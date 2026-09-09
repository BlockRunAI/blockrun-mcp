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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "CONTRIBUTING.md", "docs/mcp-schema-overhead.md"];

// A backticked path into the repo's own source, skills or scripts. Deliberately
// narrow: it must start at a directory we own, so prose like `blockrun_chat`
// or a URL never matches.
const REPO_PATH = /`((?:src|test|skills|scripts|apps|assets)\/[A-Za-z0-9_./-]+)`/g;

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
