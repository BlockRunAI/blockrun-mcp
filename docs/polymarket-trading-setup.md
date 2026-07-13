# Trading on Polymarket with `blockrun_polymarket`

A complete guide to placing real bets on [Polymarket](https://polymarket.com)
straight from your AI agent — using the **same BlockRun wallet** that pays for
AI via x402. One self-custody identity: it pays for models in USDC on Base *and*
settles USDC-denominated bets on the world's largest prediction market.

> **Real money.** A confirmed order spends real **pUSD** (Polymarket's USDC-backed
> collateral) on Polygon. Every order, approval, redeem, and withdrawal is
> **confirm-gated** (dry-run unless you pass `confirm:true`) and **capped**
> (`POLYMARKET_MAX_BET_USD`, default **$25/order**). Start with ~$5 and a $1 test.

This flow is verified end to end on the live CLOB: an agent's own wallet created
its deposit vault, funded it gaslessly via x402, and placed a **real $1 market
order that matched** — no Polymarket account, no manual API keys, no gas token.

---

## 0. How it works in 30 seconds

- **One key, non-custodial.** Your existing BlockRun key (`~/.blockrun/.session`
  by default) signs every order **locally**. Neither BlockRun nor Polymarket's relayer can
  move your funds — they only forward requests you already signed.
- **Funds live in a deposit wallet.** A smart-contract vault on Polygon, derived
  from your key (only your key can authorize it). Holds **pUSD** — the only thing
  that counts as buying power.
- **Everything is gasless.** Deploying the vault, approving the exchanges,
  placing/redeeming — a relayer pays the Polygon gas. You never need POL.
- **No Polymarket account, no API keys.** The MCP bootstraps everything it needs
  (a builder key for the gasless relayer) from your own wallet, automatically, on
  first `setup`.
- **Geoblock — handled for you.** Polymarket blocks *order placement* by IP
  (US / UK and many regions). The MCP defaults to BlockRun's Finland egress (a
  fully unrestricted region under Polymarket's policy), so it works out of the box
  (§3). Reads, funding, and x402/AI traffic stay direct.

---

## 1. Prerequisites

- The `blockrun` MCP in your client (Claude Code, etc.), with the **`trading`**
  profile enabled (the profile that includes `blockrun_polymarket`):
  ```bash
  claude mcp add blockrun -s user -- npx -y @blockrun/mcp@latest --profile trading
  ```
  To run from source instead:
  ```bash
  git clone https://github.com/BlockRunAI/blockrun-mcp
  cd blockrun-mcp && npm install && npm run build
  claude mcp add blockrun-dev -s user -- node /ABSOLUTE/PATH/blockrun-mcp/dist/index.js --profile trading
  ```
- **~$5 of USDC on Base** in your agent wallet (check with `blockrun_wallet`).
  This is what you'll move onto Polygon to bet with. That's the *only* funding
  you need — no separate Polygon wallet, no POL, no Polymarket deposit.

---

## 2. The one-wallet model (the important concept)

A private key is chain-agnostic, so a single BlockRun identity does double duty:

| | Pays for | On chain | As |
|---|---|---|---|
| **x402 / AI** | models, images, search… | Base (8453) | native USDC |
| **Polymarket** | bets | Polygon (137) | pUSD in your deposit vault |

The vault address is **derived deterministically from your key** — same key,
same vault, forever. Winnings you cash out land back as **native USDC on Base**,
in the very wallet that pays your AI bills. Lose the key, lose both — **back up
your signer key** (`~/.blockrun/.session` by default; `setup` prints the
actual signer address).

---

## 3. Geoblock — handled by default

Polymarket blocks order placement by IP (US / UK and many regions). **You
don't need to do anything** — the MCP defaults to BlockRun's hosted Finland egress
(a fully unrestricted region under Polymarket's policy), so orders route through a
permitted region out of the box, and `action:"setup"` confirms `✅ Region: order
placement permitted`. The relay only forwards to Polymarket's CLOB (it can't see
or move your funds — every order is signed locally by your key); reads, funding,
and x402/AI traffic stay direct.

**Run your own instead** (production, scale, or your own compliance posture) —
override `POLYMARKET_CLOB_HOST`:

- Direct to Polymarket (only works from a permitted region):
  ```
  POLYMARKET_CLOB_HOST=https://clob.polymarket.com
  ```
- Your own Cloud Run relay — one command, `europe-north1` (Finland), no VM or
  public IP (works even under a `vmExternalIpAccess=DENY` org policy):
  ```bash
  bash deploy/finland-egress/deploy.sh   # deploys, prints the URL → use as POLYMARKET_CLOB_HOST
  ```
- A forward proxy in a permitted region — only effective when
  `POLYMARKET_CLOB_HOST` is also pointed at Polymarket directly
  (`https://clob.polymarket.com`) or at your own relay; a proxy alone only
  changes how the default Finland relay is reached, not the Polymarket-facing
  egress:
  ```
  HTTPS_PROXY=http://user:pass@host:port            # covers CLOB + relayer
  POLYMARKET_CLOB_PROXY=http://user:pass@host:port  # Polymarket-only
  ```

Check any egress reaches CLOB V2 and isn't geoblocked (`401` = permitted; `403` =
blocked):

