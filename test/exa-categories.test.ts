// Exa retired the "tweet" category: since 2026-11-03 at the latest it answers
// 400 "no longer supported". An agent reads these two surfaces to choose a
// category, so neither may offer it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const file of ["src/tools/exa.ts", "skills/exa-research/SKILL.md"]) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  test(`${file} does not offer the retired "tweet" category`, () => {
    assert.doesNotMatch(text, /["`]tweet["`]/);
  });

  test(`${file} still lists the categories Exa accepts, and says Exa has no X content`, () => {
    assert.match(text, /"news"/);
    assert.match(text, /"company"/);
    assert.match(text, /Exa does not serve X\/Twitter content/);
  });
}
