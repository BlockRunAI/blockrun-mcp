// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// blockrun_price, driven through its registered handler.
//
// price-equity-preflight.test.ts proves what equityNotServedMessage SAYS. This
// file proves WHERE the handler says it: before the Base-only chain guard,
// before reserveBudget, before confirmSpend, and before any client or network
// call. That ordering is the whole fix — on the default Solana chain the chain
// guard used to fire first and tell the user to switch chains to pay for a
// route the gateway 501s before payment — and a string test cannot see it.
// It also keeps the free paths honest: action:"list" for stocks and a crypto
// quote must still reach the (mocked) client.
//
// The harness is the confirm-spend-coverage one, with three deliberate
// differences that turn each assertion into an ordering proof:
//   - baseOnlyMessage returns a real "switch chains" string (the coverage
//     harness returns null, which would make doesNotMatch(/switch/) vacuous);
//   - confirmation is ON with threshold 0 and the fake client advertises
//     elicitation, so reaching confirmSpend on a paid call would call
//     elicitInput — elicitCalls === 0 means it was never reached;
//   - one budget carries a cap smaller than the paid estimate, so reaching
//     reserveBudget would answer with the budget message instead of the 501.
process.env.BLOCKRUN_CONFIRM_SPEND = "on";
process.env.BLOCKRUN_CONFIRM_THRESHOLD = "0";

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BudgetState } from "../src/types.js";

// Rail pin (see image-cost.test.ts): the wallet module is mocked wholesale
// below, but nothing in this file may depend on the developer's own key.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-price-"));
const realHome = process.env.HOME;
const savedApiKey = process.env.BLOCKRUN_API_KEY;
process.env.HOME = home;
delete process.env.BLOCKRUN_API_KEY;
process.on("exit", () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (savedApiKey === undefined) delete process.env.BLOCKRUN_API_KEY; else process.env.BLOCKRUN_API_KEY = savedApiKey;
  fs.rmSync(home, { recursive: true, force: true });
});

let networkCalls = 0;
const boom = () => { networkCalls++; throw new Error("UNEXPECTED_NETWORK_CALL"); };

// Every client call is recorded; the free ones return a small fake payload so
// the handler can format a success, the paid ones would be a bug (nothing in
// this file expects to pay).
const clientCalls: Array<{ method: string; args: unknown[] }> = [];
const fakePriceClient = {
  price: async (...args: unknown[]) => { clientCalls.push({ method: "price", args }); return { symbol: args[1], price: 1 }; },
  history: async (...args: unknown[]) => { clientCalls.push({ method: "history", args }); return { bars: [] }; },
  listSymbols: async (...args: unknown[]) => { clientCalls.push({ method: "listSymbols", args }); return { symbols: ["AAPL"] }; },
};
let priceClientRequests: boolean[] = [];

const SWITCH_CHAINS = "Paid stock price/history calls need Base — switch chains with blockrun_wallet action:\"chain\".";
// The on-chain stock price goes through rawGet on a fresh client (OCS, 2026-11-23).
const rawCalls: string[] = [];
// Set per test to make rawGet throw like the SDK does on a gateway error.
let rawError: (Error & { statusCode?: number }) | null = null;
mock.module("../src/utils/raw-call.js", {
  namedExports: {
    rawGet: async (_client: unknown, path: string) => {
      rawCalls.push(path);
      if (rawError) throw rawError;
      return { data: { symbol: "NVDA", chain: "solana", price: 164.08, pools: [] }, paidUsd: 0.005 };
    },
    ledgerFallback: (x: number) => x,
    RawCallSettledError: class extends Error {},
  },
});

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://sol.blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "solana",
    // A Solana-default machine: the guard WOULD block a paid equity call. The
    // handler has retired its call for as long as the equity route is withdrawn
    // (price.ts says where to restore it); whenever it comes back — or a
    // refactor re-adds it — landing ABOVE the pre-flight puts "switch" in the
    // text and fails the ordering assertions below.
    baseOnlyMessage: () => SWITCH_CHAINS,
    getPriceClient: (paid: boolean) => { priceClientRequests.push(paid); return fakePriceClient; },
    getClient: () => new Proxy({}, { get: () => boom }),
    buildClient: () => ({}),
    getOrCreateWalletKey: () => { throw new Error("price tests must not touch a wallet key"); },
    getWalletInfo: async () => ({ address: "0xTEST" }),
    resolveSolanaKey: () => undefined,
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => boom(), isTimeoutError: () => false },
});

