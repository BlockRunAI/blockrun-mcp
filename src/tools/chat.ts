// src/tools/chat.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { buildClient, buildClientWithTimeout, getAnthropicClient, baseOnlyMessage } from "../utils/wallet.js";
import { isApiKeyMode } from "../utils/auth.js";
import {
  completeChat,
  settlementOnThrow,
  AcceptedThenFailedError,
  type ChatOutcome,
  type ChatUsage,
  type StreamChatMessage,
} from "../utils/chat-stream.js";
import { handleAnthropicNative, isAnthropicModel } from "./chat-anthropic.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import {
  MODEL_TIERS,
  FREE_MODEL_TIMEOUT_MS,
  FREE_TIER_DEADLINE_MS,
  FREE_TIER_MAX_PROMPT_CHARS,
  CHAT_PRICE_PER_MTOKEN,
  DEFAULT_CHAT_PRICE,
  FREE_CHAT_MODELS,
  canonicalChatModel,
  TIER_WORST_PRICE,
  GATEWAY_CHARS_PER_TOKEN,
  GATEWAY_CHARS_PER_TOKEN_OBSERVED,
  type RoutingMode,
} from "../utils/constants.js";
import { reserveBudget, recordActualSpend } from "../utils/budget.js";
import { confirmSpend } from "../utils/confirm-spend.js";
import { withTxFee } from "../utils/tx-fee.js";
import type { ApiClient } from "../utils/wallet.js";
import type { BudgetState } from "../types.js";

/**
 * Character length of everything we are about to send as prompt. Used only to
 * decide whether the free path will silently drop part of it.
 *
 * CHARACTERS, not bytes. 0.32.2 measured this in bytes and was wrong — see
 * FREE_TIER_MAX_PROMPT_CHARS for the CJK measurements that disproved it.
 */
export function promptCharSize(
  message: string,
  system?: string,
  messages?: Array<{ content: unknown }>,
): number {
  let chars = message.length;
  if (system) chars += system.length;
  for (const m of messages ?? []) {
    chars += (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).length;
  }
  return chars;
}

/**
 * The free NVIDIA path truncates at 128 KiB and still answers 200 with a
 * confident, well-formed reply — see FREE_TIER_MAX_PROMPT_CHARS for the
 * measurements. Nothing in the response says the input was cut, so an agent
 * summarising a large document over mode:"free" would present an answer about
 * the first 128 KiB as an answer about the whole thing.
 *
 * Silent truncation is the worst failure shape available here: unlike an error,
 * it is indistinguishable from success. We cannot stop the gateway doing it, so
 * the tool says so out loud. Returns null when nothing was lost.
 */
export function freeTierTruncationNote(promptChars: number, model: string): string | null {
  // Canonicalised: the gateway serves `gpt-oss-120b` as well as
  // `nvidia/gpt-oss-120b`, and the bare spelling truncates identically — a
  // startsWith check on the raw string let the silent-truncation warning go
  // silent, which is the one failure this function exists to make loud.
  //
  // Still a VENDOR test, on purpose, unlike the $0 classifier (FREE_CHAT_MODELS):
  // the 128 KiB cap was measured on the NVIDIA free path and nowhere else. The
  // cohere/poolside free models are unmeasured, and a warning that says "a
  // third of your prompt was dropped" must not be extended to a path where it
  // may not have been — that would push agents off a working $0 path onto paid
  // USDC on a false premise, the exact harm the byte-vs-char fix removed.
  if (!canonicalChatModel(model).startsWith("nvidia/")) return null; // paid models scale past this
  if (promptChars <= FREE_TIER_MAX_PROMPT_CHARS) return null;
  const keptPct = Math.round((FREE_TIER_MAX_PROMPT_CHARS / promptChars) * 100);
  return (
    `\n\n⚠️ TRUNCATED: the prompt was ${promptChars.toLocaleString("en-US")} characters, but ` +
    `the free NVIDIA path silently caps input at ${FREE_TIER_MAX_PROMPT_CHARS.toLocaleString("en-US")}. ` +
    `Roughly ${100 - keptPct}% of it never reached the model, so the answer above covers only ` +
    `the first ~${keptPct}%. Paid models do not truncate — pass an explicit model (or a paid ` +
    `mode) to send the whole prompt.`
  );
}

/**
 * Conservative per-call RESERVE for the budget pre-check (the gate). We don't
 * know a model's settled price until after the call, so for any path that CAN
 * pick an expensive model we reserve a frontier-ish worst-case scaled by
 * max_tokens — this stops a near-exhausted budget from authorizing one large
 * frontier completion. The post-call recordActualSpend() books the REAL settled
 * cost (LLMClient.getSpending delta), so over-reserving here only affects the
 * gate, never the ledger.
 */
