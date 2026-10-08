// Run with: npm test
//
// isDefiniteRejection decides whether a failed CLOB submit or relayer batch
// releases its budget/guard. Only a 4xx proves nothing was accepted — and a
// 408 is the one 4xx that does not: a proxy timed out, and the request behind
// it may have landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDefiniteRejection } from "../src/utils/polymarket/transactions.js";

test("4xx on the status property is a definite rejection, except 408", () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    assert.equal(isDefiniteRejection(Object.assign(new Error("x"), { status })), true, `HTTP ${status}`);
  }
  assert.equal(isDefiniteRejection(Object.assign(new Error("x"), { status: 408 })), false);
  for (const status of [500, 502, 504]) {
    assert.equal(isDefiniteRejection(Object.assign(new Error("x"), { status })), false, `HTTP ${status}`);
  }
});

test("4xx in the message text is a definite rejection, except 408", () => {
  assert.equal(isDefiniteRejection(new Error('{"error":"request error","status":400}')), true);
  assert.equal(isDefiniteRejection(new Error("HTTP 403 Forbidden")), true);
  assert.equal(isDefiniteRejection(new Error('{"error":"request error","status":408}')), false);
  assert.equal(isDefiniteRejection(new Error("HTTP 408 Request Timeout")), false);
  assert.equal(isDefiniteRejection(new Error("status code 408")), false);
  assert.equal(isDefiniteRejection(new Error("socket hang up")), false);
});
