// src/utils/polymarket/relayer.ts
//
// Thin wrapper over @polymarket/builder-relayer-client for the deposit-wallet
// lifecycle: derive (CREATE2, pre-deploy), deploy (WALLET-CREATE), and signed
// WALLET batches (approvals, redeem). Everything here is GASLESS — the relayer
// sponsors gas. It is a courier, not a custodian: it only ever receives
// EIP-712 payloads signed by the local key, which it can neither alter (the
// signature covers every byte) nor replay (nonce + deadline).
//
// The relayer authenticates via a Builder API key the MCP bootstraps from the
// wallet key itself (getOrCreateBuilderCreds below) — no Polymarket account or
// manually-obtained credentials needed.
import { RelayClient, type DepositWalletCall } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { getClobProxyAgent, getPolymarketAccount, installUnderscoreHeaderBridge } from "./client.js";
import { CLOB_HOST, POLYGON_CHAIN_ID, POLYGON_WRITE_RPC_URL, RELAYER_URL } from "./constants.js";
import { loadBuilderCreds, loadL2Creds, saveBuilderCreds, saveL2Creds, saveState } from "./creds.js";
import { deriveApiCreds } from "./l1-auth-1271.js";
import { isDefiniteRejection } from "./transactions.js";

export type { DepositWalletCall };

let _relayClient: RelayClient | null = null;

// --- stdout discipline ---
//
// The relayer SDK console.logs progress ("Waiting for transaction …",
// "Executing … transactions", "… timing out!") from pollUntilState and the
// batch builders. In the stdio MCP server stdout IS the JSON-RPC channel, so
// every deploy, approval, redeem and withdraw batch injected a non-JSON line
// into the protocol stream, mid-money-operation. The TS SDK client survives
// (it reports the bad line via onerror); a stricter client drops the
// connection and the user never receives the result text — the tx hash or the
// anti-retry guidance. Every SDK call below runs inside quietStdout, which
// points console.log/info at stderr (the MCP log channel) for its duration.
// Ref-counted: tool calls are dispatched concurrently, and two overlapping
// batches must not leave a swapped console behind when the first finishes.
let quietDepth = 0;
let savedLog: typeof console.log | null = null;
let savedInfo: typeof console.info | null = null;

async function quietStdout<T>(fn: () => Promise<T>): Promise<T> {
  if (quietDepth++ === 0) {
    savedLog = console.log;
    savedInfo = console.info;
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);
  }
  try {
    return await fn();
  } finally {
    if (--quietDepth === 0) {
      if (savedLog) console.log = savedLog;
      if (savedInfo) console.info = savedInfo;
      savedLog = null;
      savedInfo = null;
    }
  }
}

/**
 * The relayer SDK builds its OWN axios instance (`httpClient.instance`,
 * axios 0.27), so neither the underscore-header bridge nor the
 * POLYMARKET_CLOB_PROXY agent installed on the hoisted axios in client.ts ever
 * reached relayer traffic — while the 403 advice and deploy.sh told operators
 * to point POLYMARKET_RELAYER_URL at the Caddy relay, whose /relayer/* route
 * reconstructs POLY_BUILDER_* from the hyphenated copies the client never
 * sent. Install both here, on that instance, right after construction. The
 * bridge is harmless direct (Polymarket reads the underscore header and
 * ignores the copy); the agent only applies when the operator set a proxy.
 */
function bridgeRelayerTransport(client: RelayClient): void {
  const instance = (client as unknown as { httpClient?: { instance?: {
    interceptors?: { request?: { use?: (fn: (config: unknown) => unknown) => void } };
    defaults?: { httpsAgent?: unknown; proxy?: unknown };
  } } }).httpClient?.instance;
  if (!instance?.interceptors?.request?.use || !instance.defaults) {
    // SDK shape drifted: say so on stderr rather than fail the money path —
    // direct relayer traffic still works; only a relayed/proxied setup would not.
    console.error("[BlockRun] relayer SDK exposes no axios instance — header bridge / POLYMARKET_CLOB_PROXY not applied to relayer traffic");
    return;
  }
  installUnderscoreHeaderBridge(instance as never);
  const agent = getClobProxyAgent();
  if (agent) {
    instance.defaults.httpsAgent = agent;
    instance.defaults.proxy = false;
  }
}

/**
 * Programmatically obtain Builder API credentials (key/secret/passphrase) for
 * the local wallet — created via the CLOB createBuilderApiKey() (L2-authed),
 * cached on disk (the secret is only returned once). This replaces the manual
 * "get a relayer API key from polymarket.com" step: the relayer authenticates
 * via the builder-HMAC path, and because the builder == the deposit-wallet
 * owner (this wallet), the relayer's from==owner check is satisfied.
 */
