// src/tools/chat.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildClient, buildClientWithTimeout, getAnthropicClient, baseOnlyMessage } from "../utils/wallet.js";
import { handleAnthropicNative, isAnthropicModel } from "./chat-anthropic.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import { MODEL_TIERS, FREE_MODEL_TIMEOUT_MS, FREE_TIER_DEADLINE_MS, FREE_TIER_MAX_PROMPT_CHARS, type RoutingMode } from "../utils/constants.js";
import { reserveBudget, recordActualSpend } from "../utils/budget.js";
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
  if (!model.startsWith("nvidia/")) return null; // paid models scale past this
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
  if (model) {
    if (model.startsWith("nvidia/")) return 0; // genuinely free, whatever the mode
  } else if (mode === "free") {
    return 0; // no model to override it — resolves to the free tier
  }

  // Anthropic bills extended-thinking tokens as output, so the thinking budget —
  // not max_tokens — is the dominant cost driver on the native claude-* path.
  // Fold it into the reserved output size so the gate can't be bypassed by a
  // tiny max_tokens + a huge budget_tokens.
  const out = Math.max((maxTokens ?? 1024) + (thinkingBudget ?? 0), 256);
  // ~$20 / 1M output tokens — a conservative upper bound covering premium
  // frontier output, floored so tiny completions still reserve something real.
  // withTxFee: the gateway charges base + $0.002 (see src/utils/tx-fee.ts). The
  // reserve must cover the CHARGE, not the base. Rounded to micro-dollars because
  // the raw float drifts — (1024/1e6)*20 is 0.020479999999999998, which then
  // surfaces verbatim in budget messages.
  // INPUT counts too. Until 0.32.3 the reserve was derived from output alone,
  // so a large pasted document reserved the same as a one-line question: a
  // 100k-word prompt settled $0.2557 against a $0.0225 reserve (11.4x short),
  // and break-even was only ~15 KB of prompt — an ordinary pasted file. A
  // BLOCKRUN_BUDGET_LIMIT was then blown several times over by ONE approved
  // call, and concurrency multiplied it. ~4 chars/token, priced at a frontier
  // input rate; over-reserving only tightens the gate, the ledger still books
  // the real settled cost via recordActualSpend().
  const inTokens = Math.ceil((promptChars ?? 0) / 4);
  const inputReserve = (rate: number) => Math.round((inTokens / 1_000_000) * rate * 1e6) / 1e6;
  const frontierReserve = withTxFee(Math.max(0.01, Math.round((out / 1_000_000) * 20 * 1e6) / 1e6) + inputReserve(5));

  // Any tier whose FIRST-CHOICE model is a frontier model, plus any explicit
  // single model, can settle at a price we can't know up front — reserve
  // conservatively. balanced[0] = openai/gpt-5.6-terra and coding[0] =
  // anthropic/claude-opus-4.8 (see MODEL_TIERS), the same frontier primaries as
  // reasoning/powerful, and a no-mode chat resolves to "balanced" (see the
  // routing loop below) — so undefined counts too. Reserving the cheap heuristic
  // for these let a near-exhausted budget authorize a frontier completion, and
  // let N concurrent default calls each pass the gate and collectively blow the
  // cap (the exact TOCTOU that reserveBudget exists to close).
  const effectiveMode = mode ?? "balanced";
  if (
    effectiveMode === "reasoning" ||
    effectiveMode === "powerful" ||
    effectiveMode === "balanced" ||
    effectiveMode === "coding"
  ) {
    return frontierReserve;
  }
  if (model) return frontierReserve;

  // Only the explicitly-cheap tiers (cheap/fast/glm) pick budget models.
  return withTxFee(Math.max(0.002, Math.round((out / 1_000_000) * 3 * 1e6) / 1e6) + inputReserve(1));
}

/**
 * Settled cost of the LLMClient call that ran inside `run`, measured as the
 * delta of the client's own cumulative spend counter (getSpending().totalUsd),
 * which the SDK increments with the REAL on-chain amount per call. Returns the
 * result plus the booked cost so callers can record actual spend, falling back
 * to the estimate when the delta is unavailable (0/NaN).
 */
async function withSettledCost<T>(
  client: ApiClient,
  run: () => Promise<T>,
): Promise<{ result: T; settledUsd: number }> {
  const before = client.getSpending().totalUsd;
  const result = await run();
  const settledUsd = client.getSpending().totalUsd - before;
  return { result, settledUsd };
}

