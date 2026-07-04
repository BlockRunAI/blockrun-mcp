// Run with: npm test  (tsx --experimental-test-module-mocks --test)
// Drives the real blockrun_music handler with the HTTP layer and x402 payment
// helpers mocked — no network, no spend. Uses the inline 200 fast path so there
// is no polling delay. Asserts the track output carries the settled Cost line.
// node --test isolates each file in its own process, so these mocks don't leak.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

// fetchWithTimeout sequence: 1) POST → 402, 2) POST(pay) → 200 inline track.
let fetchCall = 0;
const fakeFetch = async () => {
  fetchCall++;
  if (fetchCall === 1) {
    return { status: 402, ok: false, headers: headers({ "payment-required": "x402 base ..." }), json: async () => ({}) };
  }
  return {
    status: 200, ok: true,
    headers: headers({ "X-Payment-Receipt": "0xmusictxhash" }),
    json: async () => ({ model: "minimax/music-1.5", data: [{ url: "https://blockrun.ai/media/track_1.mp3", duration_seconds: 183 }] }),
  };
};

mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: fakeFetch, isTimeoutError: () => false },
});
mock.module("../src/utils/wallet.js", {
  namedExports: { getChain: () => "base", getOrCreateWalletKey: () => TEST_KEY },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => "0xpaymentpayloadmock",
    parsePaymentRequired: () => ({}),
    // 200000 micro-USDC = $0.20 — deliberately != the flat MUSIC_COST ($0.1575),
    // proving the footer reports the real 402 quote, not the estimate constant.
    extractPaymentDetails: () => ({
      amount: "200000",
      recipient: "0x0000000000000000000000000000000000000001",
      network: "eip155:8453",
      resource: { url: "https://blockrun.ai/api/v1/audio/generations", description: "BlockRun Music Generation" },
      maxTimeoutSeconds: 300,
      extra: {},
    }),
  },
});

const { registerMusicTool } = await import("../src/tools/music.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_n: string, _c: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerMusicTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

test("music output reports the settled Cost from the 402 quote", async () => {
  const { call, budget } = makeHarness();
  const res = await call({ prompt: "lofi beat", model: "minimax/music-1.5" });
  const text = res.content.map((c: any) => c.text).join("\n");

  assert.match(text, /Cost: \$0\.2000/);
  assert.equal(res.structuredContent.cost_usd, 0.2);
  assert.ok(Math.abs(budget.spent - 0.2) < 1e-9, `budget.spent ${budget.spent} ≈ 0.2`);
});
