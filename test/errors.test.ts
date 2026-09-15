// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractErrorMessage, formatError, hasLabelledServerStatus, isPaymentRejectionError } from "../src/utils/errors.js";

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

test("post-payment 5xx is never an empty wallet, even without a parseable status", () => {
  // Since audit round 3 (C38) an UNMARKED post-payment 5xx is hedged ("the
  // charge MAY have gone through") rather than sold as an outage to retry;
  // the per-rail wording is pinned in errors-rails.test.ts. What this test
  // guards is the older mistake: the "payment" keyword reading as "fund".
  for (const msg of [
    "API error after payment: 500 Internal Server Error",
    "API error after payment: 502 Bad Gateway",
    "API error after payment: upstream provider unavailable",
  ]) {
    const out = formatError(msg);
    assert.match(out, /MAY have gone through/, msg);
    assert.doesNotMatch(out, /needs funding/, msg);
  }
  // A 5xx with no payment attached is still the plain outage.
  const out = formatError("Request failed with status code 503");
  assert.match(out, /temporary API issue/);
  assert.doesNotMatch(out, /needs funding|MAY have gone through/);
});

test("an incidental 5xx-shaped number is not sold to the user as an outage", () => {
  // LLM errors are full of bare 512s; "wait it out" hides a real validation bug.
  for (const msg of [
    "Model rejected: max_tokens 512 is above the limit",
    "embedding dimension 512 not supported",
  ]) {
    assert.equal(formatError(msg), `Error: ${msg}`, msg);
  }
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

// --- blockrun-mcp#132: the gateway said "payment NOT charged"; the tool said "after payment" ---

class FakeAPIError extends Error {
  constructor(message: string, public statusCode: number, public response: unknown) {
    super(message);
  }
}

test("extractErrorMessage surfaces the SDK's `detail` field (blockrun-llm-ts#39)", () => {
  // Post-#39 sanitizer output: `message` is the gateway's top-level `error`,
  // `detail` is the gateway's own `message` — the cause + settlement status.
  const err = new FakeAPIError("API error after payment: 502", 502, {
    message: "Upstream provider error",
    detail: "Predexon 500: An unexpected error occurred (payment NOT charged)",
  });
  const msg = extractErrorMessage(err);
  assert.match(msg, /Upstream provider error/);
  assert.match(msg, /payment NOT charged/);
  // …and formatError says so in its OWN words. Only the guidance after the echoed
  // message can prove that: the input already contains "payment NOT charged", so
  // a whole-output /not charged/ match — or a doesNotMatch(/needs funding/) on a
  // 5xx, whose branch is tested before the funding one — can never fail. This
  // is the generic path every tool without a bespoke formatter goes through.
  const out = formatError(msg);
  const guidance = out.slice(out.indexOf("\n\n"));
  assert.match(guidance, /The gateway reported that this call was not settled — nothing was charged\./);
  // The outage advice stays — an uncharged upstream 5xx is reasonable to retry.
  assert.match(guidance, /temporary API issue/);
  assert.doesNotMatch(guidance, /needs funding/);
});

test("a post-payment 5xx WITHOUT the gateway's uncharged marker never claims nothing was charged", () => {
  // The formatter must never invent a settlement claim in EITHER direction:
  // only the gateway's own marker earns "nothing was charged", and the
  // post-payment hedge says MAY, never "the charge stands".
  for (const msg of [
    "API error after payment: 502\nRequest failed",
    "API error after payment: 500 Internal Server Error",
  ]) {
    const out = formatError(msg);
    assert.match(out, /MAY have gone through/, msg);
    assert.doesNotMatch(out, /nothing was charged|not settled|charge stands|Try again in a few minutes/, msg);
  }
  const out = formatError("error 500 occurred");
  assert.match(out, /temporary API issue/);
  assert.doesNotMatch(out, /nothing was charged|not settled/);
});

test("extractErrorMessage does not repeat a detail identical to the message", () => {
  const err = new FakeAPIError("API error: 400", 400, { message: "Bad request", detail: "Bad request" });
  assert.equal(extractErrorMessage(err).match(/Bad request/g)?.length, 1);
});

test("extractErrorMessage is unchanged for the pre-#39 shape (message + code only)", () => {
  const err = new FakeAPIError("API error after payment: 502", 502, { message: "Request failed", code: "x" });
  assert.equal(extractErrorMessage(err), "API error after payment: 502\nRequest failed");
});

test("a 501 is 'not served', not a temporary outage to retry", () => {
  // Live 2026-09-08: GET /v1/stocks/us/price/AAPL → 501 before any 402.
  const out = formatError("API error: 501\nUS Stock price is not available");
  assert.match(out, /does not serve this endpoint/);
  assert.match(out, /nothing was charged/);
  assert.doesNotMatch(out, /temporary API issue/);
  assert.doesNotMatch(out, /needs funding/);
});

test("a 501-shaped number inside a message is not read as a status", () => {
  const out = formatError("API error 500: batch of 501 items rejected");
  assert.match(out, /temporary API issue/);
  assert.doesNotMatch(out, /does not serve this endpoint/);
});

test("a post-payment 501 does not claim nothing was charged", () => {
  const out = formatError("API error after payment: 501\nRequest failed");
  assert.match(out, /does not serve this endpoint/);
  assert.doesNotMatch(out, /nothing was charged/);
  assert.match(out, /whether this call settled/);
  assert.doesNotMatch(out, /temporary API issue/);
});

test("the SDK's post-payment prefix counts as a labelled status", () => {
  // "API error after payment: 502" — the word before the number is "payment".
  // It classifies as a 5xx (hasLabelledServerStatus), and because the payment
  // had been sent it is the hedged branch, not the plain outage and not
  // funding advice.
  assert.equal(hasLabelledServerStatus("API error after payment: 502\nRequest failed"), true);
  const out = formatError("API error after payment: 502\nRequest failed");
  assert.match(out, /MAY have gone through/);
  assert.doesNotMatch(out, /needs funding/);
});

// --- the account rail's own error shape (audit round 2) ---
//
// @blockrun/llm's account client writes `BlockRun account API error: ${status}.${hint}`
// — with a sentence-ending period. The status boundary excluded a dot outright
// (so "$402.50" could not read as a status), which meant every account-rail
// status fell through unclassified: the identical wallet-rail message got
// guidance, the account one got none.

test("an account-rail 5xx is classified like the wallet rail's", () => {
  for (const msg of [
    "BlockRun account API error: 502.",
    "BlockRun account API error: 503. Retry-After: 30",
    "BlockRun account API error: 500. Check https://user.blockrun.ai/dashboard/activity",
  ]) {
    const out = formatError(msg);
    assert.match(out, /temporary API issue/, msg);
    assert.doesNotMatch(out, /needs funding/, msg);
  }
});

test("an account-rail 402 is classified as a payment problem, not an outage", () => {
  // This file runs on whatever rail the machine is on; the rail-specific
  // remedy (credit top-up vs wallet funding) is pinned under a mocked auth.js
  // in errors-rails.test.ts. The earlier version of this test matched
  // /Insufficient/, a word the echoed input already contains, so it could not
  // fail either way (C28).
  const out = formatError("BlockRun account API error: 402. Insufficient credit");
  const guidance = out.slice(out.indexOf("\n\n"));
  assert.match(guidance, /needs funding|out of credit/);
  assert.doesNotMatch(out, /temporary API issue/);
});

test("an account-rail 501 is 'not served', and says nothing was charged", () => {
  const out = formatError("BlockRun account API error: 501.");
  assert.match(out, /does not serve this endpoint/);
  assert.match(out, /nothing was charged/);
});

test("a decimal amount is STILL not a status code after the boundary change", () => {
  // The whole reason a dot was excluded. A dot followed by a digit is a decimal
  // point; a dot not followed by one is punctuation.
  for (const msg of ["Charged $402.50 for this render", "cost was $1.4020 total", "price 500.25 usd"]) {
    const out = formatError(msg);
    assert.doesNotMatch(out, /temporary API issue/, msg);
    assert.doesNotMatch(out, /does not serve this endpoint/, msg);
    assert.doesNotMatch(out, /wallet needs funding/, msg);
  }
});

test("hasLabelledServerStatus agrees with formatError on the dotted shape", () => {
  assert.equal(hasLabelledServerStatus("BlockRun account API error: 502."), true);
  assert.equal(hasLabelledServerStatus("error 500. something"), true);
  assert.equal(hasLabelledServerStatus("charged $500.25"), false);
  assert.equal(hasLabelledServerStatus("batch of 501 items"), false);
});

// --- "nothing was charged" must never carry "fund your wallet" (round 2) ---
//
// explicitlyUncharged gated only the `payment` keyword sub-clause, so a bare
// 402, "balance" or "insufficient" still earned the funding footer. Two of this
// repo's own messages did exactly that.

test("the video tool's unreadable-quote refusal does not tell a funded wallet to top up", () => {
  const out = formatError(
    "The gateway's 402 quote carried an unreadable amount (\"garbage\"). Refusing to sign a payment " +
    "for an amount that could not be validated — no charge was made. This is a gateway fault; retry, " +
    "and report it if it persists.",
  );
  assert.doesNotMatch(out, /needs funding/);
  assert.doesNotMatch(out, /Send USDC/);
});

test("RealFace's 'No payment taken' is recognised as uncharged", () => {
  const out = formatError("Portrait rejected — the image did not pass the liveness check. No payment taken.");
  assert.doesNotMatch(out, /needs funding/);
});

test("the quote guard's own refusal does not read as a funding problem", () => {
  const out = formatError(
    "The gateway quoted $1.1355 for azure/sora-2 video, but this tool expected about $0.4220 " +
    "(2.7x the published rate). Refusing to sign it — no charge was made.",
  );
  assert.doesNotMatch(out, /needs funding/);
});

test("a genuine empty wallet STILL gets funding advice", () => {
  for (const msg of [
    "API error: 402 Payment Required",
    "Payment rejected: insufficient balance",
    "insufficient funds for this call",
  ]) {
    assert.match(formatError(msg), /needs funding|Send USDC/, msg);
  }
});
