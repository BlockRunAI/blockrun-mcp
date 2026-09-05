# Wallet and payment mechanics

Read this when the wallet is misbehaving, when you need to reason about what a call will cost
before making it, or when you are calling the HTTP API directly instead of through the MCP.

## First: which rail is this server on?

There are two, and almost everything below applies to only one of them. Check before
diagnosing anything — `blockrun_wallet action: "status"` says which in its first line.

| | **Wallet** | **Account (API key)** |
|---|---|---|
| Selected by | nothing — the default | `BLOCKRUN_API_KEY=brk_live_…` |
| Endpoint | `blockrun.ai` / `sol.blockrun.ai` | `api.blockrun.ai` |
| Auth | an EIP-3009 / SVM signature per call | `Authorization: Bearer brk_live_…` |
| Price | quoted in a `402` before you sign | never quoted — metered after the fact |
| Chain | Solana or Base | none |
| Ledger | on-chain, plus the local session counter | <https://user.blockrun.ai/dashboard/activity> |

On the account rail there is **no 402, no signature, no chain, and no wallet file**. Every
"switch to Base" and "fund the wallet" remedy below is wrong there; the equivalent is
topping up credit at <https://user.blockrun.ai/dashboard/credits>.

Three things genuinely need a keypair and are refused on the account rail with a message
saying so: Polymarket trading, `blockrun_wallet` balance/deposit/QR/chain, and
`blockrun_realface action: "list"` (assets are indexed by wallet address).

**Costs reported on the account rail are ESTIMATES.** The account API returns no per-call
price, so the server shows what it reserved, prefixed `~`. Do not quote it as a charge — the
invoice is the dashboard.

## Where the key lives

A wallet is auto-created on first use at `~/.blockrun/`. The private key never leaves the
machine — it signs x402 payment headers locally, and BlockRun only ever sees a signature.

The same file is read by the MCP server and by the Python, TypeScript and Go SDKs, so one funded
wallet serves every path. That also means **anything with write access to that directory can
spend the balance.** Keep the amount in it proportionate to what the agent is trusted to do, and
use `blockrun_wallet action: "budget"` rather than a large balance and good intentions.

### Ephemeral sandboxes lose the wallet and the money

Claude Cowork, Claude Desktop and Claude Web run bash in a sandbox VM that is not the user's
machine. A wallet created and funded there is destroyed when the sandbox resets, and the USDC
goes with it. There is no recovery — nobody else has the key.

In those environments, either use the free tier (no wallet involved) or give the user the exact
command to run on their own machine.

## `blockrun_wallet` actions

| Action | What it does |
|---|---|
| `status` | Address, USDC balance, session spend. The default. |
| `setup` | Address plus a funding QR — creates the wallet if there isn't one |
| `deposit` | Card onramp — mints a one-time Coinbase link and opens it. Base only; on Solana it returns address and QR guidance instead |
| `qr` | Funding QR on its own |
| `chain` | Switch between `base` and `solana`; omit `chain` to read the current one |
| `budget` | Session spend cap — `budget_action` is `set`, `check` or `clear` |
| `delegate` | Give a named `agent_id` its own allowance |
| `revoke` | Remove a sub-agent's allowance |
| `report` | Per-agent spending breakdown |

Budgets are enforced, not advisory: an agent that exhausts its delegated allowance is hard
stopped rather than allowed to overspend.

## What `action: "chain"` actually changes

It repoints every paid call at a different deployment — `blockrun.ai` becomes
`sol.blockrun.ai` — and those two do not serve the same catalog at the same prices.
Verified against both, 2026-08-07:

- **The per-transaction fee.** Base adds a flat fee to every non-zero price; Solana adds
  nothing. Same route, same base price, ~$0.001 apart. Nothing in the response says which
  convention you just paid under, so a figure that looks a tenth of a cent off is usually
  the chain, not a reprice.
- **Coverage.** `/v1/defillama/*` is absent on Solana (`404`) and `/v1/modal/*` is present
  but unconfigured (`503` on create, exec, status and terminate — eight probes, all four
  actions plus the GPU tiers). `blockrun_defi` and `blockrun_modal` guard against this and
  refuse with a message naming the chain; every other tool works on both.

  Re-probed 2026-09-05, and this list got SHORTER: music, speech, sound-effects, RealFace
  and Portrait enrolment, and native `/v1/messages` are all served by `sol.blockrun.ai`
  now. The client refused them on Solana for months after that stopped being true. If a
  tool tells you a capability is Base-only, believe the gateway, not the message — an
  unpaid `402` probe costs nothing and settles it.
