// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// keychainDelete's contract, on both backends.
//
// It documents "true when the entry is gone, INCLUDING was never there", and
// the macOS branch honoured that by accepting errSecItemNotFound. The Linux
// branch accepted only exit 0, so `secret-tool clear` on a miss reported the
// entry as still present — the one direction that misleads a caller, since it
// says a key is in the keychain when it is not. LINUX_ITEM_NOT_FOUND was
// already defined in the file and simply unused here.
//
// Nothing below spawns a real keychain helper: node:child_process is mocked,
// so `security` and `secret-tool` are never invoked and the login keychain is
// never touched.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import realOs from "node:os";

let platform = "darwin";
let result: { status: number | null; stdout: string } = { status: 0, stdout: "" };
let calls: Array<{ bin: string; args: string[] }> = [];

mock.module("node:os", {
  defaultExport: { ...realOs, platform: () => platform },
});

mock.module("node:child_process", {
  namedExports: {
    spawnSync: (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return result;
    },
  },
});

const { keychainDelete, KEYCHAIN_SERVICE } = await import("../src/utils/keychain.js");

beforeEach(() => {
  calls = [];
});

test("macOS: a successful delete reports the entry gone", () => {
  platform = "darwin";
  result = { status: 0, stdout: "" };
  assert.equal(keychainDelete("evm-wallet-key"), true);
  assert.equal(calls[0].bin, "/usr/bin/security");
  assert.deepEqual(calls[0].args, [
    "delete-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    "evm-wallet-key",
  ]);
});

test("macOS: 'was never there' (errSecItemNotFound) is also gone", () => {
  platform = "darwin";
  result = { status: 44, stdout: "" };
  assert.equal(keychainDelete("evm-wallet-key"), true);
});

test("Linux: a successful clear reports the entry gone", () => {
  platform = "linux";
  result = { status: 0, stdout: "" };
  assert.equal(keychainDelete("solana-wallet-key"), true);
  assert.equal(calls[0].bin, "/usr/bin/secret-tool");
  assert.deepEqual(calls[0].args, [
    "clear",
    "app",
    KEYCHAIN_SERVICE,
    "account",
    "solana-wallet-key",
  ]);
});

test("Linux: 'was never there' is gone too, matching macOS and the documented contract", () => {
  platform = "linux";
  result = { status: 1, stdout: "" };
  assert.equal(
    keychainDelete("solana-wallet-key"),
    true,
    "returning false here claims the key is still in the keychain when it is not",
  );
});

test("a real failure stays false on both backends", () => {
  platform = "darwin";
  result = { status: 51, stdout: "" };
  assert.equal(keychainDelete("evm-wallet-key"), false, "authorization denied is not a delete");

  platform = "linux";
  result = { status: 2, stdout: "" };
  assert.equal(keychainDelete("solana-wallet-key"), false);
});

test("a timeout (status null) is never mistaken for a delete", () => {
  platform = "darwin";
  result = { status: null, stdout: "" };
  assert.equal(keychainDelete("evm-wallet-key"), false);

  platform = "linux";
  result = { status: null, stdout: "" };
  assert.equal(keychainDelete("solana-wallet-key"), false);
});

test("a platform with no keychain deletes nothing and says so", () => {
  platform = "win32";
  result = { status: 0, stdout: "" };
  assert.equal(keychainDelete("evm-wallet-key"), false);
  assert.equal(calls.length, 0, "no helper may be spawned on an unsupported platform");
});
