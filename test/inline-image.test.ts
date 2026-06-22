// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldInline, buildInlineImageBlock } from "../src/utils/inline-image.js";

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
    assert.equal(await buildInlineImageBlock("https://example.com/x.png"), null);
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
    assert.equal(await buildInlineImageBlock("https://example.com/x.png"), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("buildInlineImageBlock: encodes a small image into a base64 JPEG block", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })) as typeof fetch;
  try {
    const block = await buildInlineImageBlock("https://example.com/x.png");
    assert.ok(block, "expected an image block");
    assert.equal(block.type, "image");
    assert.equal(block.mimeType, "image/jpeg");
    assert.ok(block.data.length > 0);
    assert.doesNotThrow(() => Buffer.from(block.data, "base64")); // valid base64
  } finally {
    globalThis.fetch = orig;
  }
});
