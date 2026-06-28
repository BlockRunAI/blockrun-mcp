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
 */
export function hasPathTraversal(path: string): boolean {
  return path.split("/").some((seg) => seg === ".." || seg === ".");
}

/**
 * True for a well-formed chain slug: lowercase alphanumerics and hyphens only.
 * Real chain keys ("ethereum", "base", "arbitrum-one") match; anything with a
 * slash, dot, or other separator that could re-route the call is rejected.
 */
export function isValidNetworkSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}
