// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountToUsd,
  checkBudget,
  parseBudgetLimitEnv,
  recordActualSpend,
  recordSpending,
  reReserveIfHigher,
  reserveBudget,
} from "../src/utils/budget.js";
import type { BudgetState } from "../src/types.js";

function newBudget(limit: number | null = null): BudgetState {
  return { limit, spent: 0, calls: 0, agents: new Map() };
}

test("amountToUsd converts atomic USDC (6 decimals) to USD", () => {
  assert.equal(amountToUsd("1000000"), 1); // 1 USDC
  assert.equal(amountToUsd("500000"), 0.5);
  assert.equal(amountToUsd(250000), 0.25);
  assert.equal(amountToUsd("1575"), 0.001575);
});

test("amountToUsd returns null for missing/garbled/non-positive amounts", () => {
  assert.equal(amountToUsd(undefined), null);
  assert.equal(amountToUsd(null), null);
  assert.equal(amountToUsd(""), null);
  assert.equal(amountToUsd("abc"), null);
  assert.equal(amountToUsd("0"), null);
  assert.equal(amountToUsd("-1000"), null);
});

test("recordActualSpend books the real settled cost when known", () => {
  const b = newBudget();
  recordActualSpend(b, 0.5, 0.001, undefined);
  assert.equal(b.spent, 0.5, "records actual, not the $0.001 estimate");
  assert.equal(b.calls, 1);
});

test("recordActualSpend falls back to the estimate when actual is unavailable/zero/negative", () => {
  const b = newBudget();
  recordActualSpend(b, null, 0.02, undefined);
  recordActualSpend(b, 0, 0.02, undefined);
  recordActualSpend(b, -5, 0.02, undefined);
  recordActualSpend(b, NaN, 0.02, undefined);
  assert.equal(Math.round(b.spent * 1000) / 1000, 0.08, "4 × $0.02 estimate");
  assert.equal(b.calls, 4);
});

test("budget cap holds once ACTUAL frontier cost is booked (the core fix)", () => {
  // A $1 cap. Each frontier call settles $0.50 on-chain.
  const b = newBudget(1);
  // gate reserves a small amount; the call is allowed
  assert.equal(checkBudget(b, undefined, 0.02).allowed, true);
  recordActualSpend(b, 0.5, 0.02, undefined); // real settled cost booked
  assert.equal(b.spent, 0.5);

  assert.equal(checkBudget(b, undefined, 0.02).allowed, true);
  recordActualSpend(b, 0.5, 0.02, undefined);
  assert.equal(b.spent, 1);

  // Third $0.50 call: spent ($1) + reserve would exceed the $1 cap → blocked.
  const third = checkBudget(b, undefined, 0.02);
  assert.equal(third.allowed, false, "cap is enforced after real spend is booked");
});

test("OLD flat-estimate behavior would have blown past the cap (regression guard)", () => {
  // Demonstrates why the fix matters: booking a flat $0.001 for $0.50 calls
  // lets 1000+ calls through a $1 cap.
  const b = newBudget(1);
  for (let i = 0; i < 50; i++) {
    assert.equal(checkBudget(b, undefined, 0.001).allowed, true);
    recordSpending(b, 0.001, undefined); // the old, buggy flat estimate
  }
  // 50 calls that really cost $0.50 each = $25 settled on-chain, but the ledger
  // shows only $0.05 — the cap is meaningless. recordActualSpend prevents this.
  assert.equal(Math.round(b.spent * 1000) / 1000, 0.05);
});

test("reserveBudget gates concurrent in-flight calls against the cap (TOCTOU fix)", () => {
  const b = newBudget(1); // $1 cap
  // Two concurrent $0.5 reservations both succeed and consume the cap...
  assert.equal(reserveBudget(b, undefined, 0.5).allowed, true);
  assert.equal(reserveBudget(b, undefined, 0.5).allowed, true);
  // ...so a third $0.5 call is blocked while the first two are still in flight,
  // even though nothing has been *recorded* yet. (checkBudget alone would let
  // all three pass because each reads the same pre-spend total.)
  assert.equal(reserveBudget(b, undefined, 0.5).allowed, false);
});

