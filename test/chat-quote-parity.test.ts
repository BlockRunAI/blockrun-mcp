// The parts of the gateway's chat quote that sit ON TOP of list rate x tokens,
// mirrored by the reserve (estimateChatCost) and the native ledger
// (anthropicCallCost). Each one was missing until 2026-11-23 and each one made
// the reserve short of a live charge (verify:prices, that day):
//
//   - the 5% chat platform fee (blockrun PF-1..PF-9, live 2026-11-18)
//   - the GPT-6.2 cache-write premium (blockrun G62-015)
//   - grok-4.7's 2,000-token reasoning allowance (blockrun#830)
//
// The live 402 figures these produce are pinned in chat.test.ts
// (LIVE_CHARGE_100K, anthropicCallCost CASES); this file pins the arithmetic
// against the same constants the code reads.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateChatCost, accountLedgerUsd } from "../src/tools/chat.js";
import { anthropicAccountLedgerUsd } from "../src/tools/chat-anthropic.js";
import {
  CACHE_WRITE_QUOTED_PRICE_PER_MTOKEN,
  CHAT_PLATFORM_FEE_FACTOR,
  CHAT_PLATFORM_FEE_PERCENT,
  CHAT_PRICE_PER_MTOKEN,
  FREE_CHAT_MODELS,
  GATEWAY_CHARS_PER_TOKEN,
  MODEL_TIERS,
  REASONING_OUTPUT_ALLOWANCE_TOKENS,
  chatQuoteRateAt,
  chatRateAt,
  reasoningAllowanceTokens,
  tierWorstPriceAt,
} from "../src/utils/constants.js";
import { withTxFee } from "../src/utils/tx-fee.js";

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** What estimateChatCost reserves for `tokens` in / `out` out at `rate`, fee before the floor. */
function reserve(rate: { input: number; output: number }, tokens: number, out: number): number {
  return withTxFee(Math.max((micro((tokens / 1e6) * rate.input) + micro((out / 1e6) * rate.output)) * CHAT_PLATFORM_FEE_FACTOR, 0.001));
}

// ── Platform fee ──

test("the platform fee mirrors the gateway's CHAT_PLATFORM_FEE_PERCENT", () => {
  // blockrun src/lib/chat-quote.ts and sol §3.15, both 5 since 2026-11-18.
  // Moving this is a re-probe (`npm run verify:prices`), not an edit to match.
  assert.equal(CHAT_PLATFORM_FEE_PERCENT, 5);
  assert.equal(CHAT_PLATFORM_FEE_FACTOR, 1.05);
});

test("the reserve multiplies a per-token chat amount by the platform fee", () => {
  for (const id of ["anthropic/claude-opus-5", "openai/gpt-5.4-pro", "google/gemini-3.5-flash", "deepseek/deepseek-v4-pro"]) {
    const rate = CHAT_PRICE_PER_MTOKEN[id];
    const reserved = estimateChatCost(1024, undefined, id, undefined, 100_000);
    assert.equal(reserved, reserve(rate, 100_000 / GATEWAY_CHARS_PER_TOKEN, 1024), id);
    // ...and that is strictly above the list-only reserve it replaced.
    assert.ok(reserved > withTxFee(micro((50_000 / 1e6) * rate.input) + micro((1024 / 1e6) * rate.output)), id);
  }
  // Routing tiers too: the fee is on whichever member settles.
  for (const mode of Object.keys(MODEL_TIERS).filter((m) => m !== "free") as Array<keyof typeof MODEL_TIERS>) {
    assert.equal(
      estimateChatCost(1024, mode, undefined, undefined, 100_000),
      reserve(tierWorstPriceAt(mode, 50_000), 50_000, 1024),
      mode,
    );
  }
});

test("the fee applies BEFORE the $0.001 floor, as the gateway's PF-3 orders it", () => {
  // gpt-6-luna ($0.10/$0.50): 8,620 input tokens + the 256-token output floor
  // is $0.00099 at list — under the floor — and $0.0010395 with the fee, over
  // it. Fee-then-floor gives the latter; floor-then-fee would give $0.00105;
  // no fee at all gives the floor.
  const luna = CHAT_PRICE_PER_MTOKEN["openai/gpt-6-luna"];
  assert.deepEqual(luna, { input: 0.1, output: 0.5 });
  const reserved = estimateChatCost(1, undefined, "openai/gpt-6-luna", undefined, 8_620 * GATEWAY_CHARS_PER_TOKEN);
  assert.equal(reserved, withTxFee(0.00099 * CHAT_PLATFORM_FEE_FACTOR));
  assert.notEqual(reserved, withTxFee(0.001 * CHAT_PLATFORM_FEE_FACTOR));
  assert.notEqual(reserved, withTxFee(0.001));
  // A call that stays under the floor even with the fee reserves the floor.
  assert.equal(estimateChatCost(1, undefined, "openai/gpt-6-luna", undefined, 2), withTxFee(0.001));
});

test("free calls stay at $0 — the fee never turns a free model into a paid reserve", () => {
  assert.equal(estimateChatCost(1024, "free", undefined, undefined, 100_000), 0);
  for (const id of FREE_CHAT_MODELS) assert.equal(estimateChatCost(1024, undefined, id, undefined, 100_000), 0, id);
});

