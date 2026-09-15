// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The previewed worst fill is the DEFAULT bound at confirm (audit round 3,
// C39). Before this, the cross-call bound existed only as an opt-in
// `max_fill_price`, and the documented agent flow — preview through
// blockrun_polymarket_read, quote the user "at most 40¢", re-call
// blockrun_polymarket with confirm:true — never passed it: the confirm
// re-walked a fresh book and signed at whatever it found, the price the user
// had explicitly not consented to. Only the MCP-Apps order card carried the
// bound. Now the preview records its worst fill per (token, side) and a bare
// confirm is held to it; a moved book refuses and says to re-preview.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Call = { kind: "limit" | "market"; order: Record<string, unknown> };
const calls: Call[] = [];
let asks: Array<{ price: string; size: string }> = [{ price: "0.40", size: "100" }];
let bids: Array<{ price: string; size: string }> = [{ price: "0.39", size: "100" }];

const fakeClob = {
  getOrderBook: async () => ({ tick_size: "0.01", neg_risk: false, min_order_size: "5", asks, bids }),
  // Round 4b: the tool signs (createOrder / createMarketOrder — the SDK's
  // pre-sign network reads live there) and POSTs the signed order separately,
  // so only the POST can have an unknown outcome. These three route the
  // split calls through the createAndPost* behaviour each test scripts.
  createOrder: async (order: Record<string, unknown>, options: Record<string, unknown>) => ({ signedOf: "limit", order, options }),
  createMarketOrder: async (order: Record<string, unknown>, options: Record<string, unknown>) => ({ signedOf: "market", order, options }),
  postOrder: async (signed: { signedOf: string; order: Record<string, unknown>; options: Record<string, unknown> }, orderType: unknown, postOnly?: boolean) =>
    signed.signedOf === "limit"
      ? (fakeClob as any).createAndPostOrder(signed.order, signed.options, orderType, postOnly)
      : (fakeClob as any).createAndPostMarketOrder(signed.order, signed.options, orderType),
  createAndPostOrder: async (order: Record<string, unknown>) => {
    calls.push({ kind: "limit", order });
    return { success: true, orderID: "0xORDER", status: "matched" };
  },
  createAndPostMarketOrder: async (order: Record<string, unknown>) => {
    calls.push({ kind: "market", order });
    return { success: true, orderID: "0xMKT", status: "matched" };
  },
};

mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => fakeClob,
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "FI", ip: null, raw: {} }),
    getPolymarketAccount: () => ({ address: "0xEOA0000000000000000000000000000000000000" }),
    resetClobClient: () => {},
  },
});
// Gamma metadata lookup for a bare token_id — keep it off the network.
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => ({ ok: false }), isTimeoutError: () => false },
});

const { executeTrade } = await import("../src/utils/polymarket/orders.js");

function lastOrder(): Record<string, unknown> {
  return calls[calls.length - 1].order;
}

test("a bare confirm after a preview is refused when the book moved past the previewed worst fill", async () => {
  asks = [{ price: "0.40", size: "100" }];
  const preview = await executeTrade({ action: "buy", token_id: "T1", amount_usd: 5 });
  assert.equal(preview.isError, undefined, preview.text);
  assert.equal((preview.structured as { worstFillPrice: number }).worstFillPrice, 0.4);
  // The preview itself tells the agent the bound is the confirm's limit.
  assert.match(preview.text, /0\.4\b.*limit|limit.*0\.4\b/s);

  asks = [{ price: "0.55", size: "100" }]; // the cheap level is lifted before the confirm
  const before = calls.length;
  // Exactly what the skill prescribes: the same call plus confirm:true, no max_fill_price.
  const res = await executeTrade({ action: "buy", token_id: "T1", amount_usd: 5, order_type: "FOK", confirm: true });
  assert.equal(res.isError, true, res.text);
  assert.match(res.text, /book moved/i);
  assert.match(res.text, /0\.55/);
  assert.match(res.text, /0\.4\b/);
  assert.match(res.text, /nothing was charged/i);
  assert.match(res.text, /re-?preview|preview again|confirm:false/i, "the refusal must say how to get a fresh quote");
  assert.equal((res.structured as { refused?: string }).refused, "worse_than_quoted");
  assert.equal((res.structured as { boundSource?: string }).boundSource, "preview");
  assert.equal(calls.length, before, "nothing may be signed");
});

