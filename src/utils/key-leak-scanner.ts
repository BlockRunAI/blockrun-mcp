/**
 * Scan user config files for leaked wallet private keys and print a loud
 * warning on stderr. Does NOT refuse to start — the user may have already
 * rotated the key and just not cleaned up their config.
 *
 * Background: the deprecated hosted-MCP flow instructed users to paste
 * `X-Wallet-Key: $(cat ~/.blockrun/.session)` into Claude Code's config,
 * which put the private key in ~/.claude.json (plaintext, 0644, often
 * synced to iCloud/Dropbox/Time Machine).
 *
 * One location is NOT a leak: `mcpServers.<name>.env.BLOCKRUN_WALLET_KEY` /
 * `SOLANA_WALLET_KEY`. That is the documented env override (README env table,
 * server.template.json `environmentVariables`), and on Claude Code the only
 * way to set it is `claude mcp add -e BLOCKRUN_WALLET_KEY=0x… -s user`, which
 * writes exactly that path into ~/.claude.json. It still lives in a synced
 * plaintext file, so it earns a short note pointing at the safer stores — but
 * not the "treat as compromised, rotate" banner the hosted-auth paste gets.
 *
 * See: https://github.com/BlockRunAI/blockrun-mcp-server/issues/1
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Strict raw-key shape: 0x-prefixed EVM key (0x + 64 hex) or Solana bs58
 * (80-100 chars). Used for the UNTAGGED catch-all scan, where requiring the 0x
 * prefix avoids flagging unrelated 64-hex values (e.g. SHA-256 hashes).
 */
export function looksLikeRawPrivateKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return true;
  if (value.length >= 80 && value.length <= 100 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return true;
  return false;
}

/**
 * Permissive key shape for a value living under a key/secret-NAMED field. Also
 * accepts a BARE (no-0x) 64-hex key — the common MetaMask "Export Private Key"
 * format — which the strict matcher misses. Safe to be permissive here because
 * the field name already says it holds a secret.
 */
export function looksLikeNamedSecretValue(value: unknown): boolean {
  if (looksLikeRawPrivateKey(value)) return true;
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Solana secret keys are most commonly exported as a JSON array of 64 byte
 * integers (the `solana-keygen` / `id.json` format) rather than a bs58 string.
 * The string scanner above never sees those, so detect the byte-array shape too.
 */
function looksLikeSolanaSecretKeyArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 64 &&
    value.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

/**
 * `leak` — a key somewhere it was never meant to be (the hosted-auth header
 * paste, a stray raw key): rotate.
 * `env-override` — the documented `mcpServers.*.env.{BLOCKRUN,SOLANA}_WALLET_KEY`
 * override: works, but a synced plaintext file is a weaker store than
 * ~/.blockrun/.session or the OS keychain. Note, do not alarm.
 */
export type FindingKind = "leak" | "env-override";

export interface Finding {
  file: string;
  path: string; // JSON path like "mcpServers.blockrun.headers.X-Wallet-Key"
  kind: FindingKind;
}

/** The env var names the README, server.template.json and the setup skill document. */
const DOCUMENTED_KEY_ENV_VARS = new Set(["BLOCKRUN_WALLET_KEY", "SOLANA_WALLET_KEY"]);

/**
 * True when `segments` ends in `mcpServers.<anyServerName>.env.<documented var>`.
 * Segment-based rather than a regex over the dotted path so a server name that
 * itself contains a dot cannot slip the check. Matches user scope
 * (`mcpServers.…`) and Claude Code's project scope (`projects.<dir>.mcpServers.…`)
 * alike, and every JSON client (Claude Desktop, Cursor, Windsurf) uses the same
 * `mcpServers.<name>.env` shape.
 */
function isDocumentedEnvOverride(segments: string[]): boolean {
  const n = segments.length;
  return (
    n >= 4 &&
    segments[n - 4] === "mcpServers" &&
    segments[n - 2] === "env" &&
    DOCUMENTED_KEY_ENV_VARS.has(segments[n - 1])
  );
}

function displayPath(segments: string[]): string {
  return segments.reduce((acc, s) => (/^\[\d+\]$/.test(s) ? acc + s : acc ? `${acc}.${s}` : s), "");
}

function walk(obj: unknown, file: string, segments: string[], out: Finding[]): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    if (looksLikeSolanaSecretKeyArray(obj)) {
      out.push({ file, path: displayPath(segments) || "(root)", kind: "leak" });
    }
    obj.forEach((v, i) => {
      const next = [...segments, `[${i}]`];
      // A string element is a leaf — walk() returns at once for primitives —
      // so it must be checked HERE. Without this a key passed as an `args`
      // element (`"args": ["-e", "0x…"]`) was never seen.
      if (looksLikeRawPrivateKey(v)) out.push({ file, path: displayPath(next), kind: "leak" });
      walk(v, file, next, out);
    });
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = [...segments, k];
    // Heuristic: look at header-ish fields first. A key/secret-named field uses
    // the permissive matcher so a bare 64-hex key is caught too.
    const named = /wallet[-_ ]?key|private[-_ ]?key|secret/i.test(k) && looksLikeNamedSecretValue(v);
    // Also catch untagged values that happen to be raw keys.
    if (named || looksLikeRawPrivateKey(v)) {
      out.push({ file, path: displayPath(next), kind: isDocumentedEnvOverride(next) ? "env-override" : "leak" });
    }
    walk(v, file, next, out);
  }
}