```bash
curl -s   <CLOB_HOST>/version                                    # → {"version":2}
curl -s -o /dev/null -w "%{http_code}\n" -X POST <CLOB_HOST>/order \
     -H "content-type: application/json" -d '{}'                 # → 401  (good)
```

> The relayer (deploy/approve/redeem) is **not** geoblocked, so only order
> placement needs the egress.

---

## 4. Configure the MCP server

Add the env to your `blockrun` registration (in `~/.claude.json`, the server's
`env` object), then restart the client so it reloads:

```jsonc
"blockrun": {
  "command": "npx",
  "args": ["-y", "@blockrun/mcp@latest", "--profile", "trading"],
  "env": {
    // Geoblock egress is handled by default (BlockRun's Finland relay) — you only
    // need POLYMARKET_CLOB_HOST to run your own egress or go direct (§3).
    // "POLYMARKET_CLOB_HOST": "https://clob.polymarket.com",

    // Optional safety knobs:
    "POLYMARKET_MAX_BET_USD": "25",       // per-order cap (default 25)
    "POLYMARKET_MAX_SESSION_USD": "100"   // cumulative per-process cap (optional)
  }
}
```

**Nothing here is required.** No Polymarket account, no API keys, no egress
config — the MCP bootstraps its builder key from your wallet on first `setup` and
defaults the geoblock egress for you; the knobs above are optional. (Advanced:
`POLYMARKET_SIG_TYPE=0` switches to plain-EOA mode, where you hold pUSD and pay
POL gas yourself — useful for reads, but the deposit wallet is the path that
places orders.)

---

## 5. The full flow

Everything is the `blockrun_polymarket` tool. Discover markets with
`blockrun_markets` first. **`confirm:true` is required to place anything** —
without it you get a dry-run preview and nothing is signed.

