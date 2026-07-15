#!/usr/bin/env node
/**
 * BlockRun MCP Server
 *
 * Live data for AI agents — search, research, markets, crypto.
 *
 * Install:
 *   claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeMcpServer } from "./mcp-handler.js";
import { warnOnLeakedKeys } from "./utils/key-leak-scanner.js";
import { installBlockrunMcpUserAgent } from "./utils/user-agent.js";
import { PROFILES } from "./profiles.js";

// Read version from package.json so it can never drift from the published version.
const { version: VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

function printHelp(): void {
  process.stdout.write(
    [
      "BlockRun MCP Server",
      "",
      "Usage:",
      "  blockrun-mcp [options]",
      "",
      "Options:",
      "  -h, --help       Show this help message",
      "  -v, --version    Print the package version",
      `      --profile <name>  Tool profile to expose: ${Object.keys(PROFILES).join(" | ")} (default: full)`,
      "",
      "When no metadata flag is provided, the server starts on stdio for MCP clients.",
      "",
    ].join("\n"),
  );
}

function handleCliMetadataFlags(argv: string[]): void {
  const args = argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
}

handleCliMetadataFlags(process.argv);
installBlockrunMcpUserAgent(VERSION);

async function checkForUpdate() {
  try {
    const resp = await fetch("https://registry.npmjs.org/@blockrun/mcp/latest", {
      signal: AbortSignal.timeout(3000),
    });
    const data = await resp.json() as { version?: string };
    if (data.version && data.version !== VERSION) {
      console.error(`[BlockRun] Update available: v${VERSION} → v${data.version}`);
      console.error(`[BlockRun] Run: claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest`);
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

  const { profile, tools } = initializeMcpServer(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const profileNote = profile === "full"
    ? `${tools.length} tools`
    : `profile "${profile}" — ${tools.length} tools: ${tools.join(", ")}`;
  console.error(`BlockRun MCP Server started (v${VERSION}) — stdio transport — ${profileNote}`);

  // Check for updates in background (non-blocking)
  checkForUpdate();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
