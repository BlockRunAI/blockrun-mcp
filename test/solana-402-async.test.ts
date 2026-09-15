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
// What solanaKeyUnavailableReason() answers when there is no key: undefined
// means "no wallet anywhere", a string means "the keychain would not open".
let keyUnavailableReason: string | undefined;
mock.module("../src/utils/wallet.js", {
  namedExports: {
    resolveSolanaKey: () => walletKey,
    solanaKeyUnavailableReason: () => (walletKey ? undefined : keyUnavailableReason),
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => (u.startsWith("http") ? u : `https://blockrun.ai/api${u.startsWith("/api/") ? u.slice(4) : u}`),
  },
});

const baseDetails = () => ({
  network: "solana:mainnet",
  recipient: "recipient",
  amount: "500000",
  extra: { feePayer: "fee-payer" },
  resource: { url: "https://sol.blockrun.ai/api/v1/videos/generations" },
});
let details: Record<string, unknown> = baseDetails();
class FakePaymentError extends Error { constructor(m: string) { super(m); this.name = "PaymentError"; } }
mock.module("@blockrun/llm", {
  namedExports: {
    SolanaLLMClient: { SOLANA_API_URL: "https://sol.blockrun.ai/api" },
    PaymentError: FakePaymentError,
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

const { solanaPaidAsyncPost, solanaPaidPost } = await import("../src/utils/solana-402.js");
const { JobFailedError } = await import("../src/utils/poll.js");
const { BilledJobError } = await import("../src/utils/api-key-call.js");

beforeEach(() => {
  script = []; requests = []; signaturesCreated = 0; signOptions = []; timeouts = [];
  failSignOnCall = null; signCalls = 0; walletKey = "test-solana-key"; keyUnavailableReason = undefined; details = baseDetails();
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

// D3/D30: 783cfb3 taught buildSolanaClient that "the keychain would not open"
// is not "no wallet" — telling that user to run setup invites a second wallet
// — and left the two manual-402 helpers saying the old thing. Both helpers
// now say what buildSolanaClient says, and neither is a funding error: image's
// catch turns a PaymentError into "out of funds", which is wrong twice over.
for (const [label, run] of [
  ["solanaPaidAsyncPost", () => solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast)],
  ["solanaPaidPost", () => solanaPaidPost("/v1/images/generations", { prompt: "t" }, 1_000)],
] as const) {
  test(`${label}: a locked keychain is 'unlock and retry', never 'run setup', and not a funding error`, async () => {
    walletKey = undefined;
    keyUnavailableReason = "the OS keychain could not be read (security exit 51)";
    await assert.rejects(run(), (err: Error) => {
      assert.match(err.message, /Cannot reach your Solana wallet key/);
      assert.match(err.message, /security exit 51/);
      assert.match(err.message, /unlock it and retry/);
      assert.match(err.message, /Nothing was charged/);
      assert.doesNotMatch(err.message, /action:"setup"|No Solana wallet/, "must not invite a second wallet");
      assert.notEqual(err.name, "PaymentError", "a locked keychain is not an empty wallet");
      return true;
    });
    assert.equal(requests.length, 0);
  });

  test(`${label}: no wallet anywhere names setup as the remedy and is not a funding error`, async () => {
    walletKey = undefined;
    keyUnavailableReason = undefined;
    await assert.rejects(run(), (err: Error) => {
      assert.match(err.message, /No Solana wallet on this machine yet/);
      assert.match(err.message, /action:"setup"/);
      assert.match(err.message, /Nothing was charged/);
      assert.notEqual(err.name, "PaymentError");
      return true;
    });
    assert.equal(requests.length, 0);
  });
}

test("a paid route that answers 2xx instead of a quote is a fault, not a free render", async () => {
  script = [() => ({ status: 200, ok: true, headers: headers(), json: async () => ({ data: [{ url: "u" }] }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Unexpected status 200/);
  assert.equal(signaturesCreated, 0);
});

test("a rejected paid submit is a PaymentError and issues no polls", async () => {
  script = [quote, quote];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
    assert.match(err.message, /Payment was rejected/);
    assert.ok(err instanceof FakePaymentError, "a 402 on the paid submit with no reason is a funding problem");
    return true;
  });
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
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /Video generation poll error 500/);
});

test("a failed job rejects without a receipt and a 504 is retried", async () => {
  script = [quote, () => submit(), () => ({ status: 504, ok: false, headers: headers(), json: async () => ({}) }), () => poll("failed", { error: "render exploded" })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
    assert.match(err.message, /render exploded.*No payment was taken/);
    // Typed, so a tool can recognise the verdict when the upstream text says
    // "aborted due to timeout" (C13) — the prose is the gateway's, not ours.
    assert.ok(err instanceof JobFailedError, `expected JobFailedError, got ${err.name}`);
    assert.equal((err as InstanceType<typeof JobFailedError>).jobId, "vid_1");
    return true;
  });
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

// ---------------------------------------------------------------------------
// Round-3 additions: the paid-request hooks, the 402 classification, the
// caller labels, settled-at-submit routes, and the deadline wording.
// ---------------------------------------------------------------------------

test("onPaidRequest fires immediately before every request carrying PAYMENT-SIGNATURE and onPaidResponse after each answer", async () => {
  const events: string[] = [];
  script = [
    () => { events.push("quote"); return quote(); },
    () => { events.push("submit"); return submit(); },
    () => { events.push("poll1"); throw new TypeError("transient disconnect"); },
    () => { events.push("poll2"); return poll("in_progress"); },
    () => { events.push("poll3"); return poll("completed", { data: [{ url: "u" }] }); },
  ];
  await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, {
    ...fast,
    onQuote: () => events.push("onQuote"),
    onPaidRequest: () => events.push("armed"),
    onPaidResponse: () => events.push("settled"),
  });
  // Nothing is armed around the unpaid quote; every signed request is armed
  // before it leaves and settled only when an answer arrives — the dropped
  // poll leaves the tracker armed, which is the whole point.
  assert.deepEqual(events, ["quote", "onQuote", "armed", "submit", "settled", "armed", "poll1", "armed", "poll2", "settled", "armed", "poll3", "settled"]);
});

test("the unpaid re-sign challenge GET is not a paid request and fires neither hook", async () => {
  const events: string[] = [];
  script = [quote, () => submit(), settleFail402, () => { events.push("challenge"); return challenge402(); }, () => poll("completed", { data: [{ url: "u" }] })];
  await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, {
    ...fast,
    onPaidRequest: () => events.push("armed"),
    onPaidResponse: () => events.push("settled"),
  });
  assert.deepEqual(events, ["armed", "settled", "armed", "settled", "challenge", "armed", "settled"]);
});

test("solanaPaidPost arms before the paid POST only, and settles on its answer", async () => {
  const events: string[] = [];
  script = [
    () => { events.push("quote"); return quote(); },
    () => { events.push("paid"); return { status: 200, ok: true, headers: headers({ "x-payment-receipt": "tx" }), json: async () => ({ data: [{ url: "u" }] }) }; },
  ];
  const r = await solanaPaidPost("/v1/images/generations", { prompt: "t" }, 1_000, {
    onQuote: () => events.push("onQuote"),
    onPaidRequest: () => events.push("armed"),
    onPaidResponse: () => events.push("settled"),
  });
  assert.equal(r.paidUsd, 0.5);
  assert.deepEqual(events, ["quote", "onQuote", "armed", "paid", "settled"]);
});

test("a signing failure after onQuote never reaches onPaidRequest — nothing carrying a payment left the machine", async () => {
  let armed = 0;
  failSignOnCall = 1;
  script = [quote];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, onPaidRequest: () => { armed++; } }), /rpc blip/);
  assert.equal(armed, 0);
  assert.equal(posts().length, 1, "only the unpaid quote went out");
});

