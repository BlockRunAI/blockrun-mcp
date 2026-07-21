// Pins the money-critical part of the redeem path: which contract we call and
// what calldata we send. Regression test for the "success + tx hash but
// REDEEM size=0" bug: redeeming through the CTF (or the legacy NegRiskAdapter)
// with pUSD collateral computes a positionId nobody holds and silently burns
// nothing — the ONLY correct targets in the pUSD era are the two collateral
// adapters, which pull the caller's real outcome tokens and pay out pUSD.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, type Hex } from "viem";
import { buildRedeemCall, didRedeemAnyHeldPosition } from "../src/utils/polymarket/redeem.js";
import { assertTransactionSucceeded } from "../src/utils/polymarket/transactions.js";
import {
  CONDITIONAL_TOKENS,
  CTF_COLLATERAL_ADAPTER,
  ERC1155_ABI,
  NEG_RISK_ADAPTER,
  NEG_RISK_CTF_COLLATERAL_ADAPTER,
  PUSD_COLLATERAL,
} from "../src/utils/polymarket/constants.js";

const CONDITION_ID = "0x1fb90afceb91eb91255088d674e7f3530b83464762f9759a3073191746971cf5" as Hex;

// Literal addresses on purpose (NOT the constants the implementation imports):
// these are the on-chain-verified adapters from
// https://docs.polymarket.com/resources/contracts — pinning them here means a
// corrupted constant fails the test instead of silently receiving approvals.
test("standard redeem targets the CtfCollateralAdapter, never the CTF", () => {
  const { target } = buildRedeemCall(false, CONDITION_ID);
  assert.equal(target, "0xAdA100Db00Ca00073811820692005400218FcE1f");
  assert.equal(target, CTF_COLLATERAL_ADAPTER);
  assert.notEqual(target.toLowerCase(), CONDITIONAL_TOKENS.toLowerCase());
});

test("neg-risk redeem targets the NegRiskCtfCollateralAdapter, never the legacy adapter", () => {
  const { target } = buildRedeemCall(true, CONDITION_ID);
  assert.equal(target, "0xadA2005600Dec949baf300f4C6120000bDB6eAab");
  assert.equal(target, NEG_RISK_CTF_COLLATERAL_ADAPTER);
  assert.notEqual(target.toLowerCase(), NEG_RISK_ADAPTER.toLowerCase());
});

test("redeem calldata is the CTF-mirror redeemPositions with the conditionId", () => {
  for (const negRisk of [false, true]) {
    const { data } = buildRedeemCall(negRisk, CONDITION_ID);
    const decoded = decodeFunctionData({ abi: ERC1155_ABI, data });
    assert.equal(decoded.functionName, "redeemPositions");
    const [collateral, parent, conditionId, indexSets] = decoded.args as readonly [Hex, Hex, Hex, readonly bigint[]];
    assert.equal(collateral.toLowerCase(), PUSD_COLLATERAL.toLowerCase());
    assert.equal(parent, "0x" + "0".repeat(64));
    assert.equal(conditionId, CONDITION_ID);
    assert.deepEqual([...indexSets], [1n, 2n]);
  }
});

// A transaction hash is not proof of redemption. Redeeming through the wrong
// collateral path burns a positionId nobody holds, which SUCCEEDS on-chain
// having done nothing — CTF redeemPositions never reverts on a zero balance.
// That is the "REDEEM size=0" class. Only a DECREASE in a balance that was
// non-zero before proves a position was actually consumed.
test("didRedeemAnyHeldPosition: a real burn counts", () => {
  assert.equal(didRedeemAnyHeldPosition([1_000_000n, 0n], [0n, 0n]), true);
  assert.equal(didRedeemAnyHeldPosition([1_000_000n, 500n], [1_000_000n, 0n]), true, "any held position decreasing counts");
});

test("didRedeemAnyHeldPosition: an unchanged balance is NOT a redemption", () => {
  assert.equal(didRedeemAnyHeldPosition([1_000_000n, 0n], [1_000_000n, 0n]), false);
});

test("didRedeemAnyHeldPosition: holding nothing can never look redeemed", () => {
  assert.equal(didRedeemAnyHeldPosition([0n, 0n], [0n, 0n]), false);
  // A balance going UP is not a redemption either.
  assert.equal(didRedeemAnyHeldPosition([0n, 0n], [5n, 5n]), false);
});

// Conservative on a short read: a missing `after` entry must read as unchanged,
// never as burned, so a truncated RPC response cannot fake success.
test("didRedeemAnyHeldPosition: a truncated after-array cannot fake success", () => {
  assert.equal(didRedeemAnyHeldPosition([1_000_000n, 1_000_000n], []), false);
  assert.equal(didRedeemAnyHeldPosition([1_000_000n, 1_000_000n], [1_000_000n]), false);
});

// viem resolves waitForTransactionReceipt for reverted transactions too, so
// awaiting it proves the tx was MINED, not that it did anything.
test("assertTransactionSucceeded throws on a reverted receipt", () => {
  assert.throws(() => assertTransactionSucceeded({ status: "reverted" }, "redeem transaction", "0xabc"), /reverted on-chain/);
  assert.throws(() => assertTransactionSucceeded({}, "redeem transaction"), /reverted on-chain/);
});

test("assertTransactionSucceeded passes a successful receipt", () => {
  assert.doesNotThrow(() => assertTransactionSucceeded({ status: "success" }, "redeem transaction"));
});
