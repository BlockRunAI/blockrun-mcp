// src/tools/image.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PaymentError } from "@blockrun/llm";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { formatError } from "../utils/errors.js";
import type { BudgetState } from "../types.js";
import { getChain, getImageClient } from "../utils/wallet.js";
import { readFile } from "node:fs/promises";
import { shouldInline, buildInlineImageBlock } from "../utils/inline-image.js";
import { confirmSpend } from "../utils/confirm-spend.js";

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
      const res = await fetch(ref, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
      const mime = (res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
      if (!mime.startsWith("image/")) throw new Error(`URL returned non-image content-type: ${mime || "(none)"}`);
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

function estimateCost(model: string, size: string): number {
  const base = GENERATE_MODEL_COST[model] ?? 0.06;
  if (size !== "1024x1024" && LARGE_SIZE_COST[model]) {
    return LARGE_SIZE_COST[model];
  }
  return base;
}

export function registerImageTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_image",
    {
      description: `Generate or edit images via BlockRun. Pays with USDC — no separate API keys needed.

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
        if (getChain() !== "base") {
          return {
            content: [{ type: "text", text: formatError("blockrun_image currently settles on Base only. Switch BlockRun to Base (for example: run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }],
            isError: true,
          };
        }

        const selectedModel = model || "openai/gpt-image-2";

        // Edit-mode inputs, normalized to data URIs in the edit branch below and
        // consumed at the shared call site after the spend confirmation.
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

        const estimatedCost = estimateCost(selectedModel, size);
        const budgetCheck = checkBudget(budget, agent_id, estimatedCost);
        if (!budgetCheck.allowed) {
          return {
            content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }],
            isError: true,
          };
        }

        // Confirm the spend before charging (elicitation; user can approve once,
        // approve all for the session, or cancel). No-ops on clients without
        // elicitation or when disabled via env.
        const confirm = await confirmSpend(server, {
          usd: estimatedCost,
          label: `${action === "edit" ? "image edit" : "image"} · ${selectedModel}`,
        });
        if (!confirm.ok) {
          return { content: [{ type: "text", text: confirm.reason || "Charge cancelled." }] };
        }

        const response = action === "edit"
          ? await getImageClient().edit(prompt, normalizedImage!, {
              model: selectedModel,
              size,
              ...(normalizedMask ? { mask: normalizedMask } : {}),
            })
          : await getImageClient().generate(prompt, { model: selectedModel, size, quality: quality as "standard" | "hd" });
        recordSpending(budget, estimatedCost, agent_id);

        const imageUrl = response.data?.[0]?.url;

        if (!imageUrl) {
          return {
            content: [{ type: "text", text: formatError("No image URL in response") }],
            isError: true,
          };
        }

        const textBlock = { type: "text" as const, text: `Image: ${imageUrl}\nPrompt: ${prompt}\nModel: ${selectedModel}` };
        // Optional inline preview (thumbnail) for rich clients. Best-effort:
        // on failure or if disabled, fall back to the URL-only text block.
        const previewBlock = shouldInline(inline) ? await buildInlineImageBlock(imageUrl) : null;

        return {
          content: previewBlock ? [previewBlock, textBlock] : [textBlock],
          structuredContent: { url: imageUrl, prompt, model: selectedModel, inlined: Boolean(previewBlock) },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof PaymentError) {
          return {
            content: [{ type: "text", text: `Image generation requires payment. Run blockrun_wallet with action: "setup" for funding instructions.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatError(`Image generation failed: ${errMsg}`) }],
          isError: true,
        };
      }
    }
  );
}
