// src/utils/poll.ts
// Shared polling arithmetic and vocabulary for the async x402 tools (video,
// music) and the helpers that poll on their behalf (utils/solana-402.ts).
//
// Deliberately NOT in http.ts: every async-tool test replaces that module
// with a network sentinel, so a pure function living there would force each
// of them to stub arithmetic just to import the tool under test. Nothing in
// the test tree mocks this module, which is also why the typed error below
// lives here and not in a tool file: video.ts cannot statically import from
// solana-402.ts (Base-only installs must never load the SVM dependencies), and
// a class that is one thing in src and another in a mock is worse than prose.

/**
 * The gateway answered a poll with a terminal job status, and the payment
 * model of that route means nothing was charged (payment-on-completion: the
 * charge only happens on a poll that observes "completed").
 *
 * Typed so a tool's catch can tell "the job failed, uncharged" from "we gave
 * up" without reading the message. The message is not safe to classify: the
 * gateway echoes the upstream failure text verbatim, and MiniMax's is Node's
 * own "The operation was aborted due to timeout" — which isTimeoutError's
 * substring fallback matched, so the Solana give-up branch booked a full
 * render and told the user the charge MAY have gone through for a job the
 * same message said was not charged (audit round 3, C13/C37).
 */
export class JobFailedError extends Error {
  readonly jobId?: string;
  constructor(message: string, opts: { jobId?: string } = {}) {
    super(message);
    this.name = "JobFailedError";
    this.jobId = opts.jobId;
  }
}

// How long the next poll may block, given the budget that is left.
//
// The async x402 tools (video, music) poll a job to completion while holding a
// signed EIP-3009 authorization that dies at a fixed instant. A loop that only
// checks its deadline at the top bounds when a poll may START, not when it
// FINISHES — so an unclamped poll entered just under the wire stays in flight
// for its full timeout, well past the authorization. Settlement happens
// server-side on the poll the gateway answers "completed", so a poll that
// outlives its authorization fails settlement for media that actually
// rendered (blockrun_music shipped exactly that bug once; see CHANGELOG).
//
// Clamping the timeout to the remaining budget pins worst-case wall time at
// the deadline itself. Returns 0 when the budget is spent, which callers treat
// as "stop" rather than issuing a request that cannot finish in time.
export function pollTimeoutFor(
  deadlineMs: number,
  nowMs: number,
  maxTimeoutMs: number,
): number {
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) return 0;
  return Math.min(maxTimeoutMs, remainingMs);
}

/**
 * The instant a poll loop must stop, given two independent clocks.
 *
 * The poll budget is measured from when polling STARTS (after submit), while
 * the signed payment authorization is measured from when it was SIGNED and
 * expires regardless of how long submit took. They are not interchangeable, so
 * the loop has to honour whichever runs out first.
 *
 * Taking the earlier means a slow submit shortens the polling window rather
 * than silently pushing polls past validBefore, and a fast one leaves the whole
 * budget intact.
 */
export function pollDeadline(
  startedAtMs: number,
  budgetMs: number,
  signedAtMs: number,
  authMs: number,
  marginMs: number,
): number {
  return Math.min(startedAtMs + budgetMs, signedAtMs + authMs - marginMs);
}