// D2: the gateway's PAYMENT-RESPONSE reason splits into two very different
// remedies. "insufficient" is the wallet; everything else on the permanent
// list is the signature or the authorization — sending that user to a
// Coinbase top-up page is the wrong door, and isPaymentRejectionError's
// substring match ("rejected", "balance") is exactly what routed it there.
const INVALID_AUTH_REASONS = ["invalid signature", "invalid payment", "unauthorized", "forbidden", "invalid_payload", "expired"];
for (const reason of INVALID_AUTH_REASONS) {
  test(`a paid submit 402 whose reason is '${reason}' is a signing/authorization fault, not a funding error`, async () => {
    script = [quote, () => ({ status: 402, ok: false, headers: headers({ "payment-response": paymentResponse(`verify failed: ${reason}`) }), json: async () => ({ error: "Payment verification failed" }) })];
    await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
      assert.notEqual(err.name, "PaymentError");
      assert.match(err.message, /refused the payment signature/);
      assert.match(err.message, /signing\/authorization fault, not a funding problem/);
      assert.match(err.message, new RegExp(reason.replace("_", "_")));
      assert.match(err.message, /no charge was made/i);
      assert.doesNotMatch(err.message, /rejected|balance|insufficient/i, "must not route to the top-up branch");
      return true;
    });
    assert.equal(gets().length, 0);
  });

  test(`a settle-time poll 402 whose reason is '${reason}' names the claimable job and is not a funding error`, async () => {
    script = [quote, () => submit(), () => settleFail402(`settle failed: ${reason}`)];
    await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
      assert.notEqual(err.name, "PaymentError");
      assert.match(err.message, /refused the payment signature while settling the completed job/);
      assert.match(err.message, /not a funding problem/);
      assert.match(err.message, /no charge was made/i);
      assert.match(err.message, /claimable.*job vid_1/);
      assert.doesNotMatch(err.message, /rejected|balance|insufficient/i);
      return true;
    });
    assert.equal(signaturesCreated, 1, "no re-sign against a signature the gateway refused outright");
  });
}

