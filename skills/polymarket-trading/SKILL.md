---
name: polymarket-trading
description: Use when the user wants to actually PLACE, manage, or redeem bets on Polymarket (not just read odds — that's blockrun_markets). Covers setup (deposit wallet, funding, approvals), buy/sell with confirm gating, positions, redeeming winnings, geoblock handling, and the end-to-end demo flow.
---

# Polymarket Trading (blockrun_polymarket)

Real-money trading on Polymarket's CLOB V2 (Polygon), signed locally by the
user's BlockRun wallet key. **Data discovery stays on `blockrun_markets`** —
this tool only trades.

## Mental model

- **Signer** = the BlockRun key (`~/.blockrun/.session`). Never leaves the machine.
- **Deposit wallet** = a Polygon vault contract derived from that key
  (POLY_1271). It holds the betting funds in **pUSD** and only honors the
  signer's EIP-712 signatures. Deploy/approve/redeem are **gasless** (relayer).
- **Money separation**: bets spend pUSD on Polygon; x402 API fees spend USDC on
  Base. The budget ledger does NOT cover bets — `confirm:true` + caps do.
- **Zero setup**: no Polymarket account, no API keys, no gas token. On first
  `setup` the MCP bootstraps a builder key from the user's OWN wallet, then
  derives + deploys the vault (all gasless). Geoblock is handled by default —
  CLOB traffic routes through BlockRun's Finland egress out of the box.

## Golden rules for agents

1. **Never pass `confirm:true` unless the user explicitly approved that exact
   trade.** Call once WITHOUT confirm → show the dry-run preview → ask → re-call
   with `confirm:true`.
2. Per-order cap `POLYMARKET_MAX_BET_USD` (default $25) and optional session cap
   are enforced server-side; don't try to split orders to sneak past them.
3. On ANY error, read the message — it says exactly what to do next (fund,
   approve, region, re-run setup). Don't retry blindly.

## End-to-end flow

```
# 0. No Polymarket account or API keys needed — the MCP bootstraps everything
#    from the user's own wallet on first setup. (Set POLYMARKET_CLOB_HOST to a
#    permitted-region egress only if the user is in a geoblocked region.)

# 1. Provision + inspect (idempotent, safe to re-run any time)
blockrun_polymarket action:"setup"
# → deposit wallet address + funding instructions + region status

# 2. Fund the vault from the user's Base USDC — gasless x402, one call ($0.01 fee,
#    non-custodial). pUSD credit is ASYNC (minutes) — re-run setup to watch it. Min $2.
blockrun_polymarket action:"fund" amount_usd:5             # dry-run preview
blockrun_polymarket action:"fund" amount_usd:5 confirm:true

# 3. Sign the one-time gasless approval batch (after user consent)
blockrun_polymarket action:"setup" confirm:true

# 4. Find a market + token (data tool, paid data)
blockrun_markets path:"polymarket/markets" params:{...}   # → clobTokenIds, conditionId

# 5. Preview, then place
blockrun_polymarket action:"buy" token_id:"..." amount_usd:2            # dry-run
blockrun_polymarket action:"buy" token_id:"..." amount_usd:2 confirm:true  # market FOK
#   or limit: price:0.45 size:10 (GTC; order_type:"GTD" + expires_at for expiry)
#   or via condition: condition_id:"0x..." outcome:"Yes"

# 6. Manage
blockrun_polymarket action:"orders"                     # open orders
blockrun_polymarket action:"cancel" order_id:"..."      # or all:true
blockrun_polymarket action:"positions"                  # holdings + PnL + redeemable

# 7. Claim winnings after resolution (gasless)
blockrun_polymarket action:"redeem" condition_id:"0x..."             # preview
blockrun_polymarket action:"redeem" condition_id:"0x..." confirm:true

# 8. Cash out — pUSD → native USDC on Base, back to the user's agent wallet
blockrun_polymarket action:"withdraw"                                # dry-run (full balance)
blockrun_polymarket action:"withdraw" confirm:true                   # (partial: amount_usd:5)
```

## Order semantics

- Prices are probabilities 0–1, auto-rounded to the market's tick grid.
- Market **buy** = `amount_usd` (dollars). Market **sell** = `size` (shares).
- Limit orders: `price` + `size`; default GTC; `post_only:true` for maker-only.
- FOK fails whole-or-nothing; FAK fills what it can. On "FOK not filled", offer
  FAK or a limit at the shown book price.

## Regions / geoblock

Order placement is IP-geoblocked (US/UK/EU + many regions). **Handled by
default** — CLOB traffic routes through BlockRun's Finland egress, so `setup`
reports `✅ Region: order placement permitted` out of the box; you don't need to
do anything. A user can override with `POLYMARKET_CLOB_HOST` (their own relay),
or `POLYMARKET_CLOB_PROXY` / `HTTPS_PROXY`. Respecting Polymarket's ToS for the
user's jurisdiction is the user's responsibility — never suggest evading it.

## Troubleshooting

- "No deposit wallet configured" → run `action:"setup"`.
- No manual creds are ever needed — the MCP bootstraps its builder key from the
  user's own wallet on first `setup`. (Advanced: `POLYMARKET_SIG_TYPE=0` = plain
  EOA mode; needs POL gas + pUSD in the EOA, and is read-only for orders.)
- Balance/allowance errors on a buy → the buy path auto-refreshes the CLOB's
  balance cache and retries once; if it still fails, the vault genuinely lacks
  pUSD or approvals — fund it, then `action:"setup" confirm:true`.
- A **neg-risk market** buy (multi-outcome "winner" markets) fails though setup
  shows ready → a deposit wallet created before the pUSD→NegRisk Adapter approval
  was added needs ONE more `action:"setup" confirm:true` to grant it (setup reads
  approvals on-chain every run, so it detects and signs the missing one).
- 403 → region issue; see setup's region line.
- "order signer address has to be the address of the API KEY" → auto-recovered
  once (creds re-derived); if persistent, `setup`, then consider
  `POLYMARKET_SIG_TYPE=0` (upstream clob-client-v2 issue #65).