export function estimateChatCost(
  maxTokens: number | undefined,
  mode: string | undefined,
  model: string | undefined,
  thinkingBudget?: number,
  promptChars?: number,
): number {
  // Free paths bypass the gate entirely — but ONLY when the call is genuinely
  // free, and `mode` alone does not make it so.
  //
  // An explicit `model` WINS over `mode` at call time:
  //   targetModel = model || MODEL_TIERS[mode ?? "balanced"][0] || "openai/gpt-5.6-terra"
  // so { mode: "free", model: "openai/gpt-5.6-sol" } runs gpt-5.6-sol and settles at
  // frontier prices. Returning 0 for it — which is what an unconditional
  // `mode === "free"` check does — is a TOTAL budget-gate bypass: any agent, even
  // one already at its cap, gets unmetered frontier calls by tacking on
  // mode:"free". Worst case measured: mode:"free" + claude-opus-4.8 + a 100k
  // thinking budget reserved $0 on a call that can settle over $2.
  //
  // So: an explicit model decides on its own merits; `mode` only grants free when
  // no model overrides it.
  // Canonicalised FIRST: the gateway serves vendor-less ids at the same price
  // (and serves the bare free ones free), so every classification below — the
  // nvidia check included — has to run on the catalog spelling.
  const canonical = model ? canonicalChatModel(model) : undefined;
  if (canonical) {
    // Membership, not vendor: the catalogue bills cohere/north-mini-code and
    // poolside/laguna-xs-2.1 at $0 too, and a `startsWith("nvidia/")` here
    // reserved the $5/$30 default for them — an exhausted budget refused a
    // free call. See FREE_CHAT_MODELS for the sweep that keeps the set honest.
    if (FREE_CHAT_MODELS.has(canonical)) return 0; // genuinely free, whatever the mode
  } else if (mode === "free") {
    return 0; // no model to override it — resolves to the free tier
  }

  // Anthropic bills extended-thinking tokens as output, so the thinking budget —
  // not max_tokens — is the dominant cost driver on the native claude-* path.
  // Fold it into the reserved output size so the gate can't be bypassed by a
  // tiny max_tokens + a huge budget_tokens.
  //
  // ONLY there, though. `thinking` is forwarded on the native claude-* path and
  // nowhere else — see the isAnthropicModel dispatch in the handler; the
  // OpenAI-compat paths build their options from max_tokens/temperature/
  // response_format/stop, exactly as the schema's "Ignored for non-Claude
  // models" promises. Folding it unconditionally reserved ~$18 for
  // mode:"powerful" + a 100k budget (gpt-5.4-pro output at $180/M) on a call
  // that settles at cents: a spurious refusal for a delegated agent, and a
  // wrong "Estimated: $X" put in front of a human under BLOCKRUN_CONFIRM_SPEND.
  // Same classifier as the dispatch, run on the canonical id, so the two agree
  // for the prefixed and the bare claude-* spelling alike.
  const thinkingOut = canonical && isAnthropicModel(canonical) ? (thinkingBudget ?? 0) : 0;
  const out = Math.max((maxTokens ?? 1024) + thinkingOut, 256);

  // Reserve at the REAL rate of what this call can settle at — the named model's
  // own price, or the most expensive member of the tier it will route through.
  //
  // Until 0.40.1 this was two hardcoded constants ($5/M input, 4 chars/token)
  // for everything "frontier" and ($1/M, $3/M) for everything "cheap". Both were
  // wrong at both ends of the catalog and always in the same direction: live 402
  // quotes for a 100k-char prompt showed gpt-5.4-pro short by 9.90x, o1 by 4.93x,
  // claude-opus-5 — the DEFAULT primary of mode:"powerful" — by 1.65x, and
  // gemini-3.5-flash (fast[0]) by 2.46x. See CHAT_PRICE_PER_MTOKEN for the table
  // and the measurements. Until 0.32.3 the input term was missing entirely
  // (11.4x short); this is the same defect, surviving in the coefficients.
  //
  // Over-reserving only tightens the gate and is released immediately after the
  // call; recordActualSpend() then books the REAL settled cost. Under-reserving
  // is what lets one approved call blow a cap, so where the two disagree this
  // rounds toward reserving more (worst tier member, 2 chars/token).
  // hasOwn-guarded, NOT `?? DEFAULT`. Both tables are object literals, so they
  // inherit from Object.prototype: `model:"constructor"` resolves to a FUNCTION,
  // which survives `??`, makes rate.input undefined, and turns the arithmetic
  // into NaN — and withTxFee maps NaN to 0, i.e. a $0 reserve that the budget
  // gate waves through. `model` is a free-form z.string(), so it is caller
  // controlled. This is the identical fail-open documented on the modal GPU
  // table (src/tools/modal.ts) and it was reintroduced here the moment these
  // tables were added; measured before the guard: model:"constructor",
  // "toString", "__proto__", "hasOwnProperty" and "valueOf" all reserved $0.
  const effectiveMode = (mode ?? "balanced") as RoutingMode;
  const rate = canonical
    ? (Object.hasOwn(CHAT_PRICE_PER_MTOKEN, canonical) ? CHAT_PRICE_PER_MTOKEN[canonical] : DEFAULT_CHAT_PRICE)
    : (Object.hasOwn(TIER_WORST_PRICE, effectiveMode) ? TIER_WORST_PRICE[effectiveMode] : DEFAULT_CHAT_PRICE);

  const inTokens = Math.ceil((promptChars ?? 0) / GATEWAY_CHARS_PER_TOKEN);
  // Rounded to micro-dollars because the raw float drifts — (1024/1e6)*20 is
  // 0.020479999999999998, which then surfaces verbatim in budget messages.
  const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;
  const inputReserve = micro((inTokens / 1_000_000) * rate.input);
  const outputReserve = micro((out / 1_000_000) * rate.output);

  // Floor: a tiny prompt still costs the flat transaction fee, and a $0 reserve
  // would make the gate a no-op for it. withTxFee adds the fee on top — the
  // reserve must cover the CHARGE, not the base (see src/utils/tx-fee.ts).
  return withTxFee(Math.max(inputReserve + outputReserve, 0.001));
}

