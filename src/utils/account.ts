// src/utils/account.ts
//
// The account rail's answer to "how much have I got left?".
//
// Wallet mode reads a USDC balance off-chain and prints one number. Account mode
// could not answer the question at all until 2026-09-05 — there was no
// key-authenticated endpoint, so `blockrun_wallet action:"status"` printed a
// local estimate and a dashboard link. GET /v1/credits closes that.

import { fetchWithTimeout } from "./http.js";
import { apiAuthHeaders, getApiKeyBase, PORTAL_CREDITS_URL, PORTAL_KEYS_URL } from "./auth.js";

/**
 * `blocked_reason` is a CODE, not a message — confirmed with the API owner, who
 * also committed to treating the set as append-only and announcing additions.
 *
 * Mapped here rather than printed because the useful half is the remedy, and the
 * remedy differs per code; a server-side message would end up either duplicated
 * or ignored. An UNKNOWN code must never read as "fine" — see describeBlock.
 */
const BLOCK_REASONS: Record<string, string> = {
  ACCOUNT_SUSPENDED:
    `This BlockRun account is suspended. Contact support — topping up will not lift it.`,
  CREDIT_LIMIT_REACHED:
    `This account has reached its credit limit. Settle the outstanding invoice or ask for a higher limit at ${PORTAL_CREDITS_URL}.`,
  BALANCE_EXHAUSTED:
    `This account is out of prepaid credit. Top up at ${PORTAL_CREDITS_URL}.`,
};

export function describeBlock(code: string | null | undefined): string | null {
  if (!code) return null;
  // An unrecognised code degrades to ugly-but-honest rather than silent. Reading
  // an unknown block as "not blocked" is the failure mode that matters: it would
  // send an agent on to a call the proxy has already decided to refuse.
  return BLOCK_REASONS[code] ?? `This account is blocked (${code}). See ${PORTAL_CREDITS_URL}.`;
}

export interface AccountCredit {
  accountId: string;
  billingMode: string;
  currency: string;
  grantedUsd: number | null;
  spentUsd: number | null;
  /** Null on an INVOICED account, where there is no prepaid ceiling to remain of. */
  remainingUsd: number | null;
  blocked: boolean;
  blockedReason: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Read the account's credit state. Throws with an actionable message rather than
 * returning a half-filled object, because every caller is about to render it.
 */
export async function getAccountCredit(timeoutMs = 15_000): Promise<AccountCredit> {
  const response = await fetchWithTimeout(
    `${getApiKeyBase()}/v1/credits`,
    { method: "GET", headers: { ...apiAuthHeaders() } },
    timeoutMs,
  );
  if (response.status === 401) {
    throw new Error(`BLOCKRUN_API_KEY was rejected. Check the key at ${PORTAL_KEYS_URL}.`);
  }
  if (!response.ok) {
    throw new Error(`Could not read account credit (HTTP ${response.status}). See ${PORTAL_CREDITS_URL}.`);
  }
  const d = (await response.json()) as Record<string, unknown>;
  return {
    accountId: typeof d.account_id === "string" ? d.account_id : "unknown",
    billingMode: typeof d.billing_mode === "string" ? d.billing_mode : "unknown",
    currency: typeof d.currency === "string" ? d.currency : "USD",
    grantedUsd: num(d.granted_usd),
    spentUsd: num(d.spent_usd),
    remainingUsd: num(d.remaining_usd),
    blocked: d.blocked === true,
    blockedReason: typeof d.blocked_reason === "string" ? d.blocked_reason : null,
  };
}

/**
 * One human line for the credit state.
 *
 * NEVER `remaining_usd ?? 0`. An invoiced ("ungated") account legitimately has
 * no ceiling, so remaining is null — and defaulting that to zero tells a paying
 * customer in good standing that they are broke. Two independent clients hit
 * this within a day of the endpoint shipping, which is why it is called out here
 * rather than left to the next reader.
 */
export function formatCredit(c: AccountCredit): string {
  if (c.remainingUsd !== null) {
    const of = c.grantedUsd !== null ? ` of $${c.grantedUsd.toFixed(2)} granted` : "";
    return `Credit remaining: $${c.remainingUsd.toFixed(4)}${of}`;
  }
  const spent = c.spentUsd !== null ? `$${c.spentUsd.toFixed(4)}` : "unavailable";
  return `Spent to date: ${spent} (invoiced account — no prepaid ceiling)`;
}
