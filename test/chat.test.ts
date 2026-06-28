// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateChatCost } from "../src/tools/chat.js";
import { handleAnthropicNative } from "../src/tools/chat-anthropic.js";
import type { BudgetState } from "../src/types.js";

function newBudget(limit: number | null = null): BudgetState {
  return { limit, spent: 0, calls: 0, agents: new Map() };
}

// ── #1: routing:"smart" + routing_profile:"free" must NOT bypass the gate ──
test("estimateChatCost reserves a non-zero amount for smart+free (paid model, no bypass)", () => {
  // routing_profile:"free" maps to undefined → the SDK routes to a PAID auto
  // tier, so reserving $0 here would skip the budget gate entirely.
  assert.ok(estimateChatCost(1024, undefined, undefined, "smart", "free") > 0);
});

test("estimateChatCost: smart+free reserves the same as smart+auto", () => {
  assert.equal(
    estimateChatCost(1024, undefined, undefined, "smart", "free"),
    estimateChatCost(1024, undefined, undefined, "smart", "auto"),
  );
});

test("estimateChatCost reserves for the extended-thinking budget, not just max_tokens", () => {
  const noThink = estimateChatCost(1024, undefined, "anthropic/claude-opus-4.8", undefined, undefined);
  const withThink = estimateChatCost(1024, undefined, "anthropic/claude-opus-4.8", undefined, undefined, 100_000);
  assert.ok(withThink > noThink * 10, `100k thinking budget should reserve far more (got ${withThink} vs ${noThink})`);
});

test("estimateChatCost keeps genuinely-free paths at $0", () => {
  assert.equal(estimateChatCost(1024, "free", undefined, undefined, undefined), 0);
  assert.equal(estimateChatCost(1024, undefined, "nvidia/deepseek-v4-flash", undefined, undefined), 0);
});

// ── #10: JSON mode must reach the native Anthropic path ──
function fakeNative() {
  return {
    model: "claude-haiku-4.5",
    content: [{ type: "text", text: "{}" }],
    usage: { input_tokens: 5, output_tokens: 5 },
    stop_reason: "end_turn",
  };
}

test("handleAnthropicNative folds json_object into the system prompt", async () => {
  let captured: any;
  const client = { messages: { create: async (p: any) => { captured = p; return fakeNative(); } } };
  await handleAnthropicNative({
    client: client as any,
    model: "anthropic/claude-haiku-4.5",
    message: "give me json",
    responseFormat: { type: "json_object" },
    budget: newBudget(),
    estimatedCost: 0.01,
  });
  assert.match(String(captured.system ?? ""), /json/i);
});

test("handleAnthropicNative sends a data:image/jpg URI as a base64 image source", async () => {
  let captured: any;
  const client = { messages: { create: async (p: any) => { captured = p; return fakeNative(); } } };
  await handleAnthropicNative({
    client: client as any,
    model: "anthropic/claude-haiku-4.5",
    message: "describe",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpg;base64,QQ==" } }] }],
    budget: newBudget(),
    estimatedCost: 0.01,
  });
  const blocks = (captured.messages as any[]).flatMap((m) => Array.isArray(m.content) ? m.content : []);
  const img = blocks.find((b: any) => b.type === "image");
  assert.ok(img, "an image block should be sent");
  assert.equal(img.source.type, "base64");
  assert.equal(img.source.media_type, "image/jpeg"); // jpg normalized to jpeg
});

test("handleAnthropicNative adds no JSON instruction for plain text", async () => {
  let captured: any;
  const client = { messages: { create: async (p: any) => { captured = p; return fakeNative(); } } };
  await handleAnthropicNative({
    client: client as any,
    model: "anthropic/claude-haiku-4.5",
    message: "hello",
    budget: newBudget(),
    estimatedCost: 0.01,
  });
  assert.doesNotMatch(String(captured.system ?? ""), /respond with only valid json/i);
});
