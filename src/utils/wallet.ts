// src/utils/wallet.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  LLMClient,
  ImageClient,
  PriceClient,
  SolanaLLMClient,
  AnthropicClient,
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  loadSolanaWallet,
  getPaymentLinks,
  formatWalletCreatedMessage,
  formatNeedsFundingMessage,
  SOLANA_WALLET_FILE_PATH,
  WALLET_FILE_PATH,
} from "@blockrun/llm";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_ADDRESS, BASE_RPC_URLS } from "./constants.js";
import {
  EVM_KEY_ACCOUNT,
  SOLANA_KEY_ACCOUNT,
  getKeychainMode,
  keychainLoad,
  keychainRead,
  persistKey,
} from "./keychain.js";
import { getApiKey, getApiKeyBase, isApiKeyMode, PORTAL_CREDITS_URL } from "./auth.js";

export type ApiClient = LLMClient | SolanaLLMClient;

const BLOCKRUN_DIR = path.join(os.homedir(), ".blockrun");
const CHAIN_PREFERENCE_FILES = [
  path.join(BLOCKRUN_DIR, ".chain"),
  path.join(BLOCKRUN_DIR, "payment-chain"),
];

let _evmClient: LLMClient | null = null;
let _imageClient: ImageClient | null = null;
let _priceClient: PriceClient | null = null;
let _freePriceClient: PriceClient | null = null;
let _evmWalletInfo: { address: string; privateKey: string; isNew: boolean } | null = null;
let _solanaClient: SolanaLLMClient | null = null;
let _anthropicClient: AnthropicClient | null = null;

// The AUTO-pin, written by ensureBothWallets to preserve the chain a user was
// already on when their second wallet gets provisioned. Deliberately a separate
// file from `.chain`: that one means "the user chose this" and outranks
// everything, and laundering a machine-made default through it silently killed
// the documented SOLANA_WALLET_KEY override — first run wrote `.chain=base`, and
// an operator who set the env var afterwards stayed on Base with no way to see
// why. Ranked below the env var in getChain(), and deleted by setChain() so an
// explicit choice is never shadowed by a stale automatic one.
const CHAIN_AUTO_FILE = path.join(BLOCKRUN_DIR, ".chain-auto");

function readOneChainFile(file: string): "base" | "solana" | null {
  try {
    if (!fs.existsSync(file)) return null;
    const value = fs.readFileSync(file, "utf-8").trim().toLowerCase();
    if (value === "base" || value === "solana") return value;
  } catch { /* ignore */ }
  return null;
}

function readAutoChain(): "base" | "solana" | null {
  return readOneChainFile(CHAIN_AUTO_FILE);
}

function writeAutoChain(chain: "base" | "solana"): void {
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.writeFileSync(CHAIN_AUTO_FILE, chain, { mode: 0o600 });
    resetChainCaches();
  } catch { /* a pin we cannot write is not worth failing a wallet call over */ }
}

function readChainPreference(): "base" | "solana" | null {
  for (const file of CHAIN_PREFERENCE_FILES) {
    try {
      if (!fs.existsSync(file)) continue;
      const value = fs.readFileSync(file, "utf-8").trim().toLowerCase();
      if (value === "base" || value === "solana") return value;
    } catch { /* ignore */ }
  }
  return null;
}

// Memoized: getChain() is a hot path and this branch spawns a subprocess.
// Only ever consulted after the file check misses, so the cost is paid at most
// once per process, and only by users who have no Solana session file.
let _keychainSolanaKeyPresent: boolean | undefined;

function hasKeychainSolanaKey(): boolean {
  if (getKeychainMode() === "off") return false;
  if (_keychainSolanaKeyPresent === undefined) {
    _keychainSolanaKeyPresent = keychainLoad(SOLANA_KEY_ACCOUNT) !== null;
  }
  return _keychainSolanaKeyPresent;
}

// Same memoization, for the mirror-image probe used by the Solana-first default.
let _keychainEvmKeyPresent: boolean | undefined;

function hasKeychainEvmKey(): boolean {
  if (getKeychainMode() === "off") return false;
  if (_keychainEvmKeyPresent === undefined) {
    _keychainEvmKeyPresent = keychainLoad(EVM_KEY_ACCOUNT) !== null;
  }
  return _keychainEvmKeyPresent;
}

