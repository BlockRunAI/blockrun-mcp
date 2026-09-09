import { getChain } from "./wallet.js";

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
  return /(?:status(?:\s*code)?|http|error|payment)\s*[:=]?\s*5[0-9]{2}(?:$|[^0-9.])/.test(m) ||
    /(?:^|[^0-9.])5[0-9]{2}:?\s+(?:internal|server error|bad gateway|service unavailable|gateway time)/.test(m);
}

/**
 * Format an error for return to the caller, appending actionable guidance for
 * the three common failure classes (upstream model unavailable, server blip,
 * payment/balance). `opts.altModels` lets a tool suggest a SAME-DOMAIN fallback
 * (e.g. video → "bytedance/seedance-2.0") instead of a generic, often-wrong
 * cross-domain one — omit it and no specific model is named.
 */
export function formatError(message: string, opts?: { altModels?: string }): string {
  const msgLower = message.toLowerCase();

  // Match HTTP status codes as standalone tokens, not substrings — "max 5000
  // characters", "$1.4020", or "$402.50" must not classify as 500/402 errors.
  // The trailing boundary excludes a following digit AND a following dot, so the
  // integer part of a decimal amount ($402.50) is not misread as a status code.
  const hasStatus = (code: string) => new RegExp(`(^|[^0-9.])${code}($|[^0-9.])`).test(msgLower);

  const isPostPaymentClientError = msgLower.includes("api error after payment") &&
    /(^|[^0-9.])4[0-9]{2}($|[^0-9.])/.test(msgLower);
  const explicitlyUncharged =
    msgLower.includes("no payment was made") ||
    msgLower.includes("no charge was made") ||
    msgLower.includes("not charged");
  const isPaymentError = !isPostPaymentClientError && (
    hasStatus("402") ||
    msgLower.includes("balance") ||
    msgLower.includes("insufficient") ||
    (msgLower.includes("payment") && !hasStatus("500") && !explicitlyUncharged)
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
    /(?:status(?:\s*code)?|http|error|payment)\s*[:=]?\s*501(?:$|[^0-9.])/.test(msgLower) ||
    /(?:^|[^0-9.])501:?\s+not implemented/.test(msgLower);
  const isNotServedPrePayment = isNotServed && !msgLower.includes("api error after payment");

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
    const chain = getChain();
    const network = chain === "solana" ? "Solana" : "Base";
    errorText += `\n\nThis error usually means your wallet needs funding.\n` +
      `Run blockrun_wallet with action: "setup" to get funding instructions.\n\n` +
      `Quick fix: Send USDC to your wallet on ${network} network.`;
  }

  return errorText;
}
