// src/cli/skills.ts
//
// `blockrun-mcp skills list | install` — copy the skills that ship inside the
// npm tarball into a project or user skills directory.
//
// The skills have been in the package since `files: ["skills"]` was added, and
// Claude Code users get them via `/plugin marketplace add BlockRunAI/blockrun-mcp`.
// Everyone else — Codex (~/.codex/skills), Cursor, a CI image, a project that
// wants them checked in under .claude/skills — had no path short of cloning
// the repo. This is that path.
//
// Pure core (installSkills / listSkills / resolveSkillsTarget) takes explicit
// paths so tests run against tmp dirs; the argv shim (runSkillsCli) is what
// index.ts calls before it would otherwise start the stdio server.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the shipped skills live. This module runs from two places: src/cli/
 * under tsx (skills/ is two levels up) and dist/index.js under npx, where tsup
 * has bundled it (skills/ is one level up). Rather than hard-code either, walk
 * up from the module until the directory that holds package.json AND skills/
 * — the package root — is found.
 */
export const SKILLS_SOURCE_DIR = locateSkillsDir(fileURLToPath(import.meta.url));

function locateSkillsDir(start: string): string {
  let dir = dirname(start);
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "skills"))) return join(dir, "skills");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the bundled layout so the error message names a real path.
  return join(dirname(dirname(start)), "skills");
}

export interface SkillInfo {
  name: string;
  description: string;
}

/** Skills = subdirectories carrying a SKILL.md. Sorted for stable output. */
export function listSkills(from: string): SkillInfo[] {
  if (!existsSync(from)) return [];
  return readdirSync(from)
    .filter((d) => {
      const p = join(from, d);
      return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
    })
    .sort()
    .map((name) => ({ name, description: readDescription(join(from, name, "SKILL.md")) }));
}

// The first `description:` scalar in the frontmatter, single-line form only.
// Multi-line (`description: |`) descriptions fall back to the first non-empty
// continuation line. Display-only — the authoritative parse is the client's.
function readDescription(skillMd: string): string {
  const text = readFileSync(skillMd, "utf8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return "";
  const inline = lines[i].replace(/^description:\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (inline && inline !== "|" && inline !== ">") return inline;
  const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
  return (next ?? "").trim();
}

export interface InstallOptions {
  from: string;
  to: string;
  only?: string[];
  force?: boolean;
}

export interface InstallResult {
  installed: string[];
  skipped: string[];
  to: string;
}

/**
 * Copy each skill directory from `from` into `to/<name>/`. An existing
 * destination is skipped unless `force`; with `force`, files WE ship are
 * overwritten and anything else the user put there is left alone (cpSync
 * merges, it does not replace the directory).
 */
export function installSkills(opts: InstallOptions): InstallResult {
  const from = resolve(opts.from);
  const to = resolve(opts.to);
  const rel = relative(from, to);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`Refusing to install into "${to}": it is inside the source directory "${from}".`);
  }

  const available = listSkills(from);
  const byName = new Map(available.map((s) => [s.name, s]));
  let selected = available.map((s) => s.name);
  if (opts.only && opts.only.length > 0) {
    const unknown = opts.only.filter((n) => !byName.has(n));
    if (unknown.length > 0) {
      throw new Error(`Unknown skill${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Available: ${selected.join(", ")}`);
    }
    selected = selected.filter((n) => opts.only!.includes(n));
  }

  mkdirSync(to, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const name of selected) {
    const dest = join(to, name);
    if (existsSync(dest) && !opts.force) {
      skipped.push(name);
      continue;
    }
    cpSync(join(from, name), dest, { recursive: true, force: true, errorOnExist: false });
    installed.push(name);
  }
  return { installed, skipped, to };
}

export interface SkillsArgs {
  cmd: "list" | "install" | "help";
  to?: string;
  global: boolean;
  force: boolean;
  only?: string[];
}

