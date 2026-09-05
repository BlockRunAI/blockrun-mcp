// Run with: npm test  (tsx --experimental-test-module-mocks --test)
// Verifies blockrun_wallet action:"deposit" wires through launchTopUp (the
// Coinbase-onramp flow), with launchTopUp + wallet mocked so no network/browser.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

const COINBASE_URL = "https://pay.coinbase.com/buy/select-asset?sessionToken=xyz";
mock.module("../src/utils/onramp.js", {
  namedExports: {
    launchTopUp: async () => ({ opened: true, url: COINBASE_URL, note: `Opened a Coinbase card top-up page in your browser: ${COINBASE_URL}` }),
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),

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

test("deposit returns the Coinbase onramp link from launchTopUp", async () => {
  const call = makeHarness();
  const res = await call({ action: "deposit" });
  const text = res.content.map((c: any) => c.text).join("\n");

  assert.match(text, /pay\.coinbase\.com/);
  assert.equal(res.structuredContent.onramp_url, COINBASE_URL);
  assert.equal(res.structuredContent.opened, true);
});
