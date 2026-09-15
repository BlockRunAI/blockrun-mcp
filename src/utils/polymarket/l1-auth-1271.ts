// src/utils/polymarket/l1-auth-1271.ts
//
// CLOB L1 authentication and API-credential derivation.
//
// READ THIS BEFORE DELETING ANYTHING HERE. The file is named for a hypothesis
// that turned out to be wrong, and the function every Polymarket action
// depends on now lives in it: deriveApiCreds(). Removing the module removes
// credential derivation, and all trading stops.
//
// The hypothesis was https://github.com/Polymarket/clob-client-v2/issues/65
// (open as of v1.0.8, 2026-07): the SDK's createApiKey()/createL1Headers()
// signs the L1 ClobAuth attestation as a PLAIN EOA signature bound to the EOA
// address, while POLY_1271 orders set order.signer = deposit wallet, and the
// CLOB rejects those orders with 400 "the order signer address has to be the
// address of the API KEY". The obvious reading was that L1 auth needed the
// same ERC-7739 wrap the SDK already applies to orders, and
// buildWrapped1271Headers() below implements exactly that.
//
// It is not the fix. The CLOB rejects the wrapped envelope outright with
// "Invalid L1 Request headers". L2 credentials are ALWAYS bound to the owner
// EOA even in POLY_1271 mode, matching the reference Rust client
// (rs-clob-client-v2 src/auth.rs): L1/L2 auth uses the owner's plain ECDSA
// signature, and only the ORDER carries signer/maker = deposit wallet, checked
// on-chain by that wallet's ERC-1271 isValidSignature. See the long note at
// the buildClobClient() call site in client.ts.
//
// So the live path is buildPlainL1Headers(), and both call sites
// (client.ts, relayer.ts) pass sigType 0. The wrapped path below is kept as a
// tested reference implementation of the ERC-7739 envelope for ClobAuth --
// it is correct about the envelope and wrong about what the server wants --
// and test/polymarket-l1-auth.test.ts pins its byte layout. Nothing calls it
// with sigType 3.
//
//   contentsHash = hashStruct(ClobAuth message)              (app = ClobAuthDomain v1)
//   innerSig     = eth_signTypedData(TypedDataSign{contents, DepositWallet domain})
//   envelope     = innerSig | appDomainSeparator | contentsHash
//                  | typeString(ClobAuth) | uint16(len(typeString))
//
// When bumping @polymarket/clob-client-v2, what to re-check is whether the SDK
// can now derive creds itself (client.createOrDeriveApiKey()) -- not whether
// issue #65 is closed, since its premise was already wrong.
import axios from "axios";
import {
  encodeAbiParameters,
  hashDomain,
  keccak256,
  toHex,
  zeroHash,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { CLOB_HOST, POLYGON_CHAIN_ID } from "./constants.js";

// Must match the SDK byte-for-byte (dist/signing/{constants,eip712}.js).
const MSG_TO_SIGN = "This message attests that I control the given wallet";
const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: POLYGON_CHAIN_ID,
} as const;
const CLOB_AUTH_FIELDS = [
  { name: "address", type: "address" },
  { name: "timestamp", type: "string" },
  { name: "nonce", type: "uint256" },
  { name: "message", type: "string" },
] as const;
const CLOB_AUTH_TYPE_STRING =
  "ClobAuth(address address,string timestamp,uint256 nonce,string message)";
const CLOB_AUTH_TYPE_HASH = keccak256(toHex(CLOB_AUTH_TYPE_STRING));

// TypedDataSign layout mirrors TYPED_DATA_SIGN_STRUCT in the SDK's
// exchangeOrderBuilderV2, with `contents` retyped to ClobAuth. The embedded
// domain fields describe the DEPOSIT WALLET (the ERC-1271 validator), which is
// what binds the signature to that one wallet and prevents cross-wallet replay.
const TYPED_DATA_SIGN_FIELDS = [
  { name: "contents", type: "ClobAuth" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;

export interface DerivedCreds {
  key: string;
  secret: string;
  passphrase: string;
}

interface L1Headers extends Record<string, string> {
  POLY_ADDRESS: string;
  POLY_SIGNATURE: string;
  POLY_TIMESTAMP: string;
  POLY_NONCE: string;
}

/** hashStruct(ClobAuth) — string fields keccak-hashed per EIP-712. */
function clobAuthContentsHash(address: Hex, timestamp: string, nonce: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        CLOB_AUTH_TYPE_HASH,
        address,
        keccak256(toHex(timestamp)),
        nonce,
        keccak256(toHex(MSG_TO_SIGN)),
      ],
    ),
  );
}

/**
 * Build 7739-wrapped L1 headers binding the attestation to `depositWallet`,
 * signed by the local EOA account. Exported for the golden-vector unit test.
 */
