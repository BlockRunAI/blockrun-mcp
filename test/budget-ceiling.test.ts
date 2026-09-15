// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// BLOCKRUN_BUDGET_LIMIT is sold as the operator's hard stop — the ONLY guard on
// a client that cannot render the spend dialog. It seeded a plain mutable
// `budget.limit`, and blockrun_wallet action:"budget" let the model write that
// field: budget_action:"clear" set it to null, budget_action:"set" to any
// positive number. The wallet tool is in every profile, annotated
// non-destructive, and the budget action is free, so no client prompted. The
// denial text an agent receives at the cap even points at the tool. One call,
// and the cap the operator set was gone on all three rails.
//
// The rule now: an env-seeded limit is a CEILING the session can only lower.
// `set` above it is clamped to it and says why; `clear` restores it rather
// than lifting it; a delegated per-agent cap cannot exceed it. Without the
// env, the tool behaves as before — set/clear are the operator's session
// controls and there is nothing to protect them from.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let apiKeyMode = false;
let activeChain: "base" | "solana" = "solana";

mock.module("../src/utils/onramp.js", {
  namedExports: { launchTopUp: async () => ({ opened: false, url: "", note: "" }) },
});
mock.module("../src/utils/auth.js", {
  namedExports: {
    isApiKeyMode: () => apiKeyMode,
    requireWalletMode: (c: string) => `${c} needs wallet mode`,
    PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
    PORTAL_ACTIVITY_URL: "https://user.blockrun.ai/dashboard/activity",
  },
});
mock.module("../src/utils/account.js", {
  namedExports: {
    describeBlock: () => null,
    formatCredit: () => "credit",
    getAccountCredit: async () => ({ accountId: "acct", billingMode: "prepaid", grantedUsd: 10, spentUsd: 1, remainingUsd: 9, blocked: false, blockedReason: null }),
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getWalletInfo: async () => ({ address: "0xTESTADDRESS", explorerUrl: "https://x", network: "base", chainId: 8453, isNew: false }),
    getChain: () => activeChain,
    getUsdcBalance: async () => 0,
    setChain: () => {},
    ensureBothWallets: async () => ({ base: { address: "0xTESTADDRESS" }, solana: { address: "SOL" } }),
    getChainBalance: async () => 0,
  },
});
const { registerWalletTool } = await import("../src/tools/wallet.js");
const { reserveBudget } = await import("../src/utils/budget.js");

// The ceiling is what initializeMcpServer seeded from the env before it
// registered the tools: a BudgetState whose `limit` is already set at
// registration time IS an env-capped server.
function makeHarness(envLimit: number | null) {
  let handler: ((a: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: any) => { handler = h; } } as any;
  const budget: BudgetState = { limit: envLimit, spent: 0, calls: 0, agents: new Map() };
  registerWalletTool(server, budget);
  return { call: (a: Record<string, unknown>) => handler!(a), budget };
}

// The ledger is one object shared by every paid tool, so the rail only changes
// which branch of the wallet tool the budget action runs in front of. All three
// are exercised so a future "api-key mode returns early" refactor cannot
// quietly reopen one of them.
const RAILS: Array<{ name: string; apiKey: boolean; chain: "base" | "solana" }> = [
  { name: "solana wallet", apiKey: false, chain: "solana" },
  { name: "base wallet", apiKey: false, chain: "base" },
  { name: "account api key", apiKey: true, chain: "base" },
];

for (const rail of RAILS) {
  test(`[${rail.name}] budget clear cannot lift an env-seeded cap — it restores the ceiling and the next call is still refused`, async () => {
    apiKeyMode = rail.apiKey;
    activeChain = rail.chain;
    const { call, budget } = makeHarness(2);
    budget.spent = 1.5;

    const res = await call({ action: "budget", budget_action: "clear" });
    assert.equal(res.isError, undefined, "clear is not an error — it is answered with what it did");
    assert.equal(budget.limit, 2, "the operator's $2 survives the clear");
    assert.equal(res.structuredContent.limit, 2);
    assert.equal(res.structuredContent.ceiling, 2);
    assert.match(res.content[0].text, /BLOCKRUN_BUDGET_LIMIT/, "names the env the operator set");
    assert.match(res.content[0].text, /cannot be removed|cannot be lifted|not removable/i, "says the cap stays");
    assert.match(res.content[0].text, /restart/i, "and where the real control is");
    assert.doesNotMatch(res.content[0].text, /Unlimited|Limit removed/);

    const over = reserveBudget(budget, undefined, 0.6);
    assert.equal(over.allowed, false, "$1.50 + $0.60 must still be refused under the $2 ceiling");
  });

  test(`[${rail.name}] budget set above the ceiling is clamped to it, with the reason`, async () => {
    apiKeyMode = rail.apiKey;
    activeChain = rail.chain;
    const { call, budget } = makeHarness(2);

    const res = await call({ action: "budget", budget_action: "set", budget_amount: 1000 });
    assert.equal(budget.limit, 2, "the raise is clamped, not applied");
    assert.equal(res.structuredContent.limit, 2);
    assert.equal(res.structuredContent.clamped, true);
    assert.match(res.content[0].text, /\$1000\.00/, "echoes what was asked for");
    assert.match(res.content[0].text, /clamped/i);
    assert.match(res.content[0].text, /BLOCKRUN_BUDGET_LIMIT/);
    assert.match(res.content[0].text, /restart/i);
    assert.doesNotMatch(res.content[0].text, /Set to \$1000/);

    budget.spent = 1.99;
    assert.equal(reserveBudget(budget, undefined, 0.05).allowed, false, "still capped at $2 after the attempted raise");
  });
}

