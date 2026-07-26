import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMarketRequest } from "../src/utils/markets-validation.js";

test("markets/listings is a live Tier-1 route, not a pre-payment rejection", () => {
  // The gateway still registers, prices, and advertises markets/listings in the
  // x402 manifest (blockrun/src/lib/predexon.ts). Blocking it here would break a
  // paid endpoint the user is being sold.
  assert.equal(validateMarketRequest("markets/listings", { venue: "polymarket" }, undefined), null);
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

test("candlesticks uses integer-minute intervals", () => {
  const path = "polymarket/candlesticks/token/123";
  assert.match(validateMarketRequest(path, { interval: "1h" }, undefined) ?? "", /use '60', not '1h'/i);
  assert.match(validateMarketRequest(path, { interval: "60", start: "1", end: "2" }, undefined) ?? "", /start_time/);
  assert.equal(validateMarketRequest(path, { interval: "60", start_time: "1", end_time: "2" }, undefined), null);
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

test("smart-money requires a meaningful cohort instead of billing a guaranteed 400", () => {
  const path = "polymarket/market/0xabc/smart-money";
  assert.match(validateMarketRequest(path, {}, undefined) ?? "", /min_trades: '100'/);
  assert.equal(validateMarketRequest(path, { window: "30d", min_trades: "100" }, undefined), null);
  assert.equal(validateMarketRequest(path, { min_win_rate: "0.6", min_trades: "50" }, undefined), null);
});

test("unknown paths remain forward compatible", () => {
  assert.equal(validateMarketRequest("future/provider/endpoint", {}, undefined), null);
});
