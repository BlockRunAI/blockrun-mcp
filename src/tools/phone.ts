// src/tools/phone.ts
//
// Phone intelligence + AI voice calls. Path-based passthrough that covers
// TWO namespaces — /v1/phone/* (lookup, number provisioning) and /v1/voice/*
// (outbound AI calls + status). The path argument is everything after /v1/.
// Full catalog lives in the phone skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordSpending, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { type RawClient, rawPost, rawGet } from "../utils/raw-call.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal, normalizeClassifyPath } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";


// Exported for unit tests. Normalizes the slug (drops query/trailing-slash/case)
// before the exact-match pricing so a perturbed path can't downgrade an
// expensive route to the $0.001 default while the gateway charges full price.
// Conservative reserve for a phone path we do not recognise. MUST NOT be $0.
//
// The old catch-all returned $0 for any unlisted GET, and the gateway has paid
// routes this table never knew about: /v1/phone/numbers/search is live and
// charges $0.0120 (verified against its payment-required header) while
// reserving — and recording — $0. That is spend the ledger never sees, and a
// gate an exhausted budget walks straight through. The gateway's own
// PHONE_PRICES does not list numbers/search either, so this table cannot be
// trusted to stay complete: fail CLOSED on the unknown.
//
// $0.0120 is the charge for the priciest known cheap-ish route (lookup and
// numbers/search both settle there), so it covers today's unknowns without
// blocking a reasonable budget. Genuinely free reads stay $0 via explicit match.
const PHONE_UNKNOWN_RESERVE_USD = 0.012;

export function estimatePhoneCost(rawPath: string, hasBody: boolean): number {
  const path = normalizeClassifyPath(rawPath);
  // Explicitly free — matched exactly, never by fallthrough.
  if (!hasBody && path.startsWith("voice/call/")) return 0;
  if (path === "phone/numbers/release") return 0;
  // Known paid routes: base + the gateway's $0.002 flat fee (src/utils/tx-fee.ts).
  // Verified live: lookup base $0.010 -> charged $0.0120; numbers/list $0.001 -> $0.0030.
  if (path === "phone/lookup") return withTxFee(0.01);
  if (path === "phone/lookup/fraud") return withTxFee(0.05);
  if (path === "phone/numbers/buy" || path === "phone/numbers/renew") return withTxFee(5);
  if (path === "phone/numbers/list") return withTxFee(0.001);
  if (path === "voice/call") return withTxFee(0.54);
  // Unknown: fail closed rather than reserve $0.
  return PHONE_UNKNOWN_RESERVE_USD;
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
      annotations: TOOL_ANNOTATIONS.publicOrExternalWrite,
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
          const confirm = await confirmSpend(server, { usd: estimatedCost, label: `phone · ${cleanPath}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          const client = getClient() as unknown as RawClient;
          const endpoint = `/v1/${cleanPath}`;
          const { data: result, paidUsd } = body !== undefined
            ? await rawPost(client, endpoint, body)
            : await rawGet(client, endpoint);
          // Free phone reads estimate $0 and must stay free; a settled figure
          // from the account rail is authoritative for everything else.
          if (estimatedCost > 0 || (paidUsd ?? 0) > 0) {
            recordActualSpend(budget, paidUsd, estimatedCost, agent_id);
          }
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
