import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDegradedSportsFailure, isDegradedSportsPath, validateMarketRequest } from "../src/utils/markets-validation.js";

test("markets/listings is retired upstream and blocked before payment", () => {
  // Verified live 2026-07-29: settles payment, THEN returns 410 Gone. The
  // gateway still registers and prices it, but the gateway only proxies —
  // registry presence is not evidence that a route still serves.
  assert.match(validateMarketRequest("markets/listings", { venue: "polymarket" }, undefined) ?? "", /410 Gone/);
});

test("Gamma-only market discovery params are rejected before payment", () => {
  assert.match(validateMarketRequest("markets/search", {
    q: "Bitcoin", status: "active",
  }, undefined) ?? "", /status:'open'/);

  assert.match(validateMarketRequest("polymarket/markets", {
    active: "true", closed: "false", order: "liquidity", ascending: "false",
  }, undefined) ?? "", /Gamma-only params/);

  assert.equal(validateMarketRequest("polymarket/markets/keyset", {
    condition_id: "0xabc", status: "open", limit: "5",
  }, undefined), null);
});

test("Predexon's own filters on polymarket/markets are not mistaken for Gamma params", () => {
  // search / sort / end_after / end_before are spec-backed POLYMARKET_MARKET_PARAMS.
  // Rejecting them blocked exactly the query the demo needs: open BTC markets
  // ending after a date, sorted by liquidity.
  for (const path of ["polymarket/markets", "polymarket/markets/keyset"]) {
    assert.equal(validateMarketRequest(path, {
      search: "Bitcoin", status: "open", sort: "liquidity",
      end_after: "1785000000", end_before: "1790000000", limit: "20",
    }, undefined), null, `${path} should accept Predexon's documented filters`);
  }
});

test("candlesticks rejects a malformed interval but does not whitelist numbers", () => {
  const path = "polymarket/candlesticks/token/123";
  assert.match(validateMarketRequest(path, { interval: "1h" }, undefined) ?? "", /not a number/i);
  assert.match(validateMarketRequest(path, { interval: "1d" }, undefined) ?? "", /not a number/i);
  // Verified live: 1440 works where 60 returns a paid 400 on the SAME market,
  // so which integers serve is data-dependent and not ours to guess.
  assert.equal(validateMarketRequest(path, { interval: "1440" }, undefined), null);
  assert.equal(validateMarketRequest(path, { interval: "60" }, undefined), null);
  assert.match(validateMarketRequest(path, { interval: "60", start: "1", end: "2" }, undefined) ?? "", /start_time/);
  assert.equal(validateMarketRequest(path, { interval: "60", start_time: "1", end_time: "2" }, undefined), null);

  // "1h" failing is observed. "interval is mandatory" is not — the endpoint may
  // well have a server-side default, and we must not bill a client-side 400 for it.
  assert.equal(validateMarketRequest(path, {}, undefined), null);
  assert.equal(validateMarketRequest(path, { start_time: "1", end_time: "2" }, undefined), null);
});

test("historical orderbooks require a valid millisecond range", () => {
  assert.match(validateMarketRequest("polymarket/orderbooks", { token_id: "123" }, undefined) ?? "", /start_time/);
  assert.match(validateMarketRequest("polymarket/orderbooks", {
    token_id: "123", start_time: "2000", end_time: "1000",
  }, undefined) ?? "", /start_time < end_time/);
  assert.equal(validateMarketRequest("polymarket/orderbooks", {
    token_id: "123", start_time: "1000", end_time: "2000",
  }, undefined), null);
});

test("smart-money requires a wallet criterion, and window alone is not one", () => {
  const path = "polymarket/market/0xabc/smart-money";
  assert.match(validateMarketRequest(path, {}, undefined) ?? "", /min_trades: '100'/);

  // Verified live: window-only 400s upstream. 0.33.0 counted `window` as a
  // cohort filter and let that paid failure through.
  const windowOnly = validateMarketRequest(path, { window: "7d" }, undefined) ?? "";
  assert.match(windowOnly, /only scopes the time range/);

  // Verified live: min_trades alone succeeds (window defaults to all_time).
  assert.equal(validateMarketRequest(path, { min_trades: "100" }, undefined), null);
  assert.equal(validateMarketRequest(path, { window: "30d", min_trades: "100" }, undefined), null);
  // Magnitudes stay unvalidated — a narrower cohort is legitimate.
  assert.equal(validateMarketRequest(path, { min_trades: "20" }, undefined), null);
  assert.equal(validateMarketRequest(path, { min_roi: "0.05" }, undefined), null);
});

