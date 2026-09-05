// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The account rail's two new signals: the settled per-call cost header, and the
// credit balance. Both shipped on the server on 2026-09-05; both have a failure
// mode that reads as success, which is what these pin.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCostHeader } from "../src/utils/api-key-call.js";
import { describeBlock, formatCredit, type AccountCredit } from "../src/utils/account.js";

// ---------------------------------------------------------------------------
// parseCostHeader
// ---------------------------------------------------------------------------

test("a settled amount parses, including an explicit zero", () => {
  assert.equal(parseCostHeader("0.007500"), 0.0075);
  assert.equal(parseCostHeader("0.010000"), 0.01);
  assert.equal(parseCostHeader("0.157500"), 0.1575);
  assert.equal(parseCostHeader(" 0.002000 "), 0.002);
  // The gateway writes 0.000000 explicitly for a charge that really resolved to
  // nothing. That is a settled price and must survive as one — it is distinct
  // from omitting the header, which means no price settled at response time.
  assert.equal(parseCostHeader("0.000000"), 0);
});

// THE TRAP. Number("") is 0, not NaN — so a present-but-empty header parsed with
// a bare Number() books $0 against a call that was genuinely billed, which is
// exactly the confusion the header exists to remove, reintroduced in the reader.
// ClawRouter's first parser had this bug and a test caught it there.
test("an empty header reads as ABSENT, not as a settled zero", () => {
  assert.equal(parseCostHeader(""), null);
  assert.equal(parseCostHeader("   "), null);
  assert.notEqual(parseCostHeader(""), 0, "empty must not collapse to a settled zero");
});

test("missing, malformed and negative values all read as absent", () => {
  assert.equal(parseCostHeader(null), null);
  assert.equal(parseCostHeader(undefined), null);
  assert.equal(parseCostHeader("free"), null);
  assert.equal(parseCostHeader("$0.0075"), null);
  assert.equal(parseCostHeader("NaN"), null);
  assert.equal(parseCostHeader("Infinity"), null);
  // A negative charge is not a refund we know how to book; treat it as unknown
  // and fall back to the estimate rather than crediting a budget.
  assert.equal(parseCostHeader("-0.001"), null);
});

// ---------------------------------------------------------------------------
// formatCredit
// ---------------------------------------------------------------------------

const credit = (over: Partial<AccountCredit> = {}): AccountCredit => ({
  accountId: "acct",
  billingMode: "ungated",
  currency: "USD",
  grantedUsd: 0,
  spentUsd: 4.238060754,
  remainingUsd: null,
  blocked: false,
  blockedReason: null,
  ...over,
});

// The bug both this client and ClawRouter nearly shipped: `remaining_usd ?? 0`
// on an invoiced account, whose remaining is legitimately null, renders as
// "$0.00 left" and tells a paying customer in good standing that they are broke.
test("an invoiced account shows spend-to-date, never a zero balance", () => {
  const line = formatCredit(credit());
  assert.match(line, /Spent to date: \$4\.2381/);
  assert.match(line, /no prepaid ceiling/);
  assert.doesNotMatch(line, /remaining/i, "must not imply a ceiling that does not exist");
  assert.doesNotMatch(line, /\$0\.00\b/, "must never render as a zero balance");
});

test("a prepaid account shows what is left, against what was granted", () => {
  const line = formatCredit(credit({ billingMode: "gated", grantedUsd: 50, remainingUsd: 12.5 }));
  assert.match(line, /Credit remaining: \$12\.5000/);
  assert.match(line, /of \$50\.00 granted/);
});

test("a prepaid account genuinely at zero still says zero", () => {
  const line = formatCredit(credit({ billingMode: "gated", grantedUsd: 50, remainingUsd: 0 }));
  assert.match(line, /Credit remaining: \$0\.0000/);
});

// ---------------------------------------------------------------------------
// describeBlock
// ---------------------------------------------------------------------------

test("not blocked describes nothing", () => {
  assert.equal(describeBlock(null), null);
  assert.equal(describeBlock(undefined), null);
  assert.equal(describeBlock(""), null);
});

test("each known code maps to its own remedy, not a generic one", () => {
  const suspended = describeBlock("ACCOUNT_SUSPENDED")!;
  const limit = describeBlock("CREDIT_LIMIT_REACHED")!;
  const exhausted = describeBlock("BALANCE_EXHAUSTED")!;

  // The remedies genuinely differ — that is the whole reason these are mapped
  // client-side instead of printed from a server message.
  assert.match(suspended, /suspended/i);
  assert.match(suspended, /will not lift it/, "topping up is the wrong advice here");
  assert.match(limit, /credit limit/i);
  assert.match(exhausted, /top up/i);
  assert.notEqual(suspended, limit);
  assert.notEqual(limit, exhausted);
});

// The API owner committed to the code list being append-only and to announcing
// additions. This pins what happens if that ever slips: an unknown code must
// surface, not vanish. Reading it as "not blocked" would send an agent on to a
// call the proxy has already decided to refuse.
test("an unknown code degrades to honest, never to silence", () => {
  const out = describeBlock("SOME_FUTURE_CODE");
  assert.ok(out, "an unknown block code must still describe a block");
  assert.match(out, /SOME_FUTURE_CODE/, "name the code so it can be looked up");
  assert.match(out, /user\.blockrun\.ai/, "and still point somewhere actionable");
});
