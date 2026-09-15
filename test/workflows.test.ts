// Run with: npm test  (tsx --test)
//
// The two release-side workflows cannot run locally, but their shell CAN, and
// their gates can be read. Both have reported success while doing nothing:
//
//   brand-sync.yml  — main is protected and Actions may not open PRs here, so
//                     the push failed, the PR fallback failed, `|| echo` ate
//                     it, and the run went green with a stale README (#123 sat
//                     26 days; #141 was the manual PR that finally landed it).
//   publish.yml     — the tag/release step was gated on `pkg != npm`, which is
//                     false once npm has published, so a job that went red
//                     AFTER npm could never repair the missing tag on re-run:
//                     the re-run skipped the step and went green.
//
// The brand-sync test executes the workflow's real `run:` block against shimmed
// `git`/`gh` binaries that behave the way this org does (push to main
// rejected, PR creation forbidden). The publish tests parse the YAML and
// inspect the gates — the only honest check available for an `if:` expression
// GitHub evaluates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

type Step = { name?: string; id?: string; if?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

function load(file: string): Workflow {
  return parse(readFileSync(path.join(ROOT, ".github", "workflows", file), "utf8")) as Workflow;
}

function step(wf: Workflow, job: string, name: string): Step {
  const s = wf.jobs[job]?.steps.find((x) => x.name === name);
  assert.ok(s, `${job} has no step named "${name}"`);
  return s!;
}

// ---- brand-sync.yml: the fallback must not report success it did not earn ----

/**
 * A scratch git repo with one committed file, a drift in the working tree, and
 * `git`/`gh` shims first on PATH. The shim delegates every git subcommand to
 * the real binary except `push`, which mirrors this org: a push to main is
 * rejected (protected branch), any other ref is accepted. `gh` always fails
 * the way it does for GITHUB_TOKEN here ("not permitted to create or approve
 * pull requests").
 */
function landingFixture(opts: { ghSucceeds: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "brand-sync-run-"));
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "calls.log");
  mkdirSync(repo);
  mkdirSync(bin);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh
echo "git $*" >> "${log}"
if [ "$1" = "push" ]; then
  case "$*" in
    *HEAD:main*) echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2; exit 1 ;;
    *) exit 0 ;;
  esac
