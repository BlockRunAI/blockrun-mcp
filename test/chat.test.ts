// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateChatCost, freeTierTruncationNote } from "../src/tools/chat.js";
import { handleAnthropicNative, anthropicCallCost } from "../src/tools/chat-anthropic.js";
import { MODEL_TIERS, CHAT_PRICE_PER_MTOKEN, DEFAULT_CHAT_PRICE, FREE_CHAT_MODELS } from "../src/utils/constants.js";
import { withTxFee } from "../src/utils/tx-fee.js";
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
// Amounts below are live unpaid 402 quotes, last refreshed 2026-09-02, 100k-char prompt,
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
  [undefined, "deepseek/deepseek-v4-pro", 0.064790],
  // Tier routing: the charge is that of the member the loop settles on, so each
  // tier is pinned against its most expensive member's live quote.
  ["powerful", undefined, 1.460020],   // gpt-5.4-pro
  ["balanced", undefined, 0.244171],   // gpt-5.5
  ["reasoning", undefined, 0.243655],  // gpt-5.6-sol / opus-5
  ["coding", undefined, 0.243655],     // claude-opus-5
  ["fast", undefined, 0.073951],       // gemini-3.5-flash
  ["glm", undefined, 0.049346],        // glm-5.x
  ["cheap", undefined, 0.064790],      // deepseek-v4-pro
];

