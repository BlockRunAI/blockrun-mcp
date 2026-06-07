---
name: rpc
description: Use when the user needs raw blockchain JSON-RPC access — contract reads (eth_call), native balances, blocks, transactions, logs, gas estimates, or any chain-native RPC method across 40+ chains. One endpoint per chain via BlockRun's Tatum-backed gateway, $0.002 per call, no node, no API key. Prefer blockrun_price / blockrun_dex / blockrun_surf when they already cover the question.
triggers:
  - "rpc"
  - "json-rpc"
  - "eth_call"
  - "contract read"
  - "raw chain"
  - "node access"
  - "blockchain rpc"
  - "getBalance"
  - "block number"
  - "transaction receipt"
  - "event logs"
  - "tatum"
---

# Multi-chain RPC — 40+ chains, one tool

`blockrun_rpc` POSTs a standard JSON-RPC 2.0 body to `/v1/rpc/{network}`. Flat **$0.002 per call**; a JSON-RPC **batch array charges per element**. Settlement in USDC via x402. Responses are cached briefly server-side for identical read calls (`X-Cache: HIT` is free of upstream latency but still billed).

## When to use which tool

| Question | Tool |
|---|---|
| "What's ETH trading at?" | `blockrun_price` (free) |
| "PEPE/WETH pool liquidity?" | `blockrun_dex` (free) |
| "What's this wallet labeled as / holding?" | `blockrun_surf` |
| "Call `balanceOf(0x...)` on this ERC-20" | **`blockrun_rpc`** |
| "Latest block / tx receipt / event logs / gas price" | **`blockrun_rpc`** |
| "Solana account info / slot / signatures" | **`blockrun_rpc`** |

## Networks

EVM (use `eth_*` methods):

| Key | Chain | | Key | Chain |
|---|---|---|---|---|
| `ethereum` | Ethereum | | `zksync` | zkSync Era |
| `base` | Base | | `berachain` | Berachain |
| `arbitrum` | Arbitrum One | | `unichain` | Unichain |
| `arbitrum-nova` | Arbitrum Nova | | `monad` | Monad |
| `optimism` | Optimism | | `chiliz` | Chiliz |
| `polygon` | Polygon | | `moonbeam` | Moonbeam |
| `bsc` | BNB Smart Chain | | `aurora` | Aurora |
| `avalanche` | Avalanche C-Chain | | `flare` | Flare |
| `fantom` | Fantom | | `oasis` | Oasis Sapphire |
| `cronos` | Cronos | | `kaia` | Kaia (Klaytn) |
| `celo` | Celo | | `sonic` | Sonic |
| `gnosis` | Gnosis | | `xdc` | XDC Network |
| `abstract` | Abstract | | `hyperevm` | HyperEVM |
| `plume` | Plume | | `ronin` | Ronin |
| `rootstock` | Rootstock (RSK) | | | |

Non-EVM (chain-native methods):

| Key | Chain | Method family |
|---|---|---|
| `solana` | Solana | `getSlot`, `getBalance`, `getAccountInfo`, `getSignaturesForAddress` |
| `bitcoin` | Bitcoin | `getblockchaininfo`, `getblockcount`, `getrawtransaction` |
| `litecoin` / `dogecoin` / `bitcoin-cash` / `zcash` | UTXO chains | Bitcoin-style RPC |
| `near` | NEAR | `status`, `query` |
| `sui` | Sui | `sui_getLatestCheckpointSequenceNumber`, `suix_getBalance` |
| `ripple` | XRP Ledger | `account_info`, `ledger` |
| `polkadot` / `kusama` | Substrate | `chain_getHeader`, `state_getStorage` |

Unknown-but-wellformed slugs pass through to the Tatum gateway untouched — newly added chains work without an MCP update. A bad slug returns HTTP 400 with the supported list (no charge).

## Recipes

ERC-20 balance (eth_call):

```
blockrun_rpc({
  network: "base",
  method: "eth_call",
  params: [{
    to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",   // USDC on Base
    data: "0x70a08231000000000000000000000000<ADDRESS_NO_0x_PADDED_TO_32B>"
  }, "latest"]
})
```

Native balance: `method: "eth_getBalance", params: ["0x...", "latest"]`
Tx receipt: `method: "eth_getTransactionReceipt", params: ["0x<txhash>"]`
Event logs: `method: "eth_getLogs", params: [{ fromBlock, toBlock, address, topics }]` — keep ranges small; huge ranges are rejected upstream (no charge).
Gas: `method: "eth_gasPrice"` / `eth_estimateGas`

Solana token account: `network: "solana", method: "getTokenAccountsByOwner", params: ["<owner>", {"mint": "<mint>"}, {"encoding": "jsonParsed"}]`

Batch (charged per element — 3 calls = $0.006):

```
blockrun_rpc({ network: "ethereum", body: [
  { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" },
  { jsonrpc: "2.0", id: 2, method: "eth_gasPrice" },
  { jsonrpc: "2.0", id: 3, method: "eth_chainId" }
]})
```

## Failure semantics

- Upstream timeout / 5xx → **no charge**, retry safe.
- Malformed body / bad network → HTTP 400, **no charge**.
- JSON-RPC-level errors (e.g. revert on `eth_call`) come back inside `result.error` — the call **is** charged (the node did the work).
