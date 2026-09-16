// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_speech's money path, driven through the registered handler on
// every rail with the wire scripted. Until audit round 3 speech had NO handler
// test at all (speech-cost.test.ts is the estimator only), which is how it
// shipped with a quote guard on Base alone and an in-flight booking that was
// dead on Base and absent on Solana and the account rail. The give-up cells
// live in rail-parity.test.ts; this file pins the rest of the ledger: what a
// settled call books, what a refused quote does, and that an answered 402 is
// a funding problem rather than a "maybe".
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

type Rail = "base" | "solana" | "account";
let rail: Rail = "base";
let script: Array<() => unknown> = [];
let quotedAmount = "54500";
let paymentsSigned = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => {
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
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
    getApiBase: () => (rail === "account" ? "https://api.blockrun.ai" : rail === "solana" ? "https://sol.blockrun.ai/api" : "https://blockrun.ai/api"),
    resolveGatewayUrl: (u: string) => u,
    getChain: () => (rail === "solana" ? "solana" : "base"),
    getOrCreateWalletKey: () => {
      if (rail !== "base") throw new Error(`the EVM wallet must not be touched on the ${rail} rail`);
      return TEST_KEY;
    },
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => (rail === "solana" ? "solana-secret-key" : undefined),
  },
});
mock.module("../src/utils/auth.js", {
  namedExports: {
    DEFAULT_API_KEY_BASE: "https://api.blockrun.ai",
    PORTAL_URL: "https://user.blockrun.ai",
    PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
    PORTAL_ACTIVITY_URL: "https://user.blockrun.ai/dashboard/activity",
    getApiKey: () => (rail === "account" ? "brk_live_test" : undefined),
    getAuthMode: () => (rail === "account" ? "api-key" : "wallet"),
    isApiKeyMode: () => rail === "account",
    getApiKeyBase: () => "https://api.blockrun.ai",
    apiAuthHeaders: () => (rail === "account" ? { Authorization: "Bearer brk_live_test" } : {}),
    requireWalletMode: () => null,
    resetAuthCache: () => {},
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
    solanaPublicKey: async () => "So1anaPubkey1111111111111111111111111111111",
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({
      amount: quotedAmount,
      recipient: rail === "solana" ? "Recipient111111111111111111111111111111111" : "0x0000000000000000000000000000000000000001",
      network: rail === "solana" ? "solana:mainnet" : "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/audio/speech", description: "ElevenLabs Flash v2.5 speech" },
      maxTimeoutSeconds: 300,
      extra: rail === "solana" ? { feePayer: "FeePayer1111111111111111111111111111111111" } : {},
    }),
  },
});

const { registerSpeechTool, speechCost } = await import("../src/tools/speech.js");

function makeHarness(limit: number | null = null) {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerSpeechTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}
const text = (res: any) => res.content.map((c: any) => c.text).join("\n");
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const resp402 = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "x402 ..." }), json: async () => ({}) });
const clip = (extra: Record<string, string> = {}) => () => ({
  status: 200, ok: true, headers: headers({ "x-payment-receipt": "0xtx", ...extra }),
  json: async () => ({ model: "elevenlabs/flash-v2.5", data: [{ url: "https://blockrun.ai/media/s.mp3", format: "mp3", characters: 1000 }] }),
});
const INPUT = "x".repeat(1000);
const SPEAK = { action: "speak", input: INPUT, model: "elevenlabs/flash-v2.5", response_format: "mp3" };
const ESTIMATE = speechCost("elevenlabs/flash-v2.5", INPUT); // $0.0545

beforeEach(() => { script = []; paymentsSigned = 0; rail = "base"; quotedAmount = "54500"; });
afterEach(() => { assert.equal(script.length, 0, "unconsumed scripted responses"); });

test("Base: a settled 200 books the 402 quote exactly once and prints it", async () => {
  quotedAmount = "55000"; // the gateway's figure wins over the local estimate
  script = [resp402, clip()];
  const { call, budget } = makeHarness();
  const res = await call(SPEAK);
  assert.notEqual(res.isError, true, text(res));
  assert.equal(paymentsSigned, 1);
  assert.match(text(res), /Cost: \$0\.0550/);
  assert.match(text(res), /Tx: 0xtx/);
  assert.ok(near(budget.spent, 0.055), `spent=${budget.spent}`);
});

test("Base: a 402 answered on the PAID request is a funding problem, not a maybe, and books nothing", async () => {
  script = [resp402, () => ({ status: 402, ok: false, headers: headers(), json: async () => ({}) })];
  const { call, budget } = makeHarness();
  const res = await call(SPEAK);
  const t = text(res);
  assert.equal(res.isError, true);
  assert.match(t, /out of funds/);
  assert.doesNotMatch(t, /MAY have/);
  assert.equal(budget.spent, 0);
});