test("reserveBudget.release frees the reservation and is idempotent", () => {
  const b = newBudget(1);
  const a = reserveBudget(b, undefined, 0.8);
  assert.equal(a.allowed, true);
  assert.equal(reserveBudget(b, undefined, 0.8).allowed, false); // 0.8 + 0.8 > 1
  a.release();
  a.release(); // idempotent — must not double-credit
  assert.equal(b.spent, 0);
  assert.equal(reserveBudget(b, undefined, 0.8).allowed, true); // capacity freed
});

test("reserve + recordActualSpend + release nets the actual settled cost", () => {
  const b = newBudget(10);
  const g = reserveBudget(b, undefined, 0.02); // reserve the estimate
  assert.equal(g.allowed, true);
  recordActualSpend(b, 0.5, 0.02, undefined);  // book the real on-chain cost
  g.release();                                  // free the estimate
  assert.equal(b.spent, 0.5);
  assert.equal(b.calls, 1);
});

test("a blocked reserveBudget makes no reservation (release is a safe no-op)", () => {
  const b = newBudget(0.01);
  const g = reserveBudget(b, undefined, 0.5);
  assert.equal(g.allowed, false);
  assert.equal(b.spent, 0);
  g.release();
  assert.equal(b.spent, 0);
});

test("reserveBudget enforces per-agent caps across concurrent calls", () => {
  const b = newBudget(null);
  b.agents.set("a1", { limit: 1, spent: 0, calls: 0 });
  assert.equal(reserveBudget(b, "a1", 0.6).allowed, true);
  assert.equal(reserveBudget(b, "a1", 0.6).allowed, false); // 0.6 + 0.6 > 1 for agent
});

test("reReserveIfHigher swaps to the higher actual and holds only that amount", () => {
  // A quote (0.09) higher than the estimate reserved (0.05): release the
  // estimate, re-reserve the true amount, so the gate holds 0.09 for the cap.
  const b = newBudget(10);
  const g0 = reserveBudget(b, undefined, 0.05);
  const g1 = reReserveIfHigher(b, g0, undefined, 0.05, 0.09);
  assert.equal(g1.allowed, true);
  assert.equal(Math.round(b.spent * 100) / 100, 0.09);
});

test("reReserveIfHigher keeps the original reservation when actual is <= estimate or unknown", () => {
  const b = newBudget(10);
  const g0 = reserveBudget(b, undefined, 0.05);
  assert.equal(reReserveIfHigher(b, g0, undefined, 0.05, 0.04), g0, "lower actual → same gate");
  assert.equal(reReserveIfHigher(b, g0, undefined, 0.05, null), g0, "unknown actual → same gate");
  assert.equal(reReserveIfHigher(b, g0, undefined, 0.05, 0.05), g0, "equal actual → same gate");
  assert.equal(b.spent, 0.05, "still holding just the one estimate");
});

test("reReserveIfHigher denies (allowed:false) when the higher actual would blow the cap, leaving no reservation", () => {
  const b = newBudget(0.10);
  b.spent = 0.05; // prior spend on the ledger
  const g0 = reserveBudget(b, undefined, 0.04); // 0.05 + 0.04 = 0.09 ≤ 0.10 → allowed
  assert.equal(g0.allowed, true);
  const g1 = reReserveIfHigher(b, g0, undefined, 0.04, 0.09); // 0.05 + 0.09 = 0.14 > 0.10
  assert.equal(g1.allowed, false);
  assert.equal(Math.round(b.spent * 100) / 100, 0.05, "estimate released, higher reserve denied → back to prior spend");
});

test("parseBudgetLimitEnv parses a default cap, ignores junk", () => {
  assert.equal(parseBudgetLimitEnv("5"), 5);
  assert.equal(parseBudgetLimitEnv("5.00"), 5);
  assert.equal(parseBudgetLimitEnv("$2.50"), 2.5);
  assert.equal(parseBudgetLimitEnv("  10 "), 10);
  assert.equal(parseBudgetLimitEnv(undefined), null);
  assert.equal(parseBudgetLimitEnv(""), null);
  assert.equal(parseBudgetLimitEnv("abc"), null);
  assert.equal(parseBudgetLimitEnv("0"), null);
  assert.equal(parseBudgetLimitEnv("-3"), null);
});