/**
 * Does this machine already hold a BASE wallet the user may have funded?
 *
 * Only consulted by getChain()'s final fallback, and only to stop the
 * Solana-first default from being a silent migration. Checks all three stores
 * the EVM key can live in, for the same reason ensureEvmWallet() does: under
 * BLOCKRUN_KEYCHAIN=strict the plaintext file is deleted once the key is in the
 * keychain, so a file-only check would read a hardened Base user as a fresh
 * install and move them to a chain they have never funded.
 */
function hasExistingBaseWallet(): boolean {
  if (process.env.BLOCKRUN_WALLET_KEY) return true;
  try {
    if (fs.existsSync(WALLET_FILE_PATH) && fs.readFileSync(WALLET_FILE_PATH, "utf-8").trim()) {
      return true;
    }
  } catch { /* an unreadable file is not evidence either way — fall through */ }
  return hasKeychainEvmKey();
}

/** Test seam — clears the memoized keychain probes. */
export function resetKeychainProbeCache(): void {
  _keychainSolanaKeyPresent = undefined;
  _keychainEvmKeyPresent = undefined;
}

export function getChain(): "base" | "solana" {
  // 1. Explicit user preference (~/.blockrun/.chain) wins over everything else.
  //    Without this, the mere existence of a stale .solana-session file pins
  //    the server to Solana even when the user has explicitly switched to Base.
  const preferred = readChainPreference();
  if (preferred) return preferred;

  // 2. SOLANA_WALLET_KEY env var implies the operator wants Solana.
  if (process.env.SOLANA_WALLET_KEY) return "solana";

  // 3. The automatic pin from ensureBothWallets — below the env var on purpose,
  //    so setting SOLANA_WALLET_KEY later still switches chains. It sits ABOVE
  //    the session autodetect below because that is exactly what it exists to
  //    override: provisioning the second wallet must not move an existing user.
  const auto = readAutoChain();
  if (auto) return auto;

  // 4. Fall back to wallet-file autodetection for first-run users who never
  //    set a chain preference but already have a Solana session on disk. Read
  //    the specific session file and require it to be NON-EMPTY: a bare
  //    existsSync would pin an empty/truncated file to a Solana client that
  //    can't be built ("Private key required"), but loadSolanaWallet() scans the
  //    whole home directory and getChain() is a hot path — so check the one file
  //    cheaply instead.
  try {
    if (fs.existsSync(SOLANA_WALLET_FILE_PATH) &&
        fs.readFileSync(SOLANA_WALLET_FILE_PATH, "utf-8").trim()) {
      return "solana";
    }
  } catch { /* ignore */ }

  // 5. Same signal, different store. Under BLOCKRUN_KEYCHAIN=strict the
  //    .solana-session file is deleted once its key is in the keychain, and
  //    without this a Solana user with no explicit .chain would be silently
  //    flipped to Base by the hardening step itself — then met with
  //    "Base-only" refusals from a wallet they never funded.
  if (hasKeychainSolanaKey()) return "solana";

  // 6. No Solana signal anywhere — but that is not the same as "new user".
  //
  //    Solana is the chain we lead with now, so a FRESH install defaults there
  //    (step 7). Flipping the fallback unconditionally, however, would be a
  //    silent destructive migration: every existing Base-only user who never
  //    wrote a .chain file would be moved onto an empty Solana wallet, and
  //    their next paid call would fail on zero balance with nothing on screen
  //    explaining why their funded wallet stopped being used.
  //
  //    That is exactly the failure CHAIN_AUTO_FILE was introduced to prevent,
  //    arriving from the opposite direction. So the default only applies when
  //    there is no Base wallet to strand.
  if (hasExistingBaseWallet()) return "base";

  // 7. Genuinely fresh install: no chain preference, no wallet of either kind.
  return "solana";
}

// The canonical file we WRITE the chain preference to (getChain reads either,
// but a single writer keeps things unambiguous).
const CHAIN_FILE = path.join(BLOCKRUN_DIR, ".chain");

