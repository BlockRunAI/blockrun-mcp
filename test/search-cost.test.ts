// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSearchCost } from "../src/tools/search.js";

// blockrun_search is the most expensive tool per call in the server — priced per
// SOURCE, so a default call settles ~$0.26 while most tools cost $0.001. The gate
// can only stop a looping agent if the reserve is >= what the gateway settles.
//
// These figures are the gateway's own 402 quotes (free to request — send any call
// with no payment header and it replies with the exact price), captured 2026-07-14:
//   max_results  1 → $0.0263
//   max_results  5 → $0.1313
//   max_results 10 → $0.2625   (default)
//   max_results 20 → $0.5250
//   max_results 50 → $1.3125
// Each is exactly 1.05x per_source x max_results. If the gateway's buffer moves,
// these pins fail — which is the point.
const QUOTES: Array<[number, number]> = [
  [1, 0.0263],
  [5, 0.1313],
  [10, 0.2625],
  [20, 0.525],
  [50, 1.3125],
];

test("estimateSearchCost reserves at least what the gateway actually settles", () => {
  for (const [max, quoted] of QUOTES) {
    const reserved = estimateSearchCost({ query: "x", max_results: max });
    assert.ok(
      reserved >= quoted - 1e-6,
      `max_results=${max}: reserved $${reserved} < gateway $${quoted} — the gate would under-reserve`,
    );
  }
});

test("estimateSearchCost does not over-reserve by more than a cent", () => {
  // Reserving wildly high would block calls a budget could actually afford.
  for (const [max, quoted] of QUOTES) {
    const reserved = estimateSearchCost({ query: "x", max_results: max });
    assert.ok(reserved - quoted < 0.01, `max_results=${max}: reserved $${reserved} vs gateway $${quoted}`);
  }
});

test("estimateSearchCost defaults to the 10-source price when max_results is absent", () => {
  // Upstream defaults to 10. Reserving less than that on a bare { query } — the
  // most common call shape — would let every default search skip the gate.
  assert.ok(estimateSearchCost({ query: "x" }) >= 0.2625 - 1e-6);
  assert.ok(estimateSearchCost(undefined) >= 0.2625 - 1e-6);
  assert.ok(estimateSearchCost("not an object") >= 0.2625 - 1e-6);
});

test("estimateSearchCost caps at 50 sources, matching the upstream ceiling", () => {
  assert.equal(estimateSearchCost({ max_results: 999 }), estimateSearchCost({ max_results: 50 }));
});

test("estimateSearchCost ignores garbage max_results instead of reserving $0", () => {
  // A $0 reserve is a gate bypass: it would authorize a ~$0.26 call against an
  // exhausted budget.
  for (const bad of [0, -5, "10", null, NaN, {}]) {
    assert.ok(
      estimateSearchCost({ max_results: bad }) >= 0.2625 - 1e-6,
      `max_results=${JSON.stringify(bad)} fell back below the default reserve`,
    );
  }
});
