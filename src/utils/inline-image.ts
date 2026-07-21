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

// sharp is a NATIVE optionalDependency, so a fresh `npx -y @blockrun/mcp@latest`
// can legitimately end up without it (musl/Alpine, unusual arch, offline CI,
// --no-optional). A top-level `import sharp` is resolved before main() runs, so
// its absence crashed the ENTIRE server — exit 1, empty stdout,
// ERR_MODULE_NOT_FOUND, all 19 tools gone, even for `--version` and for profiles
// that never register blockrun_image — for a preview that is OFF BY DEFAULT.
// No dev machine ever saw it, because every dev machine has sharp built.
// src/utils/qr.ts documents this exact hazard and loads lazily; this module did
// not, until 0.32.3. Same cached-lazy shape, so a missing sharp degrades to
// URL-only (buildInlineImageBlock already returns null on failure), never a crash.
// sharp ships as CJS `export = sharp`, so under Node's ESM interop the dynamic
// import exposes the factory as `.default`.
type SharpFactory = typeof import("sharp");
let sharpModule: SharpFactory | null | undefined;
async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    const mod = (await import("sharp")) as unknown as { default: SharpFactory };
    sharpModule = mod.default;
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

// Parse a positive-integer env knob, falling back to the default on an
// unset/empty/malformed/non-positive value. Bare `Number(env || default)` only
// catches empty/unset (a non-empty string is truthy), so a typo would become
// NaN and silently defeat the cap it guards — e.g. `data.length > NaN` is
// always false, removing the context-bloat ceiling.
function envInt(name: string, def: number, min = 1, max = Infinity): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), max) : def;
}

// Thumbnail bounds — small enough that the base64 stays cheap in context.
const MAX_DIM = envInt("BLOCKRUN_INLINE_MAX_DIM", 512);
const JPEG_QUALITY = envInt("BLOCKRUN_INLINE_QUALITY", 70, 1, 100);
// Hard ceiling on the BASE64-encoded thumbnail (the string that actually lands
// in the context window — base64 inflates the raw JPEG ~33%). Above this we
// skip inlining entirely (URL-only) so a single image can't blow up context.
const MAX_BYTES = envInt("BLOCKRUN_INLINE_MAX_BYTES", 900_000);
// Defensive caps on the SOURCE download/decode. Upstream is the trusted
// blockrun-hosted asset, but bounding the buffer + decode keeps a pathological
// response from ballooning memory before the thumbnail step runs.
const MAX_SOURCE_BYTES = 25_000_000;     // 25 MB ceiling on the fetched image
const MAX_INPUT_PIXELS = 100_000_000;    // ~100 MP decode guard for sharp

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
    // Resolve sharp before spending a network round-trip on an image we could
    // not thumbnail anyway. Absent sharp => URL-only, which is the documented
    // fallback for this whole feature.
    const sharpFn = await loadSharp();
    if (!sharpFn) return null;

    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    // Cap the download: reject early on a too-large Content-Length, and guard
    // again on the actual buffer in case the header lied or was absent.
    const declared = Number(resp.headers.get("content-length") || 0);
    if (declared > MAX_SOURCE_BYTES) return null;
    const input = Buffer.from(await resp.arrayBuffer());
    if (input.byteLength > MAX_SOURCE_BYTES) return null;

    const thumb = await sharpFn(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    const data = thumb.toString("base64");
    if (data.length > MAX_BYTES) return null;  // measure the encoded size

    return { type: "image", data, mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}