- **Onramp.** Card funding is Base-only, so `action: "deposit"` degrades to address + QR
  guidance on Solana. Fund a Solana wallet by transfer.

The budget gate reserves the **Base** figure on both chains. That over-reserves on Solana,
which is the safe direction — it can refuse an affordable call, but it can never let one
past the cap. `scripts/verify-prices.ts` probes both gateways and fails the build if
Solana ever becomes the dearer one, because then the same reserve would be short.

## Funding

1. **Card / bank.** Through the MCP this is `blockrun_wallet action: "deposit"` — do not
   hand-roll it. Calling the HTTP API directly, it is
   `POST https://blockrun.ai/api/v1/onramp/token` with `{"address": "0x..."}`. The endpoint is
   free and settles nothing — the x402 signature is used purely to prove you control the wallet,
   which is why the funding `address` must equal the address that signed the request. Returns a
   one-time Coinbase Onramp link. Base only, and rate-limited per IP and per wallet.
2. **Direct transfer.** Send USDC to the address on Solana or Base. New installs default to
   Solana; an install that already had a Base wallet stays on Base until it is switched.
3. **Neither.** The free chat tier needs no balance at all.
4. **Not a wallet at all.** On the account rail, credit is added at
   <https://user.blockrun.ai/dashboard/credits> by card or wire, and billed post-hoc at exact
   usage — no per-call minimum and no per-call transaction fee.

## What a call actually costs

Do not compute a price. Two things have gone wrong historically by doing so:

- **The per-transaction fee has changed more than once.** Any price written as
  `base + fee` in a document is wrong the next time the fee moves — and every flat price in this
  repo's skills was silently a full fee out of date for exactly that reason.
- **Display fields in a 402 body can disagree with the signed requirements.** The authority is
  the decoded `payment-required` header, not the human-readable JSON next to it.

So: read the 402 for the real amount, `blockrun_models` for live per-token pricing, and
<https://blockrun.ai/llms.txt> for the current catalog.

## The x402 round trip, when calling HTTP directly

1. `POST` the endpoint with no payment header.
2. You get `402` with a base64 `payment-required` header. Decode it — `accepts[0]` carries
   `scheme`, `network`, `amount`, `asset`, `payTo` and `maxTimeoutSeconds`.
3. Sign an EIP-3009 `TransferWithAuthorization` for that amount to that recipient.
4. Retry the same request with `X-PAYMENT` set to the base64 payload.

On success the response may carry `x-payment-receipt` with the settlement transaction hash.

**Failed requests are not charged.** Settlement happens on success only, so a non-2xx costs
nothing and a retry after an upstream error is free. A signature is single-use — build a fresh
nonce per attempt rather than replaying one.

## When it goes wrong

| Symptom | Cause |
|---|---|
| Second `402` after signing | Signature did not verify. Usually a chain mismatch, a stale nonce, or an amount that does not match the requirements. |
| `403` from the onramp endpoint | The `address` in the body is not the address that signed. They must match. |
| `429` from the onramp endpoint | Minting is rate-limited per IP and per wallet. Wait it out. |
| Funded but balance still reads zero | Wait for confirmation and re-check. Also check `action: "chain"` — funds on Solana do not show against a Base balance. |
| `401` from `api.blockrun.ai` | `BLOCKRUN_API_KEY` was rejected. Check it at <https://user.blockrun.ai/dashboard/keys>. Not a funding problem. |
| `402` from `api.blockrun.ai` | The ACCOUNT is out of credit — there is nothing to sign. Top up at <https://user.blockrun.ai/dashboard/credits>. |
| "needs wallet mode" | A keypair-only capability on the account rail. Unset `BLOCKRUN_API_KEY` and restart, or use a different tool. |
| "Refusing to sign, per-call cap exceeded" | A client-side spending hook, not BlockRun. Raise the cap on the caller. |
| Charged for something that failed | Should not happen — settlement is success-only. Capture the completion id and the receipt header before reporting it. |
