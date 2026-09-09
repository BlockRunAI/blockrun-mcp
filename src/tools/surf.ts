// src/tools/surf.ts
//
// Surf (asksurf.ai) — RETIRED upstream on 2026-09-06.
//
// Every /v1/surf/* path on blockrun.ai now answers HTTP 410
// {"error":{"code":"endpoint_retired"},"retired_on":"2026-09-06","alternatives":[…]}
// and sol.blockrun.ai answers 404; /api/openapi contains no "surf" at all
// (verified live 2026-09-08 with unauthenticated GETs — a 410 is free). There
// is no 402 on any Surf path, so a payment cannot be made through it.
//
// What this file does now: keep the tool registered under the same name (the
// 20-tool count and two profiles are pinned by README/brand-numbers and tests)
// and answer every call with the retirement notice BEFORE reserveBudget /
// confirmSpend, so no reservation is taken and no spend dialog is shown for a
// charge that cannot happen. Same precedent as price.ts's equityNotServedMessage.
//
// The notice has to be built here: @blockrun/llm's sanitizeErrorResponse keeps
// `body.error` only when it is a string, and the gateway nests the reason under
// `error.message`, so what reaches the user otherwise is "API error: 410 — API
// request failed" with the date and alternatives dropped.
//
// The money path below the short-circuit is left intact on purpose: the static
// guard in test/confirm-spend-coverage.test.ts requires every tool that
// reserves budget to also confirm, and if the gateway ever revives the namespace
// re-enabling is a one-line delete rather than a re-implementation.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { reserveBudget, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { asStructuredContent, coerceBody } from "../utils/body.js";
import { getClient } from "../utils/wallet.js";
import { rawPost, rawGet } from "../utils/raw-call.js";
import { formatError, extractErrorMessage } from "../utils/errors.js";
import { hasPathTraversal } from "../utils/path-safety.js";
import type { BudgetState } from "../types.js";

type SurfClient = {
  getWithPaymentRaw: (endpoint: string, params?: Record<string, string>) => Promise<unknown>;
  requestWithPaymentRaw: (endpoint: string, body: unknown) => Promise<unknown>;
};

// The RESERVE for a Surf call if the namespace ever serves again: $0.0075 base
// + the $0.002 flat tx fee we reserve (the gateway's live fee is $0.001 — see
// utils/tx-fee.ts OBSERVED_GATEWAY_TX_FEE_USD; the reserve stays conservative on
// purpose). Unreachable today — the retirement short-circuit returns first — but
// the constant is pinned by test/surf.test.ts and must not be lowered.
export const SURF_PRICE_USD = 0.0095;

// Exported for unit tests. Flat since 2026-07-15; feeds the BUDGET GATE, so it
// must never under-quote. Read the `payment-required` header, not the 402 body's
// `price` (that field is the base). Kept as-is under the retirement: the gate is
// the last line of defence if the route comes back priced differently.
export function estimateSurfCost(_path: string): number {
  return SURF_PRICE_USD;
}

/** The date the gateway reports in `retired_on` for every /v1/surf/* path. */
export const SURF_RETIRED_ON = "2026-09-06";

/**
 * What the gateway itself answers for any Surf path since 2026-09-06 (HTTP 410
 * `endpoint_retired`, verified live 2026-09-08), said before the wallet is
 * consulted. The alternatives are the gateway's own list, translated to the
 * tools that serve them. Exported for the test; nothing here touches the network.
 */
export function surfRetiredMessage(path: string): string {
  return `Error: blockrun_surf is retired — the gateway answers every /v1/surf/* path (here: '${path}') with 410 endpoint_retired since ${SURF_RETIRED_ON}.\n\n` +
    `This is not an outage and retrying will not help. Nothing was charged: no budget was reserved and the wallet was never asked to sign.\n` +
    `Where to go instead (the gateway's own alternatives):\n` +
    `- crypto, FX and commodity prices → blockrun_price (free)\n` +
    `- protocol TVL, chain TVL, yields → blockrun_defi\n` +
    `- prediction markets (Polymarket, Kalshi, Limitless, Opinion, Predict.Fun) → blockrun_markets\n` +
    `- DEX pairs, liquidity, volume → blockrun_dex (free); raw chain reads → blockrun_rpc\n` +
    `On-chain SQL, wallet labels / net worth, CEX order books and social mindshare have no BlockRun replacement yet — ` +
    `the gateway says a new vendor is pending and will be listed at https://blockrun.ai/api/openapi when it ships.`;
}

export function registerSurfTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_surf",
    {
      description: `RETIRED ${SURF_RETIRED_ON} — the gateway answers every Surf (asksurf.ai) path with 410 endpoint_retired. Calling this returns that notice; nothing is charged. Use instead: blockrun_price (crypto/FX/commodity quotes, free), blockrun_defi (TVL, yields), blockrun_markets (Polymarket, Kalshi and other venues), blockrun_dex (DEX pairs, free), blockrun_rpc (raw chain reads). On-chain SQL, wallet labels and social mindshare have no BlockRun replacement yet.`,
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      inputSchema: {
        path: z.string().describe("Former /v1/surf/ endpoint path. Every path returns the retirement notice."),
        params: z.record(z.string(), z.string()).optional().describe("Ignored — retired."),
        body: z.any().optional().describe("Ignored — retired."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ path, params, body, agent_id }) => {
      try {
        body = coerceBody(body);
        const cleanPath = path.replace(/^\/+/, "").replace(/^v1\/surf\//, "").replace(/^api\/v1\/surf\//, "");
        if (hasPathTraversal(cleanPath)) {
          return { content: [{ type: "text", text: formatError(`Invalid path '${path}'.`) }], isError: true };
        }
        // Retired upstream (410 on every path, no 402 is ever issued). Say so
        // BEFORE estimate/reserve/confirm: nothing to reserve, nothing to approve.
        return { content: [{ type: "text", text: surfRetiredMessage(cleanPath) }], isError: true };

        // ---- Money path, unreachable while the namespace is retired ---------
        // eslint-disable-next-line no-unreachable
        const estimatedCost = estimateSurfCost(cleanPath);
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
          const confirm = await confirmSpend(server, { usd: estimatedCost, label: `surf · ${cleanPath}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };
          const client = getClient() as unknown as SurfClient;
          const endpoint = `/v1/surf/${cleanPath}`;
          const { data: result, paidUsd } = body !== undefined
            ? await rawPost(client, endpoint, body)
            : await rawGet(client, endpoint, params);
          recordActualSpend(budget, paidUsd, estimatedCost, agent_id);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructuredContent(result),
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(extractErrorMessage(err)) }],
          isError: true,
        };
      }
    }
  );
}
