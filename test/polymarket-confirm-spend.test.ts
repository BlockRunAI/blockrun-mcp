// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// BLOCKRUN_CONFIRM_SPEND=on is the human-in-the-loop switch: the server asks
// the user, via MCP elicitation, before money moves. It covered a $0.004 rpc
// call and none of blockrun_polymarket's confirm:true actions — and
// `confirm:true` is a model-supplied boolean, not a human's click. With the
// flag on, fund / withdraw / buy / sell now go through the same confirmSpend
// dialog (usd = the notional, label names the action and destination); a
// decline signs nothing. With the flag off, confirm:true alone still places,
// exactly as before (that path is what every other polymarket test runs).
process.env.BLOCKRUN_CONFIRM_SPEND = "on";
process.env.BLOCKRUN_CONFIRM_THRESHOLD = "0";

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { outcomeIsUnknown } from "../apps/order-safety.js";
import { USDCE_COLLATERAL } from "../src/utils/polymarket/constants.js";

const VAULT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const AGENT = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const BRIDGE = "0x6a6827094a5809Df44b32adBEf26F233614F12c4";

let orderSubmits = 0;
let authorizationsSigned = 0;
let fundPosts = 0;
let bridgeWithdrawPosts = 0;
let relayerBatches = 0;
let stateFile: Record<string, unknown> = {};

const fakeClob = {
  getOrderBook: async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.40", size: "100" }], bids: [{ price: "0.39", size: "100" }],
  }),
  // Round 4b: the tool signs (createOrder / createMarketOrder — the SDK's
  // pre-sign network reads live there) and POSTs the signed order separately,
  // so only the POST can have an unknown outcome. These three route the
  // split calls through the createAndPost* behaviour each test scripts.
  createOrder: async (order: Record<string, unknown>, options: Record<string, unknown>) => ({ signedOf: "limit", order, options }),
  createMarketOrder: async (order: Record<string, unknown>, options: Record<string, unknown>) => ({ signedOf: "market", order, options }),
  postOrder: async (signed: { signedOf: string; order: Record<string, unknown>; options: Record<string, unknown> }, orderType: unknown, postOnly?: boolean) =>
    signed.signedOf === "limit"
      ? (fakeClob as any).createAndPostOrder(signed.order, signed.options, orderType, postOnly)
      : (fakeClob as any).createAndPostMarketOrder(signed.order, signed.options, orderType),
  createAndPostOrder: async () => { orderSubmits++; return { success: true, orderID: "0xORDER", status: "live" }; },
  createAndPostMarketOrder: async () => { orderSubmits++; return { success: true, orderID: "0xMKT", status: "matched" }; },
};

mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => fakeClob,
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "FI", ip: null, raw: {} }),
    getPolymarketAccount: () => ({ address: AGENT }),
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => ({ ok: false }), isTimeoutError: () => false },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => { authorizationsSigned++; return "BASE64"; },
    BlockrunClient: class {
      sessionTotalUsd = 0;
      getSpending() { return { totalUsd: 0, calls: 0 }; }
      async post() { fundPosts++; return { success: true, deposit: { txHash: "0xDEP" } }; }
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getOrCreateWalletKey: () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    getChainBalance: async () => 100,
    getChain: () => "base",
  },
});
mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { getFundsAddress: () => VAULT, listPositions: async () => ({ text: "none", structured: { positions: [] } }) },
});
mock.module("../src/utils/polymarket/setup.js", {
  namedExports: {
    runSetup: async () => { throw new Error("setup not used (test)"); },
    getPublicClient: () => ({
      getCode: async () => "0x60006000",
      // $7.50 pUSD, no legacy USDC.e — the withdraw-all amount is $7.50.
      readContract: async ({ address }: { address: string }) =>
        address.toLowerCase() === USDCE_COLLATERAL.toLowerCase() ? 0n : 7_500_000n,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
    getPusdBalance: async () => 7.5,
  },
});
mock.module("../src/utils/polymarket/redeem.js", {
  namedExports: { redeemPosition: async () => { throw new Error("redeem not used (test)"); } },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => { stateFile = { ...stateFile, ...patch }; return stateFile; },
    loadDepositWalletForSigner: () => VAULT,
    loadL2Creds: () => null,
    saveL2Creds: () => {},
    invalidateL2Creds: () => {},
    loadBuilderCreds: () => null,
    saveBuilderCreds: () => {},
  },
});
mock.module("../src/utils/polymarket/relayer.js", {
  namedExports: {
    sendWalletBatch: async () => { relayerBatches++; return { transactionHash: "0x" + "ab".repeat(32) }; },
    getRelayerTransactionState: async () => undefined,
    BATCH_DEADLINE_SECS: 300,
  },
});
mock.module("axios", {
  defaultExport: {
    post: async (url: string) => {
      if (url.endsWith("/withdraw")) bridgeWithdrawPosts++;
      return { data: { address: { evm: BRIDGE } } };
    },
    get: async () => { throw new Error("unexpected GET (test)"); },
  },
});

const { registerPolymarketTool } = await import("../src/tools/polymarket.js");
const { resetSpendApproval } = await import("../src/utils/confirm-spend.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
type Elicit = { message: string };

function harness(answer: "decline" | "accept" | "cancel") {
  let handler: Handler | undefined;
  const prompts: Elicit[] = [];
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (p: Elicit) => { prompts.push(p); return { action: answer }; },
    },
  };
  registerPolymarketTool(server as never);
  assert.ok(handler, "tool did not register a handler");
  return {
    prompts,
    call: async (args: Record<string, unknown>) => {
      const r = await handler!(args);
      return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
    },
  };
}

