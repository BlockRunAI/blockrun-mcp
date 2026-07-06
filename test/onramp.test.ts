// Run with: npm test  (tsx --experimental-test-module-mocks --test)
// Drives the real launchTopUp/mintOnrampUrl against a mocked gateway + wallet +
// browser: the two-step x402 onramp mint returns a pay.coinbase.com URL which is
// opened. No network, no browser, no spend. node --test isolates each file.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const COINBASE_URL = "https://pay.coinbase.com/buy/select-asset?sessionToken=abc123";

function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (n: string) => lower[n.toLowerCase()] ?? null };
}

// fetchWithTimeout: 1) POST → 402 challenge, 2) POST(signed) → 200 { url }.
let fetchCall = 0;
const fakeFetch = async () => {
  fetchCall++;
  if (fetchCall === 1) {
    return { status: 402, ok: false, headers: headers({ "payment-required": "x402 base ..." }), json: async () => ({}) };
  }
  return { status: 200, ok: true, headers: headers({}), json: async () => ({ url: COINBASE_URL }) };
};

let openCalls: string[] = [];
mock.module("open", { defaultExport: async (url: string) => { openCalls.push(url); return {}; } });
mock.module("../src/utils/http.js", { namedExports: { fetchWithTimeout: fakeFetch, isTimeoutError: () => false } });
mock.module("../src/utils/wallet.js", {
  namedExports: {
    getChain: () => "base",
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0x34913A202138c83D0ed5FcA84E15da456d24402E" }),
  },
});
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => "0xpaymentpayloadmock",
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({
      amount: "0", recipient: "0x0000000000000000000000000000000000000001",
      network: "eip155:8453", resource: { url: "https://blockrun.ai/api/v1/onramp/token" },
      maxTimeoutSeconds: 300, extra: {},
    }),
  },
});

const { launchTopUp, mintOnrampUrl } = await import("../src/utils/onramp.js");

test("mintOnrampUrl returns the Coinbase URL from the gateway", async () => {
  fetchCall = 0;
  const url = await mintOnrampUrl("0x34913A202138c83D0ed5FcA84E15da456d24402E");
  assert.equal(url, COINBASE_URL);
});

test("launchTopUp mints on Base and opens the Coinbase page", async () => {
  fetchCall = 0; openCalls = [];
  const r = await launchTopUp();
  assert.equal(r.opened, true);
  assert.equal(r.url, COINBASE_URL);
  assert.equal(openCalls[0], COINBASE_URL);
  assert.match(r.note, /pay\.coinbase\.com/);
});
