// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// getChain()'s precedence, pinned against a real temp HOME so the files under
// test are the ones the code actually reads.
//
// The bug: ensureBothWallets() preserved "the chain we were on" by writing an
// EXPLICIT ~/.blockrun/.chain, which outranks SOLANA_WALLET_KEY. On a fresh
// install that wrote `.chain=base` during the very first blockrun_wallet call,
// so an operator who later set SOLANA_WALLET_KEY — the documented way to pay on
// Solana — silently stayed on Base with no way to discover why. The pin itself
// is load-bearing (without it, provisioning a Solana wallet flips every Base
// user to Solana on restart, the 0.32.3 bug), so it stays — in its own file,
// ranked below the env var.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// os.homedir() reads $HOME first on POSIX, and wallet.ts captures its paths at
// import time — so HOME is set BEFORE the dynamic import below and stays fixed
// for the file; each test just rewrites the files inside it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-chain-"));
const blockrunDir = path.join(home, ".blockrun");
fs.mkdirSync(blockrunDir, { recursive: true });
const realHome = process.env.HOME;
const savedEnv = process.env.SOLANA_WALLET_KEY;
const savedKeychain = process.env.BLOCKRUN_KEYCHAIN;
process.env.HOME = home;
// These tests pin FILE precedence, and $HOME does not sandbox the OS keychain:
// getChain()'s last resort probes it for a Solana key, so on a developer
// machine that has actually used a Solana wallet the "falls back to base" cases
// would read a real keychain entry and fail. Keychain lookups get their own
// coverage in keychain.test.ts.
process.env.BLOCKRUN_KEYCHAIN = "off";

const { getChain, setChain } = await import("../src/utils/wallet.js");

beforeEach(() => {
  // .session included: the Solana-first default consults it to decide whether
  // this machine already has a Base wallet that must not be migrated.
  for (const f of [".chain", ".chain-auto", ".solana-session", ".session"]) {
    fs.rmSync(path.join(blockrunDir, f), { force: true });
  }
  delete process.env.SOLANA_WALLET_KEY;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SOLANA_WALLET_KEY;
  else process.env.SOLANA_WALLET_KEY = savedEnv;
});

