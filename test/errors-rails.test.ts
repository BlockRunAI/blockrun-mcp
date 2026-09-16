// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// formatError's rail awareness (audit round 3, C28 + C38). The formatter is
// the last word every tool without a bespoke formatter gets, so the two
// sentences it appends about MONEY have to be true on all three rails:
//
//   C28 — a 402 on the ACCOUNT rail means "out of prepaid credit". Since the
//         0.50.0 status-boundary change admitted the SDK's "account API error:
//         402." shape, it earned the wallet footer ("Run blockrun_wallet
//         action:setup … Send USDC on Solana") for a user with no wallet — and
//         following it lands on requireWalletMode ("unset BLOCKRUN_API_KEY").
//   C38 — an unmarked 5xx AFTER the payment header was sent said "temporary
//         API issue, try again in a few minutes". The gateway's catch-all 500
//         and a post-settle 504 carry no "NOT charged" marker, so the money
//         MAY have moved; "try again" pays a second time.
//
// auth.js and wallet.js are mocked so the rail is chosen here, not by whatever
// ~/.blockrun holds on the developer's machine.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let apiKeyMode = false;
let chain: "base" | "solana" = "solana";
let getChainCalls = 0;
mock.module("../src/utils/auth.js", {
  namedExports: { isApiKeyMode: () => apiKeyMode },
});
mock.module("../src/utils/wallet.js", {
  namedExports: { getChain: () => { getChainCalls++; return chain; } },
});

const { formatError, basePaymentReplayHedge } = await import("../src/utils/errors.js");

/** Everything after the echoed message — the formatter's OWN words. */
function guidance(out: string): string {
  const i = out.indexOf("\n\n");
  return i === -1 ? "" : out.slice(i);
}

beforeEach(() => { apiKeyMode = false; chain = "solana"; getChainCalls = 0; });

// ---------------------------------------------------------------- C28 ----

const ACCOUNT_402 = "BlockRun account API error: 402. Top up at https://user.blockrun.ai/dashboard/credits.";

test("account rail: the SDK's 402 is out-of-credit guidance, never a wallet to fund", () => {
  apiKeyMode = true;
  const out = formatError(ACCOUNT_402);
  const g = guidance(out);
  assert.match(g, /out of credit/i, out);
  assert.match(g, /user\.blockrun\.ai\/dashboard\/credits/, out);
  assert.doesNotMatch(g, /wallet needs funding|Send USDC|action: "setup"|Solana|Base network/, out);
  assert.doesNotMatch(out, /temporary API issue/, out);
});

test("account rail: a plain 'Insufficient balance' gets the same credit remedy", () => {
  apiKeyMode = true;
  for (const msg of ["Insufficient balance", "API error 402: insufficient balance", "Payment rejected: insufficient balance"]) {
    const g = guidance(formatError(msg));
    assert.match(g, /out of credit/i, msg);
    assert.match(g, /dashboard\/credits/, msg);
    assert.doesNotMatch(g, /wallet needs funding|Send USDC|action: "setup"/, msg);
  }
});

test("account rail: the funding branch never probes the chain (no wallet, no keychain prompt)", () => {
  apiKeyMode = true;
  formatError(ACCOUNT_402);
  assert.equal(getChainCalls, 0);
});

test("wallet rails: a 402 still names the active chain's funding path", () => {
  for (const c of ["base", "solana"] as const) {
    chain = c;
    const out = formatError("API error 402: insufficient balance");
    assert.match(out, /needs funding/, c);
    assert.match(out, new RegExp(`Send USDC to your wallet on ${c === "solana" ? "Solana" : "Base"} network`), out);
    assert.doesNotMatch(out, /out of credit|dashboard\/credits/, c);
  }
});

// ---------------------------------------------------------------- C38 ----

const UNMARKED_AFTER_PAYMENT = [
  "API error after payment: 500\nInternal server error",
  "API error after payment: 504\nRequest failed",
  "API error after payment: 502\nRequest failed",
  "API error after payment: upstream provider unavailable",
];

test("wallet rails: an unmarked 5xx after the payment was sent says the charge MAY have gone through", () => {
  for (const c of ["base", "solana"] as const) {
    chain = c;
    for (const msg of UNMARKED_AFTER_PAYMENT) {
      const out = formatError(msg);
      const g = guidance(out);
      assert.match(g, /MAY have gone through/, `${c}: ${msg}\n${out}`);
      assert.match(g, /blockrun_wallet action:"report"/, `${c}: ${msg}`);
      assert.doesNotMatch(g, /Try again in a few minutes/, `${c}: ${msg} — a blind retry pays twice`);
      // The formatter still never invents a settlement claim in either direction.
      assert.doesNotMatch(g, /nothing was charged|not settled|charge stands/, `${c}: ${msg}`);
      assert.doesNotMatch(g, /needs funding/, `${c}: ${msg}`);
    }
  }
});

