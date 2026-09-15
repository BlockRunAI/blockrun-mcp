// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// A lost or 5xx submit response is NOT a rejection (audit round 3, C40). The
// CLOB SDK signs the order, posts it, and throws on a dropped socket or a
// relay 502/504 — shapes that happen AFTER the exchange may have accepted the
// order (the default egress is a Cloud Run relay in front of the CLOB). The
// old catch released the session-cap reservation and rendered a bare
// "Polymarket CLOB error: socket hang up", and the skill tells the agent the
// message says exactly what to do next — so the agent re-placed, doubling real
// exposure while the cap saw one order. The relayer withdraw path
// (sendWalletBatch) and the order card (apps/order-safety.ts) already treated
// this class as outcome-unknown; the order path was the odd one out.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { outcomeIsUnknown } from "../apps/order-safety.js";

type Call = { kind: "limit" | "market" };
const calls: Call[] = [];
let limitBehaviour: () => Promise<unknown> = async () => ({ success: true, orderID: "0xORDER", status: "live" });
let marketBehaviour: () => Promise<unknown> = async () => ({ success: true, orderID: "0xMKT", status: "matched" });
let refreshBehaviour: () => Promise<unknown> = async () => ({});
const refreshCalls: unknown[] = [];

/** The CLOB SDK's ApiError: bare message, code on a `.status` PROPERTY, body on `.data`. */
class ApiError extends Error {
  status?: number;
  data?: unknown;
  constructor(message: string, status?: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

const fakeClob = {
  getOrderBook: async () => ({
    tick_size: "0.01", neg_risk: false, min_order_size: "5",
    asks: [{ price: "0.45", size: "100" }], bids: [{ price: "0.44", size: "100" }],
  }),
  createAndPostOrder: async () => { calls.push({ kind: "limit" }); return limitBehaviour(); },
  createAndPostMarketOrder: async () => { calls.push({ kind: "market" }); return marketBehaviour(); },
  updateBalanceAllowance: async (args: unknown) => { refreshCalls.push(args); return refreshBehaviour(); },
};

mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => fakeClob,
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "FI", ip: null, raw: {} }),
    getPolymarketAccount: () => ({ address: "0xEOA0000000000000000000000000000000000000" }),
    resetClobClient: () => {},
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => ({ ok: false }), isTimeoutError: () => false },
});

const { executeTrade, getSessionLedger } = await import("../src/utils/polymarket/orders.js");

function reset() {
  calls.length = 0;
  refreshCalls.length = 0;
  limitBehaviour = async () => ({ success: true, orderID: "0xORDER", status: "live" });
  marketBehaviour = async () => ({ success: true, orderID: "0xMKT", status: "matched" });
  refreshBehaviour = async () => ({});
}

const LIMIT = { action: "buy" as const, token_id: "L1", price: 0.45, size: 20, confirm: true, agent_id: "bot" }; // $9.00
const MARKET = { action: "buy" as const, token_id: "M1", amount_usd: 5, confirm: true };

function assertOutcomeUnknownText(text: string, kind: "limit" | "market") {
  assert.match(text, /MAY (have been accepted|be live|already be live)/i, text);
  assert.match(text, kind === "limit" ? /action:"orders"/ : /action:"positions"/, text);
  assert.match(text, /before (you )?(re-?plac|retry)/i, "must steer the agent to check before re-placing");
  assert.doesNotMatch(text, /^Polymarket CLOB error:/, "not the bare fallthrough");
  // The order card's re-arm predicate must read this as ambiguous, never as
  // "nothing was signed" — the same wording rules apps/order-safety.ts pins.
  assert.equal(outcomeIsUnknown(text), true, `the card would re-arm on: ${text}`);
}

test("a lost response (no status) on a limit order keeps the reservation and says the order MAY be live", async () => {
  reset();
  const before = getSessionLedger();
  limitBehaviour = async () => { throw new ApiError("socket hang up", undefined, { error: "socket hang up" }); };
  const res = await executeTrade(LIMIT);
  assert.equal(res.isError, true);
  assertOutcomeUnknownText(res.text, "limit");
  const after = getSessionLedger();
  assert.equal(after.totalUsd, before.totalUsd + 9, "the possibly-live $9 stays booked against the session cap");
  assert.equal(after.perAgent.bot ?? 0, (before.perAgent.bot ?? 0) + 9, "…and against the agent");
  assert.equal(after.count, before.count, "not counted as a confirmed placement");
  assert.equal(after.unconfirmed, (before.unconfirmed ?? 0) + 1, "counted as unconfirmed");
  assert.equal((res.structured as { outcome?: string }).outcome, "unknown");
  assert.equal(calls.length, 1, "no SDK-level retry");
});

