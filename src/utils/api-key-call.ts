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
   * What this call ACTUALLY cost, from the `x-blockrun-cost-usd` response header,
   * or null when the account API did not settle a price at response time.
   *
   * Null is not "free". The header is absent for two different reasons the wire
   * cannot tell apart: a genuinely free family (catalogue reads, job polls), and
   * chat — where the charge settles after the response is sent, by design, so
   * emitting it would mean holding the answer until the money landed. Callers
   * pass null to recordActualSpend, which falls back to their pre-call estimate.
   *
   * Until 2026-09-05 this was ALWAYS null: the header did not exist, and the
   * estimates it replaces are high by exactly the transaction fee this rail does
   * not charge (reconciled against the account ledger: music billed $0.157500
   * against a $0.1595 estimate, speech $0.001050 against $0.0031).
   */
  paidUsd: number | null;
  /** The `credit:<uuid>` receipt, when the gateway returns one. */
  txHash?: string;
  jobId?: string;
}

/**
 * Read `x-blockrun-cost-usd`, refusing anything that is not a settled amount.
 *
 * EMPTY, MALFORMED AND NEGATIVE ALL READ AS ABSENT, and that is the whole point
 * of doing this by hand rather than with `Number(...)`. `Number("")` is 0, not
 * NaN — so a header present but empty would parse as a settled zero and book $0
 * against a call that was genuinely billed, reintroducing in the reader exactly
 * the confusion the header exists to remove. (ClawRouter's first parser had this
 * bug; a test caught it there.) The emitter cannot currently produce an empty
 * value, but a reader that is only correct because of what the writer happens to
 * do is not correct.
 *
 * A settled ZERO is meaningful and preserved: the gateway writes "0.000000"
 * explicitly for a charge that really did resolve to nothing, as distinct from
 * omitting the header.
 */
