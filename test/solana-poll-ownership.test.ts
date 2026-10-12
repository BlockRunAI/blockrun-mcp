// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// Ownership-proof polling on the Solana wallet rail (utils/poll-ownership.ts,
// utils/solana-402.ts). The gateway contract is blockrun-sol
// src/lib/poll-ownership.ts (live 2026-10-10): pending polls carry x-poll-*
// instead of a payment, a finished video answers 402 for the ONE payment that
// settles it, music and image polls never sign a payment, and a refused proof
// falls back once to payment-signed polling.
//
// The signature is checked with node:crypto's own ed25519 verifier against the
// exact message the gateway rebuilds — not against this module's output.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import bs58 from "bs58";

// A real ed25519 keypair in the .solana-session layout: seed ‖ public key.
const { privateKey: kp, publicKey: kpub } = generateKeyPairSync("ed25519");
const seed = Buffer.from((kp.export({ format: "jwk" }) as { d: string }).d, "base64url");
const pub = Buffer.from((kpub.export({ format: "jwk" }) as { x: string }).x, "base64url");
const SECRET = new Uint8Array(Buffer.concat([seed, pub]));
const WALLET = bs58.encode(pub);

function headers(map: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

type Scripted = { url: string; method: string; headers: Record<string, string> };
let script: Array<() => unknown> = [];
let requests: Scripted[] = [];
let paymentsSigned = 0;
let failSignOnCall: number | null = null;
let signCalls = 0;
mock.module("../src/utils/http.js", {
  namedExports: {
    fetchWithTimeout: async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
      requests.push({ url, method: init.method || "GET", headers: init.headers || {} });
      const next = script.shift();
      if (!next) throw new Error("UNEXPECTED_NETWORK_CALL");
      return next();
    },
  },
});
mock.module("../src/utils/wallet.js", {
  namedExports: {
    resolveSolanaKey: () => "test-solana-key",
    solanaKeyUnavailableReason: () => undefined,
    getApiBase: () => "https://blockrun.ai/api",
    resolveGatewayUrl: (u: string) => u,
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
    solanaPublicKey: async () => WALLET,
    solanaKeyToBytes: async () => SECRET,
    // The payment-signer tripwire: every call is a signed SPL transfer.
    createSolanaPaymentPayload: async () => {
      signCalls++;
      if (failSignOnCall === signCalls) throw new Error("rpc blip");
      paymentsSigned++;
      return `signed-svm-payment-${paymentsSigned}`;
    },
    parsePaymentRequired: () => ({}),
    extractPaymentDetails: () => details,
  },
});

const { solanaPaidAsyncPost } = await import("../src/utils/solana-402.js");
const { createPollSigner, pollAuthMessage, pollRouteFor, POLL_AUTH_HEADERS } = await import("../src/utils/poll-ownership.js");
const { JobFailedError } = await import("../src/utils/poll.js");

const errLog = mock.method(console, "error", () => {});
beforeEach(() => {
  script = []; requests = []; paymentsSigned = 0; failSignOnCall = null; signCalls = 0; details = baseDetails();
  errLog.mock.resetCalls();
});
afterEach(() => { assert.equal(script.length, 0, "unconsumed scripted responses"); });

/** Independent check: the gateway's verifier, over the message it rebuilds. */
function verifiesFor(h: Record<string, string>, kind: string, jobId: string): boolean {
  const wallet = h[POLL_AUTH_HEADERS.wallet];
  const ts = h[POLL_AUTH_HEADERS.timestamp];
  const sig = h[POLL_AUTH_HEADERS.signature];
  if (!wallet || !ts || !sig) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bs58.decode(wallet)).toString("base64url") }, format: "jwk" });
  return verify(null, Buffer.from(`blockrun-poll:v1:${kind}:${jobId}:${ts}`, "utf8"), key, Buffer.from(bs58.decode(sig)));
}
const hasProof = (r: Scripted) => POLL_AUTH_HEADERS.signature in r.headers;
const gets = () => requests.filter((r) => r.method === "GET");

const VIDEO_POLL = "/api/v1/videos/generations/vid_1?model=x&duration=5&sig=abc";
const quote = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "quote" }), json: async () => ({}) });
const videoSubmit = () => ({ status: 202, ok: true, headers: headers(), json: async () => ({ id: "vid_1", status: "queued", poll_url: VIDEO_POLL }) });
const pending = (status = "in_progress") => ({ status: 202, ok: true, headers: headers(), json: async () => ({ status, payment_status: "not_charged" }) });
const completion402 = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "completion-challenge" }), json: async () => ({ error: "Payment Required", status: "completed", id: "vid_1" }) });
const settled = () => ({ status: 200, ok: true, headers: headers({ "x-payment-receipt": "solana-tx" }), json: async () => ({ status: "completed", data: [{ url: "https://blockrun.ai/media/vid_1.mp4" }] }) });
const fast = { pollBudgetMs: 10_000, pollIntervalMs: 1, resignIntervalMs: 60_000, submitMaySettle: false };

