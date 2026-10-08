// src/utils/polymarket/withdraw.ts
//
// Cash out: collateral in the deposit wallet → native USDC on Base, delivered
// to the BlockRun agent wallet (the same key/address that pays x402 AI fees) —
// closing the loop. Flow (Polymarket bridge):
//   1. POST /withdraw {address, toChainId, toTokenAddress, recipientAddr} → a
//      one-time EVM bridge address.
//   2. Transfer pUSD FROM the deposit wallet TO that bridge address (gasless
//      relayer WALLET batch; or a direct tx in EOA mode). The amount sent IS the
//      withdrawal amount.
//   3. The bridge unwraps pUSD → USDC (Collateral Offramp + Uniswap v3) and
//      sends it to recipientAddr on Base. Instant, no Polymarket fee (minor
//      swap slippage may apply).
//
// Legacy USDC.e: adapter redemptions pay pUSD, but historic direct-CTF
// redemptions left USDC.e in the wallet, which the bridge does not accept and
// which action:"withdraw" previously could not see at all. Withdrawable
// balance is now pUSD + USDC.e; any shortfall beyond the pUSD on hand is
// wrapped to pUSD through the collateral onramp first (sweep design from
// @KillerQueen-Z's #59/#66, tracked in #71).
import axios from "axios";
import { encodeFunctionData, formatUnits, http, createWalletClient, isAddress, keccak256, type Hex } from "viem";
import { polygon } from "viem/chains";
import {
  BASE_CHAIN_ID,
  BASE_USDC,
  BRIDGE_API_HOST,
  COLLATERAL_ONRAMP,
  ERC20_ABI,
  getBuilderCode,
  getSigType,
  POLYGON_WRITE_RPC_URL,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
  USDCE_COLLATERAL,
} from "./constants.js";
import { getPolymarketAccount } from "./client.js";
import { assertTransactionSucceeded } from "./transactions.js";
import { declinedResult, type SpendGate, type ToolResult } from "./transactions.js";
import { getFundsAddress } from "./positions.js";
import { loadState, saveState } from "./creds.js";
import { getRelayerTransactionState, sendWalletBatch } from "./relayer.js";
import { getPublicClient } from "./setup.js";

async function rawTokenBalance(token: Hex, owner: Hex): Promise<bigint> {
  return getPublicClient().readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

// wrap(_asset, _to, _amount) — verified against the Sourcify exact-match
// source of COLLATERAL_ONRAMP (2026-07-21). Pulls `_amount` of `_asset` from
// the caller (needs the ERC-20 approval batched before it) and mints pUSD to
// `_to`.
const COLLATERAL_ONRAMP_ABI = [{
  type: "function",
  name: "wrap",
  stateMutability: "nonpayable",
  inputs: [
    { name: "_asset", type: "address" },
    { name: "_to", type: "address" },
    { name: "_amount", type: "uint256" },
  ],
  outputs: [],
}] as const;

/** Approve-then-wrap calls for sweeping legacy USDC.e into pUSD. Exported for tests. */
export function buildLegacyWrapCalls(owner: Hex, amount: bigint): Array<{ target: Hex; value: "0"; data: Hex }> {
  return [
    {
      target: USDCE_COLLATERAL as Hex,
      value: "0",
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [COLLATERAL_ONRAMP as Hex, amount] }),
    },
    {
      target: COLLATERAL_ONRAMP as Hex,
      value: "0",
      data: encodeFunctionData({ abi: COLLATERAL_ONRAMP_ABI, functionName: "wrap", args: [USDCE_COLLATERAL as Hex, owner, amount] }),
    },
  ];
}

/**
 * Parse a dollar amount into micro-pUSD without silently changing what the
 * caller asked for. The old `BigInt(Math.floor(usd * 1e6))` truncated float
 * noise downward — `19.99 * 1e6` is 19_989_999.999…, i.e. a cent less than
 * requested. Round to the nearest micro-dollar and reject anything that isn't
 * representable (over-precision, negatives, NaN). Exported for tests.
 */
