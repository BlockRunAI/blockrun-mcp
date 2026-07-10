// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// action:"fund" — dry-run, validation, balance guard, and the confirm path
// (createPaymentPayload + gateway POST mocked; no network, no real signing).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const VAULT = "0x5d3eaa66AE01F1a907c8e0970D1D021C6Ff8EB26";
const AGENT = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const BRIDGE = "0x6a6827094a5809Df44b32adBEf26F233614F12c4";
let baseBalance = 20; // USDC on Base
let vaultCode = "0x60006000"; // deployed by default
let postCalls: unknown[] = [];

mock.module("axios", {
  defaultExport: {
    post: async () => ({ data: { address: { evm: BRIDGE } } }),
  },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => "BASE64_DEPOSIT_PAYLOAD",
    BlockrunClient: class {
      async post(path: string, body: unknown) {
        postCalls.push({ path, body });
        return { success: true, deposit: { txHash: "0xDEPOSITTX", amountUsd: 5 }, fee: { txHash: "0xFEETX" } };
      }
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getOrCreateWalletKey: () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    getChainBalance: async () => baseBalance,
  },
});
mock.module("../src/utils/polymarket/client.js", {
  namedExports: { getPolymarketAccount: () => ({ address: AGENT }) },
});
mock.module("../src/utils/polymarket/positions.js", {
  namedExports: { getFundsAddress: () => VAULT },
});
mock.module("../src/utils/polymarket/setup.js", {
  namedExports: { getPublicClient: () => ({ getCode: async () => vaultCode }) },
});

const { fundVault } = await import("../src/utils/polymarket/fund.js");

test("missing amount_usd is rejected", async () => {
  const res = await fundVault({});
  assert.equal(res.isError, true);
  assert.match(res.text, /amount_usd/);
});

test("below the $2 bridge minimum is rejected before signing", async () => {
  const res = await fundVault({ amount_usd: 0.1, confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /Minimum funding is \$2/);
  assert.equal(postCalls.length, 0, "must not sign/POST a below-min deposit");
});

test("funding an UNDEPLOYED vault is blocked (deploy first)", async () => {
  vaultCode = "0x"; // not deployed
  postCalls = [];
  try {
    const res = await fundVault({ amount_usd: 5, confirm: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /not deployed yet/);
    assert.match(res.text, /action:"setup" confirm:true/);
    assert.equal(postCalls.length, 0, "must not strand USDC at the bridge");
  } finally {
    vaultCode = "0x60006000";
  }
});

test("insufficient Base USDC is rejected with the shortfall", async () => {
  baseBalance = 2;
  const res = await fundVault({ amount_usd: 5 });
  assert.equal(res.isError, true);
  assert.match(res.text, /need \$5\.01/);
  assert.equal(postCalls.length, 0);
});

test("dry-run previews the gasless flow and submits nothing", async () => {
  baseBalance = 20;
  postCalls = [];
  const res = await fundVault({ amount_usd: 5 });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /DRY RUN/);
  assert.match(res.text, new RegExp(BRIDGE));
  assert.match(res.text, new RegExp(VAULT));
  assert.match(res.text, /fee: \$0\.01/);
  assert.equal(postCalls.length, 0, "dry run must not POST");
});

test("confirm:true signs the deposit auth and calls the gateway with the right body", async () => {
  baseBalance = 20;
  postCalls = [];
  const res = await fundVault({ amount_usd: 5, confirm: true });
  assert.equal(res.isError, undefined, res.text);
  assert.match(res.text, /Funded \$5\.00/);
  assert.match(res.text, /0xDEPOSITTX/);
  assert.equal(postCalls.length, 1);
  const call = postCalls[0] as { path: string; body: Record<string, unknown> };
  assert.equal(call.path, "/v1/polymarket/fund");
  assert.equal(call.body.recipient, BRIDGE);
  assert.equal(call.body.depositWallet, VAULT);
  assert.equal(call.body.amountMicro, "5000000"); // $5 * 1e6
  assert.equal(call.body.depositAuthorization, "BASE64_DEPOSIT_PAYLOAD");
});
