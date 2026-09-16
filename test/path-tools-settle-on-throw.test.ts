// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// C38 (audit round 3): the seven path tools let the SDK — or, on the account
// rail, utils/api-key-call.ts — own the paid request, and their catch used to
// do formatError(extractErrorMessage(err)) and nothing else. A call that was
// paid for and then never answered booked $0 and said "try again in a few
// minutes"; the retry paid again.
//
// One matrix, seven tools, three rails, five failure shapes:
//
//   settle-then-abort   the paid request went out, nothing came back
//                       → books the reserve ONCE, says MAY, no blind retry
//   edge 504            the origin did not answer (post-settle 504 has no body)
//                       → books, says MAY
//   marked NOT charged  the gateway said the nonce was released
//                       → books nothing, keeps the retry advice
//   pre-settle 500      a gateway-authored 5xx with a body after payment —
//                       the search route's Grok failure is exactly this shape
//                       → books NOTHING (would be phantom spend), text hedges
//   pre-payment 4xx     the unpaid first response refused the call
//                       → books nothing, no hedge
//
// The stub SDK client throws whatever the row says; on the account rail the
// mocked fetchWithTimeout does. Money is asserted through budget.spent.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

type Rail = "base" | "solana" | "account";
let rail: Rail = "base";
let walletThrows: unknown = null;
let accountFetch: (() => Promise<Response>) | null = null;
let sdkCalls = 0;

const stubClient = {
  getWithPaymentRaw: async () => { sdkCalls++; if (walletThrows) throw walletThrows; return { ok: true }; },
  requestWithPaymentRaw: async () => { sdkCalls++; if (walletThrows) throw walletThrows; return { ok: true }; },
};
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => (rail === "solana" ? "solana" : "base"),
    getClient: () => stubClient,
    buildClient: () => stubClient,
    buildClientWithTimeout: () => stubClient,
    baseOnlyMessage: () => null,
    getOrCreateWalletKey: () => { throw new Error("path tools must not touch a wallet key"); },
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("../src/utils/auth.js", {
  namedExports: {
    isApiKeyMode: () => rail === "account",
    getApiKey: () => (rail === "account" ? "brk_test_key" : undefined),
    apiAuthHeaders: () => ({ Authorization: "Bearer brk_test_key" }),
    getApiKeyBase: () => "https://api.blockrun.ai",
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
  },
});
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => {
      if (accountFetch) return accountFetch();
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "x-blockrun-cost-usd": "0.01" } });
    },
    isTimeoutError: (e: unknown) => (e as { name?: string } | undefined)?.name === "AbortError",
  },
});

const { registerSearchTool } = await import("../src/tools/search.js");
const { registerExaTool } = await import("../src/tools/exa.js");
const { registerMarketsTool } = await import("../src/tools/markets.js");
const { registerRpcTool, RPC_PRICE_USD } = await import("../src/tools/rpc.js");
const { registerPhoneTool } = await import("../src/tools/phone.js");
const { registerModalTool } = await import("../src/tools/modal.js");
const { registerDefiTool } = await import("../src/tools/defi.js");
const { ledgerFallback } = await import("../src/utils/raw-call.js");
const { estimateSearchCost } = await import("../src/tools/search.js");
const { estimateExaCost } = await import("../src/tools/exa.js");
const { MARKETS_PRICE_USD } = await import("../src/tools/markets.js");
const { estimatePhoneCost } = await import("../src/tools/phone.js");
const { estimateModalCost } = await import("../src/tools/modal.js");
const { withTxFee } = await import("../src/utils/tx-fee.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
type Register = (server: never, budget: BudgetState) => void;

function harness(register: Register) {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  };
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  register(server as never, budget);
  assert.ok(handler, "tool did not register a handler");
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}
const textOf = (res: { content: Array<{ text?: string }> }) => res.content.map((p) => p.text ?? "").join("\n");

// Every tool with a paid call and the reserve it makes for it. The estimate
// functions are the tools' own, so a price-table change does not silently
// turn a booked-vs-not assertion into a coincidence.
const TOOLS: Array<{ name: string; register: Register; args: Record<string, unknown>; estimate: number }> = [
  { name: "search", register: registerSearchTool as Register, args: { body: { query: "fed", max_results: 10 } }, estimate: estimateSearchCost({ query: "fed", max_results: 10 }) },
  { name: "exa", register: registerExaTool as Register, args: { path: "search", body: { query: "fed" } }, estimate: estimateExaCost("search", { query: "fed" }) },
  { name: "markets", register: registerMarketsTool as Register, args: { path: "polymarket/events", params: { search: "NBA" } }, estimate: MARKETS_PRICE_USD },
  { name: "rpc", register: registerRpcTool as Register, args: { network: "ethereum", method: "eth_blockNumber" }, estimate: withTxFee(RPC_PRICE_USD) },
  { name: "phone", register: registerPhoneTool as Register, args: { path: "phone/lookup", body: { number: "+14155551212" } }, estimate: estimatePhoneCost("phone/lookup", true) },
  { name: "modal", register: registerModalTool as Register, args: { path: "sandbox/exec", body: { command: "ls" } }, estimate: estimateModalCost("sandbox/exec", { command: "ls" }) },
  { name: "defi", register: registerDefiTool as Register, args: { path: "protocols" }, estimate: 0.007 },
];

