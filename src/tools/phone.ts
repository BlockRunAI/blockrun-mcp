// src/tools/phone.ts
//
// Phone intelligence + AI voice calls. Path-based passthrough that covers
// TWO namespaces — /v1/phone/* (lookup, number provisioning) and /v1/voice/*
// (outbound AI calls + status). The path argument is everything after /v1/.
// Full catalog lives in the phone skill.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../utils/wallet.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";

type RawClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

export function registerPhoneTool(server: McpServer): void {
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
      },
    },
    async ({ path, body }) => {
      try {
        const client = getClient() as unknown as RawClient;
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\//, "");
        const endpoint = `/v1/${cleanPath}`;
        const result = body !== undefined
          ? await client.requestWithPaymentRaw(endpoint, body)
          : await client.getWithPaymentRaw(endpoint);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
