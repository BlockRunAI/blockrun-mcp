// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The CLOB keeps a SERVER-SIDE balance/allowance cache. A deposit wallet can be
// fully funded + approved on-chain (setup verifies both) yet have the exchange
// reject an order with "not enough balance/allowance" because that cache lags —
// setup's warm-up refresh is best-effort, and freshly-bridged pUSD takes a
// moment to register. The buy/sell path must refresh the cache and retry ONCE,
// not surface a false "you're broke" to a funded user.
//
// client.js is mocked with a STATEFUL fake CLOB whose first submit fails on a
// stale cache and succeeds after updateBalanceAllowance is called.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let refreshCalls = 0;
let refreshHeals = true; // does a cache refresh make the next submit succeed?
let submitAttempts = 0;

const fakeClob = {
  getOrderBook: async () => ({
    tick_size: "0.01",
    neg_risk: true,
    min_order_size: "0",
    asks: [{ price: "0.37", size: "1000" }],
    bids: [{ price: "0.36", size: "1000" }],
  }),
  updateBalanceAllowance: async () => {
    refreshCalls += 1;
  },
  createAndPostMarketOrder: async () => {
    submitAttempts += 1;
    const healed = refreshHeals && refreshCalls > 0;
    if (!healed) throw { message: "not enough balance / allowance", status: 400 };
    return { success: true, orderID: "0xORDER", status: "matched", transactionsHashes: ["0xhash"] };
  },
};

mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => fakeClob,
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: null, ip: null, raw: null }),
    getPolymarketAccount: () => ({ address: "0xEOA0000000000000000000000000000000000000" }),
    resetClobClient: () => {},
  },
});

const { executeTrade } = await import("../src/utils/polymarket/orders.js");

beforeEach(() => {
  refreshCalls = 0;
  refreshHeals = true;
  submitAttempts = 0;
});

test("market buy self-heals a stale CLOB balance cache: refresh + retry once", async () => {
  const res = await executeTrade({ action: "buy", token_id: "1", amount_usd: 2, confirm: true });
  assert.notEqual(res.isError, true, res.text);
  assert.match(res.text, /Order submitted/);
  assert.equal(refreshCalls, 1, "should refresh the balance cache exactly once");
  assert.equal(submitAttempts, 2, "should submit, refresh, then submit again");
});

test("a persistent balance rejection is surfaced (retries once, then maps the error)", async () => {
  refreshHeals = false; // refresh doesn't help → the error is genuine
  const res = await executeTrade({ action: "buy", token_id: "1", amount_usd: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /action:"setup"/); // balance mapping, not the Base wallet hint
  assert.equal(refreshCalls, 1, "refresh attempted once");
  assert.equal(submitAttempts, 2, "no infinite retry — exactly two submit attempts");
});
