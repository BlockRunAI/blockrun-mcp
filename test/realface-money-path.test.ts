// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_realface's two paid actions on the Base rail, with fetch scripted.
// The gateway emits its 2xx only AFTER settlement, so a 2xx whose body is
// truncated or missing asset_id is still a charge — and fetchWithTimeout leaves
// its abort timer armed through the body read by design, so a stalled body lands
// here as status 200 with data {}. The handler used to throw on the missing
// asset_id one line BEFORE recordActualSpend; the catch formatted a failure and
// finally released the reservation, so the ledger netted to $0 for money that
// had moved. video.ts, speech.ts and music.ts each fixed this ordering already.
//
// Audit round 3 extended this to the other two rails and to the give-up
// path: the in-flight booking 776b4a7 added was cleared in a `.finally` before
// the catch could read it (dead on every rail), the flag behind it was
// module-global (a concurrent call's payment booked against an unrelated
// failure), the account rail discarded the settled cost header, and
// action:"list" asked the Solana gateway for an EVM address (400 on the
// default chain, minting an EVM key on the way). Each has a case below.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BudgetState } from "../src/types.js";

// Pin the auth rail: auth.ts reads ~/.blockrun/.api-key from os.homedir() at
// import time, so a developer machine set up for account billing would run
// every wallet case below in account mode. Temp HOME, no env key; the account
// cases set the env key themselves and reset the memo.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-realface-"));
const realHome = process.env.HOME;
const savedApiKey = process.env.BLOCKRUN_API_KEY;
process.env.HOME = home;
delete process.env.BLOCKRUN_API_KEY;
process.on("exit", () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (savedApiKey === undefined) delete process.env.BLOCKRUN_API_KEY; else process.env.BLOCKRUN_API_KEY = savedApiKey;
  fs.rmSync(home, { recursive: true, force: true });
});

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SOL_PUBKEY = "So1anaPubkey1111111111111111111111111111111";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

let script: Array<() => unknown> = [];
let paymentsSigned = 0;
let chain: "base" | "solana" = "base";
let solanaKey: string | undefined = "solana-secret-key";
let evmKeyReads = 0;
const requests: Array<{ url: string; method: string }> = [];
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string, init: { method?: string }) => {
      requests.push({ url, method: init.method ?? "GET" });
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
    // The real predicate, restated. This suite stubbed it to `() => false`
    // until audit round 3, which hid the give-up branch from every case.
    isTimeoutError: (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("did not complete within");
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => (chain === "solana" ? "https://sol.blockrun.ai/api" : "https://blockrun.ai/api"),
    resolveGatewayUrl: (u: string) => u,
    getChain: () => chain,
    getOrCreateWalletKey: () => { evmKeyReads++; return TEST_KEY; },
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => solanaKey,
    solanaKeyUnavailableReason: () => undefined,
  },
});
class FakePaymentError extends Error { constructor(m: string) { super(m); this.name = "PaymentError"; } }
mock.module("@blockrun/llm", {
  namedExports: {
    PaymentError: FakePaymentError,
    SOLANA_NETWORK: "solana:mainnet",
    SolanaLLMClient: { SOLANA_API_URL: "https://sol.blockrun.ai/api" },
    createPaymentPayload: async () => { paymentsSigned++; return "0xpaymentpayloadmock"; },
    createSolanaPaymentPayload: async () => { paymentsSigned++; return "solana-payment-payload"; },
    solanaKeyToBytes: async () => new Uint8Array(64),
    solanaPublicKey: async () => SOL_PUBKEY,
    parsePaymentRequired: () => ({}),
    // 12000 micro-USDC = $0.012: the gateway's $0.01 base plus the $0.002 fee.
    extractPaymentDetails: () => ({
      amount: "12000",
      recipient: chain === "solana" ? "Recipient111111111111111111111111111111111" : "0x0000000000000000000000000000000000000001",
      network: chain === "solana" ? "solana:mainnet" : "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/portrait/enroll", description: "BlockRun Virtual Portrait enrollment" },
      maxTimeoutSeconds: 120,
      extra: chain === "solana" ? { feePayer: "FeePayer1111111111111111111111111111111111" } : {},
    }),
  },
});

