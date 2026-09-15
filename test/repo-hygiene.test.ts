// Run with: npm test  (tsx --test)
//
// Commit 7f8d8f1 (round 3) tracked a SYMLINK named node_modules pointing at
// ../blockrun-mcp/node_modules — itself. `.gitignore` said `node_modules/`,
// and a trailing slash matches only a directory, so `git add -A` took the
// link. A clone named blockrun-mcp then had a self-loop (ELOOP on readdir,
// `npm install` cannot create the directory); CONTRIBUTING's `git clone … &&
// cd blockrun-mcp && npm install` failed at step one, and CI never saw it
// because `npm ci` deletes the path first.
//
// Both halves are asked of git itself, not of the .gitignore text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("git tracks nothing under node_modules — not a directory, not a symlink", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "node_modules"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.deepEqual(tracked, [], "`git rm --cached node_modules` — a tracked node_modules ships in every clone");
});

test(".gitignore ignores a node_modules SYMLINK, not only a node_modules directory", () => {
  // Asked of git in a scratch repo carrying THIS .gitignore and a dangling
  // symlink named node_modules: `git status` must not list it as untracked.
  // (check-ignore on the real tree would consult the real node_modules
  // directory and pass on the directory-only pattern too.)
  const dir = mkdtempSync(path.join(os.tmpdir(), "gitignore-symlink-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    copyFileSync(path.join(ROOT, ".gitignore"), path.join(dir, ".gitignore"));
    symlinkSync("../somewhere-else/node_modules", path.join(dir, "node_modules"));
    const untracked = git("status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .filter((l) => l.startsWith("??"))
      .map((l) => l.slice(3));
    assert.ok(!untracked.includes("node_modules"), "a node_modules symlink is untracked, not ignored — the pattern must be `node_modules`, without the trailing slash");
    assert.ok(untracked.includes(".gitignore"), "sanity: the scratch repo does see untracked files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
