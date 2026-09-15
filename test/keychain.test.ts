// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// OS keychain storage for the wallet key. These tests never touch the real
// login keychain — persistKey takes an injectable ops object precisely so the
// dangerous branch (deleting the user's plaintext key file) can be exercised
// against fakes.
//
// The property that matters most here is the read-back guard. `security` exits
// 0 on a write to a locked keychain that later reads back empty, so trusting
// the exit code and unlinking ~/.blockrun/.session would destroy the only copy
// of a key holding real USDC.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  escapeForSecurityInteractive,
  getKeychainMode,
  persistKey,
  keychainStore,
  _resetKeychainWarnings,
  type KeychainOps,
} from "../src/utils/keychain.js";
import { isEvmPrivateKey } from "../src/utils/wallet.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-keychain-"));
const savedMode = process.env.BLOCKRUN_KEYCHAIN;

beforeEach(() => {
  _resetKeychainWarnings();
  delete process.env.BLOCKRUN_KEYCHAIN;
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.BLOCKRUN_KEYCHAIN;
  else process.env.BLOCKRUN_KEYCHAIN = savedMode;
});

process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake keychain: records writes, serves reads, never spawns anything. */
function fakeOps(overrides: Partial<KeychainOps> = {}) {
  const items = new Map<string, string>();
  const calls: string[] = [];
  const ops: KeychainOps = {
    available: () => true,
    store: (account, secret) => {
      calls.push(`store:${account}`);
      items.set(account, secret);
      return true;
    },
    load: (account) => {
      calls.push(`load:${account}`);
      return items.get(account) ?? null;
    },
    ...overrides,
  };
  return { ops, items, calls };
}

function seedKeyFile(name: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, "0x" + "ab".repeat(32), { mode: 0o600 });
  return file;
}

const KEY = "0x" + "ab".repeat(32);

// --- escaping -------------------------------------------------------------

test("escapes backslashes and quotes for `security -i`", () => {
  // `security -i` parses its stdin shell-style. An unescaped quote would end
  // the value early and the keychain would silently store a truncated secret.
  assert.equal(escapeForSecurityInteractive('a"b'), 'a\\"b');
  assert.equal(escapeForSecurityInteractive("a\\b"), "a\\\\b");
  assert.equal(escapeForSecurityInteractive('a\\"b'), 'a\\\\\\"b');
});

test("leaves hex and base58 key characters untouched", () => {
  const base58 = "5KJvsngHeMpm884wtkJNzQGaCErckhHJBGFsvd3VyK5qMZXj3hS";
  assert.equal(escapeForSecurityInteractive(KEY), KEY);
  assert.equal(escapeForSecurityInteractive(base58), base58);
});

// --- mode parsing ---------------------------------------------------------

test("defaults to auto, and treats unknown values as auto", () => {
  assert.equal(getKeychainMode({}), "auto");
  assert.equal(getKeychainMode({ BLOCKRUN_KEYCHAIN: "" }), "auto");
  assert.equal(getKeychainMode({ BLOCKRUN_KEYCHAIN: "banana" }), "auto");
});

test("recognises the off and strict spellings", () => {
  for (const raw of ["off", "0", "false", "no", "OFF", " off "]) {
    assert.equal(getKeychainMode({ BLOCKRUN_KEYCHAIN: raw }), "off", raw);
  }
  assert.equal(getKeychainMode({ BLOCKRUN_KEYCHAIN: "strict" }), "strict");
  assert.equal(getKeychainMode({ BLOCKRUN_KEYCHAIN: "STRICT" }), "strict");
});

// --- persistKey -----------------------------------------------------------

test("off mode never writes to the keychain", () => {
  process.env.BLOCKRUN_KEYCHAIN = "off";
  const file = seedKeyFile("off.key");
  const { ops, calls } = fakeOps();

  persistKey("evm", KEY, file, ops);

  assert.deepEqual(calls, []);
  assert.ok(fs.existsSync(file));
});

test("auto mode mirrors the key but keeps the plaintext file", () => {
  // Other BlockRun tools (the CLI, the SDK, scripts) read ~/.blockrun/.session
  // directly. Removing it by default would break all of them.
  const file = seedKeyFile("auto.key");
  const { ops, items } = fakeOps();

  persistKey("evm", KEY, file, ops);

  assert.equal(items.get("evm"), KEY);
  assert.ok(fs.existsSync(file), "auto mode must not remove the plaintext key");
});

test("no keychain available is a no-op, not a failure", () => {
  const file = seedKeyFile("unavailable.key");
  const { ops, calls } = fakeOps({ available: () => false });

  persistKey("evm", KEY, file, ops);

  assert.deepEqual(calls, []);
  assert.ok(fs.existsSync(file));
});

test("strict mode removes the plaintext file after a matching read-back", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const file = seedKeyFile("strict-ok.key");
  const { ops, items } = fakeOps();

  persistKey("evm", KEY, file, ops);

  assert.equal(items.get("evm"), KEY);
  assert.equal(fs.existsSync(file), false);
});

