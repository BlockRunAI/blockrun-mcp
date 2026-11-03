// Run with: npm test  (tsx --test)
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { keyStorageNote } from "../src/tools/wallet.js";

// Audit r5: setup told every Solana user the key was in ~/.blockrun/.solana-session.
// Under BLOCKRUN_KEYCHAIN=strict that file is deleted (the key lives only in
// the OS keychain), and with SOLANA_WALLET_KEY it never existed. Pure string
// logic over env: no wallet is read or created here.
const KEYS = ["SOLANA_WALLET_KEY", "BLOCKRUN_WALLET_KEY", "BASE_CHAIN_WALLET_KEY", "BLOCKRUN_KEYCHAIN"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const clear = () => { for (const k of KEYS) delete process.env[k]; };

test("default: names the file", () => {
  clear();
  assert.match(keyStorageNote("solana"), /~\/\.blockrun\/\.solana-session/);
  assert.match(keyStorageNote("evm"), /~\/\.blockrun\/\.session/);
});

test("strict keychain: says the key is only in the OS keychain, never names the deleted file", () => {
  clear();
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  for (const kind of ["solana", "evm"] as const) {
    const note = keyStorageNote(kind);
    assert.match(note, /OS keychain only/);
    assert.doesNotMatch(note, /stored at ~\/\.blockrun/);
  }
});

test("an env-supplied key is named as such and outranks the keychain mode", () => {
  clear();
  process.env.BLOCKRUN_KEYCHAIN = "strict";
  process.env.SOLANA_WALLET_KEY = "x";
  assert.match(keyStorageNote("solana"), /supplied by SOLANA_WALLET_KEY/);
  process.env.BASE_CHAIN_WALLET_KEY = "y";
  assert.match(keyStorageNote("evm"), /supplied by BASE_CHAIN_WALLET_KEY/);
  process.env.BLOCKRUN_WALLET_KEY = "z";
  assert.match(keyStorageNote("evm"), /supplied by BLOCKRUN_WALLET_KEY/);
});
