// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Drives solanaPaidAsyncPost end-to-end against a scripted fetch. Every money-
// path branch has a case here: the loop spends real USDC in production and
// the Base video harness cannot reach it (its fetch mock is a sentinel).
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

type Scripted = { url: string; method: string; headers: Record<string, string> };
let script: Array<() => unknown> = [];
let requests: Scripted[] = [];
let signaturesCreated = 0;
let signOptions: Array<Record<string, unknown>> = [];
let timeouts: number[] = [];
// 1-based index of the createSolanaPaymentPayload call that should throw (null = none).
let failSignOnCall: number | null = null;
let signCalls = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string, init: { method?: string; headers?: Record<string, string> }, timeoutMs: number) => {
      requests.push({ url, method: init.method || "GET", headers: init.headers || {} });
      timeouts.push(timeoutMs);
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
  },
});

// The helper reads the key through the keychain-aware resolver, never the
// SDK's file-only loader (strict keychain mode retires the session file).
let walletKey: string | undefined = "test-solana-key";
mock.module("../src/utils/wallet.js", {
  namedExports: { resolveSolanaKey: () => walletKey },
});

const baseDetails = () => ({
  network: "solana:mainnet",
  recipient: "recipient",
  amount: "500000",
  extra: { feePayer: "fee-payer" },
  resource: { url: "https://sol.blockrun.ai/api/v1/videos/generations" },
});
let details: Record<string, unknown> = baseDetails();
mock.module("@blockrun/llm", {
  namedExports: {
    SolanaLLMClient: { SOLANA_API_URL: "https://sol.blockrun.ai/api" },
    PaymentError: class PaymentError extends Error {},
    SOLANA_NETWORK: "solana:mainnet",
    solanaPublicKey: async () => "payer",
    solanaKeyToBytes: async () => new Uint8Array(64),
    createSolanaPaymentPayload: async (...args: unknown[]) => {
      signCalls++;
      if (failSignOnCall === signCalls) throw new Error("rpc blip");
      signaturesCreated++;
      signOptions.push(args[5] as Record<string, unknown>);
      return `signed-svm-payment-${signaturesCreated}`;
    },
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => details,
  },
});

const { solanaPaidAsyncPost } = await import("../src/utils/solana-402.js");

beforeEach(() => {
  script = []; requests = []; signaturesCreated = 0; signOptions = []; timeouts = [];
  failSignOnCall = null; signCalls = 0; walletKey = "test-solana-key"; details = baseDetails();
});
// Unconsumed scripted responses fail the test that owns them, not the next one.
afterEach(() => { assert.equal(script.length, 0, "unconsumed scripted responses"); });

const POLL = "/api/v1/videos/generations/vid_1?model=x&duration=5&sig=abc";
const quote = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "quote" }), json: async () => ({}) });
const submit = (pollUrl: string = POLL, status = 202) => ({ status, ok: true, headers: headers(), json: async () => ({ id: "vid_1", status: "queued", poll_url: pollUrl }) });
const poll = (status: string, extra: Record<string, unknown> = {}, withReceipt = status === "completed") => ({
  status: status === "completed" ? 200 : 202,
  ok: true,
  headers: headers(withReceipt ? { "x-payment-receipt": "solana-tx" } : {}),
  json: async () => ({ status, ...extra }),
});
const paymentResponse = (errorReason: string) => Buffer.from(JSON.stringify({ success: false, network: "solana", errorReason })).toString("base64");
const settleFail402 = (errorReason = "Transaction simulation failed: Blockhash not found") =>
  ({ status: 402, ok: false, headers: headers({ "payment-response": paymentResponse(errorReason) }), json: async () => ({ error: "Payment settlement failed" }) });
const challenge402 = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "fresh" }), json: async () => ({}) });
const fast = { pollBudgetMs: 10_000, pollIntervalMs: 1, resignIntervalMs: 60_000 };
const gets = () => requests.filter((r) => r.method === "GET");
const posts = () => requests.filter((r) => r.method === "POST");

test("async Solana flow submits once, retries only idempotent polls, and returns the receipt", async () => {
  script = [
    quote,
    () => submit(),
    () => { throw new TypeError("transient disconnect"); },
    () => poll("in_progress"),
    () => poll("completed", { data: [{ url: "https://blockrun.ai/media/vid_1.mp4" }] }),
  ];
  const result = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "test" }, fast);
  assert.equal(result.paidUsd, 0.5);
  assert.equal(result.txHash, "solana-tx");
  assert.equal(result.jobId, "vid_1");
  assert.equal((result.data.data as Array<{ url: string }>)[0].url, "https://blockrun.ai/media/vid_1.mp4");
  assert.equal(posts().length, 2, "probe + one paid submit only");
  assert.equal(gets().length, 3);
  assert.equal(signaturesCreated, 1);
  assert.equal(gets()[0].url, `https://sol.blockrun.ai${POLL}`, "poll_url resolves against the gateway origin verbatim (its sig query is HMAC-bound)");
  assert.equal(gets()[0].headers["PAYMENT-SIGNATURE"], "signed-svm-payment-1");
});

