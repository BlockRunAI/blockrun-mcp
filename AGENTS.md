# BlockRun MCP

MCP server giving Codex real-time data — markets, research, X/Twitter, crypto. Pay per call with USDC.

## Commands

```bash
npm install              # install dependencies
npm run build            # compile with tsup
npm run dev              # watch mode (tsx)
npm start                # start MCP server
npm run typecheck        # type checking
```

## Project structure

```
src/
├── index.ts             # MCP server entry point
├── mcp-handler.ts       # MCP protocol handler
├── tools/               # MCP tool implementations
├── types.ts             # Type definitions
└── utils/               # Shared utilities
```

## Key dependencies

- `@blockrun/llm` — LLM gateway SDK (x402 payments)
- `@modelcontextprotocol/sdk` — MCP protocol SDK
- `zod` — Schema validation
- `viem` — Ethereum interaction
- `qrcode` — Wallet QR code display

## Install in Codex

```bash
codex mcp add blockrun -- npx -y @blockrun/mcp@latest
```

## Conventions

- TypeScript, ESM
- Build with tsup
- Node >= 20.19
- MIT license
- npm registry: `@blockrun/mcp`