export async function buildWrapped1271Headers(
  account: PrivateKeyAccount,
  depositWallet: Hex,
  timestampSec?: number,
): Promise<L1Headers> {
  const ts = String(timestampSec ?? Math.floor(Date.now() / 1000));
  const nonce = 0n;

  const innerSig = await account.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    types: {
      TypedDataSign: [...TYPED_DATA_SIGN_FIELDS],
      ClobAuth: [...CLOB_AUTH_FIELDS],
    },
    primaryType: "TypedDataSign",
    message: {
      contents: {
        address: depositWallet,
        timestamp: ts,
        nonce,
        message: MSG_TO_SIGN,
      },
      name: "DepositWallet",
      version: "1",
      chainId: BigInt(POLYGON_CHAIN_ID),
      verifyingContract: depositWallet,
      salt: zeroHash,
    },
  });

  const appDomainSep = hashDomain({
    domain: { ...CLOB_AUTH_DOMAIN, chainId: BigInt(POLYGON_CHAIN_ID) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
    },
  });
  const contentsHash = clobAuthContentsHash(depositWallet, ts, nonce);
  const typeHex = toHex(CLOB_AUTH_TYPE_STRING).slice(2);
  const lenHex = (typeHex.length / 2).toString(16).padStart(4, "0");
  const envelope =
    `0x${innerSig.slice(2)}${appDomainSep.slice(2)}${contentsHash.slice(2)}${typeHex}${lenHex}`;

  return {
    POLY_ADDRESS: depositWallet,
    POLY_SIGNATURE: envelope,
    POLY_TIMESTAMP: ts,
    POLY_NONCE: "0",
  };
}

/** Plain (unwrapped) L1 headers for EOA mode — matches the SDK's own path. */
async function buildPlainL1Headers(account: PrivateKeyAccount): Promise<L1Headers> {
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await account.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    types: { ClobAuth: [...CLOB_AUTH_FIELDS] },
    primaryType: "ClobAuth",
    message: {
      address: account.address,
      timestamp: ts,
      nonce: 0n,
      message: MSG_TO_SIGN,
    },
  });
  return {
    POLY_ADDRESS: account.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: ts,
    POLY_NONCE: "0",
  };
}

/**
 * Create-or-derive CLOB L2 API creds. Mirrors the SDK's createOrDeriveApiKey
 * flow (POST /auth/api-key, falling back to GET /auth/derive-api-key when the
 * key already exists).
 *
 * Pass sigType 0. It binds the creds to the EOA, which is what the CLOB wants
 * in POLY_1271 mode too, and it is what both call sites pass. sigType 3 sends
 * the wrapped headers and the server answers "Invalid L1 Request headers" --
 * it is reachable only to keep the envelope implementation honest, not because
 * it is an option. The file header explains why.
 */
export async function deriveApiCreds(
  account: PrivateKeyAccount,
  opts: { sigType: 0 | 3; depositWallet?: Hex },
): Promise<DerivedCreds> {
  const headers =
    opts.sigType === 3
      ? await buildWrapped1271Headers(account, requireDepositWallet(opts.depositWallet))
      : await buildPlainL1Headers(account);

  // POST creates a key; if one already exists it 4xxs and we fall back to
  // deriving. Keep the POST failure reason (redacted) so that when the derive
  // ALSO fails — the common cause is the server rejecting the wrapped 1271
  // signature (e.g. deposit wallet not yet deployed) — we can surface it
  // instead of a misleading "not registered" message.
  let createError: string | undefined;
  const create = await axios
    .post(`${CLOB_HOST}/auth/api-key`, undefined, { headers, timeout: 15_000 })
    .then((r) => r.data as { apiKey?: string; secret?: string; passphrase?: string })
    .catch((e) => {
      createError = summarizeAxiosError(e);
      return null;
    });
  if (create?.apiKey && create.secret && create.passphrase) {
    return { key: create.apiKey, secret: create.secret, passphrase: create.passphrase };
  }

  const derive = await axios
    .get(`${CLOB_HOST}/auth/derive-api-key`, { headers, timeout: 15_000 })
    .catch((e) => {
      throw new Error(
        `CLOB credential derivation failed: ${summarizeAxiosError(e)}` +
        (createError ? ` (create attempt: ${createError})` : "") +
        `. If the deposit wallet is not yet deployed, run action:"setup" first.`,
      );
    });
  const d = derive.data as { apiKey?: string; secret?: string; passphrase?: string };
  if (!d?.apiKey || !d.secret || !d.passphrase) {
    // Never echo the raw body — a partial response could contain a live secret.
    // Report only which fields were present.
    const present = d && typeof d === "object" ? Object.keys(d).join(", ") || "none" : typeof d;
    throw new Error(
      `CLOB did not return complete API credentials (fields present: ${present}). ` +
      `If this persists, the account may not be registered — run action:"setup".`,
    );
  }
  return { key: d.apiKey, secret: d.secret, passphrase: d.passphrase };
}

/** Status + short error text from an axios failure, WITHOUT echoing any body
 *  (which for these auth endpoints can carry credential material). */
function summarizeAxiosError(e: unknown): string {
  const ax = e as { response?: { status?: number; data?: unknown }; message?: string };
  if (ax?.response?.status) {
    const body = ax.response.data;
    const reason = body && typeof body === "object"
      ? ((body as { error?: string; message?: string }).error ?? (body as { message?: string }).message ?? "")
      : typeof body === "string" ? body : "";
    return `HTTP ${ax.response.status}${reason ? ` (${String(reason).slice(0, 120)})` : ""}`;
  }
  return ax?.message ? ax.message.slice(0, 120) : "network error";
}

function requireDepositWallet(addr: Hex | undefined): Hex {
  if (!addr) throw new Error("deposit wallet address required for POLY_1271 credential derivation");
  return addr;
}
