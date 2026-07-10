// src/utils/polymarket/relayer.ts
//
// Thin wrapper over @polymarket/builder-relayer-client for the deposit-wallet
// lifecycle: derive (CREATE2, pre-deploy), deploy (WALLET-CREATE), and signed
// WALLET batches (approvals, redeem). Everything here is GASLESS — the relayer
// sponsors gas. It is a courier, not a custodian: it only ever receives
// EIP-712 payloads signed by the local key, which it can neither alter (the
// signature covers every byte) nor replay (nonce + deadline).
//
// The relayer requires API credentials (polymarket.com → Settings → API Keys)
// purely to authenticate use of its gas-sponsoring service. Phase 2 moves
// these behind the BlockRun gateway so end users need no Polymarket account.
import { RelayClient, type DepositWalletCall } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { createWalletClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { getClobProxyAgent, getPolymarketAccount, installUnderscoreHeaderBridge } from "./client.js";
import { getRelayerCreds, POLYGON_CHAIN_ID, POLYGON_RPC_URLS, RELAYER_URL } from "./constants.js";

export type { DepositWalletCall };

let _relayClient: RelayClient | null = null;

export function relayerCredsMissing(): boolean {
  return getRelayerCreds() === null;
}

export function relayerCredsMissingMessage(): string {
  return [
    `Polymarket relayer API credentials are not configured — the deposit-wallet`,
    `path needs them (they authenticate Polymarket's FREE gas-sponsoring relayer;`,
    `they do NOT control funds — every operation still requires this machine's key).`,
    ``,
    `One-time setup:`,
    `  1. Create/log into an account at https://polymarket.com`,
    `  2. Settings → API Keys → create a key (key / secret / passphrase)`,
    `  3. Set env vars for the MCP server and restart it:`,
    `       POLYMARKET_RELAYER_API_KEY=...`,
    `       POLYMARKET_RELAYER_API_SECRET=...`,
    `       POLYMARKET_RELAYER_API_PASSPHRASE=...`,
    ``,
    `Alternative: set POLYMARKET_SIG_TYPE=0 for plain EOA mode (no deposit`,
    `wallet, no relayer — but the EOA must hold POL for gas and pUSD directly).`,
  ].join("\n");
}

/**
 * RelayClient bound to the REAL account address. Unlike the CLOB client's
 * spoofed signer (see client.ts), relayer Batch signatures are validated
 * against the deposit wallet's OWNER — the EOA — so the reported address must
 * be the real one (nonce lookup and recovery both key on it).
 */
export function getRelayClient(): RelayClient {
  if (_relayClient) return _relayClient;
  const creds = getRelayerCreds();
  if (!creds) throw new Error(relayerCredsMissingMessage());
  const walletClient = createWalletClient({
    account: getPolymarketAccount(),
    chain: polygon,
    transport: http(POLYGON_RPC_URLS[0]),
  });
  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
  });
  _relayClient = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, walletClient, builderConfig);

  // The relayer client creates its OWN axios instance (its bundled 0.27 copy),
  // so the global default we set for the CLOB axios doesn't reach it. Inject
  // the same proxy agent here so a US-egress demo routes the relayer's
  // deploy/approve/redeem POSTs (relayer-v2.polymarket.com) through the
  // permitted egress too — otherwise setup would work but its relayer calls
  // could still originate from a blocked IP.
  const instance = _relayClient.httpClient?.instance as
    | ({ defaults: { httpsAgent?: unknown; proxy?: unknown } } & Parameters<typeof installUnderscoreHeaderBridge>[0])
    | undefined;
  const agent = getClobProxyAgent();
  if (instance?.defaults && agent) {
    instance.defaults.httpsAgent = agent;
    instance.defaults.proxy = false;
  }
  // Same underscore-header survival fix as the CLOB path — the relayer's builder
  // auth (POLY_BUILDER_*) headers must survive a relay too.
  if (instance) installUnderscoreHeaderBridge(instance);
  return _relayClient;
}

/** CREATE2-derived deposit wallet address for the local key (pre-deploy safe). */
export async function deriveDepositWallet(): Promise<Hex> {
  const addr = await getRelayClient().deriveDepositWalletAddress();
  return addr as Hex;
}

/**
 * Derive the deposit wallet address WITHOUT relayer API creds. Derivation is
 * pure CREATE2 math over the signer address plus a public-RPC factory read — no
 * authenticated relayer call — so it works before the user has creds, letting
 * them pre-fund the address. (Deploy/approve/trade still need creds.)
 */
export async function deriveDepositWalletNoCreds(): Promise<Hex> {
  const walletClient = createWalletClient({
    account: getPolymarketAccount(),
    chain: polygon,
    transport: http(POLYGON_RPC_URLS[0]),
  });
  const client = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, walletClient);
  const addr = await client.deriveDepositWalletAddress();
  return addr as Hex;
}

export async function isDepositWalletDeployed(address: string): Promise<boolean> {
  return getRelayClient().getDeployed(address, "WALLET");
}

/**
 * Deploy the deposit wallet (idempotence guarded by the caller via
 * isDepositWalletDeployed). Waits for on-chain confirmation; throws with the
 * relayer transaction id on failure/timeout so the user can re-run setup.
 */
export async function deployDepositWallet(): Promise<{ transactionHash?: string }> {
  const response = await getRelayClient().deployDepositWallet();
  const confirmed = await response.wait();
  if (!confirmed) {
    throw new Error(
      `Deposit wallet deployment did not confirm (relayer tx ${response.transactionID}). ` +
      `It may still be pending — re-run action:"setup" in a minute.`,
    );
  }
  return { transactionHash: confirmed.transactionHash };
}

/**
 * Execute a signed WALLET batch from the deposit wallet (approvals, redeem…).
 * The SDK fetches the nonce, EIP-712-signs the Batch with the local key, and
 * submits; we wait for confirmation.
 */
export async function sendWalletBatch(
  calls: DepositWalletCall[],
  depositWallet: string,
  description: string,
): Promise<{ transactionHash?: string }> {
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const response = await getRelayClient().executeDepositWalletBatch(calls, depositWallet, deadline);
  const confirmed = await response.wait();
  if (!confirmed) {
    throw new Error(
      `${description}: relayer batch did not confirm (tx ${response.transactionID}). ` +
      `Re-run action:"setup" to check state and retry.`,
    );
  }
  return { transactionHash: confirmed.transactionHash };
}
