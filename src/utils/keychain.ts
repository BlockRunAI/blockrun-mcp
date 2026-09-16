// src/utils/keychain.ts
//
// OS keychain storage for wallet private keys.
//
// Background: the wallet key lives at ~/.blockrun/.session as plaintext (mode
// 0600). File permissions stop other UNIX users, but not anything that reads
// the home directory as data — a backup agent syncing to iCloud/Dropbox, a
// disk image, a dotfile or log slurper. The same class of leak already bit us
// once through ~/.claude.json, which is why utils/key-leak-scanner.ts exists.
// The keychain moves the secret behind an OS-mediated API instead of a
// readable path, so it protects the key AT REST.
//
// What it does NOT do: defend against code running as you. `security
// add-generic-password` without -T/-A grants the creating application (here,
// /usr/bin/security itself) access, and any process running as the user can
// run `security find-generic-password -w` / `secret-tool lookup` and read the
// value back — a malicious postinstall script included. Do not describe the
// keychain as protection against same-user code; it is not.
//
// Technique credit: the `security -i` approach below (and the 128-byte
// truncation gotcha it avoids) is adapted from Circle's CLI, Apache-2.0.
// This is an independent implementation, not a copy.
//
// Deliberately SYNCHRONOUS. getOrCreateWalletKey() is called from a dozen sync
// client constructors in utils/wallet.ts; making key resolution async would
// ripple through every paid tool for no benefit. The read happens once per
// process (utils/wallet.ts caches _evmWalletInfo) and costs ~10ms.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { privateKeyToAccount } from "viem/accounts";

/** Keychain service name — one namespace for every BlockRun secret. */
export const KEYCHAIN_SERVICE = "blockrun";

/** Account names within the service. */
export const EVM_KEY_ACCOUNT = "evm-wallet-key";
export const SOLANA_KEY_ACCOUNT = "solana-wallet-key";

// Absolute paths: never resolve these off $PATH. A keychain helper picked up
// from a user-writable PATH entry would be handed the private key on stdin.
const MACOS_SECURITY_BIN = "/usr/bin/security";
const LINUX_SECRET_TOOL_BIN = "/usr/bin/secret-tool";

const TIMEOUT_MS = 5_000;

/** macOS errSecItemNotFound. */
const MACOS_ITEM_NOT_FOUND = 44;
/**
 * secret-tool lookup: exit 1 — for a MISS and for a FAULT alike. libsecret's
 * tool/secret-tool.c returns 1 from the lookup action whether `value == NULL`
 * or `error != NULL`; the only difference is that the fault path g_printerr()s
 * its reason first ("Cannot autolaunch D-Bus without X11 $DISPLAY", "The
 * unlock prompt was dismissed", a StartServiceByName timeout). So the status
 * cannot decide, and until audit round 4 the Linux branch read every fault as
 * "absent" — round 3's tri-state was macOS-only, and under strict mode both
 * provisioners minted over a funded keychain wallet the process could not
 * open. linuxLookupMissed() reads stderr as well.
 */
const LINUX_ITEM_NOT_FOUND = 1;

/**
 * secret-tool's stderr when there is NO secrets service to talk to at all — no
 * D-Bus session (SSH, containers, systemd units), or a session bus with no
 * keyring provider (Fedora and Arch ship secret-tool in the base libsecret
 * package). That is a keychain that does not exist, not one that would not
 * open: nothing funded can be in it. Round 4 read every stderr as a fault,
 * and a fresh install on such a host could never mint a wallet — every paid
 * tool refused with "your existing one is most likely still in the keychain"
 * until the user found BLOCKRUN_KEYCHAIN=off (round 4b).
 */
const LINUX_NO_SECRETS_SERVICE = /cannot autolaunch d-bus|was not provided by any \.service files|could not connect|failed to connect to socket|no such interface|org\.freedesktop\.secrets|name is not activatable|dbus/i;

/**
 * What a secret-tool exit 1 meant: a miss printed nothing; a service that is
 * not there printed one of the lines above; anything else it printed (a locked
 * collection, a dismissed unlock prompt) is a fault a funded key may sit behind.
 */