async function getOrCreateBuilderCreds(): Promise<{ key: string; secret: string; passphrase: string }> {
  const account = getPolymarketAccount();
  const cached = loadBuilderCreds(account.address);
  if (cached) return { key: cached.key, secret: cached.secret, passphrase: cached.passphrase };

  // Plain EOA CLOB L2 creds (sig type 0) — needed to authenticate the builder-key
  // creation. Cached like any L2 creds.
  let l2 = loadL2Creds(account.address, 0);
  if (!l2) {
    const derived = await deriveApiCreds(account, { sigType: 0 });
    saveL2Creds(account.address, 0, derived);
    l2 = loadL2Creds(account.address, 0);
    if (!l2) throw new Error("failed to derive CLOB credentials for builder-key creation");
  }

  const wc = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
  const clob = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID,
    signer: wc,
    creds: { key: l2.key, secret: l2.secret, passphrase: l2.passphrase },
    throwOnError: true,
  });
  const builder = (await clob.createBuilderApiKey()) as { key: string; secret: string; passphrase: string };
  if (!builder?.key || !builder?.secret || !builder?.passphrase) {
    throw new Error(`createBuilderApiKey did not return complete credentials (${JSON.stringify(Object.keys(builder ?? {}))})`);
  }
  saveBuilderCreds(account.address, builder);
  return builder;
}

/**
 * RelayClient bound to the REAL account address (the deposit-wallet owner), with
 * builder-HMAC auth from bootstrapped Builder API creds. Async because the first
 * call may create the builder key. The relayer is not geoblocked → direct.
 */
export async function getRelayClient(): Promise<RelayClient> {
  if (_relayClient) return _relayClient;
  const walletClient = createWalletClient({
    account: getPolymarketAccount(),
    chain: polygon,
    transport: http(POLYGON_WRITE_RPC_URL),
  });
  const builderCreds = await getOrCreateBuilderCreds();
  const builderConfig = new BuilderConfig({ localBuilderCreds: builderCreds });
  const client = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, walletClient, builderConfig);
  bridgeRelayerTransport(client);
  _relayClient = client;
  return _relayClient;
}

/** CREATE2-derived deposit wallet address for the local key (pre-deploy safe). */
export async function deriveDepositWallet(): Promise<Hex> {
  const addr = await (await getRelayClient()).deriveDepositWalletAddress();
  return addr as Hex;
}

export async function isDepositWalletDeployed(address: string): Promise<boolean> {
  return (await getRelayClient()).getDeployed(address, "WALLET");
}

/**
 * Deploy the deposit wallet (idempotence guarded by the caller via
 * isDepositWalletDeployed). Waits for on-chain confirmation; throws with the
 * relayer transaction id on failure/timeout so the user can re-run setup.
 */
export async function deployDepositWallet(): Promise<{ transactionHash?: string }> {
  const relay = await getRelayClient();
  const { response, confirmed } = await quietStdout(async () => {
    const response = await relay.deployDepositWallet();
    return { response, confirmed: await response.wait() };
  });
  if (!confirmed) {
    throw new Error(
      `Deposit wallet deployment did not confirm (relayer tx ${response.transactionID}). ` +
      `It may still be pending — re-run action:"setup" in a minute.`,
    );
  }
  return { transactionHash: confirmed.transactionHash };
}

/** How long a signed batch stays executable by the relayer, in seconds. */
export const BATCH_DEADLINE_SECS = 300;

/** Terminal relayer states — the batch can no longer land after these. */
const TERMINAL_FAILURE_STATES = ["STATE_FAILED", "STATE_INVALID"];

/** Current relayer-side state of a submitted batch, or undefined if unreachable. */
export async function getRelayerTransactionState(transactionID: string): Promise<string | undefined> {
  try {
    const relay = await getRelayClient();
    const txns = await quietStdout(() => relay.getTransaction(transactionID));
    return txns?.[0]?.state;
  } catch {
    return undefined;
  }
}

/**
 * Execute a signed WALLET batch from the deposit wallet (approvals, redeem…).
 * The SDK fetches the nonce, EIP-712-signs the Batch with the local key, and
 * submits; we wait for confirmation.
 *
 * `wait()` returns undefined for BOTH an on-chain failure and a poll timeout
 * (100×2s < the 300s signature deadline), and those need OPPOSITE advice: a
 * failed batch is safe to retry, a timed-out one is NOT — its signature stays
 * executable until the deadline, so re-signing a money movement can
 * double-execute (the withdraw double-spend window from issue #72). On
 * undefined we ask the relayer which case it is and say so explicitly.
 *
 * opts.guidance replaces the generic "re-run setup" advice with per-operation
 * instructions. opts.trackPendingWithdraw persists the in-flight batch to the
 * state file so withdraw can refuse to sign a second transfer while the first
 * may still land (cleared on confirmation or terminal failure).
 */