test("a paid submit 402 whose reason says 'insufficient' stays a PaymentError, with the reason", async () => {
  script = [quote, () => ({ status: 402, ok: false, headers: headers({ "payment-response": paymentResponse("insufficient funds for transfer") }), json: async () => ({}) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
    assert.ok(err instanceof FakePaymentError);
    assert.match(err.message, /Payment was rejected.*insufficient funds/);
    return true;
  });
});

test("solanaPaidPost classifies its paid-POST 402 the same way", async () => {
  script = [quote, () => ({ status: 402, ok: false, headers: headers({ "payment-response": paymentResponse("invalid signature") }), json: async () => ({}) })];
  await assert.rejects(solanaPaidPost("/v1/images/generations", { prompt: "t" }, 1_000), (err: Error) => {
    assert.notEqual(err.name, "PaymentError");
    assert.match(err.message, /signing\/authorization fault/);
    assert.match(err.message, /no charge was made/i);
    assert.doesNotMatch(err.message, /rejected|balance|insufficient/i);
    return true;
  });
  script = [quote, () => ({ status: 402, ok: false, headers: headers(), json: async () => ({}) })];
  await assert.rejects(solanaPaidPost("/v1/images/generations", { prompt: "t" }, 1_000), (err: Error) => err instanceof FakePaymentError);
});

test("quote-validation refusals are gateway faults, not funding errors", async () => {
  // Every one of these says "no charge was made" and none is the wallet's
  // fault; image.ts turns a PaymentError into "out of funds" plus a top-up note.
  const cases: Array<[string, () => void, Array<() => unknown>, RegExp]> = [
    ["non-Solana network", () => { details = { ...baseDetails(), network: "eip155:8453" }; }, [quote], /Expected a Solana payment quote/],
    ["missing feePayer", () => { details = { ...baseDetails(), extra: {} }; }, [quote], /Missing feePayer/],
    ["unreadable amount", () => { details = { ...baseDetails(), amount: "x" }; }, [quote], /unreadable amount/],
    ["off-gateway poll", () => {}, [quote, () => submit("https://evil.example/poll")], /off-gateway poll URL/],
    ["mutated challenge", () => {}, [quote, () => submit(), settleFail402, () => { details = { ...baseDetails(), amount: "900000" }; return challenge402(); }], /changed the payment amount/],
  ];
  for (const [label, arrange, wire, expect] of cases) {
    details = baseDetails(); arrange(); script = wire;
    await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
      assert.match(err.message, expect, label);
      assert.notEqual(err.name, "PaymentError", `${label}: not a funding error`);
      return true;
    });
    details = baseDetails(); requests = []; signaturesCreated = 0;
  }
});

// D1/D22: music routes its Solana rail through this helper and every give-up
// said "Video generation" and "re-running blockrun_video".
test("the caller's labels reach every message; the defaults are video's", async () => {
  const music = { ...fast, what: "Music generation", tool: "blockrun_music" };
  script = [quote, () => submit(), () => poll("failed", { error: "boom" })];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music), (err: Error) => {
    assert.match(err.message, /^Music generation failed upstream: boom/);
    assert.doesNotMatch(err.message, /video/i);
    return true;
  });
  script = [quote, () => submit(), ...Array.from({ length: 200 }, () => () => poll("in_progress"))];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, { ...music, pollBudgetMs: 30 }), (err: Error) => {
    assert.match(err.message, /^Music generation did not complete within/);
    assert.match(err.message, /re-running blockrun_music would start and charge a new job/);
    assert.doesNotMatch(err.message, /video/i);
    return true;
  });
  script = [];
  script = [quote, () => submit(), () => ({ status: 500, ok: false, headers: headers(), json: async () => ({}) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music), /Music generation poll error 500/);
  script = [quote, () => submit(), ...Array.from({ length: 200 }, () => () => poll("in_progress"))];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, pollBudgetMs: 30 }), /Video generation did not complete within.*re-running blockrun_video/);
  script = [];
});

