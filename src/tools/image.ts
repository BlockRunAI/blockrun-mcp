// src/tools/image.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PaymentError } from "@blockrun/llm";
import { reserveBudget, recordSpending, recordActualSpend, reReserveIfHigher, BudgetExceededError } from "../utils/budget.js";
import { formatError } from "../utils/errors.js";
import { openUrl, DEPOSIT_URL } from "../utils/qr.js";
import type { BudgetState } from "../types.js";
import { getChain, getImageClient } from "../utils/wallet.js";
import { solanaPaidPost } from "../utils/solana-402.js";
import { isBlockedFetchHost } from "../utils/ssrf.js";
import { shouldInline, buildInlineImageBlock } from "../utils/inline-image.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// The gateway's /v1/images/image2image only accepts base64 data URIs for the
// source image(s). Callers naturally have local file paths or http(s) URLs, so
// normalize those into data URIs here instead of forcing them to pre-encode.
// Mirrors Franklin's resolveReferenceImage (src/tools/imagegen.ts): same data
// URI / http / local-path handling, with a size cap, fetch timeout, and
// content-type / extension validation.
const REFERENCE_IMAGE_MAX_BYTES = 4_000_000;
const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export async function toImageDataUri(ref: string): Promise<string> {
  if (ref.startsWith("data:image/")) return ref;

  if (/^https?:\/\//i.test(ref)) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      // Follow redirects manually so each hop's host is re-validated against the
      // SSRF deny-list — a supplied/prompt-injected URL must not reach (or 30x
      // into) localhost, the cloud metadata endpoint, or the private network.
      let url = ref;
      let res: Response;
      for (let hop = 0; ; hop++) {
        const host = new URL(url).hostname;
        if (isBlockedFetchHost(host)) {
          throw new Error(`refusing to fetch a private/loopback/link-local address: ${host}`);
        }
        res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          if (hop >= 5) throw new Error("too many redirects");
          url = new URL(location, url).toString();
          continue;
        }
        break;
      }
      if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
      const mime = (res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
      if (!mime.startsWith("image/")) throw new Error(`URL returned non-image content-type: ${mime || "(none)"}`);
      // Reject by advertised size BEFORE buffering, so an oversized remote image
      // can't be fully read into memory (OOM risk in the long-lived stdio
      // process) only to be rejected. The post-read check below still covers
      // chunked responses with no Content-Length.
      const advertised = Number(res.headers.get("content-length"));
      if (Number.isFinite(advertised) && advertised > REFERENCE_IMAGE_MAX_BYTES) {
        throw new Error(`image too large: ${(advertised / 1e6).toFixed(1)}MB > ${REFERENCE_IMAGE_MAX_BYTES / 1e6}MB cap`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > REFERENCE_IMAGE_MAX_BYTES) {
        throw new Error(`image too large: ${(buffer.byteLength / 1e6).toFixed(1)}MB > ${REFERENCE_IMAGE_MAX_BYTES / 1e6}MB cap`);
      }
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Treat as a local file path.
  const ext = ref.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_EXT_MIME[ext];
  if (!mime) throw new Error(`unsupported image extension ".${ext}"; use png/jpg/jpeg/gif/webp`);
  const buffer = await readFile(ref);
  if (buffer.byteLength > REFERENCE_IMAGE_MAX_BYTES) {
    throw new Error(`image too large: ${(buffer.byteLength / 1e6).toFixed(1)}MB > ${REFERENCE_IMAGE_MAX_BYTES / 1e6}MB cap; resize or crop first`);
  }
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// Base (1024x1024) prices, mirroring the live /v1/images/models catalog.
// dall-e-3 and flux-schnell were delisted upstream — do not re-add them.
const GENERATE_MODEL_COST: Record<string, number> = {
  "zai/cogview-4": 0.015,
  "xai/grok-imagine-image": 0.02,
  "xai/grok-imagine-image-pro": 0.07,
  "openai/gpt-image-1": 0.02,
  "openai/gpt-image-2": 0.06,
  "google/nano-banana": 0.05,
  "google/nano-banana-pro": 0.10,
};

// Non-square / oversized renders cost more on these models (live catalog).
const LARGE_SIZE_COST: Record<string, number> = {
  "openai/gpt-image-1": 0.04,
  "openai/gpt-image-2": 0.12,
  "google/nano-banana-pro": 0.15, // 4096x4096 tier
};

// Mirrors the gateway's EDIT_SUPPORTED_MODELS (/v1/images/image2image).
const EDIT_MODELS = new Set([
  "openai/gpt-image-1",
  "openai/gpt-image-2",
  "google/nano-banana",
  "google/nano-banana-pro",
]);

// Mirrors the gateway's MAX_IMAGES_BY_PREFIX. Multi-image edit fuses several
// source images (e.g. a subject + a layout guide, or a reference + a brand logo)
// into one render. openai/* accepts up to 4 source images, google/* up to 3.
const MAX_EDIT_IMAGES_BY_PREFIX: Record<string, number> = {
  "openai/": 4,
  "google/": 3,
};

// Mirrors the gateway's MASK_SUPPORTED_MODELS — only OpenAI image models inpaint.
const MASK_MODELS = new Set(["openai/gpt-image-1", "openai/gpt-image-2"]);

const IMAGE_MODELS = [
  "zai/cogview-4",
  "google/nano-banana",
  "google/nano-banana-pro",
  "openai/gpt-image-1",
  "openai/gpt-image-2",
  "xai/grok-imagine-image",
  "xai/grok-imagine-image-pro",
] as const;

// The large-size tier applies only when a dimension genuinely exceeds 1024.
// A plain `size !== "1024x1024"` inequality billed SMALLER renders (512x512) and
// harmless typos ("1024X1024", trailing space) at the large-tier price.
function isLargerThanBase(size: string): boolean {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(size);
  if (!m) return false; // unrecognized → treat as base, don't over-charge
  return Math.max(Number(m[1]), Number(m[2])) > 1024;
}

function estimateCost(model: string, size: string): number {
  const base = GENERATE_MODEL_COST[model] ?? 0.06;
  if (LARGE_SIZE_COST[model] && isLargerThanBase(size)) {
    return LARGE_SIZE_COST[model];
  }
  return base;
}

// The Solana gateway routes render synchronously (generation runs 10-180s,
// then the result is mirrored to GCS before the response returns), so the
// paid request's timeout must cover the whole render — not just a round-trip.
const SOLANA_IMAGE_TIMEOUT_MS = 300_000;

/**
 * The image2image routes (both gateways) ship the provider's output verbatim —
 * google/nano-banana returns a multi-megabyte base64 data URI, not a hosted
 * URL. Returning that inline would flood the MCP client's context, so persist
 * it to a temp file and hand back the path. Non-data URLs pass through.
 */
export async function materializeImageUrl(imageUrl: string): Promise<string> {
  if (!imageUrl.startsWith("data:image/")) return imageUrl;
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is.exec(imageUrl);
  if (!m) return imageUrl; // undecodable — better to return the paid result verbatim than drop it
  const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  const file = join(tmpdir(), `blockrun-image-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`);
  await writeFile(file, Buffer.from(m[2], "base64"));
  return file;
}

/**
 * Endpoint + body for a Solana-gateway image call. The gateway's zod schema
 * takes quality as low|medium|high|auto (the OpenAI latency knob), not this
 * tool's standard|hd — map hd→high and drop standard (the gateway default)
 * so the request isn't rejected with a 400.
 */
export function buildSolanaImageRequest(
  action: "generate" | "edit",
  params: { model: string; prompt: string; size: string; quality?: string; image?: string | string[]; mask?: string },
): { endpoint: string; body: Record<string, unknown> } {
  if (action === "edit") {
    return {
      endpoint: "/v1/images/image2image",
      body: {
        model: params.model,
        prompt: params.prompt,
        image: params.image,
        size: params.size,
        n: 1,
        ...(params.mask ? { mask: params.mask } : {}),
      },
    };
  }
  return {
    endpoint: "/v1/images/generations",
    body: {
      model: params.model,
      prompt: params.prompt,
      size: params.size,
      n: 1,
      ...(params.quality === "hd" ? { quality: "high" } : {}),
    },
  };
}

export function registerImageTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_image",
    {
      description: `Generate or edit images via BlockRun. Pays with USDC on the ACTIVE chain — Base or Solana (see blockrun_wallet) — no separate API keys needed.

Actions:
- generate (default): Create image from text prompt
- edit: Transform an existing image using img2img

Generation models (1024x1024 base price; larger sizes cost more on gpt-image-*):
- openai/gpt-image-2 ($0.06–0.12) — flagship, reasoning-driven, multilingual on-image text + character consistency (default)
- openai/gpt-image-1 ($0.02–0.04) — GPT native image generation
- google/nano-banana ($0.05) — Gemini-family image model
- google/nano-banana-pro ($0.10; $0.15 at 4096px) — up to 4K, strongest photorealism
- xai/grok-imagine-image ($0.02) — stylized, fast
- xai/grok-imagine-image-pro ($0.07) — higher quality Grok Imagine
- zai/cogview-4 ($0.015) — cheapest, photorealistic detailed scenes

Edit (img2img) models: openai/gpt-image-2 (default), openai/gpt-image-1, google/nano-banana, google/nano-banana-pro
Multi-image edit: pass an array of 2–4 source images to "image" to fuse them in one render (openai/* up to 4, google/* up to 3) — e.g. a subject plus a sprite layout guide, or a reference plus a brand logo.
Source images and masks accept a base64 data URI, an http(s) URL, or a local file path (auto-encoded). Inpaint mask (openai/gpt-image-* only) via "mask"; not combinable with multiple source images.`,
      inputSchema: {
        prompt: z.string().describe("Image description or edit instructions"),
        action: z.enum(["generate", "edit"]).optional().default("generate").describe("generate: create from text; edit: transform existing image"),
        model: z.enum(IMAGE_MODELS).optional().describe("Model to use (default: openai/gpt-image-2 for both generate and edit). gpt-image-2 renders on-image text best; nano-banana-pro for 4K photorealism; cogview-4 / grok-imagine-image for cheap drafts."),
        image: z
          .union([z.string(), z.array(z.string()).min(1).max(4)])
          .optional()
          .describe("Source image(s) for edit action: a base64 data URI, an http(s) URL, or a local file path (auto-encoded to a data URI) — or an array of 2–4 to fuse into one render (e.g. subject + layout guide, or reference + brand logo). openai/* accepts up to 4, google/* up to 3; a mask cannot be combined with multiple images."),
        mask: z.string().optional().describe("Inpaint mask for edit action (openai/gpt-image-* only): a base64 data URI, http(s) URL, or local file path. Transparent areas of the mask are regenerated. Cannot be combined with multiple source images."),
        size: z.string().optional().default("1024x1024").describe("Image size. Common values: 1024x1024 (all models), 1536x1024 / 1024x1536 (gpt-image-*), 2048x2048 / 4096x4096 (nano-banana-pro)"),
        quality: z.enum(["standard", "hd"]).optional().default("standard"),
        inline: z.boolean().optional().describe("Return a small inline image preview (thumbnail) the client can render in-conversation, in addition to the full-resolution URL. Defaults to the BLOCKRUN_INLINE_IMAGES env setting (off unless set). Rich clients (e.g. the VS Code extension) render it; plain terminals ignore it. Off keeps responses lightweight."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement."),
      },
    },
    async ({ prompt, action, model, image, mask, size, quality, inline, agent_id }) => {
      try {
        const selectedModel = model || "openai/gpt-image-2";

        // Edit-mode inputs, normalized to data URIs in the branch below and
        // consumed at the shared charge site after the spend confirmation.
        let normalizedImage: string | string[] | undefined;
        let normalizedMask: string | undefined;

        // Validate the edit action up front (before estimating/charging).
        if (action === "edit") {
          if (!image) {
            return {
              content: [{ type: "text", text: formatError("image parameter required for edit action (base64 or URL)") }],
              isError: true,
            };
          }
          if (!EDIT_MODELS.has(selectedModel)) {
            return {
              content: [{ type: "text", text: formatError("Image edits support openai/gpt-image-1, openai/gpt-image-2, google/nano-banana, or google/nano-banana-pro") }],
              isError: true,
            };
          }
          const sourceImages = Array.isArray(image) ? image : [image];
          const maxImages = MAX_EDIT_IMAGES_BY_PREFIX[`${selectedModel.split("/")[0]}/`] ?? 1;
          if (sourceImages.length > maxImages) {
            return {
              content: [{ type: "text", text: formatError(`${selectedModel} accepts at most ${maxImages} source image${maxImages > 1 ? "s" : ""} per edit (got ${sourceImages.length}).`) }],
              isError: true,
            };
          }
          if (mask) {
            if (!MASK_MODELS.has(selectedModel)) {
              return {
                content: [{ type: "text", text: formatError("mask (inpaint) is supported only by openai/gpt-image-1 and openai/gpt-image-2") }],
                isError: true,
              };
            }
            if (sourceImages.length > 1) {
              return {
                content: [{ type: "text", text: formatError("mask cannot be combined with multiple source images; send a single image with a mask, or multiple images without a mask") }],
                isError: true,
              };
            }
          }
          try {
            const dataUris = await Promise.all(sourceImages.map(toImageDataUri));
            normalizedImage = dataUris.length === 1 ? dataUris[0] : dataUris;
            if (mask) normalizedMask = await toImageDataUri(mask);
          } catch (e) {
            return {
              content: [{ type: "text", text: formatError(`Could not load source image: ${e instanceof Error ? e.message : String(e)}`) }],
              isError: true,
            };
          }
        }

        // Shared charge site: reserve the estimate, confirm the spend, call, and
        // record the real cost — releasing the reservation in finally on every
        // path (including a decline, which charges nothing).
        const estimatedCost = estimateCost(selectedModel, size);
        let gate = reserveBudget(budget, agent_id, estimatedCost);
        if (!gate.allowed) {
          return {
            content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }
        try {
          // Confirm the spend before charging (elicitation; user can approve
          // once, approve all for the session, or decline to abort). No-ops on
          // clients without elicitation or when disabled via env.
          const confirm = await confirmSpend(server, {
            usd: estimatedCost,
            label: `${action === "edit" ? "image edit" : "image"} · ${selectedModel}`,
          });
          if (!confirm.ok) {
            return { content: [{ type: "text", text: confirm.reason || "Charge cancelled." }] };
          }

          let imageUrl: string | undefined;
          // Actual USDC charged, surfaced in the result footer so the user always
          // sees the price without relying on the plugin's announce-cost skill.
          // Base has no billed-amount in the SDK response, so the catalog estimate
          // (which mirrors the live price table) is the best available figure;
          // Solana returns the real 402-quoted amount.
          let billedUsd = estimatedCost;
          if (getChain() === "solana") {
            // Solana: manual x402 against the sol.blockrun.ai gateway (the SDK's
            // ImageClient signs Base/EVM payments only). Record the ACTUAL cost
            // from the 402 quote — the Solana gateway prices carry a markup over
            // the Base table above.
            const { endpoint, body } = buildSolanaImageRequest(action, {
              model: selectedModel,
              prompt,
              size,
              quality,
              image: normalizedImage,
              mask: normalizedMask,
            });
            const { data, paidUsd } = await solanaPaidPost(endpoint, body, SOLANA_IMAGE_TIMEOUT_MS, {
              // The Solana gateway prices carry a markup over the Base estimate
              // table, so the real quote can exceed what we reserved. Re-reserve
              // the true amount against the cap BEFORE the transfer is signed
              // (mirrors blockrun_video); throwing here aborts before any payment.
              onQuote: (quotedUsd) => {
                gate = reReserveIfHigher(budget, gate, agent_id, estimatedCost, quotedUsd);
                if (!gate.allowed) {
                  throw new BudgetExceededError(`${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.`);
                }
              },
            });
            recordActualSpend(budget, paidUsd, estimatedCost, agent_id);
            billedUsd = paidUsd ?? estimatedCost;
            imageUrl = (data as { data?: Array<{ url?: string }> }).data?.[0]?.url;
          } else {
            const response = action === "edit"
              ? await getImageClient().edit(prompt, normalizedImage!, {
                  model: selectedModel,
                  size,
                  ...(normalizedMask ? { mask: normalizedMask } : {}),
                })
              : await getImageClient().generate(prompt, { model: selectedModel, size, quality: quality as "standard" | "hd" });
            recordSpending(budget, estimatedCost, agent_id);
            imageUrl = response.data?.[0]?.url;
          }

          if (!imageUrl) {
            return {
              content: [{ type: "text", text: formatError("No image URL in response") }],
              isError: true,
            };
          }

          const delivered = await materializeImageUrl(imageUrl);
          const savedLocally = delivered !== imageUrl;
          const textBlock = {
            type: "text" as const,
            text: `Image: ${delivered}${savedLocally ? " (saved locally — the gateway returned inline image data)" : ""}\nPrompt: ${prompt}\nModel: ${selectedModel}\nCost: $${billedUsd.toFixed(4)}`,
          };
          // Optional inline preview (thumbnail) for rich clients. Best-effort:
          // on failure or if disabled, fall back to the URL-only text block.
          const previewBlock = shouldInline(inline) ? await buildInlineImageBlock(imageUrl) : null;

          return {
            content: previewBlock ? [previewBlock, textBlock] : [textBlock],
            structuredContent: { url: delivered, prompt, model: selectedModel, cost_usd: billedUsd, inlined: Boolean(previewBlock) },
          };
        } finally {
          gate.release();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof BudgetExceededError) {
          return { content: [{ type: "text", text: errMsg }], isError: true };
        }
        if (err instanceof PaymentError) {
          return {
            content: [{ type: "text", text: `Image generation needs USDC — your wallet is out of funds.${await openUrl(DEPOSIT_URL) ? ` Opened ${DEPOSIT_URL} to top up.` : ` Top up at ${DEPOSIT_URL}.`}\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Image generation failed: ${errMsg}`, { altModels: "google/nano-banana, zai/cogview-4" }) }],
          isError: true,
        };
      }
    }
  );
}
