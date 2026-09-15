import { getChain } from "./wallet.js";
import { isApiKeyMode } from "./auth.js";

// Literals rather than PORTAL_CREDITS_URL / PORTAL_ACTIVITY_URL: every handler
// test that mocks utils/auth.js lists its named exports by hand, and the one
// name this module cannot do without is isApiKeyMode (in-flight.ts and
// api-key-call.ts spell their URLs out for the same reason).
const ACCOUNT_CREDITS_URL = "https://user.blockrun.ai/dashboard/credits";
const ACCOUNT_ACTIVITY_URL = "https://user.blockrun.ai/dashboard/activity";

/**
 * Pulls a useful message out of any thrown value. For SDK APIError, surfaces
 * the upstream response body (which carries `error`, `message`, and `hint`
 * fields the gateway returns on 400/422/5xx) — otherwise just the bare
 * `API error: 400` from the SDK class swallows the helpful detail.
 */
export function extractErrorMessage(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: unknown; response?: unknown; statusCode?: unknown };
  const base = typeof e.message === "string" ? e.message : String(err);
  if (e.response === undefined || e.response === null) return base;
  try {
    const body = e.response;
    if (typeof body === "string") return body.trim() ? `${base} — ${body}` : base;
    if (typeof body === "object") {
      const b = body as Record<string, unknown>;
      // Common gateway error shape: { error, message, hint, missing_params? }
      const parts: string[] = [];
      if (typeof b.message === "string") parts.push(b.message);
      // @blockrun/llm >= 3.15.1 (blockrun-llm-ts#39) keeps the gateway's own
      // `message` — the field that names the cause AND says whether money moved,
      // e.g. "Predexon 500: … (payment NOT charged)" — under `detail`, because
      // the sanitizer already uses `message` for the top-level `error` string.
      // Without this line that text is dropped a second time here, and
      // formatError() below has no evidence to say nothing was charged — all it
      // can echo is the SDK's "after payment" prefix (blockrun-mcp#132).
      if (typeof b.detail === "string" && b.detail !== b.message) parts.push(b.detail);
      if (typeof b.hint === "string") parts.push(`Hint: ${b.hint}`);
      if (Array.isArray(b.missing_params) && b.missing_params.length) {
        parts.push(`Missing: ${b.missing_params.join(", ")}`);
      }
      if (parts.length === 0) {
        // No structured fields — dump the raw body
        parts.push(JSON.stringify(b));
      }
      return `${base}\n${parts.join("\n")}`;
    }
  } catch { /* fall through */ }
  return base;
}

/**
 * True when an error from the manual-402 media tools (speech/music/video/
 * realface) is a GENUINE payment failure — an on-chain settlement rejection or
 * insufficient balance — not an upstream outage whose status text merely
 * contains "402". Those tools probe the endpoint UNPAID and throw on any
 * non-402 response, so the old `includes("402")` / `includes("payment")`
 * classifier reported 5xx/4xx outages (and RealFace's 425 liveness-not-ready) as
 * "fund your wallet". Match only the real settlement signals.
 */
export function isPaymentRejectionError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("insufficient") || m.includes("balance") || m.includes("rejected");
}

/**
 * Where a status code is allowed to END.
 *
 * End of string, or a character that is neither a digit nor a dot — that much
 * is what keeps "$402.50" and "$1.4020" from reading as status codes, and it is
 * load-bearing (both are pinned by tests).
 *
 * The third alternative is the fix for a real gap: the SDK's ACCOUNT client
 * writes `BlockRun account API error: 502.` with a sentence-ending period
 * (@blockrun/llm dist/index.js, `${response.status}.${hint}`), and a dot was
 * excluded outright — so every account-rail 5xx fell through unclassified and
 * the caller got no guidance at all, while the identical wallet-rail message
 * ("API error: 502") got it. A dot NOT followed by a digit is punctuation; a
 * dot followed by a digit is a decimal point and still disqualifies.
 */
const STATUS_END = "(?:$|[^0-9.]|\\.(?!\\d))";

/**
 * True when `message` carries a 5xx that READS as an HTTP status. A bare
 * three-digit match is far too loose: LLM errors are full of incidental
 * 5xx-shaped numbers ("max_tokens 512 is above the limit", "embedding dimension
 * 512"), and telling the user to wait out a temporary outage hides a real
 * validation bug. Either the number is directly labelled as a status ("error
 * 500", "status code 503", "http 502") — adjacency matters, so "context length
 * 512 exceeded" does not qualify — or it carries a standard HTTP reason phrase.
 * Shared with the route-specific formatters so they cannot drift looser.
 */
