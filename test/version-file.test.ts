// Run with: npm test  (tsx --test)
//
// `VERSION` is read by nothing in this repo — publish.yml, stamp-server-json
// and the CLI all take the version from package.json — but external release
// tooling (/ship) computes the NEXT version from it. 0.40.1 found it eight
// minors behind and fixed it by hand; nine minors later it was 0.41.1 against
// a package.json at 0.50.0, because nothing pinned the two together. Off a
// stale VERSION the tooling proposes a number that is either already on npm
// (the publish 403s, red release job) or LOWER than npm `latest` (it publishes
// and becomes `latest` — see the semver guard in publish.yml).
//
// So: the two files must agree, and both move in the release ritual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const versionFile = readFileSync(new URL("../VERSION", import.meta.url), "utf8");

test("VERSION carries exactly the package.json version", () => {
  assert.equal(
    versionFile.trim(),
    pkg.version,
    "VERSION and package.json disagree — release tooling computes the next version from VERSION, so bump both",
  );
});

test("VERSION is a bare semver line, nothing the tooling would have to parse around", () => {
  assert.match(versionFile, /^\d+\.\d+\.\d+\n?$/, "VERSION must be one X.Y.Z line");
});