export function parseUsdAmount(amount: number): bigint | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const scaled = amount * 10 ** PUSD_DECIMALS;
  const rounded = Math.round(scaled);
  // 0.01 micro-dollars separates the two populations cleanly: float noise on a
  // representable amount is ≤ ~1e-4 micro even at $1M (ulp-scale), while a
  // genuine 7th-decimal digit is ≥ 0.1 micro. An absolute 1e-7 bound (the
  // first draft) sat BELOW the noise floor and rejected honest amounts like
  // $1234.56 (noise 2.4e-7); a relative bound sat above real violations.
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || Math.abs(scaled - rounded) > 0.01) {
    return null;
  }
  return BigInt(rounded);
}

/** Re-read pUSD until it reaches `minimum` (post-wrap RPC lag), 3×750ms. */
async function readPusdUntil(owner: Hex, minimum: bigint): Promise<bigint> {
  let observed = 0n;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
    observed = await rawTokenBalance(PUSD_COLLATERAL as Hex, owner);
    if (observed >= minimum) return observed;
  }
  return observed;
}

// RPC rejections that prove a node refused (and so never relayed) a raw
// transaction. "already known" is deliberately absent: it means the node HAS
// the transaction. So is "nonce too low": nonce movement is not evidence about
// which transaction used the nonce — ours may be the one that did.
const DEFINITE_BROADCAST_REJECTION =
  /insufficient funds|intrinsic gas too low|max fee per gas less than block base fee|transaction underpriced|invalid sender/i;

/** True when the node refused the raw transaction outright. Exported for tests. */
export function isDefiniteBroadcastRejection(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const msg = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e);
    if (DEFINITE_BROADCAST_REJECTION.test(msg)) return true;
  }
  return false;
}

/** True unless the RPC positively reports the hash as unknown. Read errors count as known (fail closed). */
async function transactionKnown(hash: Hex): Promise<boolean> {
  try {
    await getPublicClient().getTransaction({ hash });
    return true;
  } catch (err) {
    return !(err instanceof Error && err.name === "TransactionNotFoundError");
  }
}

/** The receipt's status, or null when there is none yet (or it could not be read). */
async function receiptStatus(hash: Hex): Promise<"success" | "reverted" | null> {
  const receipt = await getPublicClient().getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return null;
  return receipt.status === "success" ? "success" : "reverted";
}

type PendingWithdraw = NonNullable<ReturnType<typeof loadState>["pendingWithdraw"]>;

/** The relayer can mine right at the deadline; don't race it. */
const PENDING_GRACE_SECS = 60;

/**
 * What became of an earlier withdrawal: either a `resolution` to report (the
 * caller clears the guard and ends the call), or a `blocked` message while it
 * may still land.
 *
 * Only a receipt resolves an EOA withdrawal. An advanced account nonce plus an
 * RPC that does not know the hash proves nothing — the RPC may lag, or ours
 * may be the transaction that used the nonce — so neither is read as
 * "dropped", and no deadline applies. While unresolved, the same signed bytes
 * are re-broadcast; a fresh signature is never made.
 */
