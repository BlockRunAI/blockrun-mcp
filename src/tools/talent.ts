// src/tools/talent.ts
//
// BlockRun agent marketplace (business.blockrun.ai) via x402 — discover and
// hire other creators' paid AI skills ("talents"). Mirrors the manual-402
// pattern in speech.ts / music.ts (Base only).
//
// The marketplace speaks standard single-leg `exact` x402, so we sign with the
// same @blockrun/llm primitives the other tools use — with two differences from
// the gateway: the 402 challenge comes back in the JSON body (not a
// PAYMENT-REQUIRED header), and the signed payment goes in the `x-payment`
// header (not PAYMENT-SIGNATURE). Discovery (list) is a free GET; hiring (run)
// pays the quoted price and settles only on a successful run.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { formatError } from "../utils/errors.js";
import type { BudgetState } from "../types.js";
import { getChain, getOrCreateWalletKey } from "../utils/wallet.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentPayload, extractPaymentDetails } from "@blockrun/llm";

const MARKET_API = (process.env.BLOCKRUN_MARKET_URL || "https://business.blockrun.ai").replace(/\/+$/, "");
const LIST_TIMEOUT = 15_000;
const RUN_TIMEOUT = 120_000;

interface MarketSkill {
  slug: string;
  name: string;
  description: string;
  price_usd: number;
  backing_model: string;
  run_count: number;
  execution_type: string; // "prompt" | "agent"
  data_sources: string[];
  sample_input?: string;
  sample_output?: string;
  creator: { wallet: string; x: string | null };
  run_url: string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function errResult(msg: string): ToolResult {
  return { content: [{ type: "text", text: formatError(msg) }], isError: true };
}

export function registerTalentTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_talent",
    {
      description: `BlockRun agent marketplace — discover and hire other creators' paid AI skills ("talents").

Actions:
- list (default): browse or search the catalog (free). Optional 'query' filters by name, description, and data source. Results are ranked by call volume, most-used first.
- run: hire a skill by 'slug' with your 'input'. Signs ONE standard USDC x402 payment from the wallet on Base and returns the skill's output. Charged automatically and ONLY on a successful run (the response reports the USD paid); a failed run is free.

Use list whenever you need talent for a sub-task you cannot do well yourself (live market/on-chain data, a domain-specific analysis, a niche transform) or when the user asks you to find an agent for some domain; then run the best match. Prefer listing first to get the exact slug and price.`,
      inputSchema: {
        action: z.enum(["list", "run"]).optional().default("list").describe("list: browse/search the catalog (free). run: hire a skill (paid)."),
        query: z.string().optional().describe("list: keyword filter over name, description, and data source."),
        slug: z.string().optional().describe("run: the skill slug to hire (get it from list)."),
        input: z.string().optional().describe("run: the input text to send the skill."),
        limit: z.number().optional().describe("list: max skills to return (default 20, max 200)."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ action, query, slug, input, limit, agent_id }) => {
      try {
        if (action === "run") return await hireSkill({ slug, input, agent_id, budget });
        return await listTalents({ query, limit });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errResult(`Marketplace request failed: ${msg}`);
      }
    },
  );
}

// ─── list (free) ─────────────────────────────────────────────────────────────