// The deadline message says what the helper KNOWS. With the hooks it knows
// whether a signed poll was outstanding when the budget ran out; before, it
// always said "a poll still in flight can settle" and the tools booked on it.
test("deadline with the last poll answered: no request is outstanding, so no charge was made", async () => {
  script = [quote, () => submit(), ...Array.from({ length: 200 }, () => () => poll("in_progress"))];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, pollBudgetMs: 30 }), (err: Error) => {
    assert.match(err.message, /last poll was answered/);
    assert.match(err.message, /no charge was made/i);
    assert.doesNotMatch(err.message, /still in flight/);
    return true;
  });
  script = [];
});

test("deadline with the last poll dropped: a signed poll is still in flight and can settle server-side", async () => {
  let n = 0;
  script = [quote, () => submit(), ...Array.from({ length: 200 }, () => () => { n++; throw new TypeError("fetch failed"); })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, pollBudgetMs: 30 }), (err: Error) => {
    assert.match(err.message, /still in flight at the deadline/);
    assert.match(err.message, /can settle server-side/);
    assert.doesNotMatch(err.message, /no charge was made/i);
    return true;
  });
  assert.ok(n >= 1);
  script = [];
});

// Settled-at-submit routes. sol.blockrun.ai's audio route (blockrun_music)
// settles the SPL transfer OPTIMISTICALLY when the POST is accepted — the
// 202 says payment_status "settled_optimistic" and carries X-Payment-Optimistic
// — and the poll GET is pure delivery. So on that route a failed job, a
// deadline or a poll error is a CERTAIN charge, not "no payment was taken",
// and the helper hands the tool the same BilledJobError the account rail uses.
const optimistic202 = () => ({
  status: 202, ok: true, headers: headers({ "x-payment-optimistic": "true" }),
  json: async () => ({ id: "aud_1", status: "queued", poll_url: "/api/v1/audio/generations/aud_1", payment_status: "settled_optimistic" }),
});
const bodyOnly202 = () => ({
  status: 202, ok: true, headers: headers(),
  json: async () => ({ id: "aud_1", status: "queued", poll_url: "/api/v1/audio/generations/aud_1", payment_status: "settled_optimistic" }),
});
const music = { ...fast, what: "Music generation", tool: "blockrun_music" };

