#!/usr/bin/env node
/**
 * BlockRun MCP Server
 *
 * Access 30+ AI models (GPT-5, Claude, Gemini, etc.) via x402 micropayments.
 * No API keys needed - just a wallet with USDC on Base.
 *
 * Installation:
 *   claude mcp add blockrun npx @blockrun/mcp
 *
 * Or with explicit wallet:
 *   claude mcp add blockrun npx @blockrun/mcp --env BLOCKRUN_WALLET_KEY=0x...
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LLMClient, type Model } from "@blockrun/llm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Wallet file location (matches Python SDK)
const WALLET_DIR = path.join(os.homedir(), ".blockrun");
const WALLET_FILE = path.join(WALLET_DIR, ".session");

// Model categories for smart routing
const MODEL_TIERS = {
  fast: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
  balanced: ["openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"],
  powerful: ["openai/gpt-5.2", "anthropic/claude-opus-4", "openai/o3"],
  cheap: ["google/gemini-2.5-flash", "deepseek/deepseek-chat", "openai/gpt-4o-mini"],
  reasoning: ["openai/o3", "openai/o1", "deepseek/deepseek-reasoner"],
} as const;

type RoutingMode = keyof typeof MODEL_TIERS;

// Track if wallet was newly created (for user notification)
let walletWasCreated = false;
let walletAddress: string | null = null;

// Initialize client with auto wallet management
let client: LLMClient | null = null;
let cachedModels: Model[] | null = null;

/**
 * Get or create wallet private key
 * Priority:
 * 1. Environment variable BLOCKRUN_WALLET_KEY or BASE_CHAIN_WALLET_KEY
 * 2. Existing file at ~/.blockrun/.session
 * 3. Generate new wallet and save to file
 */
function getOrCreateWalletKey(): `0x${string}` {
  // 1. Check environment variables
  const envKey = process.env.BLOCKRUN_WALLET_KEY || process.env.BASE_CHAIN_WALLET_KEY;
  if (envKey) {
    const account = privateKeyToAccount(envKey as `0x${string}`);
    walletAddress = account.address;
    return envKey as `0x${string}`;
  }

  // 2. Check existing wallet file
  if (fs.existsSync(WALLET_FILE)) {
    try {
      const savedKey = fs.readFileSync(WALLET_FILE, "utf-8").trim();
      if (savedKey.startsWith("0x") && savedKey.length === 66) {
        const account = privateKeyToAccount(savedKey as `0x${string}`);
        walletAddress = account.address;
        return savedKey as `0x${string}`;
      }
    } catch {
      // File exists but can't be read, will create new
    }
  }

  // 3. Generate new wallet
  const newKey = generatePrivateKey();
  const account = privateKeyToAccount(newKey);
  walletAddress = account.address;
  walletWasCreated = true;

  // Save to file
  try {
    if (!fs.existsSync(WALLET_DIR)) {
      fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(WALLET_FILE, newKey, { mode: 0o600 });
    console.error(`[BlockRun] New wallet created and saved to ${WALLET_FILE}`);
  } catch (err) {
    console.error(`[BlockRun] Warning: Could not save wallet to file: ${err}`);
  }

  return newKey;
}

function getClient(): LLMClient {
  if (!client) {
    const privateKey = getOrCreateWalletKey();
    client = new LLMClient({ privateKey });
  }
  return client;
}

/**
 * Get wallet info object
 */
function getWalletInfo() {
  const llm = getClient();
  const address = llm.getWalletAddress();
  return {
    address,
    network: "Base",
    chainId: 8453,
    currency: "USDC",
    isNew: walletWasCreated,
    basescanUrl: `https://basescan.org/address/${address}`,
    fundingOptions: {
      coinbase: "Send USDC, select 'Base' network",
      bridge: "https://bridge.base.org",
      buy: "https://www.coinbase.com/onramp",
    },
  };
}

/**
 * Get wallet setup instructions for new users
 */
function getWalletSetupInstructions(): string {
  if (!walletAddress) {
    getClient(); // Initialize to get address
  }

  return `
================================================================================
                        BLOCKRUN WALLET SETUP
================================================================================

Your wallet address: ${walletAddress}

To use BlockRun AI models, you need USDC on Base network.

HOW TO FUND YOUR WALLET:
------------------------

Option 1: Transfer from Coinbase
  1. Open Coinbase app or website
  2. Go to Send/Receive
  3. Select USDC
  4. Choose "Base" network (important!)
  5. Paste address: ${walletAddress}
  6. Send any amount ($5 is enough to start)

Option 2: Bridge from other chains
  1. Go to https://bridge.base.org
  2. Connect your existing wallet
  3. Bridge USDC to Base
  4. Send to: ${walletAddress}

Option 3: Buy directly
  1. Go to https://www.coinbase.com/onramp
  2. Buy USDC on Base network
  3. Send to: ${walletAddress}

VERIFY YOUR BALANCE:
  https://basescan.org/address/${walletAddress}

PRICING (pay only for what you use):
  - GPT-4o: ~$0.005 per request
  - Claude Sonnet: ~$0.003 per request
  - Gemini Flash: ~$0.0001 per request
  - Full pricing: https://blockrun.ai/pricing

SECURITY NOTE:
  Your private key is stored at: ~/.blockrun/.session
  This key NEVER leaves your machine - only used for signing payments locally.

================================================================================
`;
}

// Create the server with modern McpServer class
const server = new McpServer({
  name: "blockrun-mcp",
  version: "0.2.0",
});

// ============================================================================
// TOOLS
// ============================================================================

// blockrun_chat - Main chat tool
server.registerTool(
  "blockrun_chat",
  {
    description: `Chat with any AI model via BlockRun. Supports 30+ models including GPT-5, Claude Opus 4, Gemini 3, and more.
Pay-per-request with x402 micropayments - no API keys needed.

Popular models:
- openai/gpt-5.2: Most capable OpenAI model
- anthropic/claude-opus-4: Best for complex reasoning
- anthropic/claude-sonnet-4: Fast & capable (recommended)
- google/gemini-2.5-pro: Great for long context
- deepseek/deepseek-chat: Very affordable

Use blockrun_models to see all available models with pricing.`,
    inputSchema: {
      model: z.string().describe("Model ID (e.g., 'anthropic/claude-sonnet-4', 'openai/gpt-4o'). Use blockrun_models to list all."),
      message: z.string().describe("Your message to the AI"),
      system: z.string().optional().describe("Optional system prompt to set context/behavior"),
      max_tokens: z.number().optional().default(1024).describe("Maximum tokens in response"),
      temperature: z.number().optional().default(1).describe("Creativity level 0-2"),
    },
  },
  async ({ model, message, system, max_tokens, temperature }) => {
    try {
      const llm = getClient();
      const response = await llm.chat(model, message, {
        system,
        maxTokens: max_tokens,
        temperature,
      });
      return { content: [{ type: "text", text: response }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: formatError(errorMessage) }],
        isError: true,
      };
    }
  }
);

