// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_search kept selling the X/Twitter source after the gateway removed
// it (blockrun commit edefa8eb, 2026-07-05: `sources: z.array(z.enum(["web",
// "news"])).optional().default(["web"])`). The description's own "Common
// shape" was `sources: ["web","x","news"]`, so an agent following it to the
// letter reserved $0.2645, sat through the confirm dialog, and got back
// `API error: 400 / Invalid request body` with the zod issues stripped by the
// SDK — no field named, nothing charged, no way to self-correct. Unpaid probe
// 2026-09-13 on both gateways (no payment header):
//
//   {sources:["web","x","news"]} -> 400 {"path":["sources",1],"message":"Invalid option: expected one of \"web\"|\"news\""}
//   {sources:["x"]}              -> 400 (sol.blockrun.ai, same body)
//   {sources:["web","news"]}     -> 402 (the normal quote)
//
// Pinned: an unknown source is refused BEFORE the reserve, on every rail, with
// a message that names the field and the two values that exist; the
// description no longer advertises "x"; valid sources still pass through.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let apiKeyMode = false;
let chain: "base" | "solana" = "base";
const walletCalls: Array<{ endpoint: string; body: unknown }> = [];
const stubClient = {
  getWithPaymentRaw: async () => { throw new Error("search never GETs"); },
  requestWithPaymentRaw: async (endpoint: string, body: unknown) => { walletCalls.push({ endpoint, body }); return { results: [] }; },
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
    getOrCreateWalletKey: () => { throw new Error("search tests must not touch a wallet key"); },
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
const accountCalls: Array<{ url: string; body: unknown }> = [];
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string, init: { body?: string }) => {
      accountCalls.push({ url, body: JSON.parse(init.body ?? "{}") });
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-blockrun-cost-usd": "0.2625" },
      });
    },
    isTimeoutError: () => false,
  },
});

const { registerSearchTool } = await import("../src/tools/search.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
function harness() {
  let handler: Handler | undefined;
  let description = "";
  const server = {
    registerTool: (_n: string, cfg: { description: string }, h: Handler) => { handler = h; description = cfg.description; },
    server: { getClientCapabilities: () => ({}) },
  };
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerSearchTool(server as never, budget);
  assert.ok(handler, "blockrun_search did not register a handler");
  return { call: (args: Record<string, unknown>) => handler!(args), budget, description };
}

const RAILS: Array<{ name: string; apiKey: boolean; chain: "base" | "solana" }> = [
  { name: "base wallet", apiKey: false, chain: "base" },
  { name: "solana wallet", apiKey: false, chain: "solana" },
  { name: "account key", apiKey: true, chain: "solana" },
];

beforeEach(() => { apiKeyMode = false; chain = "base"; walletCalls.length = 0; accountCalls.length = 0; });

for (const rail of RAILS) {
  test(`[${rail.name}] a source the gateway removed is refused before the reserve, naming the field and the live values`, async () => {
    apiKeyMode = rail.apiKey; chain = rail.chain;
    const { call, budget } = harness();
    for (const sources of [["web", "x", "news"], ["x"], ["twitter"], ["web", "X"], ["news", "rss"]]) {
      const res = await call({ body: { query: "Solana outage today", sources, max_results: 10 } });
      const text = res.content.map((p) => p.text ?? "").join("\n");
      assert.equal(res.isError, true, `${JSON.stringify(sources)} was not refused: ${text}`);
      assert.match(text, /sources/, text);
      assert.match(text, /"web"|'web'|web/, text);
      assert.match(text, /news/, text);
      assert.match(text, /No payment was made/i, text);
      assert.doesNotMatch(text, /API error: 400/, "the refusal must be ours, not the gateway's opaque 400");
    }
    assert.equal(walletCalls.length, 0, "nothing may reach the wallet client");
    assert.equal(accountCalls.length, 0, "nothing may reach the account API");
    assert.equal(budget.spent, 0);
    assert.equal(budget.calls, 0);
  });

  test(`[${rail.name}] the X/Twitter refusal says the source is gone, so the agent does not retry it`, async () => {
    apiKeyMode = rail.apiKey; chain = rail.chain;
    const { call } = harness();
    const res = await call({ body: { query: "CT sentiment", sources: ["x"] } });
    const text = res.content.map((p) => p.text ?? "").join("\n");
    assert.match(text, /X\/Twitter/i, text);
    assert.match(text, /removed|no longer|retired/i, text);
  });

  test(`[${rail.name}] valid sources, and no sources at all, still go through`, async () => {
    apiKeyMode = rail.apiKey; chain = rail.chain;
    const { call, budget } = harness();
    const r1 = await call({ body: { query: "fed rate decision", sources: ["web", "news"], max_results: 3 } });
    assert.notEqual(r1.isError, true, r1.content.map((p) => p.text).join());
    const r2 = await call({ body: { query: "fed rate decision", max_results: 3 } });
    assert.notEqual(r2.isError, true, r2.content.map((p) => p.text).join());
    const sent = rail.apiKey ? accountCalls.map((c) => c.body) : walletCalls.map((c) => c.body);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], { query: "fed rate decision", sources: ["web", "news"], max_results: 3 });
    assert.deepEqual(sent[1], { query: "fed rate decision", max_results: 3 }, "no sources is forwarded as-is (the gateway defaults to web)");
    assert.equal(budget.calls, 2);
  });
}

test("the description no longer advertises the X source, and states the gateway's real default", () => {
  const { description } = harness();
  assert.doesNotMatch(description, /"x"/, "the Common shape must not list \"x\"");
  assert.doesNotMatch(description, /\["web","x","news"\]/);
  assert.doesNotMatch(description, /tweet-only/i);
  assert.doesNotMatch(description, /defaults to all three/i);
  assert.match(description, /\["web","news"\]|\["web", "news"\]/);
  assert.match(description, /default.*web/i);
});

test("a non-array sources value is left for the gateway's own 400 (unpaid) rather than guessed at", async () => {
  // Only the SOURCE NAMES are ours to know; shape errors are the schema's.
  const { call } = harness();
  const res = await call({ body: { query: "x", sources: "web" } });
  assert.notEqual(res.isError, true);
  assert.equal(walletCalls.length, 1);
});
