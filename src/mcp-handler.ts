// src/mcp-handler.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BudgetState } from "./types.js";
import { getClient, getWalletInfo } from "./utils/wallet.js";
import { loadModels, type ModelCache } from "./utils/model-cache.js";

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
export function initializeMcpServer(server: McpServer): void {
  const budget: BudgetState = { limit: null, spent: 0, calls: 0, agents: new Map() };
  const modelCache: ModelCache = { models: null };

  // Register all tools
  registerWalletTool(server, budget);
  registerChatTool(server, budget);
  registerModelsTool(server, modelCache);
  registerImageTool(server, budget);
  registerMusicTool(server, budget);
  registerSpeechTool(server, budget);
  registerVideoTool(server, budget);
  registerRealfaceTool(server, budget);
  registerSearchTool(server, budget);
  registerExaTool(server, budget);
  registerMarketsTool(server, budget);
  registerPriceTool(server, budget);
  registerDexTool(server);
  registerModalTool(server, budget);
  registerPhoneTool(server, budget);
  registerSurfTool(server, budget);
  registerRpcTool(server, budget);
  registerDefiTool(server, budget);

  // Register resources
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
