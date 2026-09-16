// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Round 4b (PM-7): loadState() answered {} for ANY failure — missing file,
// EACCES, a half-written JSON — and fund/withdraw read `.pendingFund` /
// `.pendingWithdraw` off it. A state file that exists but cannot be read for
// the 300s+60s window therefore let a second full authorization be signed,
// and the next saveState merged onto {} and overwrote the evidence. Absent
// is {}; unreadable is a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-pm-state-"));
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".blockrun"), { recursive: true });

const { loadState, saveState, StateUnreadableError } = await import("../src/utils/polymarket/creds.js");

process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));

test("an absent state file is an empty state", () => {
  assert.deepEqual(loadState(), {});
});

test("a state file that exists but is not JSON refuses to load — the guards inside it are not 'nothing pending'", () => {
  const file = path.join(home, ".blockrun", ".polymarket.json");
  saveState({ pendingFund: { amountUsd: 5, deadline: 4_102_444_800 } });
  assert.equal(loadState().pendingFund?.amountUsd, 5);
  fs.writeFileSync(file, '{"pendingFund": {"amountUsd": 5, "dead', { mode: 0o600 }); // interrupted write
  assert.throws(() => loadState(), (err: Error) => err instanceof StateUnreadableError && /double-send guards/.test(err.message));
  assert.throws(() => saveState({ pendingWithdraw: undefined }), StateUnreadableError, "a save must not merge onto {} and erase the file");
  assert.match(fs.readFileSync(file, "utf-8"), /"dead$/, "the evidence is still on disk for a human to read");
});