test("the account rail's ledgers stay at list: api.blockrun.ai publishes platform_fee_percent 0", () => {
  // OpenAI-compat path, reported usage.
  const opus = CHAT_PRICE_PER_MTOKEN["anthropic/claude-opus-5"];
  const booked = accountLedgerUsd("anthropic/claude-opus-5", null, 0, 1024, { promptTokens: 48_016, completionTokens: 1024 });
  assert.equal(booked, Math.ceil(((48_016 / 1e6) * opus.input + (1024 / 1e6) * opus.output) * 1e6 - 1e-6) / 1e6);
  // Native path, reported usage.
  const native = anthropicAccountLedgerUsd("claude-opus-5", 0, 1024, { input_tokens: 48_016, output_tokens: 1024 });
  assert.equal(native, booked);
});

// ── GPT-6.2 cache-write premium ──

test("the GPT-6.2 pair reserves input at the cache-write rate the gateway quotes", () => {
  const astra = CHAT_PRICE_PER_MTOKEN["openai/gpt-6.2-astra"];
  const sol = CHAT_PRICE_PER_MTOKEN["openai/gpt-6.2-sol"];
  // The rows stay at the published list rate: the catalogue sweep compares them
  // to `pricing.input`, and the account rail's ledger reads them.
  assert.deepEqual(astra, { input: 8, output: 40 });
  assert.deepEqual(sol, { input: 2, output: 10 });
  assert.deepEqual(chatRateAt("openai/gpt-6.2-astra", astra, 1_000), astra);
  // The quote rate is the write rate: $10 / $2.50 (GET /v1/models `cache_write`).
  assert.deepEqual(chatQuoteRateAt("openai/gpt-6.2-astra", astra, 1_000), { input: 10, output: 40 });
  assert.deepEqual(chatQuoteRateAt("openai/gpt-6.2-sol", sol, 1_000), { input: 2.5, output: 10 });
  // Past 272K the write rate scales with the step's input rate, as the
  // gateway's cacheRatesAt does: Base publishes long_context cache_write $20 / $5.
  assert.deepEqual(chatQuoteRateAt("openai/gpt-6.2-astra", astra, 272_001), { input: 20, output: 60 });
  assert.deepEqual(chatQuoteRateAt("openai/gpt-6.2-sol", sol, 272_001), { input: 5, output: 15 });
  // And the reserve uses it: 50k tokens at $10, 1024 at $40, with the fee.
  assert.equal(estimateChatCost(1024, undefined, "openai/gpt-6.2-astra", undefined, 100_000), reserve({ input: 10, output: 40 }, 50_000, 1024));
  assert.equal(estimateChatCost(1024, undefined, "gpt-6.2-astra", undefined, 100_000), estimateChatCost(1024, undefined, "openai/gpt-6.2-astra", undefined, 100_000));
});

test("only the write-quoted models are raised; a sibling with a cache_write column is not", () => {
  // gpt-6-astra publishes cache_write $12.50 too, but the gateway does not
  // quote it (CACHE_WRITE_QUOTED_MODELS is the GPT-6.2 pair only).
  const astra6 = CHAT_PRICE_PER_MTOKEN["openai/gpt-6-astra"];
  assert.deepEqual(chatQuoteRateAt("openai/gpt-6-astra", astra6, 1_000), astra6);
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.deepEqual(chatQuoteRateAt(key, { input: 5, output: 30 }, 1_000), { input: 5, output: 30 }, key);
  }
});

test("every write-quoted model has a price row and a write rate above its input rate", () => {
  // Without a row chatQuoteRateAt cannot scale the write rate and silently
  // returns the list rate — the premium would vanish with no signal.
  for (const [id, write] of Object.entries(CACHE_WRITE_QUOTED_PRICE_PER_MTOKEN)) {
    assert.ok(Object.hasOwn(CHAT_PRICE_PER_MTOKEN, id), `${id} needs a CHAT_PRICE_PER_MTOKEN row`);
    assert.ok(write > CHAT_PRICE_PER_MTOKEN[id].input, `${id}: write $${write} must be above input`);
  }
});

// ── grok-4.7 reasoning allowance ──

test("grok-4.7 reserves the 2,000 reasoning tokens the gateway quotes past max_tokens", () => {
  assert.equal(REASONING_OUTPUT_ALLOWANCE_TOKENS["xai/grok-4.7"], 2000);
  const grok = CHAT_PRICE_PER_MTOKEN["xai/grok-4.7"];
  const reserved = estimateChatCost(1024, undefined, "xai/grok-4.7", undefined, 100_000);
  assert.equal(reserved, reserve(grok, 50_000, 1024 + 2000));
  assert.equal(estimateChatCost(1024, undefined, "grok-4.7", undefined, 100_000), reserved, "bare spelling");
  // Live Base quote for this call, 2026-11-23: $0.120885.
  assert.ok(reserved >= 0.120885, `reserved ${reserved}`);
  // Siblings carry no allowance, and a prototype key resolves to none.
  assert.equal(reasoningAllowanceTokens("xai/grok-4.6"), 0);
  assert.equal(reasoningAllowanceTokens("constructor"), 0);
  assert.equal(
    estimateChatCost(1024, undefined, "xai/grok-4.6", undefined, 100_000),
    reserve(CHAT_PRICE_PER_MTOKEN["xai/grok-4.6"], 50_000, 1024),
  );
});
