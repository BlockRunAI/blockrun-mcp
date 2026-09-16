// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pollTimeoutFor } from "../src/utils/poll.js";

// pollTimeoutFor is the shared clamp behind blockrun_video and blockrun_music.
// Both hold a signed EIP-3009 authorization that dies at a fixed instant while
// polling a job to completion, and a loop that checks its deadline only at the
// top bounds when a poll may START, not when it finishes.
test("pollTimeoutFor never lets a poll finish past the deadline", () => {
  const MAX = 90_000;
  const start = 1_000_000;
  const deadline = start + 540_000;

  // Plenty of budget left: the full poll timeout.
  assert.equal(pollTimeoutFor(deadline, start, MAX), MAX);
  assert.equal(pollTimeoutFor(deadline, deadline - MAX, MAX), MAX);

  // The case this exists for: a poll entered just under the wire. Unclamped it
  // got the full timeout and stayed in flight long past the deadline.
  assert.equal(pollTimeoutFor(deadline, deadline - 1_000, MAX), 1_000);
  assert.equal(pollTimeoutFor(deadline, deadline - 1, MAX), 1);

  // Budget spent -> 0, which callers treat as "stop" rather than issuing a
  // request that cannot finish in time.
  assert.equal(pollTimeoutFor(deadline, deadline, MAX), 0);
  assert.equal(pollTimeoutFor(deadline, deadline + 5_000, MAX), 0);

  // The property, swept across the whole window: a poll started at any
  // reachable instant finishes on or before the deadline.
  for (let elapsed = 0; elapsed <= 540_000; elapsed += 4_999) {
    const now = start + elapsed;
    assert.ok(
      now + pollTimeoutFor(deadline, now, MAX) <= deadline,
      `poll started at +${elapsed}ms would finish past the deadline`,
    );
  }
});

// JobFailedError is the typed "the gateway answered the poll with a terminal
// status and nothing was charged" the three async loops (Base video, Base
// music, the Solana helper) throw, so a tool's catch can recognise it without
// reading prose. The prose mattered: MiniMax's own failure text is "The
// operation was aborted due to timeout", which isTimeoutError's substring
// fallback matched, and the Solana give-up branch then booked a full render
// for a job the gateway had just said was not charged (audit round 3, C13).
test("JobFailedError is a distinct class that carries the job id and stays a plain Error otherwise", async () => {
  const { JobFailedError } = await import("../src/utils/poll.js");
  const err = new JobFailedError("Video generation failed upstream: The operation was aborted due to timeout. No payment was taken.", { jobId: "vid_1" });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof JobFailedError);
  assert.equal(err.name, "JobFailedError");
  assert.equal(err.jobId, "vid_1");
  assert.match(err.message, /No payment was taken/);
  // instanceof, not name: a plain Error whose message merely looks alike is
  // not a gateway verdict.
  assert.equal(new Error(err.message) instanceof JobFailedError, false);
  assert.equal(new JobFailedError("x").jobId, undefined);
});
