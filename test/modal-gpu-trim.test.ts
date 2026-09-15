// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// modal sandbox/create is priced off the BODY, and the gateway's
// CreateRequestSchema runs `gpu: z.string().trim()` BEFORE both its allow-list
// check and getModalCreatePricing. So `" H100 "`, `"H100\n"`, an NBSP-padded
// `"H100"` all pass upstream validation and are billed at the H100 rate —
// while estimateModalCost looked the raw string up in a Map, missed, and fell
// to the CPU rate. Unpaid 402 probe 2026-09-13 (no payment header, no money):
//
//   { timeout: 3600, gpu: " H100 " }  -> amount 8001000  ($8.001)   reserved $0.102
//   { timeout: 3600, gpu: "H100\n" }  -> amount 8001000  ($8.001)   reserved $0.102
//   { timeout: 3600, gpu: "h100" }    -> HTTP 400 "Unsupported GPU type: h100"
//   { timeout: 3600, gpu: "NOPE" }    -> HTTP 400
//
// With timeout 86400 that is $2.402 reserved against a $192.002 non-refundable
// charge: past any budget cap, past the confirm dialog (which quoted $2.40),
// and — on the Base rail, where the SDK owns the 402 and reports no settled
// figure — a ledger that booked $2.40 of a $192 spend.
//
// The gateway is case-SENSITIVE (lowercase 400s before payment) and refuses
// every gpu string outside its five tiers, so the only values that diverge are
// whitespace-padded valid names. Two properties are pinned here on both rails
// that can reach Modal (Solana is refused up front by baseOnlyMessage):
//
//   1. the reserve for a padded gpu equals the reserve for the bare one;
//   2. the body that leaves this process carries the TRIMMED gpu, so what was
//      reserved is what is sent — no second normalisation on the far side;
//   3. a gpu the gateway would 400 is refused here, before the reserve, so a
//      hallucinated tier never costs a paid round-trip and the message names
//      the five that exist.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let apiKeyMode = false;
const walletBodies: unknown[] = [];
const stubClient = {
  getWithPaymentRaw: async () => { throw new Error("modal never GETs"); },
  requestWithPaymentRaw: async (_endpoint: string, body: unknown) => { walletBodies.push(body); return { sandbox_id: "sb-1" }; },
};
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getChain: () => "base",
    getClient: () => stubClient,
    buildClient: () => stubClient,
    buildClientWithTimeout: () => stubClient,
    baseOnlyMessage: () => null,
    getOrCreateWalletKey: () => { throw new Error("modal tests must not touch a wallet key"); },
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
const accountBodies: unknown[] = [];
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (_url: string, init: { body?: string }) => {
      accountBodies.push(JSON.parse(init.body ?? "{}"));
      return new Response(JSON.stringify({ sandbox_id: "sb-1" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-blockrun-cost-usd": "192.000000" },
      });
    },
    isTimeoutError: () => false,
  },
});

