# MCP Apps — the order card and the wallet panel

BlockRun MCP ships two **MCP Apps**: interactive cards that a capable host renders inline
in the conversation instead of a wall of text. They use the official
[MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview)
(`io.modelcontextprotocol/ui`). On a host without the extension nothing changes — the tool
returns the same text it always has.

| App | Attached to | What it does |
|---|---|---|
| **Order card** `ui://blockrun/order-preview.html` | `blockrun_polymarket_read` | Live Polymarket order preview: question, outcome, side, best quote, est. shares, notional, per-order cap meter, session ledger. Edit the amount and re-quote. **Place order** signs and submits through the host. |
| **Wallet panel** `ui://blockrun/wallet.html` | `blockrun_wallet` | Both chains' USDC balances, switch the active chain, copy an address, show a funding QR (EIP-681 / Solana Pay), open the explorer, buy USDC with a card. |

<p align="center">
  <img src="../assets/mcp-apps/order-card.png" width="340" alt="Order card: BUY Market FOK, you spend $5.00, best ask 57.0¢, ≈8.77 shares, per-order cap meter, Re-quote and Place buy buttons">
  &nbsp;&nbsp;
  <img src="../assets/mcp-apps/wallet-panel.png" width="340" alt="Wallet panel: Base active with $34.96 USDC, Solana $0.05 low balance, Copy / QR / Use Solana, Refresh, Basescan, Buy USDC with card">
</p>

*Rendered by the MCPJam inspector against the published server, 2026-08-30.*

## Where they render

| Host | Renders MCP Apps | Notes |
|---|---|---|
| Claude Desktop | ✅ | Local stdio server, no extra setup. |
| claude.ai | ✅ | Via a remote connector; a local stdio server needs a tunnel (see [testing](#testing-locally)). |
| VS Code (Copilot) | ✅ | |
| Cursor | ✅ | |
| ChatGPT | ✅ | Remote connectors only. |
| MCPJam inspector | ✅ | Simulates Claude / ChatGPT / Cursor side by side — the screenshots above. |
| Claude Code, Codex CLI, Gemini CLI, Windsurf | ❌ | Terminal / no extension — the text result is shown, unchanged. |

Sources: the MCP [client support matrix](https://modelcontextprotocol.io/extensions/client-matrix).

## How placing an order works — and what still guards it

The card is a UI over the same two tools the model already uses. Nothing is signed by the card
itself.

1. `blockrun_polymarket_read action:"preview"` returns the quote; the host renders the card
   with it.
2. **Re-quote** calls `blockrun_polymarket_read` again with the new amount — read-only.
3. **Place buy / sell** is two clicks (arm, then *Confirm — sign & submit $X*). The card then
   asks the **host** to call `blockrun_polymarket action:"buy"|"sell" … confirm:true`.
4. The host applies its own tool-consent prompt (it is a real `tools/call` from an app), then
   the server applies every existing rail: `POLYMARKET_MAX_BET_USD` per order (default $25),
   `POLYMARKET_MAX_SESSION_USD`, minimum size, FOK fillability, the closed-market guard.
5. The card shows the order id, status and any transaction hashes, and pushes the result
   into the model's context so the conversation knows what happened.

A declined host prompt or a server-side cap comes back as an error *inside the card*; nothing
was placed.

## Wallet panel actions

| Button | Tool call |
|---|---|
| Use Base / Use Solana | `blockrun_wallet action:"chain" chain:"…"` then `action:"status"` |
| Refresh | `blockrun_wallet action:"status"` |
| Buy USDC with card | `blockrun_wallet action:"deposit"` → opens the one-time Coinbase Onramp link via the host (`ui/open-link`) |
| Basescan / Solscan | `ui/open-link` to the explorer |
| Copy | clipboard (`permissions.clipboardWrite` is requested on the resource) |
| QR | generated in the panel; same EIP-681 / Solana Pay encoding as `action:"qr"` |

## Profiles

Apps are registered only when their tool is in the active profile: the wallet panel in every
profile, the order card in `full` and `trading`. A trimmed profile never advertises a
`ui://` resource for a tool it excludes.

## Testing locally

- **MCPJam** (stdio, no tunnel): `npx @mcpjam/inspector@latest`, add a STDIO server with
  command `npx -y @blockrun/mcp@latest --profile trading`, open **Playground**, pick a tool,
  fill the parameters, **Run**. The Chat pane renders the app in three simulated hosts.
- **Claude Desktop**: install as usual (`claude_desktop_config.json`) and ask for your wallet
  status or a Polymarket preview.
- **claude.ai**: a local stdio server is not reachable; expose an HTTP transport and tunnel it
  (`npx cloudflared tunnel --url …`), then add it as a custom connector.

## Building

The apps live in `apps/` (vanilla TypeScript, no framework) and are bundled by
`vite-plugin-singlefile` into `ui/*.html` — one self-contained file each, because the host
renders them in a deny-by-default CSP sandbox where nothing may load from a URL.
`npm run build:apps` runs as part of `npm run build` and before `npm test`; the bundles are
gitignored and shipped in the npm tarball. `test/apps.test.ts` pins the `_meta.ui` wiring,
per-profile registration, and that each bundle really is self-contained.

## Limitations

- Bundles are ~350 KB each: the `@modelcontextprotocol/ext-apps` `App` class pulls in the
  SDK protocol layer. Fine over stdio; a hand-rolled postMessage client would be ~10× smaller.
- The card re-quotes on demand, not on a timer. A quote is as fresh as the last click.
- Sell previews need `size` (shares); the card edits that field, not USD.
- The two-column layouts collapse under ~440 px; MCPJam's side-by-side preview is narrower
  than any real host, so it shows the stacked variant.
