// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The blockrun_wallet description promises that action:"status" (the default)
// shows "session spending", and tells the model to call it before expensive
// operations. The api-key branch did; the wallet branch printed addresses,
// balances and the active chain and nothing about what this process has
// spent, so an agent that checked status before a $0.40 render saw $12 of USDC
// and no hint that its $1 allotment was nearly gone. Both wallet chains carry
// the same session line and structuredContent fields the api-key branch does.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let activeChain: "base" | "solana" = "solana";

mock.module("../src/utils/onramp.js", {
  namedExports: { launchTopUp: async () => ({ opened: false, url: "", note: "" }) },
});
mock.module("../src/utils/auth.js", {
  namedExports: {
    isApiKeyMode: () => false,
    requireWalletMode: (c: string) => `${c} needs wallet mode`,
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
    PORTAL_ACTIVITY_URL: "https://user.blockrun.ai/dashboard/activity",
  },
});
mock.module("../src/utils/account.js", {
  namedExports: {
    describeBlock: () => null,
    formatCredit: () => "credit",
    getAccountCredit: async () => { throw new Error("wallet mode: not called"); },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getWalletInfo: async () => ({ address: "0xTESTADDRESS", explorerUrl: "https://explorer/x", network: "base", chainId: 8453, isNew: false }),
    getChain: () => activeChain,
    getUsdcBalance: async () => 12,
    setChain: () => {},
    ensureBothWallets: async () => ({ base: { address: "0xTESTADDRESS" }, solana: { address: "SOLADDR" } }),
    getChainBalance: async () => 12,
  },
});
const { registerWalletTool } = await import("../src/tools/wallet.js");

function makeHarness(limit: number | null) {
  let handler: ((a: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: any) => { handler = h; } } as any;
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerWalletTool(server, budget);
  return { call: (a: Record<string, unknown>) => handler!(a), budget };
}

for (const chain of ["solana", "base"] as const) {
  test(`[${chain}] wallet-mode status reports the session ledger next to the balance`, async () => {
    activeChain = chain;
    const { call, budget } = makeHarness(1);
    budget.spent = 0.7325;
    budget.calls = 3;

    const res = await call({ action: "status" });
    const text: string = res.content[0].text;
    assert.match(text, /\$12\.000000 USDC/, "the balance is still there");
    assert.match(text, /This session: \$0\.7325 \/ \$1\.00 local cap — 3 calls/, "the same line the api-key branch prints");
    assert.equal(res.structuredContent.sessionSpend, 0.7325);
    assert.equal(res.structuredContent.calls, 3);
    assert.equal(res.structuredContent.limit, 1);
    assert.equal(res.structuredContent.activeChain, chain);
  });

  test(`[${chain}] wallet-mode status with no cap says so rather than omitting the figure`, async () => {
    activeChain = chain;
    const { call, budget } = makeHarness(null);
    budget.spent = 0.01;
    budget.calls = 1;

    const res = await call({ action: "status" });
    assert.match(res.content[0].text, /This session: \$0\.0100 — 1 call/);
    assert.doesNotMatch(res.content[0].text, /local cap/);
    assert.equal(res.structuredContent.sessionSpend, 0.01);
    assert.equal(res.structuredContent.limit, null);
  });
}
