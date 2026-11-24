// Run with: npm test  (tsx --test)
//
// Since 2026-11-23 the gateways serve the on-chain US stock PRICE again (blockrun
// spec OCS): blockrun.ai prices Base, sol.blockrun.ai prices Solana. US history
// and every non-US price/history still answer a pre-payment 501, and the tool
// says so itself before any network call. This file pins the routing decision
// and the wording; handler ordering lives in test/price-behaviour.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { equityNotServedMessage, isOnchainStockPrice, ONCHAIN_STOCK_BASE_USD } from "../src/tools/price.js";
import { withTxFee } from "../src/utils/tx-fee.js";

test("only a US price goes on-chain; history and other markets do not", () => {
  assert.equal(isOnchainStockPrice("price", "stocks", "us"), true);
  assert.equal(isOnchainStockPrice("price", "stocks", undefined), true);
  assert.equal(isOnchainStockPrice("price", "usstock", undefined), true);
  assert.equal(isOnchainStockPrice("history", "stocks", "us"), false);
  assert.equal(isOnchainStockPrice("price", "stocks", "hk"), false);
  assert.equal(isOnchainStockPrice("price", "crypto", undefined), false);
  assert.equal(isOnchainStockPrice("price", "usstock", "hk"), false, "usstock with another market is that market, not US");
  assert.equal(isOnchainStockPrice("list", "stocks", "us"), false);
});

test("the reserve covers the $0.005 the caller signs", () => {
  assert.ok(withTxFee(ONCHAIN_STOCK_BASE_USD) >= 0.005);
});

test("the 501 answer points at what IS served and the free catalog", () => {
  const out = equityNotServedMessage("price", "stocks", "hk");
  assert.match(out, /market "hk"/);
  assert.match(out, /nothing was charged/);
  assert.match(out, /action: "price", category: "stocks", market: "us"/);
  assert.match(out, /action: "list", category: "stocks", market: "hk"/);
  assert.match(out, /hello@blockrun\.ai/);
  assert.doesNotMatch(out, /switch/i);
});

test("usstock history names history and defaults the catalog hint to US", () => {
  const out = equityNotServedMessage("history", "usstock", undefined);
  assert.match(out, /Equity history is not served/);
  assert.match(out, /market: "us"/);
});
