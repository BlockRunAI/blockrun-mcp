#!/usr/bin/env node
/**
 * BlockRun MCP Server
 *
 * Live data for AI agents — search, research, markets, crypto.
 *
 * Install:
 *   claude mcp add blockrun npx -y @blockrun/mcp@latest
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeMcpServer } from "./mcp-handler.js";
import { warnOnLeakedKeys } from "./utils/key-leak-scanner.js";

const VERSION = "0.7.1";

async function checkForUpdate() {
  try {
    const resp = await fetch("https://registry.npmjs.org/@blockrun/mcp/latest", {
      signal: AbortSignal.timeout(3000),
    });
    const data = await resp.json() as { version?: string };
    if (data.version && data.version !== VERSION) {
      console.error(`[BlockRun] Update available: v${VERSION} → v${data.version}`);
      console.error(`[BlockRun] Run: claude mcp add blockrun npx -y @blockrun/mcp@latest`);
    }
  } catch {
    // Don't block startup on network issues
  }
}

async function main() {
  // Scan config files for leaked wallet keys BEFORE starting the server.
  // If the key is in ~/.claude.json (deprecated hosted-auth flow), the user
  // needs to rotate their wallet — and they shouldn't miss this warning.
  warnOnLeakedKeys();

  const server = new McpServer({
    name: "blockrun-mcp",
    version: VERSION,
  });

  initializeMcpServer(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`BlockRun MCP Server started (v${VERSION}) — stdio transport`);

  // Check for updates in background (non-blocking)
  checkForUpdate();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
