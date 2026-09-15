// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The cross-PROCESS first-run race. 0.50.0's single-flight covers overlapping
// callers inside one server; it cannot see a second server. Claude Code,
// Cursor and Claude Desktop are commonly all configured with `-s user`, and on
// a machine that has never held a key two of them can both find every store
// empty, both mint, and both write: saveSolanaWallet()/saveWallet() were plain
// writeFileSync (no exclusive flag, no re-read) and persistKey stores with -U.
// Last writer wins on disk and in the keychain, but each process keeps its own
// cached wallet for its lifetime and prints its OWN address with a funding QR.
// USDC sent to the loser's address is unrecoverable once that process exits —
// no store ever held the key.
//
// The fix is at the write: publish the freshly minted key with an exclusive
// create, and when that loses, adopt the key the OTHER process published
// instead of the one just generated. Both processes then advertise the same
// wallet, which is the one every store holds.
//
// Two "processes" are simulated by interleaving: the SDK's key generator is
// wrapped so that, inside process A's mint window (after A's empty-store check,
// before A's write), process B's key lands in the session file. That is the
// exact ordering that lost money.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-first-run-race-"));
const blockrunDir = path.join(home, ".blockrun");
fs.mkdirSync(blockrunDir, { recursive: true });
const ENV_NAMES = ["HOME", "BLOCKRUN_HOME", "BLOCKRUN_KEYCHAIN", "BLOCKRUN_WALLET_KEY", "BASE_CHAIN_WALLET_KEY", "SOLANA_WALLET_KEY", "BLOCKRUN_API_KEY"] as const;
const saved = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
process.env.HOME = home;
for (const k of ENV_NAMES) if (k !== "HOME") delete process.env[k];

const realLlm = await import("@blockrun/llm");
const SESSION = path.join(blockrunDir, ".session");
const SOLANA_SESSION = path.join(blockrunDir, ".solana-session");

// What "process B" does inside A's mint window. Reset per test.
let duringSolanaMint: (() => Promise<void>) | null = null;
let duringEvmMint: (() => void) | null = null;

// The namespace object carries a `default` binding that mock.module cannot
// re-export under that name; everything else passes through untouched.
const { default: _unusedDefault, ...realNamed } = realLlm as Record<string, unknown> & { default?: unknown };
void _unusedDefault;
mock.module("@blockrun/llm", {
  namedExports: {
    ...realNamed,
    createSolanaWallet: async () => {
      const created = await realLlm.createSolanaWallet();
      if (duringSolanaMint) await duringSolanaMint();
      return created;
    },
    createWallet: () => {
      const created = realLlm.createWallet();
      if (duringEvmMint) duringEvmMint();
      return created;
    },
  },
});