/**
 * What the ACCOUNT rail is booked at when the response carried no settled cost.
 *
 * api.blockrun.ai bills chat at exact usage, after the response is sent — which
 * is why `x-blockrun-cost-usd` is absent on chat by design (api-key-call.ts).
 * Until audit round 3 the three OpenAI-compat paths then booked the GATE
 * reserve: the most expensive member of the tier, input at 2 chars/token,
 * output at the full max_tokens, plus a $0.002 transaction fee this rail never
 * charges — 3-6x the real charge on mode:"balanced", up to ~50x on "powerful"
 * with a short reply, so BLOCKRUN_BUDGET_LIMIT tripped at a fraction of real
 * spend and action:"report" overstated it (C33/D53). 0.50.0's ledgerFallback
 * fixed the same reserve-as-ledger pattern for the path tools; this is chat's.
 *
 * The model's own rate — the SERVED model's when it has a row (the gateway
 * aliases retired ids, and the bill follows what answered), else the requested
 * one's; a free REQUEST is free whatever answered it (the $0 probes show every
 * alias of a free id served without a payment header) — input and output at
 * the token counts the stream reported when it did, else the prompt at the
 * observed chars/token and the full max_tokens (the conservative side, for a
 * failure that reported nothing). No fee, no floor: reconciled 2026-09-05, the
 * account rail charges base × margin and nothing else. Still an estimate — the
 * caller labels it as one.
 */
export function accountLedgerUsd(
  requestedModel: string,
  servedModel: string | null,
  promptChars: number,
  maxTokens: number,
  usage: ChatUsage | null,
): number {
  const requested = canonicalChatModel(requestedModel);
  if (FREE_CHAT_MODELS.has(requested)) return 0;
  const served = servedModel ? canonicalChatModel(servedModel) : null;
  const rate = served && Object.hasOwn(CHAT_PRICE_PER_MTOKEN, served) ? CHAT_PRICE_PER_MTOKEN[served]
    : Object.hasOwn(CHAT_PRICE_PER_MTOKEN, requested) ? CHAT_PRICE_PER_MTOKEN[requested]
    : DEFAULT_CHAT_PRICE;
  const inTokens = usage?.promptTokens ?? Math.ceil(promptChars / GATEWAY_CHARS_PER_TOKEN_OBSERVED);
  const outTokens = usage?.completionTokens ?? maxTokens;
  const usd = (inTokens / 1_000_000) * rate.input + (outTokens / 1_000_000) * rate.output;
  // Whole micro-dollars, rounded up as the gateway bills; the epsilon keeps a
  // binary-float 4500.0000000001 from ceiling to 4501.
  return Math.ceil(usd * 1e6 - 1e-6) / 1e6;
}

/** What a failed call cost, as far as this process can tell. */
type FailedBooking = {
  usd: number;
  /** "settled": the charge is certain. "unknown": it may have happened; booked as a precaution. */
  certainty: "settled" | "unknown";
};

