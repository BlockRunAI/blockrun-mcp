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

// --- the size of the grant is stated before the signature, not after ---
//
// The prompt said what the approvals are FOR ("settle YOUR signed orders") and
// never what they are WORTH: the default is an unlimited pUSD allowance to four
// spenders. POLYMARKET_BOUNDED_APPROVALS could always cap it; nothing surfaced
// that at the moment of consent.

test("the pending-approval prompt states the allowance amount and how to bound it", async () => {
  const { getBoundedApprovalsUsd } = await import("../src/utils/polymarket/constants.js");
  const saved = process.env.POLYMARKET_BOUNDED_APPROVALS;
  try {
    delete process.env.POLYMARKET_BOUNDED_APPROVALS;
    assert.equal(getBoundedApprovalsUsd(), null, "unset means unlimited — the default this text must disclose");

    process.env.POLYMARKET_BOUNDED_APPROVALS = "250";
    assert.equal(getBoundedApprovalsUsd(), 250);

    // Garbage must not silently read as a bound the prompt would then claim.
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.POLYMARKET_BOUNDED_APPROVALS = bad;
      assert.equal(getBoundedApprovalsUsd(), null, `"${bad}" must fall back to unlimited`);
    }
  } finally {
    if (saved === undefined) delete process.env.POLYMARKET_BOUNDED_APPROVALS;
    else process.env.POLYMARKET_BOUNDED_APPROVALS = saved;
  }

  // The disclosure itself lives in the setup report; pin both branches' wording
  // so a future edit cannot quietly drop the amount again.
  const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../src/utils/polymarket/setup.ts", import.meta.url), "utf8"));
  assert.match(src, /UNLIMITED pUSD allowance/, "the unlimited branch must name it");
  assert.match(src, /POLYMARKET_BOUNDED_APPROVALS=<usd> to cap/, "and point at the bound");
  assert.match(src, /capped at \$\$\{boundedApprovalUsd\.toFixed\(2\)\} per spender/, "the bounded branch must state the cap");
});
