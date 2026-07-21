// Run with: npm test  (tsx --test)
//
// The free NVIDIA path silently truncates the prompt at 131,072 CHARACTERS: HTTP 200, a
// confident well-formed answer, no error and no finish_reason signal. Measured
// 2026-07-21 — usage.prompt_tokens flatlines above ~131,072 characters on both
// ASCII and CJK (a 393,000-byte CJK prompt passes whole), while paid models
// scale linearly right past it. 0.32.2 measured this in BYTES and was wrong;
// see FREE_TIER_MAX_PROMPT_CHARS for the measurements.
//
// Silent truncation is the worst failure shape available: it is indistinguishable
// from success, so an agent summarising a large document over mode:"free" would
// present an answer about the first 131,072 characters as the whole thing.
// These tests pin the warning that makes it visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptCharSize, freeTierTruncationNote } from "../src/tools/chat.js";
import { FREE_TIER_MAX_PROMPT_CHARS, MODEL_TIERS } from "../src/utils/constants.js";

const OVER = FREE_TIER_MAX_PROMPT_CHARS + 50_000;
const UNDER = FREE_TIER_MAX_PROMPT_CHARS - 1;

test("the cap matches what was measured against the live gateway (131,072 chars)", () => {
  assert.equal(FREE_TIER_MAX_PROMPT_CHARS, 131_072);
});

test("an oversized prompt on a free model warns, and says how much was lost", () => {
  const note = freeTierTruncationNote(OVER, MODEL_TIERS.free[0]);
  assert.ok(note, "a free model over the cap must warn");
  assert.match(note!, /TRUNCATED/);
  assert.match(note!, /181,072 characters/); // the actual prompt size, so the caller can act
  assert.match(note!, /131,072/); // the cap
  assert.match(note!, /2[0-9]%/); // ~28% discarded
});

test("every model in the free tier is covered by the warning", () => {
  for (const m of MODEL_TIERS.free) {
    assert.ok(freeTierTruncationNote(OVER, m), `${m} must be covered`);
  }
});

test("a prompt at or under the cap says nothing", () => {
  assert.equal(freeTierTruncationNote(UNDER, MODEL_TIERS.free[0]), null);
  assert.equal(freeTierTruncationNote(FREE_TIER_MAX_PROMPT_CHARS, MODEL_TIERS.free[0]), null);
});

// Paid models scale linearly past the cap — the 402 quote for gpt-5.6-terra read
// ~12,016 input tokens at 25 KB and ~192,016 at 400 KB, with no ceiling. Warning
// on those would be a lie that pushes callers off models that work fine.
test("paid models are never warned about — they do not truncate", () => {
  for (const m of ["openai/gpt-5.6-terra", "anthropic/claude-opus-4.8", "deepseek/deepseek-v4-pro"]) {
    assert.equal(freeTierTruncationNote(OVER, m), null, `${m} must not be warned about`);
  }
});

test("promptCharSize counts message, system and history together", () => {
  assert.equal(promptCharSize("abc"), 3);
  assert.equal(promptCharSize("abc", "de"), 5);
  assert.equal(promptCharSize("abc", "de", [{ content: "fgh" }]), 8);
});

// THE REGRESSION THIS FILE EXISTS FOR. 0.32.2 measured bytes and asserted the
// opposite of this test: that a 50,000-character CJK prompt "must warn". Live
// probing proved the gateway passes it through whole (131,000 CJK chars =
// 393,000 bytes -> prompt_tokens 131,065, intact). Because UTF-8 length is
// always >= string length, a byte check can ONLY over-fire — it bolts a
// "TRUNCATED" warning onto a correct answer and pushes the caller onto a paid
// model. Non-ASCII users are the ones who would have hit it.
test("a large CJK prompt under the character cap does NOT warn (bytes would have)", () => {
  const cjk = "中".repeat(50_000); // 150,000 UTF-8 bytes, 50,000 characters
  assert.ok(Buffer.byteLength(cjk, "utf8") > FREE_TIER_MAX_PROMPT_CHARS, "would trip a byte check");
  assert.ok(promptCharSize(cjk) < FREE_TIER_MAX_PROMPT_CHARS, "is under the real character cap");
  assert.equal(
    freeTierTruncationNote(promptCharSize(cjk), MODEL_TIERS.free[0]),
    null,
    "the gateway processes this whole — warning about it is a lie that costs the caller money",
  );
});

test("CJK over the character cap still warns", () => {
  const cjk = "中".repeat(140_000);
  assert.ok(freeTierTruncationNote(promptCharSize(cjk), MODEL_TIERS.free[0]));
});

test("promptCharSize counts characters, not bytes", () => {
  assert.equal(promptCharSize("中文"), 2);   // 6 bytes
  assert.equal(promptCharSize("abc"), 3);
});

test("multimodal history parts are counted, not skipped", () => {
  const withParts = promptCharSize("hi", undefined, [
    { content: [{ type: "text", text: "x".repeat(100) }] },
  ]);
  assert.ok(withParts > 100, `array content must contribute (got ${withParts})`);
});