test("settled-at-submit: a failed job is a BilledJobError carrying the quote and the job — the charge stands", async () => {
  for (const submitted of [optimistic202, bodyOnly202]) {
    script = [quote, submitted, () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "failed", error: "The operation was aborted due to timeout", note: "Payment was settled optimistically at POST" }) })];
    await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music), (err: Error) => {
      assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${err.name}: ${err.message}`);
      const billed = err as InstanceType<typeof BilledJobError>;
      assert.equal(billed.billing, "billed");
      assert.equal(billed.paidUsd, 0.5);
      assert.equal(billed.jobId, "aud_1");
      assert.match(err.message, /^Music generation failed upstream: The operation was aborted due to timeout/);
      assert.match(err.message, /settled .*at submit/i);
      assert.match(err.message, /charge stands/);
      assert.doesNotMatch(err.message, /No payment was taken|no charge was made/i);
      return true;
    });
    requests = []; signaturesCreated = 0;
  }
});

test("settled-at-submit: the deadline and a poll error are BilledJobErrors that name the claimable job", async () => {
  script = [quote, optimistic202, ...Array.from({ length: 200 }, () => () => poll("in_progress"))];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, { ...music, pollBudgetMs: 30 }), (err: Error) => {
    assert.ok(err instanceof BilledJobError);
    assert.match(err.message, /did not complete within/);
    assert.match(err.message, /charge stands/);
    assert.match(err.message, /claimable.*job aud_1.*re-running blockrun_music/);
    assert.doesNotMatch(err.message, /no charge was made|can settle server-side/i);
    return true;
  });
  script = [];
  script = [quote, optimistic202, () => ({ status: 500, ok: false, headers: headers(), json: async () => ({ error: "boom" }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music), (err: Error) => {
    assert.ok(err instanceof BilledJobError);
    assert.match(err.message, /poll error 500/);
    assert.match(err.message, /charge stands/);
    return true;
  });
});

test("settled-at-submit: a completed poll with no receipt header still returns the quote as paid", async () => {
  script = [quote, optimistic202, () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "https://blockrun.ai/media/t.mp3" }], payment: { status: "settled_at_post" } }) })];
  const r = await solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music);
  assert.equal(r.paidUsd, 0.5);
  assert.equal(r.jobId, "aud_1");
  assert.equal(r.txHash, undefined);
});

// Audit round 4: every escape from the post-submit loop, not just the ones
// the round-3 branch enumerated. The reactive re-sign path could still throw
// a plain "No charge was made" (a mutated challenge, a quote it could not
// parse) or a bare RPC error from the re-sign, and music then reported
// "failed"/"No payment was taken" with nothing booked — for a track the
// gateway had settled at POST.
test("settled-at-submit: every post-submit escape is a BilledJobError — re-sign refusals and RPC faults included", async () => {
  // A re-priced challenge on a settled route: the refusal stands, but the
  // charge does too.
  script = [quote, optimistic202, settleFail402, () => { details = { ...baseDetails(), amount: "900000" }; return challenge402(); }];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music), (err: Error) => {
    assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${err.name}: ${err.message}`);
    assert.match(err.message, /changed the payment amount/);
    assert.match(err.message, /charge stands/);
    assert.doesNotMatch(err.message, /no charge was made/i);
    assert.equal((err as InstanceType<typeof BilledJobError>).paidUsd, 0.5);
    return true;
  });
  details = baseDetails(); requests = []; signaturesCreated = 0;

  // A fresh challenge with no readable requirements.
  script = [quote, optimistic202, settleFail402, () => ({ status: 402, ok: false, headers: headers(), json: async () => ({}) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music), (err: Error) => {
    assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${err.name}: ${err.message}`);
    assert.match(err.message, /no payment requirements/);
    assert.match(err.message, /charge stands/);
    assert.doesNotMatch(err.message, /no charge was made/i);
    return true;
  });
  requests = []; signaturesCreated = 0;

  // The re-sign itself fails (RPC) on the reactive path.
  script = [quote, optimistic202, settleFail402, challenge402];
  signCalls = 0; failSignOnCall = 2;
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, music), (err: Error) => {
    assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${err.name}: ${err.message}`);
    assert.match(err.message, /rpc blip/);
    assert.match(err.message, /charge stands/);
    return true;
  });
  requests = []; signaturesCreated = 0; failSignOnCall = null; signCalls = 0;

  // Re-sign exhaustion on a settled route is a charge, not "no charge".
  script = [quote, optimistic202, settleFail402, challenge402, settleFail402];
  await assert.rejects(solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, { ...music, maxReactiveResigns: 1 }), (err: Error) => {
    assert.ok(err instanceof BilledJobError, `expected BilledJobError, got ${err.name}: ${err.message}`);
    assert.match(err.message, /did not go through after 1 re-signs/);
    assert.match(err.message, /charge stands/);
    assert.doesNotMatch(err.message, /no charge was made/i);
    return true;
  });
});

test("payment-on-completion routes keep their plain refusals: a re-priced challenge is not a billed job", async () => {
  script = [quote, () => submit(), settleFail402, () => { details = { ...baseDetails(), amount: "900000" }; return challenge402(); }];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
    assert.equal(err instanceof BilledJobError, false);
    assert.match(err.message, /No charge was made/);
    return true;
  });
  details = baseDetails();
});

test("payment-on-completion routes (video) are untouched by the settled-at-submit branch", async () => {
  script = [quote, () => submit(), () => poll("failed", { error: "boom", payment_status: "not_charged" })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
    assert.ok(err instanceof JobFailedError);
    assert.equal(err instanceof BilledJobError, false);
    return true;
  });
});

// C15: the Solana audio route holds the paid POST inline for up to 60s and
// settles at POST regardless; the helper's 30s default was sized for the
// always-202 video route. The submit timeout is per-route, and the caller's
// value must reach the wire.
test("submitTimeoutMs is honoured on the paid submit", async () => {
  script = [quote, optimistic202, () => poll("completed", { data: [{ url: "u" }] }, false)];
  await solanaPaidAsyncPost("/v1/audio/generations", { prompt: "t" }, { ...music, submitTimeoutMs: 95_000, pollBudgetMs: 240_000 });
  assert.equal(timeouts[1], 95_000, `paid submit timeout was ${timeouts[1]}`);
});
