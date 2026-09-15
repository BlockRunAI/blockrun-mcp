// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// `secret-tool lookup` exits 1 for BOTH "no such item" and "an error
// occurred" — libsecret's tool/secret-tool.c returns 1 from the lookup action
// whether `value == NULL` or `error != NULL`; the difference is that the error
// path g_printerr()s a message first. So on Linux, round 3's tri-state read
// (found / absent / error) was macOS-only: a locked collection, a missing
// D-Bus session ("Cannot autolaunch D-Bus without X11 $DISPLAY"), a dismissed
// unlock prompt — every one read as ABSENT, and under BLOCKRUN_KEYCHAIN=strict
// (session file retired) both provisioners then minted a fresh wallet over the
// funded one in the keychain the process merely could not open.
//
// The tell is stderr: a miss prints nothing, a fault prints why. The status
// alone cannot decide, and this file pins that the classifier no longer tries.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import realFs from "node:fs";
import realOs from "node:os";

const SECRET_TOOL = "/usr/bin/secret-tool";
let spawnResult: { status: number | null; stdout: string; stderr: string } = { status: 1, stdout: "", stderr: "" };

const osMock = { ...realOs, platform: () => "linux" };
mock.module("node:os", { defaultExport: osMock, namedExports: osMock });
const fsMock = {
  ...realFs,
  accessSync: (p: string, mode?: number) => (p === SECRET_TOOL ? undefined : realFs.accessSync(p, mode)),
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: fsMock });
mock.module("node:child_process", {
  namedExports: {
    spawnSync: () => ({ ...spawnResult, signal: null, pid: 1, output: [] }),
  },
});

const keychain = await import("../src/utils/keychain.js");

beforeEach(() => {
  keychain._resetKeychainWarnings();
});

test("exit 1 with nothing on stderr is a miss: absent", () => {
  spawnResult = { status: 1, stdout: "", stderr: "" };
  assert.deepEqual(keychain.keychainRead("evm-wallet-key"), { status: "absent" });
  assert.equal(keychain.keychainLoad("evm-wallet-key"), null);
});

for (const [why, stderr] of [
  ["no D-Bus session", "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n"],
  ["locked collection / dismissed prompt", "secret-tool: The unlock prompt was dismissed\n"],
  ["service unavailable", "secret-tool: Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached\n"],
] as const) {
  test(`exit 1 with a message on stderr (${why}) is a FAULT: error, never absent`, () => {
    spawnResult = { status: 1, stdout: "", stderr };
    const read = keychain.keychainRead("evm-wallet-key");
    assert.equal(read.status, "error", `${why}: ${JSON.stringify(read)}`);
    assert.match((read as { detail: string }).detail, /secret-tool/);
    assert.match((read as { detail: string }).detail, new RegExp(stderr.trim().slice(13, 30).replace(/[$()]/g, "\\$&")), "the detail carries the tool's own reason");
  });
}

test("a timeout (status null, no ENOENT) is a fault on Linux too", () => {
  spawnResult = { status: null, stdout: "", stderr: "" };
  assert.equal(keychain.keychainRead("evm-wallet-key").status, "error");
});

test("keychainLoad warns on a fault and stays quiet on a miss", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    spawnResult = { status: 1, stdout: "", stderr: "" };
    assert.equal(keychain.keychainLoad("solana-wallet-key"), null);
    assert.deepEqual(lines, [], "a miss is not worth a warning");
    keychain._resetKeychainWarnings();
    spawnResult = { status: 1, stdout: "", stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n" };
    assert.equal(keychain.keychainLoad("solana-wallet-key"), null);
    assert.equal(lines.length, 1, "a fault is");
    assert.match(lines[0], /keychain read failed/i);
  } finally {
    console.error = original;
  }
});
