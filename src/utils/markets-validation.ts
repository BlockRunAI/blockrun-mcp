// Gamma-only filter names, i.e. params the Polymarket Gamma API accepts but
// Predexon v2 does not. Kept to exactly that set: `search`, `sort`, `end_after`,
// and `end_before` ARE spec-backed Predexon filters on polymarket/markets{,/keyset}
// (see blockrun/src/lib/predexon.ts POLYMARKET_MARKET_PARAMS), so rejecting them
// here would block valid queries before payment.

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
const GAMMA_ONLY_MARKET_PARAMS = new Set([
  "active",
  "closed",
  "order",
  "ascending",
]);

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
  const path = rawPath.replace(/^\/+|\/+$/g, "");
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
    if (query.interval !== undefined && !/^\d+$/.test(query.interval)) {
      return `Polymarket candlesticks interval '${query.interval}' is not a number. It is integer minutes — use '1440', not '1h' or '1d'. Which intervals a market can serve varies, so a valid-looking number may still be refused upstream. Optional start_time/end_time are Unix seconds. No payment was made.`;
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
    const hasCriterion = SMART_MONEY_CRITERIA.some((key) => key in query);
    if (!hasCriterion) {
      const why = "window" in query
        ? "'window' only scopes the time range — it does not define the cohort, and window-only calls are rejected upstream. "
        : "An unfiltered call is rejected upstream. ";
      return `Polymarket smart-money needs a smart-wallet criterion. ${why}` +
        "A good general default is params { window: '30d', min_trades: '100' }; " +
        `any of ${SMART_MONEY_CRITERIA.map((key) => `'${key}'`).join(", ")} qualifies. No payment was made.`;
    }
  }

  return null;
}
