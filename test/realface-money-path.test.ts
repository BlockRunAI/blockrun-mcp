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
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

let script: Array<() => unknown> = [];
let paymentsSigned = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async () => {
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
    isTimeoutError: () => false,
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    getChain: () => "base",
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => { paymentsSigned++; return "0xpaymentpayloadmock"; },
    parsePaymentRequired: () => ({}),
    // 12000 micro-USDC = $0.012: the gateway's $0.01 base plus the $0.002 fee.
    extractPaymentDetails: () => ({
      amount: "12000",
      recipient: "0x0000000000000000000000000000000000000001",
      network: "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/portrait/enroll", description: "BlockRun Virtual Portrait enrollment" },
      maxTimeoutSeconds: 120,
      extra: {},
    }),
  },
});

const { registerRealfaceTool } = await import("../src/tools/realface.js");

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

beforeEach(() => { script = []; paymentsSigned = 0; });
afterEach(() => { assert.equal(script.length, 0, "unconsumed scripted responses"); });

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
