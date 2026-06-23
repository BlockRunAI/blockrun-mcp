// src/tools/models.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ImageModel, Model } from "@blockrun/llm";
import { getClient } from "../utils/wallet.js";
import { extractErrorMessage, formatError } from "../utils/errors.js";
import { loadModels, type ModelCache, type ModelEntry } from "../utils/model-cache.js";

function getModelType(model: ModelEntry): "llm" | "image" {
  return model.type === "image" || "pricePerImage" in model ? "image" : "llm";
}

export function registerModelsTool(server: McpServer, modelCache: ModelCache): void {
  server.registerTool(
    "blockrun_models",
    {
      description: "List available AI models with pricing. Use to discover models and compare costs.",
      inputSchema: {
        category: z.enum(["all", "chat", "reasoning", "image", "embedding"]).optional().default("all").describe("Filter by category"),
        provider: z.string().optional().describe("Filter by provider (e.g., 'openai', 'anthropic')"),
      },
    },
    async ({ category, provider }) => {
      try {
      let models = await loadModels(getClient(), modelCache);

      if (provider) {
        const p = provider.toLowerCase();
        models = models.filter(m => m.id.toLowerCase().startsWith(p + "/"));
      }

      if (category && category !== "all") {
        if (category === "image") {
          models = models.filter(m => getModelType(m) === "image");
        } else if (category === "embedding") {
          models = models.filter(m => m.id.includes("embed"));
        } else {
          // Use categories from API for chat/reasoning filtering
          models = models.filter(m => "categories" in m && m.categories?.includes(category));
        }
      }

      const lines = models.map(m => {
        if (getModelType(m) === "image") {
          const image = m as ImageModel;
          const pricing = image.pricePerImage ? `$${image.pricePerImage}/image` : "";
          const sizes = image.supportedSizes?.length ? ` | sizes: ${image.supportedSizes.join(", ")}` : "";
          return `- ${image.id}${pricing ? ` (${pricing})` : ""}${sizes} [image]`;
        }

        const llmModel = m as Model;
        const input = llmModel.inputPrice ? `$${llmModel.inputPrice}/M in` : "";
        const output = llmModel.outputPrice ? `$${llmModel.outputPrice}/M out` : "";
        const pricing = [input, output].filter(Boolean).join(", ");
        const ctx = llmModel.contextWindow ? ` | ${Math.round(llmModel.contextWindow / 1000)}K ctx` : "";
        const cats = llmModel.categories?.length ? ` [${llmModel.categories.join(", ")}]` : "";
        return `- ${llmModel.id}${pricing ? ` (${pricing})` : ""}${ctx}${cats}`;
      });

      return {
        content: [{ type: "text", text: `Models (${models.length}):\n${lines.join("\n")}` }],
        structuredContent: { count: models.length, models },
      };
      } catch (err) {
        // Every other tool normalizes errors; the catalogue fetch (network/5xx)
        // must not propagate uncaught out of the handler.
        return {
          content: [{ type: "text", text: formatError(extractErrorMessage(err)) }],
          isError: true,
        };
      }
    }
  );
}
