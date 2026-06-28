// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toImageDataUri } from "../src/tools/image.js";

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