export function hasLabelledServerStatus(message: string): boolean {
  const m = message.toLowerCase();
  // "payment" is a label too: the SDK's post-402 prefix is "API error after
  // payment: 502", where the word before the number is "payment", not "error".
  return new RegExp(`(?:status(?:\\s*code)?|http|error|payment)\\s*[:=]?\\s*5[0-9]{2}${STATUS_END}`).test(m) ||
    /(?:^|[^0-9.])5[0-9]{2}:?\s+(?:internal|server error|bad gateway|service unavailable|gateway time)/.test(m);
}

/**
 * Every way this repo and the gateway say "the money did not move". The list
 * is longer than it looks because the sentence is written in five places by
 * four authors: the gateway ("payment NOT charged"), the SDK, the manual-402
 * tools ("No payment taken", "no charge was made"), and the quote guard
 * ("Refusing to sign it — no charge was made"). Exported because the path
 * tools' catch (utils/path-tool-catch.ts) must refuse to BOOK a charge the
 * gateway says it never took, using the same evidence this formatter uses to
 * refuse to SAY it.
 */
export function isExplicitlyUncharged(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("no payment was made") ||
    m.includes("no payment was taken") ||
    m.includes("no payment taken") ||
    m.includes("no charge was made") ||
    m.includes("nothing was charged") ||
    m.includes("not charged");
}

/**
 * Format an error for return to the caller, appending actionable guidance for
 * the three common failure classes (upstream model unavailable, server blip,
 * payment/balance). `opts.altModels` lets a tool suggest a SAME-DOMAIN fallback
 * (e.g. video → "bytedance/seedance-2.0") instead of a generic, often-wrong
 * cross-domain one — omit it and no specific model is named.
 *
 * `opts.afterPayment` is the caller saying "a request carrying the payment
 * (a signature, or the account Bearer) had already been sent when this was
 * thrown". The formatter can read that from the SDK's "API error after
 * payment" prefix, but an abort or a dropped socket arrives as a bare
 * "This operation was aborted" / "fetch failed" with no such prefix, and the
 * text alone cannot tell a paid retry from an unpaid quote probe. Pass it from
 * a tracker (utils/in-flight.ts `paid.outstanding`) or from settlementOnThrow's
 * "unknown" verdict; never guess it.
 */
