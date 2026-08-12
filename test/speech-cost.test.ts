// Run with: npm test  (tsx --test)
// Pins speechCost() — in particular the two deliberate asymmetries the
// bytedance/seed-audio-1.0 path (added 0.40.0) has against the ElevenLabs
// formula: no 5% margin on top (the $0.003/sec rate is final retail), and
// CJK-aware duration estimation (CJK characters speak ~2.1x slower than
// Latin per character, so they quote ~2.1x the price). All values mirror
// estimateSpeechSeconds()/calculateSpeechPrice() in the gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { speechCost } from "../src/tools/speech.js";

test("elevenlabs pricing is chars/1000 x rate x 1.05 margin, plus the tx fee", () => {
  // 1000 chars @ flash: 0.05 x 1.05 = $0.0525 base -> $0.054501 charged
  // (ceil, one micro above the naive sum — see the SOUND_EFFECT_COST note).
  assert.equal(speechCost("elevenlabs/flash-v2.5", "x".repeat(1000)), 0.054501);
});

test("seed-audio bills per estimated output second with NO margin", () => {
  // 1000 Latin chars -> 105s (under the 120s cap) x $0.003 = $0.315 base.
  // With the 5% margin wrongly applied this would be $0.33275 — the exact
  // regression this test exists to catch.
  assert.equal(speechCost("bytedance/seed-audio-1.0", "x".repeat(1000)), 0.317);
});

test("seed-audio caps the estimate at 120s of output", () => {
  // 2000 CJK chars -> 450s uncapped; the gateway can only be billed for 120s,
  // so the quote must not exceed 120 x $0.003 either.
  assert.equal(speechCost("bytedance/seed-audio-1.0", "你".repeat(2000)), 0.362);
});

test("seed-audio weighs CJK characters ~2.1x heavier than Latin", () => {
  // "hi" (2 Latin) + 2 CJK: 2x0.105 + 2x0.225 = 0.66s -> $0.00198 base.
  assert.equal(speechCost("bytedance/seed-audio-1.0", "hi你好"), 0.00398);
  // Same length, all Latin, must be cheaper.
  assert.ok(
    speechCost("bytedance/seed-audio-1.0", "hiyo") < speechCost("bytedance/seed-audio-1.0", "hi你好"),
  );
});

test("seed-audio keeps the $0.001 minimum floor", () => {
  // 2 chars -> 0.21s x $0.003 = $0.00063, under the floor -> $0.001 + fee.
  assert.equal(speechCost("bytedance/seed-audio-1.0", "OK"), 0.003);
});
