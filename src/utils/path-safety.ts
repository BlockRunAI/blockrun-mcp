// src/utils/path-safety.ts
//
// Guards for the path-based passthrough tools (rpc, surf, modal, phone, exa,
// search, defi, markets). They build a gateway endpoint by concatenating a
// caller-supplied slug/path onto a fixed namespace prefix, then hand the string
// to fetch(). The WHATWG URL parser collapses dot-segments BEFORE the request is
// sent, so a `..` segment escapes the namespace — e.g.
//   `/v1/surf/` + `../../v1/modal/sandbox/create` -> `/v1/modal/sandbox/create`
// which defeats the per-tool budget pre-check and profile scoping. These helpers
// reject the traversal shapes while still allowing unknown-but-wellformed slugs.

/**
 * True when a path contains a parent-dir (`..`) or current-dir (`.`) segment,
 * the shapes that normalize away and escape the intended namespace. Segments
 * that merely *contain* a dot (e.g. `coingecko:ethereum`, `base:0x...`) are
 * legitimate and NOT flagged — only an exact `.`/`..` segment is.
 *
 * Decode once and split on both `/` and `\` first: the WHATWG URL parser (which
 * runs on the concatenated endpoint before fetch) treats `%2e`/`%2E` as `.` and
 * `\` as `/`, so `%2e%2e/...`, `.%2e/...`, and `..\..\...` normalize into
 * traversal too. A single decode matches the parser (it does not double-decode
 * `%252e`); a malformed `%` is left as-is rather than throwing.
 *
 * STRIP TAB/LF/CR FIRST. Per the URL spec the parser *removes* every ASCII tab
 * (U+0009), newline (U+000A) and carriage return (U+000D) from its input before
 * parsing — so `..<TAB>` is not a `..` segment to a naive equality check, but IS
 * one by the time fetch() resolves it. That gap was exploitable:
 *
 *   blockrun_surf({ path: "..\t/phone/numbers/buy" })
 *     -> guard sees the segment "..\t", not "..", and passes
 *     -> parser strips the tab -> /api/v1/phone/numbers/buy
 *     -> reserved $0.0095 (surf's price), charged $5.00
 *
 * A 526x under-reserve that also escapes profile scoping (a research-profile
 * install could buy phone numbers). Verified: all of `..\t/`, `.\t./`, `..\n/`,
 * `..\r/`, `\t../` and `..\t\` landed on /api/v1/phone/numbers/buy before this.
 */
export function hasPathTraversal(path: string): boolean {
  // ORDER MATTERS, and it was wrong here from 0.33 until 0.40.1 — the comment
  // above said "STRIP TAB/LF/CR FIRST" while the code decoded first.
  //
  // The real pipeline is: fetch's URL parser DELETES tab/LF/CR before the
  // request leaves this process, and only then does the far side decode. Decode
  // first and a tab SPLITTING an escape defeats both steps: `%<TAB>2e%<TAB>2e`
  // makes decodeURIComponent throw, the catch falls back to the raw string, and
  // the later strip leaves the literal segment "%2e%2e" — which is not ".." to
  // this check, but IS to the parser once it has deleted the same tab. Probed
  // live: blockrun_surf path:"%<TAB>2e%<TAB>2e/phone/numbers/buy" resolves to
  // /api/v1/phone/numbers/buy and quotes $5.001 against surf's $0.0095 reserve,
  // and escapes profile scoping on the way. Each transformation was tested
  // alone and passed; only the composition was broken.
  const asSent = path.replace(/[\t\n\r]/g, "");
  let decoded = asSent;
  try { decoded = decodeURIComponent(asSent); } catch { /* malformed %: check as-sent */ }
  // Strip again after decoding: an ENCODED %09 decodes to a literal tab, which
  // the far side does not delete. Over-blocking is the safe direction here.
  const asParsed = decoded.replace(/[\t\n\r]/g, "");
  return asParsed.split(/[/\\]/).some((seg) => seg === ".." || seg === ".");
}

/**
 * Normalize a caller-supplied passthrough slug for TIER CLASSIFICATION only (not
 * for the endpoint actually sent): drop a query string / fragment, decode once,
 * delete tab/LF/CR, strip leading + trailing slashes, and lowercase. The
 * per-endpoint price tables key on the bare route, but the gateway router
 * ignores a trailing `?query`, a trailing slash, or casing when matching — so
 * classifying the raw slug lets an expensive route (e.g. the $5
 * `phone/numbers/buy`, or a $0.02 surf tier) be mispriced as the cheap default
 * while the gateway still charges full price, defeating the budget pre-check and
 * under-recording spend. Callers still send the original slug, so a legitimate
 * query string (e.g. surf GET params in the path) is preserved.
 *
 * CLASSIFY THE ROUTE THAT WILL BE SERVED, NOT THE STRING THE CALLER TYPED. Two
 * transformations sit between them, and this helper shipped doing neither while
 * its sibling `hasPathTraversal` above has done both since 0.33 — the same
 * asymmetry, twice, each independently exploitable (probed live 2026-08-13 with
 * unpaid 402s; both quote 5001000 micro = $5.001 against a $0.012 reserve, a
 * 417x under-reserve that admits the call against ANY budget cap):
 *
 *   1. fetch() DELETES tab/LF/CR before sending, so `phone/numbers/b<TAB>uy`
 *      leaves this process as `phone/numbers/buy`.
 *   2. The gateway DECODES percent-escapes when routing, so
 *      `phone/numbers/%62uy` is served by the `buy` handler. (fetch leaves the
 *      escape intact, so unlike case 1 this one is decoded on the far side.)
 *
 * Decode ONCE, matching the parser and hasPathTraversal — `%2562uy` decodes to
 * `%62uy`, which is not a route, so it must not classify as one. A malformed `%`
 * falls back to the raw string rather than throwing.
 *
 * Direction of error, when the two sides disagree: over-classification (pricing
 * a 404 as the expensive route) merely over-reserves, which the gate tolerates
 * and `recordActualSpend` corrects; under-classification is the bug. So the
 * query string is dropped from the RAW slug BEFORE decoding — otherwise an
 * encoded `?` inside a segment (`phone/lookup%3Ffoo`) would truncate the path
 * to a real, cheaper route that the gateway would never serve.
 */
export function normalizeClassifyPath(path: string): string {
  // Strip BEFORE decoding as well as after — same order bug, same fix, same
  // reason as hasPathTraversal above: `phone/numbers/%<TAB>62uy` is sent as
  // `%62uy`, which the gateway decodes to `buy` ($5.001), while a decode-first
  // classifier throws on the split escape and prices it as the $0.012 unknown.
  const asSent = path.replace(/[?#].*$/, "").replace(/[\t\n\r]/g, "");
  let decoded = asSent;
  try { decoded = decodeURIComponent(asSent); } catch { /* malformed %: classify as-sent */ }
  return decoded
    .replace(/[\t\n\r]/g, "")  // a decoded %09 stays literal server-side
    .replace(/^\/+/, "")       // drop leading slashes
    .replace(/\/+$/, "")       // drop trailing slashes
    .toLowerCase();
}

/**
 * True for a well-formed chain slug: lowercase alphanumerics and hyphens only.
 * Real chain keys ("ethereum", "base", "arbitrum-one") match; anything with a
 * slash, dot, or other separator that could re-route the call is rejected.
 */
export function isValidNetworkSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}
