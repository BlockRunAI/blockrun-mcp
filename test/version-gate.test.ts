// Run with: npm test  (tsx --test)
//
// publish.yml's npm guard was inequality only: `pkg != npm`. npm publish does
// not compare semver and tags whatever it publishes as `latest` unless told
// otherwise, so a release PR that typed 0.5.1 for 0.51.0 would have published
// and every fresh `npx -y @blockrun/mcp@latest` would have installed a build
// with 0.5-era estimators. VERSION drifting behind package.json (see
// version-file.test.ts) is exactly how such a number gets proposed.
//
// The gate is a plain-Node script (it runs BEFORE `npm ci`, so no semver
// package) and this pins the comparison it makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs helper, no types
import { compareSemver, gate } from "../scripts/version-gate.mjs";

test("compareSemver orders numerically, not lexically", () => {
  assert.equal(compareSemver("0.51.0", "0.5.1"), 1, "0.51.0 is newer than 0.5.1 — a string compare says otherwise");
  assert.equal(compareSemver("0.50.0", "0.50.0"), 0);
  assert.equal(compareSemver("0.9.9", "0.10.0"), -1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
});

test("a package version below npm latest is refused with the downgrade named", () => {
  const r = gate({ pkg: "0.5.1", npm: "0.50.0" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0\.5\.1 is LOWER than npm latest 0\.50\.0/);
  assert.match(r.reason, /would become `latest`/);
});

test("equal is allowed — that is the 'already published, skip npm' re-run", () => {
  assert.equal(gate({ pkg: "0.50.0", npm: "0.50.0" }).ok, true);
});

test("higher is allowed, and 'none' (nothing on npm yet) is allowed", () => {
  assert.equal(gate({ pkg: "0.51.0", npm: "0.50.0" }).ok, true);
  assert.equal(gate({ pkg: "0.1.0", npm: "none" }).ok, true);
});

test("a version that is not X.Y.Z is refused rather than compared as zero", () => {
  const r = gate({ pkg: "0.51", npm: "0.50.0" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a bare X\.Y\.Z version/);
  const t = gate({ pkg: "0.51.0-rc.1", npm: "0.50.0" });
  assert.equal(t.ok, false, "prereleases are refused: publish.yml has no dist-tag path for them");
});

test("the CLI exits non-zero on a downgrade and zero on a release", () => {
  const script = new URL("../scripts/version-gate.mjs", import.meta.url).pathname;
  assert.throws(
    () => execFileSync("node", [script, "0.5.1", "0.50.0"], { stdio: "pipe" }),
    (err: unknown) => (err as { status?: number }).status === 1,
  );
  const out = execFileSync("node", [script, "0.51.0", "0.50.0"], { encoding: "utf8" });
  assert.match(out, /0\.51\.0 > npm latest 0\.50\.0/);
});