export function formatError(message: string, opts?: { altModels?: string; afterPayment?: boolean }): string {
  const msgLower = message.toLowerCase();

  // Match HTTP status codes as standalone tokens, not substrings — "max 5000
  // characters", "$1.4020", or "$402.50" must not classify as 500/402 errors.
  // The trailing boundary excludes a following digit AND a following dot, so the
  // integer part of a decimal amount ($402.50) is not misread as a status code.
  const hasStatus = (code: string) => new RegExp(`(^|[^0-9.])${code}${STATUS_END}`).test(msgLower);

  const isPostPaymentClientError = msgLower.includes("api error after payment") &&
    /(^|[^0-9.])4[0-9]{2}($|[^0-9.])/.test(msgLower);
  const explicitlyUncharged = isExplicitlyUncharged(message);
  // …and it gates the WHOLE funding branch, not just the "payment" keyword.
  // It used to gate only that sub-clause, so a message carrying a bare 402, the
  // word "balance", or "insufficient" still earned "your wallet needs funding"
  // while saying in the same breath that nothing was charged. Two of this
  // repo's own messages did exactly that: the video tool's unreadable-quote
  // refusal ("Refusing to sign a payment for an amount that could not be
  // validated — no charge was made") matched the bare 402 and told a wallet
  // holding $1,000 to top up, and RealFace's "No payment taken" was not even in
  // the marker list. Telling someone to fund a wallet that was never debited is
  // the same class of wrong as #132, pointed the other way.
  const isPaymentError = !isPostPaymentClientError && !explicitlyUncharged && (
    hasStatus("402") ||
    msgLower.includes("balance") ||
    msgLower.includes("insufficient") ||
    (msgLower.includes("payment") && !hasStatus("500"))
  );

  // Upstream model/provider availability, e.g. token360 returns
  // "Model '…' not found or not active for requested provider" (the gateway
  // surfaces it as a 500). This is the SPECIFIC model being down upstream, not
  // a generic blip — so steer the user to a sibling model, not "try again".
  const isModelUnavailable =
    msgLower.includes("not active for requested provider") ||
    msgLower.includes("not found or not active");

  // The SDK prefixes every post-402 upstream failure with "API error after
  // payment", including validation failures such as 400/410/422. Those are
  // actionable client errors, not transient server outages, so they no longer
  // get retry guidance.
  //
  // See hasLabelledServerStatus: a 5xx must LOOK like an HTTP status to count.
  const has5xxStatus = hasLabelledServerStatus(msgLower);
  // A post-payment failure with no parseable status is still an upstream
  // failure, not an empty wallet — without this it falls through to the
  // "payment" keyword branch and wrongly tells the user to fund.
  const isServerError = has5xxStatus ||
    (msgLower.includes("api error after payment") && !isPostPaymentClientError);

  // 501 is the gateway saying "we do not serve this" — the equity price/history
  // routes have answered it before any payment since 2026-09-05 (licensing;
  // blockrun#517). It is in the 5xx range but it is not an outage, so "try again
  // in a few minutes" is wrong advice and hides that the product line is gone.
  // Same labelling rule as has5xxStatus: the number must read as a status, so
  // "batch of 501 items" does not qualify. The "nothing was charged" claim is
  // only safe when the 501 arrived BEFORE payment: a post-payment 501 means the
  // gateway settled and then upstream refused, and this formatter has no
  // endpoint context to know whether the nonce was released.
  const isNotServed =
    new RegExp(`(?:status(?:\\s*code)?|http|error|payment)\\s*[:=]?\\s*501${STATUS_END}`).test(msgLower) ||
    /(?:^|[^0-9.])501:?\s+not implemented/.test(msgLower);
  const isNotServedPrePayment = isNotServed && !msgLower.includes("api error after payment");

  // Had a request CARRYING THE PAYMENT already left the machine when this was
  // thrown? On the wallet rails the SDK says so in the prefix of every failure
  // on its paid retry. On the account rail the credential rides every request,
  // so any answer from the gateway is "after payment" by construction — the
  // 4xx refusals are excluded below because the gateway answers those before
  // billing. A caller that watched the wire can also say so (`afterPayment`).
  const afterPayment = opts?.afterPayment === true ||
    msgLower.includes("api error after payment") ||
    (isApiKeyMode() && has5xxStatus);
  // No status, no prefix, no verdict: the request went out and nothing came
  // back. Same shape settlementOnThrow (chat-stream.ts) classifies as "unknown"
  // — an abort of the paid retry, an idle timeout, a socket reset mid-flight.
  const isTransportFailure =
    /aborted|timed out|timeout|fetch failed|socket hang up|econnreset|etimedout|epipe|terminated/.test(msgLower);
  // The one sentence this branch exists for. The gateway's catch-all 500 does
  // not release the payment nonce (settlement ran in the same try), a 504 after
  // settlement carries no body at all, and a client that aborted the paid retry
  // never sees the answer — in all three the USDC may be gone. Until audit
  // round 3 this read as "temporary API issue, try again in a few minutes",
  // the ledger booked nothing, and the retry paid again (C38). Only the
  // gateway's own marker (`explicitlyUncharged`) is allowed to overrule it.
  const mayHaveSettled = afterPayment && !explicitlyUncharged && !isPostPaymentClientError &&
    (isServerError || (opts?.afterPayment === true && isTransportFailure));

  const altHint = opts?.altModels ? ` (e.g. ${opts.altModels})` : "";
  let errorText = `Error: ${message}`;

  if (isModelUnavailable) {
    errorText += `\n\nThis model is temporarily unavailable upstream` +
      (opts?.altModels
        ? `. Try a different model${altHint} — it should work right away.`
        : `. Try a different model, or retry shortly.`);
  } else if (isNotServed) {
    errorText += `\n\nThe gateway does not serve this endpoint (501 Not Implemented). This is not a` +
      `\ntransient outage — retrying will not help` +
      (isNotServedPrePayment
        ? `, and nothing was charged.`
        : `. Check blockrun_wallet action:"report" to see whether this call settled.`);
  } else if (mayHaveSettled) {
    // Tested BEFORE the generic outage branch: the retry advice there is the
    // wrong advice for a call that may already have paid. Say what is known
    // (the payment went out), what is not (whether it settled), and where to
    // look — never "nothing was charged" and never "the charge stands".
    const account = isApiKeyMode();
    const carrying = account ? "the account key" : "the payment signature";
    const failure = isServerError
      ? `The gateway failed AFTER the request carrying ${carrying} was sent, and did not say whether this call was billed`
      : `No response came back, and the request carrying ${carrying} had already been sent`;
    const where = account
      ? `check blockrun_wallet action:"report" and ${ACCOUNT_ACTIVITY_URL}`
      : `check blockrun_wallet action:"report" and the wallet's recent transactions`;
    errorText += `\n\n${failure} — the charge MAY have gone through (the gateway settles on its own clock and ` +
      `does not stop because this client saw an error). Before retrying, ${where}: a retry pays again if it did.` +
      (opts?.altModels ? ` If it did not, a different model${altHint} may be healthier.` : ``);
  } else if (isServerError) {
    errorText += `\n\nThis is a temporary API issue. The API may be experiencing problems.` +
      `\nTry again in a few minutes` +
      (opts?.altModels ? `, or use a different model${altHint}.` : `.`);
    // The gateway's own words, restated as guidance. The SDK labels every
    // post-402 failure "API error after payment", and until now the only thing
    // `explicitlyUncharged` did was suppress the funding footer — which this
    // branch, tested first, already made unreachable for a 5xx. So a
    // "(payment NOT charged)" 5xx read as "after payment … try again", with
    // nothing in the tool's voice saying whether money moved (blockrun-mcp#132).
    // Only the gateway's marker earns this line; the formatter never invents a
    // settlement claim of its own.
    if (explicitlyUncharged) {
      errorText += `\nThe gateway reported that this call was not settled — nothing was charged.`;
    }
  } else if (isPaymentError) {
    // The rail decides what "payment required" means. On the account rail a
    // 402 is the gateway saying the prepaid credit is gone; there is no wallet
    // to fund, and telling the agent to run action:"setup" sends it to
    // requireWalletMode ("unset BLOCKRUN_API_KEY …") — off the rail the user
    // chose. Tested first so the branch never reaches getChain(), which on an
    // account-only machine is a session-file/keychain probe for nothing (C28).
    if (isApiKeyMode()) {
      errorText += `\n\nYour BlockRun account is out of credit. Top up at ${ACCOUNT_CREDITS_URL} ` +
        `(the API key stays the same).`;
    } else {
      const chain = getChain();
      const network = chain === "solana" ? "Solana" : "Base";
      errorText += `\n\nThis error usually means your wallet needs funding.\n` +
        `Run blockrun_wallet with action: "setup" to get funding instructions.\n\n` +
        `Quick fix: Send USDC to your wallet on ${network} network.`;
    }
  }

  return errorText;
}