test("wallet rails: the gateway's own 'NOT charged' marker keeps the retry advice and drops the hedge", () => {
  const marked = "API error after payment: 502\nUpstream provider error\nPredexon 500: An unexpected error occurred (payment NOT charged)";
  for (const c of ["base", "solana"] as const) {
    chain = c;
    const g = guidance(formatError(marked));
    assert.match(g, /nothing was charged/, c);
    assert.match(g, /temporary API issue/, c);
    assert.match(g, /Try again in a few minutes/, c);
    assert.doesNotMatch(g, /MAY have gone through/, c);
  }
});

test("a 5xx BEFORE any payment is still a plain outage to retry", () => {
  for (const msg of ["API error: 502\nBad Gateway", "error 500 occurred", "Request failed with status code 503"]) {
    const g = guidance(formatError(msg));
    assert.match(g, /temporary API issue/, msg);
    assert.match(g, /Try again in a few minutes/, msg);
    assert.doesNotMatch(g, /MAY have gone through/, msg);
  }
});

test("account rail: an unmarked 5xx points at the account ledger instead of 'try again'", () => {
  apiKeyMode = true;
  for (const msg of [
    "BlockRun account API error: 502.",
    "BlockRun account API error: 500. Check https://user.blockrun.ai/dashboard/activity",
    'API error 504: {"error":"upstream timeout"}',
  ]) {
    const g = guidance(formatError(msg));
    assert.match(g, /MAY have/, msg);
    assert.match(g, /user\.blockrun\.ai\/dashboard\/activity/, msg);
    assert.doesNotMatch(g, /Try again in a few minutes/, msg);
    // blockrun_wallet is the tool name on every rail (action:"report" is the
    // ledger); what must not appear is a WALLET to fund or a signature.
    assert.match(g, /account key/, msg);
    assert.doesNotMatch(g, /payment signature|wallet's recent|your wallet|Send USDC|needs funding/, msg);
    assert.doesNotMatch(g, /nothing was charged|not settled|charge stands/, msg);
  }
  assert.equal(getChainCalls, 0, "no chain probe on the account rail");
});

test("account rail: a 5xx the gateway marked as uncharged says so and may be retried", () => {
  apiKeyMode = true;
  const g = guidance(formatError("API error 502: Upstream provider error (payment NOT charged)"));
  assert.match(g, /nothing was charged/);
  assert.match(g, /Try again in a few minutes/);
  assert.doesNotMatch(g, /MAY have/);
});

// The abort / dropped-socket shape carries no status and no "after payment"
// prefix: the formatter cannot see from the text whether a payment was
// attached, so the caller says so. Without the flag the text stays bare —
// an abort of an unpaid quote probe must not be sold as a possible charge.
const TRANSPORT = ["This operation was aborted", "fetch failed", "socket hang up", "Request timed out after 60000ms"];

test("afterPayment: an abort or dropped socket on the paid request is hedged on every rail", () => {
  for (const rail of ["base", "solana", "account"] as const) {
    apiKeyMode = rail === "account";
    if (rail !== "account") chain = rail;
    for (const msg of TRANSPORT) {
      const out = formatError(msg, { afterPayment: true });
      const g = guidance(out);
      assert.match(g, /MAY have gone through/, `${rail}: ${msg}\n${out}`);
      assert.match(g, rail === "account" ? /dashboard\/activity/ : /action:"report"/, `${rail}: ${msg}`);
      assert.doesNotMatch(g, /Try again in a few minutes|needs funding|nothing was charged/, `${rail}: ${msg}`);
    }
  }
});

test("without afterPayment a transport failure stays bare — the formatter never guesses", () => {
  for (const msg of TRANSPORT) {
    assert.equal(formatError(msg), `Error: ${msg}`, msg);
  }
});

test("afterPayment does not override the gateway's uncharged marker or a client 4xx", () => {
  const uncharged = formatError("API error after payment: 502\nPredexon 500: boom (payment NOT charged)", { afterPayment: true });
  assert.match(guidance(uncharged), /nothing was charged/);
  assert.doesNotMatch(guidance(uncharged), /MAY have gone through/);
  const clientErr = formatError("API error after payment: 400\nBad Request", { afterPayment: true });
  assert.equal(clientErr, "Error: API error after payment: 400\nBad Request");
});

// ------------------------------------------------ shared Base replay hedge ----
//
// exa.ts grew this for the SDK's exact post-payment 402 text; defi.ts hits the
// same gateway behaviour (neither route releases the nonce on 5xx). One helper,
// two callers, one wording.

const SDK_REJECTED = "Payment was rejected. Check your wallet balance.";

test("basePaymentReplayHedge: Base only, exact SDK text only, names the upstream", () => {
  chain = "base";
  const hedge = basePaymentReplayHedge(SDK_REJECTED, "DefiLlama");
  assert.match(hedge, /DefiLlama/);
  assert.match(hedge, /nothing was settled/);
  assert.match(hedge, /retry the call once/);
  assert.equal(basePaymentReplayHedge(`${SDK_REJECTED} extra`, "DefiLlama"), "");
  assert.equal(basePaymentReplayHedge("API error after payment: 502", "DefiLlama"), "");
  chain = "solana";
  assert.equal(basePaymentReplayHedge(SDK_REJECTED, "DefiLlama"), "");
  apiKeyMode = true;
  chain = "base";
  assert.equal(basePaymentReplayHedge(SDK_REJECTED, "DefiLlama"), "");
});
