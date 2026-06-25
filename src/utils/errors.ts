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
 * Format an error for return to the caller, appending actionable guidance for
 * the three common failure classes (upstream model unavailable, server blip,
 * payment/balance). `opts.altModels` lets a tool suggest a SAME-DOMAIN fallback
 * (e.g. video → "bytedance/seedance-2.0") instead of a generic, often-wrong
 * cross-domain one — omit it and no specific model is named.
 */
export function formatError(message: string, opts?: { altModels?: string }): string {
  const msgLower = message.toLowerCase();

  // Match HTTP status codes as standalone tokens, not substrings — "max 5000
  // characters" or "$1.4020" must not classify as 500/402 errors.
  const hasStatus = (code: string) => new RegExp(`(^|[^0-9.])${code}([^0-9]|$)`).test(msgLower);

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
