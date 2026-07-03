// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePhoneCost } from "../src/tools/phone.js";

test("estimatePhoneCost prices the exact known tiers", () => {
  assert.equal(estimatePhoneCost("phone/numbers/buy", true), 5);
  assert.equal(estimatePhoneCost("phone/numbers/renew", true), 5);
  assert.equal(estimatePhoneCost("voice/call", true), 0.54);
  assert.equal(estimatePhoneCost("phone/lookup", true), 0.01);
  assert.equal(estimatePhoneCost("phone/lookup/fraud", true), 0.05);
  assert.equal(estimatePhoneCost("phone/numbers/release", true), 0);
  assert.equal(estimatePhoneCost("phone/numbers/list", true), 0.001);
});

test("estimatePhoneCost still prices the free voice/call status poll (GET, no body)", () => {
  assert.equal(estimatePhoneCost("voice/call/CA123abc", false), 0);
});

// The bug: a query string / trailing slash / casing let the $5 buy and $0.54
// call routes be mispriced as the $0.001 default while the gateway charged full.
test("estimatePhoneCost is not downgraded by a query string, trailing slash, or casing", () => {
  assert.equal(estimatePhoneCost("phone/numbers/buy?areaCode=415", true), 5);
  assert.equal(estimatePhoneCost("phone/numbers/buy/", true), 5);
  assert.equal(estimatePhoneCost("Phone/Numbers/Buy", true), 5);
  assert.equal(estimatePhoneCost("voice/call?trace=1", true), 0.54);
  assert.equal(estimatePhoneCost("phone/numbers/renew#x", true), 5);
});
