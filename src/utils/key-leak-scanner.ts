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
 * See: https://github.com/BlockRunAI/blockrun-mcp-server/issues/1
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Match Base (0x + 64 hex) or Solana (80-100 char bs58) raw key shapes. */
function looksLikeRawPrivateKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return true;
  if (value.length >= 80 && value.length <= 100 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return true;
  return false;
}

interface Finding {
  file: string;
  path: string; // JSON path like "mcpServers.blockrun.headers.X-Wallet-Key"
}

function walk(
  obj: unknown,
  file: string,
  jsonPath: string,
  out: Finding[],
): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, file, `${jsonPath}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = jsonPath ? `${jsonPath}.${k}` : k;
    // Heuristic: look at header-ish fields first
    if (/wallet[-_ ]?key|private[-_ ]?key|secret/i.test(k) && looksLikeRawPrivateKey(v)) {
      out.push({ file, path: next });
    } else if (looksLikeRawPrivateKey(v)) {
      // Also catch untagged values that happen to be raw keys
      out.push({ file, path: next });
    }
    walk(v, file, next, out);
  }
}

function scanFile(file: string): Finding[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw) as unknown;
    const out: Finding[] = [];
    walk(data, file, "", out);
    return out;
  } catch {
    return [];
  }
}

/**
 * Scan well-known config files for leaked wallet keys. Returns true if any
 * findings were printed; caller may choose to exit if strict mode is desired.
 */
export function warnOnLeakedKeys(): boolean {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude.json"),
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(home, ".config", "claude", "claude_desktop_config.json"),
    path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
  ];

  const findings: Finding[] = [];
  for (const f of candidates) findings.push(...scanFile(f));

  if (findings.length === 0) return false;

  const bar = "═".repeat(72);
  console.error("");
  console.error(`\x1b[31m${bar}`);
  console.error("  🚨 WALLET PRIVATE KEY DETECTED IN CONFIG FILE");
  console.error(bar + "\x1b[0m");
  console.error("");
  console.error("  Your config contains what looks like a raw wallet private key.");
  console.error("  Private keys should NEVER be stored in these files — they get");
  console.error("  backed up to iCloud / Dropbox / Time Machine, synced across");
  console.error("  machines, and readable by anything that can read your config.");
  console.error("");
  console.error("  Found in:");
  for (const f of findings) {
    console.error(`    · ${f.file}`);
    console.error(`      at: ${f.path}`);
  }
  console.error("");
  console.error("  RECOMMENDED ACTIONS:");
  console.error("    1. Treat this key as compromised. Rotate your wallet:");
  console.error("       - Create a new wallet");
  console.error("       - Transfer remaining USDC to the new address");
  console.error("       - Retire the old key");
  console.error("    2. Remove the X-Wallet-Key entries from your config.");
  console.error("    3. Reconnect using the local package (signs locally, key");
  console.error("       never leaves your machine):");
  console.error("         claude mcp remove blockrun");
  console.error("         claude mcp add blockrun npx -y @blockrun/mcp@latest");
  console.error("");
  console.error("  Details: https://github.com/BlockRunAI/blockrun-mcp-server/issues/1");
  console.error("");
  return true;
}
