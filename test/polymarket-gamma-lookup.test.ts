// Run with: npm test  (tsx --test)
//
// A bare token_id used to resolve with no question/outcome — so the order card
// (apps/order-preview.ts) could only title itself "Token 9292…" — and with no
// closed/acceptingOrders, so the resolved-market guard never fired for it.
// parseGammaMarket maps Gamma's token-indexed market record onto the token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGammaMarket } from "../src/utils/polymarket/orders.js";

const YES = "9292858804501752195303901432943909001681999829729072231193949216226529059833";
const NO = "4172669181406939041402397468456565438052312254193891925611001911738421673042";

// Verbatim shape from GET /markets?clob_token_ids=… on 2026-08-30: the two
// arrays are JSON-encoded STRINGS.
const gamma = [{
  question: "Will SSC Napoli win on 2026-08-30?",
  conditionId: "0xa322f23996edbe83bd1fb38caa6d08603ce34f8b9aa48ea0c05c2d39e525138a",
  closed: false,
  acceptingOrders: true,
  outcomes: '["Yes", "No"]',
  clobTokenIds: `["${YES}", "${NO}"]`,
}];

test("maps the market onto the token and picks the matching outcome by index", () => {
  assert.deepEqual(parseGammaMarket(gamma, YES), {
    question: "Will SSC Napoli win on 2026-08-30?",
    outcome: "Yes",
    conditionId: "0xa322f23996edbe83bd1fb38caa6d08603ce34f8b9aa48ea0c05c2d39e525138a",
    closed: false,
    acceptingOrders: true,
  });
  assert.equal(parseGammaMarket(gamma, NO).outcome, "No");
});

test("accepts real arrays as well as JSON-string arrays", () => {
  const arr = [{ ...gamma[0], outcomes: ["Yes", "No"], clobTokenIds: [YES, NO] }];
  assert.equal(parseGammaMarket(arr, NO).outcome, "No");
});

test("returns {} — spread-safe — when the token is not listed, the payload is not a list, or the strings are malformed", () => {
  assert.deepEqual(parseGammaMarket(gamma, "123"), {});
  assert.deepEqual(parseGammaMarket({ error: "nope" }, YES), {});
  assert.deepEqual(parseGammaMarket([{ ...gamma[0], clobTokenIds: "not json" }], YES), {});
  assert.deepEqual({ tokenId: YES, ...parseGammaMarket(null, YES) }, { tokenId: YES });
});
