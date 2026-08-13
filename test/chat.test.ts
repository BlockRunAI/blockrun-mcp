// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateChatCost } from "../src/tools/chat.js";
import { handleAnthropicNative, anthropicCallCost } from "../src/tools/chat-anthropic.js";
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
  assert.equal(estimateChatCost(1024, undefined, "nvidia/gpt-oss-120b"), 0);
});

// ── Every reserve must cover what the gateway actually charges ──
//
// These used to assert that balanced, coding and reasoning reserved the SAME
// amount — true only because all three shared one flat $5/M-input constant. They
// no longer do, and the equality was hiding the bug: that constant was up to
// 9.9x short at the top of the catalog (openai/gpt-5.4-pro charges $1.460020 on
// a 100k-char prompt against the old $0.147480 reserve) while the cheap tiers'
// $1/M constant was 2.46x short on fast[0] after gemini-3.5-flash tripled in
// price. Each tier is now reserved against its own most expensive MEMBER — the
// loop can fall through to any of them — so coding ($5/$25) legitimately
// reserves less than balanced ($5/$30).
//
// Amounts below are live unpaid 402 quotes, 2026-08-13, 100k-char prompt,
// max_tokens 1024. Re-probe with `npm run verify:prices` (which now carries one
// row per tier) rather than adjusting them to match a failing build.
const LIVE_CHARGE_100K: Array<[string | undefined, string | undefined, number]> = [
  // [mode, model, charged]
  [undefined, "openai/gpt-5.4-pro", 1.460020],
  [undefined, "openai/gpt-5.5-pro", 1.460020],
  [undefined, "openai/gpt-5.2-pro", 1.026640],
  [undefined, "openai/o1", 0.727420],
  [undefined, "anthropic/claude-fable-5", 0.486310],
  [undefined, "openai/gpt-5.6-sol", 0.244171],
  [undefined, "anthropic/claude-opus-5", 0.243655],
  [undefined, "openai/gpt-5.6-terra", 0.098269],
  [undefined, "google/gemini-3.5-flash", 0.073951],
  [undefined, "zai/glm-5", 0.049346],
  [undefined, "deepseek/deepseek-v4-pro", 0.021977],
  // Tier routing: the charge is that of the member the loop settles on, so each
  // tier is pinned against its most expensive member's live quote.
  ["powerful", undefined, 1.460020],   // gpt-5.4-pro
  ["balanced", undefined, 0.244171],   // gpt-5.5
  ["reasoning", undefined, 0.243655],  // gpt-5.6-sol / opus-5
  ["coding", undefined, 0.243655],     // claude-opus-5
  ["fast", undefined, 0.073951],       // gemini-3.5-flash
  ["glm", undefined, 0.049346],        // glm-5.x
  ["cheap", undefined, 0.021977],      // deepseek-v4-pro
];

test("estimateChatCost never reserves less than the gateway charges (live 402, 2026-08-13)", () => {
  for (const [mode, model, charged] of LIVE_CHARGE_100K) {
    const reserved = estimateChatCost(1024, mode, model, undefined, 100_000);
    assert.ok(
      reserved >= charged,
      `${mode ?? "no-mode"}/${model ?? "tier"}: reserved ${reserved} < charged ${charged}`,
    );
    // ...and not by an absurd margin, or a stale rate hides behind the cushion
    // and small budgets get locked out of calls they could afford.
    assert.ok(
      reserved <= charged * 2,
      `${mode ?? "no-mode"}/${model ?? "tier"}: reserved ${reserved} is over 2x the ${charged} charge`,
    );
  }
});

test("estimateChatCost keeps the cheap tiers cheaper than the frontier ones", () => {
  const frontier = estimateChatCost(1024, "reasoning", undefined, undefined, 100_000);
  for (const mode of ["cheap", "fast", "glm"]) {
    assert.ok(
      estimateChatCost(1024, mode, undefined, undefined, 100_000) < frontier,
      `${mode} must stay below the frontier reserve or small budgets lose the cheap path`,
    );
  }
});

test("estimateChatCost prices an unknown model at the catalog ceiling, not a guess", () => {
  // A model added upstream between releases has no table entry. $5/$30 covers
  // everything in the catalog except the five pro-tier ids, which ARE listed.
  const unknown = estimateChatCost(1024, undefined, "someone/brand-new-model", undefined, 100_000);
  assert.equal(unknown, estimateChatCost(1024, undefined, "openai/gpt-5.6-sol", undefined, 100_000));
  assert.ok(unknown >= 0.244171);
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

// ── The native Claude ledger must record what the GATEWAY charged ──
//
// It used to book actual tokens x Anthropic's PUBLIC list rates ($15/$75 opus),
// while the gateway resells opus at $5/$25 and settles the QUOTE — which prices
// output at OUTPUT_QUOTE_FACTOR (0.1) of max_tokens, floors at $0.001, and adds
// the transaction fee. A default claude-opus-5 call settles $0.003660 and was
// booked as $0.03: the ledger over-counted 8x, so a budget cap tripped at an
// eighth of its real allowance.
//
// Expected values are live unpaid 402 quotes on /v1/messages, 2026-08-13.
test("anthropicCallCost reconstructs the gateway's quote, not Anthropic's list price", () => {
  const CASES: Array<[string, number, number, number]> = [
    // [model, promptChars, maxTokens, quoted]
    ["claude-opus-5", 2, 1024, 0.003660],
    ["claude-opus-5", 2, 4096, 0.011336],
    ["claude-opus-5", 10_000, 1024, 0.027656],
    ["claude-opus-5", 100_000, 1024, 0.243655],
  ];
  for (const [model, chars, maxTokens, quoted] of CASES) {
    const booked = anthropicCallCost(model, chars, maxTokens);
    assert.ok(booked !== null, `${model} must be priceable`);
    // Within 1% and never under: the ledger may round toward caution, but an
    // 8x over-count is a broken budget and an under-count is an unbilled call.
    assert.ok(booked! >= quoted, `${model} ${chars}c/${maxTokens}t: booked ${booked} < quoted ${quoted}`);
    assert.ok(booked! <= quoted * 1.01, `${model} ${chars}c/${maxTokens}t: booked ${booked} is over 1% above ${quoted}`);
  }
});

test("anthropicCallCost honours the $0.001 floor and the prefixed/bare id", () => {
  // Small calls floor at $0.001 base + the fee, whatever the token maths says.
  assert.equal(anthropicCallCost("claude-opus-5", 2, 100), 0.002);
  assert.equal(anthropicCallCost("claude-haiku-4.5", 2, 1024), 0.002);
  // The response echoes a bare id; the catalog keys on the prefixed one.
  assert.equal(
    anthropicCallCost("claude-opus-5", 10_000, 1024),
    anthropicCallCost("anthropic/claude-opus-5", 10_000, 1024),
  );
  // A date-suffixed id still resolves via the prefix match.
  assert.ok(anthropicCallCost("claude-opus-5-20260101", 2, 1024) !== null);
  // An unknown model returns null so the caller falls back to the estimate,
  // rather than inventing a number.
  assert.equal(anthropicCallCost("claude-does-not-exist", 2, 1024), null);
});