// ---- the proof itself ----

test("the proof verifies under node:crypto over the exact gateway message, and names the paying wallet", () => {
  const signer = createPollSigner(SECRET);
  assert.equal(signer.wallet, WALLET, "derived from the seed = bytes 32..63 of the keypair");
  const now = 1_791_590_400_123;
  const h = signer.headers("video", "vid_1", now);
  assert.equal(h[POLL_AUTH_HEADERS.timestamp], "1791590400", "unix SECONDS, floored");
  assert.equal(pollAuthMessage("video", "vid_1", 1791590400), "blockrun-poll:v1:video:vid_1:1791590400");
  assert.equal(bs58.decode(h[POLL_AUTH_HEADERS.signature]).length, 64);
  assert.equal(bs58.decode(h[POLL_AUTH_HEADERS.wallet]).length, 32);
  assert.ok(verifiesFor(h, "video", "vid_1"));
  // Bound to kind, job and timestamp: any other message fails.
  assert.equal(verifiesFor(h, "audio", "vid_1"), false);
  assert.equal(verifiesFor(h, "video", "vid_2"), false);
  assert.equal(verifiesFor({ ...h, [POLL_AUTH_HEADERS.timestamp]: "1791590401" }, "video", "vid_1"), false);
  // A fresh timestamp is a fresh signature.
  assert.notEqual(signer.headers("video", "vid_1", now + 5_000)[POLL_AUTH_HEADERS.signature], h[POLL_AUTH_HEADERS.signature]);
});

test("the poll route decides the kind and the job id; unknown routes get no proof", () => {
  const at = (p: string) => pollRouteFor(new URL(p, "https://sol.blockrun.ai"));
  assert.deepEqual(at(VIDEO_POLL), { kind: "video", jobId: "vid_1" });
  assert.deepEqual(at("/api/v1/audio/generations/aud_1"), { kind: "audio", jobId: "aud_1" });
  // An image EDIT is submitted to image2image and polled here.
  assert.deepEqual(at("/api/v1/images/generations/img%3A1"), { kind: "image", jobId: "img:1" });
  assert.equal(at("/api/v1/videos/vid_1"), null);
  assert.equal(at("/api/v1/videos/generations/"), null);
});

// ---- video: payment on completion ----

test("video: pending polls carry a fresh proof and never call the payment signer; completion signs exactly one payment", async () => {
  const events: string[] = [];
  script = [quote, videoSubmit, () => pending("queued"), () => pending(), () => { throw new TypeError("reset"); }, () => pending(), completion402, settled];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, {
    ...fast,
    onPaidRequest: () => events.push(`armed@${requests.length}`),
    onPaidResponse: () => events.push("settled"),
  });
  assert.equal(r.txHash, "solana-tx");
  assert.equal(r.paidUsd, 0.5);
  const polls = gets();
  assert.equal(polls.length, 6);
  const proofPolls = polls.slice(0, 5);
  for (const p of proofPolls) {
    assert.ok(hasProof(p), "pending polls carry the proof");
    assert.equal(p.headers["PAYMENT-SIGNATURE"], undefined, "and no payment");
    assert.ok(verifiesFor(p.headers, "video", "vid_1"));
    assert.equal(p.url, `https://sol.blockrun.ai${VIDEO_POLL}`, "poll_url verbatim (its query is HMAC-bound)");
  }
  // Submit (1) + the completion payment (2): nothing signed while pending.
  assert.equal(paymentsSigned, 2);
  const paid = polls[5];
  assert.equal(paid.headers["PAYMENT-SIGNATURE"], "signed-svm-payment-2", "the payment from the completion challenge");
  assert.equal(hasProof(paid), false);
  // The tracker sees exactly two payment-bearing requests: submit and the settling poll.
  assert.deepEqual(events, ["armed@1", "settled", "armed@7", "settled"]);
});

test("video: a finished job polled again after settlement is delivered without another payment", async () => {
  script = [quote, videoSubmit, () => pending(), () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "u" }], payment: { status: "already_settled" } }) })];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal((r.data.data as Array<{ url: string }>)[0].url, "u");
  assert.equal(paymentsSigned, 1, "the submit only");
});

