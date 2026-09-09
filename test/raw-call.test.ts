// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// raw-call.ts is the rail switch for EIGHT path-based tools (search, exa,
// markets, rpc, defi, phone, modal, and formerly surf) and it had no test on
// either rail. It decides two things that are easy to get silently wrong:
//
//   1. WHICH rail runs — the SDK's 402 dance, or the account API's Bearer fetch.
//      Pick wrong and the call is billed to the other payer.
//   2. What `paidUsd` means — the settled figure on the account rail, and null
//      (never 0) on a wallet call, because recordActualSpend books the caller's
//      estimate for null and would book a real charge as FREE for 0.
//
// Both rails are mocked here; nothing reaches the network or a wallet.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let apiKeyMode = false;
mock.module("../src/utils/auth.js", {
  namedExports: {
    isApiKeyMode: () => apiKeyMode,
    getApiKey: () => (apiKeyMode ? "br_test_key" : undefined),
    apiAuthHeaders: () => ({ Authorization: "Bearer br_test_key" }),
    getApiKeyBase: () => "https://api.blockrun.ai",
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
  },
});

const accountCalls: Array<{ verb: string; endpoint: string; arg: unknown }> = [];
let accountResult: { data: unknown; paidUsd: number | null } = { data: { ok: "account" }, paidUsd: 0.0085 };
let accountThrows: Error | null = null;
mock.module("../src/utils/api-key-call.js", {
  namedExports: {
    apiKeyGet: async (endpoint: string, params?: Record<string, string>) => {
      accountCalls.push({ verb: "GET", endpoint, arg: params });
      if (accountThrows) throw accountThrows;
      return accountResult;
    },
    apiKeyPost: async (endpoint: string, body: Record<string, unknown>) => {
      accountCalls.push({ verb: "POST", endpoint, arg: body });
      if (accountThrows) throw accountThrows;
      return accountResult;
    },
  },
});

const { rawGet, rawPost } = await import("../src/utils/raw-call.js");

const walletCalls: Array<{ verb: string; endpoint: string; arg: unknown }> = [];
let walletThrows: Error | null = null;
const walletClient = {
  getWithPaymentRaw: async (endpoint: string, params?: Record<string, string>) => {
    walletCalls.push({ verb: "GET", endpoint, arg: params });
    if (walletThrows) throw walletThrows;
    return { ok: "wallet" };
  },
  requestWithPaymentRaw: async (endpoint: string, body: unknown) => {
    walletCalls.push({ verb: "POST", endpoint, arg: body });
    if (walletThrows) throw walletThrows;
    return { ok: "wallet" };
  },
};

beforeEach(() => {
  apiKeyMode = false;
  accountCalls.length = 0;
  walletCalls.length = 0;
  accountThrows = null;
  walletThrows = null;
  accountResult = { data: { ok: "account" }, paidUsd: 0.0085 };
});

test("wallet mode goes through the SDK and NEVER touches the account API", async () => {
  const got = await rawGet(walletClient, "/v1/pm/polymarket/markets", { limit: "1" });
  const posted = await rawPost(walletClient, "/v1/exa/search", { query: "fed" });

  assert.deepEqual(got.data, { ok: "wallet" });
  assert.deepEqual(posted.data, { ok: "wallet" });
  assert.equal(accountCalls.length, 0, "the account rail must not be consulted without a key");
  assert.deepEqual(walletCalls.map(c => c.verb + " " + c.endpoint), [
    "GET /v1/pm/polymarket/markets",
    "POST /v1/exa/search",
  ]);
  assert.deepEqual(walletCalls[0].arg, { limit: "1" });
  assert.deepEqual(walletCalls[1].arg, { query: "fed" });
});

test("a wallet call reports paidUsd null, never 0 — 0 would book a real charge as free", async () => {
  const got = await rawGet(walletClient, "/v1/defillama/protocols");
  const posted = await rawPost(walletClient, "/v1/search", { query: "x" });
  assert.equal(got.paidUsd, null);
  assert.equal(posted.paidUsd, null);
  // The distinction recordActualSpend depends on: null means "unknown, use the
  // estimate", 0 means "this was free".
  assert.notEqual(got.paidUsd, 0);
});

test("account mode goes through api-key-call and NEVER touches the SDK client", async () => {
  apiKeyMode = true;
  const got = await rawGet(walletClient, "/v1/pm/kalshi/markets", { status: "open" });
  const posted = await rawPost(walletClient, "/v1/modal/sandbox/exec", { command: ["echo"] });

  assert.deepEqual(got.data, { ok: "account" });
  assert.deepEqual(posted.data, { ok: "account" });
  assert.equal(walletCalls.length, 0, "the wallet must not be asked to sign in account mode");
  assert.deepEqual(accountCalls.map(c => c.verb + " " + c.endpoint), [
    "GET /v1/pm/kalshi/markets",
    "POST /v1/modal/sandbox/exec",
  ]);
  assert.deepEqual(accountCalls[0].arg, { status: "open" });
});

test("account mode surfaces the settled cost the header carried", async () => {
  apiKeyMode = true;
  accountResult = { data: { ok: "account" }, paidUsd: 0.012 };
  assert.equal((await rawGet(walletClient, "/v1/phone/lookup")).paidUsd, 0.012);

  // A gateway that priced nothing at response time hands back null, and null
  // must survive: the caller then books its estimate rather than zero.
  accountResult = { data: { ok: "account" }, paidUsd: null };
  assert.equal((await rawPost(walletClient, "/v1/search", { query: "x" })).paidUsd, null);

  // A genuinely free account route reports 0, and 0 must survive too.
  accountResult = { data: { ok: "account" }, paidUsd: 0 };
  assert.equal((await rawPost(walletClient, "/v1/phone/numbers/release", {})).paidUsd, 0);
});

test("an undefined POST body reaches the account rail as {}, not as undefined", async () => {
  // apiKeyPost types its body as an object; passing undefined through would
  // JSON.stringify to "undefined" and 400 at the gateway.
  apiKeyMode = true;
  await rawPost(walletClient, "/v1/pm/markets/search", undefined);
  assert.deepEqual(accountCalls[0].arg, {});
});

test("an undefined POST body is passed through UNCHANGED on the wallet rail", async () => {
  // The SDK distinguishes an absent body from an empty one; only the account
  // rail needs the {} coercion, and coercing both would change wallet behaviour.
  await rawPost(walletClient, "/v1/pm/markets/search", undefined);
  assert.equal(walletCalls[0].arg, undefined);
});

test("each rail's failure propagates from that rail alone", async () => {
  walletThrows = new Error("API error: 502");
  await assert.rejects(() => rawGet(walletClient, "/v1/exa/search"), /502/);
  assert.equal(accountCalls.length, 0);

  apiKeyMode = true;
  walletThrows = null;
  accountThrows = new Error("BlockRun account API error: 402.");
  await assert.rejects(() => rawGet(walletClient, "/v1/exa/search"), /402/);
  assert.equal(walletCalls.length, 1, "only the wallet call from the first half");
});

test("the rail is decided per call, so switching mid-process routes the next call correctly", async () => {
  await rawGet(walletClient, "/v1/defillama/protocols");
  apiKeyMode = true;
  await rawGet(walletClient, "/v1/defillama/protocols");
  assert.equal(walletCalls.length, 1);
  assert.equal(accountCalls.length, 1);
});
