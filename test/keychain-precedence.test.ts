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
let readAnswer: { status: string; value?: string; detail?: string } = {
  status: "found",
  value: KEYCHAIN_KEY,
};
let mode = "auto";
mock.module("../src/utils/keychain.js", {
  namedExports: {
    EVM_KEY_ACCOUNT: "evm-wallet-key",
    SOLANA_KEY_ACCOUNT: "solana-wallet-key",
    getKeychainMode: () => mode,
    keychainLoad: () => keychainAnswer,
    keychainRead: () => readAnswer,
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

// The money case. Under BLOCKRUN_KEYCHAIN=strict the plaintext file is gone, so
// a keychain read that FAILS (locked, ACL-denied, timed out) must not be
// mistaken for "no wallet here": falling through to getOrCreateWallet() would
// mint a fresh empty wallet and orphan the funded one still sitting in a
// keychain we merely could not open.
test("a failed keychain read refuses to mint a new wallet instead of orphaning the funded one", async () => {
  const { resetEvmWalletCache } = await import("../src/utils/wallet.js");
  resetEvmWalletCache?.();

  fs.rmSync(path.join(home, ".blockrun", ".session"), { force: true });
  mode = "strict";
  readAnswer = { status: "error", detail: "security exit 51" };

  assert.throws(
    () => getOrCreateWalletKey(),
    /Refusing to create a new wallet/,
    "a read failure with no file must stop, not silently provision a second wallet",
  );

  mode = "auto";
  readAnswer = { status: "found", value: KEYCHAIN_KEY };
});

// --- the Solana twin (audit 2026-09-08, P0) ---
//
// ensureBothWallets used the SDK's file-only getOrCreateSolanaWallet(). Under
// strict mode the file is retired once the key is in the keychain, so a plain
// blockrun_wallet status call minted keypair B, and the next resolveSolanaKey()
// mirrored B over the funded key A with -U and deleted the file. A was gone.

test("Solana: a failed keychain read with no session file refuses to mint (does not orphan the funded key)", async () => {
  const { ensureSolanaWallet, ensureBothWallets, resetSolanaKeyCache } = await import("../src/utils/wallet.js");
  resetSolanaKeyCache();
  fs.rmSync(path.join(home, ".blockrun", ".solana-session"), { force: true });
  mode = "strict";
  readAnswer = { status: "error", detail: "security exit 51" };

  await assert.rejects(ensureSolanaWallet(), /Refusing to create a new Solana wallet/);
  await assert.rejects(ensureBothWallets(), /Refusing to create a new/);
  assert.ok(!fs.existsSync(path.join(home, ".blockrun", ".solana-session")), "nothing may be minted on a failed read");

  mode = "auto";
  readAnswer = { status: "found", value: KEYCHAIN_KEY };
});

test("Solana: every store absent -> mint once, and the new key is visible without a cache reset", async () => {
  const { ensureSolanaWallet, resolveSolanaKey, resetSolanaKeyCache } = await import("../src/utils/wallet.js");
  resetSolanaKeyCache();
  fs.rmSync(path.join(home, ".blockrun", ".solana-session"), { force: true });
  mode = "auto";
  readAnswer = { status: "absent" };

  assert.equal(resolveSolanaKey(), undefined, "a miss before provisioning");
  const info = await ensureSolanaWallet();
  assert.equal(info.isNew, true);
  assert.equal(fs.readFileSync(path.join(home, ".blockrun", ".solana-session"), "utf-8"), info.privateKey);
  assert.equal(resolveSolanaKey(), info.privateKey, "the miss was not memoised");
  const again = await ensureSolanaWallet();
  assert.equal(again.address, info.address, "second call returns the same wallet, no second mint");

  readAnswer = { status: "found", value: KEYCHAIN_KEY };
});

test("Solana: an existing session file outranks a stale keychain entry", async () => {
  const { createSolanaWallet, saveSolanaWallet, solanaPublicKey } = await import("@blockrun/llm");
  const { ensureSolanaWallet, resetSolanaKeyCache } = await import("../src/utils/wallet.js");
  const onDisk = await createSolanaWallet();
  const stale = await createSolanaWallet();
  saveSolanaWallet(onDisk.privateKey);
  resetSolanaKeyCache();
  mode = "auto";
  readAnswer = { status: "found", value: stale.privateKey };

  const info = await ensureSolanaWallet();
  assert.equal(info.isNew, false);
  assert.equal(info.privateKey, onDisk.privateKey);
  assert.equal(info.address, await solanaPublicKey(onDisk.privateKey));

  readAnswer = { status: "found", value: KEYCHAIN_KEY };
});

// --- the empty-file gap (audit round 3) ---
//
// Both gates above asked `existsSync`. The loaders on the far side of them
// (the SDK's resolveFromFiles / loadSolanaWallet) `.trim()` the file and treat
// whitespace as no key. A zero-byte session file therefore read as PRESENT to
// the gate and ABSENT to the loader: the keychain was skipped, a brand new
// wallet was minted, and persistKey() then overwrote the keychain entry still
// holding the funded key. saveWallet() is a plain non-atomic writeFileSync, so
// an interrupted write or a full disk is enough to produce that file.

test("EVM: an EMPTY session file does not shadow the funded key in the keychain", async () => {
  const { resetEvmWalletCache } = await import("../src/utils/wallet.js");
  resetEvmWalletCache();

  const session = path.join(home, ".blockrun", ".session");
  fs.writeFileSync(session, "   \n", { mode: 0o600 });
  mode = "auto";
  readAnswer = { status: "found", value: KEYCHAIN_KEY };

  const resolved = getOrCreateWalletKey();

  assert.equal(
    resolved,
    KEYCHAIN_KEY,
    "a file holding no key must fall through to the keychain, not mint over it",
  );
  assert.equal(
    fs.readFileSync(session, "utf-8").trim(),
    "",
    "nothing may be minted and saved while a funded key sits in the keychain",
  );

  fs.rmSync(session, { force: true });
  resetEvmWalletCache();
});

test("Solana: an EMPTY session file does not shadow the funded key in the keychain", async () => {
  const { createSolanaWallet, solanaPublicKey } = await import("@blockrun/llm");
  const { ensureSolanaWallet, resetSolanaKeyCache } = await import("../src/utils/wallet.js");
  const funded = await createSolanaWallet();

  const session = path.join(home, ".blockrun", ".solana-session");
  fs.writeFileSync(session, "\n", { mode: 0o600 });
  resetSolanaKeyCache();
  mode = "auto";
  readAnswer = { status: "found", value: funded.privateKey };

  const info = await ensureSolanaWallet();

  assert.equal(info.isNew, false, "minting here orphans the key the keychain still holds");
  assert.equal(info.privateKey, funded.privateKey);
  assert.equal(info.address, await solanaPublicKey(funded.privateKey));

  fs.rmSync(session, { force: true });
  resetSolanaKeyCache();
  readAnswer = { status: "found", value: KEYCHAIN_KEY };
});

test("a file that HOLDS a key still outranks the keychain (the empty-file fix did not invert precedence)", async () => {
  const { resetEvmWalletCache } = await import("../src/utils/wallet.js");
  resetEvmWalletCache();

  const session = path.join(home, ".blockrun", ".session");
  fs.writeFileSync(session, FILE_KEY + "\n", { mode: 0o600 });
  mode = "auto";
  readAnswer = { status: "found", value: KEYCHAIN_KEY };

  assert.equal(getOrCreateWalletKey(), FILE_KEY, "rotation by replacing the file must keep working");

  fs.rmSync(session, { force: true });
  resetEvmWalletCache();
});
