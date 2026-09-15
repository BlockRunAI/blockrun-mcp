// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// setup's `ready` verdict used to ignore the geoblock probe (audit round 3,
// D17): a blocked egress printed "❌ Region: order placement BLOCKED …"
// followed by "🎯 Ready to trade" and structured.ready:true — the two fields
// an agent keys on before funding. It would fund $50 into the vault and only
// learn the truth from the first buy's 403, with the money now behind a
// withdraw. ready must be false when any blocking check fails; "unknown" is
// not a failure (the probe is best-effort) but is reported as such.
//
// Same harness as polymarket-setup-rotation.test.ts: relayer, creds, CLOB and
// viem's public client are all doubles; no network.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as viem from "viem";

const SIGNER = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const VAULT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";

let orderPlacement: "permitted" | "blocked" | "unknown" = "permitted";
let stateFile: Record<string, unknown> = { depositWallet: VAULT, signer: SIGNER, deployed: true, approvalsDone: true };

mock.module("viem", {
  namedExports: {
    ...viem,
    createPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "balanceOf") return 25_000_000n; // $25 pUSD
        if (functionName === "allowance") return viem.maxUint256;
        if (functionName === "isApprovedForAll") return true;
        throw new Error(`unexpected readContract ${functionName} (test)`);
      },
      getCode: async () => "0x60006000",
      getBalance: async () => 10n ** 18n, // 1 POL (EOA mode only)
    }),
  },
});
mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getPolymarketAccount: () => ({ address: SIGNER }),
    checkGeoblock: async () => ({ orderPlacement, country: orderPlacement === "blocked" ? "US" : "FI", ip: null, raw: {} }),
    getClobClient: async () => ({ updateBalanceAllowance: async () => ({}) }),
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});
mock.module("../src/utils/polymarket/creds.js", {
  namedExports: {
    loadState: () => ({ ...stateFile }),
    saveState: (patch: Record<string, unknown>) => { stateFile = { ...stateFile, ...patch }; return stateFile; },
    loadDepositWalletForSigner: () => VAULT,
    loadL2Creds: () => null,
    saveL2Creds: () => {},
    invalidateL2Creds: () => {},
    loadBuilderCreds: () => null,
    saveBuilderCreds: () => {},
  },
});
mock.module("../src/utils/polymarket/relayer.js", {
  namedExports: {
    deriveDepositWallet: async () => VAULT,
    isDepositWalletDeployed: async () => true,
    deployDepositWallet: async () => { throw new Error("deploy not expected (test)"); },
    sendWalletBatch: async () => { throw new Error("sendWalletBatch not expected (test)"); },
    getRelayerTransactionState: async () => undefined,
    getRelayClient: async () => { throw new Error("not used"); },
    BATCH_DEADLINE_SECS: 300,
  },
});

const { runSetup } = await import("../src/utils/polymarket/setup.js");

test("everything green and the egress permitted → ready", async () => {
  orderPlacement = "permitted";
  const res = await runSetup({ confirm: false });
  assert.match(res.text, /✅ Region: order placement permitted/);
  assert.match(res.text, /🎯 Ready to trade/);
  assert.equal(res.structured.ready, true);
  assert.equal(res.structured.orderPlacement, "permitted");
});

test("everything green but the egress BLOCKED → NOT ready, and the report says why", async () => {
  orderPlacement = "blocked";
  const res = await runSetup({ confirm: false });
  assert.match(res.text, /❌ Region: order placement BLOCKED/);
  assert.doesNotMatch(res.text, /🎯 Ready to trade/, "a blocked egress must not print the green headline");
  assert.match(res.text, /not ready|blocked/i);
  assert.equal(res.structured.ready, false, "agents branch on structured.ready before funding");
  assert.equal(res.structured.orderPlacement, "blocked");
  // The other checks still read green — the region is the one blocker.
  assert.equal(res.structured.deployed, true);
  assert.equal(res.structured.approvalsPending, false);
  assert.equal(res.structured.credsReady, true);
});

test("an undeterminable region is not a blocker, but is exposed so an agent can see it", async () => {
  orderPlacement = "unknown";
  const res = await runSetup({ confirm: false });
  assert.match(res.text, /could not determine/);
  assert.equal(res.structured.ready, true);
  assert.equal(res.structured.orderPlacement, "unknown");
});

test("EOA mode applies the same rule", async () => {
  process.env.POLYMARKET_SIG_TYPE = "0";
  try {
    orderPlacement = "blocked";
    const blocked = await runSetup({ confirm: false });
    assert.match(blocked.text, /plain EOA mode/);
    assert.doesNotMatch(blocked.text, /🎯 Ready to trade/);
    assert.equal(blocked.structured.ready, false);
    assert.equal(blocked.structured.orderPlacement, "blocked");
    orderPlacement = "permitted";
    const ok = await runSetup({ confirm: false });
    assert.equal(ok.structured.ready, true);
  } finally {
    delete process.env.POLYMARKET_SIG_TYPE;
  }
});
