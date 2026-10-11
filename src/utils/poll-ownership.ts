// src/utils/poll-ownership.ts
// Proof of job ownership for the Solana gateway's async media polls, signed by
// the wallet that paid the submit — WITHOUT a payment.
//
// Every media poll on sol.blockrun.ai used to need an x402 payment header as
// its proof of identity. On Solana a signed payment is a transaction pinned to
// a recent blockhash (~60-90s of life), so a multi-minute video job meant
// signing a fresh payment every ~20s. Since 2026-10-10 (blockrun-sol
// src/lib/poll-ownership.ts, revision 00561-ghx) the poll routes also accept
// a short ed25519 signature over the job id instead:
//
//   message   "blockrun-poll:v1:<kind>:<job id from the poll_url path>:<unix seconds>"
//   headers   x-poll-wallet     base58 32-byte public key of the submitting wallet
//             x-poll-timestamp  the <unix seconds> in the message (±300s skew)
//             x-poll-signature  base58 64-byte detached ed25519 signature
//
// Nothing here can move money: it signs a text message, not a transaction.
// The gateway compares the proven wallet to the payer bound into the job.
//
// Pure node:crypto + bs58, no @blockrun/llm import, so the signature can be
// checked in tests against the real verifier without any module mocks.
import { createPrivateKey, createPublicKey, sign as ed25519Sign, type KeyObject } from "node:crypto";
import bs58Module from "bs58";

// bs58 ships an ESM build (default export = the codec) and a CJS build
// (exports.default = the codec). The published ESM bundle resolves the ESM
// build, but Node 20's --experimental-test-module-mocks loader resolves the
// CJS one, where the default import is { default: codec } and bs58.encode is
// undefined — 13 red tests on node 20.19 only. Unwrap either shape.
const bs58: typeof bs58Module =
  (bs58Module as unknown as { default?: typeof bs58Module }).default ?? bs58Module;

/** The poll route's <kind>; music polls are "audio" on the wire. */
export type PollKind = "video" | "audio" | "image";

export const POLL_AUTH_HEADERS = {
  wallet: "x-poll-wallet",
  timestamp: "x-poll-timestamp",
  signature: "x-poll-signature",
} as const;

export function pollAuthMessage(kind: PollKind, jobId: string, timestampS: number): string {
  return `blockrun-poll:v1:${kind}:${jobId}:${timestampS}`;
}

// The poll routes that verify the proof, keyed by the path the gateway hands
// back as poll_url. Derived from the POLL path, not the submit endpoint: an
// image edit is submitted to /v1/images/image2image and polled on
// /api/v1/images/generations/{id}, whose route verifies kind "image".
const POLL_ROUTES: Array<[RegExp, PollKind]> = [
  [/\/v1\/videos\/generations\/([^/]+)$/, "video"],
  [/\/v1\/audio\/generations\/([^/]+)$/, "audio"],
  [/\/v1\/images\/generations\/([^/]+)$/, "image"],
];

/**
 * The kind and job id the gateway will verify for this poll URL, or null for a
 * route that does not accept the proof (the caller keeps paid polling).
 * The job id is the decoded path segment — the exact string the route signs
 * against — which is the submit response's `id` as returned.
 */
export function pollRouteFor(pollUrl: URL): { kind: PollKind; jobId: string } | null {
  for (const [pattern, kind] of POLL_ROUTES) {
    const match = pollUrl.pathname.match(pattern);
    if (!match) continue;
    try {
      const jobId = decodeURIComponent(match[1]);
      return jobId ? { kind, jobId } : null;
    } catch {
      return null;
    }
  }
  return null;
}

// RFC 8410 PKCS#8 prefix for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface PollSigner {
  /** base58 public key the signatures verify under. */
  wallet: string;
  /** Fresh x-poll-* headers for one poll (sign per poll: the timestamp is in the message). */
  headers(kind: PollKind, jobId: string, nowMs?: number): Record<string, string>;
}

/**
 * A signer over a Solana keypair's 64-byte secret key (seed ‖ public key, the
 * .solana-session format). The key material is held only inside a KeyObject
 * and never leaves this closure. Throws on a malformed key — callers treat
 * that as "no ownership proof" and keep paid polling.
 */
export function createPollSigner(secretKey: Uint8Array): PollSigner {
  if (secretKey.length !== 64 && secretKey.length !== 32) {
    throw new Error("Solana secret key must be 32 or 64 bytes");
  }
  const seed = Buffer.from(secretKey.subarray(0, 32));
  const privateKey: KeyObject = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  seed.fill(0);
  // The wallet is DERIVED from the seed, so the signature always verifies
  // under the key we present; for a well-formed keypair it is also bytes
  // 32..63 — the address that paid the submit.
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("Could not derive the Solana public key");
  const wallet = bs58.encode(Buffer.from(jwk.x, "base64url"));
  return {
    wallet,
    headers(kind, jobId, nowMs = Date.now()) {
      const timestamp = Math.floor(nowMs / 1000);
      const signature = ed25519Sign(null, Buffer.from(pollAuthMessage(kind, jobId, timestamp), "utf8"), privateKey);
      return {
        [POLL_AUTH_HEADERS.wallet]: wallet,
        [POLL_AUTH_HEADERS.timestamp]: String(timestamp),
        [POLL_AUTH_HEADERS.signature]: bs58.encode(signature),
      };
    },
  };
}
