import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMarketRequest } from "../src/utils/markets-validation.js";

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
