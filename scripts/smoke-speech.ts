/**
 * One-off smoke test for blockrun_speech. SPENDS REAL USDC — about six cents
 * per run (the exact figure is printed by the gate, computed from the
 * estimator), from the machine-global wallet at ~/.blockrun/.session.
 *
 * Run: npx tsx scripts/smoke-speech.ts --confirm
 *
 * The flag is not ceremony. The header used to say "real $0.001 speak" while
 * the run ends with a sound effect fifty times that, and a bare
 * `npx tsx scripts/smoke-speech.ts` charged for both immediately. This repo
 * has already lost $0.42 to a subagent that ran a paid handler because it
 * looked like a read. Nothing in scripts/ should spend money by being run.
 *
 * The figures are NOT typed here. The gate once quoted "$0.001 speak, $0.054
 * total" for a run the estimator reserves $0.004678 + $0.054501 = $0.059179
 * for — a confirm gate that understates the charge is the defect it exists
 * to prevent. ./smoke-speech-plan.ts computes them from speechCost() and
 * test/smoke-speech-plan.test.ts pins them; this file may not contain a
 * dollar literal other than the cap.
 *
 * The budget limit below is a second backstop: if a price moves or a retry
 * doubles a call, the run stops instead of draining the wallet.
 *
 * Exercises: voices (fallback path), over-length free-fail, speak,
 * sound_effect.
 */
import { registerSpeechTool } from "../src/tools/speech.js";
import type { BudgetState } from "../src/types.js";
import { SOUND_EFFECT_INPUT, SPEAK_INPUT, SPEAK_MODEL, smokeSpeechPlan, usd } from "./smoke-speech-plan.js";

const SPEND_CAP_USD = 0.15;
const plan = smokeSpeechPlan();

if (!process.argv.includes("--confirm") && process.env.BLOCKRUN_SMOKE_CONFIRM !== "1") {
  console.error(
    `smoke-speech spends about ${usd(plan.totalUsd)} of real USDC (speak ${usd(plan.speakUsd)} + sound_effect ${usd(plan.soundEffectUsd)}).\n` +
      "Re-run with --confirm, or set BLOCKRUN_SMOKE_CONFIRM=1, to authorise the charge.",
  );
  process.exit(1);
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
let handler: Handler;
const fakeServer = {
  registerTool: (_name: string, _cfg: unknown, h: Handler) => { handler = h; },
} as never;

const budget: BudgetState = { limit: SPEND_CAP_USD, spent: 0, calls: 0, agents: new Map() };
registerSpeechTool(fakeServer, budget);

async function run(label: string, args: Record<string, unknown>) {
  console.log(`\n=== ${label} ===`);
  const res = await handler!(args);
  console.log(`isError: ${res.isError ?? false}`);
  console.log(res.content[0].text.slice(0, 600));
}

await run("voices", { action: "voices" });
await run("over-length free-fail", { action: "speak", input: "x".repeat(6000), model: "elevenlabs/v3" });
// Pass defaults explicitly — the stub bypasses the MCP SDK's zod parsing.
await run(`real speak (${usd(plan.speakUsd)})`, { action: "speak", input: SPEAK_INPUT, voice: "sarah", model: SPEAK_MODEL, response_format: "mp3" });
console.log(`\nBudget spent: $${budget.spent.toFixed(4)} across ${budget.calls} calls`);
await run(`real sound_effect (${usd(plan.soundEffectUsd)})`, { action: "sound_effect", input: SOUND_EFFECT_INPUT, duration_seconds: 4, response_format: "mp3" });
console.log(`\nFinal budget: $${budget.spent.toFixed(4)} across ${budget.calls} calls`);