async function resolvePendingWithdraw(pending: PendingWithdraw): Promise<{ resolution?: string; blocked?: string }> {
  const now = Math.floor(Date.now() / 1000);
  const windowOpen = now < pending.deadline + PENDING_GRACE_SECS;
  const id = pending.transactionID;

  if (id.startsWith("eoa:")) {
    const hash = id.slice(4) as Hex;
    const status = await receiptStatus(hash);
    if (status === "success") return { resolution: `The previous withdrawal SETTLED on-chain (tx ${hash}).` };
    if (status === "reverted") return { resolution: `The previous withdrawal REVERTED on-chain (tx ${hash}); no pUSD moved.` };
    if (pending.serializedTransaction) {
      const account = getPolymarketAccount();
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
      await wallet.sendRawTransaction({ serializedTransaction: pending.serializedTransaction as Hex }).catch(() => undefined);
      return {
        blocked: `A previous withdrawal (tx ${hash}${pending.nonce !== undefined ? `, nonce ${pending.nonce}` : ""}) has no ` +
          `receipt yet and may still land — it was re-broadcast as the SAME signed transaction, so it can execute at ` +
          `most once. Signing another one now could double-send. Do not retry; check again in a few minutes. ` +
          `(If Polygonscan shows that nonce was used by a different transaction, this one can never execute and the ` +
          `user can remove "pendingWithdraw" from ~/.blockrun/.polymarket.json.)`,
      };
    }
    // Recorded by an earlier version, without the signed bytes: nothing to
    // re-broadcast. Block while the node still knows the transaction or the
    // old window is open; after that, report it as unknown rather than safe.
    if (windowOpen || (await transactionKnown(hash))) {
      return {
        blocked: `A previous withdrawal (tx ${hash}) has no receipt yet and may still land. Signing another one now ` +
          `could double-send. Do not retry; check again in a few minutes.`,
      };
    }
    return {
      resolution: `The previous withdrawal (tx ${hash}) never produced a receipt and the RPC no longer knows it. ` +
        `It most likely did not execute, but that is not proven.`,
    };
  }

  if (id === "eoa" || id === "unknown") {
    // No hash and no relayer id: the send never answered (bare "eoa", from an
    // earlier version) or the relayer's response was lost ("unknown", see
    // relayer.ts sendWalletBatch). There is nothing to look up.
    if (windowOpen) {
      const waitSecs = pending.deadline + PENDING_GRACE_SECS - now;
      return {
        blocked: `A previous withdrawal (${id === "unknown" ? "relayer tx unknown — the submit response was lost" : "EOA transfer, send never answered"}) ` +
          `may still execute for up to ~${waitSecs}s more. Signing another one now could double-send. Re-run after ` +
          `that window, when the balance reads will show what happened.`,
      };
    }
    return {
      resolution: `The previous withdrawal's outcome was never confirmed and its window has passed. ` +
        `It may or may not have executed.`,
    };
  }

  const state = await getRelayerTransactionState(id);
  if (state === "STATE_MINED" || state === "STATE_CONFIRMED") {
    return { resolution: `The previous withdrawal SETTLED (relayer tx ${id}, ${state}).` };
  }
  if (state === "STATE_FAILED" || state === "STATE_INVALID") {
    return { resolution: `The previous withdrawal FAILED (relayer tx ${id}, ${state}); no pUSD moved.` };
  }
  if (windowOpen) {
    const waitSecs = pending.deadline + PENDING_GRACE_SECS - now;
    return {
      blocked: `A previous withdrawal (relayer tx ${id}, state: ${state ?? "unreachable"}) may still execute — its ` +
        `signed transfer stays valid for up to ~${waitSecs}s more. Signing another one now could double-send. ` +
        `Re-run after that window, when the balance reads will show what happened.`,
    };
  }
  // Deadline long past: the batch can no longer execute, but it may already
  // have, so this is not proof that nothing moved.
  return {
    resolution: `The previous withdrawal's signature expired (relayer tx ${id}, state: ${state ?? "unreachable"}). ` +
      `It may or may not have executed before its deadline.`,
  };
}

function eoaOutcomeUnknown(txHash: string, msg: string): Error {
  return new Error(
    `Withdraw: the pUSD transfer (tx ${txHash}) did not confirm (${msg}). It may still land — a broadcast ` +
      `transaction is not un-sent by a client timeout. Do NOT start a new withdrawal: calling withdraw again ` +
      `re-broadcasts this same signed transaction and reports its outcome; it never signs a second one.`,
  );
}

const WITHDRAW_GUIDANCE =
  'check the pUSD balance with action:"setup" and the bridge status endpoint before ANY retry — ' +
  "a resubmitted withdrawal signs a SECOND transfer and can double-send";

interface WithdrawInput {
  amount_usd?: number;
  to_address?: string;
  confirm?: boolean;
  /** See orders.ts SpendGate. Supplied by the tool handler. */
  askUser?: SpendGate;
}