function linuxLookupVerdict(result: { status: number | null; stderr?: string | null }): "miss" | "unavailable" | "fault" {
  if (result.status !== LINUX_ITEM_NOT_FOUND) return "fault";
  const said = (result.stderr ?? "").trim();
  if (!said) return "miss";
  return LINUX_NO_SECRETS_SERVICE.test(said) ? "unavailable" : "fault";
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[blockrun] ${message}`);
}

/** Reset the warn-once dedupe. Test seam only. */
export function _resetKeychainWarnings(): void {
  warned.clear();
}

/**
 * Escape a value for embedding in a double-quoted argument of a
 * `security -i` command line.
 *
 * `security -i` reads commands from stdin and parses each line shell-style:
 * a backslash escapes the next character and a double quote ends the value.
 * Both must be doubled up or the keychain stores something other than what we
 * handed it — silently, since the write still succeeds. Private keys are hex
 * or base58 today (neither character appears), but this must stay correct if
 * we ever store a JSON blob or a passphrase here.
 *
 * A NEWLINE cannot be escaped this way at all: `security -i` reads one command
 * per line, so an embedded newline ends the command mid-value. Measured on
 * macOS 26.5: the truncated line fails to parse and `security` exits 2 without
 * storing anything, and the remainder does NOT execute as an injected command
 * — the quote escaping above already stops a value from closing its own quote.
 * So this is a correctness guard, not a security boundary: callers reject such
 * values so the failure is explicit instead of an opaque exit 2. See the guard
 * in keychainStore.
 */
export function escapeForSecurityInteractive(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Is an OS keychain usable on this platform?
 *
 * macOS ships /usr/bin/security always; Linux has secret-tool only when
 * libsecret-tools is installed AND a secret service (gnome-keyring, KWallet)
 * is running. Windows has no equivalent we can drive without a native
 * dependency, and adding one would cost us `os: any` portability — the MCP is
 * installed with `npx` on every platform, so it stays file-based there.
 */
export function isKeychainAvailable(): boolean {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      fs.accessSync(MACOS_SECURITY_BIN, fs.constants.X_OK);
      return true;
    }
    if (platform === "linux") {
      fs.accessSync(LINUX_SECRET_TOOL_BIN, fs.constants.X_OK);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Store a secret. Returns true on success; callers keep the file fallback.
 *
 * The secret never appears in argv on either platform — `ps` is world-readable
 * on both macOS and Linux, so passing it as a flag would leak it to every
 * local process for the lifetime of the call.
 */
export function keychainStore(account: string, secret: string): boolean {
  const platform = os.platform();

  // No amount of quoting makes a newline safe for `security -i`, which parses
  // one command per line: the value is cut at the break. Measured on macOS
  // 26.5 the mangled line simply fails to parse (exit 2, nothing stored) —
  // it does NOT execute the remainder as an injected command, since the quote
  // escaping already prevents a value from closing its own quote. Refusing up
  // front turns that opaque exit 2 into a stated reason, and guards against a
  // future platform being less strict about a half-parsed line.
  if (/[\r\n]/.test(secret)) {
    warnOnce("Refusing to store a key containing a line break in the OS keychain — keeping the file.");
    return false;
  }

  try {
    if (platform === "darwin") {
      // `-i` (interactive) mode: the command — including the secret — arrives
      // on stdin. The alternative, a trailing bare `-w` that prompts for the
      // password, is reported to truncate at 128 bytes; a base58 Solana key is
      // up to 100 chars today, close enough to that ceiling to avoid the
      // prompt path regardless. NOTE: the 128-byte figure is inherited from
      // Circle's CLI and has NOT been reproduced here — `-i` is preferred on
      // its own merits (no argv exposure), so nothing depends on it being
      // exact. `-U` updates an existing item in place.
      const command =
        `add-generic-password -s "${escapeForSecurityInteractive(KEYCHAIN_SERVICE)}" ` +
        `-a "${escapeForSecurityInteractive(account)}" ` +
        `-w "${escapeForSecurityInteractive(secret)}" -U\n`;
      const result = spawnSync(MACOS_SECURITY_BIN, ["-i"], {
        input: command,
        timeout: TIMEOUT_MS,
        encoding: "utf-8",
      });
      return result.status === 0;
    }

    if (platform === "linux") {
      // secret-tool reads the secret from stdin by design.
      const result = spawnSync(
        LINUX_SECRET_TOOL_BIN,
        ["store", "--label", `${KEYCHAIN_SERVICE} ${account}`, "app", KEYCHAIN_SERVICE, "account", account],
        { input: secret, timeout: TIMEOUT_MS, encoding: "utf-8" },
      );
      return result.status === 0;
    }

    return false;
  } catch {
    warnOnce("OS keychain write failed — the wallet key stays in ~/.blockrun/.session.");
    return false;
  }
}

/**
 * The three distinguishable outcomes of a keychain read.
 *
 * Collapsing `absent` and `error` into one null is a money bug: with the
 * plaintext file already retired by strict mode, "absent" means create a
 * wallet while "error" means a funded wallet may well be sitting in a keychain
 * we merely failed to open. Creating a fresh one there orphans the user's
 * funds — the failure this module's read site calls the worst possible one.
 */
export type KeychainRead =
  | { status: "found"; value: string }
  | { status: "absent" }
  | { status: "error"; detail: string };

/**
 * Did the helper binary fail to launch at all?
 *
 * spawnSync does NOT throw for a nonexistent path: it returns `{status: null,
 * error: ENOENT}`. Before this was checked, the linux branch fell through its
 * exit-code tests and reported `secret-tool exit timeout` as a keychain ERROR
 * — and both provisioners rightly refuse to mint on "error", so a fresh
 * Ubuntu/Debian/WSL/Docker install (libsecret-tools is not installed by
 * default) could never create a wallet on either chain, with a message
 * blaming BLOCKRUN_KEYCHAIN=strict on a machine that had never set it. A
 * keychain that does not exist cannot be holding a funded key: a missing
 * binary is "unavailable", never a fault, and the header above promises the
 * MCP stays file-based there.
 */
function binaryMissing(result: { error?: NodeJS.ErrnoException }): boolean {
  return result.error?.code === "ENOENT";
}

/**
 * Read a secret, preserving WHY a read came back empty.
 */
export function keychainRead(account: string): KeychainRead {
  // Without a keychain there is nothing to read and nothing to spawn. This is
  // the same check persistKey() makes before writing; a reader that asked a
  // narrower question than the writer is how the ENOENT above got classified
  // as a fault.
  if (!isKeychainAvailable()) return { status: "absent" };

  const platform = os.platform();
  try {
    if (platform === "darwin") {
      const result = spawnSync(
        MACOS_SECURITY_BIN,
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { timeout: TIMEOUT_MS, encoding: "utf-8" },
      );
      if (result.status === 0) {
        const value = result.stdout.trim();
        return value ? { status: "found", value } : { status: "absent" };
      }
      if (result.status === MACOS_ITEM_NOT_FOUND) return { status: "absent" };
      if (binaryMissing(result)) return { status: "absent" };
      return { status: "error", detail: `security exit ${result.status ?? "timeout"}` };
    }

    if (platform === "linux") {
      const result = spawnSync(
        LINUX_SECRET_TOOL_BIN,
        ["lookup", "app", KEYCHAIN_SERVICE, "account", account],
        { timeout: TIMEOUT_MS, encoding: "utf-8" },
      );
      if (result.status === 0) {
        const value = result.stdout.trim();
        return value ? { status: "found", value } : { status: "absent" };
      }
      if (linuxLookupVerdict(result) !== "fault") return { status: "absent" };
      if (binaryMissing(result)) return { status: "absent" };
      const said = (result.stderr ?? "").trim().split("\n")[0];
      return { status: "error", detail: `secret-tool exit ${result.status ?? "timeout"}${said ? `: ${said}` : ""}` };
    }

    return { status: "absent" };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read a secret. Returns null when absent, unavailable, or unreadable.
 *
 * Convenience wrapper for callers where "absent" and "error" lead to the same
 * safe action. Anywhere the difference decides whether to CREATE a wallet — or
 * which chain to select — use keychainRead() instead.
 */
export function keychainLoad(account: string): string | null {
  if (!isKeychainAvailable()) return null;

  const platform = os.platform();
  try {
    if (platform === "darwin") {
      const result = spawnSync(
        MACOS_SECURITY_BIN,
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { timeout: TIMEOUT_MS, encoding: "utf-8" },
      );
      if (result.status === 0) return result.stdout.trim() || null;
      // 44 = no such item. Anything else is a real fault worth surfacing:
      // a locked keychain returns a different code, and silently creating a
      // SECOND wallet because we could not read the first one is the worst
      // possible failure here — the user's funds appear to vanish.
      if (result.status !== MACOS_ITEM_NOT_FOUND && !binaryMissing(result)) {
        warnOnce(
          `OS keychain read failed (security exit ${result.status}) — falling back to ~/.blockrun/.session.`,
        );
      }
      return null;
    }

    if (platform === "linux") {
      const result = spawnSync(
        LINUX_SECRET_TOOL_BIN,
        ["lookup", "app", KEYCHAIN_SERVICE, "account", account],
        { timeout: TIMEOUT_MS, encoding: "utf-8" },
      );
      if (result.status === 0) return result.stdout.trim() || null;
      if (linuxLookupVerdict(result) === "fault" && !binaryMissing(result)) {
        const said = (result.stderr ?? "").trim().split("\n")[0];
        warnOnce(
          `OS keychain read failed (secret-tool exit ${result.status}${said ? `: ${said}` : ""}) — falling back to ~/.blockrun/.session.`,
        );
      }
      return null;
    }

    return null;
  } catch {
    warnOnce("OS keychain read failed — falling back to ~/.blockrun/.session.");
    return null;
  }
}

/**
 * Delete a secret. Returns true when the entry is gone, including when it was
 * never there — callers care about the end state, not about who removed it.
 *
 * Both backends have to spell that out, and only the macOS branch used to.
 * `secret-tool clear` is not consistent across versions about whether a miss
 * exits 0 or 1, so accept LINUX_ITEM_NOT_FOUND alongside success; the entry is
 * absent either way. Returning false there would tell a caller the key is
 * still in the keychain when it is not — the exact direction that turns a
 * cleanup into a retry loop or a refusal to re-provision.
 *
 * A platform with no keychain returns false: nothing was deleted and nothing
 * can be, which keychainAvailable() already reports the same way.
 */
export function keychainDelete(account: string): boolean {
  const platform = os.platform();
  try {
    if (platform === "darwin") {
      const result = spawnSync(
        MACOS_SECURITY_BIN,
        ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
        { timeout: TIMEOUT_MS, encoding: "utf-8" },
      );
      return result.status === 0 || result.status === MACOS_ITEM_NOT_FOUND;
    }

    if (platform === "linux") {
      const result = spawnSync(
        LINUX_SECRET_TOOL_BIN,
        ["clear", "app", KEYCHAIN_SERVICE, "account", account],
        { timeout: TIMEOUT_MS, encoding: "utf-8" },
      );
      return result.status === 0 || result.status === LINUX_ITEM_NOT_FOUND;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Keychain mode, from BLOCKRUN_KEYCHAIN:
 *
 *   auto (default) — read the keychain first, mirror newly-resolved keys into
 *                    it, and LEAVE ~/.blockrun/.session in place. Other
 *                    BlockRun tools (the CLI, the SDK, scripts) read that file
 *                    directly, so removing it here would break them.
 *   off            — never touch the keychain.
 *   strict         — as auto, then delete the plaintext file once a read-back
 *                    proves the keychain holds the identical key. This is the
 *                    only mode that actually removes the plaintext copy, and
 *                    it WILL break other tools that read the file. Opt-in.
 */
export type KeychainMode = "auto" | "off" | "strict";

export function getKeychainMode(env: NodeJS.ProcessEnv = process.env): KeychainMode {
  const raw = (env.BLOCKRUN_KEYCHAIN || "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off";
  if (raw === "strict") return "strict";
  return "auto";
}

/**
 * Mirror a key into the keychain, and in strict mode retire the plaintext file.
 *
 * The read-back is not paranoia: `security` exits 0 on a write that later
 * reads back empty (a locked keychain accepts the item and drops it), and
 * unlinking the file on the strength of that exit code would destroy the
 * user's only copy of the key. Verify, then delete — never the other way
 * round, and never delete at all if the read-back disagrees by a single byte.
 */
export interface KeychainOps {
  available: () => boolean;
  store: (account: string, secret: string) => boolean;
  load: (account: string) => string | null;
}

/** Injectable so tests can exercise persistKey without touching a real keychain. */
const defaultOps: KeychainOps = {
  available: isKeychainAvailable,
  store: keychainStore,
  load: keychainLoad,
};

/**
 * Does the plaintext file hold exactly `key`, as its loader would read it?
 *
 * The loaders trim and (for EVM) 0x-prefix the file, so `KEY\n` and the bare
 * hex are the same key on disk. Missing or empty is "yes": there is nothing
 * there to lose. Unreadable is "no": unverifiable is not verified.
 */
function fileHoldsKey(file: string, key: string): boolean {
  let raw: string;
  try {
    if (!fs.existsSync(file)) return true;
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return false;
  }
  const onDisk = raw.trim();
  if (onDisk === "") return true;
  if (onDisk === key) return true;
  return key.startsWith("0x") && !onDisk.startsWith("0x") && `0x${onDisk}` === key;
}

/** The address behind a stored key, for the replace notice — never the key. */
function describeKeyOwner(_account: string, key: string): string {
  // By shape, not by account name: an EVM key is the only one whose address
  // can be derived here without the SVM dependencies.
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
    try {
      return privateKeyToAccount(key as `0x${string}`).address;
    } catch { /* fall through */ }
  }
  return "another wallet";
}

export function persistKey(
  account: string,
  key: string,
  plaintextFile?: string,
  ops: KeychainOps = defaultOps,
): void {
  const mode = getKeychainMode();
  if (mode === "off" || !ops.available()) return;

  // The store is `-U`: it REPLACES whatever the keychain held. The file is
  // the source of truth by design (rotation by replacing .session), so a
  // different key is written — but never silently. Round 4 found three ways
  // a key nobody meant to rotate reached this line (a mis-read Linux
  // keychain, a lost first-run race, a stale legacy file); each is fixed at
  // its source, and this line is what makes the next one visible the run it
  // happens. The address, never the key, is printed.
  const previous = ops.load(account);
  if (previous && previous !== key) {
    console.error(
      `[blockrun] Replacing the ${account} entry in the OS keychain: it held the key for ${describeKeyOwner(account, previous)}, ` +
        `the key file now holds a different one. If you did not rotate this wallet on purpose, stop and check ~/.blockrun before spending.`,
    );
  }

  if (!ops.store(account, key)) return;

  if (mode !== "strict" || !plaintextFile) return;

  if (ops.load(account) !== key) {
    warnOnce(
      "BLOCKRUN_KEYCHAIN=strict: keychain read-back did not match — keeping the plaintext key file.",
    );
    return;
  }

  // The read-back proved the KEYCHAIN holds `key`. It says nothing about the
  // FILE, and the file is what gets deleted. Before this check, a key that
  // arrived from BLOCKRUN_WALLET_KEY went through here: stored over the
  // funded key with -U, read back as itself, and the .session still holding
  // the funded key was removed — both copies of the wallet gone in one run,
  // behind the success message below. The caller no longer persists env keys
  // at all, but the delete must be safe on its own: remove the file only when
  // it holds the very key we just verified, and never remove what we could
  // not read. Empty is fine to remove — it holds nothing to lose.
  if (!fileHoldsKey(plaintextFile, key)) {
    warnOnce(
      `BLOCKRUN_KEYCHAIN=strict: ${plaintextFile} holds a different key than the one verified in the keychain — keeping it.`,
    );
    return;
  }

  try {
    if (fs.existsSync(plaintextFile)) {
      fs.rmSync(plaintextFile, { force: true });
      console.error(
        `[blockrun] BLOCKRUN_KEYCHAIN=strict: moved the wallet key into the OS keychain and removed ${plaintextFile}.\n` +
          `[blockrun] Other BlockRun tools that read that file directly will no longer find a key. ` +
          `Unset BLOCKRUN_KEYCHAIN to go back to shared file storage.`,
      );
    }
  } catch {
    warnOnce(`BLOCKRUN_KEYCHAIN=strict: could not remove ${plaintextFile} — the plaintext key is still on disk.`);
  }
}
