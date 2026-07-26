// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatError, isPaymentRejectionError } from "../src/utils/errors.js";

test("model-unavailable (token360) → steers to a sibling model, not a generic blip", () => {
  const msg = "Video generation failed: API error 500: token360 video submit failed: Model 'seedance-2.0-fast' not found or not active for requested provider";
  const out = formatError(msg, { altModels: "bytedance/seedance-2.0" });
  assert.match(out, /temporarily unavailable upstream/);
  assert.match(out, /bytedance\/seedance-2\.0/);
  assert.doesNotMatch(out, /temporary API issue/); // not misclassified as a generic 500
});

test("model-unavailable without altModels → neutral guidance, no model named", () => {
  const out = formatError("token360 video submit failed: Model 'x' not active for requested provider");
  assert.match(out, /temporarily unavailable upstream/);
  assert.doesNotMatch(out, /e\.g\./);
});

test("generic 500 no longer suggests openai/gpt-4o", () => {
  const out = formatError("Image generation failed: API error 500: Internal server error");
  assert.match(out, /temporary API issue/);
  assert.doesNotMatch(out, /gpt-4o/);
});

test("generic 500 with altModels names same-domain alternatives", () => {
  const out = formatError("Image generation failed: API error 500: boom", { altModels: "google/nano-banana, zai/cogview-4" });
  assert.match(out, /temporary API issue/);
  assert.match(out, /google\/nano-banana/);
});

test("payment/402 → funding guidance, not server text", () => {
  const out = formatError("API error 402: insufficient balance");
  assert.match(out, /needs funding/);
  assert.doesNotMatch(out, /temporary API issue/);
});

test("plain validation message gets no canned guidance appended", () => {
  const out = formatError("mask cannot be combined with multiple source images");
  assert.equal(out, "Error: mask cannot be combined with multiple source images");
});

test("post-payment 4xx keeps validation semantics instead of claiming a temporary outage", () => {
  for (const status of [400, 410, 422]) {
    const out = formatError(`API error after payment: ${status}\nBad Request`);
    assert.match(out, new RegExp(String(status)));
    assert.doesNotMatch(out, /temporary API issue/);
    assert.doesNotMatch(out, /needs funding/);
  }
});

test("a pre-payment validation error that says no payment was made is not funding advice", () => {
  const out = formatError("Unsupported endpoint. No payment was made.");
  assert.doesNotMatch(out, /needs funding/);
  assert.doesNotMatch(out, /funding instructions/);
});

test("a dollar amount like $1.4020 is not misread as a 402", () => {
  const out = formatError("charged $1.4020 for the call");
  assert.equal(out, "Error: charged $1.4020 for the call"); // no funding/server text
});

test("the integer part of a decimal amount is not misread as a status code", () => {
  // $402.50 / $500.00 / 402.99 — the '.' that follows the code used to satisfy
  // the old trailing boundary, misclassifying these as 402/500 errors.
  assert.equal(formatError("settled $402.50 for the call"), "Error: settled $402.50 for the call");
  assert.equal(formatError("refunded $500.00 to the wallet"), "Error: refunded $500.00 to the wallet");
  assert.equal(formatError("cost 402.99 usdc"), "Error: cost 402.99 usdc");
});

test("genuine status codes still classify after the regex tightening", () => {
  assert.match(formatError("got 402"), /needs funding/);
  assert.match(formatError("error 500 occurred"), /temporary API issue/);
  assert.match(formatError("API error 402: declined"), /needs funding/);
});

test("a non-402 probe failure is not misclassified as a funding error", () => {
  // The manual-402 tools' catch falls through to formatError(errMsg); the probe
  // throw must carry no 402/payment tokens, so 425/503/400/404 outages get
  // server/plain guidance, never "needs funding".
  for (const status of [425, 503, 400, 404]) {
    const out = formatError(`Music generation failed: Unexpected status ${status} (the endpoint did not return a quote): upstream issue`);
    assert.doesNotMatch(out, /needs funding/, `status ${status} must not say needs funding`);
  }
});

test("isPaymentRejectionError matches settlement failures, not outage status text", () => {
  assert.equal(isPaymentRejectionError("Payment rejected. Check your wallet balance."), true);
  assert.equal(isPaymentRejectionError("insufficient balance"), true);
  // A non-402 probe response is an outage/validation error, NOT a funding issue.
  assert.equal(isPaymentRejectionError('Unexpected response 500 (expected a 402 payment challenge): {"error":"bad gateway"}'), false);
  assert.equal(isPaymentRejectionError("Unexpected response 425 (expected a 402 payment challenge): liveness not finished"), false);
});