test("a gateway cannot redirect the payment-bearing poll to another origin", async () => {
  script = [quote, () => submit("https://evil.example/poll/vid_1")];
  await assert.rejects(
    solanaPaidAsyncPost("/v1/videos/generations", { prompt: "test" }, fast),
    /off-gateway poll URL.*No charge was made/,
  );
  assert.equal(requests.some((request) => request.url.includes("evil.example")), false);
});

test("the authoritative quote hook runs before any Solana payment is signed", async () => {
  script = [quote];
  await assert.rejects(
    solanaPaidAsyncPost("/v1/videos/generations", { prompt: "test" }, { onQuote: () => { throw new Error("budget exceeded"); } }),
    /budget exceeded/,
  );
  assert.equal(signaturesCreated, 0);
  assert.equal(requests.length, 1);
});

test("an off-gateway resource URL in the quote is never what gets signed", async () => {
  details = { ...baseDetails(), resource: { url: "https://evil.example/v1/videos/generations" } };
  script = [quote, () => submit(), () => poll("completed", { data: [{ url: "u" }] })];
  await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(signOptions[0].resourceUrl, "https://sol.blockrun.ai/api/v1/videos/generations");
});

test("a non-Solana challenge and a missing feePayer are refused before signing", async () => {
  details = { ...baseDetails(), network: "eip155:8453" };
  script = [quote];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Expected a Solana payment quote/);
  details = { ...baseDetails(), extra: {} };
  script = [quote];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Missing feePayer/);
  assert.equal(signaturesCreated, 0);
});

test("an unreadable quote amount is never signed", async () => {
  details = { ...baseDetails(), amount: "not-a-number" };
  script = [quote];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /unreadable amount/);
  assert.equal(signaturesCreated, 0);
});

test("a missing Solana wallet is a PaymentError with the setup hint", async () => {
  walletKey = undefined;
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /No Solana wallet found/);
  assert.equal(requests.length, 0);
});

test("a paid route that answers 2xx instead of a quote is a fault, not a free render", async () => {
  script = [() => ({ status: 200, ok: true, headers: headers(), json: async () => ({ data: [{ url: "u" }] }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Unexpected status 200/);
  assert.equal(signaturesCreated, 0);
});

test("a rejected paid submit is a PaymentError and issues no polls", async () => {
  script = [quote, quote];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Payment was rejected/);
  assert.equal(gets().length, 0);
});

test("a synchronous 200 submit without poll_url returns without polling", async () => {
  script = [quote, () => ({ status: 200, ok: true, headers: headers({ "x-payment-receipt": "sync-tx" }), json: async () => ({ status: "completed", data: [{ url: "u" }] }) })];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "sync-tx");
  assert.equal(gets().length, 0);
});

test("a 200 submit that carries poll_url is an async job and gets polled", async () => {
  script = [quote, () => submit(POLL, 200), () => poll("completed", { data: [{ url: "u" }] })];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.equal(gets().length, 1);
});

test("a 202 without poll_url and a non-2xx submit are refused", async () => {
  script = [quote, () => ({ status: 202, ok: true, headers: headers(), json: async () => ({ id: "vid_1", status: "queued" }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /missing poll_url/);
  script = [quote, () => ({ status: 500, ok: false, headers: headers(), json: async () => ({ error: "boom" }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /API error 500/);
});

test("the proactive re-sign refreshes the poll signature every resignIntervalMs", async () => {
  script = [quote, () => submit(), () => poll("in_progress"), () => poll("in_progress"), () => poll("completed", { data: [{ url: "u" }] })];
  await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, resignIntervalMs: 0 });
  assert.equal(signaturesCreated, 4, "submit + one re-sign before each of the 3 polls");
  assert.deepEqual(gets().map((g) => g.headers["PAYMENT-SIGNATURE"]), ["signed-svm-payment-2", "signed-svm-payment-3", "signed-svm-payment-4"]);
  assert.equal(signOptions[3].resourceUrl, "https://sol.blockrun.ai/api/v1/videos/generations", "proactive re-sign keeps the original resource");
});

test("a failed proactive re-sign keeps polling with the previous signature and backs off", async () => {
  script = [quote, () => submit(), () => poll("in_progress"), () => poll("in_progress"), () => poll("completed", { data: [{ url: "u" }] })];
  failSignOnCall = 2; // the first proactive refresh, not the submit signature
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, resignIntervalMs: 0 });
  assert.equal(r.txHash, "solana-tx");
  // The blip cost exactly one refresh; the 10s retry back-off means the two
  // following polls reuse the submit signature instead of re-hitting the RPC.
  assert.equal(signaturesCreated, 1);
  assert.deepEqual(gets().map((g) => g.headers["PAYMENT-SIGNATURE"]), ["signed-svm-payment-1", "signed-svm-payment-1", "signed-svm-payment-1"]);
});

test("a stale-blockhash settle 402 re-signs against an identical unpaid challenge and completes", async () => {
  script = [quote, () => submit(), settleFail402, challenge402, () => poll("completed", { data: [{ url: "u" }] })];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.equal(signaturesCreated, 2);
  const [paid, challenge, retry] = gets();
  assert.equal(paid.headers["PAYMENT-SIGNATURE"], "signed-svm-payment-1");
  assert.equal(challenge.headers["PAYMENT-SIGNATURE"], undefined, "the challenge GET is unpaid");
  assert.equal(retry.headers["PAYMENT-SIGNATURE"], "signed-svm-payment-2");
  assert.equal(signOptions[1].resourceUrl, "https://sol.blockrun.ai/api/v1/videos/generations");
});

test("a refreshed challenge that re-prices, re-routes or re-sponsors the job is refused", async () => {
  for (const mutation of [{ amount: "900000" }, { recipient: "someone-else" }, { extra: { feePayer: "other-fee-payer" } }]) {
    script = [quote, () => submit(), settleFail402, () => { details = { ...baseDetails(), ...mutation }; return challenge402(); }];
    await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /changed the payment amount, recipient or fee payer.*No charge was made/);
    assert.equal(signaturesCreated, 1, "nothing signed after the mutated challenge");
    details = baseDetails(); signaturesCreated = 0; requests = [];
  }
});

test("a transient failure on the challenge GET does not abandon the job", async () => {
  script = [quote, () => submit(), settleFail402, () => { throw new TypeError("reset"); }, settleFail402, challenge402, () => poll("completed", { data: [{ url: "u" }] })];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.equal(signaturesCreated, 2);
});

test("reactive re-signs are bounded and exhaustion names the claimable job, not a funding problem", async () => {
  script = [quote, () => submit(), settleFail402, challenge402, settleFail402];
  await assert.rejects(
    solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, maxReactiveResigns: 1 }),
    (err: Error) => {
      assert.match(err.message, /did not go through after 1 re-signs/);
      assert.match(err.message, /Blockhash not found/);
      assert.match(err.message, /claimable.*job vid_1/);
      assert.match(err.message, /no charge was made/);
      assert.doesNotMatch(err.message, /rejected|balance|insufficient/i, "must not route to the top-up flow");
      return true;
    },
  );
  assert.equal(signaturesCreated, 2);
});

