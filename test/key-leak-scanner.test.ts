// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFileCandidates,
  findKeyLeaks,
  looksLikeRawPrivateKey,
  looksLikeNamedSecretValue,
  warnOnLeakedKeys,
} from "../src/utils/key-leak-scanner.js";

const EVM_KEY = "0x" + "a".repeat(64);
const SOL_KEY = "5".repeat(88); // bs58-shaped Solana key

test("a bare (no-0x) 64-hex key is detected under a key-named field", () => {
  const bare = "a".repeat(64); // MetaMask "Export Private Key" format
  assert.equal(looksLikeNamedSecretValue(bare), true);
  assert.equal(looksLikeNamedSecretValue(EVM_KEY), true);
});

test("strict matcher still catches 0x-prefixed EVM and bs58 Solana keys", () => {
  assert.equal(looksLikeRawPrivateKey(EVM_KEY), true);
  assert.equal(looksLikeRawPrivateKey(SOL_KEY), true);
});

test("strict matcher does NOT flag a bare 64-hex value (avoids SHA-256 false positives)", () => {
  // Used by the untagged catch-all branch, so an unrelated 64-hex hash must pass.
  assert.equal(looksLikeRawPrivateKey("a".repeat(64)), false);
});

test("neither matcher flags ordinary short strings", () => {
  assert.equal(looksLikeRawPrivateKey("hello"), false);
  assert.equal(looksLikeNamedSecretValue("hello"), false);
  assert.equal(looksLikeNamedSecretValue(42 as unknown as string), false);
});

// ---------------------------------------------------------------------------
// The walk. Until now only the matchers were tested; the classification of
// WHERE a key sits — which decides between "rotate your wallet" and "consider
// a safer store" — was not.

test("the hosted-auth header paste is a leak", () => {
  const f = findKeyLeaks({ mcpServers: { blockrun: { headers: { "X-Wallet-Key": EVM_KEY } } } }, "~/.claude.json");
  assert.deepEqual(f, [{ file: "~/.claude.json", path: "mcpServers.blockrun.headers.X-Wallet-Key", kind: "leak" }]);
});

test("the documented env override is NOT a leak: mcpServers.*.env.BLOCKRUN_WALLET_KEY / SOLANA_WALLET_KEY", () => {
  // README env table + server.template.json document exactly this; on Claude
  // Code `claude mcp add -e BLOCKRUN_WALLET_KEY=0x… -s user` writes it here.
  // Before this test the user who followed the docs got the rotate-your-wallet
  // banner on every launch.
  const evm = findKeyLeaks({ mcpServers: { blockrun: { env: { BLOCKRUN_WALLET_KEY: EVM_KEY } } } }, "f");
  assert.deepEqual(evm, [{ file: "f", path: "mcpServers.blockrun.env.BLOCKRUN_WALLET_KEY", kind: "env-override" }]);

  const sol = findKeyLeaks({ mcpServers: { "blockrun-trading": { env: { SOLANA_WALLET_KEY: SOL_KEY } } } }, "f");
  assert.deepEqual(sol, [{ file: "f", path: "mcpServers.blockrun-trading.env.SOLANA_WALLET_KEY", kind: "env-override" }]);

  // A bare 64-hex (MetaMask export) under the documented name is still the override.
  const bare = findKeyLeaks({ mcpServers: { blockrun: { env: { BLOCKRUN_WALLET_KEY: "b".repeat(64) } } } }, "f");
  assert.equal(bare[0]?.kind, "env-override");
});

test("Claude Code's project-scoped servers get the same treatment", () => {
  const f = findKeyLeaks(
    { projects: { "/Users/me/proj": { mcpServers: { blockrun: { env: { BLOCKRUN_WALLET_KEY: EVM_KEY } } } } } },
    "f",
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "env-override");
  assert.equal(f[0].path, "projects./Users/me/proj.mcpServers.blockrun.env.BLOCKRUN_WALLET_KEY");
});

test("a key under env with an UNdocumented name, or outside mcpServers.*.env, is still a leak", () => {
  // Same value, wrong place: only the documented shape is downgraded.
  const cases: Array<[unknown, string]> = [
    [{ mcpServers: { blockrun: { env: { WALLET_KEY: EVM_KEY } } } }, "undocumented env name"],
    [{ mcpServers: { blockrun: { env: { MY_PRIVATE_KEY: EVM_KEY } } } }, "undocumented env name (private_key)"],
    [{ env: { BLOCKRUN_WALLET_KEY: EVM_KEY } }, "env block not under mcpServers.<name>"],
    [{ mcpServers: { blockrun: { BLOCKRUN_WALLET_KEY: EVM_KEY } } }, "documented name but not in an env block"],
    [{ mcpServers: { blockrun: { args: ["-e", EVM_KEY] } } }, "raw key in args"],
    [{ BLOCKRUN_WALLET_KEY: EVM_KEY }, "top-level"],
  ];
  for (const [doc, label] of cases) {
    const f = findKeyLeaks(doc, "f");
    assert.equal(f.length, 1, `${label}: one finding`);
    assert.equal(f[0].kind, "leak", `${label}: is a leak`);
  }
});

test("a raw key as an ARRAY element (e.g. in args) is a leak — the walk used to skip string elements", () => {
  const f = findKeyLeaks({ mcpServers: { blockrun: { args: ["-e", EVM_KEY, "--profile", "trading"] } } }, "f");
  assert.deepEqual(f, [{ file: "f", path: "mcpServers.blockrun.args[1]", kind: "leak" }]);
  const sol = findKeyLeaks([SOL_KEY], "f");
  assert.deepEqual(sol, [{ file: "f", path: "[0]", kind: "leak" }]);
});

