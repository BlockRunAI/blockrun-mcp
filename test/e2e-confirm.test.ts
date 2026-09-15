// Run with: npm test  (tsx --test)
//
// Three of the Polymarket e2e scripts move real funds the moment they run:
// `e2e:polymarket:live` and `e2e:polymarket:withdraw` submit a $2 withdrawal
// with confirm:true, `e2e:polymarket:approve` signs the unlimited operator
// approval batch. smoke-speech got a --confirm gate under the rule "nothing in
// scripts/ should spend money by being run"; these three were carved out of
// that rule, so an agent checking a redeem path with `npm run
// e2e:polymarket:live` burned a position, bridged $2 and signed approvals with
// no way to say no. Same class as the $0.42 paid-handler incident.
//
// The gate is a pure function (argv and env in, refusal out) so it can be
// proven here without running a script. The wiring assertions at the bottom
// are static for the same reason scripts-spend-gate.test.ts's are: a test
// that ran the script to prove the gate would spend the wallet the day the
// gate regressed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIRM_ENV, CONFIRM_FLAG, requireLiveConfirm } from "../scripts/e2e-confirm.js";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

class Exit extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

function attempt(argv: string[], env: Record<string, string>) {
  const lines: string[] = [];
  let exited: number | undefined;
  try {
    requireLiveConfirm(["withdraw $2.00 USDC from the Polymarket deposit wallet", "sign the unlimited operator approval batch"], {
      argv,
      env,
      stderr: (s) => lines.push(s),
      exit: (code) => { exited = code; throw new Exit(code); },
    });
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
  }
  return { exited, out: lines.join("\n") };
}

test("a bare run refuses with exit 1 and prints exactly what would move", () => {
  const { exited, out } = attempt([], {});
  assert.equal(exited, 1);
  assert.match(out, /withdraw \$2\.00 USDC from the Polymarket deposit wallet/);
  assert.match(out, /sign the unlimited operator approval batch/);
  assert.match(out, /REAL funds/i);
  assert.match(out, new RegExp(CONFIRM_FLAG.replace(/-/g, "\\-")));
  assert.match(out, new RegExp(`${CONFIRM_ENV}=1`));
});

test("--confirm authorises the run", () => {
  const { exited } = attempt([CONFIRM_FLAG], {});
  assert.equal(exited, undefined);
});

test("the env switch authorises the run, and only with the value 1", () => {
  assert.equal(attempt([], { [CONFIRM_ENV]: "1" }).exited, undefined);
  assert.equal(attempt([], { [CONFIRM_ENV]: "true" }).exited, 1, "a truthy-looking string is not the documented switch");
  assert.equal(attempt([], { [CONFIRM_ENV]: "" }).exited, 1);
});

test("BLOCKRUN_SMOKE_CONFIRM (smoke-speech's switch) does NOT authorise a Polymarket script", () => {
  // Different money, different switch: a shell that exported the speech one
  // for a $0.06 smoke run must not have silently pre-authorised a $2 bridge.
  assert.equal(attempt([], { BLOCKRUN_SMOKE_CONFIRM: "1" }).exited, 1);
});

test("the gate names the two switches it accepts", () => {
  assert.equal(CONFIRM_FLAG, "--confirm");
  assert.equal(CONFIRM_ENV, "POLYMARKET_E2E_CONFIRM");
});

// ---- wiring: every script that passes confirm:true gates before its first await ----

const MONEY_MOVING = ["polymarket-e2e-live.ts", "polymarket-e2e-withdraw.ts", "polymarket-e2e-approve.ts"];

test("the set of e2e scripts that pass confirm:true to a utils/ function is known", () => {
  const found: string[] = [];
  for (const name of ["polymarket-e2e-live.ts", "polymarket-e2e-withdraw.ts", "polymarket-e2e-approve.ts", "polymarket-e2e-readonly.ts", "polymarket-e2e-verify-approvals.ts"]) {
    const source = readFileSync(path.join(SCRIPTS, name), "utf8");
    // As an argument (`{ confirm: true }`), not as prose — readonly.ts's header
    // says "Never supplies confirm:true" and must not count.
    if (/confirm:\s*true\s*[,}]/.test(source)) found.push(name);
  }
  assert.deepEqual(found.sort(), [...MONEY_MOVING].sort(), "a new script passing confirm:true moves real funds — gate it with requireLiveConfirm");
});

test("every money-moving e2e script calls requireLiveConfirm before its first await", () => {
  for (const name of MONEY_MOVING) {
    const source = readFileSync(path.join(SCRIPTS, name), "utf8");
    const gate = source.search(/requireLiveConfirm\(/);
    const firstAwait = source.search(/\bawait\b/);
    assert.ok(gate > -1, `${name} has no confirm gate — a bare \`npm run\` moves real funds`);
    assert.ok(firstAwait === -1 || gate < firstAwait, `${name}: the gate must come before the first await, not after money has moved`);
  }
});

test("the read-only scripts do not carry the gate — they must stay runnable as a preflight", () => {
  for (const name of ["polymarket-e2e-readonly.ts", "polymarket-e2e-verify-approvals.ts"]) {
    const source = readFileSync(path.join(SCRIPTS, name), "utf8");
    assert.doesNotMatch(source, /requireLiveConfirm\(/, `${name} never supplies confirm:true; gating it teaches people to type --confirm reflexively`);
  }
});
