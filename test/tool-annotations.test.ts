import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initializeMcpServer } from "../src/mcp-handler.js";

type Annotation = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

test("trading profile exposes nine annotated tools and no media surface", () => {
  const annotations = new Map<string, Annotation>();
  const fakeServer = {
    registerTool(name: string, options: { annotations?: Annotation }) {
      annotations.set(name, options.annotations ?? {});
    },
    registerResource() {},
  } as unknown as McpServer;

  const result = initializeMcpServer(fakeServer, { argv: ["--profile", "trading"], env: {} });
  assert.equal(result.profile, "trading");
  assert.equal(annotations.size, 9);
  assert.equal(annotations.has("blockrun_image"), false);
  assert.equal(annotations.has("blockrun_video"), false);

  assert.deepEqual(annotations.get("blockrun_polymarket_read"), {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  });
  assert.deepEqual(annotations.get("blockrun_polymarket"), {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  });
  assert.deepEqual(annotations.get("blockrun_markets"), {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  });
  assert.equal(annotations.get("blockrun_dex")?.readOnlyHint, true);
  assert.equal(annotations.get("blockrun_dex")?.openWorldHint, true);
});