// blockrun_smart - Smart model routing
server.registerTool(
  "blockrun_smart",
  {
    description: `Smart model routing - automatically picks the best model based on your needs.

Modes:
- fast: Quickest response (Gemini Flash, GPT-4o-mini)
- balanced: Good quality & speed (GPT-4o, Claude Sonnet)
- powerful: Best quality (GPT-5.2, Claude Opus 4, o3)
- cheap: Lowest cost (Gemini Flash, DeepSeek)
- reasoning: Complex logic (o3, o1, DeepSeek Reasoner)

Example: blockrun_smart({ mode: "fast", message: "Hello" })`,
    inputSchema: {
      mode: z.enum(["fast", "balanced", "powerful", "cheap", "reasoning"]).describe("Routing mode"),
      message: z.string().describe("Your message to the AI"),
      system: z.string().optional().describe("Optional system prompt"),
      max_tokens: z.number().optional().default(1024).describe("Maximum tokens in response"),
    },
    outputSchema: {
      model_used: z.string().describe("The model that was used"),
      response: z.string().describe("The AI response"),
    },
  },
  async ({ mode, message, system, max_tokens }) => {
    const models = MODEL_TIERS[mode as RoutingMode];

    // Try models in order until one succeeds
    let lastError: Error | null = null;
    for (const model of models) {
      try {
        const llm = getClient();
        const response = await llm.chat(model, message, {
          system,
          maxTokens: max_tokens,
        });
        const result = { model_used: model, response };
        return {
          content: [{ type: "text", text: `[Used: ${model}]\n\n${response}` }],
          structuredContent: result,
        };
      } catch (error) {
        lastError = error as Error;
        continue;
      }
    }

    const errorMessage = lastError?.message || "All models failed";
    return {
      content: [{ type: "text", text: formatError(errorMessage) }],
      isError: true,
    };
  }
);