test("video: a failed job on a proof poll is uncharged and signs nothing", async () => {
  script = [quote, videoSubmit, () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "failed", error: "boom", payment_status: "not_charged" }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
    assert.ok(err instanceof JobFailedError);
    assert.match(err.message, /No payment was taken/);
    return true;
  });
  assert.equal(paymentsSigned, 1);
});

test("video: a completion challenge that re-prices, re-routes or re-sponsors the job is refused unsigned", async () => {
  for (const mutation of [{ amount: "900000" }, { recipient: "someone-else" }, { extra: { feePayer: "other" } }]) {
    script = [quote, videoSubmit, () => { details = { ...baseDetails(), ...mutation }; return completion402(); }];
    await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /changed the payment amount, recipient or fee payer.*No charge was made/);
    assert.equal(paymentsSigned, 1, "nothing signed after the submit");
    details = baseDetails(); paymentsSigned = 0; requests = [];
  }
});

test("video: a signing failure on the completion payment retries on the next proof poll", async () => {
  failSignOnCall = 2;
  script = [quote, videoSubmit, completion402, completion402, settled];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.equal(paymentsSigned, 2);
  assert.deepEqual(gets().map(hasProof), [true, true, false]);
});

test("video: an unpaid completion challenge is not a result — a later 2xx with no status and no receipt keeps polling", async () => {
  // The 402 said "completed", but nothing has settled. A bodiless 202 on the
  // settling poll must not be read as the delivered video (it would book the
  // quote and fail on the missing URL); only the receipt or the response's
  // OWN status can end the job.
  const bodiless = () => ({ status: 202, ok: true, headers: headers(), json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } });
  script = [quote, videoSubmit, completion402, bodiless, settled];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.equal((r.data.data as Array<{ url: string }>)[0].url, "https://blockrun.ai/media/vid_1.mp4");
  assert.equal(paymentsSigned, 2, "submit + the one completion payment");
});

test("video: a stale-blockhash 402 on the settling poll uses the existing re-sign path", async () => {
  const fail = Buffer.from(JSON.stringify({ success: false, errorReason: "Blockhash not found" })).toString("base64");
  script = [
    quote, videoSubmit, completion402,
    () => ({ status: 402, ok: false, headers: headers({ "payment-response": fail }), json: async () => ({}) }),
    () => ({ status: 402, ok: false, headers: headers({ "payment-required": "fresh" }), json: async () => ({}) }),
    settled,
  ];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.equal(paymentsSigned, 3, "submit + completion + one reactive re-sign");
});

test("video: the deadline during proof polling says no charge was made — no payment was outstanding", async () => {
  script = [quote, videoSubmit, ...Array.from({ length: 400 }, () => () => pending())];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, pollBudgetMs: 40 }), (err: Error) => {
    assert.match(err.message, /did not complete within/);
    assert.match(err.message, /no charge was made/);
    assert.doesNotMatch(err.message, /can settle server-side/);
    return true;
  });
  script = [];
  assert.equal(paymentsSigned, 1);
});

// ---- music & image: paid at submit ----

