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
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),

    getChain: () => "base",
    getOrCreateWalletKey: () => TEST_KEY,
    getWalletInfo: async () => ({ address: "0x34913A202138c83D0ed5FcA84E15da456d24402E" }),
  },
});
// What the 402 quotes. The onramp link is FREE by contract ($0 = the signature
// is wallet authentication, nothing settles); a test flips this to prove the
// client refuses to sign anything else.
let quotedAmount: unknown = "0";
let signCalls = 0;
mock.module("@blockrun/llm", {
  namedExports: {
    createPaymentPayload: async () => { signCalls++; return "0xpaymentpayloadmock"; },
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({
      amount: quotedAmount, recipient: "0x0000000000000000000000000000000000000001",
      network: "eip155:8453", resource: { url: "https://blockrun.ai/api/v1/onramp/token" },
      maxTimeoutSeconds: 300, extra: {},
    }),
  },
});

const { launchTopUp, mintOnrampUrl } = await import("../src/utils/onramp.js");

const ADDRESS = "0x34913A202138c83D0ed5FcA84E15da456d24402E";

// --- the "$0" promise is enforced, not assumed (audit round 3, critic) ---
//
// mintOnrampUrl is reached from every media tool's out-of-funds catch — on
// wallets that DO hold USDC (a replayed nonce reads as "rejected" too). Until
// now it signed whatever `details.amount` the 402 quoted; the $0 lived only in
// a comment and this file's fixture. A gateway bug or a hijacked route that
// quoted a real amount would have been signed against a funded wallet.

test("a 402 that quotes a non-zero amount is refused before anything is signed", async () => {
  fetchCall = 0; signCalls = 0; quotedAmount = "1000";
  try {
    await assert.rejects(
      () => mintOnrampUrl(ADDRESS),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        assert.match(msg, /not free/i, msg);
        assert.match(msg, /1000/, msg);
        assert.match(msg, /nothing was signed/i, msg);
        return true;
      },
    );
    assert.equal(signCalls, 0, "createPaymentPayload must not run for a priced quote");
    assert.equal(fetchCall, 1, "no second (signed) POST");
  } finally {
    quotedAmount = "0";
  }
});

test("an unreadable quoted amount is refused the same way — absence is not zero", async () => {
  for (const bad of [undefined, "", "abc", null]) {
    fetchCall = 0; signCalls = 0; quotedAmount = bad;
    try {
      await assert.rejects(() => mintOnrampUrl(ADDRESS), /not free|nothing was signed/i, String(bad));
      assert.equal(signCalls, 0, `signed against amount ${String(bad)}`);
    } finally {
      quotedAmount = "0";
    }
  }
});

test("launchTopUp degrades a priced quote to the manual-funding note, still without signing", async () => {
  fetchCall = 0; signCalls = 0; openCalls = []; quotedAmount = "1000";
  try {
    const r = await launchTopUp();
    assert.equal(r.opened, false);
    assert.equal(r.url, undefined);
    assert.equal(signCalls, 0);
    assert.equal(openCalls.length, 0);
    assert.match(r.note, /not free/i, r.note);
    assert.match(r.note, /Fund manually/, r.note);
  } finally {
    quotedAmount = "0";
  }
});

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