// blockrun_models - List available models
server.registerTool(
  "blockrun_models",
  {
    description: "List all available AI models with pricing. Use this to discover models and compare costs.",
    inputSchema: {
      category: z.enum(["all", "chat", "reasoning", "image", "embedding"]).optional().default("all").describe("Filter by category"),
      provider: z.string().optional().describe("Filter by provider (e.g., 'openai', 'anthropic', 'google')"),
    },
    outputSchema: {
      count: z.number().describe("Number of models returned"),
      models: z.array(z.object({
        id: z.string(),
        name: z.string().optional(),
        inputPrice: z.number().optional(),
        outputPrice: z.number().optional(),
      })).describe("List of available models"),
    },
  },
  async ({ category, provider }) => {
    const llm = getClient();

    // Cache models for 5 minutes
    if (!cachedModels) {
      cachedModels = await llm.listModels();
      setTimeout(() => { cachedModels = null; }, 5 * 60 * 1000);
    }

    let models = cachedModels;

    // Filter by provider
    if (provider) {
      const p = provider.toLowerCase();
      models = models.filter(m => m.id.toLowerCase().startsWith(p + "/"));
    }

    // Filter by category
    if (category && category !== "all") {
      if (category === "image") {
        models = models.filter(m =>
          m.id.includes("dall-e") || m.id.includes("flux") || m.id.includes("banana")
        );
      } else if (category === "reasoning") {
        models = models.filter(m =>
          m.id.includes("/o1") || m.id.includes("/o3") || m.id.includes("reasoner")
        );
      } else if (category === "embedding") {
        models = models.filter(m => m.id.includes("embed"));
      }
    }

    // Format output
    const lines = models.map(m => {
      const input = m.inputPrice ? `$${m.inputPrice}/M in` : "";
      const output = m.outputPrice ? `$${m.outputPrice}/M out` : "";
      const pricing = [input, output].filter(Boolean).join(", ");
      return `- ${m.id}: ${m.name || ""} ${pricing ? `(${pricing})` : ""}`;
    });

    const structuredModels = models.map(m => ({
      id: m.id,
      name: m.name,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
    }));

    return {
      content: [{ type: "text", text: `Available models (${models.length}):\n\n${lines.join("\n")}` }],
      structuredContent: { count: models.length, models: structuredModels },
    };
  }
);

// blockrun_image - Generate images
server.registerTool(
  "blockrun_image",
  {
    description: `Generate images using AI models. Supports DALL-E 3, Flux, and Nano Banana.

Models:
- openai/dall-e-3: High quality, creative ($0.04-0.08/image)
- together/flux-schnell: Fast generation ($0.02/image)
- google/nano-banana: Experimental Google model`,
    inputSchema: {
      prompt: z.string().describe("Description of the image to generate"),
      model: z.enum(["openai/dall-e-3", "together/flux-schnell", "google/nano-banana"]).optional().default("openai/dall-e-3").describe("Image model"),
      size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).optional().default("1024x1024").describe("Image size"),
      quality: z.enum(["standard", "hd"]).optional().default("standard").describe("Quality level for DALL-E 3"),
    },
    outputSchema: {
      url: z.string().describe("URL of the generated image"),
      prompt: z.string().describe("The prompt used"),
      model: z.string().describe("The model used"),
    },
  },
  async ({ prompt, model, size, quality }) => {
    const apiUrl = "https://blockrun.ai/api/v1/images/generations";

    const body = {
      model,
      prompt,
      size,
      quality,
      n: 1,
    };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return {
        content: [{ type: "text", text: `Image generation requires payment. Please ensure your wallet has USDC on Base.\n\nTo generate "${prompt}" with ${model}, the approximate cost is $0.04-0.08 per image.` }],
        isError: true,
      };
    }

    if (!response.ok) {
      return {
        content: [{ type: "text", text: formatError(`Image generation failed: ${response.status}`) }],
        isError: true,
      };
    }

    const data = await response.json() as { data?: Array<{ url?: string }> };
    const imageUrl = data.data?.[0]?.url;

    if (!imageUrl) {
      return {
        content: [{ type: "text", text: formatError("No image URL in response") }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `Image generated successfully!\n\nURL: ${imageUrl}\n\nPrompt: ${prompt}\nModel: ${model}` }],
      structuredContent: { url: imageUrl, prompt, model: model! },
    };
  }
);

// blockrun_wallet - Get wallet info
server.registerTool(
  "blockrun_wallet",
  {
    description: "Get information about your BlockRun wallet address. Shows address, network, and quick funding options.",
    inputSchema: {},
    outputSchema: {
      address: z.string().describe("Wallet address"),
      network: z.string().describe("Network name"),
      chainId: z.number().describe("Chain ID"),
      currency: z.string().describe("Currency"),
      isNew: z.boolean().describe("Whether this is a newly created wallet"),
      basescanUrl: z.string().describe("Link to view on Basescan"),
    },
  },
  async () => {
    const info = getWalletInfo();
    const isNewWallet = info.isNew;

    let text = `BlockRun Wallet Information
============================

Address: ${info.address}
Network: ${info.network} (Chain ID: ${info.chainId})
Currency: ${info.currency}

View on Basescan: ${info.basescanUrl}
`;

    if (isNewWallet) {
      text += `\nSTATUS: NEW WALLET - NEEDS FUNDING\n${getWalletSetupInstructions()}`;
    } else {
      text += `
HOW TO ADD FUNDS:
-----------------
Send USDC to the address above on Base network.

Quick options:
1. From Coinbase: ${info.fundingOptions.coinbase}
2. Bridge: ${info.fundingOptions.bridge}
3. Buy: ${info.fundingOptions.buy}

Full instructions: Run blockrun_setup tool
`;
    }

    return {
      content: [{ type: "text", text }],
      structuredContent: {
        address: info.address,
        network: info.network,
        chainId: info.chainId,
        currency: info.currency,
        isNew: info.isNew,
        basescanUrl: info.basescanUrl,
      },
    };
  }
);

