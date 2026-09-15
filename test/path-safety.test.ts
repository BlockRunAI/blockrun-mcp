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
//   blockrun_exa({ path: "..\t/phone/numbers/buy" })   (found on blockrun_surf,
//                                                        retired 2026-09-06)
//     -> guard saw the segment "..\t", passed it
//     -> parser stripped the tab -> /api/v1/phone/numbers/buy
//     -> reserved the tool's own price, charged $5.00 — a 526x under-reserve that also
//        escapes profile scoping (a research-profile install could buy numbers).
//
// Each case is asserted against the REAL parser first: a guard test that blocks
// something harmless proves nothing.
test("hasPathTraversal catches tab/newline-obfuscated traversal (URL parser strips them)", () => {
  const BASE = "https://blockrun.ai/api/v1/exa/";
  const escapes = (p: string) => {
    try { return !new URL(BASE + p).pathname.startsWith("/api/v1/exa/"); } catch { return false; }
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

test("hasPathTraversal tolerates legit encoded chars", () => {
  assert.equal(hasPathTraversal("search/web%20query"), false); // %20 → space, no traversal
  assert.equal(hasPathTraversal("polymarket/wallet/0xabc%2Fdef"), false); // decodes to a slash, not a dot-segment
});

// ── ONE malformed escape ANYWHERE used to blind the whole check ──
//
// The guard decoded the entire caller string in one decodeURIComponent. A
// single malformed `%` — trivially a lone `%` after `?` or `#`, which the URL
// parser assigns to the query/fragment and never decodes — made the decode
// throw, the catch kept the raw string, and the literal segment `%2e%2e` was
// not `..` to the equality check. The parser, meanwhile, resolves `%2e%2e` /
// `.%2e` / `%2e.` as dot-segments natively and ends the path at `?`/`#`, so the
// request left this process already re-routed out of the tool's namespace:
//
//   blockrun_modal({ path: "%2e%2e/phone/numbers/buy#%" })
//     -> guard false, classified as a $0.003 modal op, POSTs /v1/phone/numbers/buy ($5.001)
//   blockrun_phone({ path: "phone/%2e%2e/modal/sandbox/create#%", body: { gpu: "H100", timeout: 86400 } })
//     -> guard false, passes the phone/ namespace pin, reserves $0.012, buys a $192 sandbox
//
// The old test at this spot pinned `foo%zzbar` -> false, i.e. it pinned the
// fallback that created the hole. Now: the query/fragment is dropped first (the
// parser never routes on it), `%2e` is read as `.` the way the parser reads it,
// each segment is decoded on its own so one bad escape cannot hide another, and
// a malformed escape in the ROUTE part is refused outright — over-blocking is
// the safe direction, and the gateway would 4xx such a path before payment.
test("hasPathTraversal is not blinded by a malformed escape in the query or fragment", () => {
  const BASE = "https://blockrun.ai/api/v1/exa/";
  const escapes = (p: string) => !new URL(BASE + p).pathname.startsWith("/api/v1/exa/");
  for (const p of [
    "%2e%2e/phone/numbers/buy?%",
    "%2e%2e/phone/numbers/buy#%",
    "%2e%2e/phone/numbers/buy%",
    ".%2e/phone/numbers/buy?%zz",
    "%2e./phone/numbers/buy?%",
    "%2E%2E/phone/numbers/buy#%",
    "%2e%2e\\phone/numbers/buy?%",
    "%\t2e%\t2e/phone/numbers/buy?%",
  ]) {
    assert.equal(escapes(p), true, `precondition: ${JSON.stringify(p)} must actually escape the namespace`);
    assert.equal(hasPathTraversal(p), true, `${JSON.stringify(p)} reaches ${new URL(BASE + p).pathname} but was not blocked`);
  }
  // A namespace-internal hop with the same trick: the parser resolves it to
  // /api/v1/exa/modal/sandbox/create, i.e. a different route than typed.
  assert.equal(hasPathTraversal("phone/%2e%2e/modal/sandbox/create#%"), true);
  assert.equal(hasPathTraversal("phone/%2e%2e/modal/sandbox/create?%"), true);
});

test("hasPathTraversal refuses a malformed escape in the route part", () => {
  // fetch sends `foo%zzbar` verbatim; the gateway's router cannot decode it and
  // 4xxs before payment. Refusing here costs nothing and closes the class.
  assert.equal(hasPathTraversal("foo%zzbar"), true);
  assert.equal(hasPathTraversal("phone/numbers/buy%"), true);
  assert.equal(hasPathTraversal("%2e%2e%/phone/numbers/buy"), true);
});

test("hasPathTraversal ignores dot-segments the parser assigns to the query/fragment", () => {
  // These never leave /api/v1/exa/ — the parser puts `../..` in the search
  // string — so blocking them would refuse a harmless (if odd) call.
  const BASE = "https://blockrun.ai/api/v1/exa/";
  for (const p of ["search?next=../..", "search#..", "contents?u=%2e%2e"]) {
    assert.equal(new URL(BASE + p).pathname.startsWith("/api/v1/exa/"), true, p);
    assert.equal(hasPathTraversal(p), false, p);
  }
  // …but a `..` immediately BEFORE the `?` is still a route segment.
  assert.equal(hasPathTraversal("../phone/numbers/buy?x=1"), true);
  assert.equal(hasPathTraversal("..?x=1"), true);
});

test("hasPathTraversal still refuses an encoded slash that decodes into a dot-segment", () => {
  // The gateway decodes %2F when routing; `phone%2F..%2Fmodal` becomes
  // phone/../modal on the far side. Per-segment decoding must split AGAIN
  // after decoding or this regresses (it was caught by the whole-string
  // decode before).
  assert.equal(hasPathTraversal("phone%2F..%2Fmodal/sandbox/create"), true);
  assert.equal(hasPathTraversal("a/%2e%2e%2fb"), true);
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

// The tier tables that price a passthrough call are keyed on the route the
// gateway will ACTUALLY serve — so normalizeClassifyPath has to reproduce the
// two transformations that happen between the caller's string and that route.
// hasPathTraversal above has done both since 0.33; its sibling did neither,
// and both gaps were live and independently exploitable:
//
//   blockrun_phone({ path: "phone/numbers/b\tuy" })   -> fetch strips the tab
//   blockrun_phone({ path: "phone/numbers/%62uy" })   -> the gateway decodes it
//
// Both land on /api/v1/phone/numbers/buy and quote 5001000 micro-USDC (probed
// live 2026-08-13, unpaid 402), while the classifier matched neither `path ===`
// branch and fell through to PHONE_UNKNOWN_RESERVE_USD = $0.012 — a 417x
// under-reserve that admits the call against any budget cap.
test("normalizeClassifyPath strips tab/LF/CR, which the URL parser deletes before sending", () => {
  const BASE = "https://blockrun.ai/api/v1/";
  for (const raw of ["phone/numbers/b\tuy", "phone/numbers/bu\ny", "phone/numbers/\rbuy"]) {
    // Assert against the REAL parser first — a guard test for a shape the
    // parser does not actually normalize would prove nothing.
    assert.equal(new URL(BASE + raw).pathname, "/api/v1/phone/numbers/buy", raw);
    assert.equal(normalizeClassifyPath(raw), "phone/numbers/buy", raw);
  }
});

test("normalizeClassifyPath decodes once, as the gateway router does", () => {
  // Percent-encoding survives fetch() untouched (unlike the tab), so this one
  // is decoded server-side: /api/v1/phone/numbers/%62uy really does route to
  // the $5 buy handler.
  assert.equal(new URL("https://blockrun.ai/api/v1/phone/numbers/%62uy").pathname, "/api/v1/phone/numbers/%62uy");
  assert.equal(normalizeClassifyPath("phone/numbers/%62uy"), "phone/numbers/buy");
  assert.equal(normalizeClassifyPath("phone/numbers/%42%55%59"), "phone/numbers/buy");
  // ONE decode, matching the parser — %2562uy is not %62uy is not buy, and the
  // gateway does not double-decode either, so it must not classify as buy.
  assert.notEqual(normalizeClassifyPath("phone/numbers/%2562uy"), "phone/numbers/buy");
  // A malformed % must not throw — fall back to the raw string.
  assert.equal(normalizeClassifyPath("phone/lookup%zz"), "phone/lookup%zz");
});

// ── `[?#].*$` did not cross a line terminator ──
//
// The query cut ran BEFORE the tab/LF/CR strip and used `.`, which in JS never
// matches LF, CR, U+2028 or U+2029; `$` without the `m` flag is end-of-input
// only. So the cut simply failed to match when a line terminator followed the
// `?`/`#`, the later strip removed the LF, and `phone/numbers/buy?` reached the
// exact-match price table — which priced it as the $0.012 unknown while fetch
// deleted the same LF and the gateway served the $5.001 buy route. The
// round-2 `?x=1` fix re-opened by one character; probed on the pure pipeline
// (no handler run) 2026-09-13.
test("normalizeClassifyPath cuts the query/fragment even when a line terminator follows it", () => {
  const BASE = "https://blockrun.ai/api/v1/";
  for (const raw of [
    "phone/numbers/buy?\n",
    "phone/numbers/buy#\r",
    "phone/numbers/buy?x\ry",
    "phone/numbers/buy?x\u2028y",
    "phone/numbers/buy#\u2029",
    "phone/numbers/buy?\n\n\n",
    "phone/numbers/buy?a=1\nb=2",
  ]) {
    // The parser deletes LF/CR outright and percent-encodes U+2028 into the
    // query; the PATH it sends is the full buy route every time.
    assert.equal(new URL(BASE + raw).pathname, "/api/v1/phone/numbers/buy", JSON.stringify(raw));
    assert.equal(normalizeClassifyPath(raw), "phone/numbers/buy", JSON.stringify(raw));
  }
  assert.equal(normalizeClassifyPath("contents?\n"), "contents");
  assert.equal(normalizeClassifyPath("markets/listings?\n"), "markets/listings");
});

test("normalizeClassifyPath keeps the query string off the classified route", () => {
  // Order matters: the query is dropped from the RAW string before decoding, so
  // an encoded `?` inside a segment cannot truncate the path to a cheaper tier.
  assert.equal(normalizeClassifyPath("phone/numbers/%62uy?x=1"), "phone/numbers/buy");
  assert.notEqual(normalizeClassifyPath("phone/lookup%3Ffoo"), "phone/lookup");
});

// ── ORDER: strip, then decode, then strip again ──
//
// The real pipeline has TWO transformations in a fixed order: fetch's URL parser
// DELETES tab/LF/CR before the request leaves this process, and the gateway
// DECODES percent-escapes when it routes. Both helpers did them backwards
// (decode first), which is invisible until one is nested inside the other:
// a tab splitting an escape (`%<TAB>62uy`) makes decodeURIComponent throw, the
// catch falls back to the RAW string, and the later strip then leaves `%62uy`
// undecoded. Each transformation was tested in isolation and passed; the
// composition was the hole.
//
// Both variants were reproduced against the live gateway with unpaid 402s
// (2026-08-13) — each quotes 5001000 micro ($5.001) at /v1/phone/numbers/buy.
test("normalizeClassifyPath survives a tab splitting a percent-escape", () => {
  const BASE = "https://blockrun.ai/api/v1/";
  for (const raw of ["phone/numbers/%\t62uy", "phone/numbers/%6\r2uy", "phone/numbers/%\n62uy"]) {
    // The parser deletes the control char, so the gateway receives %62uy and
    // decodes it to `buy` — the classifier has to reach the same conclusion.
    assert.equal(new URL(BASE + raw).pathname, "/api/v1/phone/numbers/%62uy", raw);
    assert.equal(normalizeClassifyPath(raw), "phone/numbers/buy", raw);
  }
  assert.equal(normalizeClassifyPath("sandbox/%\t63reate"), "sandbox/create");
});

test("hasPathTraversal survives a tab splitting a dot-escape (namespace escape)", () => {
  // Worse than a mispricing: this one leaves the tool's own namespace, so a
  // research-profile install that never exposes blockrun_phone could reach
  // phone/numbers/buy on the passthrough tool's own much smaller reserve.
  const BASE = "https://blockrun.ai/api/v1/exa/";
  for (const raw of [
    "%\t2e%\t2e/phone/numbers/buy",
    "%2\te%2\te/phone/numbers/buy",
    "%\r2e%\r2e/phone/numbers/buy",
    "%\n2e%\n2e/phone/numbers/buy",
  ]) {
    assert.equal(new URL(BASE + raw).pathname, "/api/v1/phone/numbers/buy", raw);
    assert.equal(hasPathTraversal(raw), true, raw);
  }
});
