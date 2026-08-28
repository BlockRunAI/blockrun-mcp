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
