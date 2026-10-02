// Long-context price steps in the chat cost estimator.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateChatCost, accountLedgerUsd } from "../src/tools/chat.js";
import {
  CHAT_PRICE_PER_MTOKEN,
  DEFAULT_CHAT_PRICE,
  GATEWAY_CHARS_PER_TOKEN,
  LONG_CONTEXT_PRICE_PER_MTOKEN,
  MODEL_TIERS,
  TIER_WORST_PRICE,
  chatRateAt,
  longContextStep,
  tierWorstPriceAt,
} from "../src/utils/constants.js";
import { withTxFee } from "../src/utils/tx-fee.js";

const MAX_TOKENS = 1024;

/** promptChars that the estimator counts as exactly `tokens` input tokens. */
const charsFor = (tokens: number) => tokens * GATEWAY_CHARS_PER_TOKEN;

/** The reserve estimateChatCost should produce at a given rate. */
function reserveAt(rate: { input: number; output: number }, tokens: number): number {
  const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;
  return withTxFee(
    Math.max(micro((tokens / 1e6) * rate.input) + micro((MAX_TOKENS / 1e6) * rate.output), 0.001),
  );
}

test("exclusive threshold: exactly 272K tokens on GPT-6 stays at the base rate", () => {
  const base = CHAT_PRICE_PER_MTOKEN["openai/gpt-6-astra"];
  const at = estimateChatCost(MAX_TOKENS, undefined, "openai/gpt-6-astra", undefined, charsFor(272_000));
  assert.equal(at, reserveAt(base, 272_000));
});

test("exclusive threshold: one token past 272K reprices the WHOLE request at 2x in / 1.5x out", () => {
  const base = CHAT_PRICE_PER_MTOKEN["openai/gpt-6-astra"];
  const past = estimateChatCost(MAX_TOKENS, undefined, "openai/gpt-6-astra", undefined, charsFor(272_001));
  assert.equal(past, reserveAt({ input: base.input * 2, output: base.output * 1.5 }, 272_001));
  assert.ok(past > estimateChatCost(MAX_TOKENS, undefined, "openai/gpt-6-astra", undefined, charsFor(272_000)) * 1.9);
});

test("inclusive threshold: Grok is in the 2x step at exactly 200K, not at 199,999", () => {
  const base = CHAT_PRICE_PER_MTOKEN["xai/grok-4.7"];
  const below = estimateChatCost(MAX_TOKENS, undefined, "xai/grok-4.7", undefined, charsFor(199_999));
  const at = estimateChatCost(MAX_TOKENS, undefined, "xai/grok-4.7", undefined, charsFor(200_000));
  assert.equal(below, reserveAt(base, 199_999));
  assert.equal(at, reserveAt({ input: base.input * 2, output: base.output * 2 }, 200_000));
});

test("Gemini Pro steps above 200K (exclusive) at 2x in / 1.5x out", () => {
  const base = CHAT_PRICE_PER_MTOKEN["google/gemini-3.1-pro"];
  assert.equal(
    estimateChatCost(MAX_TOKENS, undefined, "google/gemini-3.1-pro", undefined, charsFor(200_000)),
    reserveAt(base, 200_000),
  );
  assert.equal(
    estimateChatCost(MAX_TOKENS, undefined, "google/gemini-3.1-pro", undefined, charsFor(200_001)),
    reserveAt({ input: base.input * 2, output: base.output * 1.5 }, 200_001),
  );
});

test("the steps match the live multipliers for every tiered row that has a base row", () => {
  for (const [id, steps] of Object.entries(LONG_CONTEXT_PRICE_PER_MTOKEN)) {
    if (!Object.hasOwn(CHAT_PRICE_PER_MTOKEN, id) || id.startsWith("qwen/")) continue;
    const base = CHAT_PRICE_PER_MTOKEN[id];
    const [step] = steps;
    const [inMul, outMul] = id.startsWith("xai/") ? [2, 2] : [2, 1.5];
    assert.ok(Math.abs(step.input - base.input * inMul) < 1e-9, `${id} input step ${step.input}`);
    assert.ok(Math.abs(step.output - base.output * outMul) < 1e-9, `${id} output step ${step.output}`);
    assert.equal(step.inclusive, id.startsWith("xai/"), `${id} inclusive flag`);
  }
});

