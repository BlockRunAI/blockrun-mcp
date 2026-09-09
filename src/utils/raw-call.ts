// src/utils/raw-call.ts
//
// One entry point for the path-based tools (search, exa, surf, markets, rpc,
// defi, phone, modal), so each of them stops choosing a rail for itself.
//
// WHY THIS EXISTS RATHER THAN "just call the SDK". On the account rail there is
// no x402 to perform: no quote to read, nothing to sign, no retry-after-payment.
// The SDK's requestWithPaymentRaw degrades to a fetch with a Bearer header —
// which utils/api-key-call.ts already does, and does better, because it reads
// the `x-blockrun-cost-usd` response header while the SDK parses the body and
// discards the response. Routing account calls around the SDK is therefore not
// a workaround; it is the shorter path, and it is the only one that can tell a
// caller what the call actually cost.
//
// The wallet rails keep going through the SDK unchanged, because there the 402
// dance is real work worth not reimplementing.

import { isApiKeyMode } from "./auth.js";
import { apiKeyGet, apiKeyPost } from "./api-key-call.js";
import { getChain } from "./wallet.js";
import { OBSERVED_GATEWAY_TX_FEE_USD, TRANSACTION_FEE_USD } from "./tx-fee.js";

/** The two raw methods every path-based tool already depends on. */
export type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

export interface RawCallResult {
  data: unknown;
  /**
   * Actual settled cost, or null when unknown.
   *
   * Null on every wallet call — the SDK does not surface the 402's settled
   * amount through these two methods — and on account calls the gateway did not
   * price at response time. Callers hand it to recordActualSpend, which falls
   * back to the pre-call estimate for null, so a missing figure degrades to
   * today's behaviour rather than to a booked zero.
   */
  paidUsd: number | null;
}

/** GET a rooted endpoint on whichever rail is active. */
export async function rawGet(
  client: RawClient,
  endpoint: string,
  params?: Record<string, string>,
): Promise<RawCallResult> {
  if (isApiKeyMode()) {
    const { data, paidUsd } = await apiKeyGet(endpoint, params);
    return { data, paidUsd };
  }
  return { data: await client.getWithPaymentRaw(endpoint, params), paidUsd: null };
}

/** POST a rooted endpoint on whichever rail is active. */
export async function rawPost(
  client: RawClient,
  endpoint: string,
  body: unknown,
): Promise<RawCallResult> {
  if (isApiKeyMode()) {
    const { data, paidUsd } = await apiKeyPost(endpoint, (body ?? {}) as Record<string, unknown>);
    return { data, paidUsd };
  }
  return { data: await client.requestWithPaymentRaw(endpoint, body), paidUsd: null };
}

/**
 * What to BOOK when the rail reports no settled figure.
 *
 * The gate and the ledger are deliberately different numbers — tx-fee.ts says
 * so at length — and until now exactly one file honoured it. Every path tool
 * passed its RESERVE (base + TRANSACTION_FEE_USD, 0.002, rounded against us on
 * purpose) as recordActualSpend's fallback, and on the wallet rail there is
 * never a settled figure to override it, so the ledger booked the reserve.
 *
 * Measured with unauthenticated 402 probes on 2026-09-09, no payment header:
 *
 *   route                     reserved   Base charge   Solana charge
 *   rpc/ethereum (single)     $0.0040    $0.0030       $0.0020
 *   pm/*                      $0.0095    $0.0085       $0.0075
 *   phone/lookup              $0.0120    $0.0110       $0.0100
 *   search (max_results=10)   $0.2645    $0.2635       $0.2625
 *
 * On Solana — the default chain since 0.46.0 — that is $0.002 of invented spend
 * per call: an agent capped at $1.00 making only rpc calls was cut off after 250
 * of them having actually spent $0.50, and action:"report" showed $1.00. The
 * account rail bills the base with no fee at all.
 *
 * Reserving high stays. This only converts a reserve into what the gateway is
 * observed to charge, for the LEDGER.
 */
export function ledgerFallback(reservedUsd: number): number {
  if (!(reservedUsd > 0)) return 0;
  // withTxFee() adds exactly one fee, whatever the route's per-element maths.
  const base = Math.max(0, reservedUsd - TRANSACTION_FEE_USD);
  if (isApiKeyMode() || getChain() === "solana") return base;
  // Never book more than was reserved. Structural, not incidental: a reserve
  // smaller than one fee would otherwise book a fee with no base under it.
  return Math.min(reservedUsd, base + OBSERVED_GATEWAY_TX_FEE_USD);
}
