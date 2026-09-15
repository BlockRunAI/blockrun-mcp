// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// A per-agent cap the agent can refill is not a cap.
//
// `delegate` wrote `spent: 0` unconditionally, so an agent that had exhausted
// its allocation could call blockrun_wallet action:"delegate" with its own
// agent_id and start again — and delegate is a tool the MODEL can call. The
// global BLOCKRUN_BUDGET_LIMIT was never bypassable this way (checkBudget
// tests it separately), so the damage was bounded: the sub-cap simply meant
// nothing once the agent noticed. A limit is the operator's to raise or lower;
// spend already happened and is not theirs to erase.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

mock.module("../src/utils/onramp.js", {
  namedExports: { launchTopUp: async () => ({ opened: false, url: "", note: "" }) },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
    getWalletInfo: async () => ({ address: "0xTESTADDRESS" }),
    getChain: () => "base",
    getUsdcBalance: async () => 0,
    setChain: () => {},
    ensureBothWallets: async () => ({ base: { address: "0xTESTADDRESS" }, solana: { address: "SOL" } }),
    getChainBalance: async () => 0,
  },
});
const { registerWalletTool } = await import("../src/tools/wallet.js");
const { reserveBudget, recordActualSpend } = await import("../src/utils/budget.js");

function makeHarness(limit: number | null = null) {
  let handler: ((a: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: any) => { handler = h; } } as any;
  const budget: BudgetState = { limit, spent: 0, calls: 0, agents: new Map() };
  registerWalletTool(server, budget);
  return { call: (a: Record<string, unknown>) => handler!(a), budget };
}

test("re-delegating the same agent_id carries the spend, it does not refill the cap", async () => {
  const { call, budget } = makeHarness();
  await call({ action: "delegate", agent_id: "worker-1", agent_limit: 1 });

  // Spend it out through the real ledger, the way a paid tool does.
  const gate = reserveBudget(budget, "worker-1", 0.9);
  assert.equal(gate.allowed, true);
  gate.release();
  budget.agents.get("worker-1")!.spent = 0.9;

  const blocked = reserveBudget(budget, "worker-1", 0.5);
  assert.equal(blocked.allowed, false, "0.9 of a 1.0 cap leaves no room for 0.5");

  // The refill attempt.
  const res = await call({ action: "delegate", agent_id: "worker-1", agent_limit: 1 });
  assert.equal(budget.agents.get("worker-1")!.spent, 0.9, "spend must survive a re-delegation");
  assert.equal(res.structuredContent.spent, 0.9);
  assert.equal(res.structuredContent.remaining, 0.1);
  assert.match(res.content[0].text, /Carried over/);
  assert.match(res.content[0].text, /\$0\.1000 remains/);

  const stillBlocked = reserveBudget(budget, "worker-1", 0.5);
  assert.equal(stillBlocked.allowed, false, "the cap must still bite after re-delegation");
});

test("raising the limit gives an exhausted agent room again — that is the operator's call", async () => {
  const { call, budget } = makeHarness();
  await call({ action: "delegate", agent_id: "worker-2", agent_limit: 1 });
  budget.agents.get("worker-2")!.spent = 1;

  const res = await call({ action: "delegate", agent_id: "worker-2", agent_limit: 5 });
  assert.equal(budget.agents.get("worker-2")!.spent, 1, "still one dollar spent");
  assert.equal(res.structuredContent.remaining, 4);
  assert.doesNotMatch(res.content[0].text, /already at its cap/);
  assert.equal(reserveBudget(budget, "worker-2", 3).allowed, true);
});

test("a first delegation reports no carry-over, and revoke removes the allocation", async () => {
  const { call, budget } = makeHarness();
  const first = await call({ action: "delegate", agent_id: "fresh", agent_limit: 2 });
  assert.equal(first.structuredContent.spent, 0);
  assert.doesNotMatch(first.content[0].text, /Carried over/);

  const res = await call({ action: "revoke", agent_id: "fresh" });
  assert.equal(budget.agents.has("fresh"), false, "revoke removes the allocation outright");
  assert.equal(res.structuredContent.revoked, true);
  assert.equal(reserveBudget(budget, "fresh", 100).allowed, true, "a revoked id has no per-agent cap — it is tracked globally only");
});

