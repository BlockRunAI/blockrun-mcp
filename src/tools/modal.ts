// src/tools/modal.ts
//
// Modal sandbox — isolated remote code execution (optional GPU). Path-based
// passthrough. Full action catalog (create / exec / status / terminate) and
// GPU type / image / timeout details live in the modal skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordSpending, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { baseOnlyMessage, buildClientWithTimeout } from "../utils/wallet.js";
import { ledgerFallback, rawPost, type RawClient } from "../utils/raw-call.js";
import { formatError } from "../utils/errors.js";
import { pathToolFailure } from "../utils/path-tool-catch.js";
import { normalizeClassifyPath } from "../utils/path-safety.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";


// sandbox/create is priced off the BODY, not the path. Mirrors
// getModalCreatePricing() in the gateway's src/lib/modal.ts:
//
//   timeout <= 300s  -> flat rate: CPU $0.01, or the GPU tier below
//   timeout >  300s  -> hourly:    rate x (timeout/3600), EXACT (not rounded up),
//                                  charged upfront for the full requested lifetime
//                                  with NO refund on early terminate
//
// Estimating on the path alone reserved a flat $0.01 for every create. Verified
// live against the payment-required header:
//
//   { timeout: 86400, gpu: "H100" } -> charged $192.0020   (reserved $0.012 — 16,000x short)
//   { timeout: 3600,  gpu: "A100" } -> charged   $4.0020
//   { timeout: 300 }                -> charged   $0.0120
//
// A $1 agent cap could settle $192 of non-refundable spend. Keep these tables in
// step with the gateway's. The gateway's CreateRequestSchema 400s BEFORE payment
// on any gpu string outside its five tiers (case-sensitive: "h100" is refused),
// so the CPU rate is only ever what an ABSENT gpu pays.
const MODAL_FLAT_RATE_MAX_SECONDS = 300;
const MODAL_DEFAULT_CREATE_TIMEOUT_SECONDS = 300;
const MODAL_CREATE_PRICE_USD = 0.01;
const MODAL_OPERATION_PRICE_USD = 0.001;
// Map, not an object literal. A literal inherits from Object.prototype, so
// TABLE["toString"] resolves to a FUNCTION and the `?? default` fallback never
// fires — the function then flows into the budget gate as NaN and permanently
// disables every cap for the process (reserveBudget does Math.max(0, fn) = NaN,
// checkBudget's `cost > 0` is false so it ALLOWS, then `spent += NaN` sticks).
// Reachable via toString/valueOf/constructor/hasOwnProperty/__proto__. A Map has
// no prototype keys, so `.get()` returns undefined for all of them and the
// fallback works. See test/modal-cost.test.ts.
const MODAL_GPU_CREATE_PRICE_USD = new Map<string, number>([
  ["T4", 0.05], ["L4", 0.08], ["A10G", 0.1], ["A100", 0.2], ["H100", 0.4],
]);
const MODAL_CPU_HOURLY_PRICE_USD = 0.1;
const MODAL_GPU_HOURLY_PRICE_USD = new Map<string, number>([
  ["T4", 1.5], ["L4", 2.0], ["A10G", 2.5], ["A100", 4.0], ["H100", 8.0],
]);
const MODAL_GPU_TIERS = [...MODAL_GPU_HOURLY_PRICE_USD.keys()];

// NORMALISE THE BODY THE WAY THE GATEWAY DOES, BEFORE PRICING AND BEFORE
// SENDING. The gateway's CreateRequestSchema declares `gpu: z.string().trim()`
// and runs its allow-list check and getModalCreatePricing on the TRIMMED value,
// so `" H100 "`, `"H100\n"` and an NBSP-padded `"H100"` are all accepted and
// billed as H100. This estimator looked the raw string up in the Map, missed,
// and priced the CPU rate — the path-classification bug below, on the body
// field that carries the largest single charge this server can make. Unpaid
// 402 probe 2026-09-13: `{ timeout: 3600, gpu: " H100 " }` quotes 8001000
// micro ($8.001) against a $0.102 reserve; at 24h that is $192.002 against
// $2.402 — past a $5 cap, past the confirm dialog, and booked as $2.40 on the
// Base ledger. Trim (String.prototype.trim, same as zod's) and keep the case:
// the gateway is case-sensitive and 400s "h100" before payment, so folding
// case would turn a free refusal into a paid H100.
//
// The trimmed body is also what gets SENT, so the reserve and the wire agree by
// construction rather than by a second normalisation on the far side.
export function normalizeModalCreateBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const o = body as Record<string, unknown>;
  if (typeof o.gpu !== "string") return body;
  return { ...o, gpu: o.gpu.trim() };
}

