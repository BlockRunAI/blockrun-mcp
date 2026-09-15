// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// utils/in-flight.ts: the per-call "was a request carrying the payment
// outstanding when this threw?" tracker that replaced the hand-copied
// paidRequestInFlight flags. The three properties pinned here are the three
// the flags got wrong in 0.50.0: a rejection must leave the tracker ARMED
// (the `.finally` shape cleared it before the catch could read it), a response
// that arrived must settle it (a 402 that came back is an answer, not a
// maybe), and an error that proves nothing left the machine must not book.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { BudgetState } from "../src/types.js";

let apiKeyMode = false;
mock.module("../src/utils/auth.js", {
  namedExports: { isApiKeyMode: () => apiKeyMode },
});

const { trackPaidRequest, sendPaid, settleGiveUp } = await import("../src/utils/in-flight.js");

const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };
const fetchFailed = (code: string) => { const e = new TypeError("fetch failed"); (e as Error & { cause: unknown }).cause = { code }; return e; };
const budget = (): BudgetState => ({ limit: null, spent: 0, calls: 0, agents: new Map() });

test("a rejection leaves the tracker armed — the catch can still see it", async () => {
  const paid = trackPaidRequest();
  await assert.rejects(sendPaid(paid, async () => { throw abortError(); }, 0.25));
  assert.equal(paid.outstanding, true);
  assert.equal(paid.quotedUsd, 0.25);
  assert.equal(paid.mayHaveSettled(abortError()), true);
});

test("the `.finally` shape is exactly what must not come back: it clears before the catch runs", async () => {
  // Documents the JS ordering the 0.50.0 flags tripped over, so nobody
  // "simplifies" sendPaid back into it.
  let flag = false;
  try {
    flag = true;
    await Promise.reject(abortError()).finally(() => { flag = false; });
  } catch {
    assert.equal(flag, false, "finally ran before the catch — the flag is useless here");
  }
  const paid = trackPaidRequest();
  try {
    await sendPaid(paid, () => Promise.reject(abortError()));
  } catch (err) {
    assert.equal(paid.mayHaveSettled(err), true, "sendPaid keeps the tracker armed through the rejection");
  }
});

test("a response that arrived settles the tracker, whatever the caller does with it next", async () => {
  const paid = trackPaidRequest();
  const resp = await sendPaid(paid, async () => ({ status: 402 }), 0.25);
  assert.equal(resp.status, 402);
  assert.equal(paid.outstanding, false);
  // The caller now throws "Payment rejected" on that 402 — that is an answer,
  // not a maybe, and must not be booked as a possible settlement.
  assert.equal(paid.mayHaveSettled(new Error("Payment rejected. Check your wallet balance.")), false);
});

test("nothing is 'may have settled' before arm() — the unpaid 402 probe charges nothing", () => {
  const paid = trackPaidRequest();
  assert.equal(paid.mayHaveSettled(abortError()), false);
  assert.equal(settleGiveUp(paid, abortError(), { budget: budget(), estimateUsd: 0.05, what: "X" }), null);
});

test("only a no-response error counts: an API error thrown after a response is not a maybe", () => {
  const paid = trackPaidRequest();
  paid.arm(0.1);
  assert.equal(paid.mayHaveSettled(abortError()), true, "abort after send");
  assert.equal(paid.mayHaveSettled(fetchFailed("ECONNRESET")), true, "socket dropped mid-flight");
  assert.equal(paid.mayHaveSettled(fetchFailed("UND_ERR_HEADERS_TIMEOUT")), true, "undici header timeout");
  assert.equal(paid.mayHaveSettled(new TypeError("fetch failed")), true, "undici transport failure with no cause");
  assert.equal(paid.mayHaveSettled(fetchFailed("ECONNREFUSED")), false, "never connected");
  assert.equal(paid.mayHaveSettled(fetchFailed("ENOTFOUND")), false, "DNS failed");
  assert.equal(paid.mayHaveSettled(new Error("API error 500: {}")), false, "a status is an answer");
  assert.equal(paid.mayHaveSettled(new Error("Budget exceeded. No charge was made.")), false);
});

test("settleGiveUp books the captured quote, else the reserve, and says where to look", () => {
  const b = budget();
  const paid = trackPaidRequest();
  paid.arm(0.3);
  const out = settleGiveUp(paid, abortError(), { budget: b, agentId: undefined, estimateUsd: 0.25, what: "Speech generation" });
  assert.ok(out);
  assert.equal(out.bookedUsd, 0.3, "the quote wins over the reserve");
  assert.ok(Math.abs(b.spent - 0.3) < 1e-9);
  assert.match(out.text, /^Speech generation got no answer/);
  assert.match(out.text, /MAY have gone through/);
  assert.match(out.text, /action:"report"/);
  assert.match(out.text, /\$0\.3000 has been booked/);
  assert.match(out.text, /Error: This operation was aborted$/);
  assert.doesNotMatch(out.text, /No payment was taken/);

  const b2 = budget();
  const noQuote = trackPaidRequest();
  noQuote.arm();
  const out2 = settleGiveUp(noQuote, abortError(), { budget: b2, estimateUsd: 0.25, what: "X", note: "Job stays claimable." });
  assert.ok(out2);
  assert.equal(out2.bookedUsd, 0.25, "no quote: the reserve is booked");
  assert.ok(Math.abs(b2.spent - 0.25) < 1e-9);
  assert.match(out2.text, /Job stays claimable\.\nError:/);
});