```
# 1) Provision + inspect — idempotent, safe to re-run any time.
blockrun_polymarket action:"setup"
#    First run bootstraps your builder key, derives + deploys your deposit
#    wallet (gasless), and prints a checklist:
#      ✅ Deposit wallet deployed        ✅ CLOB API credentials
#      ✅ pUSD balance                   ✅ Region: order placement permitted
#      ✅ Exchange approvals

# 2) Fund the vault — gasless, from your Base USDC, one call.
blockrun_polymarket action:"fund" amount_usd:5                 # dry-run preview
blockrun_polymarket action:"fund" amount_usd:5 confirm:true    # signs + submits
#    BlockRun pays the Base gas and charges $0.01; you need no ETH. Non-custodial:
#    your USDC → the Polymarket bridge → wraps to pUSD → your vault.
#    NOTE: the bridge credits pUSD ASYNCHRONOUSLY (usually minutes, occasionally
#    30+). "Submitted" != "credited" — re-run action:"setup" and watch the pUSD
#    balance. Minimum $2 per deposit.

# 3) Sign the one-time gasless approvals (after the vault shows pUSD).
blockrun_polymarket action:"setup" confirm:true

# 4) Find a market + outcome token.
blockrun_markets path:"polymarket/markets" params:{ ... }      # → clobTokenIds, conditionId

# 5) Preview, then place a $1 test order.
blockrun_polymarket action:"buy" token_id:"<id>" amount_usd:1              # dry-run preview
blockrun_polymarket action:"buy" token_id:"<id>" amount_usd:1 confirm:true # places (market FOK)
#    limit order:  price:0.45 size:10           (GTC, rests on the book)
#    by market:    condition_id:"0x..." outcome:"Yes"

# 6) Manage.
blockrun_polymarket action:"positions"                 # holdings, avg price, PnL, redeemable
blockrun_polymarket action:"orders"                    # open orders
blockrun_polymarket action:"cancel" order_id:"<id>"    # or all:true
blockrun_polymarket action:"sell" token_id:"<id>" size:10 confirm:true   # exit before resolution

# 7) Claim winnings after a market resolves (gasless).
blockrun_polymarket action:"redeem" condition_id:"0x..." confirm:true

# 8) Cash out — pUSD -> native USDC on Base, to your agent wallet.
blockrun_polymarket action:"withdraw"                          # dry-run (full balance)
blockrun_polymarket action:"withdraw" confirm:true             # execute
#    partial:    amount_usd:5
#    elsewhere:  to_address:"0x..."   (default: your own agent wallet on Base)
```

**The loop that closes the story:** `sell` (before resolution) or `redeem`
(after you win) turns a position back into pUSD in your vault; `withdraw` bridges
that pUSD to **native USDC on Base**, delivered to the same wallet that pays your
x402 AI fees. Money in via x402, money out via withdraw — one wallet, full circle.

---

## 6. Order semantics

- **Prices are probabilities, `0–1`.** `0.45` = 45¢ = a 45% implied chance.
- Prices are **auto-rounded conservatively** to the market's tick grid — a buy
  never signs *above* your limit, a sell never *below*.
- **Market buy** takes `amount_usd` (dollars to spend); **market sell** takes
  `size` (shares to sell). **Limit** takes `price` + `size`.
- **Order types:** `GTC` (rests, default for limits), `GTD` (good-till-`expires_at`),
  `FOK` (fill-or-kill, default for market), `FAK` (fill-and-kill the rest).
- `min_order_size` and tick come from the live market — the dry-run shows both.

---

## 7. Safety

- **`confirm:true` is required** for every order / approval / fund / redeem /
  withdraw. Without it: a dry-run preview, nothing signed.
- **Per-order cap** `POLYMARKET_MAX_BET_USD` (default $25) + optional cumulative
  **`POLYMARKET_MAX_SESSION_USD`** (in-memory, per-`agent_id`).
- **Bets never draw from your x402 API budget** — different asset (pUSD vs Base
  USDC), different wallet ledger. They can't corrupt each other.
- **Your private key never leaves the machine** and is never printed or logged.
  Credential files are `0600`.
- **Back up your signer key** (`~/.blockrun/.session` by default; a
  `BLOCKRUN_WALLET_KEY` env var or an existing agent `wallet.json` takes
  precedence — `setup` prints the actual signer address) — it is the only key to
  *both* the payment wallet and the Polymarket deposit vault. Lose it, lose the
  funds.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `403 Trading restricted in your region` | The default Finland egress was overridden or isn't routing. Restore the default `POLYMARKET_CLOB_HOST` or point it at a working permitted-region egress and restart (§3) — a proxy alone doesn't change the Polymarket-facing egress. |