/**
 * The refusal for a gpu the gateway would 400 before payment — every string
 * outside the five tiers, including lowercase and the empty string. Returns
 * null when the body is fine. Refusing here costs nothing (the gateway would
 * refuse the same call unpaid) and saves the round-trip; naming the tiers
 * matters because "Unsupported GPU type" alone sends a model guessing again.
 * Only sandbox/create carries a priced gpu, so callers gate on the route.
 */
export function unsupportedModalGpu(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const gpu = (body as { gpu?: unknown }).gpu;
  if (gpu === undefined || gpu === null) return null;
  if (typeof gpu === "string" && MODAL_GPU_HOURLY_PRICE_USD.has(gpu)) return null;
  return `Unsupported GPU type ${JSON.stringify(gpu)}. Allowed: ${MODAL_GPU_TIERS.join(", ")} (case-sensitive), or omit gpu for a CPU sandbox. ` +
    `The gateway rejects any other value before payment, so nothing would have been served. No payment was made.`;
}

/** Exported for tests. Returns what x402 will CHARGE (base + the flat tx fee). */
export function estimateModalCost(path: string, body?: unknown): number {
  // Classify the route the gateway will SERVE, not the string the caller typed.
  // A raw `path.includes("sandbox/create")` compared the un-normalized slug, so
  // a single invisible character moved the most expensive call this server can
  // make into the cheapest tier: `sandbox/cre<TAB>ate` reserved $0.003 (fetch
  // deletes the tab, so the gateway still routed and billed a real create — up
  // to $192.00, non-refundable), and $0.003 clears every budget cap there is.
  // `%63reate` did the same via the router's own percent-decode. This is the
  // shared helper `hasPathTraversal` has always used; modal was the one price
  // table that never adopted it. See test/modal-cost.test.ts.
  if (!normalizeClassifyPath(path).includes("sandbox/create")) return withTxFee(MODAL_OPERATION_PRICE_USD);

  const o = body && typeof body === "object" ? (body as { gpu?: unknown; timeout?: unknown }) : {};
  // Trimmed, as the gateway prices it — see normalizeModalCreateBody. The
  // handler sends a body normalised the same way; this is belt-and-braces so
  // the estimator is right even for a caller that skipped the handler.
  const gpu = typeof o.gpu === "string" ? o.gpu.trim() : undefined;
  // A non-numeric/absent timeout defaults to 300s upstream — the flat tier.
  const seconds =
    typeof o.timeout === "number" && Number.isFinite(o.timeout) && o.timeout > 0
      ? o.timeout
      : MODAL_DEFAULT_CREATE_TIMEOUT_SECONDS;

  if (seconds > MODAL_FLAT_RATE_MAX_SECONDS) {
    // An absent gpu is the CPU rate — same as the gateway's
    // `opts.gpu && opts.gpu in TABLE ? TABLE[gpu] : CPU_RATE`, which runs on
    // the trimmed value. An unknown gpu also falls back here, but only so the
    // estimator stays total: the handler refuses it before the reserve
    // (unsupportedModalGpu), and the gateway 400s it before payment.
    const hourly = gpu !== undefined ? MODAL_GPU_HOURLY_PRICE_USD.get(gpu) : undefined;
    return withTxFee((hourly ?? MODAL_CPU_HOURLY_PRICE_USD) * (seconds / 3600));
  }
  const flat = gpu !== undefined ? MODAL_GPU_CREATE_PRICE_USD.get(gpu) : undefined;
  return withTxFee(flat ?? MODAL_CREATE_PRICE_USD);
}

// Modal sandbox/exec is synchronous — the HTTP call stays open for the whole
// run. Size the client timeout to the requested sandbox/exec `timeout` (seconds)
// plus slack, floored at the documented 300s sandbox default and capped at 30
// min, so a legitimately long exec isn't aborted at the SDK's 60s default (which
// would lose the result and leave the paid sandbox running upstream).
const MODAL_DEFAULT_TIMEOUT_S = 300;
const MODAL_MAX_TIMEOUT_S = 1800;
const MODAL_SLACK_MS = 15_000;

export function modalTimeoutMs(body: unknown): number {
  const raw = body && typeof body === "object" ? (body as { timeout?: unknown }).timeout : undefined;
  const requested = typeof raw === "number" && raw > 0 ? raw : MODAL_DEFAULT_TIMEOUT_S;
  const clamped = Math.min(Math.max(requested, MODAL_DEFAULT_TIMEOUT_S), MODAL_MAX_TIMEOUT_S);
  return clamped * 1000 + MODAL_SLACK_MS;
}

