// Run with: npm test  (tsx --test)
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyStorageNote } from "../src/tools/wallet.js";

// Audit r5: setup told every Solana user the key was in ~/.blockrun/.solana-session.
// Under BLOCKRUN_KEYCHAIN=strict that file is usually deleted, and with
// SOLANA_WALLET_KEY it never existed. Regression r5: the first fix trusted the
// MODE, but persistKey keeps the file whenever it cannot prove the keychain
// copy (Windows, no secret-tool, a failed read-back) and never touches the
// legacy wallet.key. The note must follow what is on disk. A temp HOME only:
// no real key file is read, and nothing here creates a wallet.
const KEYS = ["SOLANA_WALLET_KEY", "BLOCKRUN_WALLET_KEY", "BASE_CHAIN_WALLET_KEY", "BLOCKRUN_KEYCHAIN", "HOME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let home = "";
const put = (name: string, body = "secret\n") => fs.writeFileSync(path.join(home, ".blockrun", name), body);

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "br-keynote-"));
  fs.mkdirSync(path.join(home, ".blockrun"));
  process.env.HOME = home;
  assert.equal(os.homedir(), home, "os.homedir() must follow HOME for this test to be hermetic");
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("a key file on disk is named, in any mode", () => {
  put(".solana-session");
  put(".session");
  for (const mode of [undefined, "strict"]) {
    if (mode) process.env.BLOCKRUN_KEYCHAIN = mode;
    assert.match(keyStorageNote("solana"), /stored at ~\/\.blockrun\/\.solana-session/, `mode=${mode}`);
    assert.match(keyStorageNote("evm"), /stored at ~\/\.blockrun\/\.session/, `mode=${mode}`);
    assert.doesNotMatch(keyStorageNote("solana"), /keychain only/, `mode=${mode}`);
  }
});

test("strict mode with the file still on disk (persistKey kept it) names the file, not the keychain", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  put(".solana-session");
  assert.match(keyStorageNote("solana"), /\.solana-session/);
  assert.doesNotMatch(keyStorageNote("solana"), /keychain only/);
});

test("the legacy wallet.key is named: strict mode never retires it", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  put("wallet.key");
  assert.match(keyStorageNote("evm"), /~\/\.blockrun\/wallet\.key/);
  assert.doesNotMatch(keyStorageNote("evm"), /keychain only/);
});

test("an empty key file does not count as holding the key", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  put(".solana-session", "  \n");
  assert.match(keyStorageNote("solana"), /OS keychain only/);
});

test("strict mode with no plaintext file left: keychain only", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  for (const kind of ["solana", "evm"] as const) {
    assert.match(keyStorageNote(kind), /OS keychain only/);
    assert.doesNotMatch(keyStorageNote(kind), /stored at ~\/\.blockrun/);
  }
});

test("an env-supplied key is named as such and outranks everything", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  put(".solana-session");
  process.env.SOLANA_WALLET_KEY = "x";
  assert.match(keyStorageNote("solana"), /supplied by SOLANA_WALLET_KEY/);
  process.env.BASE_CHAIN_WALLET_KEY = "y";
  assert.match(keyStorageNote("evm"), /supplied by BASE_CHAIN_WALLET_KEY/);
  process.env.BLOCKRUN_WALLET_KEY = "z";
  assert.match(keyStorageNote("evm"), /supplied by BLOCKRUN_WALLET_KEY/);
});
