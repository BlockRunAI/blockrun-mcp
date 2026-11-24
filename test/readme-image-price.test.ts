// Run with: npm test  (tsx --test)
//
// The README tool table's `blockrun_image` cost cell is a public price claim.
// It said "$0.015–0.15" for months while the tool's own tables reached $0.30
// (nano-banana-pro at 4096x4096) and $0.56 (gpt-image-2.5 at 1536x1024 /
// 1024x1536), because nothing compared it with anything. Derive the range
// from the same catalog tables estimateCost() reads, so the next reprice or
// model addition fails here instead of leaving the README behind.
//
// The figures are CATALOG prices (what the tool description quotes per
// model), not the charged amount — the README states the catalog range, and
// the charge (x1.05 + fee) is verified separately by verify:prices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GENERATE_MODEL_COST, LARGE_SIZE_COST } from "../src/tools/image.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README blockrun_image price range is the min and max of the image price tables", () => {
  const prices = [...Object.values(GENERATE_MODEL_COST), ...Object.values(LARGE_SIZE_COST)];
  assert.ok(prices.length > 0 && prices.every((p) => p > 0), "price tables must be populated");
  const range = `$${Math.min(...prices)}–${Math.max(...prices)}`;

  const row = README.split("\n").find((line) => line.startsWith("| `blockrun_image` |"));
  assert.ok(row, "README tool table has no blockrun_image row");
  const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
  assert.equal(cells.at(-1), range, `README blockrun_image cost should read ${range}`);
});
