// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSearchCost } from "../src/tools/search.js";
import { estimateExaCost } from "../src/tools/exa.js";

// blockrun_search is the most expensive tool per call in the server — priced per
// SOURCE, so a default call settles ~$0.26 while most tools cost $0.001. The gate
// can only stop a looping agent if the reserve is >= what the gateway settles.
//
// These are what x402 ACTUALLY charges — `maxAmountRequired` decoded from the
// base64 `payment-required` header on a live 402 (free to request: send any call
// with no payment header). Captured 2026-07-15.
//
// They are NOT the 402's JSON `price` field. That field is the BASE, and the
// charge is base + a $0.002 flat transaction fee:
//
//   max_results   body price   header (CHARGED)   <- pin the RIGHT column
//   1             $0.0263      $0.0283
//   5             $0.1313      $0.1333
//   10            $0.2625      $0.2645
//   20            $0.5250      $0.5270
//   50            $1.3125      $1.3145
//
// 0.30.10 pinned the body column and shipped a gate that was $0.002 short on
// every search. If the fee or the buffer moves, these fail — which is the point.
const CHARGED: Array<[number, number]> = [
  [1, 0.0283],
  [5, 0.1333],
  [10, 0.2645],
  [20, 0.527],
  [50, 1.3145],
];

test("estimateSearchCost reserves at least what x402 actually charges (header, not body)", () => {
  for (const [max, quoted] of CHARGED) {
    const reserved = estimateSearchCost({ query: "x", max_results: max });
    assert.ok(
      reserved >= quoted - 1e-6,
      `max_results=${max}: reserved $${reserved} < charged $${quoted} — the gate would under-reserve`,
    );
  }
});

test("estimateSearchCost does not over-reserve by more than a cent", () => {
  // Reserving wildly high would block calls a budget could actually afford.
  for (const [max, quoted] of CHARGED) {
    const reserved = estimateSearchCost({ query: "x", max_results: max });
    assert.ok(reserved - quoted < 0.01, `max_results=${max}: reserved $${reserved} vs gateway $${quoted}`);
  }
});

test("estimateSearchCost defaults to the 10-source price when max_results is absent", () => {
  // Upstream defaults to 10. Reserving less than that on a bare { query } — the
  // most common call shape — would let every default search skip the gate.
  assert.ok(estimateSearchCost({ query: "x" }) >= 0.2645 - 1e-6);
  assert.ok(estimateSearchCost(undefined) >= 0.2645 - 1e-6);
  assert.ok(estimateSearchCost("not an object") >= 0.2645 - 1e-6);
});

test("estimateSearchCost caps at 50 sources, matching the upstream ceiling", () => {
  assert.equal(estimateSearchCost({ max_results: 999 }), estimateSearchCost({ max_results: 50 }));
});

test("estimateSearchCost ignores garbage max_results instead of reserving $0", () => {
  // A $0 reserve is a gate bypass: it would authorize a ~$0.26 call against an
  // exhausted budget.
  for (const bad of [0, -5, "10", null, NaN, {}]) {
    assert.ok(
      estimateSearchCost({ max_results: bad }) >= 0.2645 - 1e-6,
      `max_results=${JSON.stringify(bad)} fell back below the default reserve`,
    );
  }
});

// The exa price gate matched the RAW slug, so `contents?x=1` missed the per-URL
// branch and reserved the flat $0.01 while the gateway — which ignores the query
// when routing — still billed per URL. 100 URLs: $0.012 reserved, $0.202 settled,
// a 17x under-reserve that recordSpending then books wrong permanently. The path
// is caller-supplied, so one hallucinated `?` was enough.
test("exa contents pricing survives a query string, fragment, prefix and case", () => {
  const body = { urls: Array.from({ length: 100 }, (_, i) => `https://e.com/${i}`) };
  const plain = estimateExaCost("contents", body);
  assert.ok(plain > 0.19, `100 URLs should price ~$0.202, got ${plain}`);
  for (const variant of ["contents?x=1", "/contents?a=b&c=d", "v1/exa/contents?x=1", "contents#frag", "CONTENTS", "contents/"]) {
    assert.equal(estimateExaCost(variant, body), plain, `${variant} must price like "contents"`);
  }
});

test("a non-contents exa path still prices flat", () => {
  assert.equal(estimateExaCost("search?q=1", {}), estimateExaCost("search", {}));
});
