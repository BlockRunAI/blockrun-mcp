// src/mcp-handler.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Model } from "@blockrun/llm";
import type { BudgetState } from "./types.js";
import { getClient, getWalletInfo } from "./utils/wallet.js";

import { registerWalletTool } from "./tools/wallet.js";
import { registerChatTool } from "./tools/chat.js";
import { registerModelsTool } from "./tools/models.js";
import { registerImageTool } from "./tools/image.js";
import { registerMusicTool } from "./tools/music.js";
import { registerSearchTool } from "./tools/search.js";
import { registerExaTool } from "./tools/exa.js";
import { registerMarketsTool } from "./tools/markets.js";
import { registerDexTool } from "./tools/dex.js";
import { registerModalTool } from "./tools/modal.js";
export function initializeMcpServer(server: McpServer): void {
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  const modelCache: { models: Model[] | null } = { models: null };

  // Register all tools
  registerWalletTool(server, budget);
  registerChatTool(server, budget);
  registerModelsTool(server, modelCache);
  registerImageTool(server);
  registerMusicTool(server);
  registerSearchTool(server);
  registerExaTool(server);
  registerMarketsTool(server);
  registerDexTool(server);
  registerModalTool(server);

  // Register resources
  server.registerResource(
    "wallet",
    "blockrun://wallet",
    { description: "Wallet address and status", mimeType: "application/json" },
    async () => ({
      contents: [{
        uri: "blockrun://wallet",
        mimeType: "application/json",
        text: JSON.stringify(getWalletInfo(), null, 2),
      }],
    })
  );

  server.registerResource(
    "models",
    "blockrun://models",
    { description: "Available AI models with pricing", mimeType: "application/json" },
    async () => {
      const llm = getClient();
      if (!modelCache.models) {
        modelCache.models = await llm.listModels();
        setTimeout(() => { modelCache.models = null; }, 5 * 60 * 1000);
      }
      return {
        contents: [{
          uri: "blockrun://models",
          mimeType: "application/json",
          text: JSON.stringify(modelCache.models, null, 2),
        }],
      };
    }
  );
}
