// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The native claude-* path on the ACCOUNT rail. Mode is derived from
// BLOCKRUN_API_KEY at first use and fixed for the process, so the account-rail
// cases live here and the wallet-rail ones in chat-anthropic-settled.test.ts.
//
// Two things differ on this rail and both were wrong (audit round 3, C20/D58):
// the ledger added the $0.001 x402 transaction fee that api.blockrun.ai never
// charges, and it booked the x402 QUOTE formula (0.1 x max_tokens) on a rail
// that bills exact usage. And a call the account accepted and then lost booked
// $0 with no note at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { handleAnthropicNative } from "../src/tools/chat-anthropic.js";
import { CHAT_PRICE_PER_MTOKEN } from "../src/utils/constants.js";
import type { BudgetState } from "../src/types.js";

process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000";

function newBudget(): BudgetState {
  return { limit: 100, spent: 0, calls: 0, agents: new Map() };
}
function message(): Anthropic.Message {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
  } as Anthropic.Message;
}
function fakeClient(s: { connect: boolean; events?: number; result: Anthropic.Message | Error; costHeader?: string }) {
  return {
    messages: {
      stream: () => {
        const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
        const self = {
          on(ev: string, cb: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(cb); return self; },
          off() { return self; },
          abort() {},
          response: s.costHeader === undefined ? null : new Response(null, { headers: { "x-blockrun-cost-usd": s.costHeader } }),
          finalMessage: async () => {
            await Promise.resolve();
            if (s.connect) for (const cb of listeners.connect ?? []) cb();
            for (let i = 0; i < (s.events ?? 0); i++) for (const cb of listeners.streamEvent ?? []) cb({ type: "content_block_delta" });
            if (s.result instanceof Error) throw s.result;
            return s.result;
          },
        };
        return self;
      },
    },
  };
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const micro = (usd: number) => Math.ceil(usd * 1e6 - 1e-6) / 1e6;
const baseArgs = { model: "anthropic/claude-haiku-4.5", message: "hi", maxTokens: 1024, estimatedCost: 0.05 };

test("account rail: success books reported usage at the model's own rate — no transaction fee, no quote formula (D58)", async () => {
  const budget = newBudget();
  const res = await handleAnthropicNative({ client: fakeClient({ connect: true, events: 2, result: message() }) as never, ...baseArgs, budget });
  assert.equal(res.isError, undefined, res.content[0].text);
  const rate = CHAT_PRICE_PER_MTOKEN["anthropic/claude-haiku-4.5"];
  // 100 in / 50 out at $1/$5 per M = $0.00035. The old ledger booked $0.002
  // (the $0.001 quote floor plus a $0.001 fee this rail does not charge).
  assert.ok(near(budget.spent, micro((100 * rate.input + 50 * rate.output) / 1e6)), `booked ${budget.spent}`);
  assert.equal(res.structuredContent?.cost_is_estimate, true);
  assert.match(res.content[0].text, /Cost: ~\$0\.000[34]/, res.content[0].text);
  assert.match(res.content[0].text, /exact usage/, res.content[0].text);
});

test("account rail: x-blockrun-cost-usd on the stream response is the ledger entry", async () => {
  const budget = newBudget();
  await handleAnthropicNative({ client: fakeClient({ connect: true, events: 2, result: message(), costHeader: "0.001200" }) as never, ...baseArgs, budget });
  assert.ok(near(budget.spent, 0.0012), `booked ${budget.spent}`);
});

test("account rail: a 402 out-of-credit before any stream books nothing and is not called billed", async () => {
  const budget = newBudget();
  const err = Object.assign(new Error("402 BlockRun account API error: 402. Top up at https://user.blockrun.ai/dashboard/credits."), { status: 402 });
  const res = await handleAnthropicNative({ client: fakeClient({ connect: false, result: err }) as never, ...baseArgs, budget });
  assert.equal(res.isError, true);
  assert.equal(budget.spent, 0);
  assert.doesNotMatch(res.content[0].text, /charge stands|has been billed|is billed|second charge/i, res.content[0].text);
});

test("account rail: a failure after the stream connected is billed at exact usage — booked at the model's rate over max_tokens, said plainly", async () => {
  const budget = newBudget();
  const err = Object.assign(new Error("Connection error."), { status: undefined, cause: new Error("terminated") });
  const res = await handleAnthropicNative({ client: fakeClient({ connect: true, events: 3, result: err }) as never, ...baseArgs, budget });
  assert.equal(res.isError, true);
  const rate = CHAT_PRICE_PER_MTOKEN["anthropic/claude-haiku-4.5"];
  // Prompt at the observed chars/token plus the gateway's ~20-token message
  // envelope (the same fit anthropicCallCost uses), output at the full
  // max_tokens — nothing was reported, so the conservative side — no fee.
  const expected = micro(((Math.ceil(2 / 2.08) + 20) * rate.input + 1024 * rate.output) / 1e6);
  assert.ok(near(budget.spent, expected), `booked ${budget.spent}, expected ${expected}`);
  assert.match(res.content[0].text, /accepted/i, res.content[0].text);
  assert.match(res.content[0].text, /billed/i, res.content[0].text);
  assert.match(res.content[0].text, /second charge/i, res.content[0].text);
});
