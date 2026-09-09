// Run with: npm test  (tsx --experimental-test-module-mocks --test)
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

// The namespace tests below drive the real handler, so the wallet and the
// network are stubbed BEFORE the tool module loads (ESM static imports are
// hoisted above any mock.module call — hence the dynamic import). The wallet
// on a dev machine is real; nothing in this file may reach it.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const clientCalls: Array<{ method: string; endpoint: string }> = [];
const stubClient = {
  getWithPaymentRaw: async (endpoint: string) => { clientCalls.push({ method: "GET", endpoint }); return { ok: true }; },
  requestWithPaymentRaw: async (endpoint: string) => { clientCalls.push({ method: "POST", endpoint }); return { ok: true }; },
};
let httpCalls = 0;
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "base",
    getClient: () => stubClient,
    buildClient: () => stubClient,
    buildClientWithTimeout: () => stubClient,
    getPriceClient: () => stubClient,
    getAnthropicClient: () => stubClient,
    baseOnlyMessage: () => null,
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => { httpCalls++; throw new Error("UNEXPECTED_NETWORK_CALL"); },
    isTimeoutError: () => false,
  },
});

const { estimatePhoneCost, registerPhoneTool } = await import("../src/tools/phone.js");

// Reserves are the CHARGE (base + the gateway's $0.002 flat tx fee), not the
// base. Verified against live payment-required headers: phone/lookup base $0.010
// -> charged $0.0120; phone/numbers/list $0.001 -> $0.0030. Reserving the base
// left the gate short on every paid phone call.
test("estimatePhoneCost prices the exact known tiers at the CHARGED price", () => {
  assert.equal(estimatePhoneCost("phone/numbers/buy", true), 5.002);
  assert.equal(estimatePhoneCost("phone/numbers/renew", true), 5.002);
  assert.equal(estimatePhoneCost("voice/call", true), 0.542);
  assert.equal(estimatePhoneCost("phone/lookup", true), 0.012);
  assert.equal(estimatePhoneCost("phone/lookup/fraud", true), 0.052001);
  assert.equal(estimatePhoneCost("phone/numbers/release", true), 0);
  assert.equal(estimatePhoneCost("phone/numbers/list", true), 0.003);
});

// An unlisted paid route must never reserve $0. /v1/phone/numbers/search is live
// and charges $0.0120 (verified) yet appears in neither this table nor the
// gateway's own PHONE_PRICES — the old catch-all reserved AND recorded $0 for it,
// so the spend was invisible to the ledger and the gate waved it through.
test("estimatePhoneCost fails closed on an unknown paid route", () => {
  assert.ok(estimatePhoneCost("phone/numbers/search", false) >= 0.012,
    "unknown GET must not reserve $0 — numbers/search charges $0.0120");
  assert.ok(estimatePhoneCost("phone/some/future/route", false) > 0);
  assert.ok(estimatePhoneCost("phone/some/future/route", true) > 0);
});

test("estimatePhoneCost still prices the free voice/call status poll (GET, no body)", () => {
  assert.equal(estimatePhoneCost("voice/call/CA123abc", false), 0);
});

// The bug: a query string / trailing slash / casing let the $5 buy and $0.54
// call routes be mispriced as the $0.001 default while the gateway charged full.
test("estimatePhoneCost is not downgraded by a query string, trailing slash, or casing", () => {
  assert.equal(estimatePhoneCost("phone/numbers/buy?areaCode=415", true), 5.002);
  assert.equal(estimatePhoneCost("phone/numbers/buy/", true), 5.002);
  assert.equal(estimatePhoneCost("Phone/Numbers/Buy", true), 5.002);
  assert.equal(estimatePhoneCost("voice/call?trace=1", true), 0.542);
  assert.equal(estimatePhoneCost("phone/numbers/renew#x", true), 5.002);
});

// ---------------------------------------------------------------------------
// Namespace pin. The tool's own description promises phone/* and voice/*; the
// handler used to build `/v1/${path}` from whatever the caller sent, so
// `modal/sandbox/create` (up to $192) ran at phone's $0.012 unknown reserve:
// past any budget cap, and past a confirm dialog that quoted the wrong number.
// Classify the route the gateway will serve (normalizeClassifyPath: strip ->
// decode -> strip, lowercase), not the string the caller typed.
// ---------------------------------------------------------------------------
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

function harness() {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  };
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerPhoneTool(server as never, budget);
  assert.ok(handler, "blockrun_phone did not register a handler");
  clientCalls.length = 0;
  httpCalls = 0;
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

const OUT_OF_NAMESPACE = [
  "modal/sandbox/create",
  "/v1/modal/sandbox/create",
  "images/generations",
  "phone%2F..%2Fmodal/sandbox/create",
  "voice/../modal/sandbox/create",
  "phone",               // the namespace root is not a route
  "phonebook/lookup",    // prefix, not namespace
  "modal/sandbox/create?x=phone/",
];

for (const path of OUT_OF_NAMESPACE) {
  test(`blockrun_phone refuses '${path}' before reserving or sending anything`, async () => {
    const { call, budget } = harness();
    const res = await call({ path, body: { gpu: "H100", timeout: 86400 } });
    const text = res.content.map((p) => p.text ?? "").join("\n");
    assert.equal(res.isError, true, `'${path}' was not refused: ${text}`);
    assert.match(text, /Invalid path/);
    assert.equal(clientCalls.length, 0, `'${path}' reached the client: ${JSON.stringify(clientCalls)}`);
    assert.equal(httpCalls, 0, `'${path}' reached fetch`);
    assert.equal(budget.spent, 0, `'${path}' left spend booked`);
    assert.equal(budget.calls, 0, `'${path}' was counted as a call`);
  });
}

test("blockrun_phone's refusal names the namespaces it serves", async () => {
  const { call } = harness();
  const res = await call({ path: "modal/sandbox/create", body: {} });
  const text = res.content.map((p) => p.text ?? "").join("\n");
  assert.match(text, /phone\/\*/);
  assert.match(text, /voice\/\*/);
});

test("blockrun_phone still passes phone/* and voice/* through to the client", async () => {
  const { call } = harness();
  const r1 = await call({ path: "phone/lookup", body: { phoneNumber: "+14155550100" } });
  assert.notEqual(r1.isError, true, r1.content.map((p) => p.text).join());
  const r2 = await call({ path: "voice/call/abc" });
  assert.notEqual(r2.isError, true, r2.content.map((p) => p.text).join());
  // A leading slash or v1/ is tolerated, as before; casing is the gateway's problem.
  const r3 = await call({ path: "/v1/voice/call/abc" });
  assert.notEqual(r3.isError, true, r3.content.map((p) => p.text).join());
  assert.deepEqual(clientCalls, [
    { method: "POST", endpoint: "/v1/phone/lookup" },
    { method: "GET", endpoint: "/v1/voice/call/abc" },
    { method: "GET", endpoint: "/v1/voice/call/abc" },
  ]);
  assert.equal(httpCalls, 0);
});
