// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Two regressions the 0.49.0 keychain-aware Solana provisioning introduced,
// found by the round-2 audit. Both are about a FUNDED wallet.
//
//  1. Under BLOCKRUN_KEYCHAIN=strict the mint stores the key and deletes
//     .solana-session, so the post-provision getChain() sees neither the file
//     nor a fresh keychain probe (it was memoised before the mint) and answers
//     "base" twice. No .chain-auto pin was written, and the NEXT start found the
//     stored key and moved a funded Base user onto an empty Solana wallet — the
//     0.32.3 failure CHAIN_AUTO_FILE exists to prevent.
//
//  2. The wallet cache is assigned after `await createSolanaWallet()`, so two
//     overlapping callers both minted. 0.49.0 made that reachable from two
//     entry points at once (the blockrun://wallet resource and action:"setup"),
//     and last-writer-wins means one caller is handed a funding address whose
//     key was thrown away.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-sol-prov-"));
const blockrunDir = path.join(home, ".blockrun");
fs.mkdirSync(blockrunDir, { recursive: true });
const saved = { HOME: process.env.HOME, KC: process.env.BLOCKRUN_KEYCHAIN, SOL: process.env.SOLANA_WALLET_KEY, EVM: process.env.BLOCKRUN_WALLET_KEY, API: process.env.BLOCKRUN_API_KEY };
process.env.HOME = home;
delete process.env.SOLANA_WALLET_KEY;
delete process.env.BLOCKRUN_API_KEY;

// A keychain that behaves like the real one in strict mode: persistKey stores
// the secret AND deletes the plaintext file, which is the step that blinds
// getChain() to the wallet that was just created.
let mode = "strict";
let readFails = false;
const store = new Map<string, string>();
mock.module("../src/utils/keychain.js", {
  namedExports: {
    EVM_KEY_ACCOUNT: "evm-wallet-key",
    SOLANA_KEY_ACCOUNT: "solana-wallet-key",
    getKeychainMode: () => mode,
    keychainLoad: (a: string) => store.get(a) ?? null,
    keychainRead: (a: string) =>
      readFails
        ? { status: "error", detail: "security exit 51" }
        : store.has(a)
          ? { status: "found", value: store.get(a) }
          : { status: "absent" },
    persistKey: (account: string, key: string, file?: string) => {
      store.set(account, key);
      if (mode === "strict" && file && fs.existsSync(file)) fs.rmSync(file, { force: true });
    },
  },
});

const wallet = await import("../src/utils/wallet.js");

process.on("exit", () => {
  for (const [k, v] of Object.entries({ HOME: saved.HOME, BLOCKRUN_KEYCHAIN: saved.KC, SOLANA_WALLET_KEY: saved.SOL, BLOCKRUN_WALLET_KEY: saved.EVM, BLOCKRUN_API_KEY: saved.API })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of [".chain", ".chain-auto", ".solana-session", ".session"]) fs.rmSync(path.join(blockrunDir, f), { force: true });
  store.clear();
  mode = "strict";
  readFails = false;
  wallet.resetSolanaKeyCache();
  wallet.resetEvmWalletCache();
  wallet.resetKeychainProbeCache();
});

test("strict mode: provisioning Solana for a Base user writes the continuity pin", async () => {
  // An existing Base-only user: a key file on disk, no chain preference.
  fs.writeFileSync(path.join(blockrunDir, ".session"), "0x" + "11".repeat(32), { mode: 0o600 });
  assert.equal(wallet.getChain(), "base", "precondition: this user is on Base");

  const both = await wallet.ensureBothWallets();
  assert.equal(both.solana.isNew, true, "precondition: the Solana wallet was minted here");

  // The mint stored the key and (strict) deleted the file, so a later probe
  // would see a Solana key and move the user. The pin has to outrank it.
  assert.equal(fs.existsSync(path.join(blockrunDir, ".chain-auto")), true, "continuity pin must be written");
  wallet.resetKeychainProbeCache();
  wallet.resetSolanaKeyCache();
  assert.equal(wallet.getChain(), "base", "a funded Base user must NOT be moved by provisioning");
});

test("a fresh install keeps its Solana default against the Base wallet it just minted", async () => {
  // Both wallets are new. getChain() answered "solana" (the fresh-install
  // default) BEFORE provisioning, and minting the EVM wallet is exactly what
  // would flip it to "base" on the next start, so the pin belongs here too —
  // the direction is just reversed.
  const both = await wallet.ensureBothWallets();
  assert.equal(both.base.isNew, true);
  assert.equal(both.solana.isNew, true);
  assert.equal(fs.readFileSync(path.join(blockrunDir, ".chain-auto"), "utf-8").trim(), "solana");

  wallet.resetKeychainProbeCache();
  wallet.resetSolanaKeyCache();
  wallet.resetEvmWalletCache();
  assert.equal(wallet.getChain(), "solana", "the default the user started on must survive provisioning");
});

test("no pin when nothing was minted — a second run does not rewrite it", async () => {
  fs.writeFileSync(path.join(blockrunDir, ".session"), "0x" + "11".repeat(32), { mode: 0o600 });
  await wallet.ensureBothWallets();
  fs.rmSync(path.join(blockrunDir, ".chain-auto"), { force: true });

  // Everything already exists now, so the second call mints nothing and must
  // not write a pin off a stale probe.
  await wallet.ensureBothWallets();
  assert.equal(fs.existsSync(path.join(blockrunDir, ".chain-auto")), false, "nothing minted, nothing to preserve");
});

test("an explicit chain preference is never overwritten by provisioning", async () => {
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "solana");
  await wallet.ensureBothWallets();
  assert.equal(fs.existsSync(path.join(blockrunDir, ".chain-auto")), false, "an explicit .chain already wins");
  assert.equal(wallet.getChain(), "solana");
});

test("concurrent callers mint ONE Solana wallet, not one each", async () => {
  const [a, b, c] = await Promise.all([
    wallet.ensureSolanaWallet(),
    wallet.ensureSolanaWallet(),
    wallet.ensureSolanaWallet(),
  ]);
  assert.equal(a.address, b.address);
  assert.equal(b.address, c.address);
  // And the address every caller was handed is the key the machine kept.
  assert.equal(store.get("solana-wallet-key"), a.privateKey, "the stored key must be the one callers were shown");
  assert.equal(wallet.resolveSolanaKey(), a.privateKey);
});

test("a failed provisioning is NOT cached — unlocking the keychain and retrying works", async () => {
  // Strict mode with an unreadable keychain and no file: refuse to mint, which
  // is 0.49.0's rule. The rejection must not be memoised by the single-flight
  // promise, or a user who unlocks and retries stays broken until restart.
  readFails = true;
  await assert.rejects(wallet.ensureSolanaWallet(), /Refusing to create a new Solana wallet/);
  await assert.rejects(wallet.ensureSolanaWallet(), /Refusing to create a new Solana wallet/);

  // Unlock it: the very next call in the SAME process must succeed.
  readFails = false;
  const info = await wallet.ensureSolanaWallet();
  assert.equal(info.isNew, true);
  assert.equal(store.get("solana-wallet-key"), info.privateKey);
});
