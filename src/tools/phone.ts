// src/tools/phone.ts
//
// Phone intelligence + AI voice calls. Path-based passthrough that covers
// TWO namespaces — /v1/phone/* (lookup, number provisioning) and /v1/voice/*
// (outbound AI calls + status). The path argument is everything after /v1/.
// Full catalog lives in the phone skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

function estimatePhoneCost(path: string, hasBody: boolean): number {
  if (!hasBody && path.startsWith("voice/call/")) return 0;
  if (path === "phone/numbers/release") return 0;
  if (path === "phone/lookup") return 0.01;
  if (path === "phone/lookup/fraud") return 0.05;
  if (path === "phone/numbers/buy" || path === "phone/numbers/renew") return 5;
  if (path === "phone/numbers/list") return 0.001;
  if (path === "voice/call") return 0.54;
  return hasBody ? 0.001 : 0;
}

export function registerPhoneTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_phone",
    {
      description: `Phone-number intelligence, US/CA number provisioning, and outbound AI voice calls.

Common paths (path = everything after /v1/):
- phone/lookup               POST body: { phoneNumber }                                          ($0.01)
- phone/lookup/fraud         POST body: { phoneNumber } — SIM-swap + call-forwarding signals    ($0.05)
- phone/numbers/buy          POST body: { country?: "US"|"CA", areaCode? } — 30-day lease       ($5.00)
- phone/numbers/renew        POST body: { phoneNumber } — extend 30 days                        ($5.00)
- phone/numbers/list         POST body: {} — your wallet-owned numbers                          ($0.001)
- phone/numbers/release      POST body: { phoneNumber } — release back to pool                  (free)
- voice/call                 POST body: { to, task, from, voice?, max_duration?, ... }          ($0.54 flat)
- voice/call/{call_id}       GET (no body) — poll status + transcript                           (free)

REQUIRED for voice/call: \`from\` must be a number your wallet owns. Provision one with \`phone/numbers/buy\` first ($5, 30-day lease).

Voice presets: nat, josh, maya, june, paige, derek, florian. Phone numbers use E.164 format (e.g. +1 followed by 10 US digits, or +<country-code><number>).

Voice call flow + voice preset details + full body shapes in the \`phone\` skill.`,
      inputSchema: {
        path: z.string().describe("Endpoint after /v1/. Use 'phone/...' for lookup + number ops, 'voice/call' for outbound AI calls, 'voice/call/{id}' (no body) to poll status."),
        body: z.any().optional().describe("JSON body. Sent as POST. Omit for the free GET poll (voice/call/{call_id})."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, body, agent_id }) => {
      try {
        body = coerceBody(body);
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        const estimatedCost = estimatePhoneCost(cleanPath, body !== undefined);
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        const client = getClient() as unknown as RawClient;
        const endpoint = `/v1/${cleanPath}`;
        const result = body !== undefined
          ? await client.requestWithPaymentRaw(endpoint, body)
          : await client.getWithPaymentRaw(endpoint);
        if (estimatedCost > 0) recordSpending(budget, estimatedCost, agent_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: asStructuredContent(result),
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
