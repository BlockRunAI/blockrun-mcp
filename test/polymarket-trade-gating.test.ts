// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The money-safety gates around order placement, with the CLOB client mocked:
//   - no confirm:true → dry-run preview, NOTHING signed or submitted
//   - per-order cap (POLYMARKET_MAX_BET_USD) and session cap enforced pre-sign
//   - tick rounding + minimum size applied before submission
//   - the submitted order carries the rounded price / correct market amount
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Call = { kind: "limit" | "market"; order: Record<string, unknown>; options: Record<string, unknown>; orderType: unknown };
const calls: Call[] = [];

// Mutable so individual tests can swap the market response (node:test module
// mocks cannot be re-mocked once installed).
let marketResponse: Record<string, unknown> | null = null;

const fakeClob = {
  getMarket: async (conditionId: string) =>
    marketResponse ?? {
      question: "Will the demo work?",
      condition_id: conditionId,
      tokens: [
        { token_id: "111", outcome: "Yes" },
        { token_id: "222", outcome: "No" },
      ],
      closed: false,
      accepting_orders: true,
    },
  getOrderBook: async () => ({
    tick_size: "0.01",
    neg_risk: false,
    min_order_size: "5",
    asks: [{ price: "0.45", size: "100" }],
    bids: [{ price: "0.44", size: "100" }],
  }),
  createAndPostOrder: async (order: Record<string, unknown>, options: Record<string, unknown>, orderType: unknown) => {
    calls.push({ kind: "limit", order, options, orderType });
    return { success: true, orderID: "0xORDER", status: "matched", transactionsHashes: ["0xTX"] };
  },
  createAndPostMarketOrder: async (order: Record<string, unknown>, options: Record<string, unknown>, orderType: unknown) => {
    calls.push({ kind: "market", order, options, orderType });
    return { success: true, orderID: "0xMKT", status: "matched" };
  },
};

mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => fakeClob,
    checkGeoblock: async () => ({ blocked: false, closedOnly: false, raw: {} }),
    getPolymarketAccount: () => ({ address: "0xEOA0000000000000000000000000000000000000" }),
    resetClobClient: () => {},
  },
});

const { executeTrade, getSessionLedger } = await import("../src/utils/polymarket/orders.js");

test("no confirm → dry-run preview and zero client submissions", async () => {
  const res = await executeTrade({ action: "buy", token_id: "111", price: 0.45, size: 10 });
  assert.equal(res.isError, undefined);
  assert.match(res.text, /DRY RUN/);
  assert.match(res.text, /confirm:true/);
  assert.equal((res.structured as { dryRun?: boolean })?.dryRun, true);
  assert.equal(calls.length, 0, "dry run must not submit anything");
});

test("per-order cap: notional over POLYMARKET_MAX_BET_USD is rejected pre-sign", async () => {
  const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 100, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /POLYMARKET_MAX_BET_USD/);
  assert.equal(calls.length, 0);
});

test("minimum order size enforced from the live book", async () => {
  const res = await executeTrade({ action: "buy", token_id: "111", price: 0.45, size: 2, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /minimum order size/);
  assert.equal(calls.length, 0);
});

test("confirm:true submits a limit BUY with the price floored onto the tick grid", async () => {
  const res = await executeTrade({ action: "buy", token_id: "111", price: 0.456, size: 10, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /Order submitted/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "limit");
  assert.equal(calls[0].order.price, 0.45, "a buy must floor (never sign above the user's limit)");
  assert.equal(calls[0].order.tokenID, "111");
  assert.equal(calls[0].options.negRisk, false);
});

test("condition_id + outcome resolves to the right token; market buy passes dollars", async () => {
  const res = await executeTrade({
    action: "buy",
    condition_id: "0xC0ND",
    outcome: "yes",
    amount_usd: 5,
    confirm: true,
  });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, 2);
  const call = calls[1];
  assert.equal(call.kind, "market");
  assert.equal(call.order.tokenID, "111", "outcome 'yes' must resolve case-insensitively to the Yes token");
  assert.equal(call.order.amount, 5);
});

test("unknown outcome lists the available ones instead of guessing", async () => {
  const res = await executeTrade({
    action: "buy",
    condition_id: "0xC0ND",
    outcome: "Maybe",
    amount_usd: 5,
    confirm: true,
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /Available outcomes: Yes, No/);
});

test("session cap blocks the order that would cross it", async () => {
  const spent = getSessionLedger().totalUsd;
  process.env.POLYMARKET_MAX_SESSION_USD = String(spent + 1);
  try {
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /POLYMARKET_MAX_SESSION_USD/);
  } finally {
    delete process.env.POLYMARKET_MAX_SESSION_USD;
  }
});

test("a failed submit rolls back the reservation (no phantom session spend)", async () => {
  const before = getSessionLedger();
  const failClob = {
    ...fakeClob,
    createAndPostMarketOrder: async () => { throw new Error("network blip"); },
  };
  mock.method(fakeClob, "createAndPostMarketOrder", failClob.createAndPostMarketOrder);
  try {
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true });
    assert.equal(res.isError, true);
    const after = getSessionLedger();
    assert.equal(after.totalUsd, before.totalUsd, "failed order must not consume session budget");
    assert.equal(after.count, before.count, "failed order must not increment the order count");
  } finally {
    mock.restoreAll();
  }
});

test("success:true with an informational errorMsg (delayed) counts as placed", async () => {
  const before = getSessionLedger();
  mock.method(fakeClob, "createAndPostMarketOrder", async () => ({
    success: true,
    errorMsg: "order match delayed due to market conditions",
    status: "delayed",
    orderID: "0xDELAYED",
  }));
  try {
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true });
    assert.equal(res.isError, undefined, res.text);
    assert.match(res.text, /Order submitted/);
    assert.match(res.text, /delayed/);
    assert.equal(getSessionLedger().count, before.count + 1, "a delayed-but-placed order IS counted");
  } finally {
    mock.restoreAll();
  }
});

test("market sell with no bid in the book is rejected, not silently $0-notional", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5", asks: [], bids: [],
  }));
  try {
    const res = await executeTrade({ action: "sell", token_id: "111", size: 100000, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /no bid|price a market sell/i);
  } finally {
    mock.restoreAll();
  }
});

test("closed market is rejected with a redeem hint", async () => {
  marketResponse = { question: "Done?", tokens: [{ token_id: "1", outcome: "Yes" }], closed: true };
  try {
    const res = await executeTrade({ action: "buy", condition_id: "0xC", outcome: "Yes", amount_usd: 5, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /not accepting orders/);
    assert.match(res.text, /redeem/);
  } finally {
    marketResponse = null;
  }
});
