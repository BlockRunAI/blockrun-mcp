// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { modalTimeoutMs } from "../src/tools/modal.js";

const FLOOR_MS = 300 * 1000 + 15_000; // 315000
const SLACK = 15_000;

test("modalTimeoutMs floors at the 300s sandbox default + slack", () => {
  assert.equal(modalTimeoutMs(undefined), FLOOR_MS);
  assert.equal(modalTimeoutMs({}), FLOOR_MS);
  assert.equal(modalTimeoutMs("not an object"), FLOOR_MS);
  assert.equal(modalTimeoutMs({ timeout: 60 }), FLOOR_MS, "below floor → floored");
  assert.equal(modalTimeoutMs({ timeout: 0 }), FLOOR_MS);
  assert.equal(modalTimeoutMs({ timeout: -5 }), FLOOR_MS);
  assert.equal(modalTimeoutMs({ timeout: "600" }), FLOOR_MS, "non-number ignored");
});

test("modalTimeoutMs honors a longer requested timeout (no 60s premature abort)", () => {
  assert.equal(modalTimeoutMs({ timeout: 600 }), 600 * 1000 + SLACK);
  assert.equal(modalTimeoutMs({ timeout: 1200 }), 1200 * 1000 + SLACK);
});

test("modalTimeoutMs caps at 30 min so a hung exec can't block forever", () => {
  assert.equal(modalTimeoutMs({ timeout: 3000 }), 1800 * 1000 + SLACK);
  assert.equal(modalTimeoutMs({ timeout: 99999 }), 1800 * 1000 + SLACK);
});