/**
 * Settled cost of the chat call that ran inside `run`.
 *
 * ON THE WALLET RAILS it is the delta of the client's own cumulative spend
 * counter (getSpending().totalUsd), which the SDK increments with the REAL
 * on-chain amount once the PAID response comes back OK. A THROW DOES NOT MEAN A
 * REFUND: x402 settles on that 200, before the body is read, and the call can
 * still fail afterwards — a mid-stream error event, an idle stall, an empty
 * completion. Until 0.40.1 the delta was computed only after `run()` resolved,
 * so the USDC left the wallet, `budget.spent` never moved, and the `finally`
 * released the reservation — the ledger recorded a free call. `onSettledThrow`
 * is how the charge still gets booked.
 *
 * The counter has a blind spot, and it is on the DEFAULT chain. The SDK counts
 * only after the paid retry was OK — SolanaLLMClient runs assertPaid() before
 * recordSettlement(), LLMClient throws "API error after payment" before its
 * increment, and a fetch timeout on the paid retry (60s on Solana) throws with
 * no increment at all. The payment had been signed and SENT in every one of
 * those; the gateway settles them after the client is gone. Until audit round
 * 3 that read as a $0 delta: nothing booked, "temporary API issue — try again",
 * and the routing loop signed a second payment for the next model under the
 * same reservation (C19). settlementOnThrow classifies those as "unknown": the
 * reserve is booked as a precaution, the loop stops, the note says MAY. An
 * unpaid first-response 4xx, a refused payment, or a 4xx on the paid retry (the
 * gateway's own refusal, before settlement starts) still books nothing.
 *
 * ON THE ACCOUNT RAIL THERE IS NO COUNTER TO READ — getSpending() THROWS for an
 * API-key client. What there is instead: the SDK's account transport throws an
 * APIError carrying the status of the FIRST response, before any body, for
 * every refusal (400 unknown model, 401, 402 out of credit, 429), so none of
 * those is billed; a failure after the 2xx (AcceptedThenFailedError) is a
 * billed call at exact usage; an origin that never answered is "unknown". The
 * 0.50.0 fix for "a billed-then-dropped stream booked $0" caught EVERY
 * rejection here and booked the full reserve for it with "the charge stands"
 * — five typo'd model ids exhausted a delegated cap at $0 real spend, a 402
 * out-of-credit read as billed, and mode:"free" died on its first timeout
 * (C5/C18/C23/C31). On success the response may carry `x-blockrun-cost-usd`;
 * when it does that is the entry (a settled zero included), and when it does
 * not, accountLedgerUsd is — labelled as the estimate it is.
 */
async function withSettledCost<T extends ChatOutcome>(
  client: ApiClient,
  estimateUsd: number,
  accountLedger: (outcome: T | null) => number,
  run: () => Promise<T>,
  onSettledThrow: (booking: FailedBooking) => void,
): Promise<{ result: T; settledUsd: number; costIsEstimate: boolean }> {
  if (isApiKeyMode()) {
    try {
      const result = await run();
      return result.settledUsd === null
        ? { result, settledUsd: accountLedger(result), costIsEstimate: true }
        : { result, settledUsd: result.settledUsd, costIsEstimate: false };
    } catch (error) {
      const verdict = settlementOnThrow(error, { rail: "account", estimateUsd });
      if (verdict !== "none") onSettledThrow({ usd: accountLedger(null), certainty: verdict });
      throw error;
    }
  }
  const before = client.getSpending().totalUsd;
  const delta = () => {
    const d = client.getSpending().totalUsd - before;
    return Number.isFinite(d) && d >= 0 ? d : null;
  };
  try {
    const result = await run();
    // null = the counter could not be read: book the reserve rather than $0.
    const d = delta();
    return { result, settledUsd: d ?? estimateUsd, costIsEstimate: d === null };
  } catch (error) {
    const d = delta();
    if (d !== null && d > 0) {
      onSettledThrow({ usd: d, certainty: "settled" });
    } else if (settlementOnThrow(error, { rail: "wallet", estimateUsd }) === "unknown") {
      onSettledThrow({ usd: estimateUsd, certainty: "unknown" });
    }
    // A counter that says $0 after a 2xx is a call the gateway served without
    // charging (its free fallback); nothing to book.
    throw error;
  }
}

/**
 * The error text for a call that cost money — or may have — and then failed.
 *
 * x402 settles on the 200, before the body is read, and every paid path streams,
 * so a stall or an in-band error event arrives with the money already gone.
 * withSettledCost books it (onSettledThrow); this is the sentence that tells the
 * CALLER. Without it the text was "Error: stream stalled: no data from the
 * gateway for 120s" — indistinguishable from a free failure, so the obvious next
 * step (retry) settled a second payment.
 *
 * The wording tracks the certainty, because the text is what an agent acts on.
 * "The charge stands" is said only when it is known to (a counter delta, or an
 * account request the gateway accepted with a 2xx). When the payment was sent
 * and no verdict came back, the note says MAY, names the booked reserve as a
 * precaution, and points at action:"report" — it does not assert a charge it
 * cannot see, and it does not invite a retry that would pay again.
 *
 * formatError runs on the BARE error and the note is appended afterwards, on
 * purpose: formatError classifies on keywords, and this note contains the word
 * "payment", which its funding branch reads as an empty wallet. Fed the combined
 * text, the routing loop's version ended in "your wallet needs funding" — the
 * exact wrong advice for a call that just paid.
 */
