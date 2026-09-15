// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The suite's verdict must not depend on whose machine runs it. Ten mocked-
// handler suites (chat-settled-on-error, chat-free-deadline, music-cost, video-
// money-path, realface-money-path, phone, price-behaviour, dex, ...) never mock
// utils/auth.js, and isApiKeyMode() reads BLOCKRUN_API_KEY or ~/.blockrun/.api-key
// from the REAL home. A developer who set up account mode locally ran the Base-
// rail assertions on the account rail: six chat tests went red with account-rail
// text, and the obvious "fix" is to rewrite the expectations — quietly deleting
// the Base assertion those tests exist for. image-cost.test.ts pinned itself
// (temp HOME, no env key) in 0.49.0; nothing pinned the other nine.
//
// test/_setup.ts is preloaded into every test child by the `test` script
// (`--import`), and it is what this file checks. Each assertion is about the
// process this test runs in, not about the setup file's text: if the pin is
// dropped from package.json, or the setup stops clearing a variable, the
// corresponding assertion fails here for the right reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("the suite does not run in the developer's real home directory", () => {
  // os.homedir() honours $HOME (POSIX) / %USERPROFILE% (Windows); os.userInfo()
  // asks the passwd database, which no env var can move. They agree only when
  // nothing pinned HOME.
  let real: string | undefined;
  try { real = os.userInfo().homedir; } catch { /* no passwd entry (some containers) */ }
  const pinned = os.homedir();
  assert.ok(pinned, "os.homedir() must resolve");
  if (real) assert.notEqual(pinned, real, "HOME is the real home — ~/.blockrun/.api-key and .session leak into the suite");
  assert.ok(existsSync(pinned), "the pinned HOME must exist, so code that writes ~/.blockrun can");
  assert.deepEqual(readdirSync(pinned), [], "the pinned HOME must start empty — no key file, no session, no chain preference");
});

test("no BlockRun credential, chain or pricing override reaches the suite from the shell", () => {
  // Every one of these selects a rail, a chain, a key or a price. A suite that
  // wants one sets it itself and restores it; none may inherit it.
  const leaked = Object.keys(process.env).filter((k) =>
    /^(BLOCKRUN_|SOLANA_|POLYMARKET_)/.test(k) || k === "BASE_CHAIN_WALLET_KEY" || k === "TRANSACTION_FEE_USD",
  );
  assert.deepEqual(leaked, [], "these came from the developer's shell, not from a test");
});

test("the key file the account rail looks for is absent under the pinned home", async () => {
  // auth.ts captures the key path from os.homedir() at import time, so this
  // import must happen AFTER the pin — which the --import preload guarantees.
  const { isApiKeyMode } = await import("../src/utils/auth.js");
  assert.equal(existsSync(path.join(os.homedir(), ".blockrun", ".api-key")), false);
  assert.equal(isApiKeyMode(), false, "the suite must start on the wallet rail; account-rail suites mock auth.js explicitly");
});
