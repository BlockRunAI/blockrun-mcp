// src/utils/qr.ts
import QRCode from "qrcode";
import open from "open";
import * as fs from "fs";
import * as path from "path";
import { WALLET_DIR, QR_FILE, USDC_ADDRESS, BASE_CHAIN_ID } from "./constants.js";

const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// sharp is a native module whose platform binaries ship as optional deps, so a
// fresh `npx -y @blockrun/mcp@latest` can silently fail to build it (musl/Alpine,
// unusual arch, offline CI, partial optionalDeps install). It's used ONLY for the
// cosmetic Solana-logo overlay on the payment QR. A top-level `import sharp` would
// be resolved before main() runs, so a failed install would crash the ENTIRE
// server — taking down all 18 tools for a decoration. Load it lazily and tolerate
// its absence: a missing sharp degrades to a logo-less QR, never a crash.
// sharp ships as a CJS `export = sharp`, so the module type IS the factory
// function; under Node's ESM interop the dynamic import exposes it as `.default`.
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

export function getEip681Uri(address: string, amountUsdc: number = 1.0): string {
  const amountWei = Math.floor(amountUsdc * 1_000_000);
  return `ethereum:${USDC_ADDRESS}@${BASE_CHAIN_ID}/transfer?address=${address}&uint256=${amountWei}`;
}

export function getSolanaPayUri(address: string, amountUsdc: number = 1.0): string {
  return `solana:${address}?spl-token=${SOLANA_USDC_MINT}&amount=${amountUsdc}&label=BlockRun`;
}

// Solana gradient ◎ logo as SVG (purple → green, Solana brand colors)
function buildSolanaLogoSvg(size: number): string {
  const half = size / 2;
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#9945FF"/>
      <stop offset="100%" style="stop-color:#14F195"/>
    </linearGradient>
    <clipPath id="c"><circle cx="${half}" cy="${half}" r="${half}"/></clipPath>
  </defs>
  <circle cx="${half}" cy="${half}" r="${half}" fill="url(#g)" clip-path="url(#c)"/>
  <text x="${half}" y="${half + 14}" font-size="40" font-weight="bold" fill="white"
    font-family="Arial,sans-serif" text-anchor="middle">◎</text>
</svg>`;
}

async function overlayLogo(qrBuf: Buffer, chain: "base" | "solana", qrSize: number): Promise<Buffer> {
  if (chain !== "solana") return qrBuf;

  // No sharp (native binary missing) → return the plain QR without the overlay.
  // The QR is fully scannable; only the cosmetic ◎ logo is skipped.
  const sharp = await loadSharp();
  if (!sharp) return qrBuf;

  const logoSize = Math.round(qrSize * 0.18);
  const pad = Math.round(logoSize * 0.08);

  const logoBuf = await sharp(Buffer.from(buildSolanaLogoSvg(logoSize)))
    .resize(logoSize, logoSize)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .toBuffer();

  const totalSize = logoSize + pad * 2;
  const offset = Math.round((qrSize - totalSize) / 2);

  return sharp(qrBuf)
    .composite([{ input: logoBuf, left: offset, top: offset }])
    .toBuffer();
}

export async function generateQrPng(address: string, chain: "base" | "solana" = "base"): Promise<string> {
  const uri = chain === "solana" ? getSolanaPayUri(address) : getEip681Uri(address);
  const qrSize = 400;

  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  }

  const qrBuf = await QRCode.toBuffer(uri, {
    type: "png",
    width: qrSize,
    margin: 2,
    errorCorrectionLevel: "H",
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  const finalBuf = await overlayLogo(qrBuf, chain, qrSize);
  fs.writeFileSync(QR_FILE, finalBuf);

  return QR_FILE;
}

/**
 * Render an arbitrary URL as a QR PNG (no logo overlay) and return the path.
 * Used by RealFace enrollment so the real person can scan the upstream H5
 * liveness link on their phone. `fileName` is written under WALLET_DIR.
 */
export async function generateUrlQrPng(url: string, fileName: string = "realface-qr.png"): Promise<string> {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  }

  const outPath = path.join(WALLET_DIR, fileName);
  await QRCode.toFile(outPath, url, {
    type: "png",
    width: 400,
    margin: 2,
    errorCorrectionLevel: "H",
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  return outPath;
}

export async function openQrInViewer(qrPath: string): Promise<void> {
  try {
    await open(qrPath);
  } catch {
    // Silently fail
  }
}

// Hosted BlockRun top-up portal — opened in the browser when a wallet needs
// funds (no local panel server required, unlike Franklin's in-panel top-up).
export const DEPOSIT_URL = "https://buy.blockrun.ai";

/**
 * Open a URL in the user's default browser. Best-effort — returns true if the
 * launch was attempted without error, false on any failure (headless / no
 * browser / permission), so the caller can fall back to printing the link.
 */
export async function openUrl(url: string): Promise<boolean> {
  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
}