test("a relay 504 on a market order is outcome-unknown too, pointing at positions", async () => {
  reset();
  const before = getSessionLedger();
  marketBehaviour = async () => { throw new ApiError("<html>upstream request timeout</html>", 504, { error: "<html>", status: 504 }); };
  const res = await executeTrade(MARKET);
  assert.equal(res.isError, true);
  assertOutcomeUnknownText(res.text, "market");
  assert.match(res.text, /504/);
  const after = getSessionLedger();
  assert.equal(after.totalUsd, before.totalUsd + 5);
  assert.equal(after.count, before.count);
  assert.equal(after.unconfirmed, (before.unconfirmed ?? 0) + 1);
});

test("a definite 4xx rejection releases the reservation and reads as a plain rejection", async () => {
  reset();
  const before = getSessionLedger();
  limitBehaviour = async () => { throw new ApiError("invalid order payload", 400, { error: "invalid order payload", status: 400 }); };
  const res = await executeTrade(LIMIT);
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.text, /MAY (have been accepted|be live)/i);
  assert.match(res.text, /invalid order payload/);
  const after = getSessionLedger();
  assert.equal(after.totalUsd, before.totalUsd, "a rejected order must not consume session budget");
  assert.equal(after.unconfirmed ?? 0, before.unconfirmed ?? 0);
});

test("a 4xx that only appears in the message text is still a definite rejection", async () => {
  reset();
  const before = getSessionLedger();
  limitBehaviour = async () => { throw new Error('{"error":"request error","status":422,"data":"bad tick"}'); };
  const res = await executeTrade(LIMIT);
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.text, /MAY (have been accepted|be live)/i);
  assert.equal(getSessionLedger().totalUsd, before.totalUsd);
});

test("an explicit success:false response is a rejection: released, not outcome-unknown", async () => {
  reset();
  const before = getSessionLedger();
  limitBehaviour = async () => ({ success: false, errorMsg: "order rejected by risk" });
  const res = await executeTrade(LIMIT);
  assert.equal(res.isError, true);
  assert.match(res.text, /order rejected by risk/);
  assert.doesNotMatch(res.text, /MAY (have been accepted|be live)/i);
  assert.equal(getSessionLedger().totalUsd, before.totalUsd);
});

test("balance-cache retry: a lost response on the SECOND submit is outcome-unknown", async () => {
  reset();
  const before = getSessionLedger();
  let n = 0;
  limitBehaviour = async () => {
    n++;
    if (n === 1) throw new ApiError("not enough balance / allowance", 400, { error: "not enough balance / allowance", status: 400 });
    throw new ApiError("ECONNRESET", undefined, { error: "ECONNRESET" });
  };
  const res = await executeTrade(LIMIT);
  assert.equal(res.isError, true);
  assertOutcomeUnknownText(res.text, "limit");
  assert.equal(refreshCalls.length, 1, "the cache refresh ran once");
  assert.equal(calls.length, 2);
  assert.equal(getSessionLedger().totalUsd, before.totalUsd + 9);
});

test("balance-cache retry: the refresh itself failing is NOT an unknown order — nothing was re-submitted", async () => {
  reset();
  const before = getSessionLedger();
  limitBehaviour = async () => { throw new ApiError("not enough balance / allowance", 400, { error: "not enough balance / allowance", status: 400 }); };
  refreshBehaviour = async () => { throw new Error("socket hang up"); };
  const res = await executeTrade(LIMIT);
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.text, /MAY (have been accepted|be live)/i);
  assert.equal(calls.length, 1, "the second submit never ran");
  assert.equal(getSessionLedger().totalUsd, before.totalUsd, "released — the one submit was definitely rejected");
});

test("the unconfirmed booking is visible in the session ledger the success text prints", async () => {
  reset();
  const ledgerBefore = getSessionLedger();
  limitBehaviour = async () => { throw new ApiError("socket hang up"); };
  await executeTrade(LIMIT);
  limitBehaviour = async () => ({ success: true, orderID: "0xORDER2", status: "live" });
  const res = await executeTrade({ ...LIMIT, token_id: "L2" });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /unconfirmed/i, "a later success must keep showing the unresolved order");
  assert.equal(getSessionLedger().unconfirmed, (ledgerBefore.unconfirmed ?? 0) + 1);
});
