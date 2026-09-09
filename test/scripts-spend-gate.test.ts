// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// A script that registers a real tool handler spends real USDC from the
// machine-global wallet the moment it is run. scripts/smoke-speech.ts did
// exactly that on a bare `npx tsx scripts/smoke-speech.ts`, with `limit: null`
// so nothing capped it, under a header advertising "real $0.001 speak" while
// the run ends with a $0.0525 sound effect. This repo has already lost $0.42
// to a paid handler that was run because it looked like a read.
//
// These assertions are STATIC on purpose. A test that proved the gate by
// running the script would charge the wallet the day the gate regressed,
// which is the failure it is supposed to catch.
//
// The polymarket e2e scripts are deliberately not covered: they reach paid
// paths through utils/, not through a tool handler, they are exposed only as
// explicitly named `npm run e2e:polymarket:live`-style targets, and each
// carries its own bound ($2 withdrawal cap, redeem restricted to a position
// worth <= $0.001).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

function scriptsRegisteringTools(): Array<{ name: string; source: string }> {
  const found: Array<{ name: string; source: string }> = [];
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(path.join(SCRIPTS, name), "utf-8");
    // Importing a pure estimator from src/tools is free — verify-prices.ts does
    // exactly that. Calling register…Tool() is what wires up a handler that pays.
    if (/register[A-Za-z]*Tool\s*\(/.test(source)) found.push({ name, source });
  }
  return found;
}

test("the set of scripts that register a paid tool handler is known", () => {
  assert.deepEqual(
    scriptsRegisteringTools().map((s) => s.name).sort(),
    ["smoke-speech.ts"],
    "a new script here spends real USDC when run — give it a confirm gate and a budget cap",
  );
});

test("every such script refuses to spend without an explicit confirmation", () => {
  for (const { name, source } of scriptsRegisteringTools()) {
    assert.match(
      source,
      /--confirm|BLOCKRUN_SMOKE_CONFIRM/,
      `${name} charges a real wallet on a bare run with no way to say no`,
    );
    const gate = source.search(/process\.exit\(1\)/);
    const firstCall = source.search(/await run\(|await handler/);
    assert.ok(gate > -1 && (firstCall === -1 || gate < firstCall), `${name}: the gate must come before the first paid call`);
  }
});

test("every such script caps its own spend", () => {
  for (const { name, source } of scriptsRegisteringTools()) {
    assert.equal(
      /limit:\s*null/.test(source),
      false,
      `${name} runs with an uncapped budget — a moved price or a retry drains the wallet`,
    );
    assert.match(source, /limit:\s*[A-Z_]+|limit:\s*0\.\d+/, `${name} must set a numeric budget limit`);
  }
});