test("a bare confirm on an unmoved book signs at the previewed worst fill", async () => {
  asks = [{ price: "0.40", size: "100" }];
  await executeTrade({ action: "buy", token_id: "T2", amount_usd: 5 });
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "T2", amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, before + 1);
  assert.equal(lastOrder().price, 0.4);
});

test("a book that moved in the user's favour places, signed no worse than the previewed bound", async () => {
  asks = [{ price: "0.40", size: "100" }];
  await executeTrade({ action: "buy", token_id: "T3", amount_usd: 5 });
  asks = [{ price: "0.30", size: "100" }];
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "T3", amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, before + 1);
  const signed = lastOrder().price as number;
  assert.ok(signed <= 0.4, `signed ${signed} must not exceed the previewed 0.4`);
});

test("a fresh preview replaces the bound — re-preview then confirm goes through at the new figure", async () => {
  asks = [{ price: "0.40", size: "100" }];
  await executeTrade({ action: "buy", token_id: "T4", amount_usd: 5 });
  asks = [{ price: "0.55", size: "100" }];
  const refused = await executeTrade({ action: "buy", token_id: "T4", amount_usd: 5, confirm: true });
  assert.equal(refused.isError, true);
  const again = await executeTrade({ action: "buy", token_id: "T4", amount_usd: 5 });
  assert.equal((again.structured as { worstFillPrice: number }).worstFillPrice, 0.55);
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "T4", amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, before + 1);
  assert.equal(lastOrder().price, 0.55);
});

test("an explicit max_fill_price overrides the previewed bound in both directions", async () => {
  asks = [{ price: "0.40", size: "100" }];
  await executeTrade({ action: "buy", token_id: "T5", amount_usd: 5 });
  asks = [{ price: "0.55", size: "100" }];
  const before = calls.length;
  // The caller widens the bound on purpose: the walk at 0.55 is within 0.60.
  const ok = await executeTrade({ action: "buy", token_id: "T5", amount_usd: 5, confirm: true, max_fill_price: 0.6 });
  assert.equal(ok.isError, undefined, ok.text);
  assert.equal(calls.length, before + 1);
  // …and tightens it: 0.55 is worse than 0.50 even though the preview is stale.
  const refused = await executeTrade({ action: "buy", token_id: "T5", amount_usd: 5, confirm: true, max_fill_price: 0.5 });
  assert.equal(refused.isError, true);
  assert.equal((refused.structured as { boundSource?: string }).boundSource, "max_fill_price");
  assert.equal(calls.length, before + 1);
});

test("the bound is per (token, side): a sell preview does not bound a buy, and a sell is bounded as a floor", async () => {
  asks = [{ price: "0.60", size: "100" }];
  bids = [{ price: "0.45", size: "100" }];
  const preview = await executeTrade({ action: "sell", token_id: "T6", size: 10 });
  assert.equal((preview.structured as { worstFillPrice: number }).worstFillPrice, 0.45);
  bids = [{ price: "0.35", size: "100" }]; // bids dropped: a LOWER fill is the worse one
  const before = calls.length;
  const refused = await executeTrade({ action: "sell", token_id: "T6", size: 10, confirm: true });
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /below/);
  assert.equal(calls.length, before);
  // The buy side of the same token was never previewed: no bound, the walk stands.
  const buy = await executeTrade({ action: "buy", token_id: "T6", amount_usd: 5, confirm: true });
  assert.equal(buy.isError, undefined, buy.text);
  assert.equal(calls.length, before + 1);
  bids = [{ price: "0.39", size: "100" }];
});

test("a confirm with no preview in this process and no max_fill_price stands on its own walk", async () => {
  asks = [{ price: "0.55", size: "100" }];
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "T7", amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, before + 1);
  assert.equal(lastOrder().price, 0.55);
});

test("limit orders are untouched by the bound — the price is the user's own limit", async () => {
  asks = [{ price: "0.40", size: "100" }];
  await executeTrade({ action: "buy", token_id: "T8", amount_usd: 5 }); // a market preview on the same token/side
  asks = [{ price: "0.55", size: "100" }];
  const before = calls.length;
  const res = await executeTrade({ action: "buy", token_id: "T8", price: 0.5, size: 10, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.equal(calls.length, before + 1);
  assert.equal(calls[calls.length - 1].kind, "limit");
  assert.equal(lastOrder().price, 0.5);
});