test("revoke + delegate is not a refill: the spend follows the agent_id back", async () => {
  // The 0.50.0 fix carried `spent` across a re-delegation, but `revoke` deleted
  // the entry and the next `delegate` started at zero — two calls instead of
  // one, both of them the model's to make. The changelog said the cap could
  // not refill itself; it could.
  const { call, budget } = makeHarness();
  await call({ action: "delegate", agent_id: "fresh", agent_limit: 2 });
  budget.agents.get("fresh")!.spent = 2;
  budget.agents.get("fresh")!.calls = 7;
  await call({ action: "revoke", agent_id: "fresh" });

  const again = await call({ action: "delegate", agent_id: "fresh", agent_limit: 2 });
  assert.equal(again.structuredContent.spent, 2, "spend already happened; revoke does not erase it");
  assert.equal(again.structuredContent.calls, 7);
  assert.equal(again.structuredContent.remaining, 0);
  assert.match(again.content[0].text, /Carried over/);
  assert.match(again.content[0].text, /already at its cap/);
  assert.equal(reserveBudget(budget, "fresh", 0.01).allowed, false, "still exhausted after the revoke/delegate dance");

  // Raising the limit is the operator's call and still works.
  const raised = await call({ action: "delegate", agent_id: "fresh", agent_limit: 3 });
  assert.equal(raised.structuredContent.remaining, 1);
  assert.equal(reserveBudget(budget, "fresh", 0.5).allowed, true);
});

test("a reservation taken BEFORE a re-delegation is released against the entry that is live AFTER it", async () => {
  // Regression of 7f8d8f1: carrying `spent` into a brand-new object meant the
  // reservation closure (which holds the OLD object) released the estimate
  // from an orphan, so the live entry kept reservation + actual and the agent
  // was over-counted for the rest of the process.
  const { call, budget } = makeHarness();
  await call({ action: "delegate", agent_id: "worker-1", agent_limit: 2 });

  const gate = reserveBudget(budget, "worker-1", 1);
  assert.equal(gate.allowed, true);
  assert.equal(budget.agents.get("worker-1")!.spent, 1, "the estimate is held while the call is in flight");

  // The operator raises the cap two minutes into the render.
  const res = await call({ action: "delegate", agent_id: "worker-1", agent_limit: 3 });
  assert.equal(res.structuredContent.spent, 1, "the in-flight reservation is still visible");
  assert.equal(budget.agents.get("worker-1")!.limit, 3);

  // The call settles at the estimate, then the gate is released — the order
  // every paid tool follows.
  recordActualSpend(budget, 1, 1, "worker-1");
  gate.release();
  assert.equal(budget.agents.get("worker-1")!.spent, 1, "actual only: the reservation was netted out of the LIVE entry");
  assert.equal(budget.agents.get("worker-1")!.calls, 1);
  assert.equal(budget.spent, 1, "the global ledger agrees");
  assert.equal(reserveBudget(budget, "worker-1", 1.5).allowed, true, "$1 of $3 spent leaves room for $1.50");
});

test("the same holds across revoke → re-delegate while a call is in flight", async () => {
  const { call, budget } = makeHarness();
  await call({ action: "delegate", agent_id: "worker-2", agent_limit: 2 });
  const gate = reserveBudget(budget, "worker-2", 0.5);
  await call({ action: "revoke", agent_id: "worker-2" });
  const back = await call({ action: "delegate", agent_id: "worker-2", agent_limit: 2 });
  assert.equal(back.structuredContent.spent, 0.5, "the in-flight reservation came back with the id");
  assert.equal(reserveBudget(budget, "worker-2", 1.6).allowed, false, "and it still counts against the cap");

  recordActualSpend(budget, 0.5, 0.5, "worker-2");
  gate.release();
  assert.equal(budget.agents.get("worker-2")!.spent, 0.5);
  assert.equal(budget.agents.get("worker-2")!.calls, 1);
});

test("an agent_limit above the session cap says so instead of implying it can be spent", async () => {
  // A cap set through the tool mid-session (no BLOCKRUN_BUDGET_LIMIT) is not a
  // ceiling — the delegation is honoured and the note says the session cap
  // will stop it first. The env-ceiling case, where the allocation itself is
  // clamped, lives in budget-ceiling.test.ts.
  const { call, budget } = makeHarness();
  await call({ action: "budget", budget_action: "set", budget_amount: 3 });
  const res = await call({ action: "delegate", agent_id: "greedy", agent_limit: 50 });
  assert.equal(budget.agents.get("greedy")!.limit, 50);
  assert.match(res.content[0].text, /session cap is \$3\.00/);
  assert.doesNotMatch(res.content[0].text, /clamped/i);
});

test("an agent whose spend has reached the limit is told so, not silently re-armed", async () => {
  const { call, budget } = makeHarness();
  await call({ action: "delegate", agent_id: "spent-out", agent_limit: 1 });
  budget.agents.get("spent-out")!.spent = 1;

  const res = await call({ action: "delegate", agent_id: "spent-out", agent_limit: 1 });
  assert.equal(res.structuredContent.remaining, 0);
  assert.match(res.content[0].text, /already at its cap/);
  assert.match(res.content[0].text, /raise agent_limit above \$1\.0000/);
  assert.equal(reserveBudget(budget, "spent-out", 0.01).allowed, false);
});
