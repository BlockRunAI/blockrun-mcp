// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePhoneCost } from "../src/tools/phone.js";

// Reserves are the CHARGE (base + the gateway's $0.002 flat tx fee), not the
// base. Verified against live payment-required headers: phone/lookup base $0.010
// -> charged $0.0120; phone/numbers/list $0.001 -> $0.0030. Reserving the base
// left the gate short on every paid phone call.
test("estimatePhoneCost prices the exact known tiers at the CHARGED price", () => {
  assert.equal(estimatePhoneCost("phone/numbers/buy", true), 5.002);
  assert.equal(estimatePhoneCost("phone/numbers/renew", true), 5.002);
  assert.equal(estimatePhoneCost("voice/call", true), 0.542);
  assert.equal(estimatePhoneCost("phone/lookup", true), 0.012);
  assert.equal(estimatePhoneCost("phone/lookup/fraud", true), 0.052001);
  assert.equal(estimatePhoneCost("phone/numbers/release", true), 0);
  assert.equal(estimatePhoneCost("phone/numbers/list", true), 0.003);
});

// An unlisted paid route must never reserve $0. /v1/phone/numbers/search is live
// and charges $0.0120 (verified) yet appears in neither this table nor the
// gateway's own PHONE_PRICES — the old catch-all reserved AND recorded $0 for it,
// so the spend was invisible to the ledger and the gate waved it through.
test("estimatePhoneCost fails closed on an unknown paid route", () => {
  assert.ok(estimatePhoneCost("phone/numbers/search", false) >= 0.012,
    "unknown GET must not reserve $0 — numbers/search charges $0.0120");
  assert.ok(estimatePhoneCost("phone/some/future/route", false) > 0);
  assert.ok(estimatePhoneCost("phone/some/future/route", true) > 0);
});

test("estimatePhoneCost still prices the free voice/call status poll (GET, no body)", () => {
  assert.equal(estimatePhoneCost("voice/call/CA123abc", false), 0);
});

// The bug: a query string / trailing slash / casing let the $5 buy and $0.54
// call routes be mispriced as the $0.001 default while the gateway charged full.
test("estimatePhoneCost is not downgraded by a query string, trailing slash, or casing", () => {
  assert.equal(estimatePhoneCost("phone/numbers/buy?areaCode=415", true), 5.002);
  assert.equal(estimatePhoneCost("phone/numbers/buy/", true), 5.002);
  assert.equal(estimatePhoneCost("Phone/Numbers/Buy", true), 5.002);
  assert.equal(estimatePhoneCost("voice/call?trace=1", true), 0.542);
  assert.equal(estimatePhoneCost("phone/numbers/renew#x", true), 5.002);
});
