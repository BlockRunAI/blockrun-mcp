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

  const isPaymentError = hasStatus("402") ||
    msgLower.includes("balance") ||
    msgLower.includes("insufficient") ||
    (msgLower.includes("payment") && !hasStatus("500"));

  // Upstream model/provider availability, e.g. token360 returns
  // "Model '…' not found or not active for requested provider" (the gateway
  // surfaces it as a 500). This is the SPECIFIC model being down upstream, not
  // a generic blip — so steer the user to a sibling model, not "try again".
  const isModelUnavailable =
    msgLower.includes("not active for requested provider") ||
    msgLower.includes("not found or not active");

  const isServerError = hasStatus("500") ||
    msgLower.includes("api error after payment");

  const altHint = opts?.altModels ? ` (e.g. ${opts.altModels})` : "";
  let errorText = `Error: ${message}`;

  if (isModelUnavailable) {
    errorText += `\n\nThis model is temporarily unavailable upstream` +
      (opts?.altModels
        ? `. Try a different model${altHint} — it should work right away.`
        : `. Try a different model, or retry shortly.`);
  } else if (isServerError) {
    errorText += `\n\nThis is a temporary API issue. The API may be experiencing problems.` +
      `\nTry again in a few minutes` +
      (opts?.altModels ? `, or use a different model${altHint}.` : `.`);
  } else if (isPaymentError) {
    const chain = getChain();
    const network = chain === "solana" ? "Solana" : "Base";
    errorText += `\n\nThis error usually means your wallet needs funding.\n` +
      `Run blockrun_wallet with action: "setup" to get funding instructions.\n\n` +
      `Quick fix: Send USDC to your wallet on ${network} network.`;
  }

  return errorText;
}
