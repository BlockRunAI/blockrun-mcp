// Run with: npm test  (tsx --test)
//
// scripts/sync-brand-numbers.mjs is a vendored copy of blockrun's
// brand/sync-brand-numbers.mjs, and blockrun's CI (`brand-script-sync`)
// compares every consumer's copy byte-for-byte against that source. Its
// printed remediation is "copy the source over the consumer's copy". This
// repo's copy is AHEAD of the source: the markup-injection guard
// (assertRenderable + escAttr, commit efb9e2e) exists only here, and a
// resync PR that follows the remediation deletes it — which is what #84 and
// #128 did to earlier local fixes. Nothing failed then, because nothing
// exercised the behaviour.
//
// These tests run the script for real (a temp dir, no git, no network — only
// --refresh fetches) and assert what it DOES with a hostile value. A resync
// that drops the guard fails `npm test`, which is a required check on main,
// so the guard cannot be quietly reverted; the header of the script says
// which direction the resync has to go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sync-brand-numbers.mjs");

function fixture(numbers: unknown, readme: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "brand-sync-script-"));
  // A string is written verbatim: JSON.stringify would turn the Infinity the
  // non-finite case needs back into null before the script ever saw it.
  writeFileSync(path.join(dir, "brand-numbers.json"), typeof numbers === "string" ? numbers : JSON.stringify(numbers, null, 2));
  writeFileSync(path.join(dir, "README.md"), readme);
  const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { dir, run, readme: () => readFileSync(path.join(dir, "README.md"), "utf8"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BADGE_README = 'Hero: <!-- br:mcp.tools@badge -->old<!-- /br:mcp.tools@badge -->\nPlain: <!-- br:mcp.tools -->18<!-- /br:mcp.tools --> tools\n';

test("a value carrying a quote or an angle bracket is refused, and nothing is written", () => {
  // What a compromised mirror would serve: closes the src="…" attribute and
  // injects a tag into every consuming README.
  const hostile = '19" onerror="alert(1)"><script>';
  const f = fixture({ mcp: { tools: hostile } }, BADGE_README);
  try {
    const r = f.run();
    assert.notEqual(r.status, 0, `the script must exit non-zero on a hostile value:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /refusing to render mcp\.tools/);
    assert.match(r.stderr, /pushed by the brand-sync bot/);
    assert.equal(f.readme(), BADGE_README, "the README must be untouched — a refusal that already wrote is not a refusal");
  } finally {
    f.cleanup();
  }
});

test("--check refuses the same value the same way, so PR CI fails too", () => {
  const f = fixture({ mcp: { tools: "<img src=x>" } }, BADGE_README);
  try {
    const r = f.run("--check");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing to render/);
  } finally {
    f.cleanup();
  }
});

test("an array or an object under a marker is refused rather than rendered as [object Object]", () => {
  const f = fixture({ mcp: { tools: [19] } }, BADGE_README);
  try {
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expected a number or a string, got an array/);
  } finally {
    f.cleanup();
  }
});

test("a plain number renders into both the badge and the prose, and the badge's attributes stay closed", () => {
  const f = fixture({ mcp: { tools: 19 } }, BADGE_README);
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const out = f.readme();
    assert.match(out, /<!-- br:mcp\.tools -->19<!-- \/br:mcp\.tools --> tools/);
    assert.match(out, /<img src="https:\/\/img\.shields\.io\/badge\/tools-19-5B9BF6\?style=flat-square&labelColor=0B0A0F" alt="19 tools">/);
  } finally {
    f.cleanup();
  }
});

test("a short plain label (a string value) is allowed, and ampersands in it are attribute-escaped", () => {
  // The artifact legitimately carries labels ("Solana & Base" style). Belt to
  // the braces: even an allowed character that is special in an attribute is
  // escaped inside src/alt, so the tag cannot be mis-parsed.
  const f = fixture({ mcp: { tools: "19+" } }, BADGE_README);
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(f.readme(), /alt="19\+ tools"/);
  } finally {
    f.cleanup();
  }
});

test("a non-finite number is refused", () => {
  // JSON cannot carry NaN, but the mirror could carry 1e999 — which parses
  // to Infinity and would render the word "Infinity" into the hero badge.
  const f = fixture('{"mcp":{"tools":1e999}}', BADGE_README);
  try {
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a finite number/);
  } finally {
    f.cleanup();
  }
});
