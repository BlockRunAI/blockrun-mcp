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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
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

// Tool definitions
const tools: Tool[] = [
  {
    name: "blockrun_chat",
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
      type: "object" as const,
      properties: {
        model: {
          type: "string",
          description: "Model ID (e.g., 'anthropic/claude-sonnet-4', 'openai/gpt-4o'). Use blockrun_models to list all.",
        },
        message: {
          type: "string",
          description: "Your message to the AI",
        },
        system: {
          type: "string",
          description: "Optional system prompt to set context/behavior",
        },
        max_tokens: {
          type: "number",
          description: "Maximum tokens in response (default: 1024)",
        },
        temperature: {
          type: "number",
          description: "Creativity level 0-2 (default: 1)",
        },
      },
      required: ["model", "message"],
    },
  },
  {
    name: "blockrun_smart",
    description: `Smart model routing - automatically picks the best model based on your needs.

Modes:
- fast: Quickest response (Gemini Flash, GPT-4o-mini)
- balanced: Good quality & speed (GPT-4o, Claude Sonnet)
- powerful: Best quality (GPT-5.2, Claude Opus 4, o3)
- cheap: Lowest cost (Gemini Flash, DeepSeek)
- reasoning: Complex logic (o3, o1, DeepSeek Reasoner)

Example: blockrun_smart({ mode: "fast", message: "Hello" })`,
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["fast", "balanced", "powerful", "cheap", "reasoning"],
          description: "Routing mode: fast, balanced, powerful, cheap, or reasoning",
        },
        message: {
          type: "string",
          description: "Your message to the AI",
        },
        system: {
          type: "string",
          description: "Optional system prompt",
        },
        max_tokens: {
          type: "number",
          description: "Maximum tokens in response (default: 1024)",
        },
      },
      required: ["mode", "message"],
    },
  },
  {
    name: "blockrun_models",
    description: "List all available AI models with pricing. Use this to discover models and compare costs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: ["all", "chat", "reasoning", "image", "embedding"],
          description: "Filter by category (default: all)",
        },
        provider: {
          type: "string",
          description: "Filter by provider (e.g., 'openai', 'anthropic', 'google')",
        },
      },
    },
  },
  {
    name: "blockrun_image",
    description: `Generate images using AI models. Supports DALL-E 3, Flux, and Nano Banana.

Models:
- openai/dall-e-3: High quality, creative ($0.04-0.08/image)
- together/flux-schnell: Fast generation ($0.02/image)
- google/nano-banana: Experimental Google model`,
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "Description of the image to generate",
        },
        model: {
          type: "string",
          description: "Image model (default: openai/dall-e-3)",
          enum: ["openai/dall-e-3", "together/flux-schnell", "google/nano-banana"],
        },
        size: {
          type: "string",
          description: "Image size (default: 1024x1024)",
          enum: ["1024x1024", "1792x1024", "1024x1792"],
        },
        quality: {
          type: "string",
          description: "Quality level for DALL-E 3 (default: standard)",
          enum: ["standard", "hd"],
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "blockrun_wallet",
    description: "Get information about your BlockRun wallet address. Shows address, network, and quick funding options.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "blockrun_setup",
    description: `Get detailed wallet setup and funding instructions. Use this for first-time setup or if you need help adding funds to your wallet.

Returns:
- Your wallet address
- Step-by-step funding instructions (Coinbase, bridge, direct purchase)
- Pricing information
- Security details`,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// Tool handlers
async function handleChat(args: {
  model: string;
  message: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
}): Promise<string> {
  const llm = getClient();

  const response = await llm.chat(args.model, args.message, {
    system: args.system,
    maxTokens: args.max_tokens,
    temperature: args.temperature,
  });

  return response;
}

async function handleSmartRoute(args: {
  mode: keyof typeof MODEL_TIERS;
  message: string;
  system?: string;
  max_tokens?: number;
}): Promise<string> {
  const models = MODEL_TIERS[args.mode];
  if (!models) {
    throw new Error(`Invalid mode: ${args.mode}. Use: fast, balanced, powerful, cheap, or reasoning`);
  }

  // Try models in order until one succeeds
  let lastError: Error | null = null;
  for (const model of models) {
    try {
      const response = await handleChat({
        model,
        message: args.message,
        system: args.system,
        max_tokens: args.max_tokens,
      });
      return `[Used: ${model}]\n\n${response}`;
    } catch (error) {
      lastError = error as Error;
      continue;
    }
  }

  throw lastError || new Error("All models failed");
}

async function handleListModels(args: {
  category?: string;
  provider?: string;
}): Promise<string> {
  const llm = getClient();

  // Cache models for 5 minutes
  if (!cachedModels) {
    cachedModels = await llm.listModels();
    setTimeout(() => { cachedModels = null; }, 5 * 60 * 1000);
  }

  let models = cachedModels;

  // Filter by provider
  if (args.provider) {
    const provider = args.provider.toLowerCase();
    models = models.filter(m => m.id.toLowerCase().startsWith(provider + "/"));
  }

  // Filter by category (infer from model id/provider)
  if (args.category && args.category !== "all") {
    const category = args.category.toLowerCase();
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
    // "chat" = default, show all non-image/embedding models
  }

  // Format output
  const lines = models.map(m => {
    const input = m.inputPrice ? `$${m.inputPrice}/M in` : "";
    const output = m.outputPrice ? `$${m.outputPrice}/M out` : "";
    const pricing = [input, output].filter(Boolean).join(", ");
    return `- ${m.id}: ${m.name || ""} ${pricing ? `(${pricing})` : ""}`;
  });

  return `Available models (${models.length}):\n\n${lines.join("\n")}`;
}

async function handleImageGeneration(args: {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
}): Promise<string> {
  const model = args.model || "openai/dall-e-3";
  const llm = getClient();

  // For image generation, we need to call the image endpoint
  // The SDK currently doesn't have a dedicated image method, so we'll use the API directly
  const apiUrl = "https://blockrun.ai/api/v1/images/generations";

  const body = {
    model,
    prompt: args.prompt,
    size: args.size || "1024x1024",
    quality: args.quality || "standard",
    n: 1,
  };

  // Use the chat method's payment handling by making a direct request
  // This is a simplified version - in production, you'd want to add proper payment handling
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 402) {
    // For now, return instructions - full implementation would handle payment
    return `Image generation requires payment. Please ensure your wallet has USDC on Base.\n\nTo generate "${args.prompt}" with ${model}, the approximate cost is $0.04-0.08 per image.`;
  }

  if (!response.ok) {
    throw new Error(`Image generation failed: ${response.status}`);
  }

  const data = await response.json() as { data?: Array<{ url?: string }> };
  const imageUrl = data.data?.[0]?.url;

  if (!imageUrl) {
    throw new Error("No image URL in response");
  }

  return `Image generated successfully!\n\nURL: ${imageUrl}\n\nPrompt: ${args.prompt}\nModel: ${model}`;
}