// The SDK's text for ANY post-payment 402, body discarded (@blockrun/llm
// dist/index.js, handlePaymentAndRetryRaw). On the Base rail it has two causes
// the tool cannot tell apart:
//
//   - the wallet really was refused (balance, allowance);
//   - the upstream answered 5xx, the gateway route returned 502 "Payment was
//     NOT charged" WITHOUT releasing the payment nonce (the pm route releases;
//     the exa and defillama routes do not — blockrun src/app/api/v1/exa/
//     [...path]/route.ts and defillama/[...path]/route.ts), the SDK slept 1s
//     and re-sent the SAME PAYMENT-SIGNATURE, and rejectReplay answered 402
//     {code: PAYMENT_REPLAY}. Nothing settled.
//
// formatError sees "balance" and prescribes funding, so a 30-second upstream
// blip told a $50 wallet to top up. The Solana client has no 502 retry and the
// account rail has no nonce, so the ambiguity is Base-only — and so is the
// hedge: on Base the SDK's words stay (it MAY be a real rejection) with the
// second reading added; elsewhere the sentence means what it says. The real
// fix is upstream (release the nonce on 5xx, as pm does) or in the SDK
// (surface the 402 `code`); this is the honest message until then. Shared so
// exa and defi cannot drift apart on the wording.
export const SDK_POST_PAYMENT_REJECTION = "Payment was rejected. Check your wallet balance.";

/**
 * The Base-only second reading of the SDK's post-payment rejection, or "" when
 * the message is anything else, the rail is not Base, or the process bills an
 * account. Append it AFTER formatError's output. `upstream` names the vendor
 * behind the route ("Exa", "DefiLlama") so the sentence says who failed.
 */
export function basePaymentReplayHedge(message: string, upstream: string): string {
  if (message.trim() !== SDK_POST_PAYMENT_REJECTION) return "";
  if (isApiKeyMode() || getChain() !== "base") return "";
  return `\n\nOn Base this exact rejection is also what the gateway returns when ${upstream} itself failed (5xx) and the SDK ` +
    "re-sent the same payment header: in that case nothing was settled and the wallet was never the problem. " +
    "Check blockrun_wallet action:\"status\" — if it shows funds, retry the call once before topping up.";
}
