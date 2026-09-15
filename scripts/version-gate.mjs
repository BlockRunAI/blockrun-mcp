#!/usr/bin/env node
// Refuse to publish a version that is not ABOVE what npm already serves.
//
//   node scripts/version-gate.mjs <package.json version> <npm latest | none>
//
// publish.yml's npm step was gated on `pkg != npm` — inequality, not order.
// `npm publish` does not compare semver: without `--tag` it points `latest` at
// whatever it just published, so a release PR that wrote 0.5.1 for 0.51.0
// would have shipped and downgraded every `npx -y @blockrun/mcp@latest` user
// to a build with 0.5-era price tables. That number is not hypothetical:
// VERSION sat nine minors behind package.json, and the release tooling that
// computes the next version reads VERSION.
//
// Plain Node on purpose — this runs before `npm ci`, so there is no `semver`
// package to lean on. Exported for test/version-gate.test.ts; the CLI is what
// the workflow calls.
//
// "none" (nothing on npm yet — npm's E404) passes; "unknown" (npm could not be
// read at all) is refused; equal passes (that is the re-run of an
// already-published version, which the workflow skips on its own); prereleases
// and anything that is not X.Y.Z are refused, because the workflow has no
// dist-tag path for them and a malformed string must not compare as 0.0.0.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1 / 0 / 1, numerically per component. Throws on anything that is not X.Y.Z. */
export function compareSemver(a, b) {
  const pa = a.match(SEMVER);
  const pb = b.match(SEMVER);
  if (!pa) throw new Error(`"${a}" is not a bare X.Y.Z version`);
  if (!pb) throw new Error(`"${b}" is not a bare X.Y.Z version`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** { ok: true } or { ok: false, reason } — never throws; a bad input is a refusal. */
export function gate({ pkg, npm }) {
  if (!SEMVER.test(pkg)) return { ok: false, reason: `package.json version "${pkg}" is not a bare X.Y.Z version — refusing to publish it` };
  if (npm === "none") return { ok: true, reason: `nothing on npm yet — ${pkg} will be the first publish` };
  // The workflow spells a registry/network failure "unknown" (only npm's own
  // E404 is "none"). A gate that could not look has not passed: refuse, and
  // say re-run — the one input where "none" and "unknown" differ is a
  // package.json below latest during a registry blip, which is exactly the
  // downgrade this script exists to stop.
  if (npm === "unknown") return { ok: false, reason: `npm latest could not be read (registry or network failure) — cannot order ${pkg} against it, refusing; re-run the job` };
  if (!SEMVER.test(npm)) return { ok: false, reason: `npm latest "${npm}" is not a bare X.Y.Z version — cannot order ${pkg} against it, refusing` };
  const order = compareSemver(pkg, npm);
  if (order < 0) {
    return {
      ok: false,
      reason:
        `package.json ${pkg} is LOWER than npm latest ${npm}. npm publish would accept it and it would become \`latest\`, ` +
        `downgrading every \`npx -y @blockrun/mcp@latest\` user. Bump package.json (and VERSION) above ${npm}.`,
    };
  }
  if (order === 0) return { ok: true, reason: `package.json ${pkg} == npm latest — already published, the workflow skips npm` };
  return { ok: true, reason: `package.json ${pkg} > npm latest ${npm}` };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [pkg, npm] = process.argv.slice(2);
  if (!pkg || !npm) {
    console.error("usage: node scripts/version-gate.mjs <package.json version> <npm latest | none>");
    process.exit(2);
  }
  const r = gate({ pkg, npm });
  console[r.ok ? "log" : "error"](`version-gate: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
