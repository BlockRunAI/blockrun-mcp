// src/tools/modal.ts
//
// Modal sandbox — isolated remote code execution (optional GPU). Path-based
// passthrough. Full action catalog (create / exec / status / terminate) and
// GPU type / image / timeout details live in the modal skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reserveBudget, recordSpending } from "../utils/budget.js";
import { withTxFee } from "../utils/tx-fee.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { buildClientWithTimeout } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

function estimateModalCost(path: string): number {
  // withTxFee: base + $0.002. Reserving the base was 3x short on non-create calls.
  return withTxFee(path.includes("sandbox/create") ? 0.01 : 0.001);
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

Use when you need: a clean ephemeral environment, GPU access (T4/L4/A10G/A100/A100-80GB/H100), or a safer place for untrusted code. Prefer local tools for normal repo work.

Common paths (all POST):
- sandbox/create     — body: { image?, timeout?, cpu?, memory?, gpu?, setup_commands? }    ($0.01)
- sandbox/exec       — body: { sandbox_id, command: ["python","-c","..."], timeout? }      ($0.001)
- sandbox/status     — body: { sandbox_id }                                                ($0.001)
- sandbox/terminate  — body: { sandbox_id }                                                ($0.001)

Full action shapes + GPU type details in the \`modal\` skill.`,
      inputSchema: {
        path: z.string().describe("Endpoint under /v1/modal/, e.g. 'sandbox/create', 'sandbox/exec'"),
        body: z.any().optional().describe("JSON body. Sent as POST."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      try {
        body = coerceBody(body);
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/modal\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const estimatedCost = estimateModalCost(cleanPath);
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
