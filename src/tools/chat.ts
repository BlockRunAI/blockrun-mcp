// src/tools/chat.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "../tool-annotations.js";
import { z } from "zod";
import { buildClient, buildClientWithTimeout, getAnthropicClient, baseOnlyMessage } from "../utils/wallet.js";
import { isApiKeyMode } from "../utils/auth.js";
import { streamChatText, supportsStreaming, type StreamChatMessage } from "../utils/chat-stream.js";
import { handleAnthropicNative, isAnthropicModel } from "./chat-anthropic.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import {
  MODEL_TIERS,
  FREE_MODEL_TIMEOUT_MS,
  FREE_TIER_DEADLINE_MS,
  FREE_TIER_MAX_PROMPT_CHARS,
  CHAT_PRICE_PER_MTOKEN,
  DEFAULT_CHAT_PRICE,
  canonicalChatModel,
  TIER_WORST_PRICE,
  GATEWAY_CHARS_PER_TOKEN,
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
    if (canonical.startsWith("nvidia/")) return 0; // genuinely free, whatever the mode
  } else if (mode === "free") {
    return 0; // no model to override it — resolves to the free tier
  }

  // Anthropic bills extended-thinking tokens as output, so the thinking budget —
  // not max_tokens — is the dominant cost driver on the native claude-* path.
  // Fold it into the reserved output size so the gate can't be bypassed by a
  // tiny max_tokens + a huge budget_tokens.
  const out = Math.max((maxTokens ?? 1024) + (thinkingBudget ?? 0), 256);

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
 * Settled cost of the LLMClient call that ran inside `run`, measured as the
 * delta of the client's own cumulative spend counter (getSpending().totalUsd),
 * which the SDK increments with the REAL on-chain amount per call. Returns the
 * result plus the booked cost so callers can record actual spend, falling back
 * to the estimate when the delta is unavailable (0/NaN).
 *
 * A THROW DOES NOT MEAN A REFUND. x402 settles when the gateway answers 200 —
 * the SDK increments its counter at that moment, before the body is read — and
 * every paid path here STREAMS, so the call can still fail afterwards: a
 * mid-stream error event, an idle stall, an empty completion. Until 0.40.1 the
 * delta was computed only after `run()` resolved, so on that path the USDC left
 * the wallet, `budget.spent` never moved, and the `finally` released the
 * reservation — the ledger recorded a free call. `onSettledThrow` is how the
 * charge still gets booked; it fires only when the delta is real (> 0), so an
 * ordinary pre-payment failure (400, timeout, refusal) still books nothing.
 *
 * ON THE ACCOUNT RAIL THERE IS NO COUNTER TO READ. getSpending() does not return
 * zero for an API-key client — it THROWS:
 *
 *   "Account usage is available at https://user.blockrun.ai/dashboard;
 *    getSpending() tracks x402 settlements only."
 *
 * and it is called three times here, on the very first line, outside the try.
 * Left alone, setting BLOCKRUN_API_KEY would not degrade blockrun_chat, it would
 * break every single call before the request was even sent. So account mode
 * skips the counter entirely and reports settledUsd 0, which every caller
 * already handles as "delta unavailable — fall back to the estimate".
 *
 * The estimate is genuinely all we have: the account API returns no per-call
 * cost header, and its dashboard is cookie-authenticated, so there is nothing
 * this process could read back. Callers label the number accordingly rather
 * than printing an estimate that looks like a settlement.
 */