function reset() {
  orderSubmits = 0; authorizationsSigned = 0; fundPosts = 0; bridgeWithdrawPosts = 0; relayerBatches = 0;
  stateFile = {};
  resetSpendApproval();
}

test("buy confirm:true with the flag on asks the user; a decline signs nothing and releases the session ledger", async () => {
  reset();
  const { call, prompts } = harness("decline");
  const res = await call({ action: "buy", token_id: "T1", amount_usd: 5, confirm: true });
  assert.equal(prompts.length, 1, "exactly one elicitation");
  assert.match(prompts[0].message, /\$5\.0000/, "the dialog states the notional");
  assert.match(prompts[0].message, /polymarket/i);
  assert.match(prompts[0].message, /buy/i);
  assert.match(res.text, /declined/i, res.text);
  assert.match(res.text, /nothing was signed/i);
  assert.equal(orderSubmits, 0, "nothing may be signed after a decline");
  // The order card must read this as "nothing moved" and re-arm, not lock.
  assert.equal(outcomeIsUnknown(res.text), false, res.text);
  assert.equal(res.isError, true, "the card branches on isError to avoid rendering 'Order submitted'");
});

test("a decline leaves no session-ledger residue", async () => {
  reset();
  const { getSessionLedger } = await import("../src/utils/polymarket/orders.js");
  const before = getSessionLedger();
  const { call } = harness("decline");
  await call({ action: "buy", token_id: "T1", amount_usd: 5, confirm: true });
  const after = getSessionLedger();
  assert.equal(after.totalUsd, before.totalUsd);
  assert.equal(after.count, before.count);
});

test("a dry-run (no confirm) never prompts — the dialog gates signatures, not previews", async () => {
  reset();
  const { call, prompts } = harness("decline");
  const res = await call({ action: "buy", token_id: "T1", amount_usd: 5 });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /DRY RUN/);
  assert.equal(prompts.length, 0);
});

test("an accept places the order (confirm:true is still required underneath)", async () => {
  reset();
  const { call, prompts } = harness("accept");
  const res = await call({ action: "buy", token_id: "T1", amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /Order submitted/);
  assert.equal(prompts.length, 1);
  assert.equal(orderSubmits, 1);
});

test("fund confirm:true: a decline signs no EIP-3009 authorization and never POSTs", async () => {
  reset();
  const { call, prompts } = harness("decline");
  const res = await call({ action: "fund", amount_usd: 5, confirm: true });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /\$5\.01/, "amount + the $0.01 fee");
  assert.match(prompts[0].message, /fund/i);
  assert.match(res.text, /declined/i, res.text);
  assert.equal(authorizationsSigned, 0, "the authorization must not be signed before the user answers");
  assert.equal(fundPosts, 0);
  assert.equal(stateFile.pendingFund, undefined, "no guard armed for a transfer that was never signed");
});

test("withdraw confirm:true (full balance): the dialog shows the real amount and destination; a decline moves nothing", async () => {
  reset();
  const { call, prompts } = harness("decline");
  const res = await call({ action: "withdraw", confirm: true });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /\$7\.5000/, "the amount is the full balance the withdraw would move, not a placeholder");
  assert.match(prompts[0].message, new RegExp(`withdraw.*${AGENT.slice(0, 6)}`, "is"), "label names the destination");
  assert.match(res.text, /declined/i, res.text);
  assert.equal(bridgeWithdrawPosts, 0, "the bridge must not be asked for a withdrawal address");
  assert.equal(relayerBatches, 0);
});

test("withdraw to a custom address puts THAT address in the dialog", async () => {
  reset();
  const custom = "0x000000000000000000000000000000000000dEaD";
  const { call, prompts } = harness("decline");
  await call({ action: "withdraw", amount_usd: 3, to_address: custom, confirm: true });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /\$3\.0000/);
  assert.match(prompts[0].message, /dEaD/);
});

test("a cancel/ESC is fail-open (the client's own permission prompt is the real gate) — the order proceeds", async () => {
  reset();
  const { call } = harness("cancel");
  const res = await call({ action: "buy", token_id: "T1", amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(orderSubmits, 1);
});

test("read-only/free actions never prompt", async () => {
  reset();
  const { call, prompts } = harness("decline");
  await call({ action: "positions" });
  assert.equal(prompts.length, 0);
});

// Round 4b (PM-1): the cap check and the reservation were split by the
// awaited dialog, so two confirms waiting on it together could overshoot
// POLYMARKET_MAX_SESSION_USD. The reservation is taken before the dialog and
// released on a decline.
test("a decline at the dialog leaves no reservation behind, and the reservation is held while the dialog is open", async () => {
  const { executeTrade, getSessionLedger } = await import("../src/utils/polymarket/orders.js");
  const before = getSessionLedger().totalUsd;
  let duringDialog: number | undefined;
  const res = await executeTrade({
    action: "buy", token_id: "111", amount_usd: 5, confirm: true,
    askUser: async () => { duringDialog = getSessionLedger().totalUsd; return { ok: false, reason: "declined" }; },
  } as never);
  assert.equal(res.isError, true);
  assert.match(res.text, /Declined at the confirmation prompt/);
  assert.equal(duringDialog, before + 5, "the notional is reserved while the user is deciding — a concurrent confirm sees it");
  assert.equal(getSessionLedger().totalUsd, before, "and released on decline");
});
