// src/tools/realface.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { amountToUsd, reserveBudget, recordActualSpend } from "../utils/budget.js";
import { formatError, isPaymentRejectionError } from "../utils/errors.js";
import { fetchWithTimeout } from "../utils/http.js";
import type { BudgetState } from "../types.js";
import { getChain, getOrCreateWalletKey } from "../utils/wallet.js";
import { generateUrlQrPng, openQrInViewer } from "../utils/qr.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "@blockrun/llm";

const BLOCKRUN_API = "https://blockrun.ai/api";
// Promotional flat fee charged by the gateway for finalizing an enrollment.
// Source: blockrun/src/app/api/v1/realface/enroll/route.ts (ENROLLMENT_PRICE_USD).
const ENROLLMENT_PRICE_USD = 0.01;

// x402 pay-and-POST: probe for the 402 challenge, sign, resubmit with payment.
// Same flow the enroll action uses inline; shared by the portrait action.
async function payAndPostJson(
  url: string,
  reqBody: string,
  fallbackDescription: string,
): Promise<{ status: number; data: Record<string, any>; settledUsd: number | null }> {
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

  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": paymentPayload,
    },
    body: reqBody,
  }, 90_000);

  const data = await resp.json().catch(() => ({})) as Record<string, any>;
  return { status: resp.status, data, settledUsd: amountToUsd(details.amount) };
}

