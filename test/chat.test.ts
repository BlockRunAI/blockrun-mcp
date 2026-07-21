// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateChatCost } from "../src/tools/chat.js";
import { handleAnthropicNative } from "../src/tools/chat-anthropic.js";
import { MODEL_TIERS } from "../src/utils/constants.js";
import type { BudgetState } from "../src/types.js";

function newBudget(limit: number | null = null): BudgetState {
  return { limit, spent: 0, calls: 0, agents: new Map() };
}

// routing:"smart" was removed in 0.30.6 along with the ClawRouter dependency, so
// the smart+free gate-bypass cases it used to guard are gone with it. Every path
// below still resolves a tier/model AFTER the gate, so the worst-case reserve
// rules these pin are what keep an agent loop from draining the wallet.

test("estimateChatCost reserves for the extended-thinking budget, not just max_tokens", () => {
  const noThink = estimateChatCost(1024, undefined, "anthropic/claude-opus-4.8");
  const withThink = estimateChatCost(1024, undefined, "anthropic/claude-opus-4.8", 100_000);
  assert.ok(withThink > noThink * 10, `100k thinking budget should reserve far more (got ${withThink} vs ${noThink})`);
});

test("estimateChatCost keeps genuinely-free paths at $0", () => {
  assert.equal(estimateChatCost(1024, "free", undefined), 0);
  assert.equal(estimateChatCost(1024, undefined, "nvidia/deepseek-v4-flash"), 0);
});

// ── balanced/coding tiers have FRONTIER primaries (gpt-5.6-terra / claude-opus-4.8),
//    so the gate must reserve the frontier worst-case — not the cheap heuristic ──
test("estimateChatCost reserves the frontier worst-case for balanced/coding (their primary is a frontier model)", () => {
  const frontier = estimateChatCost(1024, "reasoning", undefined);
  assert.equal(estimateChatCost(1024, "balanced", undefined), frontier);
  assert.equal(estimateChatCost(1024, "coding", undefined), frontier);
});

test("estimateChatCost reserves the frontier worst-case for a no-mode chat (defaults to the balanced tier → gpt-5.6-terra)", () => {
  const frontier = estimateChatCost(1024, "reasoning", undefined);
  assert.equal(estimateChatCost(1024, undefined, undefined), frontier);
});

test("estimateChatCost keeps the explicitly-cheap tiers on the budget-model heuristic", () => {
  const frontier = estimateChatCost(1024, "reasoning", undefined);
  for (const mode of ["cheap", "fast", "glm"]) {
    assert.ok(
      estimateChatCost(1024, mode, undefined) < frontier,
      `${mode} should stay on the cheap heuristic, not the frontier reserve`,
    );
  }
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

// estimateChatCost reserves $0 for mode:"free" with no model to override it. That
// is only sound because every free[] entry is an nvidia/* model the gateway serves
// at $0 — an unenforced invariant on a hand-edited array that has now been
// rewritten in three consecutive releases (0.31.x, 0.32.0, 0.32.1). One paid model
// landing in free[] silently switches the budget gate off for mode:"free", and
// every other test here still passes. Pin it.
test("every MODEL_TIERS.free entry is an nvidia/* model (keeps the $0 reserve honest)", () => {
  assert.ok(MODEL_TIERS.free.length > 0, "free tier must not be empty");
  for (const m of MODEL_TIERS.free) {
    assert.ok(
      m.startsWith("nvidia/"),
      `${m} is in the free tier but is not nvidia/* — estimateChatCost would reserve $0 for a paid model`,
    );
  }
});

// A tier that empties out resolves MODEL_TIERS[mode][0] to undefined, which sends
// the caller to the hard-coded balanced fallback while still being charged as the
// mode they asked for. Cheap to catch here.
test("no MODEL_TIERS tier is empty", () => {
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    assert.ok(models.length > 0, `tier ${tier} is empty`);
  }
});

// Duplicate IDs inside one tier mean the routing loop retries the same failing
// model instead of falling through to a different one.
test("no MODEL_TIERS tier repeats a model id", () => {
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    assert.equal(new Set(models).size, models.length, `tier ${tier} contains a duplicate id`);
  }
});

// Until 0.32.3 the reserve came from output alone, so a large pasted document
// reserved the same as a one-line question: a 100k-word prompt settled $0.2557
// against a $0.0225 reserve (11.4x short), break-even at only ~15 KB of prompt.
// One approved call blew a BLOCKRUN_BUDGET_LIMIT several times over.
test("estimateChatCost scales the reserve with prompt size, not just max_tokens", () => {
  const tiny = estimateChatCost(1024, "balanced", undefined, undefined, 50);
  const big = estimateChatCost(1024, "balanced", undefined, undefined, 600 * 1024);
  assert.ok(big > tiny * 10, `a 600 KB prompt must reserve far more than a one-liner (${big} vs ${tiny})`);
  assert.ok(big > 0.2557, `must cover the measured $0.2557 settle, got ${big}`);
});

test("prompt size does not make a genuinely free call cost anything", () => {
  assert.equal(estimateChatCost(1024, "free", undefined, undefined, 600 * 1024), 0);
  assert.equal(estimateChatCost(1024, undefined, "nvidia/gpt-oss-120b", undefined, 600 * 1024), 0);
});

test("omitting promptChars keeps the previous reserve (no silent inflation)", () => {
  assert.equal(estimateChatCost(1024, "balanced", undefined), estimateChatCost(1024, "balanced", undefined, undefined, 0));
});
