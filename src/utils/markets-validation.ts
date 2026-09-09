import { hasLabelledServerStatus } from "./errors.js";
import { normalizeClassifyPath } from "./path-safety.js";

/**
 * Smart-wallet CRITERIA — the params that define which wallets count as "smart".
 * `window` is deliberately absent: it scopes the time range, not the cohort, and
 * live probing shows `{ window: "7d" }` alone still 400s while
 * `{ min_trades: "100" }` alone succeeds (window then defaults to all_time).
 */
const SMART_MONEY_CRITERIA = [
  "min_trades",
  "min_volume",
  "min_roi",
  "min_realized_pnl",
  "min_total_pnl",
  "min_win_rate",
  "min_profit_factor",
] as const;
// Gamma-only filter names, i.e. params the Polymarket Gamma API accepts but
// Predexon v2 does not. Kept to exactly that set: `search`, `sort`, `end_after`,
// and `end_before` ARE spec-backed Predexon filters on polymarket/markets{,/keyset}
// (see blockrun/src/lib/predexon.ts POLYMARKET_MARKET_PARAMS), so rejecting them
// here would block valid queries before payment.

const GAMMA_ONLY_MARKET_PARAMS = new Set([
  "active",
  "closed",
  "order",
  "ascending",
]);

/**
 * Reduce a caller-supplied path to the slug the gateway will actually route to,
 * so a rule cannot be stepped around by decorating the path.
 *
 * Every rule below matched a bare, exactly-cased slug, which meant
 * `markets/listings?venue=polymarket`, `Markets/Listings`, `markets//listings`,
 * and a trailing tab all sailed past and settled a payment for the very failure
 * the rule exists to prevent. `normalizeClassifyPath` now does all of it — query
 * string / fragment, a single percent-decode, tab/CR/LF deletion, outer slashes,
 * lowercase — so the tab strip that used to sit here is gone; it was a local
 * patch for a gap that belonged in the shared helper (and that the price tables
 * were left exposed to for two releases as a result).
 *
 * Interior slash runs are collapsed here and ONLY here, as belt-and-braces for
 * rule matching. The note that used to live here — that the price path was
 * exposed to a doubled interior slash — was wrong: probed live 2026-08-13,
 * `phone//numbers/buy`, `phone/numbers//buy` and `//phone/numbers/buy` all 404
 * rather than routing, so the gateway does NOT collapse them and there is no
 * cheap-classification to escape into.
 */
function normalizeMarketPath(rawPath: string): string {
  return normalizeClassifyPath(rawPath).replace(/\/{2,}/g, "/");
}