fi
exec "${realGit}" "$@"
`,
  );
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
echo "gh $*" >> "${log}"
${opts.ghSucceeds ? 'echo "https://github.com/BlockRunAI/blockrun-mcp/pull/999"; exit 0' : 'echo "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)" >&2; exit 1'}
`,
  );
  chmodSync(path.join(bin, "git"), 0o755);
  chmodSync(path.join(bin, "gh"), 0o755);
  const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "<!-- br:mcp.tools -->19<!-- /br:mcp.tools --> tools\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // The drift the sync script would have written.
  writeFileSync(path.join(repo, "README.md"), "<!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools\n");
  return {
    repo,
    log,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REF_NAME: "main", GH_TOKEN: "ghs_fake" },
    calls: () => readFileSync(log, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runLandStep(fixture: ReturnType<typeof landingFixture>) {
  const script = step(load("brand-sync.yml"), "sync", "Land the rewrite").run;
  assert.ok(script, "the landing step must be a run: block");
  return spawnSync("bash", ["-e", "-c", script!], { cwd: fixture.repo, env: fixture.env, encoding: "utf8" });
}

test("brand-sync: push rejected AND PR creation forbidden is a red run that names the branch", () => {
  const f = landingFixture({ ghSucceeds: false });
  try {
    const r = runLandStep(f);
    assert.notEqual(r.status, 0, `the step exited ${r.status} having landed nothing:\n${r.stdout}${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.match(out, /brand-sync/, "the pushed branch must be named so a human can open the PR");
    assert.match(out, /manual PR|needs a human|open the PR/i);
    // The branch was still pushed — the rewrite is not lost, only unlanded.
    assert.match(f.calls(), /git push -f origin HEAD:brand-sync/);
  } finally {
    f.cleanup();
  }
});

test("brand-sync: the fallback branch name is fixed, not dated — one branch, force-pushed, not one per Monday", () => {
  const f = landingFixture({ ghSucceeds: false });
  try {
    runLandStep(f);
    const pushes = f.calls().split("\n").filter((l) => l.startsWith("git push"));
    assert.ok(pushes.some((l) => /HEAD:brand-sync$/.test(l)), `expected a push to refs/heads/brand-sync, got:\n${pushes.join("\n")}`);
    assert.ok(!pushes.some((l) => /brand-sync\/\d{8}/.test(l)), "a dated branch per run is how origin grew brand-sync/20260831, /20260905, /20260907");
  } finally {
    f.cleanup();
  }
});

test("brand-sync: when the PR does open, the run is green", () => {
  const f = landingFixture({ ghSucceeds: true });
  try {
    const r = runLandStep(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(f.calls(), /gh pr create --head brand-sync/);
  } finally {
    f.cleanup();
  }
});

test("brand-sync: nothing to land is a quiet green, no push at all", () => {
  const f = landingFixture({ ghSucceeds: false });
  try {
    // Undo the drift: the tree matches HEAD.
    writeFileSync(path.join(f.repo, "README.md"), "<!-- br:mcp.tools -->19<!-- /br:mcp.tools --> tools\n");
    const r = runLandStep(f);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already in sync/);
    assert.doesNotMatch(f.calls(), /git push/);
  } finally {
    f.cleanup();
  }
});

// ---- publish.yml: three targets, three INDEPENDENT guards ----

test("publish: a version below npm latest is refused before anything installs or publishes", () => {
  const wf = load("publish.yml");
  const steps = wf.jobs.publish.steps;
  const gate = steps.findIndex((s) => /version-gate\.mjs/.test(s.run ?? ""));
  assert.ok(gate > -1, "publish.yml must call scripts/version-gate.mjs — `pkg != npm` is inequality, not order");
  const install = steps.findIndex((s) => /npm ci/.test(s.run ?? ""));
  const publish = steps.findIndex((s) => /npm publish/.test(s.run ?? ""));
  assert.ok(gate < install && gate < publish, "the gate must run before npm ci and before npm publish");
  const call = steps[gate]!.run!;
  assert.match(call, /steps\.v\.outputs\.pkg/);
  assert.match(call, /steps\.v\.outputs\.npm/);
});

test("publish: the tag/release step is gated on the tag being ABSENT, not on npm still being behind", () => {
  const wf = load("publish.yml");
  const resolve = step(wf, "publish", "Resolve versions");
  assert.match(resolve.run ?? "", /git ls-remote --exit-code --tags origin "refs\/tags\/v\$\{PKG\}"/, "the tag must be resolved against origin up front");
  assert.match(resolve.run ?? "", /tag_missing=\$TAG_MISSING/);

  const release = step(wf, "publish", "Tag + GitHub release");
  const cond = (release.if ?? "").replace(/\s+/g, " ");
  assert.match(cond, /steps\.v\.outputs\.tag_missing == 'true'/, "the release step's own guard is the tag");
  assert.doesNotMatch(
    cond,
    /^\s*steps\.v\.outputs\.pkg != steps\.v\.outputs\.npm\s*$/,
    "gated on `pkg != npm` alone, a re-run after npm published skips the step and the tag is never repaired",
  );
  // It must still be able to run past a registry failure (the failure that
  // left 0.32.3 untagged was AFTER npm), and must not run when npm failed.
  assert.match(cond, /!cancelled\(\)/, "without !cancelled() a registry-step failure skips this step");
  assert.match(cond, /steps\.npm\.outcome == 'success' \|\| steps\.v\.outputs\.pkg == steps\.v\.outputs\.npm/, "tag only when npm carries the version — published now, or already there");
  assert.match(cond, /steps\.build\.outcome == 'success'/, "never tag a build that did not pass");
  assert.equal(step(wf, "publish", "Publish to npm").id, "npm", "the npm step needs an id for its outcome to be referenced");
  assert.equal(step(wf, "publish", "Build, typecheck, test").id, "build");
});

test("publish: an npm registry failure is 'unknown' and refused, only an E404 is 'none'", () => {
  const wf = load("publish.yml");
  const resolve = step(wf, "publish", "Resolve versions").run ?? "";
  assert.doesNotMatch(resolve, /npm view @blockrun\/mcp version 2>\/dev\/null \|\| echo "none"/, "every failure spelled as 'none' lets a downgrade through on a registry blip");
  assert.match(resolve, /E404/, "the not-yet-published case is recognised by npm's own error code");
  assert.match(resolve, /NPM=unknown|NPM="unknown"/, "anything else is unknown, which the gate refuses");
});
