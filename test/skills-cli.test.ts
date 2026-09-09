// Run with: npm test  (tsx --test)
//
// `blockrun-mcp skills install` copies the skills that ship inside the npm
// tarball (package.json "files" has carried `skills/` since 0.2x) into a
// project or user skills directory. Until this command existed the only ways
// to get them were cloning the repo or `/plugin marketplace add` — neither
// works for Codex, Cursor, or a CI image that just ran `npx @blockrun/mcp`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills, listSkills, parseSkillsArgs, resolveSkillsTarget, runSkillsCli, SKILLS_SOURCE_DIR } from "../src/cli/skills.js";

function fixture(): { from: string; to: string } {
  const root = mkdtempSync(join(tmpdir(), "br-skills-"));
  const from = join(root, "skills");
  const to = join(root, "dest");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(from, name, "rules"), { recursive: true });
    writeFileSync(join(from, name, "SKILL.md"), `---\nname: ${name}\ndescription: "x"\n---\n# ${name}\n`);
    writeFileSync(join(from, name, "rules", "r.md"), `rule for ${name}\n`);
  }
  // Noise that must NOT be treated as a skill: a stray file and a dir without SKILL.md.
  writeFileSync(join(from, "README.md"), "not a skill\n");
  mkdirSync(join(from, "not-a-skill"));
  return { from, to };
}

test("listSkills returns only directories that carry a SKILL.md, sorted", () => {
  const { from } = fixture();
  assert.deepEqual(listSkills(from).map((s) => s.name), ["alpha", "beta"]);
});

test("listSkills reads the description out of the frontmatter", () => {
  const { from } = fixture();
  assert.equal(listSkills(from)[0].description, "x");
});

test("installSkills copies every skill directory recursively", () => {
  const { from, to } = fixture();
  const r = installSkills({ from, to });
  assert.deepEqual(r.installed, ["alpha", "beta"]);
  assert.deepEqual(r.skipped, []);
  assert.equal(readFileSync(join(to, "alpha", "SKILL.md"), "utf8").includes("name: alpha"), true);
  assert.equal(readFileSync(join(to, "beta", "rules", "r.md"), "utf8"), "rule for beta\n");
  assert.equal(existsSync(join(to, "README.md")), false, "stray files are not skills");
  assert.equal(existsSync(join(to, "not-a-skill")), false, "a dir without SKILL.md is not a skill");
});

test("installSkills skips an existing skill unless --force, and never deletes user files", () => {
  const { from, to } = fixture();
  mkdirSync(join(to, "alpha"), { recursive: true });
  writeFileSync(join(to, "alpha", "SKILL.md"), "user-edited\n");
  writeFileSync(join(to, "alpha", "NOTES.md"), "keep me\n");

  const first = installSkills({ from, to });
  assert.deepEqual(first.installed, ["beta"]);
  assert.deepEqual(first.skipped, ["alpha"]);
  assert.equal(readFileSync(join(to, "alpha", "SKILL.md"), "utf8"), "user-edited\n");

  const forced = installSkills({ from, to, force: true });
  assert.deepEqual(forced.installed, ["alpha", "beta"]);
  assert.equal(readFileSync(join(to, "alpha", "SKILL.md"), "utf8").includes("name: alpha"), true);
  assert.equal(readFileSync(join(to, "alpha", "NOTES.md"), "utf8"), "keep me\n", "--force overwrites ours, keeps theirs");
});

test("installSkills --only restricts to the named skills and rejects unknown names", () => {
  const { from, to } = fixture();
  const r = installSkills({ from, to, only: ["beta"] });
  assert.deepEqual(r.installed, ["beta"]);
  assert.equal(existsSync(join(to, "alpha")), false);
  assert.throws(() => installSkills({ from, to, only: ["nope"] }), /unknown skill.*nope/i);
});

test("installSkills refuses a destination inside the source tree", () => {
  const { from } = fixture();
  assert.throws(() => installSkills({ from, to: join(from, "alpha") }), /inside the source/i);
});

test("parseSkillsArgs: subcommands, --to, --global, --force, --only", () => {
  assert.deepEqual(parseSkillsArgs(["list"]), { cmd: "list", help: false, force: false, global: false, only: undefined, to: undefined });
  assert.deepEqual(parseSkillsArgs(["install"]), { cmd: "install", help: false, force: false, global: false, only: undefined, to: undefined });
  assert.deepEqual(parseSkillsArgs(["install", "--global", "--force"]), { cmd: "install", help: false, force: true, global: true, only: undefined, to: undefined });
  assert.deepEqual(parseSkillsArgs(["install", "--to", "/x/y"]).to, "/x/y");
  assert.deepEqual(parseSkillsArgs(["install", "--to=/x/y"]).to, "/x/y");
  assert.deepEqual(parseSkillsArgs(["install", "--only", "a,b"]).only, ["a", "b"]);
  assert.deepEqual(parseSkillsArgs(["install", "--only=a, b"]).only, ["a", "b"]);
  assert.equal(parseSkillsArgs([]).cmd, "help");
  assert.equal(parseSkillsArgs(["bogus"]).cmd, "help");
  assert.throws(() => parseSkillsArgs(["install", "--to"]), /--to requires/);
});

