// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { toImageDataUri, buildSolanaImageRequest, materializeImageUrl } from "../src/tools/image.js";

const tmp = mkdtempSync(join(tmpdir(), "blockrun-img-"));

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

test("toImageDataUri passes through an existing data URI unchanged", async () => {
  const uri = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(await toImageDataUri(uri), uri);
});

test("toImageDataUri encodes a local .png into a data:image/png URI", async () => {
  const p = join(tmp, "pic.png");
  writeFileSync(p, PNG_BYTES);
  const out = await toImageDataUri(p);
  assert.match(out, /^data:image\/png;base64,/);
  assert.equal(out, `data:image/png;base64,${PNG_BYTES.toString("base64")}`);
});

test("toImageDataUri maps .jpg/.jpeg to image/jpeg", async () => {
  const p = join(tmp, "pic.jpeg");
  writeFileSync(p, PNG_BYTES); // bytes irrelevant to mime mapping
  const out = await toImageDataUri(p);
  assert.match(out, /^data:image\/jpeg;base64,/);
});

test("toImageDataUri rejects an unsupported extension", async () => {
  const p = join(tmp, "notes.txt");
  writeFileSync(p, "hello");
  await assert.rejects(() => toImageDataUri(p), /unsupported image extension/);
});

test("toImageDataUri rejects a file over the 4MB cap", async () => {
  const p = join(tmp, "huge.png");
  writeFileSync(p, Buffer.alloc(4_000_001, 0));
  await assert.rejects(() => toImageDataUri(p), /too large/);
});

test("toImageDataUri refuses to fetch a loopback/link-local URL (SSRF guard)", async () => {
  // A supplied/prompt-injected reference URL must not reach localhost, the cloud
  // metadata endpoint, or the private network. The guard rejects before fetch.
  await assert.rejects(() => toImageDataUri("http://127.0.0.1:1/x.png"), /refusing to fetch/i);
  await assert.rejects(() => toImageDataUri("http://169.254.169.254/latest/meta-data/"), /refusing to fetch/i);
  await assert.rejects(() => toImageDataUri("http://10.0.0.5/internal.png"), /refusing to fetch/i);
});

test("buildSolanaImageRequest generate targets /v1/images/generations with quality omitted for standard", () => {
  const { endpoint, body } = buildSolanaImageRequest("generate", {
    model: "openai/gpt-image-2",
    prompt: "a fox",
    size: "1024x1024",
    quality: "standard",
  });
  assert.equal(endpoint, "/v1/images/generations");
  assert.deepEqual(body, { model: "openai/gpt-image-2", prompt: "a fox", size: "1024x1024", n: 1 });
});

test("buildSolanaImageRequest maps quality hd → high (the gateway's zod enum has no 'hd')", () => {
  const { body } = buildSolanaImageRequest("generate", {
    model: "openai/gpt-image-2",
    prompt: "a fox",
    size: "1024x1024",
    quality: "hd",
  });
  assert.equal(body.quality, "high");
});

test("buildSolanaImageRequest edit targets /v1/images/image2image with image and optional mask", () => {
  const withMask = buildSolanaImageRequest("edit", {
    model: "openai/gpt-image-1",
    prompt: "add a hat",
    size: "1024x1024",
    image: "data:image/png;base64,AAAA",
    mask: "data:image/png;base64,BBBB",
  });
  assert.equal(withMask.endpoint, "/v1/images/image2image");
  assert.deepEqual(withMask.body, {
    model: "openai/gpt-image-1",
    prompt: "add a hat",
    image: "data:image/png;base64,AAAA",
    size: "1024x1024",
    n: 1,
    mask: "data:image/png;base64,BBBB",
  });

  const noMask = buildSolanaImageRequest("edit", {
    model: "google/nano-banana",
    prompt: "fuse these",
    size: "1024x1024",
    image: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
  });
  assert.equal("mask" in noMask.body, false);
  assert.deepEqual(noMask.body.image, ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]);
});

test("materializeImageUrl passes hosted URLs and local paths through unchanged", async () => {
  const url = "https://sol.blockrun.ai/api/media/images/x.png";
  assert.equal(await materializeImageUrl(url), url);
  assert.equal(await materializeImageUrl("/tmp/pic.png"), "/tmp/pic.png");
});

test("materializeImageUrl saves a data: URI to a temp file with the right bytes", async () => {
  // image2image ships the provider output verbatim — nano-banana returns a
  // multi-MB data URI. The tool must hand back a file path, never the base64.
  const out = await materializeImageUrl(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  assert.doesNotMatch(out, /^data:/);
  assert.match(out, /blockrun-image-.*\.png$/);
  assert.deepEqual(readFileSync(out), PNG_BYTES);
});

test("materializeImageUrl maps image/jpeg data URIs to a .jpg file", async () => {
  const out = await materializeImageUrl(`data:image/jpeg;base64,${PNG_BYTES.toString("base64")}`);
  assert.match(out, /\.jpg$/);
});