function numberParam(params: Record<string, string>, key: string): number | undefined {
  if (!(key in params)) return undefined;
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Catch the most expensive, repeatable Predexon request mistakes before an
 * x402 payment is created. This intentionally validates only endpoints whose
 * current contract has caused real paid failures; unknown paths still pass
 * through so the MCP remains forward-compatible with new Predexon routes.
 */
export function validateMarketRequest(
  rawPath: string,
  params: Record<string, string> | undefined,
  body: unknown,
): string | null {
  const path = normalizeMarketPath(rawPath);
  const query = params ?? {};

  // Verified live 2026-07-29: this route settles a payment and THEN returns
  // 410 Gone. The gateway still registers, prices, and advertises it
  // (blockrun/src/lib/predexon.ts), which is what talked me out of this block in
  // 0.33.0 — but the gateway only proxies, and Predexon has retired it upstream.
  // The registry is not evidence that a route still serves.
  if (path === "markets/listings") {
    return "Predexon has retired 'markets/listings' — it returns 410 Gone after settling payment. Use 'markets/search' to discover open venue markets, then resolve the selected Polymarket market with 'polymarket/markets/keyset'. No payment was made.";
  }

  if (path === "markets/search" && query.status === "active") {
    return "markets/search uses params.status:'open', not the Gamma-style value 'active'. No payment was made.";
  }

  if (path === "polymarket/markets" || path === "polymarket/markets/keyset") {
    const unsupported = Object.keys(query).filter((key) => GAMMA_ONLY_MARKET_PARAMS.has(key));
    if (unsupported.length > 0) {
      return `Predexon ${path} does not accept Gamma-only params ${unsupported.map((key) => `'${key}'`).join(", ")}. ` +
        "Use status:'open' instead of active/closed, and 'sort' instead of order/ascending. " +
        "Free-text filtering on this endpoint is 'search' (only markets/search uses 'q'). No payment was made.";
    }
  }

  if (/^polymarket\/candlesticks\/(?:token\/)?[^/]+$/.test(path)) {
    if (body !== undefined) {
      return "Polymarket candlesticks is a GET endpoint. Pass query values in params, not body. No payment was made.";
    }
    // Reject only what is definitively malformed. Verified live: omitting
    // `interval` succeeds (the server has a default), `1440` succeeds, `1h`
    // 422s — but `60` returns a paid 400 on a market where `1440` works. Which
    // integer intervals a given market can serve is data-dependent, so a
    // client-side whitelist of numeric values would block valid calls on some
    // markets and still let paid failures through on others. Only the shape is
    // ours to check.
    //
    // Honest limit: ONE market was probed. "Data-dependent" is an inference, not
    // a finding — "60 is simply unsupported" fits the same evidence. If that is
    // the true rule, letting integers through under-blocks every hourly request.
    // Re-probe a second market before treating this as settled.
    if (query.interval !== undefined && !/^\d+$/.test(query.interval)) {
      return `Polymarket candlesticks interval '${query.interval}' is not a number. It is integer minutes. The minute-equivalent of '1h' is '60', but '60' was observed returning a paid 400 on a market where '1440' (daily) worked — so '1440' is the safer choice if daily resolution is acceptable, and note it is coarser than hourly. Which intervals a market serves varies. Optional start_time/end_time are Unix seconds. No payment was made.`;
    }
    if ("start" in query || "end" in query) {
      return "Polymarket candlesticks uses params.start_time and params.end_time in Unix seconds, not start/end. No payment was made.";
    }
  }

  if (path === "polymarket/orderbooks") {
    const missing = ["token_id", "start_time", "end_time"].filter((key) => !query[key]);
    if (missing.length > 0) {
      return `Polymarket orderbooks requires ${missing.map((key) => `params.${key}`).join(", ")}. start_time/end_time are Unix milliseconds. No payment was made.`;
    }
    const start = numberParam(query, "start_time");
    const end = numberParam(query, "end_time");
    if (start === undefined || end === undefined || !Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
      return "Polymarket orderbooks requires integer Unix-millisecond start_time/end_time with start_time < end_time. No payment was made.";
    }
  }

  // Requires a smart-wallet CRITERION, not merely any param. Verified live:
  // no params 400s, `{ window: "7d" }` alone ALSO 400s, `{ min_trades: "100" }`
  // alone succeeds. Treating `window` as a cohort filter (0.33.0 did) let a
  // guaranteed paid 400 straight through.
  if (/^polymarket\/market\/[^/]+\/smart-money$/.test(path)) {
    // Presence is not enough: `{ min_trades: "" }` is the shape a model emits
    // when it knows the param name but not a value, and it 400s upstream after
    // settling exactly like the unfiltered call. The orderbooks rule above
    // already tests usability this way.
    const hasCriterion = SMART_MONEY_CRITERIA.some((key) => (query[key] ?? "").trim() !== "");
    if (!hasCriterion) {
      const why = "window" in query
        ? "'window' only scopes the time range — it does not define the cohort, and window-only calls are rejected upstream. "
        : "An unfiltered call is rejected upstream. ";
      return `Polymarket smart-money needs a smart-wallet criterion. ${why}` +
        "Verified working: params { min_trades: '100' } (window then defaults to all_time). " +
        `Also accepted, by name symmetry rather than probing: ${SMART_MONEY_CRITERIA.slice(1).map((key) => `'${key}'`).join(", ")}. No payment was made.`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Degraded upstream routes — known to fail, NOT charged
// ---------------------------------------------------------------------------
//
// Every sports/* path has returned a consistent Predexon 500 ("An unexpected
// error occurred") since 2026-08-04 — re-verified live 2026-09-08 (#132). The
// gateway marks them `status: "degraded"` in its predexon.ts: still routed for
// anyone who knows the path, withheld from openapi.json and the x402 manifest,
// and on an upstream 5xx it releases the payment nonce, so nothing settles.
//
// Not a pre-payment block like markets/listings above: that one is a 410 sunset
// and settles before failing, this one is an upstream bug that may recover, and
// the gateway is the authority on whether it has. What we own is the wording.
// The SDK reduced the gateway's "(payment NOT charged)" body to
// `API error after payment: 502`, which asserts a charge that did not happen.
export const DEGRADED_SPORTS_SINCE = "2026-08-04";

// The one remedy that 402s today on both gateways. Verified 2026-09-08 with
// unauthenticated GETs: markets/search?q=, polymarket/events and kalshi/markets
// all quote a 402; bare `markets`, `outcomes/:id` and `matching-markets` were
// removed upstream 2026-08-04 and 404 BEFORE payment ("Unknown Predexon
// endpoint"), and no live /v1/pm route accepts a `league` param — which is what
// 0.48.1 (never released — folded into 0.49.0) shipped as the steer, so it failed on first use.
const SPORTS_REMEDY =
  `For sports odds use "markets/search" with params { q: "NBA" } (every venue in one call), ` +
  `"polymarket/events" with params { search: "NBA" }, or "kalshi/markets".`;

/**
 * The gateway's own words for "the payment nonce was released". Only its
 * `!upstreamResponse.ok` branch releases, and only that branch writes
 * "(payment NOT charged)" / "Upstream provider error" into the body; the
 * catch-all 500 ("Internal server error") deliberately does not release
 * because settle ran in the same try, and a Vercel 504 after settle is
 * text/plain. A 5xx status alone therefore proves nothing about money —
 * the phrase does. Mirrors formatError's `explicitlyUncharged` (errors.ts),
 * which is not exported; kept local so this file owns its own wording.
 */
function carriesUnchargedEvidence(message: string): boolean {
  return /not charged|no charge was made|no payment was made|upstream provider error/i.test(message);
}

export function isDegradedSportsPath(path: string): boolean {
  // Same normalizer as every other rule here (query strip → decode → tab strip),
  // so "sports%2Fcategories" gets the same wording as the plain path.
  const clean = normalizeMarketPath(path);
  return clean === "sports" || clean.startsWith("sports/");
}

/**
 * Returns the full user-facing error text for a sports/* upstream failure, or
 * null when the failure is not the known outage (a 4xx, or a non-sports path)
 * so the caller falls back to the generic formatter.
 *
 * "Nothing was charged" is asserted only when the message carries the
 * gateway's own release evidence. Any other labelled 5xx on a sports path is
 * still the outage — same explanation, same steer — but money is hedged the
 * way formatError hedges a post-payment 501: point at the ledger.
 */
export function describeDegradedSportsFailure(path: string, message: string): string | null {
  if (!isDegradedSportsPath(path)) return null;
  // Same labelled-status rule as formatError, so "501 items" in an upstream
  // 4xx body cannot be mistaken for the outage and sold as "not charged".
  if (!hasLabelledServerStatus(message)) return null;
  const money = carriesUnchargedEvidence(message)
    ? `it released the payment when upstream failed — nothing was charged for this call.`
    : `it releases the payment when upstream fails, but this response does not carry the gateway's ` +
      `"payment NOT charged" confirmation. Check blockrun_wallet action:"report" to see whether this call settled.`;
  return `Error: ${message}\n\n` +
    `Predexon's sports/* routes have returned an upstream 500 on every call since ${DEGRADED_SPORTS_SINCE}. ` +
    `The gateway still routes them but no longer advertises them, and ${money}\n` +
    `Retrying will not help until Predexon repairs the route. ${SPORTS_REMEDY}`;
}
