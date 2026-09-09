// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// applyClobProxyOnce() sets axios.defaults.httpsAgent PROCESS-WIDE. That is
// not a style choice: @polymarket/clob-client-v2 reaches for the hoisted axios
// itself, so there is no instance to scope the agent to without forking it.
//
// The safety argument is entirely about WHO ELSE shares that axios. Today the
// answer is "only Polymarket": every axios importer in src/ is under
// utils/polymarket/, @blockrun/llm and the rest of the tools use fetch (which
// ignores axios defaults), and the relayer carries its own axios 0.27 copy
// that relayer.ts hands the agent to explicitly.
//
// That argument lives in a comment, which cannot fail. This can. The day a
// non-Polymarket module imports axios, its traffic starts going through an
// operator's POLYMARKET_CLOB_PROXY the moment a trade is placed -- a silent
// egress change nobody asked for -- and this test goes red first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const POLYMARKET_DIR = path.join("utils", "polymarket");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("only src/utils/polymarket may import axios", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf-8");
    if (!/(^|\n)\s*import[^;]*from\s+["']axios["']/.test(source) &&
        !/require\(\s*["']axios["']\s*\)/.test(source)) continue;
    const rel = path.relative(SRC, file);
    if (!rel.startsWith(POLYMARKET_DIR)) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    "applyClobProxyOnce() mutates axios.defaults process-wide; a non-Polymarket " +
      "axios caller would silently route through POLYMARKET_CLOB_PROXY. Use fetch, " +
      "or give this module its own axios instance with an explicit agent.",
  );
});

test("the proxy is only installed when the operator asks for one", async () => {
  const saved = process.env.POLYMARKET_CLOB_PROXY;
  delete process.env.POLYMARKET_CLOB_PROXY;
  const { getClobProxy } = await import("../src/utils/polymarket/constants.js");

  assert.equal(
    getClobProxy(),
    undefined,
    "the Finland default is a HOST (POLYMARKET_CLOB_HOST), not a proxy — if a " +
      "default ever lands here, axios.defaults gets mutated for every user",
  );

  if (saved === undefined) delete process.env.POLYMARKET_CLOB_PROXY;
  else process.env.POLYMARKET_CLOB_PROXY = saved;
});
