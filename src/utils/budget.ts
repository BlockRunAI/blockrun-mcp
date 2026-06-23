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

/**
 * Convert an x402 `details.amount` (atomic USDC base units — USDC has 6 decimals
 * on both Base and Solana) to a USD figure. Returns null when the amount is
 * missing or unparseable so callers fall back to their pre-call estimate instead
 * of silently recording $0 for a call that actually settled on-chain.
 */
export function amountToUsd(amount: unknown): number | null {
  const n =
    typeof amount === "string" ? Number(amount)
    : typeof amount === "number" ? amount
    : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 1_000_000;
}

/**
 * Record the ACTUAL settled cost of a paid call when it is known (the 402
 * `details.amount`, or an SDK getSpending() delta), else fall back to the
 * pre-call `estimate`. The budget cap is only meaningful if the ledger reflects
 * real on-chain spend: the old path recorded a flat estimate, so a frontier
 * chat or high-resolution video could settle for orders of magnitude more than
 * was booked, silently blowing past the cap.
 */
export function recordActualSpend(
  budget: BudgetState,
  actualUsd: number | null | undefined,
  estimate: number,
  agentId?: string,
): void {
  const cost =
    typeof actualUsd === "number" && Number.isFinite(actualUsd) && actualUsd > 0
      ? actualUsd
      : Math.max(0, estimate);
  recordSpending(budget, cost, agentId);
}

/**
 * Parse the optional BLOCKRUN_BUDGET_LIMIT env var into a default global spend
 * cap (USD). Without it the server starts UNLIMITED — an agent loop can drain
 * the funded wallet before the user ever runs blockrun_wallet action:"budget".
 * Accepts "5", "5.00", or "$5"; ignores junk / non-positive values (→ null).
 */
export function parseBudgetLimitEnv(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim().replace(/^\$/, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