function handleWalletInfo(): string {
  const llm = getClient();
  const address = llm.getWalletAddress();

  const isNewWallet = walletWasCreated;

  let response = `BlockRun Wallet Information
============================

Address: ${address}
Network: Base (Chain ID: 8453)
Currency: USDC

View on Basescan: https://basescan.org/address/${address}
`;

  if (isNewWallet) {
    response += `
STATUS: NEW WALLET - NEEDS FUNDING
${getWalletSetupInstructions()}`;
  } else {
    response += `
HOW TO ADD FUNDS:
-----------------
Send USDC to the address above on Base network.

Quick options:
1. From Coinbase: Send USDC, select "Base" network
2. Bridge: https://bridge.base.org
3. Buy: https://www.coinbase.com/onramp

Full instructions: Run blockrun_setup tool
`;
  }

  return response;
}

function handleSetup(): string {
  getClient(); // Initialize wallet
  return getWalletSetupInstructions();
}

// Create and start the server
const server = new Server(
  {
    name: "blockrun-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "blockrun_chat":
        result = await handleChat(args as Parameters<typeof handleChat>[0]);
        break;
      case "blockrun_smart":
        result = await handleSmartRoute(args as Parameters<typeof handleSmartRoute>[0]);
        break;
      case "blockrun_models":
        result = await handleListModels(args as Parameters<typeof handleListModels>[0]);
        break;
      case "blockrun_image":
        result = await handleImageGeneration(args as Parameters<typeof handleImageGeneration>[0]);
        break;
      case "blockrun_wallet":
        result = handleWalletInfo();
        break;
      case "blockrun_setup":
        result = handleSetup();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Check if it's a payment-related error
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

    return {
      content: [{ type: "text", text: errorText }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BlockRun MCP Server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
