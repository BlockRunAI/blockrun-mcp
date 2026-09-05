// src/utils/api-key-call.ts
//
// The account rail for the four tools that build gateway requests by hand
// (music, speech, video, realface) instead of going through an SDK client.
//
// Deliberately shaped like utils/solana-402.ts's solanaPaidAsyncPost, down to
// the result type, so a tool can pick a rail with one `if` instead of growing a
// third copy of its own submit-and-poll loop. There are now three:
//
//   base wallet   EIP-3009 402 dance          (in each tool)
//   solana wallet solanaPaidAsyncPost         (utils/solana-402.ts)
//   account key   apiKeyPost / apiKeyAsyncPost (here)
//
// The account rail is by far the simplest — there is no quote to read, nothing
// to sign, and no authorization that can expire mid-poll — which is exactly why
// it needs its own module rather than a flag threaded through the 402 code.

import { fetchWithTimeout } from "./http.js";
import { pollTimeoutFor } from "./poll.js";
import { apiAuthHeaders } from "./auth.js";
import { getApiBase, resolveGatewayUrl } from "./wallet.js";

export interface ApiKeyPostResult {
  data: Record<string, unknown>;
  /**
   * ALWAYS NULL, and that is a fact about the account API rather than a gap here.
   *
   * A wallet call learns its price from the 402 quote before it signs. An
   * account call has no quote: it is metered server-side at exact upstream token
   * counts, billed post-hoc, and the response carries no cost header (probed
   * 2026-09-05 — the only billing-ish headers are `x-blockrun-request-id` and
   * `x-payment-receipt: credit:<uuid>`). Callers therefore fall back to their
   * own pre-call estimate, which recordActualSpend already does for null.
   *
   * Returning null rather than 0 matters: recordActualSpend treats 0 as
   * "unknown" too, but null says so on purpose instead of by accident.
   */
  paidUsd: null;
  /** The `credit:<uuid>` receipt, when the gateway returns one. */
  txHash?: string;
  jobId?: string;
}

/** Statuses the gateway uses for a job that will never complete. */
const TERMINAL_FAILURES = new Set(["failed", "cancelled", "canceled"]);

