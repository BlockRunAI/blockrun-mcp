// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// On the Base rail a transient Exa 5xx surfaces as "wallet needs funding".
// Traced 2026-09-13 in @blockrun/llm 3.15.1 and the gateway:
//
//   1. MCP signs the 402, gateway proxies, Exa answers 5xx.
//   2. Gateway exa route returns 502 "Payment was NOT charged" — but unlike the
//      pm route it does NOT releasePaymentNonce, so the nonce stays claimed.
//   3. handlePaymentAndRetryRaw (dist/index.js:5274-5286) sleeps 1s and
//      re-sends the SAME PAYMENT-SIGNATURE; rejectReplay answers 402
//      {code: PAYMENT_REPLAY}; the SDK turns any post-payment 402 into
//      PaymentError("Payment was rejected. Check your wallet balance.") and
//      drops the body.
//   4. formatError sees "balance" and appends the funding footer.
//
// Nothing settled, the wallet may hold $50, and the agent is told to top up.
// The Solana client has no 502 retry and the account rail has no nonce, so
// this is Base-only. The tool cannot tell a replay from a real rejection (the
// SDK discards the code), so it HEDGES on Base instead of prescribing funding
// — and says nothing extra on the other two rails, where the sentence means
// what it says.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let apiKeyMode = false;
let chain: "base" | "solana" = "base";
let walletThrows: Error | null = null;
const stubClient = {
  getWithPaymentRaw: async () => { throw new Error("exa never GETs"); },
  requestWithPaymentRaw: async () => { if (walletThrows) throw walletThrows; return { results: [] }; },
};
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => chain,
    getClient: () => stubClient,
    buildClient: () => stubClient,
    buildClientWithTimeout: () => stubClient,
    baseOnlyMessage: () => null,
    getOrCreateWalletKey: () => { throw new Error("exa tests must not touch a wallet key"); },
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("../src/utils/auth.js", {
  namedExports: {
    isApiKeyMode: () => apiKeyMode,
    getApiKey: () => (apiKeyMode ? "br_test_key" : undefined),
    apiAuthHeaders: () => ({ Authorization: "Bearer br_test_key" }),
    getApiKeyBase: () => "https://api.blockrun.ai",
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
  },
});
let accountThrows: Error | null = null;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => {
      if (accountThrows) throw accountThrows;
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json", "x-blockrun-cost-usd": "0.01" } });
    },
    isTimeoutError: () => false,
  },
});

const { registerExaTool } = await import("../src/tools/exa.js");

// The SDK's exact text — the only signal the tool gets.
const SDK_REJECTED = "Payment was rejected. Check your wallet balance.";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
function harness() {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  };
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerExaTool(server as never, budget);
  assert.ok(handler, "blockrun_exa did not register a handler");
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

beforeEach(() => { apiKeyMode = false; chain = "base"; walletThrows = null; accountThrows = null; });

test("Base rail: the SDK's post-payment rejection is hedged — it may be a replay after an upstream Exa error, not an empty wallet", async () => {
  walletThrows = new Error(SDK_REJECTED);
  const { call, budget } = harness();
  const res = await call({ path: "search", body: { query: "fed" } });
  const text = res.content.map((p) => p.text ?? "").join("\n");
  assert.equal(res.isError, true);
  assert.match(text, /Payment was rejected/, "the SDK's own words stay — it MAY be a real rejection");
  assert.match(text, /upstream|Exa/i, text);
  assert.match(text, /nothing (was )?settled|not charged|no charge/i, text);
  assert.match(text, /retry/i, text);
  assert.match(text, /status|report/i, "point at a wallet action that exists (blockrun_wallet has no \"balance\")");
  assert.equal(budget.spent, 0, "a rejected call books nothing");
});

test("Solana rail: no hedge — the Solana client does not retry a 502 with a burned nonce", async () => {
  chain = "solana";
  walletThrows = new Error(SDK_REJECTED);
  const { call } = harness();
  const res = await call({ path: "search", body: { query: "fed" } });
  const text = res.content.map((p) => p.text ?? "").join("\n");
  assert.equal(res.isError, true);
  assert.match(text, /Payment was rejected/);
  assert.doesNotMatch(text, /replay|re-sent|resent/i, text);
});

test("account rail: no hedge — there is no nonce to replay", async () => {
  apiKeyMode = true;
  accountThrows = new Error(SDK_REJECTED);
  const { call } = harness();
  const res = await call({ path: "search", body: { query: "fed" } });
  const text = res.content.map((p) => p.text ?? "").join("\n");
  assert.equal(res.isError, true);
  assert.doesNotMatch(text, /replay|re-sent|resent/i, text);
});

test("Base rail: any other error is untouched by the hedge", async () => {
  walletThrows = new Error("API error after payment: 502");
  const { call } = harness();
  const res = await call({ path: "search", body: { query: "fed" } });
  const text = res.content.map((p) => p.text ?? "").join("\n");
  assert.doesNotMatch(text, /replay|re-sent|resent/i, text);
});
