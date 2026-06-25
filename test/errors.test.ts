// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatError } from "../src/utils/errors.js";

test("model-unavailable (token360) → steers to a sibling model, not a generic blip", () => {
  const msg = "Video generation failed: API error 500: token360 video submit failed: Model 'seedance-2.0-fast' not found or not active for requested provider";
  const out = formatError(msg, { altModels: "bytedance/seedance-2.0" });
  assert.match(out, /temporarily unavailable upstream/);
  assert.match(out, /bytedance\/seedance-2\.0/);
  assert.doesNotMatch(out, /temporary API issue/); // not misclassified as a generic 500
});

test("model-unavailable without altModels → neutral guidance, no model named", () => {
  const out = formatError("token360 video submit failed: Model 'x' not active for requested provider");
  assert.match(out, /temporarily unavailable upstream/);
  assert.doesNotMatch(out, /e\.g\./);
});

test("generic 500 no longer suggests openai/gpt-4o", () => {
  const out = formatError("Image generation failed: API error 500: Internal server error");
  assert.match(out, /temporary API issue/);
  assert.doesNotMatch(out, /gpt-4o/);
});

test("generic 500 with altModels names same-domain alternatives", () => {
  const out = formatError("Image generation failed: API error 500: boom", { altModels: "google/nano-banana, zai/cogview-4" });
  assert.match(out, /temporary API issue/);
  assert.match(out, /google\/nano-banana/);
});

test("payment/402 → funding guidance, not server text", () => {
  const out = formatError("API error 402: insufficient balance");
  assert.match(out, /needs funding/);
  assert.doesNotMatch(out, /temporary API issue/);
});

test("plain validation message gets no canned guidance appended", () => {
  const out = formatError("mask cannot be combined with multiple source images");
  assert.equal(out, "Error: mask cannot be combined with multiple source images");
});

test("a dollar amount like $1.4020 is not misread as a 402", () => {
  const out = formatError("charged $1.4020 for the call");
  assert.equal(out, "Error: charged $1.4020 for the call"); // no funding/server text
});
