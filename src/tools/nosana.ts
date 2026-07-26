// src/tools/nosana.ts
//
// Nosana — rent a GPU container on a decentralized market with the Solana wallet
// this MCP already manages.
//
// Why this sits next to blockrun_modal rather than replacing it. Modal is the
// fast path: one HTTP call, USDC on Base, nothing else to hold. Nosana is the
// durable path: the market is a Solana program, so no company can switch off a
// running lease, and the cheapest GPU market measured $0.048/hr against $1.50/hr
// for a managed T4. An agent that can only rent from one provider stops existing
// when that provider does, so the useful thing is having both verbs available
// with the same wallet — not picking a winner.
//
// The cost is real and is stated up front in the tool description: you must hold
// NOS and a little SOL, and the job definition is pinned to public IPFS, so
// anything secret has to travel through the confidential channel instead of env.
//
// @nosana/sdk is an OPTIONAL PEER dependency, imported lazily inside the handler.
// Deliberately not `optionalDependencies`: npm installs those by default, so
// every user would carry the weight of a tool most will never call.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, extractErrorMessage } from "../utils/errors.js";

// The cheapest GPU market on the network as of 2026-07-27. Overridable per call;
// a default only exists so the common case is one argument, not three.
export const NOSANA_DEFAULT_MARKET = "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq";
export const NOSANA_DEFAULT_USD_PER_HOUR = 0.04796;
export const NOSANA_MIN_SECONDS = 60;
export const NOSANA_MAX_SECONDS = 86400;

export type NosanaPlan =
  | { ok: true; seconds: number; market: string; estimateUsd: number }
  | { ok: false; reason: string };

/**
 * Exported for unit tests. Decide what to ask the market for, and refuse
 * anything unaskable BEFORE any key is touched or any transaction is built.
 *
 * The duration bounds are the market's, not ours: below a minute the escrow
 * accounting is not worth the signature, and a day is the ceiling a caller can
 * reason about. `maxSpendUsd` is the caller's own brake — an agent looping on
 * this tool should be stopped by arithmetic, not by its balance running out.
 */
export function planNosanaRental({
  seconds,
  market = NOSANA_DEFAULT_MARKET,
  usdPerHour = NOSANA_DEFAULT_USD_PER_HOUR,
  maxSpendUsd,
}: {
  seconds: number;
  market?: string;
  usdPerHour?: number;
  maxSpendUsd?: number;
}): NosanaPlan {
  if (!Number.isInteger(seconds) || seconds < NOSANA_MIN_SECONDS || seconds > NOSANA_MAX_SECONDS) {
    return { ok: false, reason: `seconds must be a whole number from ${NOSANA_MIN_SECONDS} to ${NOSANA_MAX_SECONDS}` };
  }
  if (typeof market !== "string" || market.length < 32) {
    return { ok: false, reason: "market must be a Solana account address" };
  }
  const estimateUsd = (usdPerHour * seconds) / 3600;
  if (typeof maxSpendUsd === "number" && estimateUsd > maxSpendUsd) {
    return { ok: false, reason: `that lease costs about $${estimateUsd.toFixed(4)}, over the $${maxSpendUsd} you allowed` };
  }
  return { ok: true, seconds, market, estimateUsd };
}

/**
 * Exported for unit tests. Build the job definition the market pins.
 *
 * `cmd` must be a flat string. An array command is accepted by the SDK and then
 * kills the container a few seconds in — a failure with no error message, so it
 * is worth refusing here where the caller can still read why.
 */
export function buildNosanaDefinition({
  image,
  port,
  cmd,
  env,
  gpu = true,
}: {
  image: string;
  port?: number;
  cmd?: string;
  env?: Record<string, string>;
  gpu?: boolean;
}): { definition: unknown } | { error: string } {
  if (!image || typeof image !== "string") return { error: "image is required" };
  if (cmd !== undefined && typeof cmd !== "string") {
    return { error: "cmd must be a single shell string — an array command starts and then dies silently on the node" };
  }
  const args: Record<string, unknown> = { image, gpu };
  if (port !== undefined) args.expose = port;
  if (cmd !== undefined) args.cmd = cmd;
  if (env !== undefined) args.env = env;
  return { definition: { version: "0.1", type: "container", ops: [{ type: "container/run", id: "rented", args }] } };
}

/** The Solana key this MCP already manages, same precedence getClient() uses. */
async function solanaKey(): Promise<string | null> {
  if (process.env.SOLANA_WALLET_KEY) return process.env.SOLANA_WALLET_KEY;
  const { loadSolanaWallet } = await import("@blockrun/llm");
  return loadSolanaWallet() || null;
}

type NosanaSdk = {
  ipfs: { pin: (definition: unknown) => Promise<string> };
  jobs: {
    list: (hash: string, seconds: number, market: string) => Promise<unknown>;
    get: (job: string) => Promise<unknown>;
    extend: (job: string, seconds: number, wait: boolean) => Promise<unknown>;
  };
};

// Imported through a variable so the compiler does not try to resolve an optional
// package that most installs will not have. The shape is asserted below instead.
const NOSANA_SDK = "@nosana/sdk";