export function registerChatTool(server: McpServer, budget: BudgetState): void {
  server.registerTool(
    "blockrun_chat",
    {
      description: `Get a second opinion from another AI model, or use a specialized model for a specific task.

Notable modes:
- mode:"powerful" → Claude Opus 4.8, GPT-5.6-sol, Claude Fable 5 (frontier, 1M context)
- mode:"reasoning" → Claude Opus 4.8, GPT-5.6-sol, Kimi K3, Grok 4.3, deepseek-v4-pro
- mode:"coding" → Claude Opus 4.8, GPT-5.3-codex, Kimi K3, Grok Build, GLM-5.2
- mode:"cheap" → deepseek-v4-pro, MiniMax M3, GLM-5, NVIDIA free
- mode:"glm" → Zhipu GLM-5 / 5.2 / 5.1 / 5-Turbo (cheap, strong at coding)
- mode:"free" → NVIDIA models (no cost)

Pick directly: model:"moonshot/kimi-k3", model:"openai/gpt-5.6-sol", model:"anthropic/claude-opus-4.8", model:"xai/grok-4.5", model:"nvidia/deepseek-v4-flash" (free).

Run blockrun_models to see all available models with pricing.`,
      inputSchema: {
        message: z.string().describe("Your message to the AI"),
        model: z.string().optional().describe("Specific model ID (e.g., 'moonshot/kimi-k3', 'openai/gpt-5.6-sol', 'zai/glm-5')"),
        mode: z.enum(["fast", "balanced", "powerful", "cheap", "reasoning", "free", "coding", "glm"]).optional().describe("Routing mode: powerful/reasoning = frontier models (Opus 4.8, GPT-5.6-sol, Kimi K3), coding = code-specialized, glm = Zhipu GLM (cheap, great for coding), cheap = budget models, free = NVIDIA only (ignored if model specified)"),
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
          const { result, settledUsd } = await withSettledCost(llm(), () => llm().chatCompletion(targetModel, fullMessages as unknown as Parameters<ReturnType<typeof llm>["chatCompletion"]>[1], {
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          }));
          const reply = result.choices?.[0]?.message?.content || "";
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

      // If specific model provided, use it directly
      if (model) {
        try {
          const { result: response, settledUsd } = await withSettledCost(llm(), () => llm().chat(model, message, {
            system,
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          }));
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
      // models fail by crawling and there are eight of them to fall through.
      // See FREE_MODEL_TIMEOUT_MS for the measurements behind the numbers.
      const freeClient = routingMode === "free" ? buildClientWithTimeout(FREE_MODEL_TIMEOUT_MS) : null;
      const routingClient = freeClient ?? llm();
      const loopStartedAt = Date.now();

      let lastError: unknown = null;
      let deadlineHit = false;
      for (const m of models) {
        // Stop starting NEW attempts once the loop has burned its whole budget —
        // otherwise the bound would be per-model only and would grow with the list.
        if (freeClient && Date.now() - loopStartedAt >= FREE_TIER_DEADLINE_MS) {
          deadlineHit = true;
          break;
        }
        try {
          const { result: response, settledUsd } = await withSettledCost(routingClient, () => routingClient.chat(m, message, {
            system,
            maxTokens: max_tokens,
            temperature,
            responseFormat,
            stop,
          }));
          recordActualSpend(budget, settledUsd, estimatedCost, agent_id);
          const note = freeTierTruncationNote(promptChars, m);
          return {
            content: [{ type: "text", text: `[${m}]\n\n${response}${note ?? ""}` }],
            structuredContent: { model_used: m, response, ...(note ? { truncated: true } : {}) },
          };
        } catch (error) {
          lastError = error;
          continue;
        }
      }

      // Distinguish "every model rejected" from "we ran out of time" — they need
      // different things from the caller (retry vs. pick a paid model), and a bare
      // last-error would have blamed whichever model happened to be slowest.
      const errorMessage = deadlineHit
        ? `The free tier did not answer within ${Math.round(FREE_TIER_DEADLINE_MS / 1000)}s. Free NVIDIA capacity is usually saturated when this happens — retry shortly, or pass an explicit model (or a paid mode) to skip the free tier.`
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
