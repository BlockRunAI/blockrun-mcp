// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// walkBook is the number the user consents to and the limit the order is
// signed at, so its arithmetic is pinned directly — the handler suites cover
// it only through the preview text. (Round 4b: the "Exported for tests"
// comment named a test that did not exist.)
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// orders.ts pulls in the CLOB client and the relayer at import; neither is
// touched here.
mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getClobClient: async () => { throw new Error("not used"); },
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: null, ip: null, raw: {} }),
    getPolymarketAccount: () => ({ address: "0x0000000000000000000000000000000000000001" }),
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/http.js", {
  namedExports: { fetchWithTimeout: async () => { throw new Error("not used"); }, isTimeoutError: () => false },
});

const { walkBook } = await import("../src/utils/polymarket/orders.js");
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("a buy walks the asks from the cheapest, whatever order the book arrived in", () => {
  const book = { asks: [{ price: "0.50", size: "10" }, { price: "0.40", size: "10" }], bids: [] } as never;
  const r = walkBook(book, "buy", 6); // $6: $4 at 0.40 (10 shares), $2 at 0.50 (4 shares)
  assert.ok(near(r.filled, 14), `filled=${r.filled}`);
  assert.ok(near(r.unfilled, 0));
  assert.equal(r.worstPrice, 0.5, "the last level consumed is the signed limit");
});

test("a sell walks the bids from the best, and reports the floor it reached", () => {
  const book = { asks: [], bids: [{ price: "0.30", size: "5" }, { price: "0.35", size: "5" }] } as never;
  const r = walkBook(book, "sell", 8); // 5 shares at 0.35, 3 at 0.30
  assert.ok(near(r.filled, 5 * 0.35 + 3 * 0.3), `proceeds=${r.filled}`);
  assert.equal(r.worstPrice, 0.3);
  assert.ok(near(r.unfilled, 0));
});

test("a thin book reports the unfilled remainder and the deepest level touched", () => {
  const book = { asks: [{ price: "0.45", size: "2" }], bids: [] } as never;
  const r = walkBook(book, "buy", 5); // only $0.90 of depth
  assert.ok(near(r.filled, 2));
  assert.ok(near(r.unfilled, 5 - 0.9), `unfilled=${r.unfilled}`);
  assert.equal(r.worstPrice, 0.45);
});

test("garbage levels are ignored and an empty side walks nothing", () => {
  const book = { asks: [{ price: "abc", size: "1" }, { price: "0.5", size: "0" }], bids: [] } as never;
  assert.deepEqual(walkBook(book, "buy", 1), { filled: 0, unfilled: 1, worstPrice: null });
});