// The SDK's APIError shape: message + statusCode + sanitized response body.
class FakeAPIError extends Error {
  constructor(message: string, public statusCode: number, public response: unknown) { super(message); this.name = "APIError"; }
}
const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Row = {
  shape: string;
  wallet: () => unknown;
  account: () => Promise<Response>;
  books: boolean;
  text: RegExp[];
  notText: RegExp[];
};
const ROWS: Row[] = [
  {
    shape: "settle-then-abort",
    wallet: abortError,
    account: async () => { throw abortError(); },
    books: true,
    text: [/MAY have gone through/, /booked against your budget as a precaution/, /action:"report"/],
    notText: [/Try again in a few minutes/, /needs funding|out of credit/, /nothing was charged/],
  },
  {
    shape: "edge 504 after payment (origin did not answer)",
    wallet: () => new FakeAPIError("API error after payment: 504", 504, { message: "Request failed" }),
    account: async () => new Response("upstream request timeout", { status: 504, headers: { "content-type": "text/plain" } }),
    books: true,
    text: [/MAY have gone through/, /booked against your budget as a precaution/],
    notText: [/Try again in a few minutes/, /needs funding|out of credit/, /nothing was charged/],
  },
  {
    shape: "marked NOT charged",
    wallet: () => new FakeAPIError("API error after payment: 502", 502, {
      message: "Upstream provider error",
      detail: "Predexon 500: An unexpected error occurred (payment NOT charged)",
    }),
    account: async () => jsonResponse(502, { error: "Upstream provider error", message: "Upstream returned an error. Payment was NOT charged." }),
    books: false,
    text: [/nothing was charged/, /Try again in a few minutes/],
    notText: [/MAY have gone through/, /booked against your budget/, /needs funding|out of credit/],
  },
  {
    shape: "pre-settle 500 with a body (search's Grok failure)",
    wallet: () => new FakeAPIError("API error after payment: 500", 500, { message: "Internal server error" }),
    account: async () => jsonResponse(500, { error: "Internal server error" }),
    books: false,
    // The text still hedges — the client cannot tell this from a post-settle
    // catch-all 500 — but the ledger does not guess.
    text: [/MAY have gone through/],
    notText: [/booked against your budget/, /Try again in a few minutes/, /needs funding|out of credit/],
  },
  {
    shape: "pre-payment 4xx",
    wallet: () => new FakeAPIError("API error: 400", 400, { message: "Bad request: missing query" }),
    account: async () => jsonResponse(400, { error: "Bad request: missing query" }),
    books: false,
    text: [/Bad request/],
    notText: [/MAY have gone through/, /booked against your budget/, /Try again in a few minutes/, /needs funding|out of credit/],
  },
];

beforeEach(() => { rail = "base"; walletThrows = null; accountFetch = null; sdkCalls = 0; });

for (const r of ["base", "solana", "account"] as const) {
  for (const row of ROWS) {
    for (const tool of TOOLS) {
      test(`${r} · ${tool.name} · ${row.shape} → ${row.books ? "books the reserve once" : "books nothing"}`, async () => {
        rail = r;
        if (r === "account") accountFetch = row.account; else walletThrows = row.wallet();
        const { call, budget } = harness(tool.register);

        const res = await call(tool.args);
        const out = textOf(res);

        assert.equal(res.isError, true, out);
        if (r === "account") assert.equal(sdkCalls, 0, "the account rail never touches the SDK client");
        const expected = row.books ? ledgerFallback(tool.estimate) : 0;
        assert.ok(Math.abs(budget.spent - expected) < 1e-9, `spent ${budget.spent}, expected ${expected}\n${out}`);
        if (row.books) {
          assert.ok(expected > 0, "the row must book a real amount, or the assertion proves nothing");
          assert.equal(budget.calls, 1, "booked once, not per retry");
          assert.match(out, new RegExp(`\\$${expected.toFixed(4)}`), out);
        }
        for (const re of row.text) assert.match(out, re, out);
        for (const re of row.notText) assert.doesNotMatch(out, re, out);
      });
    }
  }
}

test("nothing thrown before the paid request can book: a declined budget gate is $0", async () => {
  // sentUsd stays 0 until the line before rawGet/rawPost. Exhaust the cap so
  // the gate refuses before anything is sent; an abort-shaped message here
  // must not be read as a settled payment.
  for (const tool of TOOLS) {
    walletThrows = abortError();
    const { call, budget } = harness(tool.register);
    budget.limit = 0.000001;
    const res = await call(tool.args);
    assert.equal(res.isError, true);
    assert.equal(budget.spent, 0, tool.name);
    assert.doesNotMatch(textOf(res), /MAY have gone through|booked against/, tool.name);
  }
});

test("a free phone poll (reserve $0) books $0 even when it is aborted", async () => {
  walletThrows = abortError();
  const { call, budget } = harness(registerPhoneTool as Register);
  const res = await call({ path: "voice/call/abc123" });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0);
  assert.doesNotMatch(textOf(res), /booked against/);
});

