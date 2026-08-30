# Contributing to BlockRun MCP

PRs welcome. This server is small (~4,400 lines of tool code + 16 skills); reviews are usually fast.

## Setup

```bash
git clone https://github.com/blockrunai/blockrun-mcp
cd blockrun-mcp
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsup → dist/
npm run dev           # tsx watch mode
```

Smoke-test the built server via the MCP stdio handshake:

```bash
(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 2) | node dist/index.js 2>/dev/null
```

Should return <!-- br:mcp.tools -->20<!-- /br:mcp.tools --> tools including `blockrun_surf` and any new one you add.

To test locally with Claude Code, point it at your dev build:

```bash
claude mcp add blockrun-dev -- node /path/to/blockrun-mcp/dist/index.js
```

## Design rule — Tool vs Skill

Two ways to expose a new API. Pick the right one:

**Add an MCP tool** when:
- The API needs typed parameter validation (enums, ranges, structured shapes the LLM should respect)
- The API has complex client logic (async polling, multi-step payment, stateful retry)
- The API is core to BlockRun value-prop (chat, image, wallet)

**Add a skill** when:
- The API is path-based passthrough (mirrors `blockrun_markets` / `blockrun_surf`)
- The endpoint catalog is large (≥10 endpoints) and benefits from a Quick Decision Table
- LLM routing needs trigger keywords beyond what tool descriptions can carry

Reference examples in the repo:
- Path-based tool: `src/tools/surf.ts` — 57 lines, exposes 84 endpoints behind it
- Long-tail skill: `skills/surf/SKILL.md` — full endpoint catalog + 7 worked examples
- Async payment-on-completion: `src/tools/video.ts` — submit + poll + settle-on-complete
- Typed structured tool: `src/tools/chat.ts` — multi-mode routing + budget gating + multi-turn

## Adding a new MCP tool

1. Copy `src/tools/surf.ts` as a starting template
2. Use `getClient()` from `src/utils/wallet.ts` — it auto-routes Base vs Solana
3. Keep tool description ≤ 30 lines. Long endpoint catalogs belong in `skills/<name>/SKILL.md`, not in the tool description
4. Register in `src/mcp-handler.ts` (one import + one `register*Tool()` call)
5. Add a row to the `## Tools` table in `README.md`
6. `npm run typecheck && npm run build && npm test` + run the stdio smoke test above

## Adding a new skill

1. Create `skills/<name>/SKILL.md` with frontmatter:

   ```markdown
   ---
   name: <name>
   description: One-paragraph "use this when..." for the LLM
   triggers:
     - "keyword 1"
     - "keyword 2"
   ---
   ```

2. Mirror the structure of `skills/surf/SKILL.md`: Quick Decision Table → Worked Examples → Full Reference (organized by category)
3. Triggers should cover the long tail. Users won't always say "Surf" or "BlockRun" — they'll say "wallet labels", "on-chain SQL", "mindshare". Cover the synonyms

## Chain-aware code

Never hardcode chain ID, RPC URL, or address format. Use:
- `getChain()` from `src/utils/wallet.ts:24` for the current chain (`"base"` or `"solana"`)
- `getClient()` returns the right `LLMClient` or `SolanaLLMClient` based on chain detection

## x402 payment patterns

Two flavors. Pick the right one:

- **Sync, single-call**: use `client.getWithPaymentRaw(endpoint, params)` (GET) or `client.requestWithPaymentRaw(endpoint, body)` (POST). One signature, one settlement. See `src/tools/surf.ts`, `src/tools/exa.ts`.
- **Async, payment-on-completion**: copy the `src/tools/video.ts` pattern — submit → 402 → sign → poll the same URL with the same `PAYMENT-SIGNATURE` header → settle on the first `completed` response. Upstream failures or client-side timeout = no charge. See `src/tools/music.ts` for the simpler synchronous-blocking variant.

## CHANGELOG

Add an entry to `CHANGELOG.md`. Format:

```
## X.Y.Z

- **`tool_name` — one-line headline.** 1-2 sentences on why it matters.
  - Sub-bullet for distinct sub-changes
  - Thanks @contributor (if external)
- Second independent change in the same format.
```

Bump `package.json` `version` to match (semver: patch for fixes, minor for new tools/skills, major for breaking).

## Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Tool description ≤ 30 lines (long catalogs go in the skill)
- [ ] New tool added to `README.md` `## Tools` table
- [ ] New skill placed in `skills/<name>/` directory
- [ ] CHANGELOG entry follows the template
- [ ] `package.json` version bumped

One feature/fix per PR. Include what the tool does and its cost in the PR description.

Run `npm test` (node's built-in test runner via `tsx --test`, specs in `test/*.test.ts`) and the MCP stdio smoke-test above before opening a PR.

## Issues

[github.com/blockrunai/blockrun-mcp/issues](https://github.com/blockrunai/blockrun-mcp/issues) · [blockrun.ai](https://blockrun.ai) · [@BlockRunAI](https://x.com/BlockRunAI)