test("the solana-keygen byte-array format is a leak wherever it sits", () => {
  const bytes = Array.from({ length: 64 }, (_, i) => i);
  const f = findKeyLeaks({ mcpServers: { blockrun: { env: { SOLANA_WALLET_KEY: bytes } } } }, "f");
  // The array shape is not a documented env-var VALUE (the override takes a
  // bs58 string), so it stays a leak — it is also caught at the array itself.
  assert.ok(f.some((x) => x.kind === "leak"));
});

test("a documented env override whose value is not a key yields nothing", () => {
  assert.deepEqual(findKeyLeaks({ mcpServers: { blockrun: { env: { BLOCKRUN_WALLET_KEY: "$(cat ~/.blockrun/.session)" } } } }, "f"), []);
  assert.deepEqual(findKeyLeaks({ mcpServers: { blockrun: { env: { BLOCKRUN_API_KEY: "br_live_" + "x".repeat(40) } } } }, "f"), []);
  assert.deepEqual(findKeyLeaks({ mcpServers: { blockrun: { command: "npx", args: ["-y", "@blockrun/mcp@latest"] } } }, "f"), []);
});

// ---------------------------------------------------------------------------
// What the user sees.

function run(files: string[]): { printed: boolean; text: string } {
  const lines: string[] = [];
  const printed = warnOnLeakedKeys({ files, log: (l) => lines.push(l) });
  return { printed, text: lines.join("\n") };
}

test("warnOnLeakedKeys: a real leak prints the rotate banner and returns true", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-leak-"));
  try {
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { blockrun: { headers: { "X-Wallet-Key": EVM_KEY } } } }));
    const { printed, text } = run([file]);
    assert.equal(printed, true);
    assert.match(text, /WALLET PRIVATE KEY DETECTED/);
    assert.match(text, /Treat this key as compromised/);
    assert.match(text, /mcpServers\.blockrun\.headers\.X-Wallet-Key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warnOnLeakedKeys: the documented env override gets a short note, no rotate advice, returns false", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-leak-"));
  try {
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { blockrun: { env: { BLOCKRUN_WALLET_KEY: EVM_KEY } } } }));
    const { printed, text } = run([file]);
    assert.equal(printed, false, "an override is not a leak");
    assert.doesNotMatch(text, /DETECTED|compromised|Rotate/i, "no alarm for the documented path");
    assert.match(text, /set as an env var/);
    assert.match(text, /mcpServers\.blockrun\.env\.BLOCKRUN_WALLET_KEY/);
    assert.match(text, /~\/\.blockrun\/\.session/, "points at the default store");
    assert.match(text, /BLOCKRUN_KEYCHAIN=auto/, "and the OS keychain");
    assert.doesNotMatch(text, new RegExp(EVM_KEY), "never echoes the key");
    assert.ok(text.split("\n").length <= 5, "brief — this is a note, not a banner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warnOnLeakedKeys: both at once → banner for the leak, note for the override, true", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-leak-"));
  try {
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({
      mcpServers: { blockrun: { headers: { "X-Wallet-Key": EVM_KEY }, env: { SOLANA_WALLET_KEY: SOL_KEY } } },
    }));
    const { printed, text } = run([file]);
    assert.equal(printed, true);
    assert.match(text, /Treat this key as compromised/);
    assert.match(text, /set as an env var/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warnOnLeakedKeys: missing or unparsable files are skipped silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-leak-"));
  try {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const { printed, text } = run([join(dir, "nope.json"), bad]);
    assert.equal(printed, false);
    assert.equal(text, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Which files. The scanner knew Claude Code and Claude Desktop; the README's
// install table also documents Cursor and Windsurf config files, and those
// carry the same mcpServers.*.env shape.

test("configFileCandidates covers every client config file the README documents", () => {
  const home = "/home/u";
  const c = configFileCandidates(home, {});
  const has = (p: string) => assert.ok(c.includes(p), `missing ${p}\n${c.join("\n")}`);
  has("/home/u/.claude.json");
  has("/home/u/Library/Application Support/Claude/claude_desktop_config.json");
  has("/home/u/.config/Claude/claude_desktop_config.json"); // Electron userData is ~/.config/<productName>, capitalised
  has("/home/u/.cursor/mcp.json");
  has("/home/u/.codeium/windsurf/mcp_config.json");
  has("/home/u/.config/.codeium/windsurf/mcp_config.json");
  // Windows fallback when %APPDATA% is unset
  has("/home/u/AppData/Roaming/Claude/claude_desktop_config.json");
  has("/home/u/AppData/Roaming/Cursor/mcp.json");
  has("/home/u/AppData/Roaming/Codeium/windsurf/mcp_config.json");
  assert.equal(new Set(c).size, c.length, "no duplicates");
});

test("configFileCandidates honours %APPDATA% when set (a redirected profile need not sit under $HOME)", () => {
  const c = configFileCandidates("/home/u", { APPDATA: "/mnt/roaming" });
  assert.ok(c.includes("/mnt/roaming/Claude/claude_desktop_config.json"));
  assert.ok(c.includes("/mnt/roaming/Cursor/mcp.json"));
  assert.ok(c.includes("/mnt/roaming/Codeium/windsurf/mcp_config.json"));
  assert.ok(!c.some((p) => p.startsWith("/home/u/AppData")), "the fallback is not added alongside");
});
