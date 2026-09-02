// Run with: npm test  (tsx --test)
//
// Pins the context-window cost this repo publishes.
//
// Installing an MCP server spends the user's context on every turn, whether or
// not the tools are called. We put that number on the README the way a package
// manager puts install size on a download — which only means anything if it
// cannot quietly go stale.
//
// So this measures the live server and fails HERE, in the repo that can fix it,
// rather than letting the badge make a claim that stopped being true three
// description edits ago.
//
// The assertion is on the PUBLISHED form ("12.9K"), not the raw token count.
// Pinning 12,900 exactly would fail CI on every wording tweak; pinning the
// rounded figure fails exactly when the published claim becomes wrong.
//
// When it fails: run `npm run measure:schema`, confirm the change is intended,
// and update the README badge and the profile table to what it prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initializeMcpServer } from "../src/mcp-handler.js";
// @ts-expect-error -- plain .mjs, no types; measure()/asK() are the contract.
import { measure, asK } from "../scripts/measure-tool-schema.mjs";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const PREFIX = "mcp__blockrun__";

/** Same projection the CLI harness measures, over an in-process handshake. */
async function measureProfile(profile: string) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  initializeMcpServer(server, { argv: ["--profile", profile], env: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return measure(tools, PREFIX) as {
    tools: number; total: number; descriptions: number; perTool: number;
  };
}

test("the README badge states the measured context cost", async () => {
  const full = await measureProfile("full");
  const shown = asK(full.total) as string;
  assert.ok(
    README.includes(`badge/🧮_${shown}_Context_Tokens`),
    `badge URL should show ${shown} (measured ${full.total} tokens)`,
  );
  assert.ok(README.includes(`alt="${shown} context tokens"`), "badge alt text");
});

test("the profile table states each profile's measured cost", async () => {
  // Every row is a public claim; a trimmed profile that quietly grew would
  // otherwise keep advertising a saving it no longer delivers.
  for (const profile of ["full", "media", "trading", "research", "chat"]) {
    const { total, tools } = await measureProfile(profile);
    // Tolerant of row decoration (`full` carries a *(default)* marker), strict
    // on both numbers — the decoration is prose, the numbers are the claim.
    const row = new RegExp(
      `\\| \`${profile}\`[^|]*\\| ${tools} \\| ${total.toLocaleString()} \\|`,
    );
    assert.match(README, row,
      `README row for ${profile} should read ${tools} tools / ${total.toLocaleString()} tokens`);
  }
});

test("the advertised profile saving is the one measured", async () => {
  const full = await measureProfile("full");
  const trading = await measureProfile("trading");
  const cut = Math.round((1 - trading.total / full.total) * 100);
  assert.ok(README.includes(`${cut}% less context`), `saving should read ${cut}%`);
});

test("descriptions are the majority of the cost, which is why the table ranks them", async () => {
  // Not decoration: it is the finding the whole measurement exists to surface,
  // and if schemas ever overtake descriptions the README's advice is wrong.
  const full = await measureProfile("full");
  assert.ok(
    full.descriptions > full.total / 2,
    `descriptions ${full.descriptions} should exceed half of ${full.total}`,
  );
});
