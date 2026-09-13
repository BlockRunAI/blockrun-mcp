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

test("market-buy preview enforces the live minimum share size", async () => {
  const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 1 });
  assert.equal(res.isError, true);
  assert.match(res.text, /minimum order size of 5 shares/);
  assert.match(res.text, /use at least \$2\.25/i);
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

test("market buy with no ask is rejected instead of producing a fake preview", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5", asks: [], bids: [],
  }));
  try {
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5 });
    assert.equal(res.isError, true);
    assert.match(res.text, /no ask|price a market buy/i);
  } finally {
    mock.restoreAll();
  }
});

test("FOK market-buy preview rejects insufficient ask depth", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.45", size: "5" }], bids: [{ price: "0.44", size: "100" }],
  }));
  try {
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, order_type: "FOK" });
    assert.equal(res.isError, true);
    assert.match(res.text, /cannot fill the full \$5\.00 FOK buy/i);
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

// --- Market orders carry the previewed worst-fill bound (late audit finding) ---
//
// Without a `price`, clob-client-v2 picks the market order's limit itself at
// submit time from a fresh book fetch: the marginal ask for FOK, the top-of-
// array (worst) ask for FAK. The preview showed only the BEST ask, so the user
// consented at "best ask 0.40" and could be signed at 0.99. Now the preview
// walks the book, states the worst fill, and that same number is the signed
// limit — the exchange can never fill worse than what the user saw.

test("a market buy is signed at the previewed worst fill, not an SDK-chosen limit", async () => {
  // Unsorted book, worst level first: the walk must sort best-first.
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.99", size: "1000" }, { price: "0.40", size: "25" }], bids: [{ price: "0.39", size: "100" }],
  }));
  try {
    const preview = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5 });
    assert.equal(preview.isError, undefined, preview.text);
    assert.match(preview.text, /best ask 0\.4\b/);
    assert.match(preview.text, /worst fill ≤ 0\.4\b/);
    assert.equal((preview.structured as { worstFillPrice?: number }).worstFillPrice, 0.4);
    const before = calls.length;
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(calls.length, before + 1);
    const call = calls[calls.length - 1];
    assert.equal(call.kind, "market");
    assert.equal(call.order.price, 0.4, "the signed limit must equal the previewed worst fill");
    assert.equal(call.order.amount, 5);
  } finally {
    mock.restoreAll();
  }
});

test("a thin top level raises the worst fill, and the preview says so before any signature", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.40", size: "5" }, { price: "0.90", size: "100" }], bids: [{ price: "0.39", size: "100" }],
  }));
  try {
    const preview = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5 });
    assert.equal(preview.isError, undefined, preview.text);
    assert.match(preview.text, /best ask 0\.4\b/);
    assert.match(preview.text, /worst fill ≤ 0\.9\b/, "the $3 beyond the top level fills at 0.90");
    assert.match(preview.text, /est\. 8\.3333 shares/);
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(calls[calls.length - 1].order.price, 0.9);
  } finally {
    mock.restoreAll();
  }
});

test("FAK with insufficient depth is signed at the worst level actually consumed, not the SDK's top-of-array", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.45", size: "5" }], bids: [{ price: "0.44", size: "100" }],
  }));
  try {
    const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, order_type: "FAK", confirm: true });
    assert.equal(res.isError, undefined, res.text);
    const call = calls[calls.length - 1];
    assert.equal(call.order.price, 0.45);
    assert.equal(call.order.orderType, "FAK");
  } finally {
    mock.restoreAll();
  }
});

test("a market sell walks the bids: honest est. proceeds, worst bid stated and signed as the floor", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.50", size: "100" }], bids: [{ price: "0.30", size: "100" }, { price: "0.44", size: "3" }],
  }));
  try {
    const preview = await executeTrade({ action: "sell", token_id: "111", size: 5 });
    assert.equal(preview.isError, undefined, preview.text);
    assert.match(preview.text, /best bid 0\.44\b/);
    assert.match(preview.text, /worst fill ≥ 0\.3\b/);
    // 3 × 0.44 + 2 × 0.30 = 1.92 — the old code printed 5 × best bid = $2.20.
    assert.match(preview.text, /est\. \$1\.92/);
    assert.ok(Math.abs(((preview.structured as { notionalUsd: number }).notionalUsd) - 1.92) < 1e-9);
    assert.equal((preview.structured as { worstFillPrice?: number }).worstFillPrice, 0.3);
    const res = await executeTrade({ action: "sell", token_id: "111", size: 5, confirm: true });
    assert.equal(res.isError, undefined, res.text);
    const call = calls[calls.length - 1];
    assert.equal(call.order.price, 0.3, "a sell's signed limit is the previewed worst bid");
    assert.equal(call.order.amount, 5);
  } finally {
    mock.restoreAll();
  }
});

test("a FOK market sell the bid book cannot absorb is refused pre-sign, like the buy side", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "1",
    asks: [{ price: "0.50", size: "100" }], bids: [{ price: "0.44", size: "3" }],
  }));
  try {
    const before = calls.length;
    const res = await executeTrade({ action: "sell", token_id: "111", size: 5, order_type: "FOK", confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /cannot fill the full 5 shares/i);
    assert.equal(calls.length, before, "nothing may be signed");
  } finally {
    mock.restoreAll();
  }
});

// --- the previewed bound, enforced across the preview→confirm boundary ---
//
// "Signed at the worst fill you saw" held within ONE call: the walk that
// produced the preview also set the signed limit. The preview and the confirm
// are two calls, and the confirm re-walks a fresh book — so a book that moved
// in between was signed at a price the card never displayed. It moves against
// you exactly when it matters.

test("a book that moved against the quote is refused, unsigned, when the bound is carried", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.40", size: "25" }], bids: [{ price: "0.39", size: "100" }],
  }));
  const preview = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5 });
  const quoted = (preview.structured as { worstFillPrice: number }).worstFillPrice;
  assert.equal(quoted, 0.4);

  // The cheap level is gone by the time the user clicks Confirm.
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.55", size: "25" }], bids: [{ price: "0.39", size: "100" }],
  }));
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true, max_fill_price: quoted });
  assert.equal(res.isError, true, res.text);
  assert.match(res.text, /book moved/);
  assert.match(res.text, /nothing was charged/i);
  assert.equal((res.structured as { refused?: string }).refused, "worse_than_quoted");
  assert.equal(calls.length, before, "nothing may be signed");
});

test("a book that moved in the user's FAVOUR still places", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.30", size: "25" }], bids: [{ price: "0.29", size: "100" }],
  }));
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true, max_fill_price: 0.4 });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, before + 1, "a better price is not a reason to refuse");
});

test("a sell is bounded the other way — a LOWER fill is the worse one", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.60", size: "100" }], bids: [{ price: "0.45", size: "100" }],
  }));
  const before = calls.length;
  const worse = await executeTrade({ action: "sell", token_id: "111", size: 10, confirm: true, max_fill_price: 0.5 });
  assert.equal(worse.isError, true, worse.text);
  assert.match(worse.text, /book moved/);
  assert.equal(calls.length, before, "nothing signed on a sell below the floor");

  const ok = await executeTrade({ action: "sell", token_id: "111", size: 10, confirm: true, max_fill_price: 0.4 });
  assert.equal(ok.isError, undefined, ok.text);
  assert.equal(calls.length, before + 1);
});

test("without the bound, behaviour is unchanged — the walk stands on its own", async () => {
  mock.method(fakeClob, "getOrderBook", async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.55", size: "25" }], bids: [{ price: "0.39", size: "100" }],
  }));
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "111", amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, before + 1);
});
