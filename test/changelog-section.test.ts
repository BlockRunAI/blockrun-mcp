// Run with: npm test  (tsx --test)
//
// publish.yml builds GitHub release notes from the CHANGELOG entry, so an
// extractor bug ships an empty or wrong-version release. 0.32.1 and 0.32.2 both
// reached npm with no tag and no release at all, which is what this automation
// exists to prevent — it needs to be right.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs helper, no types
import { extractSection } from "../scripts/changelog-section.mjs";

const CHANGELOG = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

test("extracts a real section and stops at the next version heading", () => {
  const s = extractSection(CHANGELOG, "0.32.2") as string;
  assert.ok(s, "0.32.2 section must be found");
  assert.match(s, /128 KiB/);
  assert.doesNotMatch(s, /^## /m, "must not swallow the next heading");
  assert.doesNotMatch(s, /gpt-oss-120b and gpt-oss-20b are back/, "must not bleed into 0.32.1");
});

test("each version returns its OWN section", () => {
  const a = extractSection(CHANGELOG, "0.32.1") as string;
  const b = extractSection(CHANGELOG, "0.32.2") as string;
  assert.notEqual(a, b);
  assert.match(a, /never retired/);
  assert.match(b, /truncat/i);
});

test("the heading itself is dropped (the release title already carries it)", () => {
  const s = extractSection(CHANGELOG, "0.32.2") as string;
  assert.doesNotMatch(s.split("\n")[0] ?? "", /^## /);
});

test("an unknown version returns null rather than an empty release", () => {
  assert.equal(extractSection(CHANGELOG, "99.99.99"), null);
});

// A version is used as a literal, not spliced into a regex — otherwise the dots
// in "1.2.3" would match any character and select the wrong section.
test("version matching is literal, not regex", () => {
  const fake = "## 1x2x3\n\nwrong section\n\n## 1.2.3\n\nright section\n";
  assert.equal(extractSection(fake, "1.2.3"), "right section");
});

test("a prefix version does not match a longer one", () => {
  const fake = "## 0.32.11\n\neleven\n\n## 0.32.1\n\none\n";
  assert.equal(extractSection(fake, "0.32.1"), "one");
});

test("headings carrying a headline still match", () => {
  const fake = "## 0.9.0 — some headline\n\nbody here\n";
  assert.equal(extractSection(fake, "0.9.0"), "body here");
});

test("a section with no body returns null, so the workflow can fall back", () => {
  assert.equal(extractSection("## 1.0.0\n\n## 0.9.0\n\nbody\n", "1.0.0"), null);
});
