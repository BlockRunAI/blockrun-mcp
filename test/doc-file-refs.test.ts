// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// CONTRIBUTING.md pointed contributors at `src/tools/surf.ts` four times —
// as the starting template to copy, as the reference example of the
// path-based pattern, and as the example of the sync payment call. That file
// was deleted with the tool in 0.49.0. Step 1 of "Adding a new MCP tool" was
// literally uncopyable, and nothing failed, because prose naming a path is
// invisible to a compiler.
//
// So: every repo path our docs name has to exist. This is the cheap half of
// the problem. The expensive half — whether the file still demonstrates what
// the sentence claims — is not checkable here; see the raw-call assertion at
// the bottom for the one case that costs money to get wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every tracked markdown file, not a hand-kept list of three. The list was
// README, CONTRIBUTING and one doc — so the other four docs/*.md, all sixteen
// skills, AGENTS.md and every `[…](docs/x.md)` link in the README were never
// scanned, and a renamed docs/spend-confirmation.md would have 404'd on
// GitHub and npm with this test green. Excluded: CHANGELOG.md names deleted
// files on purpose (that is what a changelog is for), and docs/plans is
// gitignored scratch.
const DOCS = execFileSync("git", ["ls-files", "-z", "--", "*.md", "**/*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && f !== "CHANGELOG.md" && !f.startsWith("docs/plans/"));

// A backticked path into the repo's own source, skills or scripts. Deliberately
// narrow: it must start at a directory we own, so prose like `blockrun_chat`
// or a URL never matches. `ui/` is NOT here: it is the gitignored MCP Apps
// build output, and `ui/open-link` in docs/mcp-apps.md is an MCP Apps host
// method, not a path.
const REPO_PATH = /`((?:src|test|skills|scripts|apps|assets|docs|\.github)\/[A-Za-z0-9_./-]+)`/g;

// A markdown link target that is not a URL or an in-page anchor, resolved
// relative to the file that carries it — which is how GitHub and npm resolve
// it. An optional `"title"` after the target is tolerated.
const MD_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const NOT_A_FILE = /^(?:[a-z][a-z0-9+.-]*:|#)/i; // http:, https:, mailto:, ui:, data:, …, or an anchor

test("the doc set is the whole tree, not a hand-kept list", () => {
  // If this shrinks to a handful, `git ls-files` failed or the exclusions
  // grew too wide — either way the sweep below would be silently vacuous.
  assert.ok(DOCS.length >= 20, `only ${DOCS.length} markdown files found: ${DOCS.join(", ")}`);
  for (const must of ["README.md", "CONTRIBUTING.md", "AGENTS.md", "docs/mcp-apps.md", "skills/blockrun/SKILL.md"]) {
    assert.ok(DOCS.includes(must), `${must} must be in the scanned set`);
  }
  assert.ok(!DOCS.includes("CHANGELOG.md"));
});

test("every repo file path named in the docs exists", () => {
  const missing: string[] = [];
  for (const doc of DOCS) {
    const text = readFileSync(path.join(ROOT, doc), "utf-8");
    for (const [, rel] of text.matchAll(REPO_PATH)) {
      // A trailing colon-line-number ("wallet.ts:24") points INTO a file.
      const bare = rel.replace(/:\d+$/, "");
      if (!existsSync(path.join(ROOT, bare))) missing.push(`${doc} → ${rel}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "the docs name files that are not in the repo — a contributor told to copy one cannot",
  );
});

test("every markdown link to a file in the repo resolves from the file that carries it", () => {
  const dead: string[] = [];
  let checked = 0;
  for (const doc of DOCS) {
    const text = readFileSync(path.join(ROOT, doc), "utf-8");
    for (const [, target] of text.matchAll(MD_LINK)) {
      if (NOT_A_FILE.test(target)) continue;
      const clean = target.replace(/[#?].*$/, "");
      if (!clean) continue; // `(#anchor)` on the same page
      checked++;
      const resolved = clean.startsWith("/") ? path.join(ROOT, clean) : path.join(ROOT, path.dirname(doc), clean);
      if (!existsSync(resolved)) dead.push(`${doc} → ${target}`);
    }
  }
  assert.ok(checked >= 10, `only ${checked} relative links found — the link regex stopped matching`);
  assert.deepEqual(dead, [], "a relative link that does not resolve 404s on GitHub and on npm");
});

test("CONTRIBUTING sends new path-based tools through raw-call, not straight at the SDK", () => {
  // Not pedantry about naming. There are three payment rails and the SDK knows
  // two: on the account rail requestWithPaymentRaw degrades to a Bearer fetch
  // and discards the x-blockrun-cost-usd header, so a tool written that way
  // cannot say what it cost and books the wrong ledger figure. raw-call.ts is
  // the single entry point that exists so no tool picks a rail for itself, and
  // every rail-parity bug this repo has shipped came from one doing so.
  const text = readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf-8");
  assert.match(text, /rawGet\(client, endpoint/, "the GET helper should be the documented one");
  assert.match(text, /rawPost\(client, endpoint/, "the POST helper should be the documented one");
  assert.match(
    text,
    /Do \*\*not\*\* reach for `client\.getWithPaymentRaw`/,
    "the SDK-direct path must stay called out as the wrong one",
  );
});

test("every path-based tool actually goes through raw-call", () => {
  // The claim above is only worth documenting if it is true of the code.
  const PATH_BASED = ["search", "exa", "markets", "rpc", "defi", "phone", "modal"];
  const offenders: string[] = [];
  for (const name of PATH_BASED) {
    const file = path.join(ROOT, "src", "tools", `${name}.ts`);
    assert.ok(existsSync(file), `src/tools/${name}.ts should exist — raw-call.ts names it`);
    const source = readFileSync(file, "utf-8");
    if (!/from "\.\.\/utils\/raw-call\.js"/.test(source)) offenders.push(`${name}.ts`);
    if (/client\.(get|request)WithPaymentRaw\(/.test(source)) offenders.push(`${name}.ts (calls the SDK directly)`);
  }
  assert.deepEqual(offenders, [], "a path-based tool that skips raw-call.ts breaks the account rail");
});
