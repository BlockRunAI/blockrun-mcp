// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// action:"fund" signs a 300s EIP-3009 authorization for the FULL amount, then
// POSTs it to /v1/polymarket/fund, which forwards it to the CDP facilitator.
// A timeout, a 5xx, or a success:false that arrives AFTER the gateway forwarded
// it used to render as a bare "Funding failed" — an invitation to retry, and a
// retry signs a SECOND full transfer while the first authorization is still
// executable. withdraw.ts got exactly this guard in 0.49.0 (pendingWithdraw +
// WITHDRAW_GUIDANCE); this is the same guard for fund (audit round 3,
// CRITIC-fund): outcome-unknown wording, and a persisted pendingFund that
// refuses a re-sign inside the authorization's validity window.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { outcomeIsUnknown } from "../apps/order-safety.js";

const VAULT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const AGENT = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const BRIDGE = "0x6a6827094a5809Df44b32adBEf26F233614F12c4";

let signed = 0;
let postBehaviour: () => Promise<unknown> = async () => ({ success: true, deposit: { txHash: "0xDEPOSITTX" }, fee: { txHash: "0xFEETX" } });
let stateFile: Record<string, unknown> = {};

/** @blockrun/llm's APIError: `statusCode` property, bare message. */
class APIError extends Error {
  constructor(message: string, readonly statusCode: number, readonly response?: unknown) {
    super(message);
    this.name = "APIError";
  }
}
class PaymentError extends Error {
  constructor(message: string) { super(message); this.name = "PaymentError"; }
}

mock.module("axios", {
  defaultExport: { post: async () => ({ data: { address: { evm: BRIDGE } } }) },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => { signed++; return "BASE64_DEPOSIT_PAYLOAD"; },
    BlockrunClient: class {
      sessionTotalUsd = 0;
      getSpending() { return { totalUsd: 0, calls: 0 }; }
      async post() { return postBehaviour(); }
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getOrCreateWalletKey: () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    getChainBalance: async () => 100,
  },
});
mock.module("../src/utils/polymarket/client.js", {
  namedExports: { getPolymarketAccount: () => ({ address: AGENT }) },
});
mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { getFundsAddress: () => VAULT },
});
mock.module("../src/utils/polymarket/setup.js", {
  namedExports: { getPublicClient: () => ({ getCode: async () => "0x60006000" }) },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => { stateFile = { ...stateFile, ...patch }; return stateFile; },
  },
});

const { fundVault, FUND_AUTH_VALIDITY_SECS } = await import("../src/utils/polymarket/fund.js");

function reset() {
  signed = 0;
  stateFile = {};
  postBehaviour = async () => ({ success: true, deposit: { txHash: "0xDEPOSITTX" }, fee: { txHash: "0xFEETX" } });
}

function assertUnknown(text: string) {
  assert.match(text, /outcome UNKNOWN|MAY (already )?have been (forwarded|broadcast|submitted)/i, text);
  assert.match(text, /basescan|Base wallet balance|deposit-wallet balance|action:"setup"/i, "must say where to check");
  assert.match(text, /before (any )?retry|Do NOT retry/i);
  assert.doesNotMatch(text, /^Funding failed:/);
  assert.equal(outcomeIsUnknown(text), true, `the order card would treat this as 'nothing moved': ${text}`);
}

test("a timeout after the POST left is outcome-unknown and arms pendingFund", async () => {
  reset();
  postBehaviour = async () => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); };
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, true);
  assertUnknown(res.text);
  assert.match(res.text, /\$5\.00/);
  const pending = stateFile.pendingFund as { amountUsd: number; deadline: number } | undefined;
  assert.ok(pending, "pendingFund must be persisted");
  assert.equal(pending.amountUsd, 5);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(pending.deadline >= now + FUND_AUTH_VALIDITY_SECS - 5 && pending.deadline <= now + FUND_AUTH_VALIDITY_SECS + 5, `deadline ${pending.deadline} vs now ${now}`);
  assert.equal((res.structured as { outcome?: string }).outcome, "unknown");
});

test("a gateway 5xx after payment is outcome-unknown too", async () => {
  reset();
  postBehaviour = async () => { throw new APIError("POST /v1/polymarket/fund failed after payment: HTTP 502", 502, { error: "bad gateway" }); };
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, true);
  assertUnknown(res.text);
  assert.match(res.text, /502/);
  assert.ok(stateFile.pendingFund);
});

test("success:false with HTTP 200 is outcome-unknown — the gateway may have forwarded before failing", async () => {
  reset();
  postBehaviour = async () => ({ success: false, error: "facilitator timeout" });
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, true);
  assertUnknown(res.text);
  assert.match(res.text, /facilitator timeout/);
  assert.ok(stateFile.pendingFund);
});

test("inside the validity window a second confirm refuses to sign — no second authorization", async () => {
  reset();
  postBehaviour = async () => { throw new APIError("HTTP 504", 504); };
  await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(signed, 1);
  postBehaviour = async () => ({ success: true, deposit: { txHash: "0xSECOND" } });
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /previous funding|may still (execute|be executed|land)/i);
  assert.match(res.text, /refus/i);
  assert.equal(signed, 1, "the guard must fire BEFORE createPaymentPayload");
  assert.ok(stateFile.pendingFund, "the guard stays armed");
});

test("the guard never blocks a dry-run", async () => {
  reset();
  stateFile = { pendingFund: { amountUsd: 5, deadline: Math.floor(Date.now() / 1000) + 200 } };
  const res = await fundVault({ amount_usd: 5 });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /DRY RUN/);
  assert.match(res.text, /previous funding|outcome unknown|pending/i, "the dry-run still warns about the unresolved one");
  assert.equal(signed, 0);
});

test("past the deadline (plus grace) the guard clears and funding proceeds", async () => {
  reset();
  stateFile = { pendingFund: { amountUsd: 5, deadline: Math.floor(Date.now() / 1000) - 120 } };
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(signed, 1);
  assert.equal(stateFile.pendingFund, undefined, "cleared after a confirmed submit");
});

test("a definite 4xx from the gateway proves nothing was forwarded: plain failure, guard cleared", async () => {
  reset();
  postBehaviour = async () => { throw new APIError("POST /v1/polymarket/fund failed after payment: HTTP 400", 400, { error: "invalid authorization" }); };
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /Funding (failed|error)/);
  assert.doesNotMatch(res.text, /outcome UNKNOWN/i);
  assert.equal(stateFile.pendingFund, undefined, "a rejected submit must not wedge the next call");
});

test("a rejected x402 fee payment (PaymentError) never reached the fund logic: plain failure", async () => {
  reset();
  postBehaviour = async () => { throw new PaymentError("Payment was rejected. Check your wallet balance."); };
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.text, /outcome UNKNOWN/i);
  assert.equal(stateFile.pendingFund, undefined);
});

test("a confirmed submit clears the guard", async () => {
  reset();
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(stateFile.pendingFund, undefined);
});