test("unknown paths remain forward compatible", () => {
  assert.equal(validateMarketRequest("future/provider/endpoint", {}, undefined), null);
});

test("a decorated path cannot step around a rule", () => {
  // Every rule matched a bare, exactly-cased slug, so these all sailed past and
  // settled a payment for the exact failure the rule exists to prevent. The
  // gateway router ignores query strings, fragments, casing, slash runs, and
  // control characters when matching, so validation has to as well.
  for (const path of [
    "markets/listings?venue=polymarket",
    "Markets/Listings",
    "markets//listings",
    "markets/listings#x",
    "markets/listings\t",
    "/markets/listings/",
  ]) {
    assert.match(
      validateMarketRequest(path, {}, undefined) ?? "",
      /410 Gone/,
      `${JSON.stringify(path)} must not bypass the retired-route block`,
    );
  }

  assert.match(
    validateMarketRequest("polymarket/market/0xabc/smart-money?window=7d", {}, undefined) ?? "",
    /smart-wallet criterion/,
  );
  assert.match(
    validateMarketRequest("POLYMARKET/ORDERBOOKS", {}, undefined) ?? "",
    /token_id/,
  );
});

test("every smart-money criterion is honoured, and an unusable value is not one", () => {
  const path = "polymarket/market/0xabc/smart-money";
  // Without this loop, dropping 5 of the 7 entries kept the whole suite green.
  for (const key of [
    "min_trades", "min_volume", "min_roi", "min_realized_pnl",
    "min_total_pnl", "min_win_rate", "min_profit_factor",
  ]) {
    assert.equal(
      validateMarketRequest(path, { [key]: "1" }, undefined), null,
      `${key} should satisfy the criterion requirement`,
    );
  }
  // Presence is not usability — these 400 upstream exactly like no filter.
  for (const q of [{ min_trades: "" }, { min_roi: "   " }] as Array<Record<string, string>>) {
    assert.match(validateMarketRequest(path, q, undefined) ?? "", /smart-wallet criterion/);
  }
});

test("a non-Polymarket candlestick route keeps its own interval format", () => {
  // Binance klines take "1h" natively; applying the digits-only rule there
  // would be a pure over-block.
  assert.equal(validateMarketRequest("binance/candles/BTCUSDT", { interval: "1h" }, undefined), null);
});

// --- sports/* is degraded upstream (Predexon 500 since 2026-08-04), not charged ---

test("sports paths are recognised, decorated or not", () => {
  assert.equal(isDegradedSportsPath("sports/categories"), true);
  assert.equal(isDegradedSportsPath("/sports/markets"), true);
  assert.equal(isDegradedSportsPath("SPORTS/outcomes/abc"), true);
  assert.equal(isDegradedSportsPath("sportsbook/markets"), false);
  assert.equal(isDegradedSportsPath("polymarket/markets"), false);
});

// The gateway's release branch (pm route.ts, `!upstreamResponse.ok && status>=500`)
// is the ONLY path that releases the payment nonce, and it says so in the body:
// "(payment NOT charged)". @blockrun/llm 3.15.1 carries that through as `detail`,
// so when the evidence exists it is IN the message. Only then may we assert it.
const RELEASE_BRANCH_502 = "API error after payment: 502\nUpstream provider error\nPredexon 500: An unexpected error occurred (payment NOT charged)";

test("a sports 5xx that carries the gateway's release evidence says nothing was charged", () => {
  const out = describeDegradedSportsFailure("sports/categories", RELEASE_BRANCH_502);
  assert.ok(out);
  assert.match(out, /since 2026-08-04/);
  assert.match(out, /nothing was charged/);
  assert.doesNotMatch(out, /whether this call settled/);
  assert.doesNotMatch(out, /temporary API issue/);
});