function receiptFrom(response: Response): string | undefined {
  return (
    response.headers.get("x-payment-receipt") ??
    response.headers.get("X-Payment-Receipt") ??
    undefined
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function throwForStatus(response: Response, what: string): Promise<never> {
  const body = await readJson(response);
  // A 402 on this rail is not a quote to pay — it means the ACCOUNT is out of
  // credit. Signing anything here would be wrong (there is no wallet), so say
  // what actually has to happen.
  if (response.status === 402) {
    throw new Error(
      `${what} was refused: the BlockRun account is out of credit. ` +
        `Top up at https://user.blockrun.ai/dashboard/credits.`,
    );
  }
  if (response.status === 401) {
    throw new Error(
      `${what} was refused: BLOCKRUN_API_KEY was rejected. ` +
        `Check the key at https://user.blockrun.ai/dashboard/keys.`,
    );
  }
  throw new Error(`API error ${response.status}: ${JSON.stringify(body)}`);
}

/** POST an endpoint that answers inline. `endpoint` is rooted, e.g. "/v1/audio/speech". */
export async function apiKeyPost(
  endpoint: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<ApiKeyPostResult> {
  const response = await fetchWithTimeout(
    `${getApiBase()}${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? 120_000,
  );
  if (!response.ok) await throwForStatus(response, `POST ${endpoint}`);
  return { data: await readJson(response), paidUsd: null, txHash: receiptFrom(response) };
}

/**
 * POST a job that may complete inline (200) or asynchronously (202 + poll_url),
 * then poll to completion.
 *
 * The poll URL is resolved through resolveGatewayUrl, NOT string-concatenated.
 * The gateway hands back a root-relative `/api/v1/...` path, and the account API
 * serves `/v1/...` at its root — so the obvious concatenation produces a URL on
 * the WALLET gateway, unauthenticated, for a job the account has already been
 * billed for. That failure is silent and unrecoverable: the money is spent and
 * the result can never be collected.
 */
export async function apiKeyAsyncPost(
  endpoint: string,
  body: Record<string, unknown>,
  opts: {
    pollBudgetMs?: number;
    pollIntervalMs?: number;
    submitTimeoutMs?: number;
    pollTimeoutMs?: number;
  } = {},
): Promise<ApiKeyPostResult> {
  const startedAt = Date.now();
  const pollBudgetMs = opts.pollBudgetMs ?? 600_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 90_000;
  // No signed authorization means no second clock: unlike the wallet rails, the
  // only deadline is the caller's own budget.
  const deadline = startedAt + pollBudgetMs;

  const submit = await fetchWithTimeout(
    `${getApiBase()}${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
      body: JSON.stringify(body),
    },
    opts.submitTimeoutMs ?? 95_000,
  );
  if (!submit.ok && submit.status !== 202) await throwForStatus(submit, `POST ${endpoint}`);

  const submitted = await readJson(submit);
  const pollUrl = typeof submitted.poll_url === "string" ? submitted.poll_url : undefined;
  const jobId = typeof submitted.id === "string" ? submitted.id : undefined;

  if (submit.status !== 202 && !pollUrl) {
    return { data: submitted, paidUsd: null, txHash: receiptFrom(submit), jobId };
  }
  if (!pollUrl) {
    throw new Error(`Async submit missing poll_url: ${JSON.stringify(submitted)}`);
  }

  const absolutePollUrl = resolveGatewayUrl(pollUrl);
  let lastStatus = typeof submitted.status === "string" ? submitted.status : "queued";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const timeout = pollTimeoutFor(deadline, Date.now(), pollTimeoutMs);
    if (timeout === 0) break;

    const poll = await fetchWithTimeout(
      absolutePollUrl,
      { method: "GET", headers: { ...apiAuthHeaders() } },
      timeout,
    );
    const data = await readJson(poll);
    if (typeof data.status === "string") lastStatus = data.status;

    if (poll.status === 202 && (lastStatus === "queued" || lastStatus === "in_progress")) continue;
    if (TERMINAL_FAILURES.has(lastStatus)) {
      // Report what the gateway SAYS about the money, not what we assume.
      // A terminal failure normally carries payment_status "not_charged" plus a
      // note (verified 2026-09-05 on a MiniMax job that timed out upstream), and
      // claiming a refund we have not observed is worse than saying nothing:
      // it tells someone not to check a charge that may be real.
      const paymentStatus = typeof data.payment_status === "string" ? data.payment_status : undefined;
      const note = typeof data.note === "string" ? data.note : undefined;
      const billing =
        note ??
        (paymentStatus === "not_charged"
          ? "No payment was taken."
          : `Billing status: ${paymentStatus ?? "unknown"} — check https://user.blockrun.ai/dashboard/activity${jobId ? ` for job ${jobId}` : ""}.`);
      throw new Error(`Upstream generation failed: ${String(data.error ?? "unknown")}. ${billing}`);
    }
    if (poll.ok && lastStatus === "completed") {
      return { data, paidUsd: null, txHash: receiptFrom(poll), jobId };
    }
    // 504 is a transient upstream poll timeout on this gateway, same as the
    // wallet rails — keep polling rather than abandoning a paid job.
    if (!poll.ok && poll.status !== 202 && poll.status !== 504) {
      await throwForStatus(poll, `poll ${absolutePollUrl}`);
    }
  }

  throw new Error(
    `Job did not complete within ${Math.round(pollBudgetMs / 1000)}s (last status: ${lastStatus}). ` +
      `It has already been billed to the account${jobId ? `; job id ${jobId}` : ""} — ` +
      `check https://user.blockrun.ai/dashboard/activity before submitting again.`,
  );
}