const { registerPriceTool } = await import("../src/tools/price.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

function harness(limit: number | null = null, approve = false) {
  let handler: Handler | undefined;
  let elicitCalls = 0;
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => { elicitCalls++; return approve ? { action: "accept", content: {} } : { action: "decline" }; },
    },
  };
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerPriceTool(server as never, budget);
  assert.ok(handler, "blockrun_price did not register a handler");
  networkCalls = 0;
  rawCalls.length = 0;
  rawError = null;
  clientCalls.length = 0;
  priceClientRequests = [];
  return {
    call: async (args: Record<string, unknown>) => {
      const res = await handler!(args);
      return { res, text: res.content.map((p) => p.text ?? "").join("\n") };
    },
    budget,
    elicits: () => elicitCalls,
  };
}

function assertNothingReached(h: ReturnType<typeof harness>, label: string) {
  assert.equal(clientCalls.length, 0, `${label}: the price client was called`);
  assert.equal(priceClientRequests.length, 0, `${label}: getPriceClient was asked for a client`);
  assert.equal(networkCalls, 0, `${label}: the network was reached`);
  assert.equal(h.elicits(), 0, `${label}: confirmSpend asked the user (pre-flight ran after the confirm gate)`);
  assert.equal(h.budget.spent, 0, `${label}: something was booked`);
  assert.equal(h.budget.calls, 0, `${label}: a call was recorded`);
}

// Lowercase "us": MARKET is a lowercase z.enum, and the harness bypasses zod.
test("US stocks price goes on-chain on the ACTIVE chain: no chain guard, one paid GET, booked", async () => {
  const h = harness(null, true);
  const { res, text } = await h.call({ action: "price", category: "stocks", symbol: "NVDA", market: "us" });
  assert.notEqual(res.isError, true, text);
  assert.doesNotMatch(text, /switch/i, "the chain guard spoke: each gateway prices its own chain, Solana included");
  assert.deepEqual(rawCalls, ["/v1/stocks/us/price/NVDA"], text);
  assert.match(text, /"chain": "solana"/);
  assert.equal(clientCalls.length, 0, "the Pyth-era PriceClient must not be used for the on-chain price");
  assert.equal(h.budget.calls, 1, "a paid call is booked");
  assert.equal(h.elicits(), 1, "a paid call asks before signing when confirm-spend is on");
});

test("a ticker with no on-chain market (404 before payment) books nothing and says so (GLM review)", async () => {
  const h = harness(null, true);
  rawError = Object.assign(new Error("API error: 404 no_onchain_market — No on-chain market for IBM on Solana. Nothing was charged."), { statusCode: 404 });
  const { res, text } = await h.call({ action: "price", category: "stocks", symbol: "IBM", market: "us" });
  assert.equal(res.isError, true);
  assert.match(text, /no_onchain_market|No on-chain market/);
  assert.doesNotMatch(text, /booked against your budget/);
  assert.equal(h.budget.spent, 0, "a pre-payment 404 must not be booked");
});

test("a 503 not_charged after payment books nothing", async () => {
  const h = harness(null, true);
  rawError = Object.assign(new Error("API error after payment: 503 source_unavailable — payment_status not_charged. Nothing was charged."), { statusCode: 503 });
  const { res } = await h.call({ action: "price", category: "stocks", symbol: "NVDA", market: "us" });
  assert.equal(res.isError, true);
  assert.equal(h.budget.spent, 0, "an explicitly uncharged 503 must not be booked");
});

