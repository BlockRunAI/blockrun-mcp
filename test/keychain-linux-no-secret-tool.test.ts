// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Linux without /usr/bin/secret-tool — Ubuntu and Debian desktops (libsecret-
// tools is not installed by default), WSL, Docker, every cloud VM. The
// keychain.ts header and the 0.41.0 CHANGELOG both promise that such a machine
// "stays file-based". It did not: keychainRead() spawned the missing binary,
// spawnSync reported it as {status: null, error: ENOENT} without throwing, and
// the linux branch mapped that to {status: "error", detail: "secret-tool exit
// timeout"}. Both provisioners treat "error" as "a funded wallet may be sitting
// in a keychain we could not open — refuse to mint", so a fresh install could
// never create a wallet on EITHER chain, and the refusal blamed
// BLOCKRUN_KEYCHAIN=strict on a machine that had never set it.
//
// A keychain that does not exist cannot be holding a funded key. A missing
// binary is "unavailable", never a fault.
//
// Nothing here spawns anything: node:child_process is mocked, and the
// availability probe (fs.accessSync on the binary) is mocked so the result does
// not depend on whether the developer's machine happens to have secret-tool.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import realFs from "node:fs";
import realOs from "node:os";
import path from "node:path";

const home = realFs.mkdtempSync(path.join(realOs.tmpdir(), "br-linux-nokc-"));
const blockrunDir = path.join(home, ".blockrun");
realFs.mkdirSync(blockrunDir, { recursive: true });
const ENV_NAMES = ["HOME", "BLOCKRUN_HOME", "BLOCKRUN_KEYCHAIN", "BLOCKRUN_WALLET_KEY", "BASE_CHAIN_WALLET_KEY", "SOLANA_WALLET_KEY", "BLOCKRUN_API_KEY"] as const;
const saved = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
process.env.HOME = home;
for (const k of ENV_NAMES) if (k !== "HOME") delete process.env[k];

const SECRET_TOOL = "/usr/bin/secret-tool";
let binaryInstalled = false;
let spawns: Array<{ bin: string; args: string[] }> = [];

// Both the default and the named export surfaces: keychain.ts uses the default
// import, the SDK and viem use named imports from "os"/"fs".
const osMock = { ...realOs, platform: () => "linux" };
mock.module("node:os", { defaultExport: osMock, namedExports: osMock });

const fsMock = {
  ...realFs,
  accessSync: (p: string, mode?: number) => {
    if (p === SECRET_TOOL && !binaryInstalled) {
      const err = new Error(`ENOENT: no such file or directory, access '${p}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    if (p === SECRET_TOOL) return undefined;
    return realFs.accessSync(p, mode);
  },
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: fsMock });

mock.module("node:child_process", {
  namedExports: {
    // What spawnSync really returns for a nonexistent absolute path: no throw,
    // status null, and the ENOENT on `error`.
    spawnSync: (bin: string, args: string[]) => {
      spawns.push({ bin, args });
      const error = new Error(`spawnSync ${bin} ENOENT`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return { status: null, signal: null, stdout: "", stderr: "", error, pid: 0, output: [] };
    },
  },
});

const keychain = await import("../src/utils/keychain.js");
const wallet = await import("../src/utils/wallet.js");

process.on("exit", () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  realFs.rmSync(home, { recursive: true, force: true });
});

/** Capture stderr lines for the duration of `fn`. */
async function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

beforeEach(() => {
  for (const f of [".session", ".solana-session", "wallet.key", ".chain", ".chain-auto"]) {
    realFs.rmSync(path.join(blockrunDir, f), { force: true });
  }
  delete process.env.BLOCKRUN_KEYCHAIN;
  binaryInstalled = false;
  spawns = [];
  keychain._resetKeychainWarnings();
  wallet.resetEvmWalletCache();
  wallet.resetSolanaKeyCache();
  wallet.resetKeychainProbeCache();
});

// --- keychain.ts: classification ------------------------------------------

test("a missing secret-tool reads as ABSENT, not as a keychain error, and spawns nothing", async () => {
  const { result, lines } = await captureStderr(() => keychain.keychainRead("evm-wallet-key"));

  assert.deepEqual(result, { status: "absent" }, "no keychain means no key in it — never 'error'");
  assert.deepEqual(spawns, [], "there is nothing to spawn");
  assert.deepEqual(lines, [], "no 'OS keychain read failed' warning for a keychain that was never there");
});

test("keychainLoad on a missing secret-tool is a quiet null", async () => {
  const { result, lines } = await captureStderr(() => keychain.keychainLoad("solana-wallet-key"));

  assert.equal(result, null);
  assert.deepEqual(lines, [], "getChain()'s probes printed two of these per process on every keychain-less Linux box");
});

test("ENOENT from the spawn itself (binary vanished after the availability check) is also absent", async () => {
  binaryInstalled = true; // accessSync succeeds, spawnSync still reports ENOENT

  const { result, lines } = await captureStderr(() => keychain.keychainRead("evm-wallet-key"));

  assert.deepEqual(result, { status: "absent" });
  assert.equal(spawns.length, 1, "the binary looked present, so the spawn was attempted");
  assert.deepEqual(lines, []);
  assert.equal(keychain.keychainLoad("evm-wallet-key"), null);
});

test("isKeychainAvailable is false without the binary and true with it", () => {
  assert.equal(keychain.isKeychainAvailable(), false);
  binaryInstalled = true;
  assert.equal(keychain.isKeychainAvailable(), true);
});

// --- wallet.ts: a fresh install mints on both chains -----------------------

test("fresh keychain-less Linux install: Solana (the default chain) provisions a wallet", async () => {
  const { result: info, lines } = await captureStderr(() => wallet.ensureSolanaWallet());

  assert.equal(info.isNew, true, "a fresh install must be allowed to mint");
  assert.ok(realFs.existsSync(path.join(blockrunDir, ".solana-session")), "file storage is the fallback the header promises");
  assert.ok(!lines.some((l) => /keychain read failed|strict/i.test(l)), `spurious keychain noise: ${JSON.stringify(lines)}`);
});

test("fresh keychain-less Linux install: Base provisions a wallet too", async () => {
  const { result: key, lines } = await captureStderr(() => wallet.getOrCreateWalletKey());

  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.equal(realFs.readFileSync(path.join(blockrunDir, ".session"), "utf-8").trim(), key, "the key went to the file");
  assert.ok(!lines.some((l) => /keychain read failed|strict/i.test(l)), `spurious keychain noise: ${JSON.stringify(lines)}`);
});

test("fresh keychain-less Linux install: ensureBothWallets (the blockrun_wallet status path) succeeds", async () => {
  const both = await wallet.ensureBothWallets();
  assert.equal(both.base.isNew, true);
  assert.equal(both.solana.isNew, true);
  assert.equal(wallet.getChain(), "solana", "and the fresh-install default still applies");
});

test("an existing file-based wallet keeps working, and is not mirrored anywhere", async () => {
  const KEY = "0x" + "11".repeat(32);
  realFs.writeFileSync(path.join(blockrunDir, ".session"), KEY, { mode: 0o600 });

  assert.equal(wallet.getOrCreateWalletKey(), KEY);
  assert.deepEqual(spawns.filter((s) => s.args[0] === "store"), [], "no keychain, no store attempt");
});
