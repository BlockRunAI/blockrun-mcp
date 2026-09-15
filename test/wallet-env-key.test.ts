// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// An env-provided key is a SIGNER OVERRIDE, not a wallet the machine owns.
//
// The README, the debug skill and the SDK's own migration notice all present
// BLOCKRUN_WALLET_KEY as reversible: "for a single run without changing
// anything", "unset the override". ensureEvmWallet() nevertheless fed whatever
// getOrCreateWallet() returned into persistKey(), which stores with `-U` —
// overwriting the keychain entry that held the funded wallet — and, under
// BLOCKRUN_KEYCHAIN=strict, deleted ~/.blockrun/.session on the strength of a
// read-back that only proved the keychain held the ENV key. One run with a
// different key in the environment and the funded wallet (also the Polymarket
// deposit signer) was in no store at all, behind a "moved the wallet key into
// the OS keychain" success message. The Solana rail already returned before
// persisting SOLANA_WALLET_KEY; Base did not. Rail parity, in the direction
// that destroys money.
//
// Second gap, same root: the SDK loader honours BLOCKRUN_WALLET_KEY OR
// BASE_CHAIN_WALLET_KEY and falls back to the legacy ~/.blockrun/wallet.key,
// but the two questions the MCP asks in front of it (the keychain gate and the
// Solana-first migration guard) knew only BLOCKRUN_WALLET_KEY and .session. A
// user configured the SDK-documented way had a stale keychain entry win over
// the key they had just rotated to, and was read as "no Base wallet" by
// getChain().
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const ENV_KEY = "0x" + "aa".repeat(32);
const STALE_KEYCHAIN_KEY = "0x" + "bb".repeat(32);
const LEGACY_KEY = "0x" + "cc".repeat(32);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-env-key-"));
const blockrunDir = path.join(home, ".blockrun");
fs.mkdirSync(blockrunDir, { recursive: true });
const ENV_NAMES = ["HOME", "BLOCKRUN_HOME", "BLOCKRUN_KEYCHAIN", "BLOCKRUN_WALLET_KEY", "BASE_CHAIN_WALLET_KEY", "SOLANA_WALLET_KEY", "BLOCKRUN_API_KEY"] as const;
const saved = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
process.env.HOME = home;
for (const k of ENV_NAMES) if (k !== "HOME") delete process.env[k];

// A keychain that already holds a DIFFERENT funded key on both rails. Any test
// that resolves to it proves the env override was ignored; any persistKey call
// proves the override was about to be written over it.
let mode = "auto";
const store = new Map<string, string>([["evm-wallet-key", STALE_KEYCHAIN_KEY]]);
const persisted: Array<{ account: string; key: string; file?: string }> = [];
mock.module("../src/utils/keychain.js", {
  namedExports: {
    EVM_KEY_ACCOUNT: "evm-wallet-key",
    SOLANA_KEY_ACCOUNT: "solana-wallet-key",
    getKeychainMode: () => mode,
    keychainLoad: (a: string) => store.get(a) ?? null,
    keychainRead: (a: string) => (store.has(a) ? { status: "found", value: store.get(a) } : { status: "absent" }),
    persistKey: (account: string, key: string, file?: string) => {
      persisted.push({ account, key, file });
    },
  },
});

const wallet = await import("../src/utils/wallet.js");
const { createSolanaWallet, solanaPublicKey } = await import("@blockrun/llm");

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
  for (const k of ["BLOCKRUN_WALLET_KEY", "BASE_CHAIN_WALLET_KEY", "SOLANA_WALLET_KEY"]) delete process.env[k];
  mode = "auto";
  persisted.length = 0;
  store.clear();
  store.set("evm-wallet-key", STALE_KEYCHAIN_KEY);
  wallet.resetEvmWalletCache();
  wallet.resetSolanaKeyCache();
  wallet.resetKeychainProbeCache();
});

// --- C1: an env key is never persisted ------------------------------------

test("BLOCKRUN_WALLET_KEY is used for signing but never written to the keychain", () => {
  process.env.BLOCKRUN_WALLET_KEY = ENV_KEY;

  assert.equal(wallet.getOrCreateWalletKey(), ENV_KEY, "the env override must be the signer");
  assert.deepEqual(persisted, [], "an env override must not overwrite the keychain's funded key with -U");
  assert.equal(store.get("evm-wallet-key"), STALE_KEYCHAIN_KEY, "the funded key survives the run");
});

test("strict mode with an env override never retires the .session that holds the funded key", () => {
  // The first strict run: keychain W1, file W1, env W2. persistKey would have
  // stored W2 over W1 and — read-back W2 === W2 — deleted the file holding W1.
  mode = "strict";
  const session = path.join(blockrunDir, ".session");
  fs.writeFileSync(session, STALE_KEYCHAIN_KEY, { mode: 0o600 });
  process.env.BLOCKRUN_WALLET_KEY = ENV_KEY;

  assert.equal(wallet.getOrCreateWalletKey(), ENV_KEY);
  assert.deepEqual(persisted, [], "nothing may be persisted from an env override, in any mode");
  assert.equal(fs.readFileSync(session, "utf-8"), STALE_KEYCHAIN_KEY, "the file holding the funded key must survive");
});

