import assert from "node:assert/strict";
import test from "node:test";

import { formatReadOnlyPreviewText } from "../src/tools/polymarket.js";

test("read-only preview removes confirm:true trading guidance", () => {
  const generic = [
    "DRY RUN — no order placed.",
    "BUY token 123…",
    "",
    "Re-call with confirm:true to sign and submit.",
  ].join("\n");

  const actual = formatReadOnlyPreviewText(generic);

  assert.equal(actual.includes("confirm:true"), false);
  assert.match(actual, /READ-ONLY PREVIEW — this tool cannot sign or submit an order\.$/);
  assert.match(actual, /^DRY RUN — no order placed\./);
});

test("read-only preview formatter leaves unexpected messages unchanged", () => {
  const error = "Market is closed.";
  assert.equal(formatReadOnlyPreviewText(error), error);
});
