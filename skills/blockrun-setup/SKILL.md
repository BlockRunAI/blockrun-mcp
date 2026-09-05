---
name: blockrun-setup
description: "Use when asked to install, add, configure, or set up the BlockRun MCP server (@blockrun/mcp) in Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI or another MCP client — including first-run wallet creation, funding with USDC, choosing a tool profile, and proving the install works. Also use when a fresh install 'doesn't show up' or a user asks how to pay for calls."
triggers:
  - "install blockrun"
  - "add blockrun mcp"
  - "set up blockrun"
  - "blockrun setup"
  - "claude mcp add blockrun"
  - "@blockrun/mcp"
  - "fund my blockrun wallet"
  - "how do I pay for blockrun"
  - "blockrun profile"
---

# Installing BlockRun MCP

One command per client, then one tool call to see the wallet. Do it in this order; the
PATH step is the one people skip and then spend an hour on.

## 1. Check Node first

```bash
node -v      # must print v20.19 or newer
which npx
```

If `node` is from **nvm, Homebrew, fnm, volta or asdf**, assume the client's launcher
will NOT find it. GUI-launched apps and Claude Code's MCP spawner do not source your
shell profile. The fix is to pass your shell's PATH through at install time — not to
pin `nvm alias default`, not to edit `.zshrc`, not to symlink node into `/usr/local/bin`.

## 2. Install — pick the client

**Claude Code** (recommended; `-s user` = every project):

```bash
claude mcp add blockrun -s user -e PATH="$PATH" -- npx -y @blockrun/mcp@latest
```

The `--` matters: it stops `-y` being parsed by `claude mcp add`. The `-e PATH="$PATH"`
is the nvm/Homebrew fix from step 1; it is harmless on a system Node, so always include it.

**Codex CLI** (`--env` is Codex's equivalent of `-e`; config lands in `~/.codex/config.toml`):

```bash
codex mcp add blockrun --env PATH="$PATH" -- npx -y @blockrun/mcp@latest
```

**Claude Desktop / Cursor / Windsurf** — JSON, in the client's MCP config file:

```json
{ "mcpServers": { "blockrun": { "command": "npx", "args": ["-y", "@blockrun/mcp@latest"] } } }
```

| Client | File |
|---|---|
| Claude Desktop | `claude_desktop_config.json` (Settings → Developer → Edit Config) |
| Cursor | `~/.cursor/mcp.json` · Windows `%APPDATA%\Cursor\mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` · Linux `~/.config/.codeium/windsurf/mcp_config.json` |

For a JSON client with nvm/Homebrew Node, put the absolute `npx` path (`which npx`) in
`command` — there is no `-e PATH` equivalent there.

**Optional flags** (append after `@latest`): `--profile trading|research|media|chat`
exposes a smaller tool set so the client loads fewer schemas. Omit for all 20 tools.

**Optional env** (`-e KEY=value` on Claude Code, `"env": {}` in JSON):
`BLOCKRUN_CONFIRM_SPEND=on` asks before each paid call on clients that support MCP
elicitation; `BLOCKRUN_CONFIRM_THRESHOLD=0.05` limits that to calls above $0.05;
`BLOCKRUN_BUDGET_LIMIT=5` hard-caps the process at $5.

## 3. Restart, then prove it

Restart the client — for Claude Code that means quit and relaunch `claude`; a running
session does not pick up a new server. Then:

```bash
claude mcp list        # expect:  blockrun: npx -y @blockrun/mcp@latest - ✓ Connected
claude mcp get blockrun  # confirms the scope and that PATH / any -e vars were captured
```

Inside the session, call **`blockrun_wallet`** with no arguments. It prints the wallet
address, chain, and balance. That call is free and needs no funds — if it returns, the
install works. Do not "test" with a paid tool.

## 4. The wallet and how paying works

- The server **creates a wallet on first run**: an EVM key in `~/.blockrun/.session`
  (`0600`). On macOS/Linux it is also mirrored into the OS keychain, but the file stays
  authoritative unless the user opts into `BLOCKRUN_KEYCHAIN=strict`. Tell the user to
  **back that file up** — it is the only copy of the key; BlockRun cannot recover it.
- Payment is **per call**, and there are two ways to pay. Free tools (`blockrun_wallet`,
  `blockrun_models`, `blockrun_dex`, crypto `blockrun_price`, `blockrun_chat mode:"free"`)
  need neither.

**Wallet (the default — no account, no signup).** USDC over x402. New installs default to
**Solana**; an install that already has a Base wallet stays on Base.

- `blockrun_wallet action:"setup"` shows the address and a QR. Send USDC (SPL) on Solana
  — Coinbase (pick "Solana"), Phantom, Solflare or Backpack. $5 covers hundreds of calls.
- To use Base instead: `blockrun_wallet action:"chain" chain:"base"` then `action:"setup"`,
  and send USDC on the Base network. No restart either way.
- Only `blockrun_defi`, `blockrun_modal` and native `claude-*` chat are Base-only; they say
  so rather than charging.

**API key (for teams who cannot hand a wallet to an agent).** Ask the user whether they want
this before setting it up — it is a real account, not a local file.

1. Sign in at <https://user.blockrun.ai> (Google).
2. Mint a key at <https://user.blockrun.ai/dashboard/keys> — `brk_live_…`, shown once.
3. Add credit at <https://user.blockrun.ai/dashboard/credits> (card or wire).
4. Set `BLOCKRUN_API_KEY` in the client's MCP server config, e.g.
   `claude mcp add blockrun -s user -e BLOCKRUN_API_KEY=brk_live_… -- npx -y @blockrun/mcp@latest`
5. Confirm with `blockrun_wallet action:"status"` — it must say *"Paying with: BlockRun
   account API key"*.

In this mode no wallet is created or read, billing is post-hoc at exact usage (no per-call
minimum, no transaction fee), and the ledger is <https://user.blockrun.ai/dashboard/activity>.
Polymarket trading, wallet balances/top-ups and `blockrun_realface action:"list"` need a
keypair and are unavailable; everything else works.

## 5. Optional: install the agent skills

The package ships 16 skills (which tool to use, worked examples, this one). Claude Code
users: `/plugin marketplace add BlockRunAI/blockrun-mcp`. Everyone else:

```bash
npx -y @blockrun/mcp@latest skills install              # → ./.claude/skills
npx -y @blockrun/mcp@latest skills install --global     # → ~/.claude/skills
npx -y @blockrun/mcp@latest skills install --to ~/.codex/skills
```

## Common mistakes

| Mistake | Why it bites |
|---|---|
| Omitting `-e PATH="$PATH"` on nvm/Homebrew | `spawn npx ENOENT` / "Failed to connect" — the #1 support issue |
| Omitting `--` before `npx` | `-y` is eaten by `claude mcp add`; npx then prompts and hangs |
| Testing with a paid tool | You cannot tell "unfunded" from "broken". Use `blockrun_wallet`. |
| Sending USDC on Ethereum mainnet | Wrong network; the Base address is the same string but the funds are elsewhere. Say "Base". |
| Funding inside a sandboxed client (Claude Desktop / Cowork / Web bash) | The wallet lives in the sandbox and dies with it. Test: if `~/.blockrun/.session` is gone in the next session, you are sandboxed — install on the user's real machine. |

If the install is done and something still fails, switch to the `blockrun-debug` skill.