test("unsetting the override brings the previous wallet back — the override was reversible", () => {
  process.env.BLOCKRUN_WALLET_KEY = ENV_KEY;
  assert.equal(wallet.getOrCreateWalletKey(), ENV_KEY);

  delete process.env.BLOCKRUN_WALLET_KEY;
  wallet.resetEvmWalletCache();
  assert.equal(wallet.getOrCreateWalletKey(), STALE_KEYCHAIN_KEY, "the keychain still holds the wallet the user had before the override");
});

// --- C34: the gate asks the loader's question -----------------------------

test("BASE_CHAIN_WALLET_KEY (the SDK's alias) outranks a stale keychain entry and is not persisted", () => {
  process.env.BASE_CHAIN_WALLET_KEY = ENV_KEY;

  const resolved = wallet.getOrCreateWalletKey();
  assert.equal(resolved, ENV_KEY, "the SDK resolves this variable; the MCP's gate must not read the keychain ahead of it");
  assert.notEqual(
    privateKeyToAccount(resolved).address,
    privateKeyToAccount(STALE_KEYCHAIN_KEY as `0x${string}`).address,
    "signing with the keychain's key here is the stale-entry shadowing the precedence comment says it prevents",
  );
  assert.deepEqual(persisted, []);
});

test("a rotated BASE_CHAIN_WALLET_KEY takes effect on the next run instead of the keychain's mirror", () => {
  // The self-perpetuating form: the first run mirrored W1; the user rotates to
  // W2; the gate must not hand W1 back from the keychain.
  process.env.BASE_CHAIN_WALLET_KEY = STALE_KEYCHAIN_KEY;
  assert.equal(wallet.getOrCreateWalletKey(), STALE_KEYCHAIN_KEY);

  process.env.BASE_CHAIN_WALLET_KEY = ENV_KEY;
  wallet.resetEvmWalletCache();
  assert.equal(wallet.getOrCreateWalletKey(), ENV_KEY, "rotation must not be silently undone");
});

test("an env key without the 0x prefix is normalised the way the SDK normalises it", () => {
  process.env.BLOCKRUN_WALLET_KEY = ENV_KEY.slice(2);
  assert.equal(wallet.getOrCreateWalletKey(), ENV_KEY);
});

test("the legacy ~/.blockrun/wallet.key outranks the keychain, exactly as the SDK loader ranks it", () => {
  fs.writeFileSync(path.join(blockrunDir, "wallet.key"), LEGACY_KEY + "\n", { mode: 0o600 });

  assert.equal(wallet.getOrCreateWalletKey(), LEGACY_KEY, "a key file the SDK would load must not be shadowed by the keychain");
});

test("getChain() recognises a Base wallet configured through BASE_CHAIN_WALLET_KEY or wallet.key", () => {
  // Keychain off: the probe must not rescue the guard here, because on Windows,
  // keychain-less Linux and the very first run there is no mirror to find.
  mode = "off";

  process.env.BASE_CHAIN_WALLET_KEY = ENV_KEY;
  assert.equal(wallet.getChain(), "base", "a configured Base key is not a fresh install");
  delete process.env.BASE_CHAIN_WALLET_KEY;

  fs.writeFileSync(path.join(blockrunDir, "wallet.key"), LEGACY_KEY, { mode: 0o600 });
  assert.equal(wallet.getChain(), "base", "a legacy key file is a funded Base wallet the default must not strand");
});

// --- rail parity: every env override is treated the same way --------------

test("rail parity: no env override is ever persisted, on either wallet rail", async () => {
  const solana = await createSolanaWallet();
  const rows: Array<{ rail: string; env: string; key: string; resolve: () => Promise<string> }> = [
    { rail: "base", env: "BLOCKRUN_WALLET_KEY", key: ENV_KEY, resolve: async () => wallet.getOrCreateWalletKey() },
    { rail: "base", env: "BASE_CHAIN_WALLET_KEY", key: ENV_KEY, resolve: async () => wallet.getOrCreateWalletKey() },
    { rail: "solana", env: "SOLANA_WALLET_KEY", key: solana.privateKey, resolve: async () => (await wallet.ensureSolanaWallet()).privateKey },
  ];

  for (const row of rows) {
    for (const rowMode of ["auto", "strict"]) {
      mode = rowMode;
      persisted.length = 0;
      wallet.resetEvmWalletCache();
      wallet.resetSolanaKeyCache();
      process.env[row.env] = row.key;

      assert.equal(await row.resolve(), row.key, `${row.rail}/${row.env}/${rowMode}: the override must be the signer`);
      assert.deepEqual(persisted, [], `${row.rail}/${row.env}/${rowMode}: an override must never reach the keychain`);

      delete process.env[row.env];
    }
  }

  // And the Solana address the override maps to is the one reported.
  process.env.SOLANA_WALLET_KEY = solana.privateKey;
  wallet.resetSolanaKeyCache();
  assert.equal((await wallet.ensureSolanaWallet()).address, await solanaPublicKey(solana.privateKey));
});

test("rail parity: a key that came from a FILE is still mirrored on both rails (the fix did not disable auto mode)", async () => {
  const solana = await createSolanaWallet();
  fs.writeFileSync(path.join(blockrunDir, ".session"), ENV_KEY, { mode: 0o600 });
  fs.writeFileSync(path.join(blockrunDir, ".solana-session"), solana.privateKey, { mode: 0o600 });

  wallet.getOrCreateWalletKey();
  await wallet.ensureSolanaWallet();

  assert.deepEqual(
    persisted.map((p) => p.account).sort(),
    ["evm-wallet-key", "solana-wallet-key"],
    "file-sourced keys are the ones auto mode exists to mirror",
  );
});
