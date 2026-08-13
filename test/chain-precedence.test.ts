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
process.env.HOME = home;

const { getChain, setChain } = await import("../src/utils/wallet.js");

beforeEach(() => {
  for (const f of [".chain", ".chain-auto", ".solana-session"]) {
    fs.rmSync(path.join(blockrunDir, f), { force: true });
  }
  delete process.env.SOLANA_WALLET_KEY;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SOLANA_WALLET_KEY;
  else process.env.SOLANA_WALLET_KEY = savedEnv;
});

process.on("exit", () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const writeAuto = (v: string) => fs.writeFileSync(path.join(blockrunDir, ".chain-auto"), v);
const writeExplicit = (v: string) => fs.writeFileSync(path.join(blockrunDir, ".chain"), v);
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

test("a fresh install with nothing set defaults to Base", () => {
  assert.equal(getChain(), "base");
});

// The end-to-end regression. Everything above writes the pin file directly,
// which the OLD code would also have passed — it wrote the pin to `.chain`, a
// name those tests never create. This one runs the real writer.
//
// Local only: ensureBothWallets generates two throwaway keypairs inside the temp
// HOME. No network, no funds, nothing signed.
test("a first run leaves SOLANA_WALLET_KEY able to switch chains afterwards", async () => {
  const { ensureBothWallets } = await import("../src/utils/wallet.js");

  // Fresh install: no preference, no session, so getChain() === "base".
  assert.equal(getChain(), "base");
  await ensureBothWallets();

  // The pin must have preserved Base against the freshly-created Solana session...
  assert.equal(getChain(), "base", "provisioning a Solana wallet must not move an existing Base user");
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
});
