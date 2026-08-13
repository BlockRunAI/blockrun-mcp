// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// A chat call that SETTLES and then fails must still be booked, and must not be
// followed by a second settlement under the same reservation.
//
// x402 settles when the gateway answers 200 — the SDK increments its own
// sessionTotalUsd at that moment, before the body is read. Streaming (which
// every paid path uses) can still fail after that point: a mid-stream error
// event, an idle stall, an empty completion. The old code computed the spend
// delta only AFTER `run()` resolved, so on that path the USDC left the wallet
// and `budget.spent` never moved; the `finally` then released the reservation,
// leaving the ledger showing a free call. In the tier-routing loop the handler
// went on to try the next model and settle a SECOND payment — one reservation,
// one booking, N charges.
//
// No network and no real wallet: the client is a fake whose getSpending()
// mimics the SDK (incremented on "settlement", regardless of what happens next).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Scripted per-model behaviour for the fake client, set by each test.
type Attempt = { settleUsd: number; fail: boolean };
let script: Map<string, Attempt>;
let attempts: string[];

function makeFakeClient() {
  let total = 0;
  const run = async (model: string) => {
    attempts.push(model);
    const a = script.get(model) ?? { settleUsd: 0, fail: false };
    // Settlement happens on the 200, BEFORE the body is assembled.
    total += a.settleUsd;
    if (a.fail) throw new Error(`stream failed after settlement for ${model}`);
    return `reply from ${model}`;
  };
  return {
    getSpending: () => ({ totalUsd: total }),
    chat: async (model: string) => run(model),
    chatCompletion: async (model: string) => ({ choices: [{ message: { content: await run(model) } }] }),
    // No chatCompletionStream: supportsStreaming() is false, so the handler
    // takes the non-streaming path. The settle-then-throw shape is identical.
  };
}

mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => "base",
    buildClient: () => makeFakeClient(),
    buildClientWithTimeout: () => makeFakeClient(),
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0xTEST" }),
    getAnthropicClient: () => { throw new Error("not used"); },
    baseOnlyMessage: () => null,
  },
});

const { registerChatTool } = await import("../src/tools/chat.js");

function makeHarness(limit = 100) {
  const budget: BudgetState = { spent: 0, calls: 0, limit, agents: new Map() };
  let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  const server = {
    registerTool: (_n: string, _c: unknown, h: typeof handler) => { handler = h; },
  } as unknown as Parameters<typeof registerChatTool>[0];
  registerChatTool(server, budget);
  return { budget, call: (args: Record<string, unknown>) => handler!(args) };
}

test("a settled-then-failed chat is BOOKED, not silently forgotten", async () => {
  script = new Map([["openai/gpt-5.6-terra", { settleUsd: 0.0412, fail: true }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, true, "the caller must still see the failure");
  // The money left the wallet — the ledger has to say so, or the next call is
  // authorized against a budget that has already been spent.
  assert.ok(
    Math.abs(budget.spent - 0.0412) < 1e-9,
    `settled $0.0412 must be booked; budget.spent = ${budget.spent}`,
  );
});

test("a chat that fails BEFORE settling books nothing", async () => {
  // The common case (400, timeout, refusal): no payment, so no charge to book.
  // Booking the estimate here would invent spend that never happened.
  script = new Map([["openai/gpt-5.6-terra", { settleUsd: 0, fail: true }]]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", model: "openai/gpt-5.6-terra", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0, `nothing settled, so nothing should be booked (got ${budget.spent})`);
});

test("the routing loop stops after a payment settles — one reservation, one charge", async () => {
  // reasoning[] = [claude-opus-5, claude-opus-4.8, gpt-5.6-sol, ...]. The first
  // is an anthropic/* id, which the native branch would grab, so drive the loop
  // through `powerful`... both start with anthropic. Use `cheap`, whose primary
  // is deepseek-v4-pro: it settles and then dies mid-stream.
  script = new Map([
    ["deepseek/deepseek-v4-pro", { settleUsd: 0.0217, fail: true }],
    ["qwen/qwen3.7-flash", { settleUsd: 0.0031, fail: false }],
  ]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", mode: "cheap", max_tokens: 1024, temperature: 1 });

  assert.deepEqual(
    attempts,
    ["deepseek/deepseek-v4-pro"],
    "once a payment has settled the loop must stop — retrying charges the caller twice for one tool call",
  );
  assert.equal(res.isError, true);
  assert.ok(/charge stands|already been charged|settled/i.test(res.content[0].text), res.content[0].text);
  assert.ok(Math.abs(budget.spent - 0.0217) < 1e-9, `booked ${budget.spent}`);
});

test("the routing loop still falls through when nothing settled (the free tier's whole design)", async () => {
  // Free NVIDIA models settle $0. A failure there must NOT stop the fallback,
  // or mode:"free" loses the resilience it exists for.
  script = new Map([
    ["nvidia/gpt-oss-120b", { settleUsd: 0, fail: true }],
    ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", { settleUsd: 0, fail: true }],
    ["nvidia/step-3.7-flash", { settleUsd: 0, fail: false }],
  ]);
  attempts = [];
  const { budget, call } = makeHarness();

  const res = await call({ message: "hi", mode: "free", max_tokens: 1024, temperature: 1 });

  assert.equal(res.isError, undefined, res.content[0].text);
  assert.equal(attempts.length, 3, `expected fallthrough to the third model, got ${attempts.join(", ")}`);
  assert.equal(budget.spent, 0);
});
