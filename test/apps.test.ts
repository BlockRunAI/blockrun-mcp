// Run with: npm test  (tsx --test)
//
// MCP Apps wiring. Three things must hold together or the app silently never
// renders — the host shows plain text and nobody notices:
//
//   1. The tool carries _meta.ui.resourceUri (and ONLY the two app tools do —
//      a stray _meta.ui on a text tool makes hosts fetch a resource that
//      does not exist).
//   2. The ui:// resource is registered for exactly the profiles that expose
//      the tool, with the mcp-app MIME type.
//   3. The bundle it serves is a real single-file HTML: inline script, no
//      external script/stylesheet URLs (the host sandbox blocks them).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initializeMcpServer } from "../src/mcp-handler.js";
import { APP_RESOURCE_MIME_TYPE, APP_URIS, appToolMeta, readAppHtml } from "../src/apps.js";

type ToolCfg = { _meta?: { ui?: { resourceUri?: string } } };
type ResCfg = { mimeType?: string; _meta?: Record<string, unknown> };
type Reader = () => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>;

function collect(argv: string[]) {
  const tools = new Map<string, ToolCfg>();
  const resources = new Map<string, { cfg: ResCfg; read: Reader }>();
  const fake = {
    registerTool(name: string, cfg: ToolCfg) { tools.set(name, cfg); },
    registerResource(_name: string, uri: string, cfg: ResCfg, read: Reader) { resources.set(uri, { cfg, read }); },
  } as unknown as McpServer;
  initializeMcpServer(fake, { argv, env: {} });
  return { tools, resources };
}

test("exactly two tools carry _meta.ui, pointing at the two app URIs", () => {
  const { tools } = collect([]);
  const withUi = [...tools.entries()].filter(([, c]) => c._meta?.ui?.resourceUri).map(([n, c]) => [n, c._meta!.ui!.resourceUri]);
  assert.deepEqual(
    withUi.sort(),
    [["blockrun_polymarket_read", APP_URIS.orderPreview], ["blockrun_wallet", APP_URIS.wallet]].sort(),
  );
  assert.deepEqual(appToolMeta("wallet"), { ui: { resourceUri: "ui://blockrun/wallet.html" } });
});

test("app resources are registered only for profiles that expose their tool", () => {
  const cases: Array<[string[], string[]]> = [
    [[], [APP_URIS.orderPreview, APP_URIS.wallet]],
    [["--profile", "trading"], [APP_URIS.orderPreview, APP_URIS.wallet]],
    [["--profile", "chat"], [APP_URIS.wallet]],
    [["--profile", "media"], [APP_URIS.wallet]],
    [["--profile", "research"], [APP_URIS.wallet]],
  ];
  for (const [argv, expected] of cases) {
    const { resources } = collect(argv);
    const uis = [...resources.keys()].filter((u) => u.startsWith("ui://")).sort();
    assert.deepEqual(uis, [...expected].sort(), `argv=${argv.join(" ") || "(full)"}`);
    for (const u of uis) assert.equal(resources.get(u)!.cfg.mimeType, APP_RESOURCE_MIME_TYPE, u);
  }
});

test("each app resource serves a self-contained single-file HTML bundle", async () => {
  const { resources } = collect([]);
  for (const uri of [APP_URIS.orderPreview, APP_URIS.wallet]) {
    const r = await resources.get(uri)!.read();
    assert.equal(r.contents.length, 1);
    const c = r.contents[0];
    assert.equal(c.uri, uri);
    assert.equal(c.mimeType, APP_RESOURCE_MIME_TYPE);
    const html = c.text ?? "";
    // assert.ok, not assert.match: a failure must not dump 350 KB of bundle
    // into the test log.
    assert.ok(/^<!doctype html>/i.test(html), `${uri}: not an HTML document`);
    assert.ok(/<script type="module"[^>]*>/.test(html), `${uri}: script is not inlined`);
    assert.ok(!/<script[^>]+\ssrc=/.test(html), `${uri}: external script — the host CSP will block it`);
    assert.ok(!/<link[^>]+rel="stylesheet"[^>]+href=/.test(html), `${uri}: external stylesheet`);
    assert.ok(html.length > 5_000, `${uri}: bundle suspiciously small (${html.length} bytes)`);
  }
});

test("the order card knows the tools it calls and the wallet panel its actions", () => {
  // The bundle is minified, but tool names and action strings survive verbatim.
  const order = readAppHtml("orderPreview");
  assert.ok(order.includes("blockrun_polymarket_read"), "order card: read tool");
  assert.ok(/blockrun_polymarket["`']/.test(order), "order card: write tool");
  assert.ok(/confirm:!0|confirm:true/.test(order), "order card: confirm:true");
  const wallet = readAppHtml("wallet");
  assert.ok(wallet.includes("blockrun_wallet"), "wallet: tool");
  for (const action of ["status", "chain", "deposit"]) assert.ok(new RegExp(`["\`']${action}["\`']`).test(wallet), `wallet: action ${action}`);
});