for (const [label, endpoint, pollPath, kind] of [
  ["music", "/v1/audio/generations", "/api/v1/audio/generations/aud_1", "audio"],
  ["image", "/v1/images/image2image", "/api/v1/images/generations/aud_1", "image"],
] as const) {
  const submitted = () => ({
    status: 202, ok: true, headers: headers({ "x-payment-optimistic": "true" }),
    json: async () => ({ id: "aud_1", status: "queued", poll_url: pollPath, payment_status: "settled_optimistic" }),
  });

  test(`${label}: polls carry the "${kind}" proof and never sign a payment`, async () => {
    const events: string[] = [];
    script = [quote, submitted, () => pending("queued"), () => pending(), () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "u" }] }) })];
    const r = await solanaPaidAsyncPost(endpoint, { prompt: "t" }, {
      ...fast, submitMaySettle: true,
      onPaidRequest: () => events.push("armed"), onPaidResponse: () => events.push("settled"),
    });
    assert.equal(r.paidUsd, 0.5);
    assert.equal(paymentsSigned, 1, "the submit only");
    assert.deepEqual(events, ["armed", "settled"], "only the submit carried a payment");
    for (const p of gets()) {
      assert.equal(p.headers["PAYMENT-SIGNATURE"], undefined);
      assert.ok(verifiesFor(p.headers, kind, "aud_1"));
    }
  });

  test(`${label}: a refused proof ("Job not found") falls back ONCE to payment-signed polling, and logs it`, async () => {
    script = [
      quote, submitted,
      () => ({ status: 404, ok: false, headers: headers(), json: async () => ({ error: "Job not found" }) }),
      () => pending(),
      () => pending(),
      () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "u" }] }) }),
    ];
    const r = await solanaPaidAsyncPost(endpoint, { prompt: "t" }, { ...fast, submitMaySettle: true });
    assert.equal(r.paidUsd, 0.5);
    assert.deepEqual(gets().map(hasProof), [true, false, false, false], "never back to the proof");
    assert.ok(gets().slice(1).every((g) => typeof g.headers["PAYMENT-SIGNATURE"] === "string"));
    assert.equal(paymentsSigned, 2, "the submit + one fresh re-sign before the first paid poll");
    assert.equal(errLog.mock.callCount(), 1);
    const line = String(errLog.mock.calls[0].arguments[0]);
    assert.match(line, /refused the ownership proof.*404.*aud_1/);
    assert.doesNotMatch(line, new RegExp(bs58.encode(SECRET)), "never the key");
  });

  test(`${label}: a batch-style 402 on a proof poll takes the existing payment path`, async () => {
    script = [
      quote, submitted,
      () => ({ status: 402, ok: false, headers: headers(), json: async () => ({ error: "Batch payment required" }) }),
      () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "u" }] }) }),
    ];
    await solanaPaidAsyncPost(endpoint, { prompt: "t" }, { ...fast, submitMaySettle: true });
    assert.deepEqual(gets().map(hasProof), [true, false]);
  });
}

test("video: a refused proof (400 Invalid job id) falls back once; a real 404 elsewhere is not a refusal", async () => {
  script = [quote, videoSubmit, () => ({ status: 400, ok: false, headers: headers(), json: async () => ({ error: "Invalid job id" }) }), settled];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.deepEqual(gets().map(hasProof), [true, false]);
  assert.equal(errLog.mock.callCount(), 1);

  // The video route's refusal is 400 "Invalid job id"; a 404 there is a fault.
  requests = [];
  script = [quote, videoSubmit, () => ({ status: 404, ok: false, headers: headers(), json: async () => ({ error: "Job not found" }) })];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), /poll error 404/);
});

test("video: a gateway that ignores the proof (generic 402, no status) falls back to payment-signed polling", async () => {
  script = [quote, videoSubmit, () => ({ status: 402, ok: false, headers: headers({ "payment-required": "x" }), json: async () => ({ error: "Payment Required" }) }), () => pending(), settled];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.deepEqual(gets().map(hasProof), [true, false, false]);
});

test("pollOwnership:false keeps payment-signed polling from the first poll", async () => {
  script = [quote, videoSubmit, settled];
  await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, pollOwnership: false });
  assert.equal(hasProof(gets()[0]), false);
  assert.equal(gets()[0].headers["PAYMENT-SIGNATURE"], "signed-svm-payment-1");
});

// ---- the settling poll: an outcome the gateway itself does not know ----
//
// The gateway answers a settle that timed out with 402 "Payment settlement
// outcome unknown" + Retry-After: 90 and HOLDS the job's claim with that
// authorization recorded; until it resolves on chain, every other poll gets
// "settlement in progress on a concurrent poll". That payment may still land.
// Every finished video now reaches this path on its first paid poll, so the
// helper must wait as told instead of burning its re-sign budget in seconds,
// and must never report "no charge" while that outcome is open.
const reasonHeader = (errorReason: string) => Buffer.from(JSON.stringify({ success: false, errorReason })).toString("base64");
const outcomeUnknown = (retryAfter = "0.03") => ({
  status: 402, ok: false,
  headers: headers({ "payment-response": reasonHeader("facilitator_timeout"), "retry-after": retryAfter }),
  json: async () => ({ error: "Payment settlement outcome unknown", status: "completed" }),
});
const heldByConcurrentPoll = () => ({
  status: 402, ok: false,
  headers: headers({ "payment-response": reasonHeader("settlement in progress on a concurrent poll") }),
  json: async () => ({ error: "Payment Required" }),
});
const alreadySettled = () => ({ status: 200, ok: true, headers: headers(), json: async () => ({ status: "completed", data: [{ url: "u" }], payment: { status: "already_settled" } }) });