function settledThenFailedText(error: unknown, booking: FailedBooking, tail: string): string {
  const usd = `$${booking.usd.toFixed(6)}`;
  let what: string;
  if (isApiKeyMode()) {
    what = booking.certainty === "settled"
      ? `Note: the gateway had accepted this request (HTTP 200) before it failed, so it is billed to your BlockRun account at exact usage — ` +
        `an estimated ~${usd} has been recorded against your budget; https://user.blockrun.ai/dashboard/activity has the exact figure.`
      : `Note: this request MAY have been billed to your BlockRun account — no response was observed, so this process cannot tell. ` +
        `An estimated ~${usd} has been recorded against your budget as a precaution; https://user.blockrun.ai/dashboard/activity has the truth.`;
  } else {
    what = booking.certainty === "settled"
      ? `Note: payment had already settled when this failed, so the charge stands (${usd}) and it has been recorded against your budget.`
      : `Note: the payment for this call had been signed and sent before it failed, and this process cannot tell whether the gateway settled it — ` +
        `it may have settled after the connection dropped. The reserved ${usd} has been recorded against your budget as a precaution.`;
  }
  const partial = error instanceof AcceptedThenFailedError && error.partialText
    ? `\n\nPartial response received before the failure (${error.partialText.length.toLocaleString("en-US")} chars):\n${error.partialText}`
    : "";
  return `${formatError(extractErrorMessage(error))}\n\n${what} ${tail}${partial}`;
}
const RETRY_CHARGES_AGAIN = 'Retrying will incur a second charge — check blockrun_wallet action:"report" first.';

/**
 * Notes appended to a SUCCESSFUL reply about what the gateway said of it.
 *
 * `served_model`: constants.ts documents that the gateway aliases retired ids
 * onto a live model instead of 404ing, and that "only the response's `model`
 * field" tells you. The text and structuredContent used to echo the REQUESTED
 * id, so an agent asking a stale id for "Kimi's opinion" presented another
 * model's answer as Kimi's, paid for a model nobody chose (D55). The $0 probe
 * on 2026-09-13 showed eight of eleven free[] ids answering as another model.
 *
 * `truncated_output`: finish_reason "length" is the model stopping at
 * max_tokens mid-sentence (or mid-JSON, with response_format json_object). It
 * was read and dropped, so a cut reply came back looking complete — the silent
 * truncation shape the free-tier prompt note exists to make loud (D57).
 */
function servedNotes(requested: string, outcome: ChatOutcome, maxTokens: number | undefined): { text: string; fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  let text = "";
  const served = outcome.servedModel;
  if (served) fields.served_model = served;
  if (served && canonicalChatModel(served) !== canonicalChatModel(requested)) {
    text += `\n\n(Served by ${served} — the gateway answered the requested id ${requested} with this model instead: retired, aliased, or at capacity.)`;
  }
  if (outcome.finishReason) fields.finish_reason = outcome.finishReason;
  if (outcome.finishReason === "length" && outcome.text) {
    fields.truncated_output = true;
    text += `\n\n⚠️ TRUNCATED OUTPUT: the reply hit max_tokens=${maxTokens ?? 1024} and stopped mid-way (finish_reason "length"). ` +
      `Raise max_tokens to get the rest — reasoning tokens count against it too.`;
  }
  return { text, fields };
}

/** The cost line for a reply, and its structuredContent fields. */
function costNotes(settledUsd: number, costIsEstimate: boolean): { text: string; fields: Record<string, unknown> } {
  const fields = { cost_usd: settledUsd, cost_is_estimate: costIsEstimate };
  // Only an ESTIMATE is worth a line in the reply: a settled wallet delta is
  // already in action:"report", and the account rail's exact figure lives on
  // the dashboard. Saying "~" is what keeps the CHANGELOG's promise that an
  // estimated figure never looks like a settlement.
  if (!costIsEstimate || !(settledUsd > 0)) return { text: "", fields };
  return {
    text: `\n\n(Cost: ~$${settledUsd.toFixed(4)}, estimated${isApiKeyMode() ? " — billed to your BlockRun account at exact usage; https://user.blockrun.ai/dashboard/activity has the figure" : ""}.)`,
    fields,
  };
}