test("a multi-step ladder prices at the highest step reached (qwen3.7-flash: 32K, 256K)", () => {
  assert.equal(longContextStep("qwen/qwen3.7-flash", 31_999), null);
  assert.equal(longContextStep("qwen/qwen3.7-flash", 32_000)?.input, 0.1);
  assert.equal(longContextStep("qwen/qwen3.7-flash", 255_999)?.input, 0.1);
  assert.equal(longContextStep("qwen/qwen3.7-flash", 256_000)?.input, 0.2);
});

test("a step never lowers the reserve below the base it would otherwise use", () => {
  // gpt-5.4 has no CHAT_PRICE_PER_MTOKEN row, so it reserves the $5/$30 default;
  // its published >272K output rate ($22.50) is below that and must not win.
  const rate = chatRateAt("openai/gpt-5.4", DEFAULT_CHAT_PRICE, 300_000);
  assert.deepEqual(rate, { input: DEFAULT_CHAT_PRICE.input, output: DEFAULT_CHAT_PRICE.output });
  assert.ok(
    estimateChatCost(MAX_TOKENS, undefined, "gpt-5.4", undefined, charsFor(300_000)) >=
      estimateChatCost(MAX_TOKENS, undefined, "someone/unknown", undefined, charsFor(300_000)),
  );
});

test("bare ids pick up the step too", () => {
  assert.equal(
    estimateChatCost(MAX_TOKENS, undefined, "gpt-6-astra", undefined, charsFor(300_000)),
    estimateChatCost(MAX_TOKENS, undefined, "openai/gpt-6-astra", undefined, charsFor(300_000)),
  );
});

test("routing modes reserve the worst member's long-context step for a huge prompt", () => {
  for (const mode of Object.keys(MODEL_TIERS) as (keyof typeof MODEL_TIERS)[]) {
    assert.deepEqual(tierWorstPriceAt(mode, 1_000), TIER_WORST_PRICE[mode], `${mode} below every threshold`);
  }
  // balanced holds gpt-5.5 ($5/$30 -> $10/$45 past 272K).
  const huge = tierWorstPriceAt("balanced", 300_000);
  assert.deepEqual(huge, { input: 10, output: 45 });
  assert.ok(
    estimateChatCost(MAX_TOKENS, "balanced", undefined, undefined, charsFor(300_000)) >
      reserveAt(TIER_WORST_PRICE.balanced, 300_000),
  );
  assert.equal(estimateChatCost(MAX_TOKENS, "free", undefined, undefined, charsFor(300_000)), 0);
});

test("models without steps are unchanged at any prompt size", () => {
  const base = CHAT_PRICE_PER_MTOKEN["anthropic/claude-opus-5"];
  assert.equal(
    estimateChatCost(MAX_TOKENS, undefined, "anthropic/claude-opus-5", undefined, charsFor(900_000)),
    reserveAt(base, 900_000),
  );
});

test("prototype keys do not resolve to a step", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(longContextStep(key, 10_000_000), null, key);
  }
});

test("account-rail ledger books the step from the reported prompt tokens", () => {
  const usage = (promptTokens: number) => ({ promptTokens, completionTokens: 1_000 });
  const base = CHAT_PRICE_PER_MTOKEN["openai/gpt-5.5"];
  const below = accountLedgerUsd("openai/gpt-5.5", null, 0, 1_000, usage(272_000));
  const above = accountLedgerUsd("openai/gpt-5.5", null, 0, 1_000, usage(272_001));
  const usd = (r: { input: number; output: number }, t: number) =>
    Math.ceil(((t / 1e6) * r.input + (1_000 / 1e6) * r.output) * 1e6 - 1e-6) / 1e6;
  assert.equal(below, usd(base, 272_000));
  assert.equal(above, usd({ input: 10, output: 45 }, 272_001));
});