// Drop every chain-dependent cached client so the next getClient()/getImageClient()
// rebuilds against the freshly-selected chain. The EVM wallet identity
// (_evmWalletInfo) is chain-independent and intentionally preserved.
function resetChainCaches(): void {
  _evmClient = null;
  _solanaClient = null;
  _anthropicClient = null;
  _imageClient = null;
  _priceClient = null;
  _freePriceClient = null;
}

/**
 * Explicitly switch the active payment chain. Persists to ~/.blockrun/.chain
 * (which getChain() ranks above env vars and wallet-file autodetection) and
 * clears cached clients so the change takes effect on the very next call.
 */
export function setChain(chain: "base" | "solana"): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(CHAIN_FILE, chain, { mode: 0o600 });
  // Drop any automatic pin: an explicit choice must not leave a machine-made
  // one behind to resurface if this file is ever removed.
  try { fs.rmSync(CHAIN_AUTO_FILE, { force: true }); } catch { /* ignore */ }
  resetChainCaches();
}

/**
 * Provision BOTH wallets so each chain has a fundable address regardless of
 * which one is currently active. Idempotent — getOrCreate* only generate on
 * first run. Returns each chain's address + whether it was just created.
 */
export async function ensureBothWallets(): Promise<{
  base: { address: string; isNew: boolean };
  solana: { address: string; isNew: boolean };
}> {
  // Pin the chain BEFORE provisioning. getChain()'s step-3 autodetect keys off
  // the mere existence of a non-empty .solana-session, and this function creates
  // exactly that file — so merely running blockrun_wallet (the DEFAULT status
  // action calls this) silently flipped a Base user to Solana. Afterwards every
  // paid tool either signs from a zero-balance Solana wallet or hard-refuses
  // "Base-only", including action:"deposit" — the funding path itself becomes
  // unreachable, with no way to discover why. Contradicted this file's own
  // "Default chain is Base."
  //
  // Only writes when the user has NO explicit preference; an existing .chain
  // already wins in getChain() and must not be overwritten.
  const chainBefore = readChainPreference() === null ? getChain() : null;

  const evm = ensureEvmWallet();
  const sol = await getOrCreateSolanaWallet();
  if (sol.isNew) {
    console.error(formatWalletCreatedMessage(sol.address));
  }

  if (chainBefore !== null && getChain() !== chainBefore) {
    // writeAutoChain, NOT setChain: this is the machine preserving continuity,
    // not the user expressing a preference. The distinction is the whole fix —
    // see CHAIN_AUTO_FILE.
    writeAutoChain(chainBefore);
  }

  return {
    base: { address: evm.address, isNew: evm.isNew },
    solana: { address: sol.address, isNew: sol.isNew },
  };
}

/**
 * Guard for the two capabilities the Solana rail genuinely does not serve.
 *
 * WHAT THIS LIST IS FOR. It is a statement about the SOLANA GATEWAY, not about
 * this client, and it must be re-probed rather than assumed. Six tools carried
 * this refusal until 2026-09-05, long after sol.blockrun.ai started serving
 * them; an unpaid 402 probe (which costs nothing — the quote comes back before
 * any signature) settled every case:
 *
 *   POST /v1/audio/generations    402, amount 157500   -> serves; guard removed
 *   POST /v1/audio/speech         402, amount 1000     -> serves; guard removed
 *   POST /v1/audio/sound-effects  402, amount 52501    -> serves; guard removed
 *   POST /v1/realface/enroll      400 (missing `name`) -> serves; guard removed
 *   POST /v1/portrait/enroll      400 (missing `name`) -> serves; guard removed
 *   GET  /v1/defillama/protocols  404                  -> genuine gap; kept
 *   POST /v1/modal/sandbox/create 503 "not configured" -> genuine gap; kept
 *
 * A stale entry here is not harmless: it refuses a call the user has already
 * funded and sends them to switch chains for no reason. Re-probe before adding
 * one, and re-probe before trusting one.
 *
 * Returns null in API-KEY mode regardless of capability: account billing runs
 * against api.blockrun.ai, which serves the whole catalogue over one credential
 * and has no chain at all.
 */
