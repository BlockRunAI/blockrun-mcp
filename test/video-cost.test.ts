// Run with: npm test  (tsx --experimental-test-module-mocks --test)
// Drives the real blockrun_video handler end-to-end with the HTTP layer and the
// x402 payment helpers mocked, so NO network call and NO spend happen. Asserts
// the completed-video output now carries a Cost line. node --test runs each file
// in its own child process, so these module mocks don't leak into other tests.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

// A well-known throwaway test key (Hardhat account #1) — privateKeyToAccount
// runs for real before the mocked createPaymentPayload, so the key must be valid.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Case-insensitive header bag mimicking fetch's Headers.get.
function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

// fetchWithTimeout call sequence for one video job:
//   1) POST submit  → 402 with a PAYMENT-REQUIRED header
//   2) POST submit  → 202 { id, poll_url, status:"queued" }
//   3) GET  poll    → 200 { status:"completed", data:[...] }
let fetchCall = 0;
const fakeFetch = async () => {
  fetchCall++;
  if (fetchCall === 1) {
    return { status: 402, ok: false, headers: headers({ "payment-required": "x402 base ..." }), json: async () => ({}) };
  }
  if (fetchCall === 2) {
    return {
      status: 202, ok: false,
      headers: headers({}),
      json: async () => ({ id: "vid_123", poll_url: "/api/v1/videos/poll/vid_123", status: "queued", model: "xai/grok-imagine-video" }),
    };
  }
  return {
    status: 200, ok: true,
    headers: headers({ "X-Payment-Receipt": "0xabc123txhash" }),
    json: async () => ({
      status: "completed",
      model: "xai/grok-imagine-video",
      data: [{ url: "https://blockrun.ai/media/vid_123.mp4", duration_seconds: 8, request_id: "req_789", backed_up: true }],
    }),
  };
};

mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: fakeFetch,
    isTimeoutError: () => false,
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => "base",
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => "0xpaymentpayloadmock",
    parsePaymentRequired: () => ({}),
    // 400000 micro-USDC = $0.40 settled (grok-imagine-video @ $0.05/s × 8s).
    extractPaymentDetails: () => ({
      amount: "400000",
      recipient: "0x0000000000000000000000000000000000000001",
      network: "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/videos/generations", description: "BlockRun Video Generation" },
      maxTimeoutSeconds: 600,
      extra: {},
    }),
  },
});

const { registerVideoTool } = await import("../src/tools/video.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerVideoTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

test("completed video output includes the settled Cost line (full output printed)", async () => {
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "a rocket launch", model: "xai/grok-imagine-video" });
  const text = res.content.map((c: any) => c.text).join("\n");

  // Print the full tool output so we can eyeball it.
  console.log("\n----- blockrun_video full output -----\n" + text + "\n--------------------------------------");
  console.log("structuredContent:", JSON.stringify(res.structuredContent, null, 2));

  assert.match(text, /Cost: \$0\.4000/);
  assert.equal(res.structuredContent.cost_usd, 0.4);
  // The ledger books the settled amount, but only after reserve-then-release of
  // a DIFFERENT number (the estimate), so binary float leaves sub-microdollar
  // dust: spent = 0.422001 + 0.4 - 0.422001 = 0.39999999999999997. Exact equality
  // held here only while the estimate happened to equal the settled price, which
  // stopped being true once the estimator started including the gateway's margin
  // and transaction fee. A tolerance well under one microdollar is the real
  // invariant — anything larger would mean the reservation didn't fully release.
  assert.ok(Math.abs(budget.spent - 0.4) < 1e-9, `booked ${budget.spent}, expected ~0.4`);
});
