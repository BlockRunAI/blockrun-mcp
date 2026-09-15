// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// getChain()'s two keychain probes (step 5: "is there a Solana key?", step 6:
// "is there a Base wallet to strand?") went through keychainLoad(), which
// collapses a read ERROR — locked keychain, the 5s unlock-dialog timeout, an
// ACL denial — into the same null as "absent", and memoised that null for the
// life of the process. Under BLOCKRUN_KEYCHAIN=strict the session files are
// gone, so a Base-only user whose keychain was locked at the first paid call
// was read as a fresh install and routed to Solana; unlocking and retrying in
// the same process changed nothing (memo), the "No Solana wallet yet — run
// setup" remedy fired, and setup minted a Solana wallet that step 5 selected
// on every later start. ensureEvmWallet(), a few lines away, refuses to act on
// the same "error" status. The chain selector has to be at least as careful as
// the provisioner behind it.
//
// Rule: an unreadable keychain is UNKNOWN, never "absent". Unknown is not
// memoised, and on unknown the selector stays on Base — the chain whose
// refusal message says "unlock the keychain", rather than the one whose
// remedy says "run setup".
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-chain-probe-"));
const blockrunDir = path.join(home, ".blockrun");
fs.mkdirSync(blockrunDir, { recursive: true });
const ENV_NAMES = ["HOME", "BLOCKRUN_HOME", "BLOCKRUN_KEYCHAIN", "BLOCKRUN_WALLET_KEY", "BASE_CHAIN_WALLET_KEY", "SOLANA_WALLET_KEY", "BLOCKRUN_API_KEY"] as const;
const saved = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
process.env.HOME = home;
for (const k of ENV_NAMES) if (k !== "HOME") delete process.env[k];

const EVM_KEY = "0x" + "11".repeat(32);
const SOL_KEY = "5KJvsngHeMpm884wtkJNzQGaCErckhHJBGFsvd3VyK5qMZXj3hS";

// The keychain under test: `locked` makes every read fail; otherwise it serves
// whatever `store` holds. Reads are counted so memoisation is observable.
let locked = false;
let reads: string[] = [];
const store = new Map<string, string>();
mock.module("../src/utils/keychain.js", {
  namedExports: {
    EVM_KEY_ACCOUNT: "evm-wallet-key",
    SOLANA_KEY_ACCOUNT: "solana-wallet-key",
    getKeychainMode: () => "strict",
    keychainLoad: (a: string) => {
      reads.push(a);
      return locked ? null : store.get(a) ?? null;
    },
    keychainRead: (a: string) => {
      reads.push(a);
      if (locked) return { status: "error", detail: "security exit 36" };
      return store.has(a) ? { status: "found", value: store.get(a) } : { status: "absent" };
    },
    persistKey: () => {},
  },
});

const wallet = await import("../src/utils/wallet.js");

process.on("exit", () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of [".session", ".solana-session", "wallet.key", ".chain", ".chain-auto"]) {
    fs.rmSync(path.join(blockrunDir, f), { force: true });
  }
  locked = false;
  reads = [];
  store.clear();
  wallet.resetEvmWalletCache();
  wallet.resetSolanaKeyCache();
  wallet.resetKeychainProbeCache();
});

test("strict Base-only user, keychain locked at start: getChain() stays on Base and recovers after unlock", () => {
  store.set("evm-wallet-key", EVM_KEY); // the funded wallet, in the keychain only
  locked = true;

  assert.equal(wallet.getChain(), "base", "an unreadable keychain must not be read as 'no Base wallet here'");

  // The user unlocks the keychain and retries IN THE SAME PROCESS.
  locked = false;
  assert.equal(wallet.getChain(), "base");
  assert.ok(reads.length >= 3, `the failed probes must not have been memoised (reads: ${reads.join(",")})`);
});

test("strict Solana-only user, keychain locked at start: no migration to a Base wallet either, and unlock is honoured", () => {
  store.set("solana-wallet-key", SOL_KEY);
  locked = true;

  const during = wallet.getChain();
  assert.equal(during, "base", "on uncertainty the selector stays where the refusal says 'unlock', not where the remedy says 'setup'");

  locked = false;
  assert.equal(wallet.getChain(), "solana", "the Solana key becomes visible as soon as the keychain opens — nothing was memoised");
});

test("a genuinely absent keychain entry IS memoised — the hot path stays cheap", () => {
  assert.equal(wallet.getChain(), "solana", "fresh install");
  const after = reads.length;
  wallet.getChain();
  wallet.getChain();
  assert.equal(reads.length, after, "definite answers are cached for the process");
});

test("the locked-keychain answer never turns into a 'run setup' remedy on the Solana rail", () => {
  // The destructive step of the original trace: after the selector said
  // "solana", buildSolanaClient() reported "No Solana wallet on this machine
  // yet — run setup". With the selector on Base, the Base path throws its
  // unlock message instead, and nothing suggests minting.
  store.set("evm-wallet-key", EVM_KEY);
  locked = true;

  assert.equal(wallet.getChain(), "base");
  assert.throws(
    () => wallet.getClient(),
    (err: Error) => /Could not read the wallet key from the OS keychain/.test(err.message) && !/run blockrun_wallet action:"setup"/.test(err.message),
  );
});

test("after unlock, a later successful probe replaces the earlier failure (no stale 'unknown' either)", () => {
  store.set("evm-wallet-key", EVM_KEY);
  locked = true;
  assert.equal(wallet.getChain(), "base");

  locked = false;
  assert.equal(wallet.getChain(), "base");
  const after = reads.length;
  wallet.getChain();
  assert.equal(reads.length, after, "once the keychain answered definitively, the answer is memoised");
});
