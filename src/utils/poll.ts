// src/utils/poll.ts
// Shared polling arithmetic for the async x402 tools (video, music).
//
// Deliberately NOT in http.ts: every async-tool test replaces that module
// with a network sentinel, so a pure function living there would force each
// of them to stub arithmetic just to import the tool under test.
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