async function withSettledCost<T>(
  client: ApiClient,
  run: () => Promise<T>,
  onSettledThrow?: (settledUsd: number) => void,
): Promise<{ result: T; settledUsd: number }> {
  if (isApiKeyMode()) {
    return { result: await run(), settledUsd: 0 };
  }
  const before = client.getSpending().totalUsd;
  try {
    const result = await run();
    return { result, settledUsd: client.getSpending().totalUsd - before };
  } catch (error) {
    const settledUsd = client.getSpending().totalUsd - before;
    if (Number.isFinite(settledUsd) && settledUsd > 0) onSettledThrow?.(settledUsd);
    throw error;
  }
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
- mode:"free" → NVIDIA models (no cost)

Pick directly: model:"anthropic/claude-opus-5", model:"moonshot/kimi-k3", model:"openai/gpt-5.6-sol", model:"xai/grok-4.5", model:"nvidia/gpt-oss-120b" (free).

Run blockrun_models to see all available models with pricing.`,
      annotations: TOOL_ANNOTATIONS.generative,
      inputSchema: {
        message: z.string().describe("Your message to the AI"),
        model: z.string().optional().describe("Specific model ID (e.g., 'moonshot/kimi-k3', 'openai/gpt-5.6-sol', 'zai/glm-5')"),
        mode: z.enum(["fast", "balanced", "powerful", "cheap", "reasoning", "free", "coding", "glm"]).optional().describe("Routing mode: powerful/reasoning = frontier models (Opus 5, GPT-5.6-sol, Kimi K3), coding = code-specialized, glm = Zhipu GLM (great for coding), cheap = budget models, free = NVIDIA only (ignored if model specified)"),
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

      // Native Anthropic passthrough (EVM/Base only).
      // An explicit anthropic/claude-* model goes DIRECT to the gateway's
      // /v1/messages endpoint, which forwards to api.anthropic.com VERBATIM:
      // zero model substitution, no cost routing, no fallback, and the real
      // native response — type:"thinking" blocks with their original signature.
      // This takes priority over mode/routing precisely because the requirement
      // is "claude-* must be verbatim, never routed". The OpenAI-compat paths
      // below cannot carry thinking signatures, so claude never falls through.
      if (model && isAnthropicModel(model)) {
        const solanaBlock = baseOnlyMessage("Native Anthropic (claude-*) calls");
        if (solanaBlock) {
          return { content: [{ type: "text", text: solanaBlock }], isError: true };
        }
        return await handleAnthropicNative({
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

      // Multi-turn conversation
      if (messages && messages.length > 0) {
        const targetModel = model || MODEL_TIERS[(mode ?? "balanced") as RoutingMode]?.[0] || "openai/gpt-5.6-terra";
        const fullMessages = [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          ...messages,
          { role: "user" as const, content: message },
        ];
        try {
          // The SDK types ChatMessage.content as string-only, but the gateway
          // forwards `messages` verbatim and accepts image_url content arrays
          // for vision-capable models — so a multimodal array is runtime-valid.
          // (claude-* with history is already handled by the native branch above.)
          //
          // Paid calls STREAM and assemble (see utils/chat-stream.ts): a slow
          // reasoning model generating for minutes over a non-streaming request
          // moves zero bytes, and the edge in front of the gateway 524s the idle
          // connection AFTER the x402 payment settled — charged, no reply
          // (observed live with moonshot/kimi-k3, 2026-07-21). Solana clients
          // have no streaming API and keep the old path.
          const { result: reply, settledUsd } = await withSettledCost(llm(), async () => {
            const client = llm();
            if (supportsStreaming(client)) {
              return streamChatText(client, targetModel, fullMessages as unknown as StreamChatMessage[], {
                maxTokens: max_tokens,
                temperature,
                responseFormat,
                stop,
              });
            }
            const r = await client.chatCompletion(targetModel, fullMessages as unknown as Parameters<ReturnType<typeof llm>["chatCompletion"]>[1], {
              maxTokens: max_tokens,
              temperature,
              responseFormat,
              stop,
            });
            return r.choices?.[0]?.message?.content || "";
          }, (usd) => recordActualSpend(budget, usd, estimatedCost, agent_id));
          recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
          const note = freeTierTruncationNote(promptChars, targetModel);
          return {
            content: [{ type: "text", text: `[${targetModel} | ${fullMessages.length} msgs]\n\n${reply}${note ?? ""}` }],
            structuredContent: { model_used: targetModel, response: reply, message_count: fullMessages.length, ...(note ? { truncated: true } : {}) },
          };
        } catch (error) {
          return { content: [{ type: "text", text: formatError(extractErrorMessage(error)) }], isError: true };
        }
      }

      // If specific model provided, use it directly — streamed when the client
      // supports it (same 524 rationale as the multi-turn path above).
      if (model) {
        try {
          const { result: response, settledUsd } = await withSettledCost(llm(), async () => {
            const client = llm();
            if (supportsStreaming(client)) {
              return streamChatText(client, model, [
                ...(system ? [{ role: "system" as const, content: system }] : []),
                { role: "user" as const, content: message },
              ], { maxTokens: max_tokens, temperature, responseFormat, stop });
            }
            return client.chat(model, message, {
              system,
              maxTokens: max_tokens,
              temperature,
              responseFormat,
              stop,
            });
          }, (usd) => recordActualSpend(budget, usd, estimatedCost, agent_id));
          recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
          return { content: [{ type: "text", text: `${response}${freeTierTruncationNote(promptChars, model) ?? ""}` }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: formatError(extractErrorMessage(error)) }],
            isError: true,
          };
        }
      }

      // Smart routing mode
      const routingMode: RoutingMode = mode || "balanced";
      const models = MODEL_TIERS[routingMode];

      // Only the free tier gets a deadline. Paid tiers are frontier/reasoning
      // models where a multi-minute completion is the job, not a fault; free
      // models fail by crawling and there are seven of them to fall through.
      // See FREE_MODEL_TIMEOUT_MS for the measurements behind the numbers.
      const freeClient = routingMode === "free" ? buildClientWithTimeout(FREE_MODEL_TIMEOUT_MS) : null;
      const routingClient = freeClient ?? llm();
      const loopStartedAt = Date.now();

      let lastError: unknown = null;
      let deadlineHit = false;
      // USDC that already left the wallet on a failed attempt in this loop.
      let settledOnFailure = 0;
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
          // depends on to fail fast through its seven candidates.
          const { result: response, settledUsd } = await withSettledCost(routingClient, async () => {
            if (!freeClient && supportsStreaming(routingClient)) {
              return streamChatText(routingClient, m, [
                ...(system ? [{ role: "system" as const, content: system }] : []),
                { role: "user" as const, content: message },
              ], { maxTokens: max_tokens, temperature, responseFormat, stop });
            }
            return routingClient.chat(m, message, {
              system,
              maxTokens: max_tokens,
              temperature,
              responseFormat,
              stop,
            });
          }, (usd) => {
            // Settled, then failed. Book it and remember that this tool call has
            // already cost the caller money — see the break below.
            recordActualSpend(budget, usd, estimatedCost, agent_id);
            settledOnFailure = usd;
          });
          recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
          const note = freeTierTruncationNote(promptChars, m);
          return {
            content: [{ type: "text", text: `[${m}]\n\n${response}${note ?? ""}` }],
            structuredContent: { model_used: m, response, ...(note ? { truncated: true } : {}) },
          };
        } catch (error) {
          lastError = error;
          // ONE RESERVATION MEANS ONE SETTLEMENT. The fallback loop exists for
          // models that refuse before taking payment (400, refusal, timeout) —
          // there, trying the next model costs nothing and is the whole point.
          // But a model that settled and THEN failed has already charged the
          // caller, and continuing would settle a second payment for the same
          // tool call under the same reserved amount, unbounded by the gate.
          // Free models settle $0, so mode:"free" still falls through as designed.
          if (settledOnFailure > 0) break;
          continue;
        }
      }

      // Distinguish "every model rejected" from "we ran out of time" — they need
      // different things from the caller (retry vs. pick a paid model), and a bare
      // last-error would have blamed whichever model happened to be slowest.
      const errorMessage = deadlineHit
        ? `The free tier did not answer within ${Math.round(FREE_TIER_DEADLINE_MS / 1000)}s. Free NVIDIA capacity is usually saturated when this happens — retry shortly, or pass an explicit model (or a paid mode) to skip the free tier.`
        : settledOnFailure > 0
          // Say it plainly: the payment settled before the failure, so the
          // charge stands and no fallback was attempted. An agent that reads
          // "failed" as "free" would retry in a loop and pay each time.
          ? `${extractErrorMessage(lastError)}\n\nNote: payment had already settled when this failed, so the charge stands ($${settledOnFailure.toFixed(6)}) and it has been recorded against your budget. No fallback model was tried — retrying will incur a second charge.`
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
