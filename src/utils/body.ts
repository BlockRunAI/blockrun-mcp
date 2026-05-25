// MCP clients sometimes deliver a loosely-typed (z.any) `body` argument as a
// JSON *string* rather than a parsed object. If that string is then handed to
// the SDK's requestWithPaymentRaw / pmQuery (which JSON.stringify() it again),
// the gateway receives a double-encoded JSON string instead of an object and
// rejects it with "400 Invalid request body" (and Exa/Modal upstreams 400 too).
//
// coerceBody normalizes that: a JSON string is parsed back to an object; an
// object is returned untouched; empty/whitespace becomes {}. This also fixes
// cost estimators that read fields like body.max_results — they need the object.
export function coerceBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not JSON — leave as-is so the caller/gateway can surface a clear error.
    return body;
  }
}