test("estimateChatCost never reserves less than the gateway charges (live 402, refreshed 2026-09-02)", () => {
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
  // everything in the catalog except the ids priced above it, which ARE listed
  // (seven as of 2026-09-08 — `npm run verify:prices` sweeps the live catalogue
  // and fails the moment an eighth appears without a row).
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
// is only sound because every free[] entry is a model the gateway serves at $0 —
// an unenforced invariant on a hand-edited array that has now been rewritten in
// four releases (0.31.x, 0.32.0, 0.32.1, and this one). One paid model landing
// in free[] silently switches the budget gate off for mode:"free", and every
// other test here still passes. Pin it.
//
// This used to pin "every free[] entry is nvidia/*", and the $0 classifier was
// the same vendor test. Both are wrong-by-design since the 2026-09-08 catalogue:
// cohere/north-mini-code and poolside/laguna-xs-2.1 are billed $0 on both
// gateways, so an explicit call to either reserved the $5/$30 default and an
// exhausted budget refused a free call. FREE_CHAT_MODELS is the set now; the
// catalogue sweep in `npm run verify:prices` fails if any member starts costing.
test("every MODEL_TIERS.free entry is in FREE_CHAT_MODELS, and every member reserves $0", () => {
  assert.ok(MODEL_TIERS.free.length > 0, "free tier must not be empty");
  for (const m of MODEL_TIERS.free) {
    assert.ok(FREE_CHAT_MODELS.has(m), `${m} is routed as free but FREE_CHAT_MODELS does not list it — estimateChatCost would reserve for a $0 call`);
  }
  for (const m of FREE_CHAT_MODELS) {
    assert.equal(estimateChatCost(1024, undefined, m, undefined, 600 * 1024), 0, m);
    // The bare spelling is a real, chargeable-or-free id too (see BARE_TO_PREFIXED).
    assert.equal(estimateChatCost(1024, undefined, m.slice(m.indexOf("/") + 1), undefined, 600 * 1024), 0, `bare ${m}`);
  }
});

test("a $0 model outside nvidia/ is free — the classifier is membership, not vendor", () => {
  // Live billing_mode:"free" on both gateways, 2026-09-08. Before FREE_CHAT_MODELS
  // both reserved the unknown-model ceiling (the gpt-5.6-sol figure).
  for (const id of ["cohere/north-mini-code", "poolside/laguna-xs-2.1", "north-mini-code", "laguna-xs-2.1"]) {
    assert.equal(estimateChatCost(1024, undefined, id, undefined, 100_000), 0, id);
  }
  // ...and a paid model from the same vendors is not swept along.
  assert.ok(estimateChatCost(1024, undefined, "cohere/command-a", undefined, 100_000) > 0);
  // The truncation warning stays NVIDIA-only: the 128 KiB silent cap was measured
  // on that path and nowhere else, so it is not asserted for cohere/poolside.
  assert.equal(freeTierTruncationNote(200_000, "cohere/north-mini-code"), null);
  assert.ok(freeTierTruncationNote(200_000, "nvidia/nemotron-3-ultra-550b"));
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
  // A date-suffixed id still resolves — the suffix is stripped, not prefix-matched.
  assert.ok(anthropicCallCost("claude-opus-5-20260101", 2, 1024) !== null);
  // An unknown model returns null so the caller falls back to the estimate,
  // rather than inventing a number.
  assert.equal(anthropicCallCost("claude-does-not-exist", 2, 1024), null);
});

// A prototype key must never produce a $0 reserve. `model` is a free-form
// z.string(), CHAT_PRICE_PER_MTOKEN is an object literal, and a `?? DEFAULT`
// lookup lets Object.prototype members through: they are truthy, so the fallback
// never fires, rate.input is undefined, the arithmetic goes NaN, and withTxFee
// maps NaN to 0 — a reservation the budget gate always approves. This is the
// same fail-open documented on the modal GPU table, and it was live here for the
// length of one commit.
test("estimateChatCost never returns $0 for a prototype-key model", () => {
  const paid = estimateChatCost(1024, undefined, "openai/gpt-5.6-terra", undefined, 100_000);
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    const reserved = estimateChatCost(1024, undefined, key, undefined, 100_000);
    assert.ok(reserved > 0, `model:"${key}" reserved ${reserved} — the gate would approve anything`);
    // It must land on the unknown-model default, which is the catalog ceiling.
    assert.equal(reserved, estimateChatCost(1024, undefined, "someone/unknown", undefined, 100_000), key);
    assert.ok(reserved >= paid, key);
  }
});

// ── Vendor-less model ids are a real, chargeable spelling ──
//
// The gateway serves `gpt-5.4-pro` and `openai/gpt-5.4-pro` at the IDENTICAL
// price (live unpaid 402s, 2026-08-13: both quote $1.460020 on a 100k-char
// prompt; a genuinely unknown id 400s). Every table here keys on the prefixed
// form, so a bare id fell to DEFAULT_CHAT_PRICE and reserved $0.282720 — 5.16x
// short — reopening the under-reserve these tables were added to close, on a
// spelling chat-anthropic.ts already normalises for the ledger.
test("estimateChatCost prices a vendor-less model id exactly like its prefixed twin", () => {
  const PAIRS: Array<[string, string]> = [
    ["gpt-5.4-pro", "openai/gpt-5.4-pro"],
    ["o1", "openai/o1"],
    ["claude-fable-5", "anthropic/claude-fable-5"],
    ["gpt-5.6-terra", "openai/gpt-5.6-terra"],
    ["glm-5", "zai/glm-5"],
  ];
  for (const [bare, prefixed] of PAIRS) {
    assert.equal(
      estimateChatCost(1024, undefined, bare, undefined, 100_000),
      estimateChatCost(1024, undefined, prefixed, undefined, 100_000),
      bare,
    );
  }
  // The bare pro-tier id must still clear its real charge.
  assert.ok(estimateChatCost(1024, undefined, "gpt-5.4-pro", undefined, 100_000) >= 1.460020);
});

test("a vendor-less free model is still free, and still warns about truncation", () => {
  // The mirror case: `startsWith("nvidia/")` on the raw string made a bare free
  // id reserve like a paid one (so an exhausted budget refused a $0 call) and
  // silenced the truncation warning — the one failure that function exists for.
  assert.equal(estimateChatCost(1024, undefined, "gpt-oss-120b", undefined, 100_000), 0);
  assert.equal(estimateChatCost(1024, undefined, "nvidia/gpt-oss-120b", undefined, 100_000), 0);
  const note = freeTierTruncationNote(200_000, "gpt-oss-120b");
  assert.ok(note && /TRUNCATED/.test(note), "a bare free id must still warn about silent truncation");
});

test("every catalog id has a unique vendor-less segment — the mapping cannot be ambiguous", () => {
  const ids = [...Object.keys(CHAT_PRICE_PER_MTOKEN), ...Object.values(MODEL_TIERS).flat(), ...FREE_CHAT_MODELS].filter((i) => i.includes("/"));
  const byBare = new Map<string, Set<string>>();
  for (const id of ids) {
    const bare = id.slice(id.indexOf("/") + 1);
    if (!byBare.has(bare)) byBare.set(bare, new Set());
    byBare.get(bare)!.add(id);
  }
  const clashes = [...byBare.entries()].filter(([, set]) => set.size > 1);
  assert.deepEqual(clashes, [], `two vendors ship the same model name: ${JSON.stringify(clashes)}`);
});

// ── Two flagship ids landed above the default, and nothing noticed ──
//
// Live GET /v1/models on BOTH gateways, 2026-09-08: openai/gpt-6-astra and
// anthropic/claude-fable-5.1 are $10/$50, available, and had no table row, so an
// explicit `model` fell to DEFAULT_CHAT_PRICE ($5/$30) — 2x short on input,
// 1.67x on output, and the confirm-spend prompt showed the same wrong figure.
// This is the exact defect class the table was introduced to close; the table
// header even asserted it held "every catalog model priced ABOVE the default".
// `npm run verify:prices` now sweeps the live catalogue for this shape and fails
// on any above-default id without a row; these pin the two rows that closed it.
test("gpt-6-astra and claude-fable-5.1 reserve at their live $10/$50, not the $5/$30 default", () => {
  assert.deepEqual(CHAT_PRICE_PER_MTOKEN["openai/gpt-6-astra"], { input: 10, output: 50 });
  assert.deepEqual(CHAT_PRICE_PER_MTOKEN["anthropic/claude-fable-5.1"], { input: 10, output: 50 });

  const fable5 = estimateChatCost(1024, undefined, "anthropic/claude-fable-5", undefined, 100_000);
  const unknown = estimateChatCost(1024, undefined, "someone/brand-new-model", undefined, 100_000);
  // Bare spellings ride along: BARE_TO_PREFIXED is derived from the table keys.
  for (const id of ["openai/gpt-6-astra", "anthropic/claude-fable-5.1", "gpt-6-astra", "claude-fable-5.1"]) {
    const reserved = estimateChatCost(1024, undefined, id, undefined, 100_000);
    // 100k chars at 2 chars/token = 50k input tokens at $10/M; 1024 output at $50/M.
    assert.equal(reserved, withTxFee((50_000 / 1e6) * 10 + (1024 / 1e6) * 50), id);
    assert.equal(reserved, fable5, `${id} shares fable-5's $10/$50 rate`);
    assert.ok(reserved > unknown, `${id} must reserve above the unknown-model default (${reserved} vs ${unknown})`);
    // fable-5's live settle for this exact call (LIVE_CHARGE_100K above): same
    // rate, same gateway formula, so the same charge has to be covered.
    assert.ok(reserved >= 0.486310, id);
  }
  // And the default itself did not move: raising it would double the reserve for
  // every genuinely unknown non-pro model and lock small budgets out.
  assert.deepEqual(DEFAULT_CHAT_PRICE, { input: 5, output: 30 });
});

// ── thinking.budget_tokens is only ever SENT on the native claude-* path ──
//
// The schema says "Ignored for non-Claude models", and the handler honours that:
// only handleAnthropicNative receives `thinking`; the multi-turn, explicit-model
// and routing paths build their options from {maxTokens, temperature,
// responseFormat, stop}. But the reserve folded budget_tokens into output
// unconditionally, so mode:"powerful" + a 100k budget reserved ~$18 (gpt-5.4-pro
// at $180/M) for a call that settles at cents — a spurious refusal for a
// delegated agent, and a wrong "Estimated: $X" shown to a human under
// BLOCKRUN_CONFIRM_SPEND. Over-reserve is the safe direction for the gate, but
// a number a human is asked to approve has to be the number the call can settle at.
test("estimateChatCost ignores thinking.budget_tokens for non-Claude models, as the schema promises", () => {
  assert.equal(estimateChatCost(1024, "cheap", undefined, 100_000), estimateChatCost(1024, "cheap", undefined));
  assert.equal(estimateChatCost(1024, "powerful", undefined, 100_000), estimateChatCost(1024, "powerful", undefined));
  assert.equal(estimateChatCost(1024, undefined, "openai/gpt-5.6-terra", 100_000), estimateChatCost(1024, undefined, "openai/gpt-5.6-terra"));
  assert.equal(estimateChatCost(1024, undefined, "gpt-5.4-pro", 100_000), estimateChatCost(1024, undefined, "gpt-5.4-pro"));
  // Every Claude spelling still folds — canonicalChatModel + isAnthropicModel
  // agree with the dispatch in the handler, so prefixed and bare both count.
  assert.ok(estimateChatCost(1024, undefined, "claude-opus-4.8", 100_000) > estimateChatCost(1024, undefined, "claude-opus-4.8") * 10);
  assert.ok(estimateChatCost(1024, undefined, "anthropic/claude-fable-5.1", 100_000) > estimateChatCost(1024, undefined, "anthropic/claude-fable-5.1") * 10);
});

// ── The native ledger keys on the CATALOGUE spelling; the gateway echoes another ──
//
// /v1/messages echoes the UPSTREAM id (blockrun's ANTHROPIC_MODEL_MAP), which is
// dashed and often dated: claude-fable-5-1, claude-haiku-4-5-20251001,
// claude-sonnet-4-5-20250929. The table is dotted: anthropic/claude-fable-5.1.
// The old lookup fell back to a startsWith prefix match, which (a) never fired
// for those dashed echoes — every one silently booked the pre-call estimate
// instead of the reconstructed quote — and (b) DID fire on a version suffix, so
// "claude-fable-5-1" booked claude-fable-5's row: right by coincidence today
// (both $10/$50), and a sibling priced differently from its major would book
// the wrong number with no signal, because "null -> estimate" never engages
// when a rate WAS found. On this path the table IS the ledger.
test("anthropicCallCost normalises the gateway's echo to the catalogue key and never prefix-matches", () => {
  const ECHOES: Array<[string, string]> = [
    ["claude-fable-5-1", "anthropic/claude-fable-5.1"],
    ["claude-fable-5.1", "anthropic/claude-fable-5.1"],
    ["claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5"],
    ["claude-opus-4-8", "anthropic/claude-opus-4.8"],
    ["claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4.5"],
    ["claude-sonnet-4.6-20260301", "anthropic/claude-sonnet-4.6"],
    ["claude-opus-5-20260101", "anthropic/claude-opus-5"],
    ["anthropic/claude-opus-5", "anthropic/claude-opus-5"],
  ];
  for (const [echo, key] of ECHOES) {
    const booked = anthropicCallCost(echo, 100_000, 1024);
    assert.ok(booked !== null, `${echo} must resolve to a row`);
    assert.equal(booked, anthropicCallCost(key, 100_000, 1024), `${echo} -> ${key}`);
  }
  // Rows stay distinct: haiku's echo books haiku, not a dearer sibling.
  assert.ok(anthropicCallCost("claude-haiku-4-5-20251001", 100_000, 1024)! < anthropicCallCost("claude-sonnet-4-5-20250929", 100_000, 1024)!);
  // A sibling with NO row returns null — the estimate fallback — rather than
  // borrowing its major version's rate. This is the mechanism that would have
  // let claude-fable-5.1 book fable-5's row before it had one of its own.
  for (const unlisted of ["claude-sonnet-5-1", "claude-sonnet-5.1", "claude-fable-5-2", "claude-opus-5-5-20270101", "claude-opus-5x", "claude-does-not-exist"]) {
    assert.equal(anthropicCallCost(unlisted, 100_000, 1024), null, `${unlisted} has no row and must not borrow one`);
  }
});

// ── The Anthropic rows are the native LEDGER, so a stale-high row is not "safe" ──
//
// On the OpenAI-compat paths a row above the live rate only over-reserves (the
// gate is tighter than it needs to be; recordActualSpend books the real settle).
// On the native /v1/messages path there is no settlement counter to read, so
// anthropicCallCost books THIS TABLE — and both gateways cut claude-sonnet-5 to
// $2/$10 while the row stayed at $3/$15, a 1.5x over-count on every call that
// tripped budget caps at two-thirds of their real allowance. Live GET /v1/models,
// both gateways, 2026-09-08. The catalogue sweep now fails on an anthropic/* row
// above the Base rate for exactly this reason.
test("claude-sonnet-5 books at the gateway's $2/$10, not the old $3/$15", () => {
  assert.deepEqual(CHAT_PRICE_PER_MTOKEN["anthropic/claude-sonnet-5"], { input: 2, output: 10 });
  // 100k chars -> ceil(100000/2.08)+20 = 48,097 input tokens at $2/M = $0.096194;
  // 1024 max_tokens x 0.1 = 102.4 output tokens at $10/M = $0.001024;
  // + the $0.001 observed fee, ceiled to a micro-USDC = $0.098218.
  assert.equal(anthropicCallCost("claude-sonnet-5", 100_000, 1024), 0.098218);
  // The old row booked $0.146827 for the same call.
  assert.ok(anthropicCallCost("claude-sonnet-5", 100_000, 1024)! < 0.146827 * 0.7);
});
