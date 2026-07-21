import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, type Hex } from "viem";
import { buildRedeemCall, didRedeemAnyHeldPosition, heldOutcomeTokens } from "../src/utils/polymarket/redeem.js";
import {
  CTF_COLLATERAL_ADAPTER,
  ERC1155_ABI,
  NEG_RISK_CTF_COLLATERAL_ADAPTER,
} from "../src/utils/polymarket/constants.js";

const CONDITION = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

test("standard redemption targets the V2 CTF collateral adapter", () => {
  const { target, data } = buildRedeemCall(false, CONDITION);
  assert.equal(target.toLowerCase(), CTF_COLLATERAL_ADAPTER.toLowerCase());
  const decoded = decodeFunctionData({ abi: ERC1155_ABI, data });
  assert.equal(decoded.functionName, "redeemPositions");
  assert.equal(decoded.args[2], CONDITION);
});

test("negative-risk redemption targets the V2 negative-risk collateral adapter", () => {
  const { target, data } = buildRedeemCall(true, CONDITION);
  assert.equal(target.toLowerCase(), NEG_RISK_CTF_COLLATERAL_ADAPTER.toLowerCase());
  const decoded = decodeFunctionData({ abi: ERC1155_ABI, data });
  assert.equal(decoded.functionName, "redeemPositions");
  assert.equal(decoded.args[2], CONDITION);
});

test("redeem only reports a verified effect after consuming a held outcome token", () => {
  assert.equal(didRedeemAnyHeldPosition([1_000_000n, 0n], [0n, 0n]), true);
  assert.equal(didRedeemAnyHeldPosition([1_000_000n, 0n], [1_000_000n, 0n]), false);
  assert.equal(didRedeemAnyHeldPosition([0n, 0n], [0n, 0n]), false);
});

test("redeem takes token IDs and neg-risk state from the wallet's Data-API positions", () => {
  const tokens = heldOutcomeTokens([
    { conditionId: "0xother", asset: "111" },
    { conditionId: CONDITION, asset: "222", negativeRisk: false },
  ], CONDITION);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]?.asset, "222");
  assert.equal(heldOutcomeTokens([], CONDITION).length, 0);
});