process.on("exit", () => {
  if (savedKeychain === undefined) delete process.env.BLOCKRUN_KEYCHAIN;
  else process.env.BLOCKRUN_KEYCHAIN = savedKeychain;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const writeAuto = (v: string) => fs.writeFileSync(path.join(blockrunDir, ".chain-auto"), v);
const writeExplicit = (v: string) => fs.writeFileSync(path.join(blockrunDir, ".chain"), v);
// A pre-existing Base wallet, as ~/.blockrun/.session actually stores it.
const writeBaseSession = () =>
  fs.writeFileSync(path.join(blockrunDir, ".session"), `0x${"1".repeat(64)}`);
const writeSolanaSession = () => fs.writeFileSync(path.join(blockrunDir, ".solana-session"), "someprivatekeymaterial");

test("SOLANA_WALLET_KEY beats the automatic pin — the bug this fixes", () => {
  writeAuto("base"); // what ensureBothWallets leaves on a fresh install
  process.env.SOLANA_WALLET_KEY = "fake-key-for-precedence-only";
  assert.equal(getChain(), "solana");
});

test("an explicit user preference still beats SOLANA_WALLET_KEY", () => {
  writeExplicit("base");
  process.env.SOLANA_WALLET_KEY = "fake-key-for-precedence-only";
  assert.equal(getChain(), "base", "an explicit choice is the one thing that outranks the env var");
});

test("the automatic pin still beats session autodetect — the 0.32.3 regression it prevents", () => {
  // Without the pin, provisioning a Solana wallet flips an existing Base user to
  // Solana on the next restart and makes action:"deposit" unreachable.
  writeAuto("base");
  writeSolanaSession();
  assert.equal(getChain(), "base");
});

test("session autodetect still applies when nothing is pinned", () => {
  writeSolanaSession();
  assert.equal(getChain(), "solana");
});

test("setChain clears the automatic pin so it cannot resurface", () => {
  writeAuto("solana");
  setChain("base");
  assert.equal(fs.existsSync(path.join(blockrunDir, ".chain-auto")), false);
  assert.equal(getChain(), "base");
});

test("a fresh install with nothing set defaults to Solana", () => {
  assert.equal(getChain(), "solana");
});

// THE MIGRATION GUARD, and the reason the default could be flipped at all.
//
// An existing Base user is identified by ~/.blockrun/.session with no Solana
// signal anywhere. Before the guard existed, flipping the fallback would have
// moved every one of them onto an empty Solana wallet on upgrade — their funded
// Base wallet silently unused, their next paid call failing on zero balance,
// and nothing on screen connecting the two. Same class of silent substitution
// as the .chain-auto bug, arriving from the opposite direction.
test("an existing Base wallet is NOT migrated to Solana by the new default", () => {
  writeBaseSession();
  assert.equal(getChain(), "base");
});

test("an existing Base wallet still yields to every explicit Solana signal", () => {
  writeBaseSession();

  writeExplicit("solana");
  assert.equal(getChain(), "solana", "an explicit .chain outranks the Base session");
  fs.rmSync(path.join(blockrunDir, ".chain"), { force: true });

  process.env.SOLANA_WALLET_KEY = "fake-key-for-precedence-only";
  assert.equal(getChain(), "solana", "SOLANA_WALLET_KEY outranks the Base session");
  delete process.env.SOLANA_WALLET_KEY;

  writeAuto("solana");
  assert.equal(getChain(), "solana", "an auto pin outranks the Base session");
  fs.rmSync(path.join(blockrunDir, ".chain-auto"), { force: true });

  fs.writeFileSync(path.join(blockrunDir, ".solana-session"), "solana-key");
  assert.equal(getChain(), "solana", "a Solana session outranks the Base session");
});

// An empty/truncated .session is not a wallet. Treating it as one would pin a
// genuinely fresh install to Base off a zero-byte file — the mirror of the
// non-empty check step 4 already makes for .solana-session.
test("an empty .session is not mistaken for an existing Base wallet", () => {
  fs.writeFileSync(path.join(blockrunDir, ".session"), "   \n");
  assert.equal(getChain(), "solana");
});

// The end-to-end regression. Everything above writes the pin file directly,
// which the OLD code would also have passed — it wrote the pin to `.chain`, a
// name those tests never create. This one runs the real writer.
//
// Local only: ensureBothWallets generates two throwaway keypairs inside the temp
// HOME. No network, no funds, nothing signed.
test("a first run leaves SOLANA_WALLET_KEY able to switch chains afterwards", async () => {
  const { ensureBothWallets } = await import("../src/utils/wallet.js");

  // Fresh install: no preference, no session of either kind, so the
  // Solana-first default applies.
  assert.equal(getChain(), "solana");
  await ensureBothWallets();

  // Provisioning must not move the chain the user was already on. It is now
  // Solana rather than Base, but the property under test is unchanged.
  assert.equal(getChain(), "solana", "provisioning must not move the chain in use");
  // ...without writing an EXPLICIT preference the user never made.
  assert.equal(
    fs.existsSync(path.join(blockrunDir, ".chain")),
    false,
    "first run must not fabricate an explicit .chain preference",
  );

  // ...and the documented override must still work afterwards. This is the
  // assertion that fails on the old code.
  process.env.SOLANA_WALLET_KEY = "fake-key-for-precedence-only";
  assert.equal(getChain(), "solana", "SOLANA_WALLET_KEY set after first run must still select Solana");

  // The mirror: an explicit switch to Base must stick, even though the fresh
  // install defaulted to Solana and a Solana session now exists on disk.
  delete process.env.SOLANA_WALLET_KEY;
  setChain("base");
  assert.equal(getChain(), "base", "an explicit switch to Base must outrank the Solana session");
});