test("strict mode keeps the file when the read-back disagrees", () => {
  // The load-bearing case: a write that reports success but stores nothing.
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const file = seedKeyFile("strict-mismatch.key");
  const { ops } = fakeOps({ store: () => true, load: () => null });

  persistKey("evm", KEY, file, ops);

  assert.ok(fs.existsSync(file), "must not delete the only copy of the key");
});

test("strict mode keeps the file when the read-back is a different key", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const file = seedKeyFile("strict-wrong.key");
  const { ops } = fakeOps({ store: () => true, load: () => "0x" + "cd".repeat(32) });

  persistKey("evm", KEY, file, ops);

  assert.ok(fs.existsSync(file));
});

test("a failed store never reaches the delete branch", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const file = seedKeyFile("strict-store-fail.key");
  const { ops, calls } = fakeOps({ store: () => false });

  persistKey("evm", KEY, file, ops);

  assert.ok(fs.existsSync(file));
  assert.equal(calls.filter((c) => c.startsWith("load:")).length, 0);
});

// The read-back proved the KEYCHAIN holds `key`. It said nothing about the
// FILE, which was deleted on `existsSync` alone. An env override (a different
// key from BLOCKRUN_WALLET_KEY) reached this branch and the file holding the
// funded wallet went with it. The caller no longer persists env keys, but the
// last line of defence has to hold on its own.
test("strict mode never deletes a plaintext file that holds a DIFFERENT key than the one verified", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const file = seedKeyFile("strict-other-key.key"); // holds KEY
  const OTHER = "0x" + "ef".repeat(32);
  const { ops, items } = fakeOps();

  persistKey("evm", OTHER, file, ops);

  assert.equal(items.get("evm"), OTHER, "the store itself is not the guard");
  assert.ok(fs.existsSync(file), "a file holding a key we did not verify must never be removed");
  assert.equal(fs.readFileSync(file, "utf-8"), KEY);
});

test("strict mode still retires a file whose key matches modulo whitespace and the 0x prefix", () => {
  // The SDK loader trims and 0x-normalises the file, so these are the same key
  // on disk as far as every reader is concerned; keeping them would leave the
  // plaintext copy strict mode exists to remove.
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  for (const onDisk of [`${KEY}\n`, `  ${KEY}  `, KEY.slice(2), `${KEY.slice(2)}\n`]) {
    const file = path.join(tmp, `strict-normalised-${Math.random().toString(36).slice(2)}.key`);
    fs.writeFileSync(file, onDisk, { mode: 0o600 });
    const { ops } = fakeOps();

    persistKey("evm", KEY, file, ops);

    assert.equal(fs.existsSync(file), false, `must retire ${JSON.stringify(onDisk)}`);
  }
});

test("strict mode retires an EMPTY placeholder file — it holds nothing to lose", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const file = path.join(tmp, "strict-empty.key");
  fs.writeFileSync(file, "  \n", { mode: 0o600 });
  const { ops } = fakeOps();

  persistKey("evm", KEY, file, ops);

  assert.equal(fs.existsSync(file), false);
});

test("strict mode keeps a plaintext file it cannot READ — unverifiable is not verified", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const dir = path.join(tmp, "unreadable.key"); // a directory: readFileSync throws EISDIR
  fs.mkdirSync(dir);
  const { ops } = fakeOps();

  persistKey("evm", KEY, dir, ops);

  assert.ok(fs.existsSync(dir), "must not remove what it could not compare");
});

test("strict mode with no plaintext path just stores", () => {
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  const { ops, items } = fakeOps();

  persistKey("solana", KEY, undefined, ops);

  assert.equal(items.get("solana"), KEY);
});

// --- key validation -------------------------------------------------------

test("only well-formed EVM keys are accepted from the keychain", () => {
  // privateKeyToAccount throws on malformed input; a corrupted keychain entry
  // must degrade to the file rather than take every paid tool down.
  assert.ok(isEvmPrivateKey(KEY));
  assert.equal(isEvmPrivateKey("ab".repeat(32)), false, "missing 0x prefix");
  assert.equal(isEvmPrivateKey("0x" + "ab".repeat(31)), false, "too short");
  assert.equal(isEvmPrivateKey("0x" + "zz".repeat(32)), false, "not hex");
  assert.equal(isEvmPrivateKey(""), false);
});

// `security -i` reads one command per line, so a newline in the secret ends the
// command and the remainder parses as another security(1) subcommand. Quoting
// cannot fix that, so the store refuses rather than silently truncating a key.
test("a key containing a line break is refused, not truncated into the keychain", () => {
  for (const bad of ["0xdead\nbeef", "0xdead\r\nbeef", "key\rmore"]) {
    assert.equal(keychainStore("evm-wallet-key", bad), false, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("the escape helper still covers the characters it CAN quote", () => {
  assert.equal(escapeForSecurityInteractive('a"b'), 'a\\"b');
  assert.equal(escapeForSecurityInteractive("a\\b"), "a\\\\b");
});
