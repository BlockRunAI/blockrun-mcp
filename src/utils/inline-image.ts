// src/utils/inline-image.ts
//
// Optional inline image preview. When enabled, a generated image is fetched,
// downscaled to a small JPEG thumbnail, and returned as an MCP `type:"image"`
// content block so rich clients (e.g. the VS Code extension) render it inline.
// The full-resolution URL is always kept in the text block — the thumbnail is
// a preview, not a replacement.
//
// Off by default to avoid context/token bloat. Enable globally with
// BLOCKRUN_INLINE_IMAGES=1 (or true/yes/on), or per call with the tool's
// `inline` param (which takes precedence over the env default).

import sharp from "sharp";

// Thumbnail bounds — small enough that the base64 stays cheap in context.
const MAX_DIM = Number(process.env.BLOCKRUN_INLINE_MAX_DIM || 512);
const JPEG_QUALITY = Number(process.env.BLOCKRUN_INLINE_QUALITY || 70);
// Hard ceiling on the encoded thumbnail; above this we skip inlining entirely
// (URL-only) so a single image can never blow up the context window.
const MAX_BYTES = Number(process.env.BLOCKRUN_INLINE_MAX_BYTES || 900_000);

function truthy(v: string | undefined): boolean {
  return v != null && /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Resolve whether to inline a preview. Per-call `param` wins; otherwise the
 * BLOCKRUN_INLINE_IMAGES env default; otherwise off.
 */
export function shouldInline(param?: boolean): boolean {
  if (typeof param === "boolean") return param;
  return truthy(process.env.BLOCKRUN_INLINE_IMAGES);
}

export interface InlineImageBlock {
  type: "image";
  data: string;      // base64 (no data: prefix, per MCP ImageContent)
  mimeType: string;
}

/**
 * Fetch the image at `url`, downscale to a JPEG thumbnail, and return an MCP
 * image content block. Returns null (caller falls back to URL-only) on any
 * failure or if the thumbnail exceeds MAX_BYTES — inlining is best-effort and
 * must never break the tool call.
 */
export async function buildInlineImageBlock(url: string): Promise<InlineImageBlock | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const input = Buffer.from(await resp.arrayBuffer());

    const thumb = await sharp(input)
      .rotate()
      .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    if (thumb.byteLength > MAX_BYTES) return null;

    return { type: "image", data: thumb.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}
