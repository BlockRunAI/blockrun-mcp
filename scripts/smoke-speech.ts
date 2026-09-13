/**
 * One-off smoke test for blockrun_speech. SPENDS REAL USDC — about $0.054 per
 * run, from the machine-global wallet at ~/.blockrun/.session.
 *
 * Run: npx tsx scripts/smoke-speech.ts --confirm
 *
 * The flag is not ceremony. The header used to say "real $0.001 speak" while
 * the run ends with a $0.0525 sound effect, fifty times that, and a bare
 * `npx tsx scripts/smoke-speech.ts` charged for both immediately. This repo
 * has already lost $0.42 to a subagent that ran a paid handler because it
 * looked like a read. Nothing in scripts/ should spend money by being run.
 *
 * The budget limit below is a second backstop: if a price moves or a retry
 * doubles a call, the run stops instead of draining the wallet.
 *
 * Exercises: voices (fallback path), over-length free-fail, speak ($0.001),
 * sound_effect ($0.0525).
 */
import { registerSpeechTool } from "../src/tools/speech.js";
import type { BudgetState } from "../src/types.js";

const SPEND_CAP_USD = 0.15;

if (!process.argv.includes("--confirm") && process.env.BLOCKRUN_SMOKE_CONFIRM !== "1") {
  console.error(
    "smoke-speech spends about $0.054 of real USDC (speak $0.001 + sound_effect $0.0525).\n" +
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
await run("real speak ($0.001)", { action: "speak", input: "Hello from BlockRun. Pay per call, no subscription.", voice: "sarah", model: "elevenlabs/flash-v2.5", response_format: "mp3" });
console.log(`\nBudget spent: $${budget.spent.toFixed(4)} across ${budget.calls} calls`);
await run("real sound_effect ($0.0525)", { action: "sound_effect", input: "soft rain on a tin roof with distant thunder", duration_seconds: 4, response_format: "mp3" });
console.log(`\nFinal budget: $${budget.spent.toFixed(4)} across ${budget.calls} calls`);
