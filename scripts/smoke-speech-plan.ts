/**
 * What scripts/smoke-speech.ts is about to charge, computed from the same
 * estimator the tool reserves with — never typed by hand.
 *
 * The header used to say "$0.001 speak" and "$0.054 total". The 51-character
 * speak on flash-v2.5 reserves (51/1000) x $0.05 x 1.05 = $0.0026775 plus the
 * tx fee, ceiled: $0.004678 — and the run is $0.059179, not $0.054. The 0.50.0
 * changelog claimed the script "states the real total" while the figures it
 * asked the operator to authorise were the old ones. A confirm gate that
 * quotes the wrong price is the thing the gate exists to prevent.
 *
 * Kept out of smoke-speech.ts so a test can import it: importing the script
 * itself runs the paid calls.
 */
import { speechCost } from "../src/tools/speech.js";
import { withTxFee } from "../src/utils/tx-fee.js";

export const SPEAK_MODEL = "elevenlabs/flash-v2.5";
export const SPEAK_INPUT = "Hello from BlockRun. Pay per call, no subscription.";
export const SOUND_EFFECT_INPUT = "soft rain on a tin roof with distant thunder";

/**
 * Mirrors SOUND_EFFECT_COST in src/tools/speech.ts, which is not exported:
 * $0.05 base x 1.05 margin, plus the tx fee, ceiled to the micro — the
 * live-verified 54501 micro. If speech.ts ever exports its constant, import
 * it here instead of restating the formula.
 */
export const SOUND_EFFECT_USD = withTxFee(0.05 * 1.05);

export function smokeSpeechPlan(): { speakUsd: number; soundEffectUsd: number; totalUsd: number } {
  const speakUsd = speechCost(SPEAK_MODEL, SPEAK_INPUT);
  const soundEffectUsd = SOUND_EFFECT_USD;
  return { speakUsd, soundEffectUsd, totalUsd: Math.round((speakUsd + soundEffectUsd) * 1e6) / 1e6 };
}

export const usd = (n: number) => `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;
