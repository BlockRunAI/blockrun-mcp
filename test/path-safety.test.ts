// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPathTraversal, isValidNetworkSlug, normalizeClassifyPath } from "../src/utils/path-safety.js";

test("hasPathTraversal flags parent/current-dir segments that escape a namespace", () => {
  // Real traversal payloads (these normalize via the WHATWG URL parser).
  assert.equal(hasPathTraversal("../chat/completions"), true);
  assert.equal(hasPathTraversal("../../v1/phone/numbers/buy"), true);
  assert.equal(hasPathTraversal("foo/../bar"), true);
  assert.equal(hasPathTraversal("foo/./bar"), true);
  assert.equal(hasPathTraversal(".."), true);
  assert.equal(hasPathTraversal("."), true);
});

test("hasPathTraversal catches percent-encoded and backslash traversal", () => {
  // The WHATWG URL parser normalizes %2e/%2E and backslashes the same as ./..
  // so a literal-only check is bypassable. These must all be flagged.
  assert.equal(hasPathTraversal("%2e%2e/pm/markets"), true);
  assert.equal(hasPathTraversal("%2E%2E/v1/phone/numbers/buy"), true);
  assert.equal(hasPathTraversal(".%2e/foo"), true);
  assert.equal(hasPathTraversal("%2e/foo"), true);
  assert.equal(hasPathTraversal("..\\..\\v1\\voice\\call"), true);
});

// Per the URL spec the parser DELETES every ASCII tab (U+0009), LF (U+000A) and
// CR (U+000D) from its input before parsing. So "..<TAB>" is not a ".." segment
// to a naive equality check, but IS one by the time fetch() resolves it. The
// literal + %2e + backslash checks above all missed this shape, and it was live:
//
//   blockrun_surf({ path: "..\t/phone/numbers/buy" })
//     -> guard saw the segment "..\t", passed it
//     -> parser stripped the tab -> /api/v1/phone/numbers/buy
//     -> reserved $0.0095 (surf), charged $5.00 — a 526x under-reserve that also
//        escapes profile scoping (a research-profile install could buy numbers).
//
// Each case is asserted against the REAL parser first: a guard test that blocks
// something harmless proves nothing.
test("hasPathTraversal catches tab/newline-obfuscated traversal (URL parser strips them)", () => {
  const BASE = "https://blockrun.ai/api/v1/surf/";
  const escapes = (p: string) => {
    try { return !new URL(BASE + p).pathname.startsWith("/api/v1/surf/"); } catch { return false; }
  };
  for (const p of [
    "..\t/phone/numbers/buy",
    ".\t./phone/numbers/buy",
    "..\n/phone/numbers/buy",
    "..\r/phone/numbers/buy",
    "\t../phone/numbers/buy",
    "..\t\\phone/numbers/buy",
  ]) {
    assert.equal(escapes(p), true, `precondition: ${JSON.stringify(p)} must actually escape the namespace`);
    assert.equal(hasPathTraversal(p), true, `${JSON.stringify(p)} reaches ${new URL(BASE + p).pathname} but was not blocked`);
  }
});

test("hasPathTraversal tolerates a malformed percent and legit encoded chars", () => {
  assert.equal(hasPathTraversal("foo%zzbar"), false); // malformed % must not throw
  assert.equal(hasPathTraversal("search/web%20query"), false); // %20 → space, no traversal
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

test("normalizeClassifyPath strips query/fragment, leading+trailing slashes, and lowercases", () => {
  // Tier pricing keys on the bare endpoint; the gateway router ignores these
  // perturbations, so classification must too or an expensive route (e.g. the
  // $5 phone/numbers/buy) gets mispriced as the $0.001 default.
  assert.equal(normalizeClassifyPath("phone/numbers/buy?x=1"), "phone/numbers/buy");
  assert.equal(normalizeClassifyPath("phone/numbers/buy/"), "phone/numbers/buy");
  assert.equal(normalizeClassifyPath("/onchain/sql"), "onchain/sql");
  assert.equal(normalizeClassifyPath("Phone/Numbers/Buy"), "phone/numbers/buy");
  assert.equal(normalizeClassifyPath("social/mindshare?q=eth&interval=1d"), "social/mindshare");
  assert.equal(normalizeClassifyPath("onchain/sql#frag"), "onchain/sql");
  assert.equal(normalizeClassifyPath("market/price"), "market/price");
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
