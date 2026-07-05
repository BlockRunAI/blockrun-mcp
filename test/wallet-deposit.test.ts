// Run with: npm test  (tsx --experimental-test-module-mocks --test)
// Verifies blockrun_wallet action:"deposit" opens the buy.blockrun.ai top-up
// page and returns the link, with `open` mocked so no browser actually opens.
// node --test isolates each file in its own process, so these mocks don't leak.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let openCalls: string[] = [];
mock.module("open", { defaultExport: async (url: string) => { openCalls.push(url); return {}; } });
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getWalletInfo: async () => ({ address: "0xTESTADDRESS" }),
    getChain: () => "base",
    getUsdcBalance: async () => 0,
    setChain: () => {},
    ensureBothWallets: async () => ({ base: { address: "0xTESTADDRESS" }, solana: { address: "SOL" } }),
    getChainBalance: async () => 0,
  },
});

const { registerWalletTool } = await import("../src/tools/wallet.js");

function makeHarness() {
  let handler: ((a: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: any) => { handler = h; } } as any;
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  registerWalletTool(server, budget);
  return (a: Record<string, unknown>) => handler!(a);
}

test("deposit opens buy.blockrun.ai and returns the link", async () => {
  openCalls = [];
  const call = makeHarness();
  const res = await call({ action: "deposit" });
  const text = res.content.map((c: any) => c.text).join("\n");

  assert.equal(openCalls[0], "https://buy.blockrun.ai");
  assert.match(text, /https:\/\/buy\.blockrun\.ai/);
  assert.equal(res.structuredContent.deposit_url, "https://buy.blockrun.ai");
  assert.equal(res.structuredContent.opened, true);
});