async function listTalents({ query, limit }: { query?: string; limit?: number }): Promise<ToolResult> {
  const n = Math.min(Math.max(typeof limit === "number" ? limit : 20, 1), 200);
  const resp = await fetchWithTimeout(`${MARKET_API}/api/v1/skills?limit=${n}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  }, LIST_TIMEOUT);
  if (!resp.ok) throw new Error(`marketplace returned HTTP ${resp.status}`);

  const body = (await resp.json()) as { skills?: MarketSkill[] };
  let skills = Array.isArray(body.skills) ? body.skills : [];
  // Rank by call volume, highest first (stable — keeps the API's recency tiebreak).
  skills.sort((a, b) => (b.run_count ?? 0) - (a.run_count ?? 0));

  const q = query?.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    skills = skills.filter((s) => {
      const hay = [s.slug, s.name, s.description, ...(s.data_sources || [])].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  if (skills.length === 0) {
    return { content: [{ type: "text", text: query ? `No talents match "${query}".` : "No talents are available right now." }] };
  }

  const lines = skills.map((s) => {
    const type = s.execution_type === "agent" && s.data_sources?.length ? `live-data(${s.data_sources.join(",")})` : s.execution_type;
    const by = s.creator?.x ? ` by @${s.creator.x}` : "";
    const eg = s.sample_input ? ` | e.g. ${JSON.stringify(s.sample_input)}` : "";
    return `- ${s.slug} — ${s.name} [${type}] ${fmtUsd(s.price_usd)}/run${by}\n  ${s.description}${eg}`;
  });
  const head = query ? `BlockRun talents matching "${query}" (${skills.length}):` : `BlockRun talents (${skills.length}):`;
  return {
    content: [{ type: "text", text: `${head}\n${lines.join("\n")}\n\nTo hire: blockrun_talent action:"run" slug:"<slug>" input:"<input>".` }],
    structuredContent: { skills },
  };
}

// ─── run (paid) ──────────────────────────────────────────────────────────────

async function hireSkill(
  { slug, input, agent_id, budget }: { slug?: string; input?: string; agent_id?: string; budget: BudgetState },
): Promise<ToolResult> {
  if (getChain() !== "base") {
    return errResult("blockrun_talent settles on Base only. Switch BlockRun to Base (blockrun_wallet action:chain chain:base) and fund the Base wallet with USDC.");
  }
  if (!slug?.trim()) return errResult(`'slug' is required for action:"run" — run action:"list" first to find it.`);
  if (!input?.trim()) return errResult(`'input' is required for action:"run".`);

  const runUrl = `${MARKET_API}/api/v1/skills/${encodeURIComponent(slug)}/run`;
  const payload = JSON.stringify({ input });

  // Step 1: unpaid POST → 402 with the exact quoted price (or a free prefilter refusal).
  const resp402 = await fetchWithTimeout(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  }, 15_000);

  if (resp402.status === 200) {
    // The route can refuse an input for free (no payment) — surface that result.
    const d = (await resp402.json().catch(() => ({}))) as Record<string, unknown>;
    return runSuccess(slug, 0, null, typeof d.result === "string" ? d.result : "");
  }
  if (resp402.status !== 402) {
    const d = (await resp402.json().catch(() => ({}))) as Record<string, unknown>;
    return errResult(`Could not start '${slug}' (HTTP ${resp402.status}): ${typeof d.error === "string" ? d.error : "marketplace error"}.`);
  }

  const challenge = (await resp402.json().catch(() => null)) as { accepts?: unknown[] } | null;
  if (!challenge?.accepts?.length) return errResult("Could not read payment requirements from the marketplace.");

  const details = extractPaymentDetails(challenge as Parameters<typeof extractPaymentDetails>[0]);
  const cost = Number(details.amount) / 1_000_000;

  // Budget gate against the REAL quoted price (the 402 above was free — no charge yet).
  const bc = checkBudget(budget, agent_id, cost);
  if (!bc.allowed) {
    return { content: [{ type: "text", text: `${bc.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
  }

  const privateKey = getOrCreateWalletKey();
  const account = privateKeyToAccount(privateKey);
  const paymentPayload = await createPaymentPayload(
    privateKey,
    account.address,
    details.recipient,
    details.amount,
    details.network || "eip155:8453",
    {
      resourceUrl: details.resource?.url || runUrl,
      // createPaymentPayload base64s the payload with btoa (Latin1-only), so the
      // description must stay ASCII — strip anything else out of the slug.
      resourceDescription: `Run ${slug}`.replace(/[^\x20-\x7E]/g, ""),
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra,
    },
  );

  // Step 2: pay + run (the marketplace reads `x-payment`).
  const resp = await fetchWithTimeout(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-payment": paymentPayload },
    body: payload,
  }, RUN_TIMEOUT);

  const txHash = resp.headers.get("x-payment-receipt") || resp.headers.get("X-Payment-Receipt");
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    // The route fails closed before settle on every error path → no charge.
    return errResult(`Hiring '${slug}' failed (HTTP ${resp.status}): ${typeof data.error === "string" ? data.error : "run error"}. No charge — the marketplace settles only on a successful run.`);
  }

  recordSpending(budget, cost, agent_id);
  return runSuccess(slug, cost, txHash, typeof data.result === "string" ? data.result : "");
}

function runSuccess(slug: string, cost: number, txHash: string | null, result: string): ToolResult {
  const lines = [
    `🤝 Hired ${slug}`,
    `Paid: ${fmtUsd(cost)}`,
    ...(txHash ? [`Tx: ${txHash}`] : []),
    ``,
    result,
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { slug, cost_usd: cost, ...(txHash ? { txHash } : {}), result },
  };
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