/** Scan one parsed config object. Exported for tests; `warnOnLeakedKeys` is the caller. */
export function findKeyLeaks(data: unknown, file: string): Finding[] {
  const out: Finding[] = [];
  walk(data, file, [], out);
  return out;
}

function scanFile(file: string): Finding[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf-8");
    return findKeyLeaks(JSON.parse(raw) as unknown, file);
  } catch {
    return [];
  }
}

/**
 * The MCP config files this package documents an install path for (README
 * "Install" table, skills/blockrun-setup): Claude Code's ~/.claude.json, Claude
 * Desktop, Cursor and Windsurf. Codex (~/.codex/config.toml) is TOML and is not
 * scanned. Windows paths come from %APPDATA% when set — it is the variable the
 * docs name and a redirected profile does not have to sit under the home dir —
 * with the conventional `AppData/Roaming` as the fallback. Deduplicated because
 * the fallback and %APPDATA% usually coincide.
 */
export function configFileCandidates(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const appData = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : path.join(home, "AppData", "Roaming");
  const candidates = [
    // Claude Code (user scope; project-scoped servers live in the same file)
    path.join(home, ".claude.json"),
    // Claude Desktop — macOS, Linux (Electron userData is ~/.config/<productName>,
    // and the product name is capitalised; the lowercase spelling is kept for
    // anyone who followed an older guide), Windows
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(home, ".config", "Claude", "claude_desktop_config.json"),
    path.join(home, ".config", "claude", "claude_desktop_config.json"),
    path.join(appData, "Claude", "claude_desktop_config.json"),
    // Cursor
    path.join(home, ".cursor", "mcp.json"),
    path.join(appData, "Cursor", "mcp.json"),
    // Windsurf
    path.join(home, ".codeium", "windsurf", "mcp_config.json"),
    path.join(home, ".config", ".codeium", "windsurf", "mcp_config.json"),
    path.join(appData, "Codeium", "windsurf", "mcp_config.json"),
  ];
  return [...new Set(candidates)];
}

export interface WarnOptions {
  /** Files to scan; defaults to `configFileCandidates()`. */
  files?: string[];
  /** Line sink; defaults to console.error (stderr is the MCP log channel). */
  log?: (line: string) => void;
}

/**
 * Scan well-known config files for wallet keys. Prints the rotate-your-wallet
 * banner for a real leak and a short store-it-somewhere-safer note for the
 * documented env override. Returns true only when a real leak was printed;
 * the caller may choose to exit on that if strict mode is desired.
 */
export function warnOnLeakedKeys(opts: WarnOptions = {}): boolean {
  const files = opts.files ?? configFileCandidates();
  const log = opts.log ?? ((line: string) => console.error(line));

  const findings: Finding[] = [];
  for (const f of files) findings.push(...scanFile(f));

  const leaks = findings.filter((f) => f.kind === "leak");
  const overrides = findings.filter((f) => f.kind === "env-override");

  if (leaks.length > 0) printLeakBanner(leaks, log);
  if (overrides.length > 0) printEnvOverrideNote(overrides, log);

  return leaks.length > 0;
}

function printLeakBanner(findings: Finding[], log: (line: string) => void): void {
  const bar = "═".repeat(72);
  log("");
  log(`\x1b[31m${bar}`);
  log("  🚨 WALLET PRIVATE KEY DETECTED IN CONFIG FILE");
  log(bar + "\x1b[0m");
  log("");
  log("  Your config contains what looks like a raw wallet private key.");
  log("  Private keys should NEVER be stored in these files — they get");
  log("  backed up to iCloud / Dropbox / Time Machine, synced across");
  log("  machines, and readable by anything that can read your config.");
  log("");
  log("  Found in:");
  for (const f of findings) {
    log(`    · ${f.file}`);
    log(`      at: ${f.path}`);
  }
  log("");
  log("  RECOMMENDED ACTIONS:");
  log("    1. Treat this key as compromised. Rotate your wallet:");
  log("       - Create a new wallet");
  log("       - Transfer remaining USDC to the new address");
  log("       - Retire the old key");
  log("    2. Remove the X-Wallet-Key entries from your config.");
  log("    3. Reconnect using the local package (signs locally, key");
  log("       never leaves your machine):");
  log("         claude mcp remove blockrun");
  log("         claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest");
  log("");
  log("  Details: https://github.com/BlockRunAI/blockrun-mcp-server/issues/1");
  log("");
}

/**
 * The documented override, working as documented. Said once per start, in
 * four lines, with no rotate advice: the key was placed there on purpose and
 * is not known to anyone else. What it does deserve is the reminder that the
 * file is plaintext and synced, and where the safer stores are.
 */
function printEnvOverrideNote(findings: Finding[], log: (line: string) => void): void {
  log("[BlockRun] Your wallet key is set as an env var in an MCP client config file:");
  for (const f of findings) log(`[BlockRun]   · ${f.file}  at ${f.path}`);
  log(
    "[BlockRun] That works, but the file is plaintext and usually synced (iCloud / Dropbox / Time Machine). " +
      "Prefer the default ~/.blockrun/.session (0600) or the OS keychain (BLOCKRUN_KEYCHAIN=auto), then drop the env entry.",
  );
}
