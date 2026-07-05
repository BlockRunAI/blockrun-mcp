#!/usr/bin/env node
// Generate server.json (the MCP registry manifest) from server.template.json,
// stamping the version from package.json so the two can never drift apart.
//
// The old failure mode: server.json was hand-edited and gitignored, so its
// version silently fell behind package.json/npm (0.23.1 vs 0.26.0) and the
// registry publish was forgotten entirely (frozen at 0.2.2 since January).
// Single source of truth = package.json "version". Run in CI before publish.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (!version || version.includes("template")) {
  console.error(`Refusing to stamp: package.json version is "${version}"`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, "server.template.json"), "utf8"));
manifest.version = version;
for (const p of manifest.packages ?? []) {
  // Pin the registry entry to the exact npm version we publish.
  if (p.identifier === pkg.name) p.version = version;
}

writeFileSync(join(root, "server.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Stamped server.json → ${manifest.name} v${version} (npm ${pkg.name}@${version})`);
