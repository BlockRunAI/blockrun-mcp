// src/utils/confirm-spend.ts
//
// Server-side spend confirmation via MCP elicitation. Before a paid call, the
// server asks the client to render a confirm dialog showing the estimated cost.
// The dialog carries an "approve all this session" checkbox — when ticked, the
// server skips every later prompt for the rest of the session (in-memory flag,
// scoped to this server process = this session). This is reliable across
// clients that support elicitation (e.g. Claude Code), unlike PreToolUse hooks.
//
// Off by default — opt in with BLOCKRUN_CONFIRM_SPEND=on (or 1/true/yes). This
// avoids double-prompting when a plugin already gates spend via a PreToolUse
// hook (the hook renders the cost and is honored on more clients), and keeps
// the bare MCP from surprising users with an extra dialog.
//
// Controls (env):
//   BLOCKRUN_CONFIRM_SPEND=on       enable elicitation-based spend confirmation
//   BLOCKRUN_CONFIRM_THRESHOLD=0.05 only confirm calls estimated above this USD
//
// Degradation: if the client doesn't advertise elicitation, we proceed without
// prompting (the tool's cost footer still tells the user what was charged) —
// better than failing the call on clients that can't ask.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Session-scoped "approve all" flag. The MCP server is one process per session,
// so a module-level flag is exactly session lifetime.
let sessionAutoApprove = false;

const CONFIRM_ON = /^(1|true|on|yes)$/i.test(process.env.BLOCKRUN_CONFIRM_SPEND ?? "");
const THRESHOLD = Number(process.env.BLOCKRUN_CONFIRM_THRESHOLD || 0);

export interface ConfirmResult {
  ok: boolean;
  reason?: string;
}

/**
 * Ask the user to confirm a charge. Returns { ok:true } to proceed, or
 * { ok:false, reason } when the user cancels (caller should abort without
 * charging). Free calls, an active session approval, the off switch, the
 * sub-threshold case, and clients without elicitation all return ok:true.
 */
export async function confirmSpend(
  server: McpServer,
  opts: { usd: number; label: string; balanceNote?: string },
): Promise<ConfirmResult> {
  const { usd, label, balanceNote } = opts;

  if (!CONFIRM_ON) return { ok: true };              // off by default (opt-in)
  if (usd <= 0) return { ok: true };                 // free
  if (sessionAutoApprove) return { ok: true };       // user already approved all
  if (usd <= THRESHOLD) return { ok: true };         // cheap enough to skip

  const caps = server.server.getClientCapabilities?.();
  if (!caps?.elicitation) return { ok: true };       // client can't be asked → proceed

  try {
    const result = await server.server.elicitInput({
      message:
        `💸 BlockRun charge — ${label}\n` +
        `Estimated: $${usd.toFixed(4)}${balanceNote ? ` · ${balanceNote}` : ""}\n` +
        `Approve this spend? (USDC is debited per call.)\n` +
        `To stop the charge, choose Decline — Cancel/ESC lets it proceed.`,
      requestedSchema: {
        type: "object",
        properties: {
          approve_all_session: {
            type: "boolean",
            title: "Approve all BlockRun charges for the rest of this session (don't ask again)",
            default: false,
          },
        },
      },
    });

    const content = result.content as { approve_all_session?: boolean } | undefined;
    if (content?.approve_all_session) sessionAutoApprove = true;

    // Only an EXPLICIT decline stops the charge. Some clients (e.g. the desktop
    // app) return action "cancel" even when the user confirms a form dialog, and
    // the client's own tool-permission prompt is already the real gate — so we
    // must not treat a non-"accept" action as a cancellation, or a confirmed
    // generation gets wrongly aborted ("you cancelled"). Honor "decline" only.
    if (result.action === "decline") {
      return { ok: false, reason: "Charge declined — nothing was generated or charged." };
    }
    return { ok: true };
  } catch {
    // Couldn't render the prompt (e.g. client advertises elicitation but not
    // the form mode). Fail open — proceed rather than block a legitimate call.
    // Only an explicit user decline (above) stops the charge.
    return { ok: true };
  }
}

/** Test/escape hatch: reset the session approval (not used in normal flow). */
export function resetSpendApproval(): void {
  sessionAutoApprove = false;
}
