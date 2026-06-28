// src/utils/http.ts
// Shared fetch helpers for the x402 async tools (music, speech, video, realface).

// fetch() with a hard timeout. The abort timer is unref'd so a pending request
// never keeps the stdio process alive.
//
// We intentionally do NOT clearTimeout once fetch() resolves: fetch() resolves
// when the response HEADERS arrive, and every caller reads the body afterward
// (resp.json()/resp.text()). Leaving the unref'd timer armed means a body that
// stalls after headers is still aborted at timeoutMs — otherwise the read could
// hang with no abort coverage. A late abort() on an already-consumed response is
// a harmless no-op, and the unref'd timer never holds the event loop open.
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  id.unref?.();
  return await fetch(url, { ...options, signal: controller.signal });
}

// True when an error came from a request timing out / being aborted. Checks the
// DOMException name (AbortError from controller.abort(), TimeoutError from
// AbortSignal.timeout()) first, then falls back to message substrings for the
// custom "did not complete within" errors our polling loops throw.
export function isTimeoutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("abort") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("did not complete within")
  );
}
