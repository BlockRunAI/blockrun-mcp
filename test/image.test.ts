// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
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

test("toImageDataUri rejects a remote image by Content-Length before buffering it", async () => {
  // A large advertised Content-Length must be rejected up front so an oversized
  // remote image can't be fully buffered into memory (OOM) just to be rejected.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(5_000_000) });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // tiny body; header is what matters
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  try {
    await assert.rejects(() => toImageDataUri(`http://127.0.0.1:${port}/`), /too large/i);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
