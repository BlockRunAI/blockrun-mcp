// Run with: npm test  (tsx --test)
//
// Since 2026-09-05 the gateway answers every stocks/{market}/price|history call
// with a pre-payment 501 ("We do not currently serve equity prices"). The tool
// says so itself, before the chain guard and before any network call — on the
// default Solana chain the Base-only guard used to fire first and tell the user
// to switch chains to pay for a route that cannot succeed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { equityNotServedMessage } from "../src/tools/price.js";

test("equity pre-flight names the withdrawal, the free catalog and the contact", () => {
  const out = equityNotServedMessage("price", "stocks", "hk");
  assert.match(out, /2026-09-05/);
  assert.match(out, /nothing was charged/);
  assert.match(out, /action: "list", category: "stocks", market: "hk"/);
  assert.match(out, /hello@blockrun\.ai/);
  assert.doesNotMatch(out, /switch/i);
  assert.doesNotMatch(out, /temporary API issue/);
});

test("usstock alias defaults the catalog hint to the US market", () => {
  assert.match(equityNotServedMessage("history", "usstock", undefined), /market: "us"/);
  assert.match(equityNotServedMessage("history", "usstock", undefined), /Equity history/);
});
