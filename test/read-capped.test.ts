// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readCappedBody } from "../src/utils/read-capped.js";

// An endless body with no Content-Length: what a chunked response, or a
// gzip/br bomb after fetch() decodes it, looks like to the reader. The old
// `arrayBuffer()`-then-check shape would never return here.
function endless(chunk = 64 * 1024) {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { pulled += chunk; c.enqueue(new Uint8Array(chunk)); },
    cancel() { cancelled = true; },
  });
  return { res: new Response(body), stats: () => ({ pulled, cancelled }) };
}

test("readCappedBody: stops an endless body at the cap and cancels the stream", async () => {
  const { res, stats } = endless();
  assert.equal(await readCappedBody(res, 1_000_000), null);
  const s = stats();
  assert.ok(s.cancelled, "the stream must be cancelled, not drained");
  assert.ok(s.pulled < 2_000_000, `read ${s.pulled} bytes for a 1MB cap`);
});

test("readCappedBody: refuses an advertised oversize without reading", async () => {
  const { res, stats } = endless();
  const big = new Response(res.body, { headers: { "content-length": "5000000" } });
  assert.equal(await readCappedBody(big, 1_000_000), null);
  assert.ok(stats().pulled <= 64 * 1024 * 2);
});

test("readCappedBody: returns the exact bytes of a body within the cap", async () => {
  const bytes = Buffer.from("hello image bytes");
  const out = await readCappedBody(new Response(bytes), 1_000);
  assert.ok(out);
  assert.deepEqual(out, bytes);
});

test("readCappedBody: a body of exactly the cap is accepted", async () => {
  const out = await readCappedBody(new Response(new Uint8Array(1000)), 1000);
  assert.equal(out?.byteLength, 1000);
});