async function loadSdk(key: string): Promise<{ sdk: NosanaSdk; exposeUrl: (job: string, port: number) => string }> {
  const mod = (await import(NOSANA_SDK)) as unknown as {
    Client: new (network: string, key: string) => NosanaSdk;
    getExposeIdHash: (job: string, opIndex: number, port: number) => string;
  };
  return {
    sdk: new mod.Client("mainnet", key),
    exposeUrl: (job, port) => `https://${mod.getExposeIdHash(job, 0, port)}.node.k8s.prd.nos.ci`,
  };
}

export function registerNosanaTool(server: McpServer): void {
  server.registerTool(
    "blockrun_nosana",
    {
      description: `Rent a GPU container on Nosana, a decentralized market on Solana, with the wallet this MCP already holds.

Use this when the container must outlive its provider: the market is an on-chain program, so no company can end a running lease, and the cheapest GPU market is about $0.05/hr against $1.50/hr for a managed T4. Use blockrun_modal instead when you want a box in one call and do not want to hold a second token.

action:"rent" — post a job and get back its address and public URL.
action:"status" — read a job's state and how much lease time is left.
action:"extend" — buy more time on a lease you already pay for.

What this costs you beyond money: you must hold NOS and a little SOL on the wallet, and the job definition is pinned to PUBLIC IPFS. Never put a key or token in \`env\` — it would be world-readable. cmd must be a single shell string.

Requires the optional @nosana/sdk package: npm install @nosana/sdk`,
      inputSchema: {
        action: z.enum(["rent", "status", "extend"]).describe("What to do."),
        image: z.string().optional().describe("Container image, e.g. 'docker.io/library/nginx:alpine'. Required for rent."),
        seconds: z.number().optional().describe("Lease length in seconds (60..86400). Required for rent and extend."),
        port: z.number().optional().describe("Port to expose publicly. Returns a URL derived from the job address."),
        cmd: z.string().optional().describe("Command to run, as ONE shell string."),
        env: z.record(z.string(), z.string()).optional().describe("Environment variables. PUBLIC — never put secrets here."),
        market: z.string().optional().describe(`Market account. Defaults to ${NOSANA_DEFAULT_MARKET}.`),
        job: z.string().optional().describe("Job address. Required for status and extend."),
        max_spend_usd: z.number().optional().describe("Refuse the lease if it would cost more than this."),
      },
    },
    async ({ action, image, seconds, port, cmd, env, market, job, max_spend_usd }) => {
      try {
        const key = await solanaKey();
        if (!key) {
          return {
            content: [{ type: "text", text: formatError("No Solana wallet found. Use blockrun_wallet to create one, or set SOLANA_WALLET_KEY.") }],
            isError: true,
          };
        }

        let loaded;
        try {
          loaded = await loadSdk(key);
        } catch {
          return {
            content: [{ type: "text", text: formatError("@nosana/sdk is not installed. Run: npm install @nosana/sdk") }],
            isError: true,
          };
        }
        const { sdk, exposeUrl } = loaded;

        if (action === "status") {
          if (!job) return { content: [{ type: "text", text: formatError("status needs a job address.") }], isError: true };
          const result = await sdk.jobs.get(job);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        if (action === "extend") {
          if (!job) return { content: [{ type: "text", text: formatError("extend needs a job address.") }], isError: true };
          const plan = planNosanaRental({ seconds: seconds ?? 0, market, maxSpendUsd: max_spend_usd });
          if (!plan.ok) return { content: [{ type: "text", text: formatError(plan.reason) }], isError: true };
          const result = await sdk.jobs.extend(job, plan.seconds, false);
          return {
            content: [{ type: "text", text: JSON.stringify({ job, added_seconds: plan.seconds, result }, null, 2) }],
          };
        }

        const plan = planNosanaRental({ seconds: seconds ?? 0, market, maxSpendUsd: max_spend_usd });
        if (!plan.ok) return { content: [{ type: "text", text: formatError(plan.reason) }], isError: true };
        const built = buildNosanaDefinition({ image: image ?? "", port, cmd, env });
        if ("error" in built) return { content: [{ type: "text", text: formatError(built.error) }], isError: true };

        const ipfsHash = await sdk.ipfs.pin(built.definition);
        const listed = (await sdk.jobs.list(ipfsHash, plan.seconds, plan.market)) as { job?: string; address?: string } | string;
        const jobAddress = typeof listed === "string" ? listed : listed.job || listed.address;
        if (!jobAddress) {
          return { content: [{ type: "text", text: formatError("The market accepted no job.") }], isError: true };
        }

        const out = {
          job: jobAddress,
          market: plan.market,
          seconds: plan.seconds,
          estimated_usd: Number(plan.estimateUsd.toFixed(4)),
          ipfs: ipfsHash,
          url: port === undefined ? null : exposeUrl(jobAddress, port),
        };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
      } catch (err) {
        return { content: [{ type: "text", text: formatError(extractErrorMessage(err)) }], isError: true };
      }
    }
  );
}
