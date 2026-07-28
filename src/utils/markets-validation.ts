const CANDLE_INTERVALS = new Set(["0", "1", "5", "15", "60", "1440"]);
// Gamma-only filter names, i.e. params the Polymarket Gamma API accepts but
// Predexon v2 does not. Kept to exactly that set: `search`, `sort`, `end_after`,
// and `end_before` ARE spec-backed Predexon filters on polymarket/markets{,/keyset}
// (see blockrun/src/lib/predexon.ts POLYMARKET_MARKET_PARAMS), so rejecting them
// here would block valid queries before payment.
const SMART_MONEY_FILTERS = [
  "window",
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
    // Only validate the VALUE, and only when one is supplied. "1h" is a known
    // paid failure; whether the endpoint requires `interval` at all is not
    // established, so omitting it must not be rejected client-side.
    if (query.interval !== undefined && !CANDLE_INTERVALS.has(query.interval)) {
      return `Polymarket candlesticks interval '${query.interval}' is not valid. Use integer minutes: '0', '1', '5', '15', '60', or '1440' (so '60', not '1h'). Optional start_time/end_time are Unix seconds. No payment was made.`;
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

  // The observed paid failure was an UNFILTERED smart-money call. Require some
  // cohort filter, but don't invent magnitudes: thresholds like "min_trades >=
  // 100" were never verified against the API and would reject legitimate
  // narrower cohorts (a 20-trade window, a 7d lookback) with no way to override.
  if (/^polymarket\/market\/[^/]+\/smart-money$/.test(path)) {
    const hasCohortFilter = SMART_MONEY_FILTERS.some((key) => key in query);
    if (!hasCohortFilter) {
      return "Polymarket smart-money needs at least one cohort filter — an unfiltered call is rejected upstream. A good general default is params { window: '30d', min_trades: '100' }; " +
        `any of ${SMART_MONEY_FILTERS.map((key) => `'${key}'`).join(", ")} also works. No payment was made.`;
    }
  }

  return null;
}
