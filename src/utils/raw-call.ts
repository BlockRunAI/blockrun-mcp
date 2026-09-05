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
