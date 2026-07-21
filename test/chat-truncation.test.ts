// Run with: npm test  (tsx --test)
//
// The free NVIDIA path silently truncates the prompt at 128 KiB: HTTP 200, a
// confident well-formed answer, no error and no finish_reason signal. Measured
// 2026-07-21 — usage.prompt_tokens flatlines at 26,266 for every body from
// 135,000 B upward, identically on gpt-oss-120b and deepseek-v4-flash, while
// paid models scale linearly right past it.
//
// Silent truncation is the worst failure shape available: it is indistinguishable
// from success, so an agent summarising a large document over mode:"free" would
// present an answer about the first 128 KiB as an answer about the whole thing.
// These tests pin the warning that makes it visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptByteSize, freeTierTruncationNote } from "../src/tools/chat.js";
import { FREE_TIER_MAX_PROMPT_BYTES, MODEL_TIERS } from "../src/utils/constants.js";

const OVER = FREE_TIER_MAX_PROMPT_BYTES + 50_000;
const UNDER = FREE_TIER_MAX_PROMPT_BYTES - 1;

test("the cap matches what was measured against the live gateway (128 KiB)", () => {
  assert.equal(FREE_TIER_MAX_PROMPT_BYTES, 131_072);
});

test("an oversized prompt on a free model warns, and says how much was lost", () => {
  const note = freeTierTruncationNote(OVER, MODEL_TIERS.free[0]);
  assert.ok(note, "a free model over the cap must warn");
  assert.match(note!, /TRUNCATED/);
  assert.match(note!, /177 KiB/); // the actual prompt size, so the caller can act
  assert.match(note!, /128 KiB/); // the cap
  assert.match(note!, /2[0-9]%/); // ~28% discarded
});

test("every model in the free tier is covered by the warning", () => {
  for (const m of MODEL_TIERS.free) {
    assert.ok(freeTierTruncationNote(OVER, m), `${m} must be covered`);
  }
});

test("a prompt at or under the cap says nothing", () => {
  assert.equal(freeTierTruncationNote(UNDER, MODEL_TIERS.free[0]), null);
  assert.equal(freeTierTruncationNote(FREE_TIER_MAX_PROMPT_BYTES, MODEL_TIERS.free[0]), null);
});

// Paid models scale linearly past the cap — the 402 quote for gpt-5.6-terra read
// ~12,016 input tokens at 25 KB and ~192,016 at 400 KB, with no ceiling. Warning
// on those would be a lie that pushes callers off models that work fine.
test("paid models are never warned about — they do not truncate", () => {
  for (const m of ["openai/gpt-5.6-terra", "anthropic/claude-opus-4.8", "deepseek/deepseek-v4-pro"]) {
    assert.equal(freeTierTruncationNote(OVER, m), null, `${m} must not be warned about`);
  }
});

test("promptByteSize counts message, system and history together", () => {
  assert.equal(promptByteSize("abc"), 3);
  assert.equal(promptByteSize("abc", "de"), 5);
  assert.equal(promptByteSize("abc", "de", [{ content: "fgh" }]), 8);
});

// A 128 KiB budget is ~43,000 CJK characters, so counting characters instead of
// bytes would silently under-report by 3x and let a truncated CJK prompt through
// unwarned — the exact case this guard exists for.
test("promptByteSize measures BYTES, not characters (CJK is 3 bytes each)", () => {
  assert.equal(promptByteSize("中文"), 6);
  const cjk = "中".repeat(50_000); // 150,000 bytes, only 50,000 characters
  assert.ok(cjk.length < FREE_TIER_MAX_PROMPT_BYTES, "under the cap by character count");
  assert.ok(promptByteSize(cjk) > FREE_TIER_MAX_PROMPT_BYTES, "over the cap by byte count");
  assert.ok(freeTierTruncationNote(promptByteSize(cjk), MODEL_TIERS.free[0]), "must warn");
});

test("multimodal history parts are counted, not skipped", () => {
  const withParts = promptByteSize("hi", undefined, [
    { content: [{ type: "text", text: "x".repeat(100) }] },
  ]);
  assert.ok(withParts > 100, `array content must contribute (got ${withParts})`);
});