export function registerModalTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_modal",
    {
      description: `Run isolated code in a BlockRun-hosted Modal sandbox — disposable remote container, optional GPU.

Use when you need: a clean ephemeral environment, GPU access (T4/L4/A10G/A100/H100 — those five only), or a safer place for untrusted code. Prefer local tools for normal repo work.

⚠️ \`timeout\` IS THE BILLED LIFETIME — charged upfront in full, NEVER refunded. It is not an idle timeout: you pay for the time you ASK for, not the time you use, and terminating early refunds nothing. Ask for what you need, not a safe-looking ceiling.
- timeout ≤ 300s → flat: $0.0120 CPU · $0.0520 T4 · $0.0820 L4 · $0.1020 A10G · $0.2020 A100 · $0.4020 H100
- timeout > 300s → PER-HOUR × the full requested lifetime: $0.10/h CPU · $1.50 T4 · $2.00 L4 · $2.50 A10G · $4.00 A100 · $8.00/h H100
  e.g. { timeout: 600, gpu: "A100" } = $0.6687 · { timeout: 86400, gpu: "H100" } = $192.00

Common paths (all POST):
- sandbox/create     — body: { image?, timeout?, cpu?, memory?, gpu?, setup_commands? }    (see above — $0.0120 to $192.00)
- sandbox/exec       — body: { sandbox_id, command: ["python","-c","..."], timeout? }      ($0.0030)
- sandbox/status     — body: { sandbox_id }                                                ($0.0030)
- sandbox/terminate  — body: { sandbox_id }                                                ($0.0030)

Full pricing tables + GPU details in the \`modal\` skill.`,
      annotations: TOOL_ANNOTATIONS.publicOrExternalWrite,
      inputSchema: {
        path: z.string().describe("Endpoint under /v1/modal/, e.g. 'sandbox/create', 'sandbox/exec'"),
        body: z.any().optional().describe("JSON body. Sent as POST."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      // The reserve of the paid request in flight, for the catch: 0 until the
      // line before rawPost, so nothing thrown earlier can book a charge.
      let sentUsd = 0;
      try {
        // sol.blockrun.ai returns 503 for every /v1/modal/* route — the sandbox
        // backend is Base-only. Probed 2026-08-07 by the dual-chain sweep in
        // scripts/verify-prices.ts (all six modal probes, create and exec). A
        // raw 503 reads as "the service is down" rather than "wrong chain", so
        // say which it is before spending the round trip.
        // baseOnlyMessage returns null on the ACCOUNT rail: the 503 below is a
        // property of the SOLANA gateway, and api.blockrun.ai vendors the Base
        // routes, so an account key reaches Modal normally.
        const chainBlock = baseOnlyMessage("blockrun_modal");
        if (chainBlock) {
          return { content: [{ type: "text", text: formatError(chainBlock) }], isError: true };
        }
        body = coerceBody(body);
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/modal\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        // sandbox/create is priced from gpu + timeout. Normalise the gpu the way
        // the gateway will (trim) BEFORE estimating and BEFORE sending, so the
        // reserve, the confirm dialog, the ledger and the wire all describe the
        // same tier — and refuse a tier the gateway would 400 unpaid, so the
        // message names the five that exist instead of "API error: 400".
        if (normalizeClassifyPath(cleanPath).includes("sandbox/create")) {
          body = normalizeModalCreateBody(body);
          const badGpu = unsupportedModalGpu(body);
          if (badGpu) {
            return { content: [{ type: "text", text: formatError(badGpu) }], isError: true };
          }
        }
        const estimatedCost = estimateModalCost(cleanPath, body);
        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
          // decline returns here — nothing is sent, and the finally releases the
          // reservation. No-ops when off, sub-threshold, or unsupported by the client.
          const confirm = await confirmSpend(server, { usd: estimatedCost, label: `modal · ${cleanPath}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          // Dedicated client whose timeout covers a long synchronous exec, without
          // lengthening the 60s timeout the shared getClient() gives every other tool.
          const client = buildClientWithTimeout(modalTimeoutMs(body)) as unknown as RawClient;
          const endpoint = `/v1/modal/${cleanPath}`;
          sentUsd = estimatedCost;
          const { data: result, paidUsd } = await rawPost(client, endpoint, body ?? {});
          recordActualSpend(budget, paidUsd, ledgerFallback(estimatedCost), agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructuredContent(result),
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        // Books the reserve when the payment went out and no origin answer came
        // back (utils/path-tool-catch.ts) — for sandbox/create that is the full
        // reserve, which is the point: a create that timed out client-side may
        // well be running and billed.
        return pathToolFailure(err, { budget, agentId: agent_id, sentUsd });
      }
    }
  );
}
