// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// response_format "json_object" on the native claude-* path.
//
// The tool describes the flag as "force valid JSON output (no markdown fences).
// Works across all providers." On /v1/chat/completions the gateway does both
// halves: it injects the instruction AND strips the fence Claude puts round
// JSON anyway (blockrun ai-providers.ts stripJsonFence). /v1/messages has no
// response_format at all, so this repo injects the instruction itself — and
// until this test it stopped there. Reproduced 2026-09-20 on claude-haiku-4.5:
// the instruction lands (keys go from unquoted to quoted, +24 input tokens),
// the fence stays, and JSON.parse(response) throws on the leading backtick. The
// description promised the half that failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { handleAnthropicNative } from "../src/tools/chat-anthropic.js";
import type { BudgetState } from "../src/types.js";

process.env.BLOCKRUN_API_KEY = "brk_live_testkeyfortestsonly0000";

function newBudget(): BudgetState {
  return { limit: 100, spent: 0, calls: 0, agents: new Map() };
}
function message(text: string): Anthropic.Message {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 47, output_tokens: 30, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
  } as Anthropic.Message;
}
function fakeClient(result: Anthropic.Message) {
  return {
    messages: {
      stream: () => {
        const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
        const self = {
          on(ev: string, cb: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(cb); return self; },
          off() { return self; },
          abort() {},
          response: null,
          finalMessage: async () => {
            await Promise.resolve();
            for (const cb of listeners.connect ?? []) cb();
            return result;
          },
        };
        return self;
      },
    },
  };
}
const baseArgs = { model: "anthropic/claude-haiku-4.5", message: "city + population as JSON", maxTokens: 80, estimatedCost: 0.05 };

// Verbatim from the 2026-09-20 reproduction.
const FENCED = "```json\n{\n  \"city\": \"Tokyo\",\n  \"population\": 37400068\n}\n```";
const BARE = "{\n  \"city\": \"Tokyo\",\n  \"population\": 37400068\n}";

test("json_object: a reply that is one fenced block comes back as the JSON inside it, parseable", async () => {
  const res = await handleAnthropicNative({
    client: fakeClient(message(FENCED)) as never, ...baseArgs, budget: newBudget(),
    responseFormat: { type: "json_object" },
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const response = res.structuredContent?.response;
  assert.equal(response, BARE);
  assert.deepEqual(JSON.parse(response as string), { city: "Tokyo", population: 37400068 });
  // The text a caller reads is the header, a blank line, then the answer —
  // the fence must be gone there too, not only in structuredContent.
  assert.ok(res.content[0].text.includes(`\n\n${BARE}`), res.content[0].text);
  assert.ok(!res.content[0].text.includes("```"), res.content[0].text);
});

test("json_object: an unfenced reply is untouched", async () => {
  const res = await handleAnthropicNative({
    client: fakeClient(message(BARE)) as never, ...baseArgs, budget: newBudget(),
    responseFormat: { type: "json_object" },
  });
  assert.equal(res.structuredContent?.response, BARE);
});

test("json_object: a fence with no language tag, and CRLF line ends, is stripped too", async () => {
  const res = await handleAnthropicNative({
    client: fakeClient(message("```\r\n{\"ok\": true}\r\n```\r\n")) as never, ...baseArgs, budget: newBudget(),
    responseFormat: { type: "json_object" },
  });
  assert.equal(res.structuredContent?.response, "{\"ok\": true}");
});

test("json_object: prose around a fence is NOT a fenced reply — left alone, so nothing is silently discarded", async () => {
  // The gateway's stripJsonFence only unwraps a reply that IS the block. Text
  // outside it means the model ignored the instruction; hiding that by cutting
  // the prose would hand back JSON that was never the whole answer.
  const mixed = "Here you go:\n```json\n{\"ok\": true}\n```";
  const res = await handleAnthropicNative({
    client: fakeClient(message(mixed)) as never, ...baseArgs, budget: newBudget(),
    responseFormat: { type: "json_object" },
  });
  assert.equal(res.structuredContent?.response, mixed);
});

test("without json_object a fenced reply is returned verbatim — the strip is a JSON-mode promise, not a global rewrite", async () => {
  const res = await handleAnthropicNative({
    client: fakeClient(message(FENCED)) as never, ...baseArgs, budget: newBudget(),
  });
  assert.equal(res.structuredContent?.response, FENCED);
});

test("json_object: the raw upstream message keeps the fence — `native` is evidence, not the answer", async () => {
  const res = await handleAnthropicNative({
    client: fakeClient(message(FENCED)) as never, ...baseArgs, budget: newBudget(),
    responseFormat: { type: "json_object" },
  });
  const native = res.structuredContent?.native as Anthropic.Message;
  assert.equal((native.content[0] as { text: string }).text, FENCED);
});
