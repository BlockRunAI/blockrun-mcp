// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPathTraversal, isValidNetworkSlug } from "../src/utils/path-safety.js";

test("hasPathTraversal flags parent/current-dir segments that escape a namespace", () => {
  // Real traversal payloads (these normalize via the WHATWG URL parser).
  assert.equal(hasPathTraversal("../chat/completions"), true);
  assert.equal(hasPathTraversal("../../v1/phone/numbers/buy"), true);
  assert.equal(hasPathTraversal("foo/../bar"), true);
  assert.equal(hasPathTraversal("foo/./bar"), true);
  assert.equal(hasPathTraversal(".."), true);
  assert.equal(hasPathTraversal("."), true);
});

test("hasPathTraversal allows legitimate passthrough paths", () => {
  assert.equal(hasPathTraversal(""), false);
  assert.equal(hasPathTraversal("market/price"), false);
  assert.equal(hasPathTraversal("polymarket/events"), false);
  // defi paths legitimately contain dots inside a segment — must NOT be flagged.
  assert.equal(hasPathTraversal("prices/coingecko:ethereum"), false);
  assert.equal(hasPathTraversal("prices/base:0x833589.eth"), false);
  assert.equal(hasPathTraversal("kalshi/markets/KXBTC-25MAR14"), false);
});

test("isValidNetworkSlug accepts simple chain identifiers only", () => {
  assert.equal(isValidNetworkSlug("ethereum"), true);
  assert.equal(isValidNetworkSlug("base"), true);
  assert.equal(isValidNetworkSlug("arbitrum-one"), true);
  assert.equal(isValidNetworkSlug("bsc"), true);
});

test("isValidNetworkSlug rejects traversal / path separators / empties", () => {
  assert.equal(isValidNetworkSlug("../chat/completions"), false);
  assert.equal(isValidNetworkSlug("base/extra"), false);
  assert.equal(isValidNetworkSlug(".."), false);
  assert.equal(isValidNetworkSlug(""), false);
  assert.equal(isValidNetworkSlug("eth.mainnet"), false);
});
