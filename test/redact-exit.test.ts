// Run with: npm test  (tsx --test)
//
// Round 3 (commit 4e357af) found that only the isError branch of the live
// e2e scripts was redacted — a thrown viem/RPC error, whose message
// interpolates `sender: 0x…` and the funds address, bypassed it and Node
// printed the raw message and stack. -live.ts got process-level handlers;
// -approve.ts and -withdraw.ts got try/catch. -readonly.ts, whose header says
// it "never emits a wallet address", and -verify-approvals.ts got neither:
// `withdrawFunds({})`, `listPositions()` and `runSetup({confirm:false})` all
// reach a Polygon RPC, and an unhandled rejection from any of them printed the
// address in full.
//
// One installer, every script. The behaviour test spawns a child that
// installs it and then dies both ways — a rejection and a throw — carrying a
// wallet address and a tx hash, and asserts what reached stderr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

const WALLET = "0x" + "ab".repeat(20);
const TX = "0x" + "cd".repeat(32);

function dieWith(kind: "reject" | "throw") {
  const program = [
    `import { installRedactedExit } from "${path.join(SCRIPTS, "redact.ts")}";`,
    "installRedactedExit();",
    kind === "reject"
      ? `void Promise.reject(new Error("ContractFunctionExecutionError: sender: ${WALLET} tx ${TX}"));`
      : `setTimeout(() => { throw new Error("RPC 401 for ${WALLET}"); }, 0);`,
    // Keep the loop alive long enough for the rejection to surface.
    "setTimeout(() => {}, 200);",
  ].join("\n");
  return spawnSync(TSX, ["--eval", program], { encoding: "utf8", cwd: ROOT });
}

test("an unhandled rejection exits 1 with the address and hash redacted", () => {
  const r = dieWith("reject");
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr.includes(WALLET), false, `the wallet address reached stderr:\n${r.stderr}`);
  assert.equal(r.stderr.includes(TX), false, `the tx hash reached stderr:\n${r.stderr}`);
  assert.match(r.stderr, /<wallet>/);
  assert.match(r.stderr, /<tx>/);
  assert.match(r.stderr, /"failed":\s*true/);
});

test("an uncaught exception exits 1 with the address redacted", () => {
  const r = dieWith("throw");
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr.includes(WALLET), false, `the wallet address reached stderr:\n${r.stderr}`);
  assert.match(r.stderr, /RPC 401 for <wallet>/);
});

test("every Polymarket e2e script installs the redacted exit before its first await", () => {
  // Static, like scripts-redaction.test.ts's regex sweep: running a live
  // script to prove its error path would need a wallet and a failing RPC.
  const missing: string[] = [];
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.startsWith("polymarket-e2e-")) continue;
    const source = readFileSync(path.join(SCRIPTS, name), "utf8");
    const install = source.search(/installRedactedExit\(\)/);
    const firstAwait = source.search(/\bawait\b/);
    if (install === -1 || (firstAwait > -1 && install > firstAwait)) missing.push(name);
  }
  assert.deepEqual(missing, [], "a script without the installer prints the wallet address on the first RPC failure");
});
