// Run with: npm test  (tsx --test)
//
// The SDK's zod->JSON-Schema conversion stamps a draft-07 `$schema` header on
// every tool's inputSchema. Clients ignore it, but it ships in the tool block
// the model carries on every turn — 300 tokens across the full profile.
// stripJsonSchemaDialect() removes it by wrapping the tools/list handler, so
// the wrapper is identity-matched against the SDK's request schema: an SDK
// upgrade that reshapes that path would silently put the header back. This
// test is what notices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initializeMcpServer } from "../src/mcp-handler.js";

async function listTools(argv: string[]) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  initializeMcpServer(server, { argv, env: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

test("no tool advertises a $schema dialect header", async () => {
  const tools = await listTools([]);
  assert.equal(tools.length, 20);
  const offenders = tools
    .filter((t) => "$schema" in (t.inputSchema as Record<string, unknown>))
    .map((t) => t.name);
  assert.deepEqual(offenders, []);
});

test("stripping the dialect leaves the rest of the schema intact", async () => {
  const tools = await listTools([]);
  const markets = tools.find((t) => t.name === "blockrun_markets");
  assert.ok(markets, "blockrun_markets should be in the full profile");

  const schema = markets.inputSchema as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["path"]);
  assert.ok(schema.properties?.path, "path property survives");
  assert.ok(schema.properties?.agent_id, "agent_id property survives");

  // Annotations and MCP App metadata ride alongside inputSchema — the wrapper
  // must not disturb them.
  assert.ok(markets.annotations, "annotations survive");
  assert.equal(tools.filter((t) => t._meta?.ui).length, 2);
});
