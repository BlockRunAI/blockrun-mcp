// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Pure/early-return behavior of the trading module: tick rounding, cross-field
// validation (which must reject BEFORE any client/signing work), and the CLOB
// error taxonomy. client.js is mocked so a validation bug that reaches the
// client fails loudly here instead of hitting the network.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => {
      throw new Error("getClobClient must not be reached by early-validation tests");
    },
    checkGeoblock: async () => ({ blocked: null, closedOnly: null, raw: null }),
    getPolymarketAccount: () => ({ address: "0xEOA0000000000000000000000000000000000000" }),
    resetClobClient: () => {},
  },
});

const { roundToTick, mapClobError, executeTrade } = await import("../src/utils/polymarket/orders.js");

test("roundToTick rounds conservatively by side (buy down, sell up)", () => {
  // Buys floor onto the grid so the signed price never beats the user's limit.
  assert.equal(roundToTick(0.4567, "0.01", "buy"), 0.45);
  assert.equal(roundToTick(0.4567, "0.001", "buy"), 0.456);
  assert.equal(roundToTick(0.4567, "0.1", "buy"), 0.4);
  assert.equal(roundToTick(0.4567, "0.0001", "buy"), 0.4567);
  // Sells ceil onto the grid (also never worse than the user's limit).
  assert.equal(roundToTick(0.4567, "0.01", "sell"), 0.46);
  assert.equal(roundToTick(0.4531, "0.01", "sell"), 0.46);
  assert.equal(roundToTick(0.45, "0.01", "sell"), 0.45); // exact tick unchanged
  // A sub-tick buy floors to 0 → the caller's range check rejects it, rather
  // than silently lifting it to a full tick (the issue-#65-adjacent bug).
  assert.equal(roundToTick(0.0051, "0.01", "buy"), 0);
  // Default side is buy; no floating-point residue.
  assert.equal(roundToTick(0.29999999, "0.01"), 0.29);
  assert.equal(roundToTick(0.3, "0.01", "buy"), 0.3);
});

test("cross-field validation rejects before any client work", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: "buy", token_id: "1", price: 0.5 }, /price and size/],
    [{ action: "buy", token_id: "1" }, /amount_usd/],
    [{ action: "sell", token_id: "1" }, /size/],
    [{ action: "buy", token_id: "1", price: 0.5, size: 10, order_type: "GTD" }, /expires_at/],
    [{ action: "buy", token_id: "1", price: 0.5, size: 10, order_type: "FOK" }, /market-order types/],
    [{ action: "buy", token_id: "1", amount_usd: 5, order_type: "GTC" }, /limit price/],
  ];
  for (const [input, expected] of cases) {
    const res = await executeTrade(input as never);
    assert.equal(res.isError, true, `expected error for ${JSON.stringify(input)}`);
    assert.match(res.text, expected);
  }
});

test("mapClobError: geoblock 403 gives egress options", async () => {
  const text = await mapClobError({ message: "Request failed with status code 403", status: 403 });
  assert.match(text, /geoblock|restricted|close-only/i);
  assert.match(text, /POLYMARKET_CLOB_PROXY/);
});

test("mapClobError: issue-#65 creds mismatch points at re-derive + sig-0 fallback", async () => {
  const text = await mapClobError({
    message: "the order signer address has to be the address of the API KEY",
    status: 400,
  });
  assert.match(text, /re-derived|setup/i);
  assert.match(text, /POLYMARKET_SIG_TYPE=0/);
  assert.match(text, /issue #65/);
});

test("mapClobError: balance/allowance points at setup, NOT the Base wallet", async () => {
  const text = await mapClobError({ message: "not enough balance / allowance", status: 400 });
  assert.match(text, /action:"setup"/);
  assert.doesNotMatch(text, /blockrun_wallet|Base network/);
});

test("mapClobError: EOA maker rejection points at the deposit-wallet flow", async () => {
  const text = await mapClobError({
    message: "maker address not allowed, please use the deposit wallet flow",
    status: 400,
  });
  assert.match(text, /deposit-wallet|deposit wallet flow/i);
  assert.match(text, /POLYMARKET_RELAYER_API_KEY/);
});

test("mapClobError: resolved market suggests positions/redeem; FOK suggests FAK", async () => {
  assert.match(await mapClobError({ message: "market is closed" }), /positions.*redeem/s);
  assert.match(await mapClobError({ message: "FOK order not filled" }), /FAK|limit order/);
});
