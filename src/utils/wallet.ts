// src/utils/wallet.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  LLMClient,
  ImageClient,
  PriceClient,
  SolanaLLMClient,
  getOrCreateWallet,
  loadSolanaWallet,
  getPaymentLinks,
  formatWalletCreatedMessage,
  formatNeedsFundingMessage,
  SOLANA_WALLET_FILE_PATH,
} from "@blockrun/llm";

export type ApiClient = LLMClient | SolanaLLMClient;

const BLOCKRUN_DIR = path.join(os.homedir(), ".blockrun");
const CHAIN_PREFERENCE_FILES = [
  path.join(BLOCKRUN_DIR, ".chain"),
  path.join(BLOCKRUN_DIR, "payment-chain"),
];

let _evmClient: LLMClient | null = null;
let _imageClient: ImageClient | null = null;
let _priceClient: PriceClient | null = null;
let _evmWalletInfo: { address: string; privateKey: string; isNew: boolean } | null = null;
let _solanaClient: SolanaLLMClient | null = null;

function readChainPreference(): "base" | "solana" | null {
  for (const file of CHAIN_PREFERENCE_FILES) {
    try {
      if (!fs.existsSync(file)) continue;
      const value = fs.readFileSync(file, "utf-8").trim().toLowerCase();
      if (value === "base" || value === "solana") return value;
    } catch { /* ignore */ }
  }
  return null;
}

export function getChain(): "base" | "solana" {
  // 1. Explicit user preference (~/.blockrun/.chain) wins over everything else.
  //    Without this, the mere existence of a stale .solana-session file pins
  //    the server to Solana even when the user has explicitly switched to Base.
  const preferred = readChainPreference();
  if (preferred) return preferred;

  // 2. SOLANA_WALLET_KEY env var implies the operator wants Solana.
  if (process.env.SOLANA_WALLET_KEY) return "solana";

  // 3. Fall back to wallet-file autodetection for first-run users who never
  //    set a chain preference but already have a Solana session on disk.
  try {
    if (fs.existsSync(SOLANA_WALLET_FILE_PATH)) return "solana";
  } catch { /* ignore */ }

  return "base";
}

function ensureEvmWallet() {
  if (!_evmWalletInfo) {
    _evmWalletInfo = getOrCreateWallet();
    if (_evmWalletInfo.isNew) {
      console.error(formatWalletCreatedMessage(_evmWalletInfo.address));
    }
  }
  return _evmWalletInfo;
}

export function getOrCreateWalletKey(): `0x${string}` {
  const info = ensureEvmWallet();
  return info.privateKey as `0x${string}`;
}

export function getClient(): ApiClient {
  if (getChain() === "solana") {
    if (!_solanaClient) {
      const privateKey = process.env.SOLANA_WALLET_KEY || loadSolanaWallet() || undefined;
      _solanaClient = new SolanaLLMClient(privateKey ? { privateKey } : undefined);
    }
    return _solanaClient;
  }
  if (!_evmClient) {
    const privateKey = getOrCreateWalletKey();
    _evmClient = new LLMClient({ privateKey });
  }
  return _evmClient;
}

export function getImageClient(): ImageClient {
  if (!_imageClient) {
    const privateKey = getOrCreateWalletKey();
    _imageClient = new ImageClient({ privateKey });
  }
  return _imageClient;
}

export function getPriceClient(): PriceClient {
  if (!_priceClient) {
    const privateKey = getOrCreateWalletKey();
    _priceClient = new PriceClient({ privateKey });
  }
  return _priceClient;
}

export async function getWalletInfo() {
  if (getChain() === "solana") {
    const client = getClient() as SolanaLLMClient;
    const address = await client.getWalletAddress();
    return {
      address,
      network: "Solana" as const,
      chainId: null as number | null,
      currency: "USDC",
      isNew: false,
      explorerUrl: `https://solscan.io/account/${address}`,
      fundingUrl: "https://sol.blockrun.ai",
    };
  }
  const info = ensureEvmWallet();
  const links = getPaymentLinks(info.address);
  return {
    address: info.address,
    network: "Base" as const,
    chainId: 8453 as number | null,
    currency: "USDC",
    isNew: info.isNew,
    explorerUrl: links.basescan,
    fundingUrl: links.blockrun,
  };
}

export { formatNeedsFundingMessage };

export async function getUsdcBalance(address: string): Promise<number | null> {
  if (getChain() === "solana") {
    try {
      const client = getClient() as SolanaLLMClient;
      return await client.getBalance();
    } catch { return null; }
  }
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const BASE_RPC_URLS = [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
  ];
  const data = {
    jsonrpc: "2.0",
    method: "eth_call",
    params: [{ to: USDC_ADDRESS, data: `0x70a08231000000000000000000000000${address.slice(2)}` }, "latest"],
    id: 1,
  };
  for (const rpcUrl of BASE_RPC_URLS) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await response.json() as { result?: string };
      if (result.result) return parseInt(result.result, 16) / 1e6;
    } catch { continue; }
  }
  return null;
}
