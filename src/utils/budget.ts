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

/**
 * Atomically gate AND reserve a call's estimated cost so concurrent in-flight
 * calls can't each pass a stale `spent` and collectively blow past the cap
 * (the MCP SDK dispatches requests concurrently). `checkBudget` only READS
 * `spent`; the paid call then awaits the network before `recordSpending` WRITES
 * it, leaving a check-then-act race. Reserve closes it by adding the estimate to
 * `spent` immediately (so the next concurrent reserve sees it), and returning a
 * `release()` the caller MUST call in a `finally` once the call settles or
 * fails. The settled cost is still booked separately via recordSpending/
 * recordActualSpend; release() removes the estimate, netting the real spend:
 *
 *   const gate = reserveBudget(budget, agentId, estimate);
 *   if (!gate.allowed) return error(gate.reason);
 *   try { ...paid call...; recordActualSpend(...); return ok; }
 *   finally { gate.release(); }
 *
 * release() is idempotent and a no-op when the reservation was denied.
 */
export function reserveBudget(
  budget: BudgetState,
  agentId?: string,
  estimatedCost: number = 0.001,
): { allowed: boolean; reason?: string; release: () => void } {
  const check = checkBudget(budget, agentId, estimatedCost);
  if (!check.allowed) return { allowed: false, reason: check.reason, release: () => {} };

  const cost = Math.max(0, estimatedCost);
  budget.spent += cost;
  const agentBudget = agentId ? budget.agents.get(agentId) : undefined;
  if (agentBudget) agentBudget.spent += cost;

  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      budget.spent -= cost;
      if (agentBudget) agentBudget.spent -= cost;
    },
  };
}

/** Reservation handle returned by reserveBudget(). */
type Reservation = { allowed: boolean; reason?: string; release: () => void };

/**
 * When the REAL settled price (from a 402 quote) exceeds the estimate already
 * reserved at the gate, swap the reservation: release the estimate and
 * re-reserve the true amount, re-checking it against the cap. Returns the new
 * handle (its `.allowed` is false if the true amount would blow the budget — the
 * caller must then abort BEFORE paying), or the original handle unchanged when
 * the actual is unknown or already within the estimate.
 *
 * Used on paid paths whose price is only known after the quote (a Solana image
 * call settles the gateway's marked-up amount; blockrun_video's token-priced
 * renders can far exceed the per-second estimate) so a single call can't settle
 * past the cap and concurrent calls hold the true amount, not the low estimate.
 */
export function reReserveIfHigher(
  budget: BudgetState,
  gate: Reservation,
  agentId: string | undefined,
  estimate: number,
  actualUsd: number | null | undefined,
): Reservation {
  if (typeof actualUsd !== "number" || !Number.isFinite(actualUsd) || actualUsd <= estimate) {
    return gate;
  }
  gate.release();
  return reserveBudget(budget, agentId, actualUsd);
}

/**
 * Thrown when a re-reservation against the real quoted price exceeds the budget
 * cap. Distinct from PaymentError (which means "fund your wallet") so callers can
 * surface the budget reason instead of a misleading funding prompt.
 */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
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