export function parseCostHeader(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function costFrom(response: Response): number | null {
  return parseCostHeader(response.headers.get("x-blockrun-cost-usd"));
}

/** Statuses the gateway uses for a job that will never complete. */
const TERMINAL_FAILURES = new Set(["failed", "cancelled", "canceled"]);

/**
 * Poll statuses that mean "the proxy tier hiccupped", not "the job is gone".
 * The SDK's own ApiKeyAuth.fetch retries 502/503/504/522/524 on GETs; 429 is
 * added because a poll is free and Retry-After says exactly how long to wait.
 * On this rail the job is already paid for, so abandoning it on one of these
 * costs the whole clip and invites a second, equally billed submit.
 */
const TRANSIENT_POLL_STATUSES = new Set([429, 502, 503, 504, 522, 524]);

/**
 * A failure on the account rail's async path for which the account has been, or
 * may have been, charged.
 *
 * This rail bills a media job the moment the gateway accepts it (202); the polls
 * are free. So unlike the wallet rails, where "we gave up" means "nothing
 * settled", every exit after a successful submit here leaves money spent — and
 * the two things a caller needs are exactly what a bare Error cannot carry: how
 * much (to book it), and which job (so nobody submits it twice). The message text
 * of the deadline case is unchanged from before this class existed, because
 * isTimeoutError keys on it.
 */
export class BilledJobError extends Error {
  /**
   * The settled cost from the submit response's x-blockrun-cost-usd, or null
   * when the header was absent. Null is not free: callers hand it to
   * recordActualSpend, which falls back to their estimate, never to $0.
   */
  readonly paidUsd: number | null;
  readonly jobId?: string;
  /**
   * "billed": the gateway answered 202, so the charge is certain.
   * "unknown": no response was observed — the submit never returned, or a
   * terminal failure arrived without a payment_status — so the request may or
   * may not have been billed. Callers book the estimate in both cases: a cap
   * that over-counts a lost request is the safe direction, and under-counting a
   * real charge is the failure the ledger exists to prevent.
   */
  readonly billing: "billed" | "unknown";

  constructor(message: string, opts: { paidUsd: number | null; jobId?: string; billing: "billed" | "unknown" }) {
    super(message);
    this.name = "BilledJobError";
    this.paidUsd = opts.paidUsd;
    this.jobId = opts.jobId;
    this.billing = opts.billing;
  }
}

/**
 * True when a fetch rejection proves the request never left this machine — DNS
 * failed, or the connection was refused — so nothing could have been billed.
 * Anything else (an abort, a reset, a socket error mid-flight) is ambiguous:
 * the request may have reached the gateway and been accepted.
 */
const NEVER_CONNECTED = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);
function connectionNeverOpened(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === "string" && NEVER_CONNECTED.has(cause.code);
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  const seconds = raw === null ? NaN : Number(raw.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

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

/** The message for a non-ok response whose body has already been read. */
function statusErrorMessage(response: Response, what: string, body: Record<string, unknown>): string {
  // A 402 on this rail is not a quote to pay — it means the ACCOUNT is out of
  // credit. Signing anything here would be wrong (there is no wallet), so say
  // what actually has to happen.
  if (response.status === 402) {
    return (
      `${what} was refused: the BlockRun account is out of credit. ` +
      `Top up at https://user.blockrun.ai/dashboard/credits.`
    );
  }
  if (response.status === 401) {
    return (
      `${what} was refused: the BlockRun API key was rejected. ` +
      `Check the key at https://user.blockrun.ai/dashboard/keys.`
    );
  }
  // Surface Retry-After rather than burying it in the body. It is the one piece
  // of a 429 a caller can act on, and an agent told "rate limited" with no
  // interval will retry immediately and be refused again. (Carried over from
  // PR #136, which surfaced it and this path did not.)
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    return `${what} was rate limited${retry ? ` — retry after ${retry}s` : ""}.`;
  }
  return `API error ${response.status}: ${JSON.stringify(body)}`;
}

async function throwForStatus(response: Response, what: string): Promise<never> {
  throw new Error(statusErrorMessage(response, what, await readJson(response)));
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
  return { data: await readJson(response), paidUsd: costFrom(response), txHash: receiptFrom(response) };
}

/**
 * GET a priced endpoint. `endpoint` is rooted, e.g. "/v1/pm/polymarket/markets".
 *
 * Paid GETs settle inline on this rail, so the cost header is present on the
 * response — the three families that had it missing until 0fff304 (pm, surf,
 * defillama) are all GETs, and they were the whole reason it was worth verifying
 * per family rather than trusting one probe.
 */
export async function apiKeyGet(
  endpoint: string,
  params?: Record<string, string>,
  opts: { timeoutMs?: number } = {},
): Promise<ApiKeyPostResult> {
  const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
  const response = await fetchWithTimeout(
    `${getApiBase()}${endpoint}${qs}`,
    { method: "GET", headers: { ...apiAuthHeaders() } },
    opts.timeoutMs ?? 120_000,
  );
  if (!response.ok) await throwForStatus(response, `GET ${endpoint}`);
  return { data: await readJson(response), paidUsd: costFrom(response), txHash: receiptFrom(response) };
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

  let submit: Response;
  try {
    submit = await fetchWithTimeout(
      `${getApiBase()}${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
        body: JSON.stringify(body),
      },
      opts.submitTimeoutMs ?? 95_000,
    );
  } catch (err) {
    // A submit that never connected cannot have been billed; let it surface as
    // the network error it is. Anything else is ambiguous — the request may
    // have reached the gateway, which bills the moment it accepts — and the
    // honest statement is "may have", not "was" (no charge was observed) and
    // not "was not" (which would license a second submit).
    if (connectionNeverOpened(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new BilledJobError(
      `POST ${endpoint} did not return a response (${reason}). The request may have reached the gateway, ` +
        `and this rail bills a job the moment it is accepted, so the job MAY have been accepted and billed to the account — ` +
        `check https://user.blockrun.ai/dashboard/activity before submitting again.`,
      { paidUsd: null, billing: "unknown" },
    );
  }
  if (!submit.ok && submit.status !== 202) await throwForStatus(submit, `POST ${endpoint}`);

  const submitted = await readJson(submit);
  const submitCost = costFrom(submit);
  const pollUrl = typeof submitted.poll_url === "string" ? submitted.poll_url : undefined;
  const jobId = typeof submitted.id === "string" ? submitted.id : undefined;

  if (submit.status !== 202 && !pollUrl) {
    return { data: submitted, paidUsd: costFrom(submit), txHash: receiptFrom(submit), jobId };
  }
  if (!pollUrl) {
    throw new Error(`Async submit missing poll_url: ${JSON.stringify(submitted)}`);
  }

  const absolutePollUrl = resolveGatewayUrl(pollUrl);
  let lastStatus = typeof submitted.status === "string" ? submitted.status : "queued";

  // From here on the account has paid. Every give-up below says so, names the
  // job, and carries the cost, because the natural next move after a bare
  // failure is to submit again — and that bills a second job.
  const billedNote =
    `It has already been billed to the account${jobId ? `; job id ${jobId}` : ""} — ` +
    `check https://user.blockrun.ai/dashboard/activity before submitting again.`;
  const billed = (message: string) => new BilledJobError(message, { paidUsd: submitCost, jobId, billing: "billed" });

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const timeout = pollTimeoutFor(deadline, Date.now(), pollTimeoutMs);
    if (timeout === 0) break;

    let poll: Response;
    try {
      poll = await fetchWithTimeout(
        absolutePollUrl,
        { method: "GET", headers: { ...apiAuthHeaders() } },
        timeout,
      );
    } catch {
      // Polls are free and idempotent, and the money is already gone: a
      // transient disconnect (or one clamped poll's abort) must not abandon a
      // job the account has paid for. The deadline above bounds the retry.
      continue;
    }
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
      const failed = `Upstream generation failed: ${String(data.error ?? "unknown")}.`;
      if (paymentStatus === "not_charged") {
        throw new Error(`${failed} ${note ?? "No payment was taken."}`);
      }
      // Anything short of an observed refund is bookable: an explicit charged
      // status is certain, an absent one is unknown — and unknown books too,
      // because the gateway's contract is to say "not_charged" when it refunds.
      const billing =
        note ??
        `Billing status: ${paymentStatus ?? "unknown"} — check https://user.blockrun.ai/dashboard/activity${jobId ? ` for job ${jobId}` : ""}.`;
      throw new BilledJobError(`${failed} ${billing}`, { paidUsd: submitCost, jobId, billing: paymentStatus ? "billed" : "unknown" });
    }
    if (poll.ok && lastStatus === "completed") {
      // Async media bills at SUBMIT and the polls are free, so the price rides
      // the submit response and the completed poll carries nothing. Prefer the
      // poll's header if one ever appears, but fall back to the submit's.
      return { data, paidUsd: costFrom(poll) ?? submitCost, txHash: receiptFrom(poll), jobId };
    }
    if (TRANSIENT_POLL_STATUSES.has(poll.status)) {
      // Honour Retry-After when the proxy sends one, but never sleep past the
      // deadline; the loop's own interval covers the rest.
      const wait = Math.min(retryAfterMs(poll), Math.max(0, deadline - Date.now()));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!poll.ok && poll.status !== 202) {
      throw billed(`${statusErrorMessage(poll, `poll ${absolutePollUrl}`, data)} ${billedNote}`);
    }
  }

  throw billed(
    `Job did not complete within ${Math.round(pollBudgetMs / 1000)}s (last status: ${lastStatus}). ${billedNote}`,
  );
}
