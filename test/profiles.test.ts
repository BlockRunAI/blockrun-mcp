// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_TOOLS, PROFILES, knownProfileNames, resolveProfileName, resolveTools } from "../src/profiles.js";

const EXPECTED_COUNTS: Record<string, number> = {
  full: 20,
  media: 7,
  trading: 9,
  research: 6,
  chat: 3,
};

test("ALL_TOOLS has the full 20-tool set", () => {
  assert.equal(ALL_TOOLS.length, 20);
  assert.equal(new Set(ALL_TOOLS).size, 20, "no duplicates");
});

test("resolveProfileName precedence: --profile flag > env > default", () => {
  assert.equal(resolveProfileName(["--profile", "media"], {}), "media");
  assert.equal(resolveProfileName(["--profile=trading"], {}), "trading");
  assert.equal(resolveProfileName([], { BLOCKRUN_MCP_PROFILE: "research" }), "research");
  // CLI flag wins over env
  assert.equal(resolveProfileName(["--profile", "chat"], { BLOCKRUN_MCP_PROFILE: "media" }), "chat");
  // default
  assert.equal(resolveProfileName([], {}), "full");
});

test("resolveProfileName is case-insensitive", () => {
  assert.equal(resolveProfileName(["--profile", "MEDIA"], {}), "media");
  assert.equal(resolveProfileName([], { BLOCKRUN_MCP_PROFILE: "Trading" }), "trading");
});

test("resolveTools returns the right tool count per profile", () => {
  for (const [name, count] of Object.entries(EXPECTED_COUNTS)) {
    const { profile, tools } = resolveTools(["--profile", name], {});
    assert.equal(profile, name, `profile name for ${name}`);
    assert.equal(tools.size, count, `tool count for ${name}`);
  }
});

test("every profile includes wallet (needed to pay)", () => {
  for (const name of Object.keys(PROFILES)) {
    const { tools } = resolveTools(["--profile", name], {});
    assert.ok(tools.has("wallet"), `${name} must include wallet`);
  }
});

test("unknown profile name falls back to full (20 tools)", () => {
  const { profile, tools } = resolveTools(["--profile", "nonsense"], {});
  assert.equal(profile, "full");
  assert.equal(tools.size, 20);
});

test("no args → full", () => {
  const { profile, tools } = resolveTools([], {});
  assert.equal(profile, "full");
  assert.equal(tools.size, 20);
});

test("Object.prototype key names fall back to full instead of crashing", () => {
  // PROFILES is a plain object, so "constructor"/"__proto__" resolve to
  // inherited members (truthy, non-iterable) and used to throw at startup.
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const { profile, tools } = resolveTools(["--profile", name], {});
    assert.equal(profile, "full", `${name} should fall back to full`);
    assert.equal(tools.size, 20, `${name} should expose all 20 tools`);
  }
});

test("trimmed profiles only contain real tools", () => {
  const all = new Set(ALL_TOOLS);
  for (const name of Object.keys(PROFILES)) {
    const { tools } = resolveTools(["--profile", name], {});
    for (const t of tools) assert.ok(all.has(t), `${name}: ${t} is a real tool`);
  }
});

test("resolveProfileName trims whitespace (a JSON client's `\"trading \"` is a typo, not a new profile)", () => {
  assert.equal(resolveProfileName(["--profile", " trading "], {}), "trading");
  assert.equal(resolveProfileName(["--profile=Media\t"], {}), "media");
  assert.equal(resolveProfileName([], { BLOCKRUN_MCP_PROFILE: "  Research" }), "research");
  assert.equal(resolveTools(["--profile", " chat "], {}).profile, "chat");
});

test("a blank profile means 'not specified', not 'unknown'", () => {
  // `--profile ""` / `--profile "  "` / an empty env var would otherwise be
  // reported as an unknown profile called "".
  for (const argv of [["--profile", ""], ["--profile", "   "], ["--profile="]]) {
    const r = resolveTools(argv, {});
    assert.equal(r.requested, "full", `${JSON.stringify(argv)}: requested`);
    assert.equal(r.profile, "full");
  }
  assert.equal(resolveTools([], { BLOCKRUN_MCP_PROFILE: "" }).requested, "full");
  assert.equal(resolveTools([], { BLOCKRUN_MCP_PROFILE: "  " }).requested, "full");
});

test("resolveTools reports the REQUESTED name so the caller can log an unknown-name fallback", () => {
  // The fallback itself was already pinned above; what was missing is any way
  // for index.ts to know it happened. `--profile tradng` starting with 20 tools
  // and printing "20 tools" hid the typo from the user who wanted 9.
  const typo = resolveTools(["--profile", "tradng"], {});
  assert.equal(typo.requested, "tradng");
  assert.equal(typo.profile, "full");
  assert.notEqual(typo.requested, typo.profile, "differs → caller logs");

  const ok = resolveTools(["--profile", "trading"], {});
  assert.equal(ok.requested, "trading");
  assert.equal(ok.profile, "trading");

  const none = resolveTools([], {});
  assert.equal(none.requested, none.profile, "no flag → nothing to warn about");

  // Env path too, normalised the same way.
  const envTypo = resolveTools([], { BLOCKRUN_MCP_PROFILE: "Reserch " });
  assert.equal(envTypo.requested, "reserch");
  assert.equal(envTypo.profile, "full");
});

test("knownProfileNames lists every profile, full first", () => {
  assert.deepEqual(knownProfileNames(), Object.keys(PROFILES));
  assert.equal(knownProfileNames()[0], "full");
  assert.deepEqual([...knownProfileNames()].sort(), Object.keys(EXPECTED_COUNTS).sort());
});
