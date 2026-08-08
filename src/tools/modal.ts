// src/tools/modal.ts
//
// Modal sandbox — isolated remote code execution (optional GPU). Path-based
// passthrough. Full action catalog (create / exec / status / terminate) and
// GPU type / image / timeout details live in the modal skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { withTxFee } from "../utils/tx-fee.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { buildClientWithTimeout, getChain } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

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
// step with the gateway's; an unknown gpu string falls back to the CPU rate there,
// so it does here too.
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

/** Exported for tests. Returns what x402 will CHARGE (base + the flat tx fee). */
export function estimateModalCost(path: string, body?: unknown): number {
  if (!path.includes("sandbox/create")) return withTxFee(MODAL_OPERATION_PRICE_USD);

  const o = body && typeof body === "object" ? (body as { gpu?: unknown; timeout?: unknown }) : {};
  const gpu = typeof o.gpu === "string" ? o.gpu : undefined;
  // A non-numeric/absent timeout defaults to 300s upstream — the flat tier.
  const seconds =
    typeof o.timeout === "number" && Number.isFinite(o.timeout) && o.timeout > 0
      ? o.timeout
      : MODAL_DEFAULT_CREATE_TIMEOUT_SECONDS;

  if (seconds > MODAL_FLAT_RATE_MAX_SECONDS) {
    // An unknown or empty gpu falls back to the CPU rate — same as the gateway's
    // `opts.gpu && opts.gpu in TABLE ? TABLE[gpu] : CPU_RATE`.
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
      try {
        // sol.blockrun.ai returns 503 for every /v1/modal/* route — the sandbox
        // backend is Base-only. Probed 2026-08-07 by the dual-chain sweep in
        // scripts/verify-prices.ts (all six modal probes, create and exec). A
        // raw 503 reads as "the service is down" rather than "wrong chain", so
        // say which it is before spending the round trip.
        if (getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("blockrun_modal is served on Base only. Switch BlockRun to Base (run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }
        body = coerceBody(body);
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/modal\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        // Pass the body: sandbox/create is priced from gpu + timeout, not the path.
        const estimatedCost = estimateModalCost(cleanPath, body);
        const gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          // Dedicated client whose timeout covers a long synchronous exec, without
          // lengthening the 60s timeout the shared getClient() gives every other tool.
          const client = buildClientWithTimeout(modalTimeoutMs(body)) as unknown as RawClient;
          const endpoint = `/v1/modal/${cleanPath}`;
          const result = await client.requestWithPaymentRaw(endpoint, body ?? {});
          recordSpending(budget, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructuredContent(result),
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
