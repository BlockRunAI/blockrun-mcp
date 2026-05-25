// src/tools/realface.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBudget, recordSpending } from "../utils/budget.js";
import { formatError } from "../utils/errors.js";
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

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
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
- list: FREE. List the RealFace assets enrolled by this wallet (their ta_xxxx ids + names) so you can pick one for blockrun_video.

Typical flow:
  1. blockrun_realface action:"init" name:"Alice"          → scan QR on phone, do liveness
  2. blockrun_realface action:"status" group_id:"legacy_rf_…"  → repeat until ready_to_finalize:true
  3. blockrun_realface action:"enroll" name:"Alice" group_id:"legacy_rf_…" image_url:"https://…/alice.jpg"  → ta_xxxx
  4. blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"ta_xxxx" prompt:"…"

Privacy: BlockRun does not store face/liveness data — only the asset id, name, and the photo URL you supply.`,
      inputSchema: {
        action: z.enum(["init", "status", "enroll", "list"]).describe("What to do"),
        name: z.string().min(1).max(64).optional().describe("Display name for the person (required for init and enroll)."),
        group_id: z.string().regex(/^legacy_rf_\d+$/).optional().describe("Asset-group id from init (required for status and enroll; pass to init to refresh an expired H5 link)."),
        image_url: z.string().url().optional().describe("Public HTTPS URL to a clear front-facing face photo (JPG/PNG/WEBP, ≤10MB). Required for enroll."),
        agent_id: z.string().optional().describe("Agent identifier for budget tracking and enforcement (enroll only)."),
      },
    },
    async ({ action, name, group_id, image_url, agent_id }) => {
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
          const resp = await fetchWithTimeout(`${BLOCKRUN_API}/v1/wallet/${account.address}/realfaces`, {
            method: "GET",
          }, 30_000);
          const data = await resp.json().catch(() => ({})) as Record<string, any>;
          if (!resp.ok) {
            return { content: [{ type: "text", text: formatError(`list failed (${resp.status}): ${data.error || JSON.stringify(data)}`) }], isError: true };
          }
          const faces: Array<Record<string, any>> = Array.isArray(data.realfaces) ? data.realfaces : [];
          if (faces.length === 0) {
            return {
              content: [{ type: "text", text: `No RealFace assets enrolled for ${account.address}.\nEnroll one: blockrun_realface action:"init" name:"…".` }],
              structuredContent: { wallet: account.address, realfaces: [], count: 0 },
            };
          }
          const lines = [
            `RealFace assets for ${account.address} (${faces.length}):`,
            ...faces.map((f) => `  • ${f.assetId}  —  "${f.name}"${f.createdAt ? `  (${f.createdAt})` : ""}`),
            ``,
            `Use one: blockrun_video model:"bytedance/seedance-2.0" real_face_asset_id:"${faces[0].assetId}" prompt:"…".`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: { wallet: account.address, realfaces: faces, count: faces.length },
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

          const budgetCheck = checkBudget(budget, agent_id, ENROLLMENT_PRICE_USD);
          if (!budgetCheck.allowed) {
            return { content: [{ type: "text", text: `${budgetCheck.reason}. Use blockrun_wallet action:"report" to see usage or action:"delegate" to increase agent budget.` }], isError: true };
          }

          const privateKey = getOrCreateWalletKey();
          const account = privateKeyToAccount(privateKey);
          const enrollUrl = `${BLOCKRUN_API}/v1/realface/enroll`;
          const reqBody = JSON.stringify({ name, image_url, group_id });

          // Step 1: get 402 with price + requirements
          const resp402 = await fetchWithTimeout(enrollUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: reqBody,
          }, 15_000);

          if (resp402.status !== 402) {
            const data = await resp402.json().catch(() => ({})) as Record<string, any>;
            // Surface group-not-active (425) and validation (400) clearly.
            throw new Error(`Expected 402, got ${resp402.status}: ${data.message || data.error || JSON.stringify(data)}`);
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
              resourceUrl: details.resource?.url || enrollUrl,
              resourceDescription: details.resource?.description || "BlockRun RealFace enrollment",
              maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, 120),
              extra: details.extra,
            }
          );

          // Step 2: submit with payment. Server uploads the photo, waits for the
          // BytePlus face-match, and only settles once the asset is active.
          const resp = await fetchWithTimeout(enrollUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "PAYMENT-SIGNATURE": paymentPayload,
            },
            body: reqBody,
          }, 90_000);

          const data = await resp.json().catch(() => ({})) as Record<string, any>;

          if (resp.status === 402) {
            throw new Error("Payment rejected. Check your wallet balance.");
          }
          if (resp.status === 425) {
            return { content: [{ type: "text", text: formatError(`Group not active yet — ${data.message || "finish the phone liveness check first"}. No payment taken.`) }], isError: true };
          }
          if (resp.status === 422) {
            return { content: [{ type: "text", text: formatError(`Face match failed — ${data.hint || "use a clearer front-facing photo of the same person"}. No payment taken.`) }], isError: true };
          }
          if (!resp.ok) {
            throw new Error(`Enroll error ${resp.status}: ${data.error || JSON.stringify(data)}`);
          }

          const assetId: string | undefined = data.asset_id;
          if (!assetId) throw new Error(`Enroll response missing asset_id: ${JSON.stringify(data)}`);

          recordSpending(budget, ENROLLMENT_PRICE_USD, agent_id);

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
        if (errMsg.includes("balance") || errMsg.includes("payment") || errMsg.includes("402") || errMsg.includes("rejected")) {
          return {
            content: [{ type: "text", text: `RealFace enrollment requires payment. Run blockrun_wallet with action: "setup" for funding instructions.\nError: ${errMsg}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: formatError(`RealFace ${action} failed: ${errMsg}`) }], isError: true };
      }
    }
  );
}