export function registerChatTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_chat",
    {
      description: `Get a second opinion from another AI model, or use a specialized model for a specific task.

Notable modes:
- mode:"powerful" → Claude Opus 5, Claude Opus 4.8, GPT-5.6-sol, Claude Fable 5 (frontier, 1M context)
- mode:"reasoning" → Claude Opus 5, GPT-5.6-sol, Kimi K3, Grok 4.3, deepseek-v4-pro
- mode:"coding" → Claude Opus 5, GPT-5.3-codex, Kimi K3, Grok Build, GLM-5.2
- mode:"cheap" → deepseek-v4-pro, Qwen3.7 Flash, MiniMax M3, Tencent Hy3
- mode:"glm" → Zhipu GLM-5 / 5.2 / 5.1 / 5-Turbo (strong at coding)
- mode:"free" → free models (no cost)

Pick directly: model:"anthropic/claude-opus-5", model:"moonshot/kimi-k3", model:"openai/gpt-5.6-sol", model:"xai/grok-4.5", model:"nvidia/gpt-oss-120b" (free).

Run blockrun_models to see all available models with pricing.`,
      annotations: TOOL_ANNOTATIONS.generative,
      inputSchema: {
        message: z.string().describe("Your message to the AI"),
        model: z.string().optional().describe("Specific model ID (e.g., 'moonshot/kimi-k3', 'openai/gpt-5.6-sol', 'zai/glm-5')"),
        mode: z.enum(["fast", "balanced", "powerful", "cheap", "reasoning", "free", "coding", "glm"]).optional().describe("Routing mode: powerful/reasoning = frontier models (Opus 5, GPT-5.6-sol, Kimi K3), coding = code-specialized, glm = Zhipu GLM (great for coding), cheap = budget models, free = $0 models (ignored if model specified)"),
        system: z.string().optional().describe("Optional system prompt"),
        max_tokens: z.number().optional().default(1024).describe("Max tokens in response"),
        temperature: z.number().optional().default(1).describe("Creativity 0-2"),
        response_format: z.enum(["text", "json_object"]).optional().describe("Set to 'json_object' to force valid JSON output (no markdown fences). Works across all providers."),
        stop: z.array(z.string()).max(4).optional().describe("Up to 4 stop sequences; generation halts when any is produced"),
        thinking: z.object({
          type: z.literal("enabled"),
          budget_tokens: z.number().int().min(1024).max(100_000).describe("Tokens Claude may spend reasoning before answering (1024–100000; Anthropic requires ≥1024). max_tokens is auto-raised above this if needed; counts toward the budget reserve."),
        }).optional().describe("Anthropic extended thinking. Only honored for anthropic/claude-* models — these go direct to the native /v1/messages endpoint and the response includes verbatim type:'thinking' blocks with their original signature. Ignored for non-Claude models (no native thinking channel)."),
        agent_id: z.string().optional().describe("Agent identifier. If a budget was delegated for this agent_id via blockrun_wallet action:'delegate', spending is tracked and enforced. The agent is hard-stopped when its budget is exhausted."),
        messages: z.array(z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.union([
            z.string(),
            z.array(z.union([
              z.object({ type: z.literal("text"), text: z.string() }),
              z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string().describe("https URL or data:<mime>;base64,<...> URI") }) }),
            ])),
          ]).describe("Plain text, or an array of parts for multimodal input (text + image_url). Images are honored on the native anthropic/claude-* path."),
        })).optional().describe("Conversation history for multi-turn context. When provided, 'message' is appended as the final user turn. Use with explicit 'model' param (defaults to 'openai/gpt-5.6-terra' if not specified). Note: if you include a role:'system' entry in messages[], do not also pass the system param to avoid duplicate system messages."),
      },
    },
    async ({ message, model, mode, system, max_tokens, temperature, response_format, stop, thinking, agent_id, messages }) => {
      // Fresh per-call client so withSettledCost's getSpending() delta isolates
      // THIS call's cost (the shared singleton's cumulative counter double-counts
      // concurrent calls — see buildClient).
      // Built lazily below for the free path: mode:"free" with no model and no
      // messages is the only shape that reaches the routing loop, and it uses
      // freeClient instead — so an eager buildClient() here was constructed and
      // thrown away on every free call. On Solana that is not free: buildClient()
      // -> buildSolanaClient() -> loadSolanaWallet() scans the home directory.
      let _llm: ApiClient | undefined;
      const llm = (): ApiClient => (_llm ??= buildClient());

      // OpenAI-compatible response shaping, forwarded to every call path below.
      const responseFormat = response_format ? ({ type: response_format } as const) : undefined;

      // Measured once and checked against whichever model each path settles on:
      // the free NVIDIA path drops everything past 128 KiB without saying so.
      const promptChars = promptCharSize(message, system, messages);

      // Budget gate: global + per-agent enforcement. The tier/model is resolved
      // AFTER the gate, so reserve the worst case it could settle at.
      const estimatedCost = estimateChatCost(max_tokens, mode, model, thinking?.budget_tokens, promptChars);
      // Reserve the estimate up front so concurrent calls can't each pass a
      // stale budget; release in finally once the call settles or fails (the
      // real settled cost is booked separately via recordActualSpend).
      const gate = reserveBudget(budget, agent_id, estimatedCost);
      if (!gate.allowed) {
        return {
          content: [{ type: "text", text: `${gate.reason}. Use blockrun_wallet with action: "report" to see usage, or action: "delegate" to increase agent budget.` }],
          isError: true,
        };
      }
      try {
      // Human-in-the-loop (BLOCKRUN_CONFIRM_SPEND=on): ask before signing. A
      // decline returns here — nothing is sent, and the finally releases the
      // reservation. No-ops when off, sub-threshold, or unsupported by the client.
      const confirm = await confirmSpend(server, { usd: estimatedCost, label: `chat · ${model ?? mode ?? "auto"}` });
      if (!confirm.ok) return { content: [{ type: "text", text: confirm.reason ?? "Charge cancelled." }] };

      // Native Anthropic passthrough (Base wallet and the account rail).
      // An explicit anthropic/claude-* model goes DIRECT to the gateway's
      // /v1/messages endpoint, which forwards to api.anthropic.com VERBATIM:
      // zero model substitution, no cost routing, no fallback, and the real
      // native response — type:"thinking" blocks with their original signature.
      // This takes priority over mode/routing precisely because the requirement
      // is "claude-* must be verbatim, never routed". The OpenAI-compat paths
      // below cannot carry thinking signatures.
      //
      // ON SOLANA the AnthropicClient cannot pay (it signs EVM x402 only), and
      // until audit round 3 every explicit claude-* id was refused there with
      // "switch to Base" — while mode:"powerful"/"reasoning"/"coding" sent the
      // very same ids through /v1/chat/completions on sol.blockrun.ai one
      // branch lower, and a fresh install's Base wallet is empty. Verified
      // 2026-09-13 with an unpaid POST: sol.blockrun.ai quotes claude-opus-5
      // and claude-sonnet-5 on chat/completions (402, "Claude Opus 5 API
      // call"), so the route exists. The refusal now applies only when
      // `thinking` is requested — the one thing the compat path cannot carry —
      // and a plain claude-* call on Solana takes the explicit-model path
      // below like any other id (D5). Its price there is the Solana quote:
      // output at full max_tokens, not Base's 0.1x — see D52 in the audit —
      // which the reserve already covers.
      if (model && isAnthropicModel(model)) {
        // Non-null only on a Solana wallet (null in API-key mode and on Base).
        const solanaBlock = baseOnlyMessage("Native Anthropic (claude-*) calls with `thinking`");
        if (solanaBlock && thinking) {
          return { content: [{ type: "text", text: solanaBlock }], isError: true };
        }
        // Solana without `thinking` falls through to the explicit-model path.
        if (!solanaBlock) return await handleAnthropicNative({
          client: getAnthropicClient(),
          model,
          message,
          system,
          messages,
          maxTokens: max_tokens,
          temperature,
          stop,
          thinking,
          responseFormat,
          budget,
          agentId: agent_id,
          estimatedCost,
        });
      }

      // NOTE: routing:"smart" (llm.smartChat → @blockrun/clawrouter) was removed in
      // 0.30.6. It auto-picked the cheapest capable model, which serves an agent
      // that has no model of its own — but every caller here is already running
      // inside a frontier model and reaches for this tool to get what that model
      // LACKS: a specific model, an image, live X data. It was the sole reason the
      // router was in our dependency tree (~50MB, ~15% of the install), and the sole
      // reason clawrouter@0.12.220's broken bundle could take this server down.
      // Callers wanting a cheap model should pass mode:"cheap"/"glm" or an explicit
      // model — both resolve here, with no router.

      // One paid attempt, whichever path asked for it: run it, book what it
      // cost, and hand back the outcome with the notes a reply carries.
      //
      // Paid calls STREAM and assemble (see utils/chat-stream.ts): a slow
      // reasoning model generating for minutes over a non-streaming request
      // moves zero bytes, and the edge in front of the gateway 524s the idle
      // connection AFTER the x402 payment settled — charged, no reply (observed
      // live with moonshot/kimi-k3, 2026-07-21). That includes Solana since
      // audit round 3: the SDK's stream() pays and records the settlement
      // before the first frame, where the old non-streaming path aborted at
      // the Solana client's 60s default with the payment already sent.
      //
      // The SDK types ChatMessage.content as string-only, but the gateway
      // forwards `messages` verbatim and accepts image_url content arrays for
      // vision-capable models — so a multimodal array is runtime-valid.
      // (claude-* with history is already handled by the native branch above.)
      const attempt = async (
        client: ApiClient,
        targetModel: string,
        fullMessages: StreamChatMessage[],
        stream: boolean,
        onFailedBooking: (booking: FailedBooking) => void,
      ) => {
        const { result, settledUsd, costIsEstimate } = await withSettledCost(
          client,
          estimatedCost,
          (outcome) => accountLedgerUsd(targetModel, outcome?.servedModel ?? null, promptChars, max_tokens ?? 1024, outcome?.usage ?? null),
          () => completeChat(client, targetModel, fullMessages, { maxTokens: max_tokens, temperature, responseFormat, stop }, { stream }),
          (booking) => {
            recordActualSpend(budget, booking.usd, estimatedCost, agent_id);
            onFailedBooking(booking);
          },
        );
        recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
        const served = servedNotes(targetModel, result, max_tokens);
        const cost = costNotes(settledUsd, costIsEstimate);
        const prompt = freeTierTruncationNote(promptChars, result.servedModel ?? targetModel);
        return {
          reply: result.text,
          notes: `${served.text}${cost.text}${prompt ?? ""}`,
          fields: { ...served.fields, ...cost.fields, ...(prompt ? { truncated: true } : {}) },
        };
      };
      const failedText = (error: unknown, booking: FailedBooking | null, tail: string) => {
        const partial = error instanceof AcceptedThenFailedError && error.partialText ? error.partialText : "";
        // Nothing booked (a free model, or a served-free call that died): the
        // partial text is still the caller's, so it still rides along.
        const text = booking
          ? settledThenFailedText(error, booking, tail)
          : `${formatError(extractErrorMessage(error))}${partial ? `\n\nPartial response received before the failure (${partial.length.toLocaleString("en-US")} chars):\n${partial}` : ""}`;
        return {
          content: [{ type: "text" as const, text }],
          ...(partial ? { structuredContent: { partial_response: partial } } : {}),
          isError: true as const,
        };
      };

      // Multi-turn conversation
      if (messages && messages.length > 0) {
        const targetModel = model || MODEL_TIERS[(mode ?? "balanced") as RoutingMode]?.[0] || "openai/gpt-5.6-terra";
        const fullMessages = [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          ...messages,
          { role: "user" as const, content: message },
        ] as StreamChatMessage[];
        // What a failed attempt cost, if anything (see settledThenFailedText).
        let failedBooking: FailedBooking | null = null;
        try {
          const { reply, notes, fields } = await attempt(llm(), targetModel, fullMessages, true, (b) => { failedBooking = b; });
          return {
            content: [{ type: "text", text: `[${targetModel} | ${fullMessages.length} msgs]\n\n${reply}${notes}` }],
            structuredContent: { model_used: targetModel, response: reply, message_count: fullMessages.length, ...fields },
          };
        } catch (error) {
          return failedText(error, failedBooking, RETRY_CHARGES_AGAIN);
        }
      }

      // If specific model provided, use it directly.
      if (model) {
        let failedBooking: FailedBooking | null = null;
        try {
          const { reply, notes, fields } = await attempt(llm(), model, [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user" as const, content: message },
          ], true, (b) => { failedBooking = b; });
          return {
            content: [{ type: "text", text: `${reply}${notes}` }],
            structuredContent: { model_used: model, response: reply, ...fields },
          };
        } catch (error) {
          return failedText(error, failedBooking, RETRY_CHARGES_AGAIN);
        }
      }

      // Smart routing mode
      const routingMode: RoutingMode = mode || "balanced";
      const models = MODEL_TIERS[routingMode];

      // Only the free tier gets a deadline. Paid tiers are frontier/reasoning
      // models where a multi-minute completion is the job, not a fault; free
      // models fail by crawling and there are several of them to fall through.
      // See FREE_MODEL_TIMEOUT_MS for the measurements behind the numbers.
      const freeClient = routingMode === "free" ? buildClientWithTimeout(FREE_MODEL_TIMEOUT_MS) : null;
      const routingClient = freeClient ?? llm();
      const loopStartedAt = Date.now();

      let lastError: unknown = null;
      let deadlineHit = false;
      // What a failed attempt in this loop already cost — or may have.
      let failedBooking: FailedBooking | null = null;
      for (const m of models) {
        // Stop starting NEW attempts once the loop has burned its whole budget —
        // otherwise the bound would be per-model only and would grow with the list.
        if (freeClient && Date.now() - loopStartedAt >= FREE_TIER_DEADLINE_MS) {
          deadlineHit = true;
          break;
        }
        try {
          // Paid tiers stream (frontier primaries can generate for minutes —
          // same 524 class as the explicit-model path). The free tier stays on
          // the non-streaming client whose short timeout the deadline loop
          // depends on to fail fast through its candidates.
          const { reply, notes, fields } = await attempt(routingClient, m, [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user" as const, content: message },
          ], !freeClient, (b) => { failedBooking = b; });
          return {
            content: [{ type: "text", text: `[${m}]\n\n${reply}${notes}` }],
            structuredContent: { model_used: m, response: reply, ...fields },
          };
        } catch (error) {
          lastError = error;
          // ONE RESERVATION MEANS ONE SETTLEMENT. The fallback loop exists for
          // models that refuse before taking payment (400, refusal, an unpaid
          // timeout) — there, trying the next model costs nothing and is the
          // whole point. But a model that settled and THEN failed has already
          // charged the caller, and one whose payment was sent and never
          // answered MAY have — continuing would settle a second payment for
          // the same tool call under the same reserved amount, unbounded by
          // the gate. Free models reserve $0, so mode:"free" always falls
          // through, on every rail.
          if (failedBooking) break;
          continue;
        }
      }

      // Say it plainly: the payment settled (or may have) before the failure,
      // so no fallback was attempted. An agent that reads "failed" as "free"
      // would retry in a loop and pay each time. (Free models reserve $0, so
      // the deadline case below can never also be a booked one.)
      if (failedBooking) {
        return failedText(lastError, failedBooking, "No fallback model was tried — retrying will incur a second charge.");
      }
      // Distinguish "every model rejected" from "we ran out of time" — they need
      // different things from the caller (retry vs. pick a paid model), and a bare
      // last-error would have blamed whichever model happened to be slowest.
      const errorMessage = deadlineHit
        ? `The free tier did not answer within ${Math.round(FREE_TIER_DEADLINE_MS / 1000)}s. Free-tier capacity is usually saturated when this happens — retry shortly, or pass an explicit model (or a paid mode) to skip the free tier.`
        : lastError
          ? extractErrorMessage(lastError)
          : "All models failed";
      return {
        content: [{ type: "text", text: formatError(errorMessage) }],
        isError: true,
      };
      } finally {
        gate.release();
      }
    }
  );
}
