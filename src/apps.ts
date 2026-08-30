// src/apps.ts
//
// MCP Apps (extension io.modelcontextprotocol/ui): interactive HTML that a
// capable host — Claude Desktop, claude.ai, VS Code, Cursor — renders inline
// in place of a tool's text result. Two apps ship:
//
//   ui://blockrun/order-preview.html  attached to blockrun_polymarket_read
//     A live order card for the `preview` action: quote, est. shares,
//     notional, caps, an editable amount that re-quotes, and a Place-order
//     button that calls blockrun_polymarket with confirm:true THROUGH THE
//     HOST — so the host's own tool-consent prompt and every server-side cap
//     (POLYMARKET_MAX_BET_USD, session cap) still apply.
//
//   ui://blockrun/wallet.html         attached to blockrun_wallet
//     Both chains' balances, active-chain switch, address + QR, card top-up.
//
// Hosts without the extension ignore `_meta.ui` and get the text result
// exactly as before (the spec's mandated fallback) — Claude Code, Codex CLI
// and every other terminal client see no difference.
//
// The bundles are single-file HTML (vite-plugin-singlefile) built from apps/
// into ui/ at build time and shipped in the npm tarball. They are resolved
// from the package root the same way skills/ is, so this works from src/
// under tsx and from the tsup bundle in dist/.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** MIME type the host uses to recognise an MCP App resource. */
export const APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export const APP_URIS = {
  orderPreview: "ui://blockrun/order-preview.html",
  wallet: "ui://blockrun/wallet.html",
} as const;

export type AppName = keyof typeof APP_URIS;

const APP_FILES: Record<AppName, string> = {
  orderPreview: "order-preview.html",
  wallet: "wallet.html",
};

/** `_meta` to put on a tool so a capable host renders the app for its results. */
export function appToolMeta(app: AppName): { ui: { resourceUri: string } } {
  return { ui: { resourceUri: APP_URIS[app] } };
}

export const UI_DIR = locateUiDir(fileURLToPath(import.meta.url));

function locateUiDir(start: string): string {
  let dir = dirname(start);
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "ui"))) return join(dir, "ui");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dirname(dirname(start)), "ui");
}

/** Read a built app bundle. Throws a clear error if `npm run build:apps` never ran. */
export function readAppHtml(app: AppName): string {
  const file = join(UI_DIR, APP_FILES[app]);
  if (!existsSync(file)) {
    throw new Error(`MCP App bundle missing: ${file}. Run \`npm run build:apps\` (it is part of \`npm run build\`).`);
  }
  return readFileSync(file, "utf8");
}

/**
 * Register the UI resources for whichever apps' tools are active. Gated on
 * the tool set exactly like the wallet/models resources, so a trimmed profile
 * never advertises an app for a tool it excluded.
 */
export function registerAppResources(server: McpServer, tools: Set<string>): AppName[] {
  const wanted: Array<[AppName, string]> = [
    ["orderPreview", "polymarket_read"],
    ["wallet", "wallet"],
  ];
  const registered: AppName[] = [];
  for (const [app, tool] of wanted) {
    if (!tools.has(tool)) continue;
    const uri = APP_URIS[app];
    server.registerResource(
      `app-${APP_FILES[app].replace(/\.html$/, "")}`,
      uri,
      {
        description: app === "orderPreview"
          ? "Polymarket order-preview card (MCP App) for blockrun_polymarket_read"
          : "Wallet balance / top-up panel (MCP App) for blockrun_wallet",
        mimeType: APP_RESOURCE_MIME_TYPE,
        // Resource-level UI metadata: the app copies addresses, so ask for
        // clipboard; a card wants the host's border/background chrome.
        _meta: { ui: { prefersBorder: true, permissions: { clipboardWrite: {} } } },
      },
      async () => ({
        contents: [{
          uri,
          mimeType: APP_RESOURCE_MIME_TYPE,
          text: readAppHtml(app),
          _meta: { ui: { prefersBorder: true, permissions: { clipboardWrite: {} } } },
        }],
      }),
    );
    registered.push(app);
  }
  return registered;
}
