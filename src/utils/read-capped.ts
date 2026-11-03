// src/utils/read-capped.ts
//
// Read a fetch() body into memory, but stop as soon as it passes a byte cap.
//
// `await res.arrayBuffer()` followed by a length check buffers the WHOLE body
// before the check runs. A Content-Length pre-check does not close that:
// a chunked response has none, and fetch() decodes gzip/br transparently, so
// a few-KB brotli bomb advertises its compressed size and inflates to
// gigabytes in the long-lived stdio process. Counting decoded bytes as they
// arrive and cancelling the stream at the cap bounds memory at roughly `max`.

/** The decoded body, or null when it exceeds `max` bytes (the stream is cancelled). */
export async function readCappedBody(res: Response, max: number): Promise<Buffer | null> {
  const advertised = Number(res.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
