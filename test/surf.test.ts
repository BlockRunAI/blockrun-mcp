// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSurfCost, SURF_PRICE_USD } from "../src/tools/surf.js";

// Surf went FLAT on 2026-07-15. Pin what x402 CHARGES — $0.0095 — not the base.
//
// The 402's JSON `price` field reports $0.0075; that is the BASE. The charge is
// base + a $0.002 flat tx fee and lives in `maxAmountRequired` inside the base64
// `payment-required` header (decoded live: every /v1/surf/* route → 9500 micro =
// $0.0095). The gateway says so itself in src/app/api/v1/pm/[...path]/route.ts:
// "Tier 1 (GET) = $0.0095/call ($0.0075 base + $0.002 tx fee)".
//
// This estimator feeds the budget gate and must never under-quote. It has been
// wrong twice in the same direction: stale tiers after the gateway went flat,
// then the base mistaken for the price. Read the header.
// (one network-uniform price across Surf and Predexon).
//
// This estimator feeds the budget gate, so under-quoting is the failure that
// matters. It previously returned $0.001/$0.005/$0.02 from tier tables while
// the gateway had already moved T1/T2 to $0.0075 — under-reserving on every
// cheap-looking call. Flat pricing removes that drift at the root.
test("estimateSurfCost returns the flat rate for every endpoint", () => {
  assert.equal(SURF_PRICE_USD, 0.0095);
  for (const path of [
    "market/price",     // was T1 $0.001
    "social/mindshare", // was T2 $0.005 (exact)
    "wallet/detail",    // was T2 (prefix)
    "search/web",       // was T2 (prefix)
    "onchain/sql",      // was T3 $0.02 — the big one
    "chat/completions", // was T3 $0.02
    "prediction-market/polymarket/ranking",
  ]) {
    assert.equal(estimateSurfCost(path), 0.0095, `${path} should be flat-rated`);
  }
});

// The old bug: a query string or trailing slash pushed a T3 ($0.02) / T2
// ($0.005) path off its exact-set match down to the $0.001 default,
// under-recording spend up to 20x. A flat rate makes that unrepresentable —
// there is no tier left to misclassify. Kept as a regression guard in case
// anyone reintroduces path-dependent pricing.
test("no path perturbation can change the quoted cost", () => {
  for (const path of [
    "onchain/schema?chain=ethereum",
    "chat/completions/",
    "social/mindshare?q=eth&interval=1d",
    "token/holders?token=0x1",
    "MARKET/PRICE",
    "/onchain/sql/",
    "",
  ]) {
    assert.equal(estimateSurfCost(path), 0.0095, `${path} must not be repriced`);
  }
});
