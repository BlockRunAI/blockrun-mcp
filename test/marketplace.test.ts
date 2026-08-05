// Run with: npm test  (tsx --test)
//
// A skill that is not listed in .claude-plugin/marketplace.json is unreachable.
// `/plugin marketplace add BlockRunAI/blockrun-mcp` shows the user exactly the
// entries in that file, so an unlisted SKILL.md is shipped, published to npm,
// and installable by nobody.
//
// That is not hypothetical either. Nine of thirteen skills sat unreachable —
// `crypto-data`, `surf`, `rpc`, `search`, `image-prompting`, `phone`, `modal`,
// `gentech-blockrun` and `blockrun` — until 0.37.1. No decision was ever taken
// to withhold them: an entry got added alongside whichever skill prompted it,
// and the rest were never backfilled. Nothing failed, because nothing looked.
//
// The failure mode is silence in BOTH directions, which is why this checks
// both: an unregistered directory is invisible to users, and an entry pointing
// at a directory that moved or was renamed is a broken install rather than a
// missing one.
//
// Sibling guard: skill-frontmatter.test.ts proves each SKILL.md can LOAD.
// This file proves it can be REACHED. A skill needs both, and neither implies
// the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, "skills");
const MARKETPLACE = join(ROOT, ".claude-plugin", "marketplace.json");

type Entry = { name?: unknown; source?: unknown; description?: unknown };

const marketplace = JSON.parse(readFileSync(MARKETPLACE, "utf8")) as { plugins?: Entry[] };
const entries = marketplace.plugins ?? [];

// A directory is a shippable skill exactly when it carries a SKILL.md at its
// root — that root file is what makes the plugin register a skill (verified on
// 0.37.1 with `claude plugin details`, which reports `Skills (1)` for this
// layout despite there being no .claude-plugin/plugin.json). Same definition
// skill-frontmatter.test.ts uses, deliberately: the two tests must agree on
// what counts as a skill or one of them can pass vacuously.
const skillDirs = readdirSync(SKILLS_DIR).filter((d) => existsSync(join(SKILLS_DIR, d, "SKILL.md")));

test("marketplace.json parses and lists plugins", () => {
  assert.ok(Array.isArray(marketplace.plugins), ".claude-plugin/marketplace.json has no `plugins` array");
  assert.ok(entries.length > 0, "marketplace lists no plugins at all");
});

test("every skill on disk is registered in the marketplace", () => {
  const registered = new Set(entries.map((e) => e.name));
  const missing = skillDirs.filter((d) => !registered.has(d));
  assert.deepEqual(
    missing,
    [],
    `these skills exist on disk but are NOT installable — nobody can reach them:\n` +
      missing.map((d) => `  skills/${d}/`).join("\n") +
      `\n  Add an entry to .claude-plugin/marketplace.json:\n` +
      missing
        .map((d) => `    { "name": "${d}", "source": "./skills/${d}", "description": "Use when …" }`)
        .join("\n"),
  );
});

test("every marketplace entry points at a skill that exists", () => {
  const orphans = entries
    .map((e) => String(e.name))
    .filter((n) => !skillDirs.includes(n));
  assert.deepEqual(
    orphans,
    [],
    `these marketplace entries have no skills/<name>/SKILL.md, so installing them yields an empty plugin:\n` +
      orphans.map((n) => `  ${n}`).join("\n"),
  );
});

test("every entry's source path matches its name", () => {
  // The install resolves `source` relative to the repo root. A name/source
  // mismatch installs the wrong skill under the right label, which is worse
  // than a missing entry because it looks like it worked.
  for (const e of entries) {
    assert.equal(
      e.source,
      `./skills/${String(e.name)}`,
      `marketplace entry "${String(e.name)}" has source ${JSON.stringify(e.source)}; expected "./skills/${String(e.name)}"`,
    );
  }
});

test("every entry has a non-empty description", () => {
  // This is the only text a user sees in the marketplace list before
  // installing; an entry without it is registered but unchosen.
  for (const e of entries) {
    assert.equal(typeof e.description, "string", `marketplace entry "${String(e.name)}" has no description`);
    assert.ok(
      (e.description as string).trim().length > 0,
      `marketplace entry "${String(e.name)}" has an empty description`,
    );
  }
});

test("no duplicate entry names", () => {
  const names = entries.map((e) => String(e.name));
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dupes, [], `duplicate marketplace entries: ${dupes.join(", ")}`);
});