const { registerModalTool, estimateModalCost } = await import("../src/tools/modal.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
function harness(limit: number | null = null) {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  };
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerModalTool(server as never, budget);
  assert.ok(handler, "blockrun_modal did not register a handler");
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

beforeEach(() => { apiKeyMode = false; walletBodies.length = 0; accountBodies.length = 0; });

const PADDED = [" H100", "H100 ", " H100 ", "H100\n", "\tH100", " H100", "H100\r\n"];

test("estimateModalCost prices a whitespace-padded gpu exactly like the bare tier (the gateway trims)", () => {
  // The bare figures are the gateway's own quotes (see modal-cost.test.ts):
  // 24h H100 $192.002, 1h H100 $8.001 charged / $8.002 reserved, flat H100 $0.402.
  assert.equal(estimateModalCost("sandbox/create", { timeout: 86400, gpu: "H100" }), 192.002);
  for (const timeout of [86400, 3600, 300]) {
    const bare = estimateModalCost("sandbox/create", { timeout, gpu: "H100" });
    assert.ok(bare >= (timeout > 300 ? 8 * (timeout / 3600) : 0.4), `precondition: bare H100 at ${timeout}s reserves the H100 rate`);
    for (const gpu of PADDED) {
      assert.equal(estimateModalCost("sandbox/create", { timeout, gpu }), bare, `${JSON.stringify(gpu)} at ${timeout}s`);
    }
  }
  assert.equal(estimateModalCost("sandbox/create", { timeout: 86400, gpu: " A100 " }), estimateModalCost("sandbox/create", { timeout: 86400, gpu: "A100" }));
});

// A $5 cap admitted " H100" for 24h at the $2.402 CPU reserve. It must now be
// refused at the gate exactly like the bare "H100" is.
test("a $5 cap refuses a padded 24h H100 create the way it refuses the bare one (Base rail)", async () => {
  const { call, budget } = harness(5);
  const bare = await call({ path: "sandbox/create", body: { gpu: "H100", timeout: 86400 } });
  assert.equal(bare.isError, true, "precondition: bare H100 is over a $5 cap");
  for (const gpu of PADDED) {
    const res = await call({ path: "sandbox/create", body: { gpu, timeout: 86400 } });
    const text = res.content.map((p) => p.text ?? "").join("\n");
    assert.equal(res.isError, true, `${JSON.stringify(gpu)} slipped past the $5 cap: ${text}`);
    assert.match(text, /budget|limit/i, text);
  }
  assert.equal(walletBodies.length, 0, "nothing may reach the client under a refused reserve");
  assert.equal(budget.spent, 0);
});

test("the body that leaves this process carries the TRIMMED gpu on the Base rail, and the ledger books the H100 figure", async () => {
  const { call, budget } = harness();
  const res = await call({ path: "sandbox/create", body: { gpu: " H100 ", timeout: 86400, image: "python:3.11" } });
  assert.notEqual(res.isError, true, res.content.map((p) => p.text).join());
  assert.equal(walletBodies.length, 1);
  assert.deepEqual(walletBodies[0], { gpu: "H100", timeout: 86400, image: "python:3.11" });
  // Wallet rail reports no settled figure, so the ledger books the reserve's
  // ledgerFallback — of the H100 price, not the CPU one. 192.002 - 0.002 + 0.001.
  assert.ok(budget.spent > 190, `ledger booked $${budget.spent}, not the H100 figure`);
});

test("the same on the account rail: trimmed body, and the reserve gate sees the H100 price", async () => {
  apiKeyMode = true;
  const capped = harness(5);
  const refused = await capped.call({ path: "sandbox/create", body: { gpu: "H100\n", timeout: 86400 } });
  assert.equal(refused.isError, true, "account rail: padded H100 must not clear a $5 cap");
  assert.equal(accountBodies.length, 0);

  const { call, budget } = harness();
  const res = await call({ path: "sandbox/create", body: { gpu: " H100", timeout: 86400 } });
  assert.notEqual(res.isError, true, res.content.map((p) => p.text).join());
  assert.equal(accountBodies.length, 1);
  assert.deepEqual(accountBodies[0], { gpu: "H100", timeout: 86400 });
  assert.equal(walletBodies.length, 0, "an account call must not touch the wallet client");
  assert.equal(budget.spent, 192, "account rail books the settled x-blockrun-cost-usd");
});

// The gateway 400s every gpu outside its five tiers BEFORE payment — including
// lowercase — so refusing here loses nothing and saves the round-trip. The
// message has to name the tiers: "Unsupported GPU type" alone sends the model
// guessing again.
test("a gpu the gateway would reject is refused before the reserve, on both rails, naming the five tiers", async () => {
  for (const mode of [false, true]) {
    apiKeyMode = mode;
    const { call, budget } = harness();
    for (const gpu of ["h100", "NOPE", "", "  ", "H-100", "toString"]) {
      const res = await call({ path: "sandbox/create", body: { gpu, timeout: 3600 } });
      const text = res.content.map((p) => p.text ?? "").join("\n");
      assert.equal(res.isError, true, `${JSON.stringify(gpu)} (apiKey=${mode}) was not refused: ${text}`);
      assert.match(text, /T4, L4, A10G, A100, H100/, text);
      assert.match(text, /No payment was made/i, text);
    }
    assert.equal(walletBodies.length, 0);
    assert.equal(accountBodies.length, 0);
    assert.equal(budget.spent, 0);
    assert.equal(budget.calls, 0);
  }
});

test("a create with no gpu, or a non-create op, is untouched", async () => {
  const { call } = harness();
  const r1 = await call({ path: "sandbox/create", body: { timeout: 300 } });
  assert.notEqual(r1.isError, true);
  assert.deepEqual(walletBodies[0], { timeout: 300 });
  const r2 = await call({ path: "sandbox/exec", body: { sandbox_id: "sb-1", command: ["echo"], gpu: "whatever" } });
  assert.notEqual(r2.isError, true, "gpu is not a create field; exec must not be validated on it");
  assert.deepEqual(walletBodies[1], { sandbox_id: "sb-1", command: ["echo"], gpu: "whatever" });
});
