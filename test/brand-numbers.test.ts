// Run with: npm test  (tsx --test)
//
// Pins the tool count that BlockRun publishes but cannot count.
//
// blockrun.ai/brand/numbers.json is the artifact every public repo's marketing
// copy is generated from. Most of it is derived from the model catalog, so it
// cannot go stale. `mcp.tools` is different: it lives in THIS repo's code, so
// over there it is hand-asserted.
//
// This test is what makes that safe. Add or drop a tool and the build fails
// HERE — in the repo that can fix it — instead of quietly making a claim wrong
// in the README, on npm, and in awesome-blockrun's ecosystem table.
//
// When it fails: confirm the change is intended, update brand-numbers.json, and
// update the same number in blockrun's src/app/brand/numbers.json/route.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ALL_TOOLS, PROFILES, resolveTools } from "../src/profiles.js";

const published = JSON.parse(
  readFileSync(new URL("../brand-numbers.json", import.meta.url), "utf8"),
) as { mcp: { tools: number }; chains: { rpc: number } };

test("ships the advertised number of tools", () => {
  assert.equal(ALL_TOOLS.length, published.mcp.tools);
});

test("the default profile is the one the count describes", () => {
  // Copy states the tool count without qualification, so it has to be what an
  // agent gets by default — not a maximum only reachable with a flag.
  const { tools } = resolveTools(undefined, {});
  assert.equal(tools.size, published.mcp.tools);
});

test("the README hero badge shows the published count", () => {
  // The count is baked into a shields URL and its alt text. A marker cannot go
  // inside an HTML attribute without breaking the tag, so this is the one
  // surface scripts/sync-brand-numbers.mjs cannot reach.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const n = published.mcp.tools;
  assert.ok(readme.includes(`badge/🧰_${n}_Tools-success`), "badge URL");
  assert.ok(readme.includes(`alt="${n} tools"`), "badge alt text");
});

test("no profile advertises a tool that does not exist", () => {
  const known = new Set<string>(ALL_TOOLS);
  for (const [name, tools] of Object.entries(PROFILES)) {
    if (tools === "all") continue;
    for (const tool of tools) {
      assert.ok(known.has(tool), `profile ${name} names unknown tool ${tool}`);
    }
  }
});

test("skills frontmatter states the published chain count", () => {
  // A skill's YAML frontmatter becomes the description an agent reads when
  // deciding whether to load it. A marker there is not inert — it would be
  // part of the string — so these are literals, asserted instead.
  const n = published.chains.rpc;
  for (const f of ["skills/rpc/SKILL.md", "skills/crypto-data/SKILL.md"]) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const frontmatter = text.slice(0, text.indexOf("\n---", 4));
    assert.ok(
      frontmatter.includes(`${n} chains`),
      `${f} frontmatter must say "${n} chains"`,
    );
  }
});