// The keychain both processes share. `-U` semantics: last store wins.
const store = new Map<string, string>();
mock.module("../src/utils/keychain.js", {
  namedExports: {
    EVM_KEY_ACCOUNT: "evm-wallet-key",
    SOLANA_KEY_ACCOUNT: "solana-wallet-key",
    getKeychainMode: () => "auto",
    keychainLoad: (a: string) => store.get(a) ?? null,
    keychainRead: (a: string) => (store.has(a) ? { status: "found", value: store.get(a) } : { status: "absent" }),
    persistKey: (account: string, key: string) => {
      store.set(account, key);
    },
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
  for (const f of fs.readdirSync(blockrunDir)) fs.rmSync(path.join(blockrunDir, f), { force: true, recursive: true });
  store.clear();
  duringSolanaMint = null;
  duringEvmMint = null;
  wallet.resetEvmWalletCache();
  wallet.resetSolanaKeyCache();
  wallet.resetKeychainProbeCache();
});

test("Solana: when another process publishes first, this process adopts THAT key instead of its own", async () => {
  const processB = await realLlm.createSolanaWallet();
  let generatedByA: string | undefined;
  duringSolanaMint = async () => {
    // Process B wins the race: its key is on disk before A writes.
    fs.writeFileSync(SOLANA_SESSION, processB.privateKey, { mode: 0o600 });
    store.set("solana-wallet-key", processB.privateKey);
  };

  const info = await wallet.ensureSolanaWallet();
  generatedByA = info.privateKey;

  assert.equal(info.privateKey, processB.privateKey, "A must hand back the key every store holds, not one only its heap holds");
  assert.equal(info.address, processB.address, "the address shown with the funding QR must be the winner's");
  assert.equal(fs.readFileSync(SOLANA_SESSION, "utf-8").trim(), processB.privateKey, "B's file was not overwritten");
  assert.equal(store.get("solana-wallet-key"), processB.privateKey, "and the keychain still holds B's key");
  assert.equal(wallet.resolveSolanaKey(), processB.privateKey);
  assert.equal((await wallet.ensureSolanaWallet()).address, processB.address, "the cache agrees with the stores");
  assert.equal(generatedByA, processB.privateKey);
});

test("Base: when another process publishes first, this process adopts THAT key instead of its own", () => {
  const processB = realLlm.createWallet();
  duringEvmMint = () => {
    fs.writeFileSync(SESSION, processB.privateKey, { mode: 0o600 });
    store.set("evm-wallet-key", processB.privateKey);
  };

  const key = wallet.getOrCreateWalletKey();

  assert.equal(key, processB.privateKey, "A must sign with the key every store holds");
  assert.equal(fs.readFileSync(SESSION, "utf-8").trim(), processB.privateKey, "B's file was not overwritten");
  assert.equal(store.get("evm-wallet-key"), processB.privateKey);
  assert.equal(privateKeyToAccount(key).address, processB.address);
});

test("the address a process reports after losing the race is fundable — its key is in the file", async () => {
  const processB = await realLlm.createSolanaWallet();
  duringSolanaMint = async () => {
    fs.writeFileSync(SOLANA_SESSION, processB.privateKey, { mode: 0o600 });
  };

  const info = await wallet.getWalletInfo();
  assert.equal(info.network, "Solana");
  assert.equal(info.address, processB.address);
  // Simulate the loser restarting: a fresh process resolves the same address.
  wallet.resetSolanaKeyCache();
  assert.equal((await wallet.ensureSolanaWallet()).address, info.address, "after restart the same wallet is found — no funds stranded");
});

test("no race: a fresh mint still writes the file and reports isNew on both chains", async () => {
  const sol = await wallet.ensureSolanaWallet();
  assert.equal(sol.isNew, true);
  assert.equal(fs.readFileSync(SOLANA_SESSION, "utf-8").trim(), sol.privateKey);

  const evm = wallet.getOrCreateWalletKey();
  assert.equal(fs.readFileSync(SESSION, "utf-8").trim(), evm);
  assert.deepEqual(fs.readdirSync(blockrunDir).sort(), [".session", ".solana-session"], "no temp files left behind");
});

test("a pre-existing EMPTY session file is replaced by the mint, not adopted as a key", async () => {
  // The round-3 scenario: an interrupted write left a zero-byte file. The
  // exclusive create loses to it, but there is nothing to adopt.
  fs.writeFileSync(SOLANA_SESSION, "", { mode: 0o600 });
  fs.writeFileSync(SESSION, "  \n", { mode: 0o600 });

  const sol = await wallet.ensureSolanaWallet();
  assert.equal(sol.isNew, true);
  assert.equal(fs.readFileSync(SOLANA_SESSION, "utf-8").trim(), sol.privateKey);

  const evm = wallet.getOrCreateWalletKey();
  assert.equal(fs.readFileSync(SESSION, "utf-8").trim(), evm);
});

test("the session files are created mode 0600", async () => {
  await wallet.ensureSolanaWallet();
  wallet.getOrCreateWalletKey();
  for (const f of [SESSION, SOLANA_SESSION]) {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
  }
});
