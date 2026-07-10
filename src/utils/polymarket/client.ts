// src/utils/polymarket/client.ts
//
// ClobClient factory for Polymarket CLOB V2 trading. The signer is the same
// local EVM key that pays BlockRun x402 fees on Base (~/.blockrun/.session) —
// a private key is chain-agnostic, so one identity pays API fees on Base and
// authorizes bets on Polygon. The key never leaves this machine.
//
// POLY_1271 note (issue #65 companion — see l1-auth-1271.ts): the SDK's L2
// header builder reports getSignerAddress(signer) as POLY_ADDRESS, but creds
// derived for a deposit wallet are bound to the DEPOSIT WALLET address. We
// therefore hand the ClobClient a wallet client whose account REPORTS the
// deposit wallet address while still signing with the real EOA key. That is
// safe everywhere the client reads the address:
//   - L2 headers: POLY_ADDRESS = deposit wallet (must match the API key) ✓
//   - order building: for POLY_1271 maker/signer come from funderAddress, and
//     the signer==address assertion is skipped (createOrder.js) ✓
//   - order signing: signTypedData uses the account's key-bound closure,
//     ignoring the address field ✓
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createWalletClient, http, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { getOrCreateWalletKey } from "../wallet.js";
import {
  assertContractConfig,
  CLOB_HOST,
  GEOBLOCK_URL,
  getBuilderCode,
  getClobProxy,
  getSigType,
  POLYGON_CHAIN_ID,
  POLYGON_RPC_URLS,
} from "./constants.js";
import { loadDepositWalletForSigner, loadL2Creds, saveL2Creds } from "./creds.js";
import { deriveApiCreds } from "./l1-auth-1271.js";

let _account: PrivateKeyAccount | null = null;
let _clobClient: ClobClient | null = null;
let _clobClientKey = "";
let _proxyApplied = false;
let _proxyAgent: HttpsProxyAgent<string> | null | undefined;

/** The local EOA account (BlockRun session key) used as the Polymarket signer. */
export function getPolymarketAccount(): PrivateKeyAccount {
  if (!_account) {
    _account = privateKeyToAccount(getOrCreateWalletKey());
  }
  return _account;
}

/**
 * The shared HttpsProxyAgent for POLYMARKET_CLOB_PROXY, or null when unset.
 * Built once. Reused for both the CLOB axios (v1, here) and the relayer's own
 * axios (0.27) instance (relayer.ts injects it), so a US-egress demo can route
 * ALL geoblockable Polymarket traffic — order placement AND the relayer
 * deploy/approve/redeem calls — through one permitted egress.
 */
export function getClobProxyAgent(): HttpsProxyAgent<string> | null {
  if (_proxyAgent === undefined) {
    const proxy = getClobProxy();
    _proxyAgent = proxy ? new HttpsProxyAgent(proxy) : null;
  }
  return _proxyAgent;
}

/**
 * Route CLOB traffic through POLYMARKET_CLOB_PROXY when set. Applied to the
 * axios v1 defaults, which clob-client-v2 (and our l1-auth / geoblock / Data-API
 * calls) share via the hoisted axios install; @blockrun/llm and the other tools
 * use fetch (which ignores this), so it scopes to Polymarket traffic. Plain
 * HTTPS_PROXY is honored by BOTH axios copies natively (proxy-from-env) without
 * any of this — the simplest option for a US-egress demo.
 */
export function applyClobProxyOnce(): void {
  if (_proxyApplied) return;
  _proxyApplied = true;
  const agent = getClobProxyAgent();
  if (!agent) return;
  axios.defaults.httpsAgent = agent;
  axios.defaults.proxy = false;
}

/**
 * Wallet client that reports `reportAddress` but signs with the real key.
 * See the POLY_1271 note in the file header for why this is sound.
 */
function buildWalletClient(reportAddress?: Hex): WalletClient {
  const real = getPolymarketAccount();
  const account = reportAddress ? { ...real, address: reportAddress } : real;
  return createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYGON_RPC_URLS[0]),
  });
}

/**
 * Cached, authenticated ClobClient for the active signature mode. Requires
 * setup to have persisted the deposit wallet address first in POLY_1271 mode.
 */