const { registerRealfaceTool } = await import("../src/tools/realface.js");
const { resetAuthCache, isApiKeyMode } = await import("../src/utils/auth.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerRealfaceTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}
const text = (res: any) => res.content.map((c: any) => c.text).join("\n");

const resp402 = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "x402 base ..." }), json: async () => ({}) });
const paid = (status: number, body: unknown) => () => ({ status, ok: status >= 200 && status < 300, headers: headers(), json: async () => body });

const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
function accountMode(on: boolean) {
  if (on) process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000"; else delete process.env.BLOCKRUN_API_KEY;
  resetAuthCache();
}

beforeEach(() => { script = []; paymentsSigned = 0; chain = "base"; solanaKey = "solana-secret-key"; evmKeyReads = 0; requests.length = 0; accountMode(false); });
afterEach(() => { assert.equal(script.length, 0, "unconsumed scripted responses"); });

test("the suite runs on the wallet rail whatever the developer's account setup", () => {
  assert.equal(isApiKeyMode(), false);
});

const PORTRAIT = { action: "portrait", name: "Ada", image_url: "https://ok.example.com/ada.png" };
const ENROLL = { action: "enroll", name: "Ada", image_url: "https://ok.example.com/ada.png", group_id: "legacy_rf_1" };

for (const [label, args, missing] of [
  ["portrait", PORTRAIT, /Portrait response missing asset_id/],
  ["enroll", ENROLL, /Enroll response missing asset_id/],
] as const) {
  test(`${label}: a settled 2xx with a malformed body still BOOKS the charge`, async () => {
    script = [resp402, paid(200, {})];
    const { call, budget } = makeHarness();
    const res = await call(args);
    const t = text(res);
    assert.equal(res.isError, true, "no asset id is still an error for the caller");
    assert.match(t, missing);
    assert.equal(paymentsSigned, 1);
    assert.ok(Math.abs(budget.spent - 0.012) < 1e-9, `settled charge must stay booked: spent=${budget.spent}`);
  });

  test(`${label}: the happy path books the settled amount exactly once`, async () => {
    script = [resp402, paid(200, { asset_id: "ta_abc123", name: "Ada", group_id: "legacy_rf_1" })];
    const { call, budget } = makeHarness();
    const res = await call(args);
    assert.notEqual(res.isError, true, text(res));
    assert.equal(res.structuredContent.asset_id, "ta_abc123");
    assert.ok(Math.abs(budget.spent - 0.012) < 1e-9, `booked once: spent=${budget.spent}`);
  });

  test(`${label}: a 422 rejection books nothing (the gateway does not settle it)`, async () => {
    script = [resp402, paid(422, { hint: "use a clearer photo" })];
    const { call, budget } = makeHarness();
    const res = await call(args);
    assert.equal(res.isError, true);
    assert.match(text(res), /No payment taken/);
    assert.equal(budget.spent, 0, "reservation must be fully released");
  });
}

