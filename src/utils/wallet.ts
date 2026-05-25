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
  getOrCreateSolanaWallet,
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
let _freePriceClient: PriceClient | null = null;
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

// The canonical file we WRITE the chain preference to (getChain reads either,
// but a single writer keeps things unambiguous).
const CHAIN_FILE = path.join(BLOCKRUN_DIR, ".chain");

// Drop every chain-dependent cached client so the next getClient()/getImageClient()
// rebuilds against the freshly-selected chain. The EVM wallet identity
// (_evmWalletInfo) is chain-independent and intentionally preserved.
function resetChainCaches(): void {
  _evmClient = null;
  _solanaClient = null;
  _imageClient = null;
  _priceClient = null;
  _freePriceClient = null;
}

/**
 * Explicitly switch the active payment chain. Persists to ~/.blockrun/.chain
 * (which getChain() ranks above env vars and wallet-file autodetection) and
 * clears cached clients so the change takes effect on the very next call.
 */
export function setChain(chain: "base" | "solana"): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(CHAIN_FILE, chain, { mode: 0o600 });
  resetChainCaches();
}

/**
 * Provision BOTH wallets so each chain has a fundable address regardless of
 * which one is currently active. Idempotent — getOrCreate* only generate on
 * first run. Returns each chain's address + whether it was just created.
 */
export async function ensureBothWallets(): Promise<{
  base: { address: string; isNew: boolean };
  solana: { address: string; isNew: boolean };
}> {
  const evm = ensureEvmWallet();
  const sol = await getOrCreateSolanaWallet();
  if (sol.isNew) {
    console.error(formatWalletCreatedMessage(sol.address));
  }
  return {
    base: { address: evm.address, isNew: evm.isNew },
    solana: { address: sol.address, isNew: sol.isNew },
  };
}

/**
 * Guard for capabilities the Solana SDK path doesn't cover yet (image
 * generation, price data, video, music, RealFace). Returns an actionable
 * message when the active chain is Solana, otherwise null. Tools call this
 * before paying so they never silently drain the Base wallet while the user
 * believes they're on Solana.
 */
export function baseOnlyMessage(capability: string): string | null {
  if (getChain() === "solana") {
    return `${capability} currently supports Base-chain payment only — your active chain is Solana. Switch with: blockrun_wallet action:"chain" chain:"base"  (switch back later with chain:"solana"). Solana support depends on the @blockrun/llm SDK adding this capability.`;
  }
  return null;
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

function buildSolanaClient(): SolanaLLMClient {
  const privateKey = process.env.SOLANA_WALLET_KEY || loadSolanaWallet() || undefined;
  return new SolanaLLMClient(privateKey ? { privateKey } : undefined);
}

export function getClient(): ApiClient {
  if (getChain() === "solana") {
    if (!_solanaClient) {
      _solanaClient = buildSolanaClient();
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

export function getPriceClient(requireWallet = true): PriceClient {
  if (!requireWallet) {
    if (!_freePriceClient) {
      _freePriceClient = new PriceClient({ requireWallet: false });
    }
    return _freePriceClient;
  }

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

async function getSolanaUsdcBalance(): Promise<number | null> {
  try {
    return await buildSolanaClient().getBalance();
  } catch { return null; }
}

async function getBaseUsdcBalance(address: string): Promise<number | null> {
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

/** USDC balance for an explicit chain — used to show BOTH wallets at once. */
export async function getChainBalance(chain: "base" | "solana", address: string): Promise<number | null> {
  return chain === "solana" ? getSolanaUsdcBalance() : getBaseUsdcBalance(address);
}

export async function getUsdcBalance(address: string): Promise<number | null> {
  return getChainBalance(getChain(), address);
}
