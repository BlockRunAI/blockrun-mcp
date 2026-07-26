// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planNosanaRental,
  buildNosanaDefinition,
  NOSANA_DEFAULT_MARKET,
  NOSANA_DEFAULT_USD_PER_HOUR,
} from "../src/tools/nosana.js";

test("planNosanaRental prices by the hour and defaults to the cheapest market", () => {
  const plan = planNosanaRental({ seconds: 3600 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.market, NOSANA_DEFAULT_MARKET);
  assert.equal(plan.estimateUsd, NOSANA_DEFAULT_USD_PER_HOUR);
});

test("planNosanaRental refuses durations the market will not take", () => {
  for (const seconds of [0, 59, 86401, 1.5, NaN]) {
    const plan = planNosanaRental({ seconds });
    assert.equal(plan.ok, false, `${seconds} should be refused`);
  }
});

test("planNosanaRental stops a caller from overspending before any key is touched", () => {
  const plan = planNosanaRental({ seconds: 86400, maxSpendUsd: 0.1 });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /over the \$0\.1 you allowed/);
});

test("planNosanaRental allows a lease that fits inside the caller's cap", () => {
  const plan = planNosanaRental({ seconds: 600, maxSpendUsd: 0.05 });
  assert.equal(plan.ok, true);
});

test("buildNosanaDefinition produces a container op the market accepts", () => {
  const built = buildNosanaDefinition({ image: "docker.io/library/nginx:alpine", port: 8080 });
  assert.ok("definition" in built);
  if (!("definition" in built)) return;
  assert.deepEqual(built.definition, {
    version: "0.1",
    type: "container",
    ops: [{ type: "container/run", id: "rented", args: { image: "docker.io/library/nginx:alpine", gpu: true, expose: 8080 } }],
  });
});

test("buildNosanaDefinition rejects an array command instead of letting the node die silently", () => {
  const built = buildNosanaDefinition({
    image: "node:20-alpine",
    cmd: ["sh", "-c", "echo hi"] as unknown as string,
  });
  assert.ok("error" in built);
  if (!("error" in built)) return;
  assert.match(built.error, /single shell string/);
});

test("buildNosanaDefinition requires an image", () => {
  const built = buildNosanaDefinition({ image: "" });
  assert.ok("error" in built);
});

test("buildNosanaDefinition omits optional fields rather than sending empty ones", () => {
  const built = buildNosanaDefinition({ image: "alpine" });
  assert.ok("definition" in built);
  if (!("definition" in built)) return;
  const args = (built.definition as { ops: { args: Record<string, unknown> }[] }).ops[0].args;
  assert.equal("expose" in args, false);
  assert.equal("cmd" in args, false);
  assert.equal("env" in args, false);
});