/** Parse everything after the `skills` word. Unknown subcommand → help. */
export function parseSkillsArgs(argv: string[]): SkillsArgs {
  const out: SkillsArgs = { cmd: "help", global: false, force: false, only: undefined, to: undefined };
  const [first, ...rest] = argv;
  if (first === "list" || first === "install") out.cmd = first;
  else return out;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--global" || a === "-g") out.global = true;
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--to") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) throw new Error("--to requires a directory path");
      out.to = v;
    } else if (a.startsWith("--to=")) out.to = a.slice("--to=".length);
    else if (a === "--only") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) throw new Error("--only requires a comma-separated list of skill names");
      out.only = splitList(v);
    } else if (a.startsWith("--only=")) out.only = splitList(a.slice("--only=".length));
    else if (a === "--help" || a === "-h") out.cmd = "help";
    else throw new Error(`Unknown option for "skills ${first}": ${a}`);
  }
  return out;
}

function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Destination precedence: explicit --to (with ~ expansion, relative to cwd)
 * → --global (~/.claude/skills, where Claude Code loads personal skills) →
 * project ./.claude/skills.
 */
export function resolveSkillsTarget(
  opts: { to?: string; global?: boolean },
  cwd: string = process.cwd(),
  home: string = homedir(),
): string {
  if (opts.to) {
    const expanded = opts.to === "~" ? home : opts.to.startsWith(`~${sep}`) || opts.to.startsWith("~/") ? join(home, opts.to.slice(2)) : opts.to;
    return isAbsolute(expanded) ? expanded : join(cwd, expanded);
  }
  return opts.global ? join(home, ".claude", "skills") : join(cwd, ".claude", "skills");
}

export function skillsUsage(): string {
  return [
    "Usage:",
    "  blockrun-mcp skills list                      Show the skills shipped in this package",
    "  blockrun-mcp skills install [options]         Copy them into a skills directory",
    "",
    "Options (install):",
    "  --to <dir>       Destination directory (default: ./.claude/skills)",
    "  -g, --global     Install to ~/.claude/skills instead of the project",
    "  --only a,b       Install only these skills",
    "  -f, --force      Overwrite skills that are already there",
    "",
    "Examples:",
    "  npx -y @blockrun/mcp@latest skills install",
    "  npx -y @blockrun/mcp@latest skills install --global",
    "  npx -y @blockrun/mcp@latest skills install --to ~/.codex/skills",
    "  npx -y @blockrun/mcp@latest skills install --only blockrun,blockrun-setup,blockrun-debug",
    "",
    "Claude Code users can instead run:  /plugin marketplace add BlockRunAI/blockrun-mcp",
    "",
  ].join("\n");
}

/**
 * Entry point for `blockrun-mcp skills …`. Returns the process exit code;
 * writes to stdout/stderr directly. Never starts the MCP server.
 */
export function runSkillsCli(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
}): number {
  let args: SkillsArgs;
  try {
    args = parseSkillsArgs(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${skillsUsage()}`);
    return 2;
  }

  if (args.cmd === "help") {
    io.out(skillsUsage());
    return argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" ? 0 : 2;
  }

  const skills = listSkills(SKILLS_SOURCE_DIR);
  if (skills.length === 0) {
    io.err(`No skills found at ${SKILLS_SOURCE_DIR} — the package may be corrupted. Reinstall with: npx -y @blockrun/mcp@latest\n`);
    return 1;
  }

  if (args.cmd === "list") {
    const width = Math.max(...skills.map((s) => s.name.length));
    io.out(`${skills.length} skills in ${SKILLS_SOURCE_DIR}\n\n`);
    for (const s of skills) {
      // One line each; the full text is in the SKILL.md frontmatter.
      const d = s.description.length > 110 ? `${s.description.slice(0, 109).trimEnd()}…` : s.description;
      io.out(`  ${s.name.padEnd(width)}  ${d}\n`);
    }
    io.out(`\nInstall with: blockrun-mcp skills install [--global | --to <dir>]\n`);
    return 0;
  }

  const to = resolveSkillsTarget(args);
  try {
    const r = installSkills({ from: SKILLS_SOURCE_DIR, to, only: args.only, force: args.force });
    for (const n of r.installed) io.out(`  installed  ${join(to, n)}\n`);
    for (const n of r.skipped) io.out(`  skipped    ${join(to, n)}  (exists — use --force to overwrite)\n`);
    io.out(`\n${r.installed.length} installed, ${r.skipped.length} skipped → ${to}\n`);
    if (r.installed.length > 0) io.out(`Restart your client (or start a new session) so it picks the skills up.\n`);
    return 0;
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
}
