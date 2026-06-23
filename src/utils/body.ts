// MCP clients sometimes deliver a loosely-typed (z.any) `body` argument as a
// JSON *string* rather than a parsed object. If that string is then handed to
// the SDK's requestWithPaymentRaw / pmQuery (which JSON.stringify() it again),
// the gateway receives a double-encoded JSON string instead of an object and
// rejects it with "400 Invalid request body" (and Exa/Modal upstreams 400 too).
//
// coerceBody normalizes that: a JSON string is parsed back to an object; an
// object is returned untouched.
//
// Empty/whitespace string → `undefined` (treated as "no body"), NOT `{}`. Some
// MCP clients serialize an omitted optional `body` as "" rather than leaving it
// absent; mapping that to `{}` flipped GET-only endpoints (voice/call poll,
// markets GET reads) to POST and triggered Tier-2 billing. Returning `undefined`
// preserves the absent-vs-empty distinction: a caller's real `{}` object stays
// `{}` (a deliberate empty POST body, e.g. phone/numbers/list), while "" means
// "not provided". Cost estimators here all guard for a non-object body, and
// tools that always POST send `body ?? {}`, so `undefined` is safe everywhere.
export function coerceBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not JSON — leave as-is so the caller/gateway can surface a clear error.
    return body;
  }
}

/**
 * MCP `structuredContent` must be a JSON object. Path-based passthrough tools can
 * return a top-level array or primitive from the upstream API, so wrap those as
 * `{ result }` (matching the defi/rpc convention) instead of casting an array to
 * an object — which violates the protocol's object-typed structuredContent.
 */
export function asStructuredContent(result: unknown): Record<string, unknown> {
  return (typeof result === "object" && result !== null && !Array.isArray(result)
    ? result
    : { result }) as Record<string, unknown>;
}