test("video: an unknown settle outcome is waited out (Retry-After), not given up on after the re-sign budget", async () => {
  const at: number[] = [];
  const stamp = (f: () => unknown) => () => { at.push(Date.now()); return f(); };
  script = [quote, videoSubmit, completion402, stamp(() => outcomeUnknown()), stamp(heldByConcurrentPoll), heldByConcurrentPoll, heldByConcurrentPoll, heldByConcurrentPoll, alreadySettled];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, maxReactiveResigns: 3 });
  assert.equal((r.data.data as Array<{ url: string }>)[0].url, "u", "the held payment landed: delivered, not abandoned");
  assert.ok(at[1] - at[0] >= 25, `waited the gateway's Retry-After before re-polling (${at[1] - at[0]}ms)`);
  // Every request after the completion challenge carried a payment; no unpaid challenge fetches while held.
  assert.ok(gets().slice(1).every((g) => typeof g.headers["PAYMENT-SIGNATURE"] === "string"));
});

test("video: a deadline while the settle outcome is unknown is booked as MAY have been charged, never 'no charge'", async () => {
  const { BilledJobError } = await import("../src/utils/api-key-call.js");
  script = [quote, videoSubmit, completion402, () => outcomeUnknown("0.02"), ...Array.from({ length: 400 }, () => heldByConcurrentPoll)];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, pollBudgetMs: 300, pollIntervalMs: 5 }), (err: Error) => {
    assert.ok(err instanceof BilledJobError, `typed so the tool books it (got ${err.name}: ${err.message})`);
    assert.equal((err as InstanceType<typeof BilledJobError>).billing, "unknown");
    assert.equal((err as InstanceType<typeof BilledJobError>).paidUsd, 0.5);
    assert.doesNotMatch(err.message, /no charge was made/i);
    assert.match(err.message, /may/i);
    return true;
  });
  script = [];
});

test("video: a completion 402 whose challenge cannot be read falls back to payment-signed polling, not an abort", async () => {
  // No payment-required header and no accepts in the body: the paid path
  // fetches and validates its own challenge, so the finished clip is still collected.
  const unreadable = () => ({ status: 402, ok: false, headers: headers(), json: async () => ({ error: "Payment Required", status: "completed" }) });
  script = [quote, videoSubmit, unreadable, settled];
  const r = await solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast);
  assert.equal(r.txHash, "solana-tx");
  assert.deepEqual(gets().map(hasProof), [true, false]);
  assert.equal(paymentsSigned, 2, "submit + one fresh signature for the paid poll");
});

test("video: after a hold, a 402 with no PAYMENT-RESPONSE is a refusal on the bounded re-sign path, not another hold", async () => {
  // The route's "Payment verification failed" 402 carries no PAYMENT-RESPONSE.
  // A sticky "last reason" from the earlier hold must not re-classify it as
  // held: that would re-sign an SPL transaction every poll interval for the
  // whole budget and never reach the re-sign ceiling.
  const verificationFailed = () => ({ status: 402, ok: false, headers: headers(), json: async () => ({ error: "Payment verification failed" }) });
  const freshChallenge = () => ({ status: 402, ok: false, headers: headers({ "payment-required": "fresh" }), json: async () => ({}) });
  script = [
    quote, videoSubmit, completion402, () => outcomeUnknown("0.01"), heldByConcurrentPoll,
    verificationFailed, freshChallenge, verificationFailed, freshChallenge, verificationFailed,
  ];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, { ...fast, maxReactiveResigns: 2 }), (err: Error) => {
    assert.match(err.message, /did not go through after 2 re-signs/);
    assert.doesNotMatch(err.message, /no charge was made/i, "a held payment may have landed");
    return true;
  });
  // Two unpaid challenge fetches = the two reactive re-signs, then the ceiling.
  assert.equal(gets().filter((g) => !hasProof(g) && g.headers["PAYMENT-SIGNATURE"] === undefined).length, 2);
});

test("video: every give-up after a hold is booked as MAY have been charged — a 500 poll answer included", async () => {
  const { BilledJobError } = await import("../src/utils/api-key-call.js");
  const serverError = () => ({ status: 500, ok: false, headers: headers(), json: async () => ({ error: "Internal server error" }) });
  script = [quote, videoSubmit, completion402, () => outcomeUnknown("0.01"), serverError];
  await assert.rejects(solanaPaidAsyncPost("/v1/videos/generations", { prompt: "t" }, fast), (err: Error) => {
    assert.ok(err instanceof BilledJobError, `got ${err.name}: ${err.message}`);
    assert.equal((err as InstanceType<typeof BilledJobError>).billing, "unknown");
    assert.match(err.message, /poll error 500/);
    assert.match(err.message, /MAY have been charged/);
    return true;
  });
});
