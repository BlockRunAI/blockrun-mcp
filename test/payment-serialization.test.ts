import { test } from "node:test";
import assert from "node:assert/strict";
import { serializePaidRequest } from "../src/utils/payment-serialization.js";

test("paid requests execute serially and preserve result order", async () => {
  let active = 0;
  let maxActive = 0;
  const started: number[] = [];

  const run = (id: number) => serializePaidRequest(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return id;
  });

  const results = await Promise.all([run(1), run(2), run(3)]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(maxActive, 1);
});

test("a stalled task does not wedge the queue past the wait cap", async () => {
  // The queue is process-global: without a bounded wait, one hung x402 call
  // would block every paid tool until the server is restarted.
  process.env.BLOCKRUN_PAYMENT_QUEUE_MAX_WAIT_MS = "20";
  try {
    const stalled = serializePaidRequest(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 500)),
    );

    const started = Date.now();
    assert.equal(await serializePaidRequest(async () => "not blocked"), "not blocked");
    assert.ok(Date.now() - started < 400, "waiter should give up on the stalled predecessor");

    assert.equal(await stalled, "slow");
  } finally {
    delete process.env.BLOCKRUN_PAYMENT_QUEUE_MAX_WAIT_MS;
  }
});

test("a rejected paid request releases the next waiter", async () => {
  const first = serializePaidRequest(async () => {
    throw new Error("expected failure");
  });
  const second = serializePaidRequest(async () => "completed");

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "completed");
});
