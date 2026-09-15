// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The same Base-rail ambiguity exa-replay-hedge.test.ts pins, on the other
// route that has it. The gateway's defillama/[...path] route, like exa's,
// answers an upstream 5xx with 502 "Payment was NOT charged" WITHOUT releasing
// the payment nonce; @blockrun/llm's handlePaymentAndRetryRaw sleeps 1s and
// re-sends the SAME PAYMENT-SIGNATURE, rejectReplay answers 402
// {code: PAYMENT_REPLAY}, and the SDK collapses every post-payment 402 into
// PaymentError("Payment was rejected. Check your wallet balance."), body
// discarded. formatError then sees "balance" and prescribes funding to a
// wallet that was never the problem.
//
// exa.ts got the hedge in round 3; defi.ts did not (E-residual). The wording
// is now one helper in utils/errors.ts so the two cannot drift.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let apiKeyMode = false;
let chain: "base" | "solana" = "base";
let walletThrows: Error | null = null;
let getCalls: string[] = [];
const stubClient = {
  getWithPaymentRaw: async (endpoint: string) => {
    getCalls.push(endpoint);
    if (walletThrows) throw walletThrows;
    return { protocols: [] };
  },
  requestWithPaymentRaw: async () => { throw new Error("defi never POSTs"); },
};
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => chain,
    getClient: () => stubClient,
    buildClient: () => stubClient,
    buildClientWithTimeout: () => stubClient,
    // defi is Base-only on the wallet rails; the real helper returns null on
    // Base and on the account rail. The Solana case here is the hedge's own
    // rail check, reached by pretending the chain gate passed.
    baseOnlyMessage: () => null,
    getOrCreateWalletKey: () => { throw new Error("defi tests must not touch a wallet key"); },
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("../src/utils/auth.js", {
  namedExports: {
    isApiKeyMode: () => apiKeyMode,
    getApiKey: () => (apiKeyMode ? "brk_test_key" : undefined),
    apiAuthHeaders: () => ({ Authorization: "Bearer brk_test_key" }),
    getApiKeyBase: () => "https://api.blockrun.ai",
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
  },
});
let accountThrows: Error | null = null;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => {
      if (accountThrows) throw accountThrows;
      return new Response(JSON.stringify({ protocols: [] }), { status: 200, headers: { "content-type": "application/json", "x-blockrun-cost-usd": "0.005" } });
    },
    isTimeoutError: () => false,
  },
});

const { registerDefiTool } = await import("../src/tools/defi.js");

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
  registerDefiTool(server as never, budget);
  assert.ok(handler, "blockrun_defi did not register a handler");
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}
const text = (res: { content: Array<{ text?: string }> }) => res.content.map((p) => p.text ?? "").join("\n");

beforeEach(() => { apiKeyMode = false; chain = "base"; walletThrows = null; accountThrows = null; getCalls = []; });

test("Base rail: the SDK's post-payment rejection is hedged — it may be a replay after a DefiLlama 5xx, not an empty wallet", async () => {
  walletThrows = new Error(SDK_REJECTED);
  const { call, budget } = harness();
  const res = await call({ path: "protocols" });
  const out = text(res);
  assert.equal(res.isError, true);
  assert.deepEqual(getCalls, ["/v1/defillama/protocols"]);
  assert.match(out, /Payment was rejected/, "the SDK's own words stay — it MAY be a real rejection");
  assert.match(out, /DefiLlama/, out);
  assert.match(out, /nothing was settled/, out);
  assert.match(out, /retry the call once/, out);
  // Points at a wallet action that exists (blockrun_wallet has no "balance").
  assert.match(out, /blockrun_wallet action:"status"/, out);
  assert.equal(budget.spent, 0, "a rejected call books nothing");
});

test("Solana rail: no hedge — the Solana client does not retry a 502 with a burned nonce", async () => {
  chain = "solana";
  walletThrows = new Error(SDK_REJECTED);
  const { call } = harness();
  const res = await call({ path: "protocols" });
  const out = text(res);
  assert.equal(res.isError, true);
  assert.match(out, /Payment was rejected/);
  assert.doesNotMatch(out, /replay|re-sent|resent|DefiLlama itself failed/i, out);
});

test("account rail: no hedge — there is no nonce to replay", async () => {
  apiKeyMode = true;
  accountThrows = new Error(SDK_REJECTED);
  const { call } = harness();
  const res = await call({ path: "protocols" });
  const out = text(res);
  assert.equal(res.isError, true);
  assert.equal(getCalls.length, 0, "the account rail never touches the SDK client");
  assert.doesNotMatch(out, /replay|re-sent|resent|DefiLlama itself failed/i, out);
});

test("Base rail: any other error is untouched by the hedge", async () => {
  for (const msg of ["API error after payment: 502", "API error: 402 Payment Required", `${SDK_REJECTED} (extra)`]) {
    walletThrows = new Error(msg);
    const { call } = harness();
    const res = await call({ path: "protocols" });
    assert.doesNotMatch(text(res), /replay|re-sent|resent|DefiLlama itself failed/i, msg);
  }
});
