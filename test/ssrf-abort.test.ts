// Run with: npm test  (tsx --test)
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A resolver that never answers: getaddrinfo against dead nameservers, or a
// saturated libuv pool. dns.lookup cannot be aborted.
mock.module("node:dns/promises", {
  namedExports: { lookup: () => new Promise(() => {}) },
});

const { fetchPublicUrl } = await import("../src/utils/ssrf.js");

// Regression r5: fetchPublicUrl awaited the per-hop DNS check before fetch()
// ever saw the caller's signal, so the inline preview's 15s budget no longer
// covered name resolution and a hung resolver held a paid image result past it.
test("fetchPublicUrl: the caller's deadline covers a hung DNS lookup", async () => {
  const orig = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response("x"); }) as typeof fetch;
  try {
    const started = Date.now();
    // A ref'd timer, not AbortSignal.timeout (unref'd): with the lookup hung
    // forever, an unref'd timer lets the event loop drain and the test dies.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error("deadline")), 50);
    await assert.rejects(fetchPublicUrl("https://hangs.example/x.png", { signal: ctrl.signal }), /deadline/);
    clearTimeout(t);
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
    assert.equal(fetched, 0, "nothing is fetched when the host was never checked");
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchPublicUrl: an already-aborted signal rejects before resolving", async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error("gone"));
  await assert.rejects(fetchPublicUrl("https://hangs.example/x.png", { signal: ctrl.signal }), /gone/);
});