test("on the account rail the sentence points at the account activity page, not a wallet", () => {
  apiKeyMode = true;
  try {
    const paid = trackPaidRequest();
    paid.arm();
    const out = settleGiveUp(paid, abortError(), { budget: budget(), estimateUsd: 0.05, what: "Image generation" });
    assert.ok(out);
    assert.match(out.text, /carrying the account key/);
    assert.match(out.text, /dashboard\/activity/);
    assert.match(out.text, /action:"report"/);
    assert.doesNotMatch(out.text, /wallet's recent transactions/);
  } finally {
    apiKeyMode = false;
  }
});

test("a non-positive or unreadable quote is not captured — the reserve stays the fallback", () => {
  const paid = trackPaidRequest();
  paid.arm(null);
  assert.equal(paid.quotedUsd, null);
  paid.arm(0);
  assert.equal(paid.quotedUsd, null);
  paid.arm(NaN);
  assert.equal(paid.quotedUsd, null);
  const b = budget();
  const out = settleGiveUp(paid, abortError(), { budget: b, estimateUsd: 0.012, what: "RealFace enroll" });
  assert.equal(out?.bookedUsd, 0.012);
  assert.ok(Math.abs(b.spent - 0.012) < 1e-9);
});

// Audit round 4: a helper wrapped in sendPaid can inspect the response and
// THROW inside send(), so settle() is never reached although an answer
// arrived — apiKeyPost's AccountApiError (a 4xx/5xx with its body text),
// apiKeyAsyncPost's not_charged terminal failure, a Solana helper's
// "API error N:". The tracker cannot know, so the verdict has to: an error
// that carries a status, a typed job verdict, or the gateway's own uncharged
// marker is an ANSWER, whatever its prose says. Before this, a not_charged
// poll whose upstream text read "The operation was aborted due to timeout"
// booked a whole render on image's account rail and said "MAY have gone
// through" — the C13 shape, on the rail whose tools had just documented
// why it must not happen.
test("an error carrying a status is an answer, not a maybe — even when its body says 'timeout'", async () => {
  const paid = trackPaidRequest();
  const answered = Object.assign(new Error('API error 504: {"error":"Upstream timeout"}'), { statusCode: 504, name: "AccountApiError" });
  await assert.rejects(sendPaid(paid, async () => { throw answered; }, 0.05));
  assert.equal(paid.outstanding, true, "sendPaid itself cannot know a response arrived");
  assert.equal(paid.mayHaveSettled(answered), false, "a statusCode proves the gateway answered");
  const sdkShape = Object.assign(new Error("API error after payment: 502"), { statusCode: 502 });
  assert.equal(paid.mayHaveSettled(sdkShape), false);
  const anthropicShape = Object.assign(new Error("Request timed out"), { status: 408 });
  assert.equal(paid.mayHaveSettled(anthropicShape), false);
});

test("the gateway's own not-charged verdict outranks a timeout in the upstream text", async () => {
  const paid = trackPaidRequest();
  const notCharged = new Error("Upstream generation failed: The operation was aborted due to timeout. No payment was taken.");
  await assert.rejects(sendPaid(paid, async () => { throw notCharged; }, 0.05));
  assert.equal(paid.mayHaveSettled(notCharged), false);
  assert.equal(settleGiveUp(paid, notCharged, { budget: budget(), estimateUsd: 0.05, what: "Image generation" }), null);
});

test("a typed job verdict (JobFailedError / BilledJobError) is never a maybe", async () => {
  const paid = trackPaidRequest();
  for (const name of ["JobFailedError", "BilledJobError"]) {
    const typed = Object.assign(new Error("Upstream generation failed: aborted due to timeout"), { name });
    await assert.rejects(sendPaid(paid, async () => { throw typed; }, 0.05));
    assert.equal(paid.mayHaveSettled(typed), false, name);
  }
});

test("a bare abort while armed is still a maybe — the answered-error rule does not widen into 'never'", async () => {
  const paid = trackPaidRequest();
  await assert.rejects(sendPaid(paid, async () => { throw abortError(); }, 0.05));
  assert.equal(paid.mayHaveSettled(abortError()), true);
  assert.equal(paid.mayHaveSettled(fetchFailed("ECONNRESET")), true);
  assert.equal(paid.mayHaveSettled(fetchFailed("ECONNREFUSED")), false);
});