export async function withdrawFunds(input: WithdrawInput): Promise<ToolResult> {
  let owner: Hex;
  try {
    owner = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
  // The destination is forwarded to the bridge as `recipientAddr` and the USDC
  // lands wherever it says — irreversibly. Validate BEFORE any I/O: strict
  // isAddress rejects non-addresses and mixed-case strings whose EIP-55
  // checksum does not match (the transposition-typo shape); all-lowercase input
  // carries no checksum and is accepted as-is.
  if (input.to_address !== undefined && !isAddress(input.to_address, { strict: true })) {
    return {
      text: `to_address must be a valid 0x… Base address (40 hex chars; if mixed-case, the checksum must match). ` +
        `Got ${JSON.stringify(input.to_address)}. Nothing withdrawn.`,
      isError: true,
    };
  }
  const agent = getPolymarketAccount().address;
  const recipient = (input.to_address as Hex | undefined) ?? agent;
  // The dry-run is the one human checkpoint before the transfer. Label the
  // destination from what it IS, not from where the default would have gone:
  // a caller-supplied third-party address used to print as "agent wallet".
  const isCustom = recipient.toLowerCase() !== agent.toLowerCase();

  try {
    // Refuse to sign while an earlier withdrawal may still land: a second
    // signed transfer on top of it double-sends (issue #72 finding 1).
    //
    // Resolving the earlier withdrawal ENDS this call. The retry that finds
    // the first transfer settled is the same call that would otherwise sign a
    // second one on top of it — the double-send this guard exists to stop. The
    // outcome is reported and the guard cleared; another withdrawal needs a
    // fresh, deliberate call made after the balances have been looked at.
    const pending = loadState().pendingWithdraw;
    if (pending && input.confirm === true) {
      const resolved = await resolvePendingWithdraw(pending);
      if (resolved.blocked) return { text: resolved.blocked, isError: true };
      saveState({ pendingWithdraw: undefined });
      return {
        text: `${resolved.resolution} Nothing new was signed. Check the balances (action:"setup") and the bridge ` +
          `status before deciding whether ANOTHER withdrawal is wanted; only then call withdraw again.`,
        isError: true,
        structured: { previousWithdrawal: resolved.resolution },
      };
    }

    // Withdrawable = pUSD + legacy USDC.e (wrapped on demand below).
    const [pusdRaw, usdceRaw] = await Promise.all([
      rawTokenBalance(PUSD_COLLATERAL as Hex, owner),
      rawTokenBalance(USDCE_COLLATERAL as Hex, owner),
    ]);
    const totalRaw = pusdRaw + usdceRaw;
    const totalUsd = Number(formatUnits(totalRaw, PUSD_DECIMALS));
    if (totalRaw === 0n) {
      return { text: `No pUSD or USDC.e to withdraw — the deposit wallet ${owner} holds $0. (Redeem/sell a position first.)`, isError: true };
    }
    const amountRaw = input.amount_usd !== undefined ? parseUsdAmount(input.amount_usd) : totalRaw;
    if (amountRaw === null) {
      return { text: `amount_usd must be a positive USD amount with at most ${PUSD_DECIMALS} decimal places.`, isError: true };
    }
    if (amountRaw > totalRaw) {
      return { text: `Requested $${input.amount_usd} exceeds the withdrawable collateral balance of $${totalUsd.toFixed(2)}.`, isError: true };
    }
    const amountUsd = Number(formatUnits(amountRaw, PUSD_DECIMALS));
    const wrapRaw = amountRaw > pusdRaw ? amountRaw - pusdRaw : 0n;

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing withdrawn.`,
          `Withdraw $${amountUsd.toFixed(2)} → native USDC on Base`,
          `  from deposit wallet: ${owner}`,
          `  to: ${recipient}${isCustom ? "  ⚠️ CUSTOM destination — NOT your agent wallet" : "  (your agent wallet)"}`,
          ...(wrapRaw > 0n
            ? [``, `  First wrap: $${Number(formatUnits(wrapRaw, PUSD_DECIMALS)).toFixed(2)} legacy USDC.e → pUSD (collateral onramp, same wallet)`]
            : []),
          ``,
          `pUSD is unwrapped to USDC (Uniswap v3 — minor slippage may apply); instant, no Polymarket fee.`,
          `Re-call with confirm:true to execute.`,
        ].join("\n"),
        structured: {
          dryRun: true, amountUsd, from: owner, to: recipient, toChainId: BASE_CHAIN_ID, toToken: BASE_USDC,
          pusdUsd: Number(formatUnits(pusdRaw, PUSD_DECIMALS)),
          usdceUsd: Number(formatUnits(usdceRaw, PUSD_DECIMALS)),
          wrapUsd: Number(formatUnits(wrapRaw, PUSD_DECIMALS)),
        },
      };
    }

    // The user's word before anything is signed, when the operator asked for
    // it (BLOCKRUN_CONFIRM_SPEND=on). The amount is the one that will move —
    // the full balance when amount_usd was omitted — and the label carries the
    // destination, since a custom to_address is the irreversible part.
    if (input.askUser) {
      const gate = await input.askUser(amountUsd, `polymarket · withdraw $${amountUsd.toFixed(2)} → ${recipient}${isCustom ? " (CUSTOM address)" : " (your agent wallet)"}`);
      if (!gate.ok) return declinedResult(`the $${amountUsd.toFixed(2)} withdrawal`);
    }

    // 0. Sweep legacy USDC.e → pUSD when the pUSD on hand can't cover the
    //    amount. Wrapping keeps funds in the SAME wallet (a re-run after a
    //    partial failure is safe), so this batch is not double-spend-tracked.
    if (wrapRaw > 0n) {
      const [approveCall, wrapCall] = buildLegacyWrapCalls(owner, wrapRaw);
      if (getSigType() === 3) {
        await sendWalletBatch([approveCall, wrapCall], owner, "Wrap legacy USDC.e", {
          guidance: 're-run action:"withdraw" — wrapping keeps funds in your wallet, so retrying is safe',
        });
      } else {
        const account = getPolymarketAccount();
        const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
        const approveHash = await wallet.sendTransaction({ to: approveCall.target, data: approveCall.data, chain: polygon, account });
        assertTransactionSucceeded(await getPublicClient().waitForTransactionReceipt({ hash: approveHash }), "USDC.e approval", approveHash);
        const wrapHash = await wallet.sendTransaction({ to: wrapCall.target, data: wrapCall.data, chain: polygon, account });
        assertTransactionSucceeded(await getPublicClient().waitForTransactionReceipt({ hash: wrapHash }), "USDC.e wrap", wrapHash);
      }
      const normalizedPusd = await readPusdUntil(owner, amountRaw);
      if (normalizedPusd < amountRaw) {
        throw new Error(
          "The USDC.e wrap confirmed but the required pUSD balance is not yet visible after 3 reads. " +
          "Your funds are in your wallet (wrapping moves nothing out) — re-run action:\"withdraw\" in a minute.",
        );
      }
    }

    // 1. Ask the bridge for a one-time deposit address for this withdrawal.
    const headers: Record<string, string> = { "content-type": "application/json" };
    const builderCode = getBuilderCode();
    if (builderCode) headers["X-Builder-Code"] = builderCode;
    const wres = await axios.post(
      `${BRIDGE_API_HOST}/withdraw`,
      { address: owner, toChainId: String(BASE_CHAIN_ID), toTokenAddress: BASE_USDC, recipientAddr: recipient },
      { headers, timeout: 20_000 },
    );
    const bridgeEvm = (wres.data as { address?: { evm?: string } })?.address?.evm as Hex | undefined;
    if (!bridgeEvm) {
      return { text: `Bridge did not return a withdrawal address (got: ${JSON.stringify(wres.data)}).`, isError: true };
    }

    // 2. Transfer pUSD from the deposit wallet to the bridge address.
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [bridgeEvm, amountRaw] });
    let txHash: string | undefined;
    if (getSigType() === 3) {
      const res = await sendWalletBatch([{ target: PUSD_COLLATERAL, value: "0", data }], owner, "Withdraw", {
        guidance: WITHDRAW_GUIDANCE,
        trackPendingWithdraw: true,
      });
      txHash = res.transactionHash;
    } else {
      const account = getPolymarketAccount();
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
      // The same double-send guard the relayer path keeps, armed before the
      // broadcast: a send that never answers may still have reached the node.
      // The transaction is signed locally first so the record carries its
      // hash and exact bytes — a retry re-broadcasts THESE bytes (same nonce,
      // so at most one transfer can execute) instead of signing a second one.
      // `deadline` is recorded for the shape only; a plain transaction has none.
      // The nonce comes from the WRITE endpoint (prepareTransactionRequest
      // asks the wallet's own transport), not the public reader, which can be
      // a separate provider with its own pending pool. A load-balanced write
      // URL can still answer from a different backend than the broadcast;
      // safety does not rest on this — the bytes are persisted first and a
      // retry re-sends only those.
      const request = await wallet.prepareTransactionRequest({ to: PUSD_COLLATERAL as Hex, data, chain: polygon, account });
      const nonce = request.nonce;
      const serializedTransaction = await wallet.signTransaction(request);
      txHash = keccak256(serializedTransaction);
      saveState({
        pendingWithdraw: { transactionID: `eoa:${txHash}`, deadline: Math.floor(Date.now() / 1000), nonce, serializedTransaction },
      });
      try {
        await wallet.sendRawTransaction({ serializedTransaction });
      } catch (err) {
        // Only a node that refused these bytes outright never relayed them,
        // so only that case releases the guard — and only if the RPC does not
        // know the hash anyway. A timeout or a 5xx keeps it.
        const msg = err instanceof Error ? err.message : String(err);
        if (isDefiniteBroadcastRejection(err) && !(await transactionKnown(txHash as Hex))) {
          saveState({ pendingWithdraw: undefined });
          throw new Error(`Withdraw: the node rejected the pUSD transfer (${msg}). Nothing was sent.`);
        }
        throw eoaOutcomeUnknown(txHash, msg);
      }
      try {
        // viem does NOT throw on a reverted tx — it resolves with status:"reverted".
        // Discarding the receipt meant a REVERTED pUSD transfer still printed
        // "✅ Withdrawal submitted … the bridge delivers USDC to Base" with a link
        // to the failed tx and no isError, so the user waited for money that was
        // never sent and blamed the bridge. redeem.ts and setup.ts both assert
        // status; this path was the one that did not.
        const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash as Hex });
        saveState({ pendingWithdraw: undefined });
        assertTransactionSucceeded(receipt, "pUSD transfer", txHash);
      } catch (err) {
        if (err instanceof Error && /reverted/i.test(err.message)) throw err; // a receipt was read: definite
        throw eoaOutcomeUnknown(txHash, err instanceof Error ? err.message : String(err));
      }
    }

    return {
      text: [
        `✅ Withdrawal submitted: $${amountUsd.toFixed(2)} → USDC on Base`,
        ...(wrapRaw > 0n ? [`  (included wrapping $${Number(formatUnits(wrapRaw, PUSD_DECIMALS)).toFixed(2)} legacy USDC.e → pUSD first)`] : []),
        `  to ${isCustom ? "CUSTOM address (not your agent wallet)" : "your agent wallet"}: ${recipient}`,
        ...(txHash ? [`  pUSD transfer tx: https://polygonscan.com/tx/${txHash}`] : []),
        `  The bridge unwraps + delivers USDC to Base (usually within a minute).`,
        `  Track: GET ${BRIDGE_API_HOST}/status/${owner}`,
      ].join("\n"),
      structured: {
        amountUsd, from: owner, to: recipient, toChainId: BASE_CHAIN_ID, toToken: BASE_USDC,
        bridgeAddress: bridgeEvm, transactionHash: txHash,
        ...(wrapRaw > 0n ? { wrappedUsdceUsd: Number(formatUnits(wrapRaw, PUSD_DECIMALS)) } : {}),
      },
    };
  } catch (err) {
    // No CLOB call happens anywhere in this function, so mapClobError's
    // taxonomy does not apply: a bridge 403 used to come back as "point
    // POLYMARKET_CLOB_HOST + POLYMARKET_RELAYER_URL at a permitted-region
    // relay" (the relay does not serve the bridge) and any transport message
    // containing "closed" as "market resolved, go redeem". Report the bridge
    // as the bridge; pass everything else through verbatim — the relayer's
    // anti-retry wording (sendWalletBatch) must reach the user unchanged.
    return { text: describeWithdrawError(err), isError: true };
  }
}

/** Plain, source-honest error text for the withdraw path. Exported for tests. */
export function describeWithdrawError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const e = err as { isAxiosError?: boolean; response?: { status?: number; data?: unknown } };
  if (e?.isAxiosError === true) {
    const status = e.response?.status;
    const data = e.response?.data !== undefined ? ` — ${typeof e.response.data === "string" ? e.response.data : JSON.stringify(e.response.data)}` : "";
    return `Polymarket bridge request failed (POST ${BRIDGE_API_HOST}/withdraw${status ? `, HTTP ${status}` : ""}): ${message}${data}. ` +
      `Nothing was transferred — the pUSD move only happens after the bridge answers. This is the BRIDGE host ` +
      `(POLYMARKET_BRIDGE_HOST), not the CLOB/relayer egress; check the bridge status, then retry.`;
  }
  return message;
}