test("a permanent settle reason is a PaymentError routed to funding", async () => {
  script = [quote, () => submit(), () => settleFail402("insufficient funds for transfer")];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Payment was rejected.*insufficient funds.*claimable/);
  assert.equal(signaturesCreated, 1, "no re-sign against a wallet that cannot pay");
});

test("a poll answer carrying a receipt is settlement even when its body is malformed", async () => {
  script = [quote, () => submit(), () => ({ status: 200, ok: true, headers: headers({ "x-payment-receipt": "solana-tx" }), json: async () => { throw new SyntaxError("truncated"); } })];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.equal(r.paidUsd, 0.5);
  assert.deepEqual(r.data, {});
});

test("a completed body without a receipt is still returned, with no txHash", async () => {
  script = [quote, () => submit(), () => poll("completed", { data: [{ url: "u" }] }, false)];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, undefined);
  assert.equal((r.data.data as Array<{ url: string }>)[0].url, "u");
});

test("a completed status on a non-2xx poll is not trusted", async () => {
  script = [quote, () => submit(), () => ({ status: 500, ok: false, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "u" }] }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Video poll error 500/);
});

test("a failed job rejects without a receipt and a 504 is retried", async () => {
  script = [quote, () => submit(), () => ({ status: 504, ok: false, headers: headers(), json: async () => ({}) }), () => poll("failed", { error: "render exploded" })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /render exploded.*No payment was taken/);
  assert.equal(gets().length, 2);
});

test("deadline expiry reports the last status and the claimable job", async () => {
  script = [quote, () => submit(), ...Array.from({ length: 200 }, () => () => poll("in_progress"))];
  await assert.rejects(
    solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { pollBudgetMs: 30, pollIntervalMs: 1, resignIntervalMs: 60_000 }),
    /did not complete within 0s \(last status: in_progress\).*claimable.*job vid_1/,
  );
  script = [];
});

test("every request is clamped to the remaining budget (no request may outlive the deadline)", async () => {
  script = [quote, () => submit(), () => poll("in_progress"), () => poll("completed", { data: [{ url: "u" }] })];
  await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { pollBudgetMs: 5_000, pollIntervalMs: 1, resignIntervalMs: 60_000, pollTimeoutMs: 60_000, submitTimeoutMs: 30_000 });
  assert.equal(timeouts.length, 4);
  for (const t of timeouts) assert.ok(t > 0 && t <= 5_000, `timeout ${t} exceeds the 5s budget`);
  assert.ok(timeouts[1] <= 5_000 && timeouts[2] <= 5_000, "submit and poll were both clamped below their 30s/60s defaults");
});
