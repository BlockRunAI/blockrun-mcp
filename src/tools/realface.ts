// src/tools/realface.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { amountToUsd, assertQuoteNearEstimate, recordActualSpend, reserveBudget } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import { formatError, isPaymentRejectionError } from "../utils/errors.js";
import { fetchWithTimeout } from "../utils/http.js";
import { sendPaid, settleGiveUp, trackPaidRequest, type PaidRequest } from "../utils/in-flight.js";
import { parseCostHeader } from "../utils/api-key-call.js";
import type { BudgetState } from "../types.js";
import { getApiBase, getChain, getOrCreateWalletKey, resolveSolanaKey } from "../utils/wallet.js";
import { PORTAL_CREDITS_URL, apiAuthHeaders, isApiKeyMode, requireWalletMode } from "../utils/auth.js";
import { generateUrlQrPng, openQrInViewer } from "../utils/qr.js";
import { launchTopUp } from "../utils/onramp.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";

// Promotional flat fee charged by the gateway for finalizing an enrollment.
// Source: blockrun/src/app/api/v1/realface/enroll/route.ts (ENROLLMENT_PRICE_USD).
// withTxFee: missed by the sweep. The gateway charges base + $0.002, so a $0.01
// enrolment settles $0.012 — reserving the base was 20% short.
const ENROLLMENT_PRICE_USD = withTxFee(0.01);