export function baseOnlyMessage(capability: string): string | null {
  if (isApiKeyMode()) return null;
  if (getChain() === "solana") {
    return `${capability} currently supports Base-chain payment only — your active chain is Solana. Switch with: blockrun_wallet action:"chain" chain:"base"  (switch back later with chain:"solana"). Alternatively, API-key billing reaches it on either rail — see ${PORTAL_CREDITS_URL}.`;
  }
  return null;
}

/**
 * Base URL for hand-built gateway requests, WITHOUT a trailing slash, such that
 * `${getApiBase()}/v1/<path>` is always the right URL for the active credential.
 *
 * The three rails do not share a path prefix — the wallet gateways mount the API
 * under /api and the account API mounts it at the root — which is why four tools
 * hardcoding `https://blockrun.ai/api` could not simply have a hostname swapped.
 */
export function getApiBase(): string {
  if (isApiKeyMode()) return getApiKeyBase();
  return getChain() === "solana" ? "https://sol.blockrun.ai/api" : "https://blockrun.ai/api";
}

/**
 * Resolve a `poll_url` handed back by an async job (video, music, image) into an
 * absolute URL on the SAME rail that accepted the submission.
 *
 * This is the sharp edge of multi-rail support. A submitted job is ALREADY PAID;
 * if its poll URL resolves to a different host than the one that took the money,
 * the result can never be collected and the charge is simply lost. The gateway
 * returns a root-relative `/api/v1/...`, so the old
 * `BLOCKRUN_API.replace(/\/api$/, "") + poll_url` reconstruction silently sent
 * every account-mode poll back to the wallet gateway, unauthenticated.
 *
 * Mirrors ApiKeyAuth.resolveUrl in @blockrun/llm: on the account rail the
 * gateway's `/api` prefix is stripped, and an absolute URL pointing at another
 * origin is refused rather than followed with our credential attached.
 */
export function resolveGatewayUrl(pollUrl: string): string {
  const base = getApiBase();
  if (/^https?:\/\//i.test(pollUrl)) {
    const target = new URL(pollUrl);
    const expected = new URL(base);
    if (target.origin !== expected.origin) {
      throw new Error(
        `Refusing to follow a job poll URL to a different origin (${target.origin}); ` +
          `the job was submitted to ${expected.origin}.`,
      );
    }
    return target.href;
  }
  const path = pollUrl.startsWith("/") ? pollUrl : `/${pollUrl}`;
  // The account API serves /v1/... at the root; the wallet gateways serve it
  // under /api. `base` already carries whichever prefix applies, so a poll path
  // that arrives with its own /api prefix must have it removed exactly once.
  const relative = path.startsWith("/api/") ? path.slice("/api".length) : path;
  return `${base}${relative}`;
}

/**
 * A 0x-prefixed 32-byte EVM key. Anything else found in the keychain is
 * ignored rather than handed to viem: privateKeyToAccount THROWS on malformed
 * input, and a corrupted keychain entry must degrade to the file, not take
 * every paid tool down with it.
 */
