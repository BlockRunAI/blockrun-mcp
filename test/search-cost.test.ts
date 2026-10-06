// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSearchCost } from "../src/tools/search.js";
import { estimateExaCost } from "../src/tools/exa.js";

// blockrun_search is one flat price per call. These are what x402 ACTUALLY
// charges — the `amount` in a live 402's payment requirement (free to request:
// send any call with no payment header). Captured 2026-10-06 on Base:
// 81000 micro-USDC at max_results 1, 10 and 50 alike; Solana quoted 80000.
//
// The gate can only stop a looping agent if the reserve is >= the charge, and
// it must not over-reserve by much or it blocks calls a budget can afford —
// the old $0.025 x max_results reserve did exactly that, 16x at 50 sources.
const CHARGED_BASE_USD = 0.081;
const SIZES = [1, 5, 10, 20, 50];

test("estimateSearchCost reserves at least what x402 actually charges, at every size", () => {
  for (const max of SIZES) {
    const reserved = estimateSearchCost({ query: "x", max_results: max });
    assert.ok(
      reserved >= CHARGED_BASE_USD - 1e-6,
      `max_results=${max}: reserved $${reserved} < charged $${CHARGED_BASE_USD} — the gate would under-reserve`,
    );
  }
});

test("estimateSearchCost does not over-reserve by more than a cent", () => {
  for (const max of SIZES) {
    const reserved = estimateSearchCost({ query: "x", max_results: max });
    assert.ok(reserved - CHARGED_BASE_USD < 0.01, `max_results=${max}: reserved $${reserved} vs gateway $${CHARGED_BASE_USD}`);
  }
});

test("estimateSearchCost is flat: max_results never changes the reserve", () => {
  const flat = estimateSearchCost({ query: "x" });
  for (const body of [undefined, "not an object", { max_results: 1 }, { max_results: 50 }, { max_results: 999 }]) {
    assert.equal(estimateSearchCost(body), flat);
  }
});

test("estimateSearchCost never reserves $0 on garbage max_results", () => {
  // A $0 reserve is a gate bypass.
  for (const bad of [0, -5, "10", null, NaN, {}]) {
    assert.ok(
      estimateSearchCost({ max_results: bad }) >= CHARGED_BASE_USD - 1e-6,
      `max_results=${JSON.stringify(bad)} fell below the charge`,
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