test("the sports remedy points at routes that 402 today, and never at `league`", () => {
  // Verified live 2026-09-08 (unauthenticated GET, no payment header):
  //   /v1/pm/markets?league=NBA   → 404 Unknown Predexon endpoint (removed 2026-08-04)
  //   /v1/pm/outcomes/x           → 404
  //   /v1/pm/markets/search?q=NBA → 402  (the only canonical-layer survivor)
  //   /v1/pm/polymarket/events    → 402  (free-text filter is `search`, not `league`)
  //   /v1/pm/kalshi/markets       → 402
  // No live /v1/pm route accepts a `league` param. an unreleased 0.48.1 draft shipped a remedy that
  // 404'd on first use; this pins the replacement.
  const out = describeDegradedSportsFailure("sports/markets", RELEASE_BRANCH_502) ?? "";
  assert.match(out, /markets\/search/);
  assert.match(out, /\{ q: "NBA" \}/);
  assert.match(out, /polymarket\/events/);
  assert.match(out, /\{ search: "NBA" \}/);
  assert.doesNotMatch(out, /league/);
  assert.doesNotMatch(out, /path "markets" /, "bare `markets` was removed upstream 2026-08-04 and 404s");
  assert.doesNotMatch(out, /outcomes\//, "outcomes/:id was removed upstream 2026-08-04 and 404s");
});

test("a sports 5xx WITHOUT the gateway's evidence hedges instead of asserting no charge", () => {
  // Two real shapes the status-range gate alone cannot tell from the release
  // branch: the gateway's own catch-all (500 "Internal server error", which
  // deliberately does NOT release because settle ran in the same try) and a
  // Vercel 504 after settle (text/plain, so the SDK reduces it to "Request
  // failed"). Both are the ambiguous case the gateway itself refuses to call
  // uncharged; so must we. Same hedge formatError uses for a post-payment 501.
  for (const message of [
    "API error after payment: 500\nInternal server error",
    "API error after payment: 504\nRequest failed",
    "API error after payment: 502\nRequest failed", // pre-3.15.1 SDK shape: evidence stripped, so unknown
  ]) {
    const out = describeDegradedSportsFailure("sports/categories", message);
    assert.ok(out, `${JSON.stringify(message)} is still the sports outage and should get the sports wording`);
    assert.match(out, /since 2026-08-04/);
    assert.match(out, /blockrun_wallet action:"report" to see whether this call settled/);
    assert.doesNotMatch(out, /nothing was charged/, `${JSON.stringify(message)} carries no proof of release`);
    assert.match(out, /markets\/search/, "the steer is the same either way");
    assert.doesNotMatch(out, /temporary API issue/);
  }
});

test("each of the gateway's uncharged phrasings is accepted as evidence, case-insensitively", () => {
  for (const evidence of [
    "payment NOT charged",
    "not charged",
    "No charge was made",
    "no payment was made",
    "Upstream provider error", // the 502 body the release branch emits even when detail is dropped
  ]) {
    const out = describeDegradedSportsFailure("sports/markets/abc", `API error after payment: 502\n${evidence}`) ?? "";
    assert.match(out, /nothing was charged/, `${JSON.stringify(evidence)} is the gateway's own release wording`);
  }
});

test("a sports 4xx is the caller's problem and falls through to the generic formatter", () => {
  assert.equal(describeDegradedSportsFailure("sports/markets", "API error after payment: 400\nMissing league"), null);
});

test("a non-sports 5xx falls through to the generic formatter", () => {
  assert.equal(describeDegradedSportsFailure("polymarket/markets", "API error after payment: 502\nRequest failed"), null);
});

test("sports paths are still routed — no pre-payment block, the gateway decides", () => {
  assert.equal(validateMarketRequest("sports/categories", undefined, undefined), null);
});

test("an incidental 5xx-shaped number in a sports 4xx body is not the outage", () => {
  assert.equal(describeDegradedSportsFailure("sports/markets", "API error after payment: 400\nbatch of 501 items rejected"), null);
});

test("a percent-encoded sports path gets the same wording as the plain one", () => {
  assert.equal(isDegradedSportsPath("sports%2Fcategories"), true);
  assert.equal(isDegradedSportsPath("sports/categories?league=NBA"), true);
});
