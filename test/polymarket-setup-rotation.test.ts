// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Pins runSetup's handling of a signer/key rotation (audit cluster F).
// saveState is a shallow merge, and `deployed:true` was written once and never
// cleared. loadDepositWalletForSigner correctly refuses the OLD vault after a
// rotation and a NEW CREATE2 address is derived — but the stale flag then
// short-circuited the deploy step, so setup printed "✅ Deposit wallet deployed"
// for a vault with no code and told the user to bridge USDC into it (which the
// bridge sweeps and never delivers — fund.ts documents this live).
//
// Everything is mocked: relayer, creds file, CLOB, geoblock, and viem's public
// client (setup builds its own via createPublicClient, so viem is mocked with
// its real exports spread and only createPublicClient replaced). No network.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as viem from "viem";

const OLD_SIGNER = "0x1111111111111111111111111111111111111111";
const NEW_SIGNER = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const VAULT_A = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26"; // the old key's vault (deployed, funded once)
const VAULT_B = "0x2222222222222222222222222222222222222222"; // the new key's CREATE2 vault

let stateFile: Record<string, unknown> = {};
const saveStateCalls: Array<Record<string, unknown>> = [];
let onChainCode: Record<string, string> = {};
let relayerSaysDeployed = false;
let deployBehaviour: "ok" | "throw" = "ok";
const relayerCalls: string[] = [];

mock.module("viem", {
  namedExports: {
    ...viem,
    createPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "balanceOf" || functionName === "allowance") return 0n;
        if (functionName === "isApprovedForAll") return false;
        throw new Error(`unexpected readContract ${functionName} (test)`);
      },
      getCode: async ({ address }: { address: string }) => onChainCode[address.toLowerCase()] ?? "0x",
    }),
  },
});
mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getPolymarketAccount: () => ({ address: NEW_SIGNER }),
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "FI", ip: null, raw: {} }),
    getClobClient: async () => { throw new Error("clob unavailable (test)"); },
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => {
      saveStateCalls.push(patch);
      stateFile = { ...stateFile, ...patch };
      return stateFile;
    },
    // Mirrors the real guard: the saved wallet is only returned for ITS signer.
    loadDepositWalletForSigner: (signer: string) => {
      const s = stateFile as { depositWallet?: string; signer?: string };
      return s.depositWallet && s.signer && s.signer.toLowerCase() === signer.toLowerCase() ? s.depositWallet : undefined;
    },
    loadL2Creds: () => null,
    saveL2Creds: () => {},
    invalidateL2Creds: () => {},
    loadBuilderCreds: () => null,
    saveBuilderCreds: () => {},
  },
});
mock.module("../src/utils/polymarket/relayer.js", {
  namedExports: {
    deriveDepositWallet: async () => { relayerCalls.push("derive"); return VAULT_B; },
    isDepositWalletDeployed: async (address: string) => { relayerCalls.push(`isDeployed:${address}`); return relayerSaysDeployed; },
    deployDepositWallet: async () => {
      relayerCalls.push("deploy");
      if (deployBehaviour === "throw") throw new Error("relayer unavailable (test)");
      onChainCode[VAULT_B.toLowerCase()] = "0x60006000";
      return { transactionHash: "0x" + "de".repeat(32) };
    },
    sendWalletBatch: async () => { throw new Error("sendWalletBatch not expected (test)"); },
    getRelayerTransactionState: async () => undefined,
    getRelayClient: async () => { throw new Error("not used"); },
    BATCH_DEADLINE_SECS: 300,
  },
});

const { runSetup } = await import("../src/utils/polymarket/setup.js");

function reset() {
  stateFile = {};
  saveStateCalls.length = 0;
  onChainCode = { [VAULT_A.toLowerCase()]: "0x60006000" };
  relayerSaysDeployed = false;
  deployBehaviour = "ok";
  relayerCalls.length = 0;
}

test("a signer rotation resets the stale deployed flag and actually checks/deploys the NEW vault", async () => {
  reset();
  stateFile = { depositWallet: VAULT_A, signer: OLD_SIGNER, deployed: true, approvalsDone: true };
  deployBehaviour = "throw"; // the relayer is down: setup must SURFACE that, not report the old flag
  await assert.rejects(runSetup({ confirm: false }), /relayer unavailable \(test\)/);
  assert.equal(stateFile.depositWallet, VAULT_B);
  assert.equal(stateFile.signer, NEW_SIGNER);
  assert.equal(stateFile.deployed, false, "deployed:true belonged to the OLD vault and must not survive");
  assert.equal(stateFile.approvalsDone, false, "approvals were granted from the OLD vault");
  assert.ok(relayerCalls.includes(`isDeployed:${VAULT_B}`), `the new vault must be checked on the relayer (calls: ${relayerCalls})`);
  assert.ok(relayerCalls.includes("deploy"), "an undeployed new vault must be deployed, not assumed");
});

test("after a rotation the new vault is deployed for real and only then reported as deployed", async () => {
  reset();
  stateFile = { depositWallet: VAULT_A, signer: OLD_SIGNER, deployed: true, approvalsDone: true };
  const res = await runSetup({ confirm: false });
  assert.deepEqual(relayerCalls, ["derive", `isDeployed:${VAULT_B}`, "deploy"]);
  assert.match(res.text, /✅ Deposit wallet deployed \(tx 0xdede/);
  assert.match(res.text, new RegExp(`Deposit wallet \\(holds betting funds\\): ${VAULT_B}`));
  assert.equal(res.structured.deployed, true);
  assert.equal(stateFile.deployed, true, "re-armed only after code is visible at the derived address");
  // Funding instructions are fine NOW — the vault exists on-chain.
  assert.match(res.text, /Fund it/);
});

test("same signer, same vault: the persisted flag is still trusted (no extra relayer round-trip)", async () => {
  reset();
  stateFile = { depositWallet: VAULT_B, signer: NEW_SIGNER, deployed: true, approvalsDone: true };
  onChainCode[VAULT_B.toLowerCase()] = "0x60006000";
  const res = await runSetup({ confirm: false });
  assert.deepEqual(relayerCalls, [], "no derive/isDeployed/deploy when nothing changed");
  assert.match(res.text, /✅ Deposit wallet deployed/);
  assert.ok(!saveStateCalls.some((p) => p.deployed === false), "the flag must not be reset for the same vault");
  assert.equal(stateFile.deployed, true);
});
