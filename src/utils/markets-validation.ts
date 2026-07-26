const CANDLE_INTERVALS = new Set(["0", "1", "5", "15", "60", "1440"]);
const GAMMA_STYLE_MARKET_PARAMS = new Set([
  "active",
  "closed",
  "order",
  "ascending",
  "search",
  "end_after",
  "end_before",
  "sort",
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

  if (path === "markets/listings") {
    return "Predexon no longer exposes 'markets/listings' in its current API. Use 'markets/search' to discover open venue markets, then resolve the selected Polymarket market with 'polymarket/markets/keyset'. No payment was made.";
  }

  if (path === "markets/search" && query.status === "active") {
    return "markets/search uses params.status:'open', not the Gamma-style value 'active'. No payment was made.";
  }

  if (path === "polymarket/markets" || path === "polymarket/markets/keyset") {
    const unsupported = Object.keys(query).filter((key) => GAMMA_STYLE_MARKET_PARAMS.has(key));
    if (unsupported.length > 0) {
      return `Predexon ${path} does not accept Gamma-style params ${unsupported.map((key) => `'${key}'`).join(", ")}. ` +
        "Discover by text with markets/search params { q, status:'open', venue:'polymarket', limit }, then resolve with " +
        "polymarket/markets/keyset params { condition_id, status:'open', limit }. No payment was made.";
    }
  }

  if (/^polymarket\/candlesticks\/(?:token\/)?[^/]+$/.test(path)) {
    if (body !== undefined) {
      return "Polymarket candlesticks is a GET endpoint. Pass query values in params, not body. No payment was made.";
    }
    if (!query.interval || !CANDLE_INTERVALS.has(query.interval)) {
      return "Polymarket candlesticks requires params.interval in integer minutes: '0', '1', '5', '15', '60', or '1440' (use '60', not '1h'). Optional start_time/end_time are Unix seconds. No payment was made.";
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

  if (/^polymarket\/market\/[^/]+\/smart-money$/.test(path)) {
    const minTrades = numberParam(query, "min_trades") ?? 0;
    const strongFilter =
      (numberParam(query, "min_realized_pnl") ?? 0) >= 1_000 ||
      (numberParam(query, "min_total_pnl") ?? 0) >= 1_000 ||
      (numberParam(query, "min_roi") ?? 0) >= 0.15 ||
      minTrades >= 100 ||
      (numberParam(query, "min_volume") ?? 0) >= 10_000;
    const qualityFilter =
      ("min_win_rate" in query || "min_profit_factor" in query) && minTrades >= 50;
    if (!strongFilter && !qualityFilter) {
      return "Polymarket smart-money requires a meaningful cohort filter. For a general demo use params { window: '30d', min_trades: '100' }; alternatives include min_realized_pnl >= 1000, min_total_pnl >= 1000, min_roi >= 0.15, or min_volume >= 10000. No payment was made.";
    }
  }

  return null;
}
