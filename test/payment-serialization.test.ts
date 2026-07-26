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

test("a rejected paid request releases the next waiter", async () => {
  const first = serializePaidRequest(async () => {
    throw new Error("expected failure");
  });
  const second = serializePaidRequest(async () => "completed");

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "completed");
});
