// src/mcp-handler.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BudgetState } from "./types.js";
import { getClient, getWalletInfo } from "./utils/wallet.js";
import { loadModels, type ModelCache } from "./utils/model-cache.js";
import { parseBudgetLimitEnv } from "./utils/budget.js";

import { registerWalletTool } from "./tools/wallet.js";
import { registerChatTool } from "./tools/chat.js";
import { registerModelsTool } from "./tools/models.js";
import { registerImageTool } from "./tools/image.js";
import { registerMusicTool } from "./tools/music.js";
import { registerSpeechTool } from "./tools/speech.js";
import { registerVideoTool } from "./tools/video.js";
import { registerRealfaceTool } from "./tools/realface.js";
import { registerSearchTool } from "./tools/search.js";
import { registerExaTool } from "./tools/exa.js";
import { registerMarketsTool } from "./tools/markets.js";
import { registerPriceTool } from "./tools/price.js";
import { registerDexTool } from "./tools/dex.js";
import { registerModalTool } from "./tools/modal.js";
import { registerPhoneTool } from "./tools/phone.js";
import { registerSurfTool } from "./tools/surf.js";
import { registerRpcTool } from "./tools/rpc.js";
import { registerDefiTool } from "./tools/defi.js";
import { registerPolymarketReadTool, registerPolymarketTool } from "./tools/polymarket.js";
import { resolveTools, type ToolName } from "./profiles.js";
import { registerAppResources } from "./apps.js";
import { stripJsonSchemaDialect } from "./utils/strip-schema-dialect.js";

/**
 * Initialize the MCP server. The active tool `profile` (resolved from
 * `--profile` / BLOCKRUN_MCP_PROFILE, defaulting to "full") decides which
 * tools are registered, so one published package can expose a trimmed set
 * (e.g. media-only) without loading the excluded tools' schemas into the
 * client's context. Returns the canonical profile name + registered tools
 * for startup logging.
 */
export function initializeMcpServer(
  server: McpServer,
  profileArgs?: { argv?: string[]; env?: NodeJS.ProcessEnv },
): { profile: string; tools: ToolName[] } {
  // Must run before any tool is registered — that is when the SDK lazily
  // installs the tools/list handler this wraps.
  stripJsonSchemaDialect(server);

  // Default global spend cap from BLOCKRUN_BUDGET_LIMIT (USD). Without it the
  // ledger starts unlimited; the cap is in-memory and resets when the (npx-spawned)
  // process restarts, so an operator who wants a hard ceiling should set the env.
  const env = profileArgs?.env ?? process.env;
  const budget: BudgetState = {
    limit: parseBudgetLimitEnv(env.BLOCKRUN_BUDGET_LIMIT),
    spent: 0,
    calls: 0,
    agents: new Map(),
  };
  const modelCache: ModelCache = { models: null };

  const { profile, tools } = resolveTools(profileArgs?.argv, profileArgs?.env);

  // One registrar per tool — only the ones in the active profile run, so a
  // trimmed profile never advertises (or loads schemas for) excluded tools.
  const registrars: Record<ToolName, () => void> = {
    wallet: () => registerWalletTool(server, budget),
    chat: () => registerChatTool(server, budget),
    models: () => registerModelsTool(server, modelCache),
    image: () => registerImageTool(server, budget),
    music: () => registerMusicTool(server, budget),
    speech: () => registerSpeechTool(server, budget),
    video: () => registerVideoTool(server, budget),
    realface: () => registerRealfaceTool(server, budget),
    search: () => registerSearchTool(server, budget),
    exa: () => registerExaTool(server, budget),
    markets: () => registerMarketsTool(server, budget),
    price: () => registerPriceTool(server, budget),
    dex: () => registerDexTool(server),
    modal: () => registerModalTool(server, budget),
    phone: () => registerPhoneTool(server, budget),
    surf: () => registerSurfTool(server, budget),
    rpc: () => registerRpcTool(server, budget),
    defi: () => registerDefiTool(server, budget),
    polymarket_read: () => registerPolymarketReadTool(server),
    polymarket: () => registerPolymarketTool(server),
  };

  for (const [name, register] of Object.entries(registrars) as [ToolName, () => void][]) {
    if (tools.has(name)) register();
  }

  // Register resources — gated on the matching tool so a trimmed profile
  // doesn't advertise resources for capabilities it excluded.
  if (tools.has("wallet")) {
    server.registerResource(
      "wallet",
      "blockrun://wallet",
      { description: "Wallet address and status", mimeType: "application/json" },
      async () => {
        const info = await getWalletInfo();
        return {
          contents: [{
            uri: "blockrun://wallet",
            mimeType: "application/json",
            text: JSON.stringify(info, null, 2),
          }],
        };
      }
    );
  }

  if (tools.has("models")) {
    server.registerResource(
      "models",
      "blockrun://models",
      { description: "Available AI models with pricing", mimeType: "application/json" },
      async () => {
        const models = await loadModels(getClient(), modelCache);
        return {
          contents: [{
            uri: "blockrun://models",
            mimeType: "application/json",
            text: JSON.stringify(models, null, 2),
          }],
        };
      }
    );
  }

  // MCP App bundles (ui://) for the tools that carry _meta.ui — same gating.
  registerAppResources(server, tools);

  return { profile, tools: [...tools] };
}
