// Run with: npm test  (tsx --experimental-test-module-mocks --test)
import { test, mock } from "node:test";
import assert from "node:assert/strict";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

let script: Array<() => unknown> = [];
let requests: Array<{ url: string; method: string }> = [];
let signaturesCreated = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string, init: { method?: string }) => {
      requests.push({ url, method: init.method || "GET" });
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
  },
});

mock.module("@blockrun/llm", {
  namedExports: {
    SolanaLLMClient: { SOLANA_API_URL: "https://sol.blockrun.ai/api" },
    PaymentError: class PaymentError extends Error {},
    SOLANA_NETWORK: "solana:mainnet",
    loadSolanaWallet: () => "test-solana-key",
    solanaPublicKey: async () => "payer",
    solanaKeyToBytes: async () => new Uint8Array(64),
    createSolanaPaymentPayload: async () => { signaturesCreated++; return "signed-svm-payment"; },
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => ({
      network: "solana:mainnet",
      recipient: "recipient",
      amount: "500000",
      extra: { feePayer: "fee-payer" },
      resource: { url: "https://sol.blockrun.ai/api/v1/videos/generations" },
    }),
  },
});

const { solanaPaidAsyncPost } = await import("../src/utils/solana-402.js");
const quote = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "quote" }), json: async () => ({}) });
const submit = (pollUrl: string) => ({ status: 202, ok: true, headers: headers(), json: async () => ({ id: "vid_1", status: "queued", poll_url: pollUrl }) });
const poll = (status: string, extra: Record<string, unknown> = {}) => ({ status: status === "completed" ? 200 : 202, ok: true, headers: headers({ "x-payment-receipt": "solana-tx" }), json: async () => ({ status, ...extra }) });

test("async Solana flow submits once, retries only idempotent polls, and returns the receipt", async () => {
  requests = [];
  signaturesCreated = 0;
  script = [
    quote,
    () => submit("/api/v1/videos/poll/vid_1"),
    () => { throw new TypeError("transient disconnect"); },
    () => poll("in_progress"),
    () => poll("completed", { data: [{ url: "https://blockrun.ai/media/vid_1.mp4" }] }),
  ];
  const result = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "test" }, 100, {
    pollBudgetMs: 100,
    pollIntervalMs: 1,
    resignIntervalMs: 10_000,
  });
  assert.equal(result.paidUsd, 0.5);
  assert.equal(result.txHash, "solana-tx");
  assert.equal((result.data.data as Array<{ url: string }>)[0].url, "https://blockrun.ai/media/vid_1.mp4");
  assert.equal(requests.filter((request) => request.method === "POST").length, 2, "probe + one paid submit only");
  assert.equal(requests.filter((request) => request.method === "GET").length, 3);
  assert.equal(signaturesCreated, 1);
});

test("a gateway cannot redirect the payment-bearing poll to another origin", async () => {
  requests = [];
  script = [quote, () => submit("https://evil.example/poll/vid_1")];
  await assert.rejects(
    solanaPaidAsyncPost("/v1/videos/generations", { prompt: "test" }, 100, { pollBudgetMs: 10, pollIntervalMs: 1 }),
    /off-gateway poll URL/,
  );
  assert.equal(requests.some((request) => request.url.includes("evil.example")), false);
});

test("the authoritative quote hook runs before any Solana payment is signed", async () => {
  requests = [];
  signaturesCreated = 0;
  script = [quote];
  await assert.rejects(
    solanaPaidAsyncPost("/v1/videos/generations", { prompt: "test" }, 100, {
      onQuote: () => { throw new Error("budget exceeded"); },
    }),
    /budget exceeded/,
  );
  assert.equal(signaturesCreated, 0);
  assert.equal(requests.length, 1);
});