test("a declined confirm sends nothing", async () => {
  const h = harness();
  const { text } = await h.call({ action: "price", category: "stocks", symbol: "NVDA", market: "us" });
  assert.match(text, /declined|cancel/i);
  assert.deepEqual(rawCalls, []);
  assert.equal(h.budget.calls, 0);
});

test("a stocks quote with no market is the US on-chain price", async () => {
  const h = harness(null, true);
  const { res, text } = await h.call({ action: "price", category: "stocks", symbol: "NVDA" });
  assert.notEqual(res.isError, true, text);
  assert.deepEqual(rawCalls, ["/v1/stocks/us/price/NVDA"]);
});

test("usstock price is the same on-chain route; the symbol is encoded", async () => {
  const h = harness(null, true);
  await h.call({ action: "price", category: "usstock", symbol: "BRK/B" });
  assert.deepEqual(rawCalls, ["/v1/stocks/us/price/BRK%2FB"]);
});

test("a budget cap below the on-chain price refuses before any request", async () => {
  const h = harness(0.001);
  const { res, text } = await h.call({ action: "price", category: "stocks", symbol: "NVDA", market: "us" });
  assert.equal(res.isError, true);
  assert.match(text, /budget|limit/i);
  assert.deepEqual(rawCalls, []);
});

test("usstock history: 501 pre-flight before anything, and it names what IS served", async () => {
  const h = harness();
  const { res, text } = await h.call({ action: "history", category: "usstock", symbol: "AAPL", from: 1 });
  assert.equal(res.isError, true);
  assert.match(text, /Equity history is not served/);
  assert.match(text, /action: "price", category: "stocks", market: "us"/);
  assert.doesNotMatch(text, /switch/i);
  assert.deepEqual(rawCalls, []);
  assertNothingReached(h, "usstock history");
});

test("a non-US price: 501 pre-flight beats reserveBudget, even under a tiny cap", async () => {
  const h = harness(0.001);
  const { res, text } = await h.call({ action: "price", category: "stocks", symbol: "0700-HK", market: "hk" });
  assert.equal(res.isError, true);
  assert.match(text, /market "hk"/);
  assert.doesNotMatch(text, /budget/i, "reserveBudget ran before the pre-flight");
  assert.deepEqual(rawCalls, []);
  assertNothingReached(h, "hk stocks price");
});

test("stocks list is free and still reaches the client, on the Solana default, with no confirm dialog", async () => {
  const h = harness();
  const { res, text } = await h.call({ action: "list", category: "stocks", market: "us", query: "app" });
  assert.notEqual(res.isError, true, text);
  assert.doesNotMatch(text, /not served|switch/i);
  assert.deepEqual(clientCalls.map((c) => c.method), ["listSymbols"]);
  assert.deepEqual(clientCalls[0].args, ["stocks", { market: "us", query: "app", limit: undefined }]);
  assert.deepEqual(priceClientRequests, [false], "list is not a paid call");
  assert.equal(h.elicits(), 0, "a free call must not prompt");
  assert.equal(networkCalls, 0);
  assert.equal(h.budget.spent, 0);
});

test("a crypto quote reaches the client for free — the pre-flight is equity-only", async () => {
  const h = harness(0.001); // even under a tiny cap: $0 reserves clear it
  const { res, text } = await h.call({ action: "price", category: "crypto", symbol: "BTC-USD" });
  assert.notEqual(res.isError, true, text);
  assert.doesNotMatch(text, /not served|switch/i);
  assert.deepEqual(clientCalls.map((c) => c.method), ["price"]);
  assert.equal(clientCalls[0].args[1], "BTC-USD");
  assert.deepEqual(priceClientRequests, [false]);
  assert.equal(h.elicits(), 0);
  assert.equal(networkCalls, 0);
  assert.equal(h.budget.spent, 0);
  assert.equal(h.budget.calls, 0, "a free call is not booked");
});

test("the free stocks catalog still requires a market, before the client is asked", async () => {
  const h = harness();
  const { res, text } = await h.call({ action: "list", category: "stocks" });
  assert.equal(res.isError, true);
  assert.match(text, /market is required/);
  assertNothingReached(h, "stocks list without market");
});
