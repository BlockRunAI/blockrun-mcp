// Run with: npm test  (tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_TOOLS, PROFILES, resolveProfileName, resolveTools } from "../src/profiles.js";

const EXPECTED_COUNTS: Record<string, number> = {
  full: 19,
  media: 7,
  trading: 8,
  research: 6,
  chat: 3,
};

test("ALL_TOOLS has the full 19-tool set", () => {
  assert.equal(ALL_TOOLS.length, 19);
  assert.equal(new Set(ALL_TOOLS).size, 19, "no duplicates");
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

test("unknown profile name falls back to full (19 tools)", () => {
  const { profile, tools } = resolveTools(["--profile", "nonsense"], {});
  assert.equal(profile, "full");
  assert.equal(tools.size, 19);
});

test("no args → full", () => {
  const { profile, tools } = resolveTools([], {});
  assert.equal(profile, "full");
  assert.equal(tools.size, 19);
});

test("Object.prototype key names fall back to full instead of crashing", () => {
  // PROFILES is a plain object, so "constructor"/"__proto__" resolve to
  // inherited members (truthy, non-iterable) and used to throw at startup.
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const { profile, tools } = resolveTools(["--profile", name], {});
    assert.equal(profile, "full", `${name} should fall back to full`);
    assert.equal(tools.size, 19, `${name} should expose all 19 tools`);
  }
});

test("trimmed profiles only contain real tools", () => {
  const all = new Set(ALL_TOOLS);
  for (const name of Object.keys(PROFILES)) {
    const { tools } = resolveTools(["--profile", name], {});
    for (const t of tools) assert.ok(all.has(t), `${name}: ${t} is a real tool`);
  }
});
