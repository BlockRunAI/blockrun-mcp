// Run with: npm test  (tsx --test)
//
// Pins the mode:"free" fallback deadline added in 0.32.1.
//
// Free NVIDIA models fail by CRAWLING, not by erroring — the measurement that
// excluded mistral-large-3-675b was 2s on a toy ping and 123.2s on a real
// prompt — and the SDK's default request timeout is 600s. With eight entries in
// MODEL_TIERS.free, an unbounded loop could hold a single MCP tool call for
// eighty minutes. These tests assert the loop gives up, and that the bound is on
// the WHOLE loop rather than per-model (so adding a ninth free model can never
// lengthen the worst case again).
//
// No network and no clock-waiting: the fake client resolves slowly against fake
// timers, so a "120s" model costs the suite nothing.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";
import { MODEL_TIERS, FREE_MODEL_TIMEOUT_MS, FREE_TIER_DEADLINE_MS } from "../src/utils/constants.js";

// Records which models were attempted and how long each was allowed to run.
const attempts: string[] = [];
let clientTimeoutMs: number | undefined;
// How long each simulated call takes before it would resolve.
let modelLatencyMs = 0;

// A virtual clock. The loop bounds itself with Date.now(), so advancing this
// instead of really sleeping keeps the suite instant and fully deterministic.
let now = 1_000_000;
const realDateNow = Date.now;

function makeFakeClient(timeout?: number) {
  return {
    chat: async (model: string) => {
      attempts.push(model);
      // Emulate the SDK's AbortController: a model slower than its timeout burns
      // the whole timeout and then rejects. Time passes on the virtual clock.
      const budgetMs = timeout ?? 600_000;
      if (modelLatencyMs >= budgetMs) {
        now += budgetMs;
        throw new Error(`timeout after ${budgetMs}ms`);
      }
      now += modelLatencyMs;
      return "hello from " + model;
    },
    getSpending: () => 0,
  };
}

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),

    getChain: () => "base",
    buildClient: () => makeFakeClient(),
    buildClientWithTimeout: (ms: number) => {
      clientTimeoutMs = ms;
      return makeFakeClient(ms);
    },
    getAnthropicClient: () => null,
    baseOnlyMessage: () => "base only",
    getOrCreateWalletKey: () => "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    getWalletInfo: async () => ({ address: "0xTEST" }),
  },
});

const { registerChatTool } = await import("../src/tools/chat.js");

function makeHarness() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = {
    registerTool: (_name: string, _cfg: unknown, h: any) => { handler = h; },
    server: { getClientCapabilities: () => ({}) },
  } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerChatTool(server, budget);
  return { call: (args: Record<string, unknown>) => handler!(args), budget };
}

function reset() {
  attempts.length = 0;
  clientTimeoutMs = undefined;
  modelLatencyMs = 0;
  now = 1_000_000;
}

test("the free tier is built with the short per-model timeout, not the 600s default", async () => {
  reset();
  const { call } = makeHarness();
  await call({ message: "hi", mode: "free", max_tokens: 16, temperature: 1 });
  assert.equal(clientTimeoutMs, FREE_MODEL_TIMEOUT_MS);
  assert.ok(FREE_MODEL_TIMEOUT_MS < 600_000, "must be shorter than the SDK default");
});

test("a healthy free tier still answers from free[0] and tries nothing else", async () => {
  reset();
  modelLatencyMs = 5; // a fast, healthy model
  const { call } = makeHarness();
  const res = await call({ message: "hi", mode: "free", max_tokens: 16, temperature: 1 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(attempts, [MODEL_TIERS.free[0]]);
});

test("paid tiers get NO deadline — a long frontier completion is the job, not a fault", async () => {
  reset();
  const { call } = makeHarness();
  await call({ message: "hi", mode: "reasoning", max_tokens: 16, temperature: 1 });
  assert.equal(clientTimeoutMs, undefined, "buildClientWithTimeout must not be used for paid tiers");
});

// The core regression guard. Every free model crawls past its per-model timeout,
// so each attempt burns FREE_MODEL_TIMEOUT_MS. The loop must stop starting new
// attempts once FREE_TIER_DEADLINE_MS is spent instead of walking all eight.
test("a fully degraded free tier gives up on the cumulative deadline, not after all 8 models", async () => {
  reset();
  modelLatencyMs = FREE_MODEL_TIMEOUT_MS; // every model hits its timeout
  Date.now = () => now;
  let res: any;
  try {
    const { call } = makeHarness();
    res = await call({ message: "hi", mode: "free", max_tokens: 16, temperature: 1 });
  } finally {
    Date.now = realDateNow;
  }

  const maxAttempts = Math.ceil(FREE_TIER_DEADLINE_MS / FREE_MODEL_TIMEOUT_MS);
  assert.ok(
    attempts.length <= maxAttempts,
    `should stop at the deadline (<= ${maxAttempts} attempts), tried ${attempts.length}`,
  );
  assert.ok(
    attempts.length < MODEL_TIERS.free.length,
    "must NOT walk the entire free tier — that is the 80-minute worst case this bounds",
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /free tier did not answer/i);
});

// Guards the shape of the bound itself, so a later edit can't quietly restore an
// unbounded (or per-model-only) worst case.
test("the deadline actually bounds the tier: total < models x per-model timeout", () => {
  assert.ok(FREE_MODEL_TIMEOUT_MS > 0 && FREE_TIER_DEADLINE_MS > 0);
  assert.ok(
    FREE_TIER_DEADLINE_MS > FREE_MODEL_TIMEOUT_MS,
    "the loop must get to try more than one model",
  );
  assert.ok(
    FREE_TIER_DEADLINE_MS < MODEL_TIERS.free.length * FREE_MODEL_TIMEOUT_MS,
    "a total deadline that exceeds models x per-model timeout bounds nothing",
  );
});