export async function sendWalletBatch(
  calls: DepositWalletCall[],
  depositWallet: string,
  description: string,
  opts?: { guidance?: string; trackPendingWithdraw?: boolean },
): Promise<{ transactionHash?: string }> {
  const deadlineSec = Math.floor(Date.now() / 1000) + BATCH_DEADLINE_SECS;
  let response: Awaited<ReturnType<RelayClient["executeDepositWalletBatch"]>>;
  // Getting the client is NOT part of the send. getRelayClient derives CLOB
  // credentials and creates a builder key — real network calls that happen
  // before the RelayClient exists, so they cannot have signed or posted the
  // batch. Leaving them inside the try armed the double-send guard for a
  // failure that provably moved nothing, wedging the user behind a deadline
  // for a transfer that was never signed.
  const relay = await getRelayClient();
  try {
    response = await quietStdout(() => relay.executeDepositWalletBatch(calls, depositWallet, String(deadlineSec)));
  } catch (err) {
    // The SDK signs, THEN posts. A lost response (proxy 502/504, reset — the
    // SDK surfaces these as `{"error":"connection error"}` or a 5xx "request
    // error") leaves the signature executable until deadlineSec with nothing
    // on disk to say so, and the old error text invited an immediate retry —
    // the #72.1 double-send on the submit side. Only a definite 4xx proves the
    // relayer accepted nothing. Pre-sign failures (signer/config/nonce) are
    // 4xx-free too but cannot have signed anything; we cannot tell them apart
    // from a lost post here, so the conservative side wins for tracked
    // (money-moving) batches: arm the guard, say so, and let the deadline
    // clear it (withdraw.ts). Untracked batches (approvals, wrap) are safe to
    // retry and rethrow as before.
    const message = err instanceof Error ? err.message : String(err);
    // The CLOB SDK's ApiError carries its code on a `.status` PROPERTY and
    // leaves the message as the bare error string, so matching only the JSON
    // shape missed every definite 4xx it raises — the guard armed on rejections
    // that were unambiguous. isDefiniteRejection reads the property first,
    // then the shapes that only appear in text (shared with the order submit).
    if (opts?.trackPendingWithdraw && !isDefiniteRejection(err)) {
      saveState({ pendingWithdraw: { transactionID: "unknown", deadline: deadlineSec } });
      throw new Error(
        `${description}: the relayer returned no transaction id (${message}). It may still have ACCEPTED the ` +
        `signed batch — a transfer may already be in flight, and the signature stays executable for ` +
        `${BATCH_DEADLINE_SECS / 60} minutes. Do NOT retry yet: wait for that deadline to pass, then ` +
        `${opts?.guidance ?? 're-run action:"setup" to re-check state'}.`,
      );
    }
    throw err;
  }
  if (opts?.trackPendingWithdraw) {
    saveState({ pendingWithdraw: { transactionID: response.transactionID, deadline: deadlineSec } });
  }
  const confirmed = await quietStdout(() => response.wait());
  if (!confirmed) {
    const state = await getRelayerTransactionState(response.transactionID);
    if (state && TERMINAL_FAILURE_STATES.includes(state)) {
      if (opts?.trackPendingWithdraw) saveState({ pendingWithdraw: undefined });
      // "failed" must appear here so callers' revert-hint regexes (e.g.
      // redeem's missing-approval hint) fire on it. Safe to retry.
      throw new Error(
        `${description}: relayer batch failed on-chain (tx ${response.transactionID}). ` +
        `${opts?.guidance ?? 'Re-run action:"setup" to check state and retry.'}`,
      );
    }
    // Unknown or still-pending: the signed batch may STILL land. Deliberately
    // no "failed"/"revert" wording (this is not a revert), and deliberately
    // anti-retry advice — pendingWithdraw stays persisted when tracked.
    throw new Error(
      `${description}: relayer batch did not confirm within the polling window ` +
      `(tx ${response.transactionID}, relayer state: ${state ?? "unreachable"}). It may still land — the signed ` +
      `batch stays executable until its ${BATCH_DEADLINE_SECS / 60}-minute deadline. Do NOT retry yet: wait for ` +
      `the deadline to pass, then ${opts?.guidance ?? 're-run action:"setup" to re-check state'}.`,
    );
  }
  if (opts?.trackPendingWithdraw) saveState({ pendingWithdraw: undefined });
  return { transactionHash: confirmed.transactionHash };
}