// Audit round 4: the Solana client records the settlement BEFORE it parses
// the paid body (requestWithPaymentRaw: assertPaid → recordSettlement →
// retryResponse.json()), so a non-JSON 200 throws a bare SyntaxError with no
// status and no transport words — "none" to settlementOnThrow — for a call
// the SDK's own counter says was paid. The counter is the evidence: rawGet /
// rawPost read it around the SDK call and hand the delta to the catch, which
// books it as a CERTAIN charge.
test("a throw after the SDK counted the settlement books the counted amount, on every wallet rail", async () => {
  for (const r of ["base", "solana"] as const) {
    rail = r;
    let total = 0;
    const settling = {
      getSpending: () => ({ totalUsd: total }),
      getWithPaymentRaw: async () => { total += 0.003; throw new SyntaxError("Unexpected token < in JSON at position 0"); },
      requestWithPaymentRaw: async () => { total += 0.003; throw new SyntaxError("Unexpected token < in JSON at position 0"); },
    };
    const { rawGet, rawPost } = await import("../src/utils/raw-call.js");
    for (const call of [() => rawGet(settling as never, "/v1/x"), () => rawPost(settling as never, "/v1/x", {})]) {
      await assert.rejects(call, (err: Error & { settledUsd?: number }) => {
        assert.equal(err.name, "RawCallSettledError", `${r}: ${err.message}`);
        assert.ok(Math.abs((err.settledUsd ?? 0) - 0.003) < 1e-9, `${r}: settledUsd=${err.settledUsd}`);
        assert.match(err.message, /Unexpected token/);
        return true;
      });
    }
  }
});

test("a path tool renders a settled-then-failed call as a charge that stands, booked at the counted amount", async () => {
  rail = "solana";
  const { rawPost } = await import("../src/utils/raw-call.js");
  let total = 0;
  const settling = { getSpending: () => ({ totalUsd: total }), requestWithPaymentRaw: async () => { total += 0.003; throw new SyntaxError("Unexpected token <"); } };
  let thrown: unknown;
  try { await rawPost(settling as never, "/v1/rpc/ethereum", {}); } catch (e) { thrown = e; }
  const { pathToolFailure } = await import("../src/utils/path-tool-catch.js");
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  const res = pathToolFailure(thrown, { budget, sentUsd: withTxFee(RPC_PRICE_USD) });
  const t = textOf(res);
  assert.ok(Math.abs(budget.spent - 0.003) < 1e-9, `spent=${budget.spent}`);
  assert.match(t, /charge stands/);
  assert.match(t, /\$0\.0030/);
  assert.doesNotMatch(t, /MAY have gone through|Try again in a few minutes/);
});

// Audit round 4b (P1, a regression of the RawCallSettledError fix): the SDK's
// spend counter is per CLIENT, getClient() is a cached singleton per rail, and
// tool calls run concurrently — so a concurrent call's settlement landed
// inside a failing call's before/after window and was booked to it as "the
// charge stands" (and booked again by the call that actually paid). Every
// path tool now builds its own client, like blockrun_chat always did.
test("every shared-client path tool builds a fresh client per call, never the singleton", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["search", "exa", "markets", "rpc", "defi", "phone"]) {
    const src = readFileSync(new URL(`../src/tools/${f}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bgetClient\(\)/, `${f}.ts must not read the shared client — its spend counter is shared too`);
    assert.match(src, /\bbuildClient\(\)/, `${f}.ts builds a per-call client`);
  }
});

test("a concurrent settlement on the SAME client would be misattributed — which is why the client is per call", async () => {
  const { rawPost } = await import("../src/utils/raw-call.js");
  let total = 0;
  const shared = {
    getSpending: () => ({ totalUsd: total }),
    requestWithPaymentRaw: async () => {
      total += 0.2645; // a concurrent call settles while this one is in flight...
      throw Object.assign(new Error("API error: 400"), { statusCode: 400 }); // ...and this one is refused unpaid
    },
  };
  // The helper cannot tell the two apart on a shared counter; this pins that
  // the ONLY defence is the per-call client asserted above.
  await assert.rejects(rawPost(shared as never, "/v1/x", {}), (e: Error) => e.name === "RawCallSettledError");
});

// Round 4b (RP-5): the account rail returned a settled 2xx whose body would
// not parse as a SUCCESS with data `{}` — money booked, no hint the body was
// unreadable — while the wallet rails say the charge stands. Same verdict now.
test("account rail: a settled 2xx with an unreadable body is a charge that stands, booked at the cost header", async () => {
  rail = "account";
  accountFetch = async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html", "x-blockrun-cost-usd": "0.012000" } });
  const { call, budget } = harness(registerRpcTool as Register);
  const res = await call({ network: "ethereum", method: "eth_blockNumber" });
  const t = textOf(res);
  assert.equal(res.isError, true, t);
  assert.match(t, /charge stands/);
  assert.match(t, /\$0\.0120/);
  assert.ok(Math.abs(budget.spent - 0.012) < 1e-9, `spent=${budget.spent}`);
});
