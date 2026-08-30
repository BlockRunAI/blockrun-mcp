---
name: blockrun-debug
description: "Use when the BlockRun MCP server (@blockrun/mcp) is installed but misbehaving — 'Failed to connect', spawn npx ENOENT, blockrun missing from claude mcp list, HTTP 402 / Insufficient balance, fetch failed, video or music timeouts, spend-confirmation dialogs not appearing, or a Polymarket buy/redeem failing after funding. Symptom → cause → fix, plus what never to do."
triggers:
  - "blockrun failed to connect"
  - "blockrun not working"
  - "spawn npx ENOENT"
  - "402 payment required"
  - "insufficient balance"
  - "blockrun 402"
  - "fetch failed blockrun"
  - "video generation timed out"
  - "polymarket buy failed"
  - "insufficient allowance"
  - "redeem reverts"
  - "debug blockrun"
---

# Debugging BlockRun MCP

Find the row, run the fix, stop. Most "broken" reports are one of the first three rows.

## Rules before touching anything

1. **A 402 / "Insufficient balance" is a funding state, not a bug.** Call
   `blockrun_wallet` first. Never retry the failing tool in a loop — it will 402
   identically every time and the failed attempts cost nothing, but they burn turns.
2. **Never delete or regenerate `~/.blockrun/.session`.** It is the only copy of the
   key that holds the user's USDC and their Polymarket deposit wallet. There is no recovery.
3. **Never advise withdrawing from Polymarket to "start over".** Every post-funding
   trade failure seen so far was a missing approval; a withdraw does not fix it and
   costs a round trip.
4. Reproduce with the **free** call `blockrun_wallet` before anything paid.

## Run these first (read-only, 10 seconds)

```bash
node -v && which npx                     # runtime present, ≥ 20.19?
claude mcp get blockrun                  # registered command, env, AND scope (-s user / project / local)
npx -y @blockrun/mcp@latest --version    # does the package itself run? (prints e.g. 0.43.0)
```

Use the scope `claude mcp get` reports in every `remove`/`add` below — the examples say
`-s user` because that is the documented install, but a project-scoped install
re-added at user scope leaves a duplicate. Then, in the session: `blockrun_wallet`
(free) → `blockrun_models` (free) → the tool that failed, **once**.

## Symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| `claude mcp list` → `blockrun … ✗ Failed to connect`, or logs show `spawn npx ENOENT` | The client's launcher can't find `node`/`npx` — nvm, Homebrew, fnm, volta. Interactive shell has them; the spawner does not. | `claude mcp remove blockrun -s user` then `claude mcp add blockrun -s user -e PATH="$PATH" -- npx -y @blockrun/mcp@latest`. Quit and relaunch the client. Codex: `codex mcp add blockrun --env PATH="$PATH" -- …`. JSON clients (Claude Desktop / Cursor / Windsurf): set `"command"` to the output of `which npx`; file paths are in the `blockrun-setup` skill. |
| `blockrun` absent from `claude mcp list` | Wrong scope, or Node < 20.19, or a corrupt npx cache | `node -v` (≥ 20.19). `claude mcp get blockrun`. `rm -rf ~/.npm/_npx`. Re-run the install line. |
| Connects, but every paid tool → `HTTP 402` / `Insufficient balance` | Wallet is empty (or on the wrong chain for this tool) | `blockrun_wallet` → read balance + chain. `blockrun_wallet action:"setup"` → address + QR. Fund with USDC **on Base** (or switch to Solana). Then retry **once**. |
| 402 although balance shows funds | Chain mismatch: a Base-only tool (`music`, `speech`, `modal`, `defi`, paid `realface`, stock `price`, native `claude-*` chat) while active chain is Solana. Every other tool pays on either chain. | The error names it. `blockrun_wallet action:"chain" chain:"base"`. |
| `fetch failed` / balance-check timeout | Base RPC blip; the tool rotates through 3 public RPCs | Wait 30 s, retry once. Persistent → a local proxy/firewall is blocking outbound RPC. |
| `Video`/`Music generation timed out` | Upstream queue. **Not charged** — payment settles on completion only. | Retry, or pick a faster model. Do not retry-loop; jobs take 60–180 s. |
| Model id 404s | Delisted upstream | `blockrun_models` for the live list. |
| Startup prints `🚨 WALLET PRIVATE KEY DETECTED IN CONFIG FILE` | The key was pasted into `~/.claude.json` (old hosted-auth flow) | Treat the key as compromised: move funds to a new wallet, remove it from the config. |
| No spend-confirmation dialog with `BLOCKRUN_CONFIRM_SPEND=on` | Client doesn't support MCP elicitation (Windsurf, Codex, Gemini CLI) — the server proceeds without asking, by design | Use `BLOCKRUN_BUDGET_LIMIT` / `blockrun_wallet action:"delegate"` as the guard, or use Claude Code / Cursor / VS Code where the dialog renders. |
| Dialog appears, user clicks OK, tool says "declined" | Only an explicit **Decline** stops a charge; Cancel/ESC proceeds. If it says declined, Decline was pressed. | Re-run the call; approve it. |
| `Update available: vX → vY` on stderr | Informational | Switch to the `blockrun-upgrade` skill. |

## Polymarket (`blockrun_polymarket`)

| Symptom | Cause | Fix |
|---|---|---|
| Funded the deposit wallet, `buy` fails with `insufficient allowance` / neg-risk market rejects | The one-time gasless approval batch hasn't run, or predates an upgrade that added the NegRisk-adapter and collateral-adapter grants | `blockrun_polymarket action:"setup" confirm:true` **once** (idempotent, gasless, signs approvals — tell the user before running). Wait for it to report ready. Retry the buy. **Do not withdraw.** Still failing → check the signer row below: the funded wallet and the signing wallet must be the same address. |
| `redeem` reverts or redeems 0 | Same missing approvals (collateral adapter) | Same fix: `setup confirm:true`, then `redeem` again. |
| Order rejected by region | Order placement is geoblocked by IP. The MCP routes CLOB traffic via BlockRun's Finland egress by default. | Check `POLYMARKET_CLOB_HOST` was not overridden. `setup` prints the region status. |
| `setup` shows a different signer address than expected | Signer precedence: `BLOCKRUN_WALLET_KEY` env → agent `wallet.json` → `~/.blockrun/.session` | Unset the override, or fund the address `setup` actually prints. |

The full walkthrough is `docs/polymarket-trading-setup.md` in the package repo.

## Why "retried 5 times" happens and how to stop it

A 402 is free — nothing settles — so a retry loop costs turns, not money, and no budget
cap will interrupt it. The stop is behavioural: the README's "For agents" block and the
`blockrun` skill both say *call `blockrun_wallet` first, never retry a 402 blindly*.
If a client keeps looping, install the skills so that rule is in context
(`npx -y @blockrun/mcp@latest skills install`).

## Red flags — stop

- You are about to retry a 402 a second time without checking the wallet.
- You are about to `rm` anything under `~/.blockrun/`.
- You are about to suggest a Polymarket `withdraw` to fix a failed order.
- You are about to test with `blockrun_video` or `blockrun_phone` — $0.30+/s and $5 numbers.
