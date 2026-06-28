// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBaseUsdcCallResult } from "../src/utils/wallet.js";

test("parseBaseUsdcCallResult converts a hex eth_call result to USDC", () => {
  // 1 USDC = 1_000_000 atomic units (6 decimals).
  const oneUsdc = "0x" + (1_000_000).toString(16).padStart(64, "0");
  assert.equal(parseBaseUsdcCallResult(oneUsdc), 1);
  const zero = "0x" + "0".repeat(64);
  assert.equal(parseBaseUsdcCallResult(zero), 0);
});

test("parseBaseUsdcCallResult returns null for empty/garbled results (so the next RPC is tried)", () => {
  // "0x" (empty returndata from a lagging/pruned node) used to become NaN and
  // short-circuit the whole fallback list with "$NaN USDC".
  assert.equal(parseBaseUsdcCallResult("0x"), null);
  assert.equal(parseBaseUsdcCallResult(undefined), null);
  assert.equal(parseBaseUsdcCallResult(null), null);
  assert.equal(parseBaseUsdcCallResult("not-hex"), null);
  assert.equal(parseBaseUsdcCallResult(123 as unknown as string), null);
});