// Paid POST across all three rails. `path` is ROOTED (e.g. "/v1/portrait/enroll")
// because each rail mounts /v1 under a different base.
//
// Returns the raw status rather than throwing on it: both callers need to tell
// 402 (payment), 422 (image rejected, NOT charged) and 2xx apart, and collapsing
// those into an exception loses the distinction that decides whether a refund
// message is warranted.
async function payAndPostJson(
  path: string,
  reqBody: string,
  fallbackDescription: string,
  /**
   * The caller's per-call tracker for "a request carrying a payment is
   * outstanding". Armed here on every rail the moment the paid request is
   * about to go out, settled the moment a response arrives; the handler's
   * catch reads it to book a give-up. Handed in rather than kept here because
   * the MCP SDK dispatches calls concurrently and this function is shared: a
   * module-level flag (0.50.0) made one call's outstanding payment book a
   * phantom charge against another call's unrelated failure (audit round 3).
   */
  paid: PaidRequest,
  /**
   * Called with the authoritative quote BEFORE anything is signed, on whichever
   * rail is active. Throwing aborts unpaid. realface was the one manual-402
   * tool with no such hook: it read the 402 amount and signed it five lines
   * later, so a gateway quoting a different product (as sol.blockrun.ai did for
   * azure/sora-2 on 2026-09-08) was paid without a word.
   */
  onQuote?: (quotedUsd: number | null, quotedFor?: string) => void,
): Promise<{ status: number; data: Record<string, any>; settledUsd: number | null }> {
  // ---- Rail 1: account API key. ----
  if (isApiKeyMode()) {
    // No 402 on this rail: one POST, billed by the account. There is no quote
    // to sanity-check, which is why onQuote is not called here. The Bearer is
    // the payment, so the POST is armed like a signed one.
    const resp = await sendPaid(paid, () => fetchWithTimeout(`${getApiBase()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
      body: reqBody,
    }, 90_000));
    const data = await resp.json().catch(() => ({})) as Record<string, any>;
    // The account API reports what it settled in x-blockrun-cost-usd (since
    // 2026-09-05 — see utils/api-key-call.ts). Absent reads as null, and the
    // callers then fall back to ENROLLMENT_PRICE_USD; that estimate carries
    // the $0.002 tx fee this rail does not charge, so booking it for a
    // settled $0.010 over-counted every enrolment by 20%.
    return { status: resp.status, data, settledUsd: parseCostHeader(resp.headers.get("x-blockrun-cost-usd")) };
  }

  // ---- Rail 2: Solana wallet. sol.blockrun.ai serves both enroll routes
  // (probed 2026-09-05: 400 on a missing `name`, i.e. the route is live). ----
  if (getChain() === "solana") {
    const { solanaPaidPost } = await import("../utils/solana-402.js");
    try {
      // The quote, captured for the tracker: armed at the helper's
      // onPaidRequest (the line before the signed POST leaves) and settled at
      // onPaidResponse (any status), so a refused quote (thrown from onQuote,
      // nothing signed) never books and an answered 5xx is never a maybe.
      let solQuotedUsd: number | null = null;
      const r = await solanaPaidPost(path, JSON.parse(reqBody) as Record<string, unknown>, 90_000, {
        onPaidRequest: () => paid.arm(solQuotedUsd),
        onPaidResponse: () => paid.settle(),
        onQuote: (quotedUsd, quoteDetails) => {
          onQuote?.(quotedUsd, quoteDetails?.resource?.description);
          solQuotedUsd = quotedUsd;
        },
      });
      return { status: 200, data: r.data as Record<string, any>, settledUsd: r.paidUsd };
    } catch (err) {
      // solanaPaidPost throws on a non-2xx answer to the PAID request with the
      // status on the error (`statusCode`, the SDK's shape): a 422 still reads
      // as "rejected, not charged" and a 402 as the wallet's refusal. Read
      // the property, never the prose — the regex this replaces turned any
      // quote fault whose text mentioned "402" (an unreadable amount, a
      // missing feePayer) into "out of funds" plus a top-up page, for a call
      // where nothing had been signed (audit round 4).
      const status = (err as { statusCode?: unknown } | undefined)?.statusCode;
      if (typeof status === "number") {
        const msg = err instanceof Error ? err.message : String(err);
        return { status, data: { error: msg }, settledUsd: null };
      }
      throw err;
    }
  }

  // ---- Rail 3: Base wallet. Probe for the 402 challenge, sign, resubmit. ----
  const url = `${getApiBase()}${path}`;
  const privateKey = getOrCreateWalletKey();
  const account = privateKeyToAccount(privateKey);

  const resp402 = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: reqBody,
  }, 15_000);

  if (resp402.status !== 402) {
    const data = await resp402.json().catch(() => ({})) as Record<string, any>;
    throw new Error(`Unexpected status ${resp402.status} (the endpoint did not return a quote): ${data.message || data.error || JSON.stringify(data)}`);
  }

  const prHeader = resp402.headers.get("payment-required") || resp402.headers.get("PAYMENT-REQUIRED");
  if (!prHeader) throw new Error("No PAYMENT-REQUIRED header in 402 response");

  const paymentRequired = parsePaymentRequired(prHeader);
  const details = extractPaymentDetails(paymentRequired);

  onQuote?.(amountToUsd(details.amount), details.resource?.description);
  const paymentPayload = await createPaymentPayload(
    privateKey,
    account.address,
    details.recipient,
    details.amount,
    details.network || "eip155:8453",
    {
      resourceUrl: details.resource?.url || url,
      resourceDescription: details.resource?.description || fallbackDescription,
      maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, 120),
      extra: details.extra,
    }
  );

  // Armed for exactly this fetch — the signature is on it — and settled by a
  // response of any status before the status is read.
  const resp = await sendPaid(paid, () => fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": paymentPayload,
    },
    body: reqBody,
  }, 90_000), amountToUsd(details.amount));

  const data = await resp.json().catch(() => ({})) as Record<string, any>;
  return { status: resp.status, data, settledUsd: amountToUsd(details.amount) };
}

export function registerRealfaceTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_realface",
    {
      description: `Enroll a real person's face as a BytePlus RealFace asset, then drive Seedance 2.0 video with it (blockrun_video real_face_asset_id).

A RealFace asset (ta_xxxx) lets Seedance 2.0 / 2.0-fast / 2.0-mini generate video of a SPECIFIC real person — not a generic seed image. Only those three models: seedance-2.5 is numerically newer but does NOT accept ta_ assets, and seedance-1.5-pro never did. Enrollment is a multi-step flow because BytePlus requires a live phone liveness check (the real person nods + blinks on camera) before a face photo can be uploaded.

Actions:
- init: FREE. Create an asset group + a phone H5 link. The tool renders the link as a QR code and opens it; the real person scans it on their phone and completes the ~1 min liveness check. Pass group_id to refresh an expired link.
- status: FREE. Poll a group until status:"active" (ready_to_finalize:true). The H5 link is valid ~120s — re-init if it expires.
- enroll: PAID ($0.01). Settles on Solana or Base from a wallet, or against your BlockRun account key. After the group is active, upload a clear front-facing photo (image_url) of the SAME person. Returns the ta_xxxx asset id.
- portrait: PAID ($0.01). Settles on Solana or Base from a wallet, or against your BlockRun account key. Virtual Portrait — enroll an AI-GENERATED character from an image URL directly, NO liveness needed (one step: name + image_url → ta_xxxx). For fictional/AI characters only; for a real person use the init→status→enroll liveness flow.
- list: FREE, WALLET MODE ONLY (assets are indexed by wallet address). List the RealFace + Virtual Portrait assets enrolled by this wallet (their ta_xxxx ids + names) so you can pick one for blockrun_video.

Typical flow:
  1. blockrun_realface action:"init" name:"Alice"          → scan QR on phone, do liveness
  2. blockrun_realface action:"status" group_id:"legacy_rf_…"  → repeat until ready_to_finalize:true
  3. blockrun_realface action:"enroll" name:"Alice" group_id:"legacy_rf_…" image_url:"https://…/alice.jpg"  → ta_xxxx
  4. blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"ta_xxxx" prompt:"…"

Privacy: BlockRun does not store face/liveness data — only the asset id, name, and the photo URL you supply.`,
      annotations: TOOL_ANNOTATIONS.generative,
      inputSchema: {
        action: z.enum(["init", "status", "enroll", "portrait", "list"]).describe("What to do"),
        name: z.string().min(1).max(64).optional().describe("Display name for the person/character (required for init, enroll, and portrait)."),
        group_id: z.string().regex(/^legacy_rf_\d+$/).optional().describe("Asset-group id from init (required for status and enroll; pass to init to refresh an expired H5 link). Not used by portrait."),
        image_url: z.string().url().optional().describe("Public HTTPS URL to a clear front-facing face image (JPG/PNG/WEBP, ≤10MB). Required for enroll and portrait."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement (enroll only)."),
      },
    },
    async ({ action, name, group_id, image_url, agent_id }) => {
      // Reserve the estimate up front so concurrent calls can't each pass a
      // stale budget; release in finally once the call settles or fails.
      let gate: ReturnType<typeof reserveBudget> | undefined;
      // THIS call's outstanding-payment state, read by the catch below. Per
      // call on purpose — see payAndPostJson.
      const paid = trackPaidRequest();
      // The amount booked once settlement was OBSERVED. Read by the catch: a
      // settled 2xx whose body carried no asset id is a real charge with an
      // unusable result, and the message must say so and point at
      // action:"list" — not "failed", which invites a second paid enrolment
      // (round 4b: the D13 step the other media tools have).
      let bookedUsd: number | null = null;
      const book = (settledUsd: number | null) => {
        recordActualSpend(budget, settledUsd, ENROLLMENT_PRICE_USD, agent_id);
        bookedUsd = settledUsd ?? ENROLLMENT_PRICE_USD;
      };
      try {
        // ---- init (free) ----
        if (action === "init") {
          if (!name) {
            return { content: [{ type: "text", text: formatError("name is required for action:\"init\".") }], isError: true };
          }
          const body: Record<string, unknown> = { name };
          if (group_id) body.groupId = group_id;

          const resp = await fetchWithTimeout(`${getApiBase()}/v1/realface/init`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
            body: JSON.stringify(body),
          }, 30_000);

          const data = await resp.json().catch(() => ({})) as Record<string, any>;
          if (resp.status === 429) {
            return { content: [{ type: "text", text: formatError(`Rate limited — retry in ${data.retryAfterSeconds ?? "a few"}s.`) }], isError: true };
          }
          if (!resp.ok) {
            return { content: [{ type: "text", text: formatError(`init failed (${resp.status}): ${data.error || JSON.stringify(data)}`) }], isError: true };
          }

          const h5Link: string | undefined = data.h5_link;
          let qrNote = "";
          if (h5Link) {
            try {
              const qrPath = await generateUrlQrPng(h5Link, "realface-h5-qr.png");
              await openQrInViewer(qrPath);
              qrNote = `\nQR opened for scanning (${qrPath}).`;
            } catch {
              qrNote = "\n(QR generation failed — open the link below on the phone directly.)";
            }
          }

          const lines = [
            `🪪 RealFace enrollment started${data.refreshed ? " (link refreshed)" : ""}.`,
            `Group ID: ${data.group_id}`,
            `Status: ${data.status}`,
            h5Link ? `Phone link: ${h5Link}` : "",
            data.expires_in_seconds ? `Link expires in: ${data.expires_in_seconds}s` : "",
            qrNote.trim(),
            ``,
            `Next: the real person scans the QR / opens the link on their phone and completes the liveness check (nod + blink, ~1 min). Then poll: blockrun_realface action:"status" group_id:"${data.group_id}".`,
          ].filter(Boolean);

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              group_id: data.group_id,
              status: data.status,
              h5_link: h5Link,
              expires_in_seconds: data.expires_in_seconds,
              refreshed: !!data.refreshed,
            },
          };
        }

        // ---- status (free) ----
        if (action === "status") {
          if (!group_id) {
            return { content: [{ type: "text", text: formatError("group_id is required for action:\"status\".") }], isError: true };
          }
          const resp = await fetchWithTimeout(`${getApiBase()}/v1/realface/status?groupId=${encodeURIComponent(group_id)}`, {
            method: "GET",
          }, 30_000);
          const data = await resp.json().catch(() => ({})) as Record<string, any>;
          if (resp.status === 429) {
            return { content: [{ type: "text", text: formatError(`Rate limited — retry in ${data.retryAfterSeconds ?? "a few"}s.`) }], isError: true };
          }
          if (!resp.ok) {
            return { content: [{ type: "text", text: formatError(`status failed (${resp.status}): ${data.error || JSON.stringify(data)}`) }], isError: true };
          }

          const ready = !!data.ready_to_finalize;
          const lines = [
            `RealFace group ${data.group_id}`,
            `Status: ${data.status}`,
            `Assets in group: ${data.asset_count ?? 0}`,
            ready
              ? `✅ Ready to finalize — call blockrun_realface action:"enroll" group_id:"${data.group_id}" name:"…" image_url:"https://…".`
              : `⏳ Not active yet. The real person must finish the phone liveness check. Re-poll, or re-init if the link expired.`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              group_id: data.group_id,
              status: data.status,
              asset_count: data.asset_count,
              ready_to_finalize: ready,
            },
          };
        }

        // ---- list (free) ----
        if (action === "list") {
          // Wallet-only by construction: the gateway indexes enrolled assets by
          // the WALLET ADDRESS that paid for them (/v1/wallet/{address}/…), and
          // an account key has no address to look up. Guarding here also stops
          // getOrCreateWalletKey() below from minting one to ask with.
          const listBlock = requireWalletMode('blockrun_realface action:"list"');
          if (listBlock) return { content: [{ type: "text", text: listBlock }], isError: true };
          // The ACTIVE chain's payer address against the ACTIVE chain's
          // gateway. Assets are stored under whichever wallet paid the
          // enrolment, and sol.blockrun.ai's /v1/wallet/{address} routes
          // accept base58 only (probed 2026-09-13: an 0x address is a 400,
          // "expected Solana base58"). 0.46.0 pointed this URL at getApiBase()
          // and left the address EVM, so on the default chain every list
          // failed — and minted an EVM keypair on a Solana-only install just
          // to ask (audit round 3). On Solana the key is READ, never minted:
          // a free listing must not provision a wallet.
          const chain = getChain();
          let address: string;
          if (chain === "solana") {
            const solanaKey = resolveSolanaKey();
            if (!solanaKey) {
              // Dynamic so the handler suites that mock utils/wallet.js by
              // name (and predate this branch) keep linking; the same reason
              // the Solana helper below is imported lazily.
              const { solanaKeyUnavailableReason } = await import("../utils/wallet.js");
              const why = solanaKeyUnavailableReason?.();
              return {
                content: [{ type: "text", text: formatError(why
                  ? `Cannot list RealFace assets: ${why}. Unlock the keychain and retry.`
                  : `No Solana wallet yet, so there is nothing enrolled to list. Run blockrun_wallet action:"setup" to provision one, or switch to Base (blockrun_wallet action:"chain" chain:"base") to list assets paid from the Base wallet.`) }],
                isError: true,
              };
            }
            const { solanaPublicKey } = await import("@blockrun/llm");
            address = await solanaPublicKey(solanaKey);
          } else {
            address = privateKeyToAccount(getOrCreateWalletKey()).address;
          }
          const account = { address };
          const chainLabel = chain === "solana" ? "Solana" : "Base";
          const [rfResp, vpResp] = await Promise.all([
            fetchWithTimeout(`${getApiBase()}/v1/wallet/${account.address}/realfaces`, { method: "GET" }, 30_000),
            fetchWithTimeout(`${getApiBase()}/v1/wallet/${account.address}/portraits`, { method: "GET" }, 30_000)
              .catch(() => null),
          ]);
          const data = await rfResp.json().catch(() => ({})) as Record<string, any>;
          if (!rfResp.ok) {
            return { content: [{ type: "text", text: formatError(`list failed (${rfResp.status}): ${data.error || JSON.stringify(data)}`) }], isError: true };
          }
          const faces: Array<Record<string, any>> = Array.isArray(data.realfaces) ? data.realfaces : [];
          // Virtual Portraits are best-effort: a transient failure on this
          // endpoint shouldn't break the RealFace listing.
          let portraits: Array<Record<string, any>> = [];
          // Track whether the portrait lookup actually SUCCEEDED. Without this,
          // a transient failure collapsed to portraits=[] and then rendered as
          // "No ... assets enrolled" — a positive claim the code never verified,
          // which prompts a duplicate $0.01 enroll of something already enrolled.
          // The RealFace half above already surfaces its own failure; this half
          // silently did not.
          const portraitsUnavailable = !vpResp?.ok;
          if (vpResp?.ok) {
            const vpData = await vpResp.json().catch(() => ({})) as Record<string, any>;
            portraits = Array.isArray(vpData.portraits) ? vpData.portraits : [];
          }
          if (faces.length === 0 && portraits.length === 0) {
            const caveat = portraitsUnavailable
              ? `\n⚠️ The Virtual Portrait lookup failed, so this covers RealFace only — do NOT re-enroll a portrait on the strength of this listing; retry first.`
              : "";
            return {
              content: [{ type: "text", text: `No RealFace${portraitsUnavailable ? "" : " or Virtual Portrait"} assets enrolled for ${account.address} (${chainLabel} wallet — assets are per paying wallet and per chain).${caveat}\nEnroll one: blockrun_realface action:"init" name:"…" (real person) or action:"portrait" name:"…" image_url:"https://…" (AI character).` }],
              structuredContent: { wallet: account.address, chain, realfaces: [], portraits: [], count: 0, portraitsUnavailable },
            };
          }
          const first = faces[0] ?? portraits[0];
          const lines = [
            `Assets for ${account.address} on ${chainLabel} (${faces.length} RealFace, ${portraits.length} Virtual Portrait; assets are per paying wallet and per chain):`,
            ...faces.map((f) => `  • ${f.assetId}  —  "${f.name}" [realface]${f.createdAt ? `  (${f.createdAt})` : ""}`),
            ...portraits.map((p) => `  • ${p.assetId}  —  "${p.name}" [portrait]${p.createdAt ? `  (${p.createdAt})` : ""}`),
            ``,
            `Use one: blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"${first.assetId}" prompt:"…".`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: { wallet: account.address, chain, realfaces: faces, portraits, count: faces.length + portraits.length },
          };
        }

        // ---- portrait (paid, Base only — Virtual Portrait, no liveness) ----
        if (action === "portrait") {
          // No chain guard: sol.blockrun.ai serves /v1/portrait/enroll (probed
          // 2026-09-05 — 400 on a missing `name`, so the route is live), and
          // payAndPostJson pays on whichever rail is active.
          if (!name || !image_url) {
            return { content: [{ type: "text", text: formatError("portrait requires name and image_url (public HTTPS URL of an AI-generated character image).") }], isError: true };
          }

          gate = reserveBudget(budget, agent_id, ENROLLMENT_PRICE_USD);
          if (!gate.allowed) {
            return { content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
          }
          // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
          // decline returns here — nothing is sent, and the finally releases the
          // reservation. No-ops when off, sub-threshold, or unsupported by the client.
          const confirm = await confirmSpend(server, { usd: ENROLLMENT_PRICE_USD, label: `realface · ${action}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };

          const { status, data, settledUsd } = await payAndPostJson(
            "/v1/portrait/enroll",
            JSON.stringify({ name, image_url }),
            "BlockRun Virtual Portrait enrollment",
            paid,
            (quotedUsd, quotedFor) => {
              // Same rule as video, music, image and speech: refuse a quote far
              // above the published rate before signing, then re-check the cap
              // at the REAL price.
              assertQuoteNearEstimate(quotedUsd, ENROLLMENT_PRICE_USD, {
                what: "portrait enrollment",
                quotedFor,
                hint: `Report the quote — the published rate is $${ENROLLMENT_PRICE_USD.toFixed(4)}.`,
              });
              if (quotedUsd === null || quotedUsd <= ENROLLMENT_PRICE_USD) return;
              gate?.release();
              gate = reserveBudget(budget, agent_id, quotedUsd);
              if (!gate.allowed) throw new Error(`${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget. No charge was made.`);
            },
          );

          if (status === 402) {
            throw new Error("Payment rejected. Check your wallet balance.");
          }
          if (status === 422) {
            return { content: [{ type: "text", text: formatError(`Portrait rejected — ${data.hint || data.message || "use a clear front-facing character image"}. No payment taken.`) }], isError: true };
          }
          if (status < 200 || status >= 300) {
            // Status on the error, as the realface branch below (round 4b).
            throw Object.assign(new Error(`Portrait enroll error ${status}: ${data.error || JSON.stringify(data)}`), { statusCode: status });
          }

          // The gateway answers 2xx only AFTER settling, so the charge is real
          // whatever the body looks like. Book it before validating the payload:
          // a truncated or asset-less body used to throw first, the catch
          // formatted a failure, and finally released the reservation — a real
          // charge the ledger never saw (same ordering video.ts and speech.ts fixed).
          book(settledUsd);

          const assetId: string | undefined = data.asset_id;
          if (!assetId) throw new Error(`Portrait response missing asset_id: ${JSON.stringify(data)}`);

          const txHash = data.settlement?.tx_hash || undefined;
          const lines = [
            `✅ Virtual Portrait enrolled!`,
            `Asset ID: ${assetId}`,
            `Name: ${data.name || name}`,
            `Cost: $${(settledUsd ?? ENROLLMENT_PRICE_USD).toFixed(4)} USDC`,
            ...(txHash ? [`Tx: ${txHash}`] : []),
            ``,
            `Use it: blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"${assetId}" prompt:"…".`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              asset_id: assetId,
              group_id: data.group_id,
              name: data.name || name,
              image_url: data.image_url,
              price_usd: settledUsd ?? ENROLLMENT_PRICE_USD,
              ...(txHash ? { txHash } : {}),
            },
          };
        }

        // ---- enroll (paid) ----
        if (action === "enroll") {
          // No chain guard: sol.blockrun.ai serves /v1/realface/enroll (probed
          // 2026-09-05 — 400 on a missing `name`), and payAndPostJson pays on
          // whichever rail is active.
          if (!name || !image_url || !group_id) {
            return { content: [{ type: "text", text: formatError("enroll requires name, image_url, and group_id (from init, after the group is active).") }], isError: true };
          }

          gate = reserveBudget(budget, agent_id, ENROLLMENT_PRICE_USD);
          if (!gate.allowed) {
            return { content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
          }
          // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
          // decline returns here — nothing is sent, and the finally releases the
          // reservation. No-ops when off, sub-threshold, or unsupported by the client.
          const confirm = await confirmSpend(server, { usd: ENROLLMENT_PRICE_USD, label: `realface · ${action}` });
          if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };

          // Same x402 probe/sign/resubmit flow as the portrait action — shared
          // via payAndPostJson. The server uploads the photo, waits for the
          // BytePlus face-match, and only settles once the asset is active.
          const { status, data, settledUsd } = await payAndPostJson(
            "/v1/realface/enroll",
            JSON.stringify({ name, image_url, group_id }),
            "BlockRun RealFace enrollment",
            paid,
            (quotedUsd, quotedFor) => {
              // Same rule as video, music, image and speech: refuse a quote far
              // above the published rate before signing, then re-check the cap
              // at the REAL price.
              assertQuoteNearEstimate(quotedUsd, ENROLLMENT_PRICE_USD, {
                what: "RealFace enrollment",
                quotedFor,
                hint: `Report the quote — the published rate is $${ENROLLMENT_PRICE_USD.toFixed(4)}.`,
              });
              if (quotedUsd === null || quotedUsd <= ENROLLMENT_PRICE_USD) return;
              gate?.release();
              gate = reserveBudget(budget, agent_id, quotedUsd);
              if (!gate.allowed) throw new Error(`${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget. No charge was made.`);
            },
          );

          if (status === 402) {
            throw new Error("Payment rejected. Check your wallet balance.");
          }
          if (status === 425) {
            return { content: [{ type: "text", text: formatError(`Group not active yet — ${data.message || "finish the phone liveness check first"}. No payment taken.`) }], isError: true };
          }
          if (status === 422) {
            return { content: [{ type: "text", text: formatError(`Face match failed — ${data.hint || "use a clearer front-facing photo of the same person"}. No payment taken.`) }], isError: true };
          }
          if (status < 200 || status >= 300) {
            // With the status on it, so the catch can tell an edge 504 (the
            // origin may still be enrolling and settling — a maybe) from the
            // gateway's own refusal (round 4b).
            throw Object.assign(new Error(`Enroll error ${status}: ${data.error || JSON.stringify(data)}`), { statusCode: status });
          }

          // Book before validating the payload — see the portrait action above:
          // a settled 2xx with a malformed body must not un-record the charge.
          book(settledUsd);

          const assetId: string | undefined = data.asset_id;
          if (!assetId) throw new Error(`Enroll response missing asset_id: ${JSON.stringify(data)}`);

          const txHash = data.settlement?.tx_hash || undefined;
          const lines = [
            `✅ RealFace enrolled!`,
            `Asset ID: ${assetId}`,
            `Name: ${data.name || name}`,
            `Cost: $${(settledUsd ?? ENROLLMENT_PRICE_USD).toFixed(4)} USDC`,
            ...(txHash ? [`Tx: ${txHash}`] : []),
            ``,
            `Use it: blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"${assetId}" prompt:"…".`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              asset_id: assetId,
              group_id: data.group_id || group_id,
              name: data.name || name,
              price_usd: settledUsd ?? ENROLLMENT_PRICE_USD,
              ...(txHash ? { txHash } : {}),
            },
          };
        }

        return { content: [{ type: "text", text: formatError(`Unknown action: ${action}`) }], isError: true };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // 1. Settlement was observed and booked, then the body could not be
        //    used. First, before any word-based branch can misread it.
        const booked = bookedUsd as number | null;
        if (booked !== null) {
          const where = isApiKeyMode() ? "https://user.blockrun.ai/dashboard/activity" : `blockrun_wallet action:"report"`;
          return {
            content: [{ type: "text", text: `RealFace ${action} settled and the charge stands — $${booked.toFixed(4)} is booked against your budget — but the response could not be used: ${errMsg}\nRun blockrun_realface action:"list" to find the asset before enrolling again; check ${where} first.` }],
            isError: true,
          };
        }
        if (isPaymentRejectionError(errMsg)) {
          return {
            content: [{ type: "text", text: isApiKeyMode()
              ? `RealFace enrollment was refused for lack of credit on your BlockRun account — top it up at ${PORTAL_CREDITS_URL}.\nError: ${errMsg}`
              : `RealFace enrollment needs USDC — your wallet is out of funds. ${(await launchTopUp()).note}\nError: ${errMsg}` }],
            isError: true,
          };
        }
        // The request carrying the payment never answered. The gateway
        // settles on its own clock, so this is not "no charge" — book it
        // conservatively (the quote where one was seen, else the reserve) and
        // say what is and is not known. Same trade-off video and music make:
        // over-counting a request that settled nothing is recoverable,
        // under-counting a real charge is not. `paid` is this call's own
        // tracker, so another call's outstanding payment cannot land here.
        const giveUp = settleGiveUp(paid, err, { budget, agentId: agent_id, estimateUsd: ENROLLMENT_PRICE_USD, what: `RealFace ${action}` });
        if (giveUp) return { content: [{ type: "text", text: giveUp.text }], isError: true };
        return { content: [{ type: "text", text: formatError(`RealFace ${action} failed: ${errMsg}`) }], isError: true };
      } finally {
        gate?.release();
      }
    }
  );
}
