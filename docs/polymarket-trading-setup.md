# Polymarket Trading Setup & Test Guide

How to configure `blockrun_polymarket` and place a real bet on Polymarket end to
end. Written for testers evaluating the feature on PR #36.

> **Real money.** Orders spend real **pUSD** on Polygon. Everything is
> confirm-gated and capped (`POLYMARKET_MAX_BET_USD`, default **$25/order**), but
> a confirmed order is a real trade. Start with ~$5 and a $1 test order.

---

## 0. How it works (30-second version)

- Your existing BlockRun wallet key (`~/.blockrun/.session`) signs every order
  **locally** — non-custodial. Nothing (not BlockRun, not Polymarket's relayer)
  can move your funds; they only forward requests you already signed.
- Funds live as **pUSD** in a **deposit wallet** — a smart-contract vault on
  Polygon derived from your key (only your key can authorize it). Deploying it,
  approving the exchanges, and redeeming winnings are all **gasless** (a relayer
  pays the gas).
- Polymarket **geoblocks order placement by IP** (US / UK / EU and many regions
  are restricted). We route order traffic through a **Tokyo egress** (an
  API-permitted region). Reads and your AI/x402 traffic are unaffected.

---

## 1. Prerequisites

- Node ≥ 20.19, and the `blockrun` MCP installed in your client (Claude Code,
  etc.). To test **this PR** before it's published:
  ```bash
  git clone https://github.com/BlockRunAI/blockrun-mcp
  cd blockrun-mcp && git checkout feat/polymarket-trading
  npm install && npm run build
  # point your MCP client at the local build:
  claude mcp add blockrun-dev -s user -- node /ABSOLUTE/PATH/blockrun-mcp/dist/index.js --profile trading
  ```
  (Once merged: `claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest`.)
- A funded BlockRun wallet for AI/x402 (only if you also use the other tools).
- ~**$5 of USDC** you're willing to bet, reachable to move onto Polygon.

---

## 2. Egress (get past the geoblock)

You almost certainly need this — from the US/EU a raw order returns
`403 Trading restricted in your region`.

### Option A — use the shared Tokyo relay (fastest for testing)

A public Tokyo relay is already deployed for this test round. Set two env vars on
the MCP server (see §3):

```
POLYMARKET_CLOB_HOST=https://pm-egress-vbsbhh7lea-an.a.run.app/clob
POLYMARKET_RELAYER_URL=https://pm-egress-vbsbhh7lea-an.a.run.app/relayer
```

Verify it reaches CLOB from Tokyo:
```bash
curl -s https://pm-egress-vbsbhh7lea-an.a.run.app/clob/version   # → {"version":2}
```

> ⚠️ This is a **temporary, shared, unauthenticated demo relay** — it only
> forwards to Polymarket hosts, is rate-limited, and will be torn down after the
> showcase. For anything beyond testing, run your own (Option B).

### Option B — run your own egress

- **Cloud Run relay** (no VM public IP needed — works even under a
  `compute.vmExternalIpAccess=DENY` org policy):
  ```bash
  bash deploy/tokyo-egress/deploy.sh    # deploys to asia-northeast1, prints the URL
  ```
  First run in a fresh project may need the Cloud Build service account to have
  `roles/artifactregistry.writer` (grant it, then re-run).
- **Authenticated forward proxy** on any Tokyo VM/VPS, then set
  `HTTPS_PROXY=http://user:pass@host:port` (covers both CLOB and relayer) or
  `POLYMARKET_CLOB_PROXY=...` (Polymarket-only). x402/LLM traffic stays direct.

---

## 3. Configure the MCP server

Add the env to your `blockrun` MCP registration (in `~/.claude.json`, the
server's `env` object), then restart the client so it reloads:

```jsonc
"blockrun": {
  "command": "npx",
  "args": ["-y", "@blockrun/mcp@latest"],
  "env": {
    "POLYMARKET_CLOB_HOST": "https://pm-egress-vbsbhh7lea-an.a.run.app/clob",
    "POLYMARKET_RELAYER_URL": "https://pm-egress-vbsbhh7lea-an.a.run.app/relayer",

    // Choose a wallet mode (§4):
    // Deposit-wallet mode (gasless, recommended) — from polymarket.com → Settings → API Keys:
    "POLYMARKET_RELAYER_API_KEY": "...",
    "POLYMARKET_RELAYER_API_SECRET": "...",
    "POLYMARKET_RELAYER_API_PASSPHRASE": "...",

    // Optional safety knobs:
    "POLYMARKET_MAX_BET_USD": "25",
    "POLYMARKET_MAX_SESSION_USD": "100"
  }
}
```

Restart Claude Code (or `/mcp` to reconnect) — MCP env is read at startup.

---

## 4. Choose a wallet mode

| | **Deposit wallet** (default, `POLYMARKET_SIG_TYPE=3`) | **EOA** (`POLYMARKET_SIG_TYPE=0`) |
|---|---|---|
| Gas | Gasless (relayer pays) | You need **POL** for gas |
| Needs | Relayer API creds (polymarket.com → Settings → API Keys) | No relayer creds |
| Funds live in | A deposit-wallet vault derived from your key | Your key's own address |
| Can place orders? | ✅ Yes | ⚠️ **No** — CLOB V2 rejects a plain EOA maker (`maker address not allowed, please use the deposit wallet flow`) |

**Use deposit-wallet mode to place orders.** Verified against the live CLOB: a
plain EOA maker is rejected with *"maker address not allowed, please use the
deposit wallet flow"*, so relayer creds are effectively required for trading. EOA
mode is still useful for reads and credential derivation, but not for placing
orders.

---

## 5. Run it

All commands are the `blockrun_polymarket` tool. Discover markets with
`blockrun_markets` first.

```
# 1) Provision + inspect (idempotent — safe to re-run any time)
blockrun_polymarket action:"setup"
#    → prints your deposit wallet address, funding instructions,
#      and: ✅ Region: order placement permitted from this egress

# 2) Fund the DEPOSIT WALLET printed above with ~$5 (pUSD, or USDC via the
#    Polymarket bridge which auto-wraps to pUSD). Only pUSD in the deposit
#    wallet counts as buying power.

# 3) Sign the one-time gasless approvals (after funding)
blockrun_polymarket action:"setup" confirm:true

# 4) Find a market + outcome token
blockrun_markets path:"polymarket/markets" params:{ ... }      # → clobTokenIds, conditionId

# 5) Preview, then place a $1 test order
blockrun_polymarket action:"buy" token_id:"<id>" amount_usd:1              # dry-run preview
blockrun_polymarket action:"buy" token_id:"<id>" amount_usd:1 confirm:true # places (market FOK)
#    limit order instead: price:0.45 size:10   (GTC)
#    by market:            condition_id:"0x..." outcome:"Yes"

# 6) Manage
blockrun_polymarket action:"positions"                 # holdings, PnL, redeemable
blockrun_polymarket action:"orders"                    # open orders
blockrun_polymarket action:"cancel" order_id:"<id>"    # or all:true

# 7) Claim winnings after a market resolves (gasless)
blockrun_polymarket action:"redeem" condition_id:"0x..." confirm:true

# 8) Cash out — pUSD → native USDC on Base, to your agent wallet
blockrun_polymarket action:"withdraw"                          # dry-run (full balance)
blockrun_polymarket action:"withdraw" confirm:true             # execute (full balance)
#   partial:      amount_usd:5
#   elsewhere:    to_address:"0x..."   (default: your own agent wallet on Base)
```

**Cash-out loop:** `sell` (before resolution) or `redeem` (after you win) turns a
position into pUSD in your deposit wallet; `withdraw` then bridges that pUSD to
**native USDC on Base**, delivered to your agent wallet — the same wallet that
pays x402 AI fees. Instant, no Polymarket fee (minor Uniswap-v3 swap slippage).

**Order semantics:** prices are probabilities `0–1`, auto-rounded conservatively
to the market's tick grid (a buy never signs above your limit). Market **buy** =
`amount_usd` (dollars); market **sell** = `size` (shares). Limit = `price` +
`size`. `confirm:true` is required to place anything; without it you get a
dry-run preview.

---

## 6. Verify the egress (optional sanity checks)

```bash
# Reaches CLOB V2 from Tokyo:
curl -s <RELAY>/clob/version                          # → {"version":2}

# Order endpoint is NOT geoblocked from this egress (401 = needs auth, would
# work with a real signature; 403 = still geoblocked):
curl -s -o /dev/null -w "%{http_code}\n" -X POST <RELAY>/clob/order \
  -H "content-type: application/json" -d '{}'          # → 401  (good)
```

`action:"setup"` runs this same order-endpoint probe and reports
`✅ / ❌ Region: order placement …`.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `403 Trading restricted in your region` | Egress not set / not routing. Set `POLYMARKET_CLOB_HOST` + `POLYMARKET_RELAYER_URL` (or `HTTPS_PROXY`) and restart. |
| `❌ Region: order placement BLOCKED` in setup | Same as above — the order endpoint probe still sees a restricted egress. |
| `relayer API credentials are not configured` | Add `POLYMARKET_RELAYER_API_KEY/_SECRET/_PASSPHRASE`, or use `POLYMARKET_SIG_TYPE=0` (EOA + POL). |
| `Not enough balance/allowance` | Fund the deposit wallet with pUSD, then re-run `action:"setup"` (it refreshes the CLOB balance cache). |
| `order signer address has to be the address of the API KEY` | Auto-recovered once (creds re-derived); if it persists, re-run setup or set `POLYMARKET_SIG_TYPE=0` (upstream clob-client-v2 issue #65 — this tool ships the fix). |
| `FOK order could not fill` | Use `order_type:"FAK"` or a limit order at the shown book price. |
| Setup says pending after deploy | The relayer tx is still confirming; re-run `action:"setup"` in a minute. |

---

## 8. Safety recap

- `confirm:true` is **required** for every order / approval / redeem (dry-run otherwise).
- Per-order cap `POLYMARKET_MAX_BET_USD` (default $25) + optional `POLYMARKET_MAX_SESSION_USD`.
- Bets never draw from the x402 API budget — different asset, different wallet.
- Your private key never leaves the machine and is never printed.
- **Back up `~/.blockrun/.session`** — it is the only key to both the payment
  wallet and the Polymarket deposit wallet. Lose it, lose the funds.
