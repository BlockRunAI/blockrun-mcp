// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Withdraw dry-run + amount validation (the confirm path hits the bridge/relayer
// and is exercised in the live integration run, not here). Deps are mocked so no
// network/RPC.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const DEPOSIT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const AGENT = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
let balanceRaw = 7_500_000n; // $7.50 pUSD (6 decimals)

mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { getFundsAddress: () => DEPOSIT },
});
mock.module("../src/utils/polymarket/setup.js", {
  namedExports: {
    getPublicClient: () => ({
      readContract: async () => balanceRaw,
      waitForTransactionReceipt: async () => ({}),
    }),
  },
});
// client.js is imported (transitively via orders.js/relayer.js) for several
// exports — stub them all so the mock doesn't drop any.
mock.module("../src/utils/polymarket/client.js", {
  namedExports: {
    getPolymarketAccount: () => ({ address: AGENT }),
    checkGeoblock: async () => ({ orderPlacement: "permitted", country: "JP", ip: null, raw: {} }),
    getClobClient: async () => { throw new Error("clob client not used in withdraw dry-run"); },
    resetClobClient: () => {},
    getClobProxyAgent: () => null,
    installUnderscoreHeaderBridge: () => {},
  },
});

const { withdrawFunds } = await import("../src/utils/polymarket/withdraw.js");

test("no confirm → dry-run previews full balance to the agent wallet on Base", async () => {
  balanceRaw = 7_500_000n;
  const res = await withdrawFunds({});
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /DRY RUN/);
  assert.match(res.text, /\$7\.50/);
  assert.match(res.text, /USDC on Base/);
  assert.match(res.text, new RegExp(AGENT));
  assert.equal((res.structured as { dryRun?: boolean }).dryRun, true);
  assert.equal((res.structured as { toChainId?: number }).toChainId, 8453);
});

test("amount_usd caps the withdrawal to that amount", async () => {
  balanceRaw = 7_500_000n;
  const res = await withdrawFunds({ amount_usd: 3 });
  assert.match(res.text, /\$3\.00/);
});

test("amount above balance is rejected", async () => {
  balanceRaw = 7_500_000n;
  const res = await withdrawFunds({ amount_usd: 10 });
  assert.equal(res.isError, true);
  assert.match(res.text, /exceeds the pUSD balance/);
});

test("nothing to withdraw when balance is zero", async () => {
  balanceRaw = 0n;
  const res = await withdrawFunds({});
  assert.equal(res.isError, true);
  assert.match(res.text, /No pUSD to withdraw/);
});

test("custom to_address overrides the destination", async () => {
  balanceRaw = 5_000_000n;
  const other = "0x1111111111111111111111111111111111111111";
  const res = await withdrawFunds({ to_address: other });
  assert.match(res.text, new RegExp(other));
});