| `❌ Region: order placement BLOCKED` in setup | Same — the order-endpoint probe still sees a restricted egress. |
| `redeem` reverts / relayer batch failed | The two pUSD collateral-adapter approvals (added 2026-07) pull your outcome tokens during `redeem`. A wallet set up earlier lacks them — run `action:"setup" confirm:true` once (setup reads approvals on-chain every run and signs what's missing), then retry. |
| Vault shows `$0.00` right after funding | The bridge credits pUSD **asynchronously** (minutes, sometimes 30+). Re-run `action:"setup"` and watch the balance. |
| `Minimum funding is $2` | The Polymarket bridge won't deliver deposits under $2. Fund ≥ $2. |
| `not deployed yet` when funding | Run `action:"setup" confirm:true` first — funds only land in a *deployed* vault. |
| `Not enough balance/allowance` | The buy path auto-refreshes the CLOB balance cache and retries once. If it persists, the vault genuinely lacks pUSD or an approval — fund it, then re-run `action:"setup" confirm:true`. |
| Neg-risk ("winner" / multi-outcome) market buy fails though setup shows ✅ ready | The **pUSD → NegRisk Adapter** approval settles neg-risk orders. A deposit wallet set up before it was added lacks it — run `action:"setup" confirm:true` once to grant it (setup reads approvals on-chain every run and signs the missing one). |
| `order signer address has to be the address of the API KEY` | Auto-recovered once (creds re-derived). If it persists, re-run setup. (Upstream clob-client-v2 [#65](https://github.com/Polymarket/clob-client-v2/issues/65) — this tool ships the correct fix: CLOB creds bind to your EOA, orders are ERC-1271-validated by the vault.) |
| `FOK order could not fill` | Use `order_type:"FAK"`, or a limit order at the book price the dry-run shows. |
| Setup says "pending" after deploy | The relayer tx is still confirming; re-run `action:"setup"` in a minute. |

---

## 9. Under the hood (for the curious)

- **Deposit wallet = POLY_1271 vault.** A CREATE2 smart-contract wallet from
  Polymarket's factory, owned by your key. Orders carry `signer/maker = vault`
  and are validated on-chain by the vault's ERC-1271 `isValidSignature`.
- **CLOB credentials bind to your EOA, not the vault.** This is the correct
  resolution of clob-client-v2 #65: L1/L2 auth uses your key's plain signature
  (matching Polymarket's reference Rust client); the vault authorizes orders via
  ERC-1271. Binding creds to the vault (the fix #65 *proposed*) is rejected by the
  CLOB — this tool does it the working way.
- **Gasless via the builder relayer.** `deploy`, `approve`, and `redeem` are
  EIP-712 `Batch` payloads your key signs and the relayer submits (it pays gas,
  can't alter or replay them). The builder API key that authenticates the relayer
  is **created programmatically from your own wallet** — no manual onboarding.
- **Approval set = Polymarket's canonical `approveTokensForTrading`, plus the two
  pUSD collateral adapters.** The one-time batch grants pUSD (ERC-20) spend to all
  four collateral spenders — CTF Exchange, NegRisk Exchange, **NegRisk Adapter**,
  and the Conditional Tokens contract — plus the CTF outcome-token (ERC-1155)
  operator to five contracts: the two exchanges, the NegRisk Adapter, and the two
  **pUSD collateral adapters** (`CtfCollateralAdapter` /
  `NegRiskCtfCollateralAdapter`), which pull your outcome tokens during `redeem`
  and pay the winnings back as pUSD. The NegRisk Adapter approvals are what let
  neg-risk ("winner"/multi-outcome) markets settle; omitting the pUSD→adapter one
  lets the CLOB accept an order that then reverts in settlement.
- **x402 funding is non-custodial.** `fund` signs an EIP-3009
  `TransferWithAuthorization` on Base USDC; the BlockRun gateway charges $0.01,
  then settles your deposit **straight to the Polymarket bridge** via the CDP
  facilitator (which pays the Base gas). Your USDC never touches a BlockRun
  wallet; the gateway only forwards an authorization it cannot redirect.

---

*Questions or issues: [github.com/BlockRunAI/blockrun-mcp](https://github.com/BlockRunAI/blockrun-mcp).*
