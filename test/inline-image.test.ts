// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldInline, buildInlineImageBlock } from "../src/utils/inline-image.js";

// A literal public IP: the SSRF guard has nothing to resolve, so these tests
// never touch DNS (a hostname would be looked up for real before the mocked
// fetch ran, and fail closed offline).
const PUBLIC = "https://1.1.1.1/x.png";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("shouldInline: explicit param wins over env", () => {
  process.env.BLOCKRUN_INLINE_IMAGES = "1";
  assert.equal(shouldInline(false), false); // param beats a truthy env
  assert.equal(shouldInline(true), true);
  delete process.env.BLOCKRUN_INLINE_IMAGES;
});

test("shouldInline: falls back to env when param is undefined", () => {
  delete process.env.BLOCKRUN_INLINE_IMAGES;
  assert.equal(shouldInline(undefined), false);
  process.env.BLOCKRUN_INLINE_IMAGES = "true";
  assert.equal(shouldInline(undefined), true);
  process.env.BLOCKRUN_INLINE_IMAGES = "off"; // only 1/true/yes/on are truthy
  assert.equal(shouldInline(undefined), false);
  delete process.env.BLOCKRUN_INLINE_IMAGES;
});

test("buildInlineImageBlock: null on non-ok fetch", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    assert.equal(await buildInlineImageBlock(PUBLIC), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("buildInlineImageBlock: null when fetch throws", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    assert.equal(await buildInlineImageBlock(PUBLIC), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("buildInlineImageBlock: encodes a small image into a base64 JPEG block", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })) as typeof fetch;
  try {
    const block = await buildInlineImageBlock(PUBLIC);
    assert.ok(block, "expected an image block");
    assert.equal(block.type, "image");
    assert.equal(block.mimeType, "image/jpeg");
    assert.ok(block.data.length > 0);
    assert.doesNotThrow(() => Buffer.from(block.data, "base64")); // valid base64
  } finally {
    globalThis.fetch = orig;
  }
});

// #194: the preview URL comes from the gateway, and this fetch used to take it
// verbatim, redirects and all. A malicious or compromised gateway could make the
// user's machine GET localhost or cloud metadata. Every case below must refuse
// BEFORE any request to the private address leaves the process.
function recordingFetch(handler: (url: string) => Response) {
  const seen: string[] = [];
  const orig = globalThis.fetch;
  // Behaves like real fetch: follows 3xx itself unless the caller asked for
  // redirect:"manual". Without that, a guard-less caller would look safe here
  // only because the mock never followed the redirect it was handed.
  const mock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const res = handler(url);
    const location = res.headers.get("location");
    if (init?.redirect !== "manual" && res.status >= 300 && res.status < 400 && location) {
      return mock(new URL(location, url).toString(), init);
    }
    return res;
  };
  globalThis.fetch = mock as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

test("buildInlineImageBlock: refuses a private/loopback/metadata URL without fetching it", async () => {
  const f = recordingFetch(() => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
  try {
    for (const url of [
      "http://127.0.0.1:8080/admin.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/x.png",
      "http://[::1]/x.png",
      "http://10.0.0.5/x.png",
    ]) {
      assert.equal(await buildInlineImageBlock(url), null, url);
    }
    assert.deepEqual(f.seen, [], "no request may reach a private address");
  } finally {
    f.restore();
  }
});

test("buildInlineImageBlock: refuses a public URL that redirects into the private network", async () => {
  const f = recordingFetch((url) =>
    url === PUBLIC
      ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
      : new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
  try {
    assert.equal(await buildInlineImageBlock(PUBLIC), null);
    assert.deepEqual(f.seen, [PUBLIC], "the redirect target must never be requested");
  } finally {
    f.restore();
  }
});

test("buildInlineImageBlock: still follows a public-to-public redirect", async () => {
  const f = recordingFetch((url) =>
    url === PUBLIC
      ? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/final.png" } })
      : new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
  try {
    const block = await buildInlineImageBlock(PUBLIC);
    assert.ok(block, "a redirect between public hosts must still inline");
    assert.deepEqual(f.seen, [PUBLIC, "https://8.8.8.8/final.png"]);
  } finally {
    f.restore();
  }
});

test("buildInlineImageBlock: refuses non-http(s) schemes other than a data:image URI", async () => {
  const f = recordingFetch(() => new Response(PNG, { status: 200 }));
  try {
    assert.equal(await buildInlineImageBlock("file:///etc/passwd"), null);
    assert.deepEqual(f.seen, []);
  } finally {
    f.restore();
  }
});

test("buildInlineImageBlock: a data:image URI from an image2image route still inlines", async () => {
  const block = await buildInlineImageBlock(`data:image/png;base64,${PNG.toString("base64")}`);
  assert.ok(block, "data URIs touch no network and must keep working");
  assert.equal(block.mimeType, "image/jpeg");
});
