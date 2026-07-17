// src/utils/polymarket/withdraw.ts
//
// Cash out: pUSD in the deposit wallet → native USDC on Base, delivered to the
// BlockRun agent wallet (the same key/address that pays x402 AI fees) — closing
// the loop. Flow (Polymarket bridge):
//   1. POST /withdraw {address, toChainId, toTokenAddress, recipientAddr} → a
//      one-time EVM bridge address.
//   2. Transfer pUSD FROM the deposit wallet TO that bridge address (gasless
//      relayer WALLET batch; or a direct tx in EOA mode). The amount sent IS the
//      withdrawal amount.
//   3. The bridge unwraps pUSD → USDC (Collateral Offramp + Uniswap v3) and
//      sends it to recipientAddr on Base. Instant, no Polymarket fee (minor
//      swap slippage may apply).
import axios from "axios";
import { encodeFunctionData, formatUnits, http, createWalletClient, type Hex } from "viem";
import { polygon } from "viem/chains";
import {
  BASE_CHAIN_ID,
  BASE_USDC,
  BRIDGE_API_HOST,
  COLLATERAL_ONRAMP,
  ERC20_ABI,
  getBuilderCode,
  getSigType,
  POLYGON_RPC_URLS,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
  USDCE_COLLATERAL,
} from "./constants.js";
import { getPolymarketAccount } from "./client.js";
import type { ToolResult } from "./orders.js";
import { mapClobError } from "./orders.js";
import { getFundsAddress } from "./positions.js";
import { sendWalletBatch } from "./relayer.js";
import { getPublicClient } from "./setup.js";

async function rawTokenBalance(token: Hex, owner: Hex): Promise<bigint> {
  return getPublicClient().readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

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

interface WithdrawInput {
  amount_usd?: number;
  to_address?: string;
  confirm?: boolean;
}

export async function withdrawFunds(input: WithdrawInput): Promise<ToolResult> {
  let owner: Hex;
  try {
    owner = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
  const recipient = (input.to_address as Hex) || getPolymarketAccount().address;

  try {
    // Normal adapter redemptions return pUSD. Historic direct CTF redemptions
    // may leave USDC.e instead, so normalize that residue before withdrawing.
    const [pusdRaw, usdceRaw] = await Promise.all([
      rawTokenBalance(PUSD_COLLATERAL as Hex, owner),
      rawTokenBalance(USDCE_COLLATERAL as Hex, owner),
    ]);
    const totalRaw = pusdRaw + usdceRaw;
    const totalUsd = Number(formatUnits(totalRaw, PUSD_DECIMALS));
    if (totalRaw === 0n) {
      return { text: `No pUSD or USDC.e to withdraw — the deposit wallet ${owner} holds $0. (Redeem/sell a position first.)`, isError: true };
    }
    const amountRaw = input.amount_usd !== undefined
      ? BigInt(Math.floor(input.amount_usd * 10 ** PUSD_DECIMALS))
      : totalRaw;
    if (amountRaw > totalRaw) {
      return { text: `Requested $${input.amount_usd} exceeds the withdrawable collateral balance of $${totalUsd.toFixed(2)}.`, isError: true };
    }
    const amountUsd = Number(formatUnits(amountRaw, PUSD_DECIMALS));
    const wrapRaw = amountRaw > pusdRaw ? amountRaw - pusdRaw : 0n;

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing withdrawn.`,
          `Withdraw $${amountUsd.toFixed(2)} pUSD → native USDC on Base`,
          `  from deposit wallet: ${owner}`,
          `  to (agent wallet): ${recipient}`,
          ``,
          ...(wrapRaw > 0n ? [`  First wrap: $${Number(formatUnits(wrapRaw, PUSD_DECIMALS)).toFixed(2)} legacy USDC.e → pUSD`] : []),
          `pUSD is unwrapped to USDC (Uniswap v3 — minor slippage may apply); instant, no Polymarket fee.`,
          `Re-call with confirm:true to execute.`,
        ].join("\n"),
        structured: { dryRun: true, amountUsd, from: owner, to: recipient, toChainId: BASE_CHAIN_ID, toToken: BASE_USDC, pusdUsd: Number(formatUnits(pusdRaw, PUSD_DECIMALS)), usdceUsd: Number(formatUnits(usdceRaw, PUSD_DECIMALS)), wrapUsd: Number(formatUnits(wrapRaw, PUSD_DECIMALS)) },
      };
    }

    // In the deposit-wallet mode approval + wrap are one atomic relayer batch.
    // EOA mode waits for each confirmation before sending pUSD to the bridge.
    if (wrapRaw > 0n) {
      const approve = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [COLLATERAL_ONRAMP as Hex, wrapRaw] });
      const wrap = encodeFunctionData({ abi: COLLATERAL_ONRAMP_ABI, functionName: "wrap", args: [USDCE_COLLATERAL as Hex, owner, wrapRaw] });
      if (getSigType() === 3) {
        await sendWalletBatch([
          { target: USDCE_COLLATERAL, value: "0", data: approve },
          { target: COLLATERAL_ONRAMP, value: "0", data: wrap },
        ], owner, "Wrap legacy USDC.e");
      } else {
        const account = getPolymarketAccount();
        const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URLS[0]) });
        const approveHash = await wallet.sendTransaction({ to: USDCE_COLLATERAL as Hex, data: approve, chain: polygon, account });
        await getPublicClient().waitForTransactionReceipt({ hash: approveHash });
        const wrapHash = await wallet.sendTransaction({ to: COLLATERAL_ONRAMP as Hex, data: wrap, chain: polygon, account });
        await getPublicClient().waitForTransactionReceipt({ hash: wrapHash });
      }
      const normalizedPusd = await rawTokenBalance(PUSD_COLLATERAL as Hex, owner);
      if (normalizedPusd < amountRaw) {
        throw new Error("legacy USDC.e wrap confirmed but the required pUSD balance was not observed; do not retry the withdrawal blindly");
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
      const res = await sendWalletBatch([{ target: PUSD_COLLATERAL, value: "0", data }], owner, "Withdraw");
      txHash = res.transactionHash;
    } else {
      const account = getPolymarketAccount();
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URLS[0]) });
      txHash = await wallet.sendTransaction({ to: PUSD_COLLATERAL as Hex, data, chain: polygon, account });
      await getPublicClient().waitForTransactionReceipt({ hash: txHash as Hex });
    }

    return {
      text: [
        `✅ Withdrawal submitted: $${amountUsd.toFixed(2)} pUSD → USDC on Base`,
        `  to your agent wallet: ${recipient}`,
        ...(txHash ? [`  pUSD transfer tx: https://polygonscan.com/tx/${txHash}`] : []),
        `  The bridge unwraps + delivers USDC to Base (usually within a minute).`,
        `  Track: GET ${BRIDGE_API_HOST}/status/${owner}`,
      ].join("\n"),
      structured: {
        amountUsd, from: owner, to: recipient, toChainId: BASE_CHAIN_ID, toToken: BASE_USDC,
        bridgeAddress: bridgeEvm, transactionHash: txHash,
      },
    };
  } catch (err) {
    return { text: await mapClobError(err), isError: true };
  }
}