export function registerRealfaceTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_realface",
    {
      description: `Enroll a real person's face as a BytePlus RealFace asset, then drive Seedance 2.0 video with it (blockrun_video real_face_asset_id).

A RealFace asset (ta_xxxx) lets Seedance 2.0 / 2.0-fast generate video of a SPECIFIC real person — not a generic seed image. Enrollment is a multi-step flow because BytePlus requires a live phone liveness check (the real person nods + blinks on camera) before a face photo can be uploaded.

Actions:
- init: FREE. Create an asset group + a phone H5 link. The tool renders the link as a QR code and opens it; the real person scans it on their phone and completes the ~1 min liveness check. Pass group_id to refresh an expired link.
- status: FREE. Poll a group until status:"active" (ready_to_finalize:true). The H5 link is valid ~120s — re-init if it expires.
- enroll: PAID ($0.01 USDC, Base only). After the group is active, upload a clear front-facing photo (image_url) of the SAME person. Returns the ta_xxxx asset id.
- portrait: PAID ($0.01 USDC, Base only). Virtual Portrait — enroll an AI-GENERATED character from an image URL directly, NO liveness needed (one step: name + image_url → ta_xxxx). For fictional/AI characters only; for a real person use the init→status→enroll liveness flow.
- list: FREE. List the RealFace + Virtual Portrait assets enrolled by this wallet (their ta_xxxx ids + names) so you can pick one for blockrun_video.

Typical flow:
  1. blockrun_realface action:"init" name:"Alice"          → scan QR on phone, do liveness
  2. blockrun_realface action:"status" group_id:"legacy_rf_…"  → repeat until ready_to_finalize:true
  3. blockrun_realface action:"enroll" name:"Alice" group_id:"legacy_rf_…" image_url:"https://…/alice.jpg"  → ta_xxxx
  4. blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"ta_xxxx" prompt:"…"

Privacy: BlockRun does not store face/liveness data — only the asset id, name, and the photo URL you supply.`,
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
      try {
        // ---- init (free) ----
        if (action === "init") {
          if (!name) {
            return { content: [{ type: "text", text: formatError("name is required for action:\"init\".") }], isError: true };
          }
          const body: Record<string, unknown> = { name };
          if (group_id) body.groupId = group_id;

          const resp = await fetchWithTimeout(`${BLOCKRUN_API}/v1/realface/init`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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
          const resp = await fetchWithTimeout(`${BLOCKRUN_API}/v1/realface/status?groupId=${encodeURIComponent(group_id)}`, {
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
          const account = privateKeyToAccount(getOrCreateWalletKey());
          const [rfResp, vpResp] = await Promise.all([
            fetchWithTimeout(`${BLOCKRUN_API}/v1/wallet/${account.address}/realfaces`, { method: "GET" }, 30_000),
            fetchWithTimeout(`${BLOCKRUN_API}/v1/wallet/${account.address}/portraits`, { method: "GET" }, 30_000)
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
          if (vpResp?.ok) {
            const vpData = await vpResp.json().catch(() => ({})) as Record<string, any>;
            portraits = Array.isArray(vpData.portraits) ? vpData.portraits : [];
          }
          if (faces.length === 0 && portraits.length === 0) {
            return {
              content: [{ type: "text", text: `No RealFace or Virtual Portrait assets enrolled for ${account.address}.\nEnroll one: blockrun_realface action:"init" name:"…" (real person) or action:"portrait" name:"…" image_url:"https://…" (AI character).` }],
              structuredContent: { wallet: account.address, realfaces: [], portraits: [], count: 0 },
            };
          }
          const first = faces[0] ?? portraits[0];
          const lines = [
            `Assets for ${account.address} (${faces.length} RealFace, ${portraits.length} Virtual Portrait):`,
            ...faces.map((f) => `  • ${f.assetId}  —  "${f.name}" [realface]${f.createdAt ? `  (${f.createdAt})` : ""}`),
            ...portraits.map((p) => `  • ${p.assetId}  —  "${p.name}" [portrait]${p.createdAt ? `  (${p.createdAt})` : ""}`),
            ``,
            `Use one: blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"${first.assetId}" prompt:"…".`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: { wallet: account.address, realfaces: faces, portraits, count: faces.length + portraits.length },
          };
        }

        // ---- portrait (paid, Base only — Virtual Portrait, no liveness) ----
        if (action === "portrait") {
          if (getChain() !== "base") {
            return { content: [{ type: "text", text: formatError("blockrun_realface portrait settles on Base only. Switch BlockRun to Base (run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }], isError: true };
          }
          if (!name || !image_url) {
            return { content: [{ type: "text", text: formatError("portrait requires name and image_url (public HTTPS URL of an AI-generated character image).") }], isError: true };
          }

          gate = reserveBudget(budget, agent_id, ENROLLMENT_PRICE_USD);
          if (!gate.allowed) {
            return { content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
          }

          const { status, data, settledUsd } = await payAndPostJson(
            `${BLOCKRUN_API}/v1/portrait/enroll`,
            JSON.stringify({ name, image_url }),
            "BlockRun Virtual Portrait enrollment",
          );

          if (status === 402) {
            throw new Error("Payment rejected. Check your wallet balance.");
          }
          if (status === 422) {
            return { content: [{ type: "text", text: formatError(`Portrait rejected — ${data.hint || data.message || "use a clear front-facing character image"}. No payment taken.`) }], isError: true };
          }
          if (status < 200 || status >= 300) {
            throw new Error(`Portrait enroll error ${status}: ${data.error || JSON.stringify(data)}`);
          }

          const assetId: string | undefined = data.asset_id;
          if (!assetId) throw new Error(`Portrait response missing asset_id: ${JSON.stringify(data)}`);

          recordActualSpend(budget, settledUsd, ENROLLMENT_PRICE_USD, agent_id);

          const txHash = data.settlement?.tx_hash || undefined;
          const lines = [
            `✅ Virtual Portrait enrolled!`,
            `Asset ID: ${assetId}`,
            `Name: ${data.name || name}`,
            `Cost: $${ENROLLMENT_PRICE_USD.toFixed(2)} USDC`,
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
              price_usd: ENROLLMENT_PRICE_USD,
              ...(txHash ? { txHash } : {}),
            },
          };
        }

        // ---- enroll (paid, Base only) ----
        if (action === "enroll") {
          if (getChain() !== "base") {
            return { content: [{ type: "text", text: formatError("blockrun_realface enroll settles on Base only. Switch BlockRun to Base (run blockrun_wallet with action:chain chain:base) and fund the Base wallet with USDC.") }], isError: true };
          }
          if (!name || !image_url || !group_id) {
            return { content: [{ type: "text", text: formatError("enroll requires name, image_url, and group_id (from init, after the group is active).") }], isError: true };
          }

          gate = reserveBudget(budget, agent_id, ENROLLMENT_PRICE_USD);
          if (!gate.allowed) {
            return { content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
          }

          // Same x402 probe/sign/resubmit flow as the portrait action — shared
          // via payAndPostJson. The server uploads the photo, waits for the
          // BytePlus face-match, and only settles once the asset is active.
          const { status, data, settledUsd } = await payAndPostJson(
            `${BLOCKRUN_API}/v1/realface/enroll`,
            JSON.stringify({ name, image_url, group_id }),
            "BlockRun RealFace enrollment",
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
            throw new Error(`Enroll error ${status}: ${data.error || JSON.stringify(data)}`);
          }

          const assetId: string | undefined = data.asset_id;
          if (!assetId) throw new Error(`Enroll response missing asset_id: ${JSON.stringify(data)}`);

          recordActualSpend(budget, settledUsd, ENROLLMENT_PRICE_USD, agent_id);

          const txHash = data.settlement?.tx_hash || undefined;
          const lines = [
            `✅ RealFace enrolled!`,
            `Asset ID: ${assetId}`,
            `Name: ${data.name || name}`,
            `Cost: $${ENROLLMENT_PRICE_USD.toFixed(2)} USDC`,
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
              price_usd: ENROLLMENT_PRICE_USD,
              ...(txHash ? { txHash } : {}),
            },
          };
        }

        return { content: [{ type: "text", text: formatError(`Unknown action: ${action}`) }], isError: true };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isPaymentRejectionError(errMsg)) {
          return {
            content: [{ type: "text", text: `RealFace enrollment requires payment. Run blockrun_wallet with action: "setup" for funding instructions.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: formatError(`RealFace ${action} failed: ${errMsg}`) }], isError: true };
      } finally {
        gate?.release();
      }
    }
  );
}
