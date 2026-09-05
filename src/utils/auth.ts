// src/utils/auth.ts
//
// Which credential is this process paying with — an account API key, or a
// wallet signing x402?
//
// This module is deliberately DEPENDENCY-FREE. It is imported by utils/wallet.ts
// (which owns the chain and the SDK clients) and by the four tools that build
// gateway requests by hand, so anything it imported back from wallet.ts would be
// an import cycle across the hottest path in the server.
//
// It exists because "which credential" used to be implicit in five places at
// once — utils/wallet.ts, four `const BLOCKRUN_API = "https://blockrun.ai/api"`
// literals, and utils/solana-402.ts. Chain selection was spread the same way
// once, and the result was six `getChain() !== "base"` refusals that stayed in
// the code for months after the Solana gateway started serving those routes.
// One decision point, or it drifts again.

/**
 * The shape the gateway issues and the SDK validates (`resolveApiKeyAuth` in
 * @blockrun/llm). Kept identical on purpose: a key this module accepts and the
 * SDK rejects would pass our checks and then throw from inside a paid call.
 */
const API_KEY_PATTERN = /^brk_[A-Za-z0-9_-]+$/;

/** Account API. Overridable for staging via BLOCKRUN_API_BASE_URL. */
export const DEFAULT_API_KEY_BASE = "https://api.blockrun.ai";

/** Where a human goes to mint a key, add credit, and read the real ledger. */
export const PORTAL_URL = "https://user.blockrun.ai";
export const PORTAL_KEYS_URL = `${PORTAL_URL}/dashboard/keys`;
export const PORTAL_CREDITS_URL = `${PORTAL_URL}/dashboard/credits`;
export const PORTAL_ACTIVITY_URL = `${PORTAL_URL}/dashboard/activity`;

export type AuthMode = "api-key" | "wallet";

// Resolved once per process. getAuthMode() is consulted on every paid call and
// on both hot display paths, and the validation below should not re-run per call.
let _apiKey: string | null | undefined;

/**
 * The account API key, or undefined when this process pays from a wallet.
 *
 * A MALFORMED key THROWS rather than falling back to the wallet. Falling back
 * silently is how someone who believes they are spending prepaid credit starts
 * spending USDC out of a wallet instead — the same class of silent-substitution
 * bug that ~/.blockrun/.chain-auto exists to prevent, and the one that costs
 * real money rather than merely confusing someone.
 */
export function getApiKey(): string | undefined {
  if (_apiKey !== undefined) return _apiKey ?? undefined;

  const raw = process.env.BLOCKRUN_API_KEY?.trim();
  if (!raw) {
    _apiKey = null;
    return undefined;
  }
  if (!API_KEY_PATTERN.test(raw)) {
    throw new Error(
      `BLOCKRUN_API_KEY is not a valid BlockRun API key (expected brk_…). ` +
        `Create one at ${PORTAL_KEYS_URL}, or unset BLOCKRUN_API_KEY to pay from a wallet instead.`,
    );
  }
  _apiKey = raw;
  return raw;
}

export function getAuthMode(): AuthMode {
  return getApiKey() ? "api-key" : "wallet";
}

/** True when this process bills an account rather than signing x402 payments. */
export function isApiKeyMode(): boolean {
  return getAuthMode() === "api-key";
}

/**
 * Base URL for the account API, WITHOUT a trailing slash and without `/v1`.
 *
 * Mirrors the SDK's own normalisation so an operator can set either
 * `https://api.blockrun.ai` or `https://api.blockrun.ai/v1` and get the same
 * result — the SDK accepts the OpenAI-style base, and a base that behaved
 * differently here than inside @blockrun/llm would split one deployment across
 * two hosts.
 */
export function getApiKeyBase(): string {
  const configured = process.env.BLOCKRUN_API_BASE_URL?.trim();
  const base = configured || DEFAULT_API_KEY_BASE;
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Authorization header for hand-built gateway requests. Empty in wallet mode,
 * where the credential is a signature on the retried request rather than a header.
 */
export function apiAuthHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * The message a wallet-only capability returns when the process is on API-key
 * billing — or null when there is nothing to refuse.
 *
 * Wallet-only means "needs a keypair we control", not "needs money": placing a
 * Polymarket order signs on-chain, and a USDC balance is a property of an
 * address. Account credit cannot stand in for either.
 */
export function requireWalletMode(capability: string): string | null {
  if (!isApiKeyMode()) return null;
  return (
    `${capability} needs wallet mode — it signs on-chain or reads a wallet address, ` +
    `and this server is on API-key account billing.\n\n` +
    `To use it: unset BLOCKRUN_API_KEY and restart, then fund the wallet with USDC.\n` +
    `Account credit and usage stay at ${PORTAL_CREDITS_URL}.`
  );
}

/** Test seam — clears the memoized key so a test can change the environment. */
export function resetAuthCache(): void {
  _apiKey = undefined;
}