// blockrun_setup - Detailed setup instructions
server.registerTool(
  "blockrun_setup",
  {
    description: `Get detailed wallet setup and funding instructions. Use this for first-time setup or if you need help adding funds to your wallet.

Returns:
- Your wallet address
- Step-by-step funding instructions (Coinbase, bridge, direct purchase)
- Pricing information
- Security details`,
    inputSchema: {},
  },
  async () => {
    getClient(); // Initialize wallet
    return { content: [{ type: "text", text: getWalletSetupInstructions() }] };
  }
);

// ============================================================================
// RESOURCES
// ============================================================================

// Wallet resource - read wallet info as structured data
server.registerResource(
  "wallet",
  "blockrun://wallet",
  {
    description: "Your BlockRun wallet address and status",
    mimeType: "application/json",
  },
  async () => {
    const info = getWalletInfo();
    return {
      contents: [{
        uri: "blockrun://wallet",
        mimeType: "application/json",
        text: JSON.stringify(info, null, 2),
      }],
    };
  }
);

// Models resource - list all available models
server.registerResource(
  "models",
  "blockrun://models",
  {
    description: "List of all available AI models with pricing",
    mimeType: "application/json",
  },
  async () => {
    const llm = getClient();
    if (!cachedModels) {
      cachedModels = await llm.listModels();
      setTimeout(() => { cachedModels = null; }, 5 * 60 * 1000);
    }
    return {
      contents: [{
        uri: "blockrun://models",
        mimeType: "application/json",
        text: JSON.stringify(cachedModels, null, 2),
      }],
    };
  }
);

// ============================================================================
// PROMPTS
// ============================================================================

// Quick chat prompt
server.registerPrompt(
  "quick_chat",
  {
    description: "Start a quick chat with a recommended model",
    argsSchema: {
      message: z.string().describe("Your message"),
      style: z.enum(["concise", "detailed", "creative"]).optional().default("concise").describe("Response style"),
    },
  },
  async ({ message, style }) => {
    const systemPrompts: Record<string, string> = {
      concise: "Be concise and direct. Give short, focused answers.",
      detailed: "Provide thorough, comprehensive answers with examples.",
      creative: "Be creative and imaginative in your responses.",
    };
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `[System: ${systemPrompts[style || "concise"]}]\n\n${message}`,
          },
        },
      ],
    };
  }
);

// Code review prompt
server.registerPrompt(
  "code_review",
  {
    description: "Get a code review from a powerful model",
    argsSchema: {
      code: z.string().describe("The code to review"),
      language: z.string().optional().describe("Programming language"),
      focus: z.enum(["bugs", "performance", "style", "all"]).optional().default("all").describe("What to focus on"),
    },
  },
  async ({ code, language, focus }) => {
    const focusInstructions: Record<string, string> = {
      bugs: "Focus on potential bugs, errors, and edge cases.",
      performance: "Focus on performance issues and optimization opportunities.",
      style: "Focus on code style, readability, and best practices.",
      all: "Review for bugs, performance, and style.",
    };
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please review this ${language || ""} code. ${focusInstructions[focus || "all"]}\n\n\`\`\`${language || ""}\n${code}\n\`\`\``,
          },
        },
      ],
    };
  }
);

// ============================================================================
// ERROR HANDLING
// ============================================================================

function formatError(message: string): string {
  const isPaymentError = message.toLowerCase().includes("payment") ||
    message.toLowerCase().includes("402") ||
    message.toLowerCase().includes("balance") ||
    message.toLowerCase().includes("insufficient");

  let errorText = `Error: ${message}`;

  if (isPaymentError) {
    errorText += `\n\n` +
      `This error usually means your wallet needs funding.\n` +
      `Run the blockrun_setup tool to get your wallet address and funding instructions.\n\n` +
      `Quick fix: Send USDC to your wallet on Base network.`;
  }

  return errorText;
}

// ============================================================================
// START SERVER
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BlockRun MCP Server started (v0.1.0)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
