---
name: blockrun-debug
description: "Use when the BlockRun MCP server (@blockrun/mcp) is installed but misbehaving — 'Failed to connect', spawn npx ENOENT, blockrun missing from claude mcp list, HTTP 402 / Insufficient balance, fetch failed, video or music timeouts, a 501 'not served' error or 'API error after payment' while the balance never moved, spend-confirmation dialogs not appearing, or a Polymarket buy/redeem failing after funding. Symptom → cause → fix, plus what never to do."
triggers:
  - "blockrun failed to connect"
  - "blockrun not working"
  - "spawn npx ENOENT"
  - "402 payment required"
  - "insufficient balance"
  - "blockrun 402"
  - "fetch failed blockrun"
  - "video generation timed out"
  - "api error after payment"
  - "equity quotes are not served"
  - "sports markets 500"
  - "501 not implemented"
  - "blockrun unavailable"
  - "server timed out"
  - "startup_timeout_sec"
  - "refusing to sign it"
  - "quoted a different price"
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
| 402 although balance shows funds | Chain mismatch: a Base-only tool (`defi`, `modal`, native `claude-*` chat) while active chain is Solana. Everything else — music, speech, RealFace, price, media — now pays on either chain. | The error names it. `blockrun_wallet action:"chain" chain:"base"`. |
| 402 from `api.blockrun.ai` | Not a wallet problem: the server is on an API key and the ACCOUNT is out of credit. | Top up at <https://user.blockrun.ai/dashboard/credits>. Do not look for a wallet. |
| 401 from `api.blockrun.ai` | `BLOCKRUN_API_KEY` rejected. | Check the key at <https://user.blockrun.ai/dashboard/keys>. |
| "needs wallet mode" on Polymarket / wallet / realface list | Keypair-only capability while `BLOCKRUN_API_KEY` is set. | Unset `BLOCKRUN_API_KEY` and restart to use a wallet. |
| Startup error "not a valid BlockRun API key" | `BLOCKRUN_API_KEY` is malformed. It deliberately fails loudly rather than silently spending USDC from a wallet instead. | Fix the value or unset it. |
| Grok (or any client with a startup timeout) shows `blockrun [unavailable]`, and `mcp doctor` says `server timed out (no response within 30s)` | NOT broken: a cold `npx -y` is still downloading the package and its dependency tree when the client gives up. Grok's `startup_timeout_sec` defaults to 30; the cold start measured 17s on a fast connection and 42-46s on a slower box. Nothing is charged — the server never started. | Raise it in `~/.grok/config.toml` (`[mcp_servers.blockrun]` … `startup_timeout_sec = 120`), or `npm install -g @blockrun/mcp@latest` and point the client at `blockrun-mcp`. Confirm the package itself is fine first: `npx -y @blockrun/mcp@latest` in a terminal answers an `initialize` line. Only the first run is slow — npx caches by exact spec. |
| `fetch failed` / balance-check timeout | Base RPC blip; the tool rotates through 3 public RPCs | Wait 30 s, retry once. Persistent → a local proxy/firewall is blocking outbound RPC. |
| `Video`/`Music generation timed out` | Upstream queue. **Not charged** — payment settles on completion only. | Retry, or pick a faster model. Do not retry-loop; jobs take 60–180 s. |
| `blockrun_price` with `category:"stocks"` / `"usstock"` → `Equity quotes are not served (gateway 501 …)` | The gateway withdrew equity price/history on 2026-09-05 (licensing), and the tool answers before the wallet is consulted. Not an outage. **Not charged.** | Do not retry. `action:"list" category:"stocks" market:"us"` still returns the ticker catalog for free. Equity coverage: hello@blockrun.ai. |
| `blockrun_markets` on `sports/*` → `Predexon's sports/* routes have returned an upstream 500 … since 2026-08-04` (builds before 0.49.0: `API error after payment: 502 / Request failed` with no balance change) | Upstream Predexon outage since 2026-08-04. The gateway releases the payment on the upstream 500, so the old wording asserted a charge that never happened. **Not charged** when the response carries the gateway's `(payment NOT charged)` confirmation — the error then says so; without it the error tells you to check `blockrun_wallet action:"report"`. | Use `path:"markets/search"` with `params:{ q:"NBA" }` or `polymarket/events` with `params:{ search:"NBA" }`. Not `markets` + `league` — removed upstream 2026-08-04, 404s before payment. Do not retry `sports/*`. Upgrade to ≥ 0.49.0 so the error says this itself. |
| A config names `blockrun_surf` → the client reports an unknown tool | The tool was REMOVED in 0.49.0: the gateway has answered every Surf path with `410 endpoint_retired` since 2026-09-06, so it could only ever error. **Nothing is charged.** | Use `blockrun_price` / `blockrun_dex` / `blockrun_defi` / `blockrun_markets` / `blockrun_rpc`; the `surf` skill maps each former endpoint. Drop `blockrun_surf` from any allowlist. |
| `blockrun_video` / `blockrun_image` → `The gateway quoted $X for <model>, but this tool expected about $Y (N.Nx the published rate) … Refusing to sign it — no charge was made` | The 402 price is far above the published rate: the gateway repriced the model, or a lagging deployment substituted another one. Live 2026-09-08: `sol.blockrun.ai` does not know `azure/sora-2` and quotes Seedance 2.0 Pro at $1.135 in its place. **Not charged** — the tool refuses before signing. | For Sora: `blockrun_wallet action:"chain" chain:"base"`. Otherwise pick another model or chain, and report the quote (the message names what the gateway labelled it) so the estimator or the gateway gets fixed. |
| Any tool → `The gateway does not serve this endpoint (501 Not Implemented)` | The route is withdrawn, not down. Before payment the message ends "nothing was charged"; after payment it tells you to check the ledger instead, because the formatter cannot know whether the nonce was released. | Do not retry. `blockrun_wallet action:"report"` shows whether the call settled. |
| Model id 404s | Delisted upstream | `blockrun_models` for the live list. |
| Startup prints `🚨 WALLET PRIVATE KEY DETECTED IN CONFIG FILE` | A raw key sits somewhere it was never meant to be — a header, an `args` entry, the old hosted-auth field — in a client config file (`~/.claude.json`, Claude Desktop, Cursor, Windsurf). Since 0.49.0 the DOCUMENTED override `mcpServers.*.env.BLOCKRUN_WALLET_KEY` / `SOLANA_WALLET_KEY` does NOT trigger this banner; it gets a short plaintext-and-synced note instead. | Banner: treat the key as compromised — move funds to a new wallet, remove it from the config. Note: optional; prefer `~/.blockrun/.session` or `BLOCKRUN_KEYCHAIN=auto`. |
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
