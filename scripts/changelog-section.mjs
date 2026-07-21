// scripts/changelog-section.mjs — print one version's CHANGELOG section.
//
// Used by publish.yml to build GitHub release notes from the entry that was
// already written, so the release and the CHANGELOG can never disagree.
//
// Usage: node scripts/changelog-section.mjs 0.32.2
// Exits 1 with nothing on stdout when the version has no section, so the
// workflow can fall back to a generic note instead of publishing an empty one.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sections are `## <version>` and run until the next `## ` heading.
 * Kept string-based rather than regex-built-from-input: a version like
 * "1.2.3" would otherwise let `.` match any character and pick up "1x2x3".
 */
export function extractSection(changelog, version) {
  const lines = changelog.split("\n");
  const isHeading = (l) => l.startsWith("## ");
  // Accept "## 0.32.2" and "## v0.32.2", plus a trailing " — headline".
  const matches = (l) => {
    const h = l.slice(3).trim();
    const v = h.startsWith("v") ? h.slice(1) : h;
    return v === version || v.startsWith(version + " ");
  };

  const start = lines.findIndex((l) => isHeading(l) && matches(l));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) { end = i; break; }
  }
  // Drop the heading itself — the release title already carries it.
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body.length ? body : null;
}

// Only run as a CLI when invoked directly, so the test can import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/changelog-section.mjs <version>");
    process.exit(1);
  }
  const section = extractSection(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
  if (!section) {
    console.error(`no CHANGELOG section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(section + "\n");
}
