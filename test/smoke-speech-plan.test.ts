// Run with: npm test  (tsx --test)
//
// scripts/smoke-speech.ts asks the operator to authorise a charge, and the
// figure it quoted was typed by hand: "$0.001 speak", "$0.054 total". The
// estimator the tool actually reserves with says $0.004678 and $0.059179.
// The gate message is now computed from that estimator via smoke-speech-plan.ts;
// this pins the plan to the estimator and keeps hand-typed dollar figures out
// of the script.
//
// smoke-speech.ts itself is never imported here: importing it runs the paid
// calls. The plan module is pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOUND_EFFECT_USD, SPEAK_INPUT, SPEAK_MODEL, smokeSpeechPlan, usd } from "../scripts/smoke-speech-plan.js";
import { speechCost } from "../src/tools/speech.js";

test("the speak figure is what speechCost reserves for the exact input the script sends", () => {
  const plan = smokeSpeechPlan();
  assert.equal(plan.speakUsd, speechCost(SPEAK_MODEL, SPEAK_INPUT));
  // 51 chars @ $0.05/1k x 1.05 = $0.0026775 base, + $0.002 fee, ceiled.
  assert.equal(SPEAK_INPUT.length, 51);
  assert.equal(plan.speakUsd, 0.004678);
});

test("the sound-effect figure is the live-verified 54501 micro, not the $0.0525 base", () => {
  // speech-cost.test.ts pins the same number through the tool's own path.
  assert.equal(SOUND_EFFECT_USD, 0.054501);
  assert.equal(smokeSpeechPlan().soundEffectUsd, 0.054501);
});

test("the total is the sum, to the micro", () => {
  const plan = smokeSpeechPlan();
  assert.equal(plan.totalUsd, 0.059179);
  assert.equal(plan.totalUsd, Math.round((plan.speakUsd + plan.soundEffectUsd) * 1e6) / 1e6);
});

test("usd() prints a readable figure without trailing zeros", () => {
  assert.equal(usd(0.004678), "$0.004678");
  assert.equal(usd(0.05), "$0.05");
  assert.equal(usd(0.1), "$0.1");
});

test("smoke-speech.ts carries no hand-typed dollar figure and sends the inputs the plan priced", () => {
  const source = readFileSync(new URL("../scripts/smoke-speech.ts", import.meta.url), "utf8");
  // The one dollar figure allowed is the spend cap; everything shown to the
  // operator must come from the plan. A literal like "$0.001" in the gate
  // message or a run label is the bug this test exists for.
  // Comments may recount the old wrong figures; code may not carry any.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const literals = [...code.matchAll(/\$0\.\d+/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], `hand-typed dollar figures in smoke-speech.ts: ${literals.join(", ")} — print smokeSpeechPlan() instead`);
  assert.match(source, /smokeSpeechPlan\(\)/, "the gate message must be computed from the estimator");
  assert.match(source, /input: SPEAK_INPUT/, "the speak call must send the input the plan priced");
  assert.match(source, /input: SOUND_EFFECT_INPUT/);
  assert.match(source, /model: SPEAK_MODEL/);
});
