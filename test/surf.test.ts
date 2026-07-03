// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSurfCost } from "../src/tools/surf.js";

test("estimateSurfCost prices the exact tier tables", () => {
  assert.equal(estimateSurfCost("onchain/sql"), 0.02);      // T3
  assert.equal(estimateSurfCost("chat/completions"), 0.02); // T3
  assert.equal(estimateSurfCost("social/mindshare"), 0.005); // T2 exact
  assert.equal(estimateSurfCost("wallet/detail"), 0.005);    // T2 prefix
  assert.equal(estimateSurfCost("search/web"), 0.005);       // T2 prefix
  assert.equal(estimateSurfCost("market/price"), 0.001);     // T1 default
});

// The bug: a query string / trailing slash let a T3 ($0.02) or T2 ($0.005)
// exact-set path drop to the $0.001 default, under-recording spend up to 20x.
test("estimateSurfCost is not downgraded by a query string or trailing slash", () => {
  assert.equal(estimateSurfCost("onchain/schema?chain=ethereum"), 0.02);
  assert.equal(estimateSurfCost("chat/completions/"), 0.02);
  assert.equal(estimateSurfCost("social/mindshare?q=eth&interval=1d"), 0.005);
  assert.equal(estimateSurfCost("token/holders?token=0x1"), 0.005);
});
