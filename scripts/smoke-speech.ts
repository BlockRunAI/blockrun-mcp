// One-off smoke test for blockrun_speech. Run: npx tsx scripts/smoke-speech.ts
// Exercises: voices (fallback path), over-length free-fail, real $0.001 speak.
import { registerSpeechTool } from "../src/tools/speech.js";
import type { BudgetState } from "../src/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
let handler: Handler;
const fakeServer = {
  registerTool: (_name: string, _cfg: unknown, h: Handler) => { handler = h; },
} as never;

const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
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
