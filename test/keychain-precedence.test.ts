// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Pins the ONE precedence rule that costs money when it is wrong: an existing
// key file outranks the OS keychain.
//
// Replacing ~/.blockrun/.session is how a wallet is rotated or restored from a
// backup. If the keychain were read first, a stale entry from the previous
// wallet would shadow the new key silently and every payment would be signed by
// a wallet the user believes they replaced. The keychain becomes authoritative
// only once the file is gone, which is exactly what BLOCKRUN_KEYCHAIN=strict
// does.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";

// Two distinct, well-formed EVM keys. FILE_KEY is what the user just put on
// disk; KEYCHAIN_KEY is the stale entry the keychain still remembers.
const FILE_KEY = "0x" + "11".repeat(32);
const KEYCHAIN_KEY = "0x" + "22".repeat(32);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-keychain-prec-"));
fs.mkdirSync(path.join(home, ".blockrun"), { recursive: true });
const realHome = process.env.HOME;
const savedKey = process.env.BLOCKRUN_WALLET_KEY;
process.env.HOME = home;
delete process.env.BLOCKRUN_WALLET_KEY;

// The keychain always answers with the stale key, so any test that resolves to
// KEYCHAIN_KEY proves the file was skipped.
let keychainAnswer: string | null = KEYCHAIN_KEY;
mock.module("../src/utils/keychain.js", {
  namedExports: {
    EVM_KEY_ACCOUNT: "evm-wallet-key",
    SOLANA_KEY_ACCOUNT: "solana-wallet-key",
    getKeychainMode: () => "auto",
    keychainLoad: () => keychainAnswer,
    persistKey: () => {},
  },
});

const { getOrCreateWalletKey } = await import("../src/utils/wallet.js");

process.on("exit", () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (savedKey === undefined) delete process.env.BLOCKRUN_WALLET_KEY;
  else process.env.BLOCKRUN_WALLET_KEY = savedKey;
  fs.rmSync(home, { recursive: true, force: true });
});

test("a key file on disk outranks a stale keychain entry", () => {
  fs.writeFileSync(path.join(home, ".blockrun", ".session"), FILE_KEY, { mode: 0o600 });
  keychainAnswer = KEYCHAIN_KEY;

  const resolved = getOrCreateWalletKey();

  assert.equal(
    resolved,
    FILE_KEY,
    "the wallet the user just wrote to disk must win; the keychain is only its mirror",
  );
  assert.notEqual(
    privateKeyToAccount(resolved).address,
    privateKeyToAccount(KEYCHAIN_KEY as `0x${string}`).address,
    "resolving to the keychain address would sign payments from a wallet the user replaced",
  );
});
