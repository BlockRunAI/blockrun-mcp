import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initializeMcpServer } from "../src/mcp-handler.js";
import { ALL_TOOLS } from "../src/profiles.js";

type Annotation = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

function collect(argv: string[]): { annotations: Map<string, Annotation>; profile: string } {
  const annotations = new Map<string, Annotation>();
  const fakeServer = {
    registerTool(name: string, options: { annotations?: Annotation }) {
      annotations.set(name, options.annotations ?? {});
    },
    registerResource() {},
  } as unknown as McpServer;
  const result = initializeMcpServer(fakeServer, { argv, env: {} });
  return { annotations, profile: result.profile };
}

test("trading profile exposes nine annotated tools and no media surface", () => {
  const { annotations, profile } = collect(["--profile", "trading"]);
  assert.equal(profile, "trading");
  assert.equal(annotations.size, 9);
  assert.equal(annotations.has("blockrun_image"), false);
  assert.equal(annotations.has("blockrun_video"), false);

  assert.deepEqual(annotations.get("blockrun_polymarket_read"), {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  });
  assert.deepEqual(annotations.get("blockrun_polymarket"), {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  });
});

test("every shipped tool carries an annotation", () => {
  // Without this, a new tool silently defaults to destructiveHint:true under
  // the MCP spec and clients start prompting for it.
  const { annotations } = collect([]);
  assert.equal(annotations.size, ALL_TOOLS.length);
  for (const [name, a] of annotations) {
    assert.equal(typeof a.readOnlyHint, "boolean", `${name} missing readOnlyHint`);
    assert.equal(typeof a.openWorldHint, "boolean", `${name} missing openWorldHint`);
    assert.equal(typeof a.destructiveHint, "boolean", `${name} missing destructiveHint`);
  }
});

test("costing USDC does not make a data query destructive", () => {
  // These all settle real USDC per call and all only READ. The hints describe
  // effect, not price — spend control is the budget ledger's job. Marking them
  // destructive makes annotation-honoring clients prompt on every lookup.
  const { annotations } = collect([]);
  for (const name of [
    "blockrun_markets", "blockrun_search", "blockrun_exa",
    "blockrun_surf", "blockrun_defi", "blockrun_price",
  ]) {
    assert.deepEqual(annotations.get(name), {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    }, `${name} is a paid read, not a destructive write`);
  }
});

test("only tools with real external side effects are destructive", () => {
  const { annotations } = collect([]);
  const destructive = [...annotations]
    .filter(([, a]) => a.destructiveHint)
    .map(([name]) => name)
    .sort();

  // polymarket moves funds; phone places real calls; modal executes arbitrary
  // code; rpc can broadcast a signed transaction.
  assert.deepEqual(destructive, [
    "blockrun_modal", "blockrun_phone", "blockrun_polymarket", "blockrun_rpc",
  ]);
});

test("generative tools are writes but not destructive", () => {
  const { annotations } = collect([]);
  for (const name of [
    "blockrun_image", "blockrun_video", "blockrun_music",
    "blockrun_speech", "blockrun_realface", "blockrun_chat",
  ]) {
    const a = annotations.get(name);
    assert.equal(a?.readOnlyHint, false, `${name} creates something`);
    assert.equal(a?.destructiveHint, false, `${name} destroys nothing`);
  }
});
