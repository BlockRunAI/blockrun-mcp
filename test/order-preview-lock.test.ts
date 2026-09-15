// Run with: npm test  (tsx --test)
//
// The order card's outcome-unknown lock must outlive the card that set it
// (audit round 3, D14). After a transport throw the card said "this card will
// not re-submit it" and disabled Place — then re-enabled Re-quote, whose
// handler rendered a brand-new card with a fresh `outcomeUnknown = false` and
// Place enabled. One more click was a second real order on top of one that
// may already be resting at the CLOB. The model was also never told: the
// card called updateModelContext only on success.
//
// The card is DOM code inside a minified single-file bundle, so — like the
// rest of apps.test.ts — this pins the strings and property names that only
// exist if the module-scope lock and the model notification are wired in.
// The predicates the lock keys on (outcomeIsUnknown / declinedByUser) are
// tested as logic in apps.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppHtml } from "../src/apps.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the built card tells the model when an order's outcome is unknown", () => {
  const order = readAppHtml("orderPreview");
  assert.ok(order.includes("its outcome is UNKNOWN"), "model-context message on the unknown path");
  assert.ok(order.includes('action:"orders"'), "…pointing at the order list");
  assert.ok(order.includes('action:"positions"'), "…and at positions");
  assert.ok(/outcome:["'`]unknown["'`]/.test(order), "structured outcome for the model");
});

test("the built card keeps the lock across Re-quote", () => {
  const order = readAppHtml("orderPreview");
  // The re-rendered-while-locked note only exists on the module-scope path.
  assert.ok(order.includes("A previous submit of this order did not complete"), "a re-quoted card renders locked");
});

test("the source declares the lock at module scope, not inside renderPreview", () => {
  const src = readFileSync(join(ROOT, "apps", "order-preview.ts"), "utf8");
  const declaration = src.indexOf("const unknownOutcomes = new Map");
  const renderPreview = src.indexOf("function renderPreview(");
  assert.ok(declaration > -1, "unknownOutcomes map exists");
  assert.ok(declaration < renderPreview, "the lock must be declared before (outside) renderPreview so Re-quote cannot reset it");
  assert.ok(/let outcomeUnknown = unknownOutcomes\.has\(/.test(src), "renderPreview must initialise its flag from the module-scope lock");
  assert.ok(!/let outcomeUnknown = false/.test(src), "the per-render `false` initialiser is the bug");
});