export function isEvmPrivateKey(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function ensureEvmWallet() {
  if (_evmWalletInfo) return _evmWalletInfo;

  // BLOCKRUN_WALLET_KEY outranks the keychain, matching the SDK's own
  // precedence (env > ~/.blockrun/.session). An operator who exports a key
  // must not be silently overridden by a stale keychain entry from an earlier
  // wallet — that is the same failure the .chain-auto file exists to prevent,
  // and here it would route payments through a wallet the user cannot see.
  // ...and so does the key FILE, whenever it exists. Replacing
  // ~/.blockrun/.session is how a wallet gets rotated or restored from backup,
  // and reading the keychain ahead of an existing file would let a stale entry
  // from the previous wallet shadow the new key silently — every payment then
  // signed by a wallet the user believes they replaced. In auto mode the file
  // is deliberately kept for the CLI/SDK, so it is the shared source of truth
  // and the keychain is only its mirror; the keychain becomes authoritative
  // exactly when the file is gone, which is what strict mode does. Reading it
  // first bought no security in auto mode anyway: the plaintext file is still
  // sitting there for the same attacker to read.
  if (
    !process.env.BLOCKRUN_WALLET_KEY &&
    getKeychainMode() !== "off" &&
    !fs.existsSync(WALLET_FILE_PATH)
  ) {
    const read = keychainRead(EVM_KEY_ACCOUNT);

    if (read.status === "found" && isEvmPrivateKey(read.value)) {
      _evmWalletInfo = {
        address: privateKeyToAccount(read.value).address,
        privateKey: read.value,
        isNew: false,
      };
      return _evmWalletInfo;
    }

    // A read that FAILED is not a read that found nothing. The file is already
    // gone at this point (strict mode retired it), so falling through would
    // hand getOrCreateWallet() an empty slate and mint a BRAND NEW wallet —
    // orphaning a funded one that is very likely still sitting in a keychain we
    // merely could not open (locked, ACL-denied, timed out). Stop instead: a
    // loud error is recoverable, a silently replaced wallet is not.
    if (read.status === "error") {
      throw new Error(
        `Could not read the wallet key from the OS keychain (${read.detail}), and ` +
          `~/.blockrun/.session no longer exists because BLOCKRUN_KEYCHAIN=strict retired it. ` +
          `Refusing to create a new wallet — your existing one is most likely still in the keychain. ` +
          `Unlock the keychain and retry, or set BLOCKRUN_WALLET_KEY to your key.`,
      );
    }

    if (read.status === "found") {
      console.error(
        "[blockrun] Ignoring a malformed EVM key in the OS keychain — falling back to ~/.blockrun/.session.",
      );
    }
  }

  _evmWalletInfo = getOrCreateWallet();
  if (_evmWalletInfo.isNew) {
    console.error(formatWalletCreatedMessage(_evmWalletInfo.address));
  }
  // Mirror into the keychain so the next process reads it from there instead
  // of the plaintext file. No-op unless a keychain exists; only strict mode
  // then retires the file, and only after a verified read-back.
  persistKey(EVM_KEY_ACCOUNT, _evmWalletInfo.privateKey, WALLET_FILE_PATH);
  return _evmWalletInfo;
}

/** Drop the cached EVM wallet. Test seam, mirroring resetSolanaKeyCache(). */
export function resetEvmWalletCache(): void {
  _evmWalletInfo = null;
}

export function getOrCreateWalletKey(): `0x${string}` {
  const info = ensureEvmWallet();
  return info.privateKey as `0x${string}`;
}

// Resolved once per process. buildSolanaClient() is called per-request on the
// non-cached paths (blockrun_chat, modal), and a keychain read spawns a
// subprocess — fine once, not fine on every paid call.
let _solanaKey: string | null | undefined;

/**
 * Solana key precedence, mirroring the EVM path:
 * SOLANA_WALLET_KEY env > ~/.blockrun/.solana-session > OS keychain.
 * The file outranks the keychain so that rotating the wallet by replacing the
 * file is not silently undone by a stale keychain entry; the keychain carries
 * the key only once the file is gone (strict mode). A key found in the file is
 * mirrored into the keychain on the way past.
 */
export function resolveSolanaKey(): string | undefined {
  if (process.env.SOLANA_WALLET_KEY) return process.env.SOLANA_WALLET_KEY;
  if (_solanaKey !== undefined) return _solanaKey ?? undefined;

  // Same precedence correction as the EVM path: an existing .solana-session is
  // the user's current intent, so it outranks whatever the keychain remembers.
  if (getKeychainMode() !== "off" && !fs.existsSync(SOLANA_WALLET_FILE_PATH)) {
    const stored = keychainLoad(SOLANA_KEY_ACCOUNT);
    if (stored) {
      _solanaKey = stored;
      return stored;
    }
  }

  const fromFile = loadSolanaWallet();
  if (fromFile) persistKey(SOLANA_KEY_ACCOUNT, fromFile, SOLANA_WALLET_FILE_PATH);
  _solanaKey = fromFile ?? null;
  return fromFile ?? undefined;
}

/** Drop the cached Solana key. Test seam, and used when the wallet is re-provisioned. */
export function resetSolanaKeyCache(): void {
  _solanaKey = undefined;
}

/**
 * Client options for the ACTIVE credential.
 *
 * The SDK throws when handed both `apiKey` and `privateKey`, which is the
 * behaviour we want mirrored here rather than worked around: there is one payer
 * per process, and a call that could settle from either a prepaid account or a
 * funded wallet depending on which branch ran is a billing bug waiting for a
 * user to find it.
 *
 * The second job of this helper is what it does NOT do. Every factory below
 * used to call getOrCreateWalletKey() eagerly, and that call MINTS a key: it
 * writes ~/.blockrun/.session, mirrors it into the OS keychain, and announces a
 * new wallet on stderr. Someone who set BLOCKRUN_API_KEY and never intends to
 * touch a wallet would have had one created, persisted and stored in their
 * keychain on the first paid call. Resolving credentials lazily, inside the
 * branch that needs them, is the whole point.
 */
function evmClientOptions(timeout?: number): { apiKey: string } | { privateKey: `0x${string}` } {
  const apiKey = getApiKey();
  const base = apiKey ? { apiKey } : { privateKey: getOrCreateWalletKey() };
  return (timeout ? { ...base, timeout } : base) as
    | { apiKey: string }
    | { privateKey: `0x${string}` };
}

function buildSolanaClient(timeout?: number): SolanaLLMClient {
  const apiKey = getApiKey();
  if (apiKey) {
    return new SolanaLLMClient({ apiKey, ...(timeout ? { timeout } : {}) });
  }
  const privateKey = resolveSolanaKey();
  const opts = { ...(privateKey ? { privateKey } : {}), ...(timeout ? { timeout } : {}) };
  return new SolanaLLMClient(Object.keys(opts).length ? opts : undefined);
}

export function getClient(): ApiClient {
  // On the account rail there is no chain to branch on: both SDK clients resolve
  // to the same api.blockrun.ai base with the same Bearer credential. Returning
  // early also keeps getChain() out of the path, and getChain() is not free for
  // a user who has no wallet — its steps 4-6 stat the session files and can
  // spawn a `security` keychain probe, on a machine that was never meant to hold
  // a key at all.
  if (isApiKeyMode()) {
    if (!_evmClient) _evmClient = new LLMClient(evmClientOptions());
    return _evmClient;
  }
  if (getChain() === "solana") {
    if (!_solanaClient) {
      _solanaClient = buildSolanaClient();
    }
    return _solanaClient;
  }
  if (!_evmClient) {
    _evmClient = new LLMClient(evmClientOptions());
  }
  return _evmClient;
}

/**
 * Build a NON-cached client for the active chain with an explicit HTTP timeout.
 * Modal's sandbox/exec is synchronous — the HTTP call blocks for the whole run,
 * which the skill documents at up to 1200s — but the shared getClient() uses the
 * SDK default (600s, via BLOCKRUN_CHAT_TIMEOUT; this comment said 60s until
 * 0.32.1 and was wrong by 10x). A long exec on the shared client would abort,
 * charge nothing, and orphan a live paid sandbox. Modal calls use this instead,
 * so a long timeout never leaks onto the shared client.
 *
 * blockrun_chat also uses this to put a SHORT timeout on the mode:"free"
 * fallback loop — see FREE_MODEL_TIMEOUT_MS. Same mechanism, opposite direction.
 */
export function buildClientWithTimeout(timeoutMs: number): ApiClient {
  if (!isApiKeyMode() && getChain() === "solana") {
    return buildSolanaClient(timeoutMs);
  }
  return new LLMClient(evmClientOptions(timeoutMs));
}

/**
 * A FRESH (non-cached) client for the active chain at the default timeout. Used
 * by blockrun_chat so the per-call getSpending() delta in withSettledCost
 * reflects ONLY that call. The shared singleton's getSpending() is a cumulative
 * counter, so concurrent calls (the MCP SDK dispatches in parallel) would each
 * read the other's settlement in their delta — over-recording spend and
 * misattributing it across agent_ids.
 */
export function buildClient(): ApiClient {
  if (!isApiKeyMode() && getChain() === "solana") return buildSolanaClient();
  return new LLMClient(evmClientOptions());
}

/**
 * Native Anthropic client → BlockRun's `/v1/messages` endpoint, which forwards
 * Claude requests/responses to api.anthropic.com VERBATIM (thinking blocks +
 * signatures + upstream identity headers, zero model substitution, no fallback).
 * This is the ONLY path that surfaces real Anthropic native signals — the
 * OpenAI-compat `/v1/chat/completions` path (LLMClient.chat/chatCompletion)
 * flattens thinking to a string and drops thought signatures entirely.
 * EVM/Base only: AnthropicClient signs x402 payments with the viem wallet key.
 */
export function getAnthropicClient(): AnthropicClient {
  if (!_anthropicClient) {
    _anthropicClient = new AnthropicClient(evmClientOptions());
  }
  return _anthropicClient;
}

export function getImageClient(): ImageClient {
  if (!_imageClient) {
    _imageClient = new ImageClient(evmClientOptions());
  }
  return _imageClient;
}

export function getPriceClient(requireWallet = true): PriceClient {
  if (!requireWallet) {
    if (!_freePriceClient) {
      _freePriceClient = new PriceClient({ requireWallet: false });
    }
    return _freePriceClient;
  }

  if (!_priceClient) {
    _priceClient = new PriceClient(evmClientOptions());
  }
  return _priceClient;
}

export type AccountInfo = {
  address: string | null;
  network: "Base" | "Solana" | "BlockRun account";
  chainId: number | null;
  currency: string;
  isNew: boolean;
  explorerUrl: string | null;
  fundingUrl: string;
};

export async function getWalletInfo(): Promise<AccountInfo> {
  // Account billing has no address, no chain and no explorer page — and asking
  // for one must not CREATE one. Reading blockrun://wallet is a status check;
  // before this branch existed it would have minted an EVM keypair, written it
  // to disk and mirrored it into the OS keychain, for a user who pays by invoice
  // and will never fund it.
  if (isApiKeyMode()) {
    return {
      address: null,
      network: "BlockRun account",
      chainId: null,
      currency: "USD credit",
      isNew: false,
      explorerUrl: null,
      fundingUrl: PORTAL_CREDITS_URL,
    };
  }
  if (getChain() === "solana") {
    const client = getClient() as SolanaLLMClient;
    const address = await client.getWalletAddress();
    return {
      address,
      network: "Solana" as const,
      chainId: null as number | null,
      currency: "USDC",
      isNew: false,
      explorerUrl: `https://solscan.io/account/${address}`,
      fundingUrl: "https://sol.blockrun.ai",
    };
  }
  const info = ensureEvmWallet();
  const links = getPaymentLinks(info.address);
  return {
    address: info.address,
    network: "Base" as const,
    chainId: 8453 as number | null,
    currency: "USDC",
    isNew: info.isNew,
    explorerUrl: links.basescan,
    fundingUrl: links.blockrun,
  };
}

export { formatNeedsFundingMessage };

async function getSolanaUsdcBalance(): Promise<number | null> {
  try {
    return await buildSolanaClient().getBalance();
  } catch { return null; }
}

/**
 * Parse a USDC `balanceOf` eth_call result (hex string) into a USD figure.
 * Returns null for missing/empty ("0x") / non-hex results so the caller can fall
 * through to the next RPC instead of surfacing "$NaN USDC" and skipping the rest
 * of the healthy fallback list. BigInt avoids the >2^53 precision loss of
 * parseInt for very large balances.
 */
export function parseBaseUsdcCallResult(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  return Number(BigInt(raw)) / 1e6;
}

async function getBaseUsdcBalance(address: string): Promise<number | null> {
  const data = {
    jsonrpc: "2.0",
    method: "eth_call",
    params: [{ to: USDC_ADDRESS, data: `0x70a08231000000000000000000000000${address.slice(2)}` }, "latest"],
    id: 1,
  };
  for (const rpcUrl of BASE_RPC_URLS) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(8000),
      });
      const result = await response.json() as { result?: string };
      const usd = parseBaseUsdcCallResult(result.result);
      if (usd !== null) return usd;
    } catch { continue; }
  }
  return null;
}

/** USDC balance for an explicit chain — used to show BOTH wallets at once. */
export async function getChainBalance(chain: "base" | "solana", address: string): Promise<number | null> {
  return chain === "solana" ? getSolanaUsdcBalance() : getBaseUsdcBalance(address);
}

export async function getUsdcBalance(address: string): Promise<number | null> {
  return getChainBalance(getChain(), address);
}
