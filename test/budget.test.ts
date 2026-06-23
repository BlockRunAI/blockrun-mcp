// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountToUsd,
  checkBudget,
  parseBudgetLimitEnv,
  recordActualSpend,
  recordSpending,
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