export async function getClobClient(): Promise<ClobClient> {
  assertContractConfig();
  applyClobProxyOnce();

  const sigType = getSigType();
  const account = getPolymarketAccount();
  const depositWallet = loadDepositWalletForSigner(account.address) as Hex | undefined;

  if (sigType === 3 && !depositWallet) {
    throw new Error(
      `No Polymarket deposit wallet configured for this signer yet. Run blockrun_polymarket ` +
      `action:"setup" first (or set POLYMARKET_SIG_TYPE=0 for plain EOA mode).`,
    );
  }

  const bindAddress = sigType === 3 ? (depositWallet as Hex) : account.address;
  const cacheKey = `${sigType}:${bindAddress.toLowerCase()}`;
  if (_clobClient && _clobClientKey === cacheKey) return _clobClient;

  let creds = loadL2Creds(bindAddress, sigType);
  if (!creds) {
    const derived = await deriveApiCreds(account, {
      sigType,
      depositWallet: sigType === 3 ? (depositWallet as Hex) : undefined,
    });
    saveL2Creds(bindAddress, sigType, derived);
    creds = loadL2Creds(bindAddress, sigType);
    if (!creds) throw new Error("failed to persist derived Polymarket API credentials");
  }

  const builderCode = getBuilderCode();
  _clobClient = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID,
    signer: buildWalletClient(sigType === 3 ? (depositWallet as Hex) : undefined),
    creds: { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    signatureType: sigType === 3 ? SignatureTypeV2.POLY_1271 : SignatureTypeV2.EOA,
    ...(sigType === 3 ? { funderAddress: depositWallet } : {}),
    ...(builderCode ? { builderConfig: { builderCode } } : {}),
    throwOnError: true,
  });
  _clobClientKey = cacheKey;
  return _clobClient;
}

/** Drop the cached client (after creds invalidation or a sig-type switch). */
export function resetClobClient(): void {
  _clobClient = null;
  _clobClientKey = "";
}

export interface GeoblockStatus {
  orderPlacement: "permitted" | "blocked" | "unknown";
  country: string | null;
  ip: string | null;
  raw: unknown;
}

let _geoCache: { at: number; value: GeoblockStatus } | null = null;

/**
 * Region check for ORDER PLACEMENT. The authoritative signal is the CLOB order
 * endpoint itself: an unauthenticated POST returns 403 ("Trading restricted in
 * your region") when geoblocked, or 401/400 (auth/validation) when NOT — and it
 * routes through POLYMARKET_CLOB_HOST, i.e. the exact egress real orders use.
 *
 * We deliberately do NOT trust polymarket.com/api/geoblock's boolean: it
 * reflects FRONTEND blocking (it returns blocked=true for Japan even though the
 * Japanese API accepts orders — verified: POST /order from a Tokyo egress
 * returns 401, not 403). The /api/geoblock call is kept only for country/ip
 * context. Cached 10 min; fail-open (unknown) on network error so a hiccup never
 * blocks a call that might succeed.
 */
export async function checkGeoblock(): Promise<GeoblockStatus> {
  applyClobProxyOnce();
  if (_geoCache && Date.now() - _geoCache.at < 10 * 60_000) return _geoCache.value;

  let orderPlacement: GeoblockStatus["orderPlacement"] = "unknown";
  try {
    const res = await axios.post(`${CLOB_HOST}/order`, {}, { timeout: 6_000, validateStatus: () => true });
    orderPlacement = res.status === 403 ? "blocked" : "permitted";
  } catch { /* network error → unknown */ }

  let country: string | null = null;
  let ip: string | null = null;
  try {
    const g = await axios.get(GEOBLOCK_URL, { timeout: 3_000 });
    const d = g.data as Record<string, unknown>;
    country = typeof d?.country === "string" ? d.country : null;
    ip = typeof d?.ip === "string" ? d.ip : null;
  } catch { /* context is optional */ }

  const value: GeoblockStatus = { orderPlacement, country, ip, raw: { orderPlacement, country, ip } };
  if (orderPlacement !== "unknown") _geoCache = { at: Date.now(), value };
  return value;
}
