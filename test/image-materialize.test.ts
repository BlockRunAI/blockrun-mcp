// Run with: npm test  (tsx --test)
//
// materializeImageUrl persists a data: URI the image2image routes ship verbatim
// (google/nano-banana returns multi-megabyte base64) to a temp file and hands
// back the path. The subtype it captures is UPSTREAM OUTPUT spliced into the
// filename, which a round-4 finder read as a traversal: "the class admits `.`,
// so `../` can escape tmpdir". It cannot — the capture is `[a-z0-9.+-]+`, which
// admits neither `/` nor `\`, so the subtype is always the tail of ONE path
// segment and path.join has nothing to normalise. Refuted, and pinned here so
// that widening the class later (say, to accept `image/svg+xml;charset=…`)
// cannot quietly reopen the question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { materializeImageUrl } from "../src/tools/image.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const cleanup: string[] = [];
process.on("exit", () => { for (const f of cleanup) rmSync(f, { force: true }); });

test("a subtype carrying a path separator is not a data URI to this function — returned verbatim, nothing written", async () => {
  for (const subtype of ["../../x", "png/../../x", "..\\..\\x", "png/../../../etc/passwd"]) {
    const uri = `data:image/${subtype};base64,${PNG_B64}`;
    assert.equal(await materializeImageUrl(uri), uri, subtype);
  }
});

test("a separator-free subtype — dots included — lands as one segment inside tmpdir", async () => {
  for (const subtype of [".", "..", "...", "png..", "a.b.c", "svg+xml", "PNG"]) {
    const file = await materializeImageUrl(`data:image/${subtype};base64,${PNG_B64}`);
    cleanup.push(file);
    assert.equal(dirname(file), tmpdir(), `${subtype}: wrote to ${file}`);
    assert.match(basename(file), /^blockrun-image-\d+-[0-9a-f]{8}\./, `${subtype}: ${file}`);
    assert.ok(existsSync(file));
  }
});

test("jpeg maps to .jpg; other subtypes keep their own lowercased extension", async () => {
  for (const [subtype, ext] of [["jpeg", "jpg"], ["JPEG", "jpg"], ["png", "png"], ["WebP", "webp"]] as const) {
    const file = await materializeImageUrl(`data:image/${subtype};base64,${PNG_B64}`);
    cleanup.push(file);
    assert.match(file, new RegExp(`\\.${ext}$`), `${subtype} -> ${file}`);
  }
});

test("a non-data URL and an undecodable data URI pass through untouched", async () => {
  assert.equal(await materializeImageUrl("https://blockrun.ai/media/x.png"), "https://blockrun.ai/media/x.png");
  assert.equal(await materializeImageUrl("data:image/png,notbase64"), "data:image/png,notbase64");
});
