// One-off smoke test for blockrun_talent. Run:
//   BLOCKRUN_MARKET_URL=<market> BLOCKRUN_WALLET_KEY=0x<funded> npx tsx scripts/smoke-talent.ts
// Exercises: list (free discovery), list+query (filter), run (paid hire via x402).
import { registerTalentTool } from "../src/tools/talent.js";
import type { BudgetState } from "../src/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
let handler: Handler;
const fakeServer = {
  registerTool: (_name: string, _cfg: unknown, h: Handler) => { handler = h; },
} as never;

const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
registerTalentTool(fakeServer, budget);

async function run(label: string, args: Record<string, unknown>) {
  console.log(`\n=== ${label} ===`);
  const res = await handler!(args);
  console.log(`isError: ${res.isError ?? false}`);
  console.log(res.content[0].text.slice(0, 600));
}

await run("list (free)", { action: "list" });
await run("list query", { action: "list", query: "e2e" });
await run("missing slug (free, errors)", { action: "run", input: "x" });
await run("run (paid x402)", { action: "run", slug: "franklin-e2e", input: "ping from mcp" });
console.log(`\nBudget spent: $${budget.spent.toFixed(4)} across ${budget.calls} call(s)`);
