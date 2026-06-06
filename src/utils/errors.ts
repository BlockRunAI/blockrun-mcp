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

export function formatError(message: string): string {
  const msgLower = message.toLowerCase();

  // Match HTTP status codes as standalone tokens, not substrings — "max 5000
  // characters" or "$1.4020" must not classify as 500/402 errors.
  const hasStatus = (code: string) => new RegExp(`(^|[^0-9.])${code}([^0-9]|$)`).test(msgLower);

  const isPaymentError = hasStatus("402") ||
    msgLower.includes("balance") ||
    msgLower.includes("insufficient") ||
    (msgLower.includes("payment") && !hasStatus("500"));

  const isServerError = hasStatus("500") ||
    msgLower.includes("api error after payment");

  let errorText = `Error: ${message}`;

  if (isServerError) {
    errorText += `\n\nThis is a temporary API issue. The API may be experiencing problems.` +
      `\nTry again in a few minutes, or use a different model (e.g., openai/gpt-4o).`;
  } else if (isPaymentError) {
    const chain = getChain();
    const network = chain === "solana" ? "Solana" : "Base";
    errorText += `\n\nThis error usually means your wallet needs funding.\n` +
      `Run blockrun_wallet with action: "setup" to get funding instructions.\n\n` +
      `Quick fix: Send USDC to your wallet on ${network} network.`;
  }

  return errorText;
}