test("the session may LOWER an env cap, and raise it back — but only up to the ceiling", async () => {
  apiKeyMode = false;
  activeChain = "solana";
  const { call, budget } = makeHarness(5);

  const lower = await call({ action: "budget", budget_action: "set", budget_amount: 1 });
  assert.equal(budget.limit, 1);
  assert.equal(lower.structuredContent.clamped, false);
  assert.match(lower.content[0].text, /Set to \$1\.00/);
  assert.equal(reserveBudget(budget, undefined, 1.5).allowed, false, "the lowered cap bites");

  const back = await call({ action: "budget", budget_action: "set", budget_amount: 5 });
  assert.equal(budget.limit, 5, "raising back to exactly the ceiling is allowed");
  assert.equal(back.structuredContent.clamped, false);

  await call({ action: "budget", budget_action: "set", budget_amount: 1 });
  const cleared = await call({ action: "budget", budget_action: "clear" });
  assert.equal(budget.limit, 5, "clear after a lower means: back to the operator's number");
  assert.match(cleared.content[0].text, /\$5\.00/);
});

test("budget check and report both name the ceiling so the model knows the cap is the operator's", async () => {
  apiKeyMode = false;
  activeChain = "base";
  const { call } = makeHarness(3);
  const res = await call({ action: "budget" });
  assert.equal(res.structuredContent.ceiling, 3);
  assert.match(res.content[0].text, /BLOCKRUN_BUDGET_LIMIT/);

  const report = await call({ action: "report" });
  assert.equal(report.structuredContent.global.ceiling, 3);
  assert.match(report.content[0].text, /operator ceiling \$3\.00 via BLOCKRUN_BUDGET_LIMIT/);

  const { call: free } = makeHarness(null);
  const freeReport = await free({ action: "report" });
  assert.equal(freeReport.structuredContent.global.ceiling, null);
  assert.doesNotMatch(freeReport.content[0].text, /ceiling/);
});

test("a delegated per-agent cap cannot exceed the ceiling either", async () => {
  apiKeyMode = false;
  activeChain = "solana";
  const { call, budget } = makeHarness(2);
  const res = await call({ action: "delegate", agent_id: "greedy", agent_limit: 50 });
  assert.equal(budget.agents.get("greedy")!.limit, 2, "clamped to the operator's $2");
  assert.equal(res.structuredContent.limit, 2);
  assert.equal(res.structuredContent.remaining, 2);
  assert.match(res.content[0].text, /\$50\.00/, "echoes the request");
  assert.match(res.content[0].text, /BLOCKRUN_BUDGET_LIMIT/);
  assert.match(res.content[0].text, /clamped/i);

  budget.agents.get("greedy")!.spent = 1.99;
  assert.equal(reserveBudget(budget, "greedy", 0.05).allowed, false, "the agent cap bites at $2, not $50");
});

test("with no env cap the tool keeps its old contract: set anything, clear to unlimited", async () => {
  apiKeyMode = false;
  activeChain = "solana";
  const { call, budget } = makeHarness(null);

  const set = await call({ action: "budget", budget_action: "set", budget_amount: 1000 });
  assert.equal(budget.limit, 1000);
  assert.equal(set.structuredContent.ceiling, null);
  assert.equal(set.structuredContent.clamped, false);
  assert.match(set.content[0].text, /Set to \$1000\.00/);
  assert.doesNotMatch(set.content[0].text, /BLOCKRUN_BUDGET_LIMIT/, "no env, no lecture about one");

  const cleared = await call({ action: "budget", budget_action: "clear" });
  assert.equal(budget.limit, null);
  assert.match(cleared.content[0].text, /Unlimited/);
  assert.match(cleared.content[0].text, /Limit removed/);
  assert.equal(reserveBudget(budget, undefined, 999).allowed, true);

  const big = await call({ action: "delegate", agent_id: "free", agent_limit: 50 });
  assert.equal(big.structuredContent.limit, 50, "no ceiling to clamp a delegation against");
  assert.doesNotMatch(big.content[0].text, /clamped/i);
});

test("the ceiling is what the server STARTED with — a cap set later in the session is not one", async () => {
  // An operator with no env who sets $1 via the tool has set a session
  // control, not a process ceiling: clearing it must still work, or the tool
  // would lock the very person it is meant to serve out of their own change.
  apiKeyMode = false;
  activeChain = "base";
  const { call, budget } = makeHarness(null);
  await call({ action: "budget", budget_action: "set", budget_amount: 1 });
  await call({ action: "budget", budget_action: "clear" });
  assert.equal(budget.limit, null);
});
