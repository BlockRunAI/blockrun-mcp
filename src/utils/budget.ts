// src/utils/budget.ts
import type { AgentBudget, BudgetState } from "../types.js";

const EPSILON = 1e-9;

function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount >= 1 ? 2 : 4)}`;
}

/**
 * Coerce an estimate into a usable, non-poisonous cost.
 *
 * `Math.max(0, x)` alone is NOT safe: for NaN, a function, or a string it yields
 * NaN, and NaN silently disables every cap in the process — `cost > 0` is false
 * so checkBudget ALLOWS, then `budget.spent += NaN` sticks and every subsequent
 * `spent + cost > limit` is false forever. That reached production once, via a
 * prototype-chain hit on modal's GPU table returning Object.prototype.toString.
 *
 * A non-finite estimate is a BUG in an estimator, and it must fail CLOSED here
 * rather than take the ledger with it.
 */
function coerceCost(estimatedCost: unknown): number {
  if (typeof estimatedCost !== "number" || !Number.isFinite(estimatedCost)) return 0;
  return Math.max(0, estimatedCost);
}

export function checkBudget(
  budget: BudgetState,
  agentId?: string,
  estimatedCost: number = 0.001,
): { allowed: boolean; reason?: string } {
  const cost = coerceCost(estimatedCost);

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

  const cost = coerceCost(estimatedCost);
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
  // coerceCost, not raw: a NaN here poisons budget.spent permanently and every
  // later cap check silently passes. Fail closed on a bad number.
  cost = coerceCost(cost);
  budget.spent += cost;
  budget.calls += 1;

  if (agentId) {
    // The live entry, or the tombstone a revoke left behind: a call that
    // settles while its id is revoked still spent that agent's money, and the
    // next delegate of the id carries the ledger back. Until audit round 4
    // this looked only at the live map, so revoke → settle → delegate forgot
    // the call — a per-agent refill, one in-flight call at a time.
    const agentBudget = budget.agents.get(agentId) ?? revokedLedgers.get(budget)?.get(agentId);
    if (agentBudget) {
      agentBudget.spent += cost;
      agentBudget.calls += 1;
    }
    // If no entry for this agent anywhere, spending is tracked globally only
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
 *
 * ZERO IS A SETTLED FIGURE, NOT AN ABSENT ONE. The account rail writes
 * `x-blockrun-cost-usd: 0.000000` for a charge that really resolved to nothing,
 * and parseCostHeader preserves it as 0 for exactly this call; the wallet rails
 * report a genuinely free model as a 0 counter delta. Until audit round 3 this
 * treated 0 like null (`actualUsd > 0`) and booked the ESTIMATE for it, so a
 * free-priced account call was recorded at the reserve and a $0.05 delegate
 * was cut off after seven of them having spent nothing (D33/D40). "Unknown" is
 * spelled null/undefined; NaN and a negative are estimator bugs and fall back
 * the same way. Callers that cannot tell free from unknown must pass null —
 * amountToUsd already does, mapping a missing or "0" x402 amount to null.
 */
export function recordActualSpend(
  budget: BudgetState,
  actualUsd: number | null | undefined,
  estimate: number,
  agentId?: string,
): void {
  const cost =
    typeof actualUsd === "number" && Number.isFinite(actualUsd) && actualUsd >= 0
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

// ---------------------------------------------------------------------------
// The operator's ceiling — the one number the session cannot raise
// ---------------------------------------------------------------------------
//
// BLOCKRUN_BUDGET_LIMIT is documented as the hard stop for clients that cannot
// render the spend dialog: on those, it is the ONLY guard. It used to seed the
// same mutable `budget.limit` that blockrun_wallet action:"budget" writes, so
// the agent it constrained could clear it (limit = null) or raise it (any
// positive number) in one free, non-destructive, un-elicited tool call — and
// the denial text it received at the cap pointed it at exactly that tool.
//
// The env value is therefore remembered separately, keyed by the ledger it
// seeded, and the wallet tool treats it as a ceiling: `set` may lower the
// session cap or raise it back UP TO the ceiling, `clear` restores the ceiling
// rather than lifting it, and a delegated per-agent cap is clamped to it.
// Without the env the ceiling is null and the tool keeps its old contract —
// set/clear are then the operator's own session controls, and there is no one
// to protect them from.
//
// A WeakMap rather than a field on BudgetState: the ledger is constructed in
// one place and handed by reference to every tool, and the ceiling is a fact
// about how that ledger was BORN, not state the tools update. Sealing happens
// at wallet-tool registration, which initializeMcpServer runs right after the
// env seed — so "the limit the server started with" and "the env value" are
// the same number, and a cap the model sets later in the session is not
// mistaken for one.
const operatorCeilings = new WeakMap<BudgetState, number | null>();

/**
 * Record the current `budget.limit` as the operator ceiling for this ledger,
 * once. Later calls return the sealed value and do not re-read `limit`, so a
 * session `set` cannot become the ceiling by being sealed after the fact.
 */
export function sealOperatorCeiling(budget: BudgetState): number | null {
  if (!operatorCeilings.has(budget)) operatorCeilings.set(budget, budget.limit);
  return operatorCeilings.get(budget) ?? null;
}

/** The sealed operator ceiling, or null when the server started unlimited. */
export function getOperatorCeiling(budget: BudgetState): number | null {
  return operatorCeilings.get(budget) ?? null;
}

// ---------------------------------------------------------------------------
// Per-agent allocations — the ledger follows the agent_id, not the Map entry
// ---------------------------------------------------------------------------
//
// Two bugs shared a root: `delegate` REPLACED the Map entry and `revoke`
// DELETED it, while the reservation closure in reserveBudget() holds the entry
// object it was given. So a re-delegation two minutes into a $1 render carried
// `spent` into a new object, the actual was booked on the new one and the
// estimate released from the old — the agent was over-counted by the estimate
// for the rest of the process. And revoke + delegate (two calls, both the
// model's to make) started the id at zero, which is the refill 0.50.0 said it
// had closed.
//
// So the entry object is never replaced: re-delegation mutates its `limit`,
// and revoke moves the SAME object into a per-ledger tombstone map that the
// next delegate of that id restores. A reservation taken before either
// operation releases against the object that is live after it. Spend made
// while an id is revoked is tracked globally only, as before — a revoked id
// has no per-agent cap, and a cap it does not have cannot be charged against.
const revokedLedgers = new WeakMap<BudgetState, Map<string, AgentBudget>>();

/**
 * Allocate (or re-allocate) a per-agent cap. Returns the live entry and
 * whether it carried a prior ledger — from a live entry or a revoked one — so
 * the caller can say so. Never resets `spent`/`calls`.
 */
export function delegateAgent(
  budget: BudgetState,
  agentId: string,
  limit: number,
): { entry: AgentBudget; carried: boolean } {
  const live = budget.agents.get(agentId);
  if (live) {
    live.limit = limit;
    return { entry: live, carried: true };
  }
  const tombs = revokedLedgers.get(budget);
  const revoked = tombs?.get(agentId);
  if (revoked) {
    tombs!.delete(agentId);
    revoked.limit = limit;
    budget.agents.set(agentId, revoked);
    return { entry: revoked, carried: true };
  }
  const entry: AgentBudget = { limit, spent: 0, calls: 0 };
  budget.agents.set(agentId, entry);
  return { entry, carried: false };
}

/**
 * The ledgers revoke left behind, for action:"report": the tool description
 * promises "its spend is kept", and kept spend nobody can read is not kept.
 */
export function listRevokedAgents(budget: BudgetState): Array<[string, AgentBudget]> {
  return [...(revokedLedgers.get(budget)?.entries() ?? [])];
}

/**
 * Remove an agent's cap. Its ledger is kept (tombstoned) so a later delegate
 * of the same id carries the spend. Returns false when there was no entry.
 */
export function revokeAgent(budget: BudgetState, agentId: string): boolean {
  const live = budget.agents.get(agentId);
  if (!live) return false;
  budget.agents.delete(agentId);
  let tombs = revokedLedgers.get(budget);
  if (!tombs) {
    tombs = new Map();
    revokedLedgers.set(budget, tombs);
  }
  tombs.set(agentId, live);
  return true;
}

// ---------------------------------------------------------------------------
// Quote sanity — pay what you were told, or nothing
// ---------------------------------------------------------------------------
//
// Every manual-402 tool estimates the charge from a published rate table, then
// reads the REAL price off the gateway's 402 before signing. Until now the only
// check on that real price was the budget cap: a quote above the estimate was
// re-reserved and paid. That is right for a token-priced 4K render that the
// table undershoots by a cent, and wrong for what verify:prices found on
// 2026-09-08: the Solana gateway (a separate deployment that can lag Base)
// does not know azure/sora-2 and quotes it as "Seedance 2.0 Pro video
// generation (5s)" at $1.135 — 2.7x the published Sora rate, for a different
// model. The budget cap would have let that through on any wallet with $2.
//
// So: a quote more than QUOTE_TOLERANCE_RATIO above the estimate (and more than
// QUOTE_TOLERANCE_FLOOR_USD above it, so a $0.003 quote against a $0.001
// estimate is not a "3x") is refused before anything is signed. The estimators
// are verified against live 402s to within $0.001 (`npm run verify:prices`), so
// the honest cases live far inside 1.5x; a legitimate gateway reprice past it
// fails loud until the estimator is updated, which is the safe direction for
// money. Nothing here touches the ledger — a refused quote settles nothing.
export const QUOTE_TOLERANCE_RATIO = 1.5;
export const QUOTE_TOLERANCE_FLOOR_USD = 0.02;

export class QuoteMismatchError extends Error {
  readonly quotedUsd: number;
  readonly estimateUsd: number;
  constructor(message: string, quotedUsd: number, estimateUsd: number) {
    super(message);
    this.name = "QuoteMismatchError";
    this.quotedUsd = quotedUsd;
    this.estimateUsd = estimateUsd;
  }
}

/**
 * Throws QuoteMismatchError when the gateway's authoritative quote is far above
 * what the caller told the user to expect. `null` quotes are not judged here —
 * callers already fail closed on an unreadable amount. The message ends with
 * "no charge was made" so formatError() does not append funding advice.
 */
export function assertQuoteNearEstimate(
  quotedUsd: number | null | undefined,
  estimateUsd: number,
  opts: { what: string; quotedFor?: string; hint?: string },
): void {
  if (typeof quotedUsd !== "number" || !Number.isFinite(quotedUsd)) return;
  if (!(estimateUsd > 0)) return; // a $0 estimate means "free": nothing to compare
  const ratio = quotedUsd / estimateUsd;
  if (ratio <= QUOTE_TOLERANCE_RATIO || quotedUsd - estimateUsd <= QUOTE_TOLERANCE_FLOOR_USD) return;
  const labelled = opts.quotedFor ? ` — the gateway labels that quote "${opts.quotedFor}"` : "";
  throw new QuoteMismatchError(
    `The gateway quoted $${quotedUsd.toFixed(4)} for ${opts.what}, but this tool expected about $${estimateUsd.toFixed(4)} ` +
      `(${ratio.toFixed(1)}x the published rate)${labelled}. Refusing to sign it — no charge was made. ` +
      `A gap this large means the gateway repriced the model or substituted a different one.` +
      (opts.hint ? ` ${opts.hint}` : ""),
    quotedUsd,
    estimateUsd,
  );
}
