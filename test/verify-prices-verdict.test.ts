// Run with: npm test  (tsx --test)
//
// `npm run verify:prices` is the release gate against silent gateway repricing.
// Until this existed it exited 0 whenever every probe was UNREACHABLE: a
// renamed 402 field, DNS failing, a proxy answering 200 pages — all sixty rows
// print `?`, both catalogues print `?`, and the summary reads "0 under-
// reserving … N unreachable" with exit 0. The release ritual and every agent
// read that as pass, on a run that verified nothing.
//
// The verdict is a pure function of the tallies so it can be pinned here
// without touching the network. Exit codes are distinct on purpose: 1 is a
// CONFIRMED under-reserve (fix the estimator), 2 is "could not verify" (fix the
// probe, or the network, and run again). A caller must be able to tell them
// apart, and neither may read as success.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNREACHABLE_FRACTION, longContextSteps, platformFeePercentOf, verdict, type Tally } from "../scripts/verify-prices-verdict.js";

const clean: Tally = {
  probes: 60, short: 0, solShort: 0, unreachable: 0,
  catalogueGaps: 0, catalogues: 3, catalogueUnreachable: 0,
};

test("a fully reachable, fully covered run passes", () => {
  const v = verdict(clean);
  assert.equal(v.code, 0);
  assert.deepEqual(v.lines, []);
});

test("every probe unreachable is a failure, not a pass with a warning", () => {
  const v = verdict({ ...clean, unreachable: 60 });
  assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /60 of 60 routes could not be verified/);
  assert.match(v.lines.join("\n"), /NOT verified/);
});

test("unreachable above the fraction fails; at or below it only warns", () => {
  const limit = Math.floor(60 * UNREACHABLE_FRACTION);
  assert.equal(verdict({ ...clean, unreachable: limit }).code, 0, "at the threshold a transient miss is tolerated");
  const over = verdict({ ...clean, unreachable: limit + 1 });
  assert.equal(over.code, 2);
  assert.match(over.lines.join("\n"), new RegExp(`${limit + 1} of 60 routes could not be verified`));
});

test("a few unreachable rows still print the 'treat as unknown' line without failing", () => {
  const v = verdict({ ...clean, unreachable: 2 });
  assert.equal(v.code, 0);
  assert.match(v.lines.join("\n"), /2 unreachable route/);
  assert.match(v.lines.join("\n"), /treat them as unknown, not as passing/);
});

test("a catalogue that could not be read fails the run — the sweep is the only check that sees a NEW model", () => {
  const v = verdict({ ...clean, catalogueUnreachable: 1 });
  assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /1 of 3 price catalogues could not be read/);
});

test("a confirmed under-reserve is exit 1 even when the run was also partly unreachable", () => {
  // Both are true; the one that costs money wins the exit code, and the
  // unverified rows are still named so nobody reads a partial run as complete.
  const v = verdict({ ...clean, short: 1, unreachable: 59 });
  assert.equal(v.code, 1);
  const out = v.lines.join("\n");
  assert.match(out, /FAIL: an estimator reserves less than the gateway charges/);
  assert.match(out, /59 of 60 routes could not be verified/);
});

test("a Solana-side under-reserve names the chain", () => {
  const v = verdict({ ...clean, solShort: 2 });
  assert.equal(v.code, 1);
  assert.match(v.lines.join("\n"), /\(on Solana\)/);
});

test("a catalogue gap is exit 1 and counts its models", () => {
  const one = verdict({ ...clean, catalogueGaps: 1 });
  assert.equal(one.code, 1);
  assert.match(one.lines.join("\n"), /1 live chat model disagrees with the price table/);
  const two = verdict({ ...clean, catalogueGaps: 2 });
  assert.match(two.lines.join("\n"), /2 live chat models disagree with the price table/);
});

test("zero probes is not a pass — a probe list that filtered itself empty verified nothing", () => {
  const v = verdict({ ...clean, probes: 0 });
  assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /0 of 0 routes could not be verified|no routes were probed/);
});

// 2026-11-23: the Decisions entry published long_context as a bare object and
// `for (const step of …)` threw, killing the whole release gate.
test("long_context: a list is read as steps, absence as none", () => {
  const steps = [{ threshold: 272000, inclusive: false, input: 0.2, output: 0 }];
  assert.deepEqual(longContextSteps(steps), { steps, malformed: false });
  assert.deepEqual(longContextSteps(undefined), { steps: [], malformed: false });
  assert.deepEqual(longContextSteps(null), { steps: [], malformed: false });
});

test("long_context: a bare object is malformed, not a crash and not silently skipped", () => {
  const r = longContextSteps({ threshold: 272000, input: 0.2 });
  assert.equal(r.malformed, true);
  assert.deepEqual(r.steps, []);
  assert.equal(longContextSteps("272000").malformed, true);
});

// The catalogue's platform fee (blockrun PF-8), read the way ClawRouter#622
// reads it. verify:prices fails a gateway that publishes more than
// CHAT_PLATFORM_FEE_PERCENT, so a misread here is a gate that cannot see a
// fee change.
test("platform fee: nested pricing value first, top-level fallback, else 0", () => {
  assert.equal(platformFeePercentOf({ pricing: { platform_fee_percent: 5 } }), 5); // Solana's shape
  assert.equal(platformFeePercentOf({ platform_fee_percent: 5, pricing: { platform_fee_percent: 5 } }), 5); // Base's
  assert.equal(platformFeePercentOf({ platform_fee_percent: 7 }), 7);
  assert.equal(platformFeePercentOf({ platform_fee_percent: 7, pricing: { platform_fee_percent: 0 } }), 0, "an explicit nested 0 wins");
  assert.equal(platformFeePercentOf({}), 0);
  assert.equal(platformFeePercentOf({ pricing: {} }), 0);
});

test("platform fee: a malformed value falls through rather than reading as a fee", () => {
  for (const bad of ["5", -1, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    assert.equal(platformFeePercentOf({ pricing: { platform_fee_percent: bad } }), 0, String(bad));
    assert.equal(platformFeePercentOf({ platform_fee_percent: 3, pricing: { platform_fee_percent: bad } }), 3, `fallback past ${String(bad)}`);
  }
});