test("Base: an API error that came back after the signature books nothing and is not a maybe", async () => {
  script = [resp402, () => ({ status: 500, ok: false, headers: headers(), json: async () => ({ error: "upstream" }) })];
  const { call, budget } = makeHarness();
  const res = await call(SPEAK);
  assert.equal(res.isError, true);
  assert.doesNotMatch(text(res), /MAY have/);
  assert.equal(budget.spent, 0);
});

test("Solana: a quote inside the tolerance is re-reserved against the cap before signing", async () => {
  rail = "solana";
  quotedAmount = "70000"; // $0.07 vs $0.0545 estimate: 1.28x, honest markup
  script = [resp402];
  const { call, budget } = makeHarness(0.06); // the estimate fits, the quote does not
  const res = await call(SPEAK);
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /budget|limit/i);
  assert.match(t, /No charge was made/);
  assert.equal(paymentsSigned, 0, "refused before signing");
  assert.equal(budget.spent, 0);
});

test("Solana: a sound-effect quote far above the flat rate is refused unsigned, labelled as such", async () => {
  rail = "solana";
  quotedAmount = "500000"; // $0.50 against $0.0545: the 9x shape
  script = [resp402];
  const { call, budget } = makeHarness();
  const res = await call({ action: "sound_effect", input: "rain on a tin roof", response_format: "mp3" });
  const t = text(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /quoted \$0\.5000 for sound effect speech/);
  assert.match(t, /ElevenLabs Flash v2\.5 speech/, "names what the gateway said it was quoting");
  assert.match(t, /Refusing to sign it/);
  assert.match(t, /chain:"base"/, "points at the other rail");
  assert.equal(paymentsSigned, 0);
  assert.equal(budget.spent, 0);
});

test("Solana: a settled 200 books the quote exactly once", async () => {
  rail = "solana";
  quotedAmount = "56000";
  script = [resp402, clip()];
  const { call, budget } = makeHarness();
  const res = await call(SPEAK);
  assert.notEqual(res.isError, true, text(res));
  assert.equal(paymentsSigned, 1);
  assert.ok(near(budget.spent, 0.056), `spent=${budget.spent}`);
});

test("account rail: the settled cost header is booked, and its absence books the estimate", async () => {
  rail = "account";
  script = [clip({ "x-blockrun-cost-usd": "0.052500" })];
  const withHeader = makeHarness();
  const res = await withHeader.call(SPEAK);
  assert.notEqual(res.isError, true, text(res));
  assert.equal(paymentsSigned, 0);
  assert.ok(near(withHeader.budget.spent, 0.0525), `spent=${withHeader.budget.spent}`);
  assert.match(text(res), /Cost: \$0\.0525/);
  assert.doesNotMatch(text(res), /estimated/);

  script = [clip()];
  const noHeader = makeHarness();
  const res2 = await noHeader.call(SPEAK);
  assert.notEqual(res2.isError, true, text(res2));
  assert.ok(near(noHeader.budget.spent, ESTIMATE), `spent=${noHeader.budget.spent}`);
  assert.match(text(res2), /estimated/);
});

// Audit round 4 (the D13 shape video and music got in round 3, and speech did
// not): settlement was OBSERVED and booked, then the result could not be used
// — the body aborted mid-read, or carried no URL. The charge stands; the
// message has to say so and must not invite a second payment. Before this a
// Base body abort after the booking returned "Speech generation failed" plus
// formatError's "temporary API issue, try again" — for a call that had paid.
for (const [name, setup, expectUsd] of [
  ["Base", () => { rail = "base"; quotedAmount = "55000"; script = [resp402, () => ({ status: 200, ok: true, headers: headers({ "x-payment-receipt": "0xtx" }), json: async () => { throw new Error("aborted"); } })]; }, 0.055],
  ["Solana", () => { rail = "solana"; quotedAmount = "56000"; script = [resp402, () => ({ status: 200, ok: true, headers: headers({ "x-payment-receipt": "sol-tx" }), json: async () => ({ model: "elevenlabs/flash-v2.5", data: [{}] }) })]; }, 0.056],
  ["account", () => { rail = "account"; script = [() => ({ status: 200, ok: true, headers: headers({ "x-blockrun-cost-usd": "0.052500" }), json: async () => ({ data: [] }) })]; }, 0.0525],
] as const) {
  test(`${name}: a settled 200 whose body is unusable says the charge stands, once, and does not invite a retry`, async () => {
    setup();
    const { call, budget } = makeHarness();
    const res = await call(SPEAK);
    const t = text(res);
    assert.equal(res.isError, true, t);
    assert.ok(near(budget.spent, expectUsd), `${name}: spent=${budget.spent}, expected ${expectUsd}`);
    assert.match(t, /charge stands/, `${name}: ${t}`);
    assert.match(t, /action:"report"|dashboard\/activity/, `${name}: must say where to check — ${t}`);
    assert.doesNotMatch(t, /try again|No payment was taken|out of funds/i, `${name}: ${t}`);
  });
}
