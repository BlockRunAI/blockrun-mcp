// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// A SKILL.md whose YAML frontmatter fails to parse is not a degraded skill —
// it is an ABSENT one. The loader gets no `name`, so the skill is never
// registered and Claude never learns it exists. Nothing else in this repo
// notices: it builds, it publishes, the file sits there looking correct, and
// the only symptom is that the model never uses a capability we shipped.
//
// That is not hypothetical. `prediction-markets` shipped DEAD for several
// releases on this one line:
//
//   description: ... you CANNOT get from a public API: historical price ...
//                                                    ^^
//
// In YAML a plain (unquoted) scalar may not contain ": " — the parser sees a
// nested mapping and rejects the whole block. The prose reads perfectly to a
// human reviewer, which is exactly why review missed it. The fix is to quote
// the scalar; this test is the thing that would have caught it.
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

function frontmatterOf(file: string): string {
  const match = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${file}: no --- frontmatter block; the skill cannot be registered`);
  return match[1];
}

const skillDirs = readdirSync(SKILLS_DIR).filter((d) => existsSync(join(SKILLS_DIR, d, "SKILL.md")));

test("every skill ships at least one SKILL.md", () => {
  assert.ok(skillDirs.length > 0, "no skills found — is SKILLS_DIR wrong?");
});

test("every SKILL.md frontmatter is parseable YAML with a name and description", () => {
  for (const dir of skillDirs) {
    const file = join(SKILLS_DIR, dir, "SKILL.md");
    let meta: unknown;
    try {
      meta = parse(frontmatterOf(file));
    } catch (err) {
      // Fail loudly with the parser's own message — "Nested mappings are not
      // allowed in compact mappings" is the signature of an unquoted ": ".
      assert.fail(
        `skills/${dir}/SKILL.md: frontmatter is not valid YAML, so this skill NEVER LOADS.\n` +
          `  ${(err as Error).message}\n` +
          `  If the description contains ": ", wrap the whole scalar in double quotes.`,
      );
    }
    assert.ok(meta && typeof meta === "object", `skills/${dir}: frontmatter is not a mapping`);
    const { name, description } = meta as { name?: unknown; description?: unknown };
    assert.equal(typeof name, "string", `skills/${dir}: missing a string \`name\` — the skill cannot be registered`);
    assert.equal(name, dir, `skills/${dir}: frontmatter name "${String(name)}" must match its directory`);
    assert.equal(
      typeof description,
      "string",
      `skills/${dir}: missing a string \`description\` — the model has nothing to route on`,
    );
    assert.ok(
      (description as string).trim().length > 0,
      `skills/${dir}: empty description — the skill will never be selected`,
    );
  }
});
