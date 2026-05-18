// src/utils/budget.ts
import type { BudgetState } from "../types.js";

const EPSILON = 1e-9;

function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount >= 1 ? 2 : 4)}`;
}

export function checkBudget(
  budget: BudgetState,
  agentId?: string,
  estimatedCost: number = 0.001,
): { allowed: boolean; reason?: string } {
  const cost = Math.max(0, estimatedCost);

  // Check global limit first. Use the next-call estimate so a budget cannot be
  // exceeded by one final paid request.
  if (cost > 0 && budget.limit !== null && budget.spent + cost > budget.limit + EPSILON) {
    const remaining = Math.max(0, budget.limit - budget.spent);
    return {
      allowed: false,
      reason: `Global budget limit ${formatUsd(budget.limit)} would be exceeded (${formatUsd(budget.spent)} spent, ${formatUsd(remaining)} remaining, next call estimated ${formatUsd(cost)})`,
    };
  }

  // Check per-agent limit
  if (agentId) {
    const agentBudget = budget.agents.get(agentId);
    if (cost > 0 && agentBudget && agentBudget.spent + cost > agentBudget.limit + EPSILON) {
      const remaining = Math.max(0, agentBudget.limit - agentBudget.spent);
      return {
        allowed: false,
        reason: `Agent "${agentId}" budget ${formatUsd(agentBudget.limit)} would be exceeded (${formatUsd(agentBudget.spent)} spent, ${formatUsd(remaining)} remaining, next call estimated ${formatUsd(cost)})`,
      };
    }
  }

  return { allowed: true };
}

export function recordSpending(budget: BudgetState, cost: number, agentId?: string): void {
  budget.spent += cost;
  budget.calls += 1;

  if (agentId) {
    const agentBudget = budget.agents.get(agentId);
    if (agentBudget) {
      agentBudget.spent += cost;
      agentBudget.calls += 1;
    }
    // If no budget entry for this agent, spending is tracked globally only
  }
}