test("parseSkillsArgs tells a help REQUEST apart from an unknown subcommand", () => {
  // Same cmd ("help", same usage text); different intent, and runSkillsCli
  // turns that into exit 0 vs exit 2.
  for (const argv of [[], ["--help"], ["-h"], ["install", "--help"], ["install", "-h"], ["list", "--help"], ["install", "--global", "-h"]]) {
    const a = parseSkillsArgs(argv);
    assert.equal(a.cmd, "help", `${argv.join(" ")}: cmd`);
    assert.equal(a.help, true, `${argv.join(" ")}: is an explicit help request`);
  }
  const bogus = parseSkillsArgs(["bogus"]);
  assert.equal(bogus.cmd, "help");
  assert.equal(bogus.help, false, "an unknown subcommand is NOT a help request");
});

// runSkillsCli is the exact function index.ts hands `process.exit`, so these
// are the exit codes a shell sees. `skills install --help` used to print the
// usage and exit 2 — the form index.ts's own comment promises works — which
// aborts any `&&`-chained setup script that probes the command first.
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); } }, out, err };
}

test("runSkillsCli: an explicit help request exits 0 with the usage on stdout, wherever the flag sits", () => {
  for (const argv of [[], ["--help"], ["-h"], ["install", "--help"], ["list", "-h"], ["install", "--global", "--help"]]) {
    const c = capture();
    const code = runSkillsCli(argv, c.io);
    assert.equal(code, 0, `skills ${argv.join(" ")}: exit code`);
    assert.match(c.out.join(""), /Usage:/, `skills ${argv.join(" ")}: usage on stdout`);
    assert.equal(c.err.join(""), "", `skills ${argv.join(" ")}: nothing on stderr`);
  }
});

test("runSkillsCli: an unknown subcommand exits 2 and names it on stderr", () => {
  const c = capture();
  const code = runSkillsCli(["bogus"], c.io);
  assert.equal(code, 2);
  assert.match(c.err.join(""), /Unknown skills subcommand: bogus/);
  assert.match(c.err.join(""), /Usage:/, "the usage follows the complaint");
  assert.equal(c.out.join(""), "", "nothing on stdout for an error");
});

test("runSkillsCli: a bad option still exits 2 via the parse error", () => {
  const c = capture();
  assert.equal(runSkillsCli(["install", "--to"], c.io), 2);
  assert.match(c.err.join(""), /--to requires/);
});

test("runSkillsCli: `list` exits 0 and prints the shipped skills", () => {
  const c = capture();
  assert.equal(runSkillsCli(["list"], c.io), 0);
  assert.match(c.out.join(""), /blockrun-setup/);
});

test("runSkillsCli: `install --to <tmp>` exits 0 and copies the skills", () => {
  const to = mkdtempSync(join(tmpdir(), "br-skills-cli-"));
  try {
    const c = capture();
    assert.equal(runSkillsCli(["install", "--to", to], c.io), 0);
    assert.ok(existsSync(join(to, "blockrun", "SKILL.md")));
    assert.match(c.out.join(""), /installed/);
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
});

test("resolveSkillsTarget: project .claude/skills by default, ~/.claude/skills with --global, --to wins", () => {
  const cwd = "/proj";
  const home = "/home/me";
  assert.equal(resolveSkillsTarget({ global: false }, cwd, home), join(cwd, ".claude", "skills"));
  assert.equal(resolveSkillsTarget({ global: true }, cwd, home), join(home, ".claude", "skills"));
  assert.equal(resolveSkillsTarget({ global: true, to: "/elsewhere" }, cwd, home), "/elsewhere");
  assert.equal(resolveSkillsTarget({ to: "~/.codex/skills" }, cwd, home), join(home, ".codex", "skills"));
  assert.equal(resolveSkillsTarget({ to: "rel/skills" }, cwd, home), join(cwd, "rel", "skills"));
});

test("the shipped skills directory resolves and contains the real skills", () => {
  // Resolved relative to the module the way index.ts resolves package.json,
  // so it must work from src/ under tsx and from dist/ under npx alike.
  assert.ok(existsSync(join(SKILLS_SOURCE_DIR, "blockrun", "SKILL.md")), SKILLS_SOURCE_DIR);
  const names = listSkills(SKILLS_SOURCE_DIR).map((s) => s.name);
  const onDisk = readdirSync(join(SKILLS_SOURCE_DIR)).filter((d) => existsSync(join(SKILLS_SOURCE_DIR, d, "SKILL.md"))).sort();
  assert.deepEqual(names, onDisk);
  // and a real install round-trips
  const to = mkdtempSync(join(tmpdir(), "br-skills-real-"));
  const r = installSkills({ from: SKILLS_SOURCE_DIR, to });
  assert.deepEqual(r.installed, onDisk);
  rmSync(to, { recursive: true, force: true });
});