// ---------------------------------------------------------------------------
// Give-up booking, per rail. The paid request goes out (402 answered, transfer
// signed — or the Bearer on the request) and never answers.
// ---------------------------------------------------------------------------
test("Base: the signed POST dropping is booked at the quote and reported as a possible charge", async () => {
  script = [resp402, () => { throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call(PORTRAIT);
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.equal(paymentsSigned, 1);
  assert.match(t, /RealFace portrait got no answer/);
  assert.match(t, /MAY have gone through/);
  assert.match(t, /action:"report"/);
  assert.doesNotMatch(t, /No payment taken|no charge was made/i);
  assert.ok(near(budget.spent, 0.012), `the quote is booked: spent=${budget.spent}`);
});

test("Base: the unpaid 402 probe dropping books nothing — nothing was signed", async () => {
  script = [() => { throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call(PORTRAIT);
  assert.equal(res.isError, true);
  assert.equal(paymentsSigned, 0);
  assert.doesNotMatch(text(res), /MAY have/);
  assert.equal(budget.spent, 0);
});

test("Solana: the paid POST dropping after the SPL transfer was signed is booked at the quote", async () => {
  chain = "solana";
  script = [resp402, () => { throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call(ENROLL);
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.equal(paymentsSigned, 1, "one SPL transfer signed");
  assert.equal(evmKeyReads, 0, "the EVM wallet is never touched on Solana");
  assert.match(t, /RealFace enroll got no answer/);
  assert.match(t, /MAY have gone through/);
  assert.ok(near(budget.spent, 0.012), `spent=${budget.spent}`);
});

test("Solana: the unpaid quote probe dropping books nothing — the tracker is armed only from onQuote", async () => {
  chain = "solana";
  script = [() => { throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call(ENROLL);
  assert.equal(res.isError, true);
  assert.equal(paymentsSigned, 0);
  assert.doesNotMatch(text(res), /MAY have/);
  assert.equal(budget.spent, 0);
});

test("Solana: a 422 that came back is 'rejected, not charged' — a response is an answer, never a maybe", async () => {
  chain = "solana";
  script = [resp402, paid(422, { hint: "use a clearer photo" })];
  const { call, budget } = makeHarness();
  const res = await call(ENROLL);
  assert.equal(res.isError, true);
  assert.match(text(res), /No payment taken/);
  assert.doesNotMatch(text(res), /MAY have/);
  assert.equal(budget.spent, 0);
});

test("account rail: the Bearer POST dropping is booked at the reserve and points at the account activity page", async () => {
  accountMode(true);
  script = [() => { throw abortError(); }];
  const { call, budget } = makeHarness();
  const res = await call(PORTRAIT);
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.equal(paymentsSigned, 0, "nothing is signed on the account rail");
  assert.match(t, /carrying the account key/);
  assert.match(t, /MAY have gone through/);
  assert.match(t, /dashboard\/activity/);
  assert.ok(near(budget.spent, 0.012), `the reserve is booked: spent=${budget.spent}`);
});

test("account rail: the settled cost header is booked and shown instead of the fee-inclusive estimate", async () => {
  // The account API bills the $0.010 base with no transaction fee and says so
  // in x-blockrun-cost-usd (since 2026-09-05). realface hand-rolled its fetch
  // and threw the header away under a comment claiming there was none, so the
  // ledger carried $0.012 for a $0.010 charge on every enrolment.
  accountMode(true);
  script = [() => ({ status: 200, ok: true, headers: headers({ "x-blockrun-cost-usd": "0.010000" }), json: async () => ({ asset_id: "ta_acc", name: "Ada" }) })];
  const { call, budget } = makeHarness();
  const res = await call(PORTRAIT);
  assert.notEqual(res.isError, true, text(res));
  assert.ok(near(budget.spent, 0.01), `spent=${budget.spent}`);
  assert.match(text(res), /Cost: \$0\.0100/);
  assert.equal(res.structuredContent.price_usd, 0.01);
  assert.match(requests[0].url, /\/v1\/portrait\/enroll$/);
});

test("account rail: an absent cost header still books the estimate, never $0", async () => {
  accountMode(true);
  script = [() => ({ status: 200, ok: true, headers: headers(), json: async () => ({ asset_id: "ta_acc", name: "Ada" }) })];
  const { call, budget } = makeHarness();
  const res = await call(PORTRAIT);
  assert.notEqual(res.isError, true, text(res));
  assert.ok(near(budget.spent, 0.012), `spent=${budget.spent}`);
});

// ---------------------------------------------------------------------------
// Per-call state. Two calls interleave; only the one whose paid request is
// outstanding may book — the module-global flag booked $0.012 against the
// OTHER call's refused-unsigned quote and told it a charge may have settled.
// ---------------------------------------------------------------------------
test("a concurrent call's outstanding payment never books against another call's failure", async () => {
  chain = "solana";
  let releaseA: (() => void) | undefined;
  const aPaidPostReached = new Promise<void>((resolve) => {
    // Call A: 402 answered, transfer signed, paid POST hangs until released,
    // then drops.
    script = [
      resp402,
      () => new Promise((_, reject) => { resolve(); releaseA = () => reject(abortError()); }),
    ];
  });
  const { call, budget } = makeHarness();
  const a = call(ENROLL);
  await aPaidPostReached;
  assert.equal(paymentsSigned, 1, "A has signed and its paid POST is outstanding");

  // Call B, while A is in flight: its quote probe drops before anything is
  // quoted or signed. B must book nothing and say nothing about a charge.
  const heldByA = budget.spent;
  assert.ok(near(heldByA, 0.012), "A's reservation is what the ledger holds mid-flight");
  script = [() => { throw abortError(); }];
  const b = await call(PORTRAIT);
  assert.equal(b.isError, true);
  assert.doesNotMatch(text(b), /MAY have/, `B borrowed A's state: ${text(b)}`);
  assert.ok(near(budget.spent, heldByA), `B booked nothing (its own reservation released): spent=${budget.spent}`);
  assert.equal(paymentsSigned, 1, "B signed nothing");

  releaseA!();
  const resA = await a;
  assert.match(text(resA), /MAY have gone through/);
  assert.ok(near(budget.spent, 0.012), `A books its own charge exactly once: spent=${budget.spent}`);
});

// ---------------------------------------------------------------------------
// action:"list" on the default chain.
// ---------------------------------------------------------------------------
test("list on Solana asks the Solana gateway for the Solana payer, and mints nothing", async () => {
  chain = "solana";
  script = [
    () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ realfaces: [{ assetId: "ta_sol", name: "Ada" }], count: 1 }) }),
    () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ portraits: [] }) }),
  ];
  const { call, budget } = makeHarness();
  const res = await call({ action: "list" });
  const t = text(res);
  assert.notEqual(res.isError, true, t);
  assert.equal(requests[0].url, `https://sol.blockrun.ai/api/v1/wallet/${SOL_PUBKEY}/realfaces`);
  assert.equal(requests[1].url, `https://sol.blockrun.ai/api/v1/wallet/${SOL_PUBKEY}/portraits`);
  assert.equal(evmKeyReads, 0, "a free listing on Solana must not read (or mint) the EVM wallet");
  assert.match(t, /ta_sol/);
  assert.match(t, /on Solana/);
  assert.equal(res.structuredContent.chain, "solana");
  assert.equal(res.structuredContent.wallet, SOL_PUBKEY);
  assert.equal(budget.spent, 0);
});

test("list on Solana with no Solana wallet refuses without provisioning one", async () => {
  chain = "solana";
  solanaKey = undefined;
  const { call } = makeHarness();
  const res = await call({ action: "list" });
  assert.equal(res.isError, true);
  assert.match(text(res), /No Solana wallet yet/);
  assert.match(text(res), /action:"setup"/);
  assert.equal(requests.length, 0, "nothing asked of the gateway");
  assert.equal(evmKeyReads, 0);
});

test("list on Base still asks the Base gateway for the EVM address", async () => {
  script = [
    () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ realfaces: [], count: 0 }) }),
    () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ portraits: [] }) }),
  ];
  const { call } = makeHarness();
  const res = await call({ action: "list" });
  assert.notEqual(res.isError, true, text(res));
  assert.match(requests[0].url, /^https:\/\/blockrun\.ai\/api\/v1\/wallet\/0x[0-9a-fA-F]{40}\/realfaces$/);
  assert.match(text(res), /Base wallet/);
  assert.equal(res.structuredContent.chain, "base");
});
