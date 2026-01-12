# @blockrun/mcp

**Access 30+ AI models in Claude Code with zero API keys.**

One wallet. Pay-per-request. All major AI models.

```bash
claude mcp add blockrun npx @blockrun/mcp
```

## Why BlockRun MCP?

| Feature | Other Solutions | BlockRun MCP |
|---------|-----------------|--------------|
| **API Keys** | Need 5+ keys (OpenAI, Anthropic, Google...) | **None needed** |
| **Billing** | Manage 5+ subscriptions | **One wallet, unified balance** |
| **Setup** | Complex config per provider | **One command, auto-wallet** |
| **Models** | Usually 1 provider | **30+ models, 6 providers** |
| **Payment** | Monthly subscriptions | **Pay only what you use** |
| **Minimum** | $20-100/month per provider | **$0 minimum, start with $5** |

## Quick Start

### 1. Install (30 seconds)

```bash
# Add to Claude Code
claude mcp add blockrun npx @blockrun/mcp
```

That's it! A wallet is automatically created for you.

### 2. Get Your Wallet Address

In Claude Code, run:
```
Use blockrun_setup to get my wallet address
```

Or:
```
Use blockrun_wallet to show my wallet info
```

### 3. Fund Your Wallet

Send USDC to your wallet address on **Base** network. Even $5 gets you hundreds of requests.

**Funding Options:**

| Method | Steps |
|--------|-------|
| **From Coinbase** | Send → USDC → Select "Base" network → Paste your address |
| **Bridge** | Visit [bridge.base.org](https://bridge.base.org) → Bridge USDC to Base |
| **Buy Direct** | Visit [Coinbase Onramp](https://www.coinbase.com/onramp) → Buy USDC on Base |

### 4. Start Using

```
You: Use blockrun_chat to ask claude-sonnet-4 what is quantum computing

Claude: [calls blockrun_chat]
        Quantum computing is a type of computation that harnesses...
```

## Available Tools

### `blockrun_chat`
Chat with any AI model.

```javascript
blockrun_chat({
  model: "anthropic/claude-sonnet-4",  // Required
  message: "Explain quantum computing", // Required
  system: "You are a physics professor", // Optional
  max_tokens: 2000,                      // Optional (default: 1024)
  temperature: 0.7                       // Optional (default: 1)
})
```

**Popular Models:**
- `openai/gpt-5.2` - Most capable OpenAI model
- `anthropic/claude-opus-4` - Best for complex reasoning
- `anthropic/claude-sonnet-4` - Fast & capable (recommended)
- `google/gemini-2.5-pro` - Great for long context (1M tokens)
- `deepseek/deepseek-chat` - Very affordable

### `blockrun_smart`
Auto-select the best model for your needs.

```javascript
blockrun_smart({
  mode: "balanced",  // Required: fast | balanced | powerful | cheap | reasoning
  message: "Hello!"  // Required
})
```

| Mode | Models Used | Best For | Cost |
|------|-------------|----------|------|
| `fast` | Gemini Flash, GPT-4o-mini | Quick responses | $ |
| `balanced` | GPT-4o, Claude Sonnet | Daily tasks | $$ |
| `powerful` | GPT-5.2, Claude Opus, o3 | Complex work | $$$$ |
| `cheap` | Gemini Flash, DeepSeek | Budget-conscious | $ |
| `reasoning` | o3, o1, DeepSeek Reasoner | Logic & math | $$$ |

### `blockrun_models`
List all available models with pricing.

```javascript
blockrun_models({
  category: "chat",    // Optional: all, chat, reasoning, image, embedding
  provider: "openai"   // Optional: filter by provider
})
```

### `blockrun_image`
Generate images with AI.

```javascript
blockrun_image({
  prompt: "A sunset over mountains",  // Required
  model: "openai/dall-e-3",           // Optional
  size: "1024x1024",                  // Optional: 1024x1024, 1792x1024, 1024x1792
  quality: "hd"                       // Optional: standard, hd
})
```

### `blockrun_wallet`
Check your wallet information.

```javascript
blockrun_wallet({})
// Returns: address, network, balance link, funding options
```

### `blockrun_setup`
Get detailed setup and funding instructions.

```javascript
blockrun_setup({})
// Returns: complete setup guide with step-by-step funding instructions
```

## Supported Models & Pricing

### Chat Models

| Provider | Models | Input Price | Output Price |
|----------|--------|-------------|--------------|
| **OpenAI** | GPT-5.2, GPT-5-mini, GPT-4o, o3, o1 | $0.15 - $21/M | $0.60 - $84/M |
| **Anthropic** | Claude Opus 4, Sonnet 4, Haiku | $0.25 - $15/M | $1.25 - $75/M |
| **Google** | Gemini 3 Pro, 2.5 Pro/Flash | Free - $2.50/M | Free - $15/M |
| **DeepSeek** | V3.2, Reasoner | $0.14 - $0.55/M | $0.28 - $2.19/M |
| **xAI** | Grok 3, Grok 3 Mini | $3 - $5/M | $15 - $25/M |

*M = million tokens. Prices in USD.*

### Image Models

| Model | Price per Image |
|-------|-----------------|
| DALL-E 3 (Standard) | $0.04 |
| DALL-E 3 (HD) | $0.08 |
| Flux Schnell | $0.02 |

### Cost Examples

| Task | Model | Approx. Cost |
|------|-------|--------------|
| Quick question | Gemini Flash | $0.0001 |
| Code review | Claude Sonnet | $0.003 |
| Complex analysis | GPT-4o | $0.005 |
| Long document | Claude Opus | $0.02 |
| Image generation | DALL-E 3 | $0.04 |

**$5 gets you approximately:**
- 50,000 Gemini Flash requests, OR
- 1,600 Claude Sonnet requests, OR
- 1,000 GPT-4o requests, OR
- 125 DALL-E 3 images

## Wallet Management

### Auto-Generated Wallet

When you first use BlockRun MCP, a wallet is automatically created and saved to:
```
~/.blockrun/wallet.key
```

This wallet is:
- Created locally on your machine
- Never transmitted to any server
- Used only for signing payment authorizations
- Persistent across sessions

### Using Your Own Wallet

If you prefer to use an existing wallet:

```bash
# Option 1: Environment variable
export BLOCKRUN_WALLET_KEY=0x...

# Option 2: Add with Claude Code
claude mcp add blockrun npx @blockrun/mcp --env BLOCKRUN_WALLET_KEY=0x...
```

### Wallet Priority

1. Environment variable `BLOCKRUN_WALLET_KEY`
2. Environment variable `BASE_CHAIN_WALLET_KEY`
3. File at `~/.blockrun/wallet.key`
4. Auto-generate new wallet (saved to file)

## How Payment Works

```
┌─────────────────────────────────────────────────────────────┐
│  1. You send a request (e.g., chat with GPT-5)              │
│                          ↓                                  │
│  2. BlockRun calculates cost based on tokens                │
│                          ↓                                  │
│  3. Your wallet signs a payment authorization LOCALLY       │
│     (private key NEVER leaves your machine)                 │
│                          ↓                                  │
│  4. Payment settles on Base network via USDC                │
│                          ↓                                  │
│  5. You receive your AI response                            │
└─────────────────────────────────────────────────────────────┘
```

**Security Guarantees:**
- Private key is used ONLY for local signing
- Key is NEVER transmitted to any server
- Same security model as MetaMask transactions
- You can verify all transactions on [Basescan](https://basescan.org)

## Comparison with Alternatives

### vs claude-code-proxy
| | claude-code-proxy | BlockRun MCP |
|---|---|---|
| API Keys | Required (bring your own) | **Not needed** |
| Setup | Configure each provider | **One command** |
| Billing | Multiple subscriptions | **Unified wallet** |

### vs gemini-mcp
| | gemini-mcp | BlockRun MCP |
|---|---|---|
| Models | Gemini only | **30+ models, 6 providers** |
| API Key | Required | **Not needed** |
| Payment | Google billing | **Pay-per-use crypto** |

### vs Direct API Keys
| | Direct APIs | BlockRun MCP |
|---|---|---|
| Accounts | 5+ accounts needed | **One wallet** |
| Minimums | $20-100/mo per provider | **$0 minimum** |
| Management | Complex | **Simple** |

## Troubleshooting

### "Payment was rejected"
Your wallet needs funding. Run `blockrun_setup` to get your address and funding instructions.

### "Wallet key required"
The MCP couldn't find or create a wallet. Check that `~/.blockrun/` directory is writable.

### Model not responding
Some models have rate limits. Try `blockrun_smart` with mode `fast` or `cheap` to use alternative models.

### Check wallet balance
Visit: `https://basescan.org/address/YOUR_ADDRESS`

## Configuration

### Claude Code Setup

```bash
# Basic (recommended)
claude mcp add blockrun npx @blockrun/mcp

# With explicit wallet
claude mcp add blockrun npx @blockrun/mcp --env BLOCKRUN_WALLET_KEY=0x...

# Project-specific
claude mcp add blockrun --scope project npx @blockrun/mcp

# User-wide (all projects)
claude mcp add blockrun --scope user npx @blockrun/mcp
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BLOCKRUN_WALLET_KEY` | Your wallet private key (hex, starts with 0x) |
| `BASE_CHAIN_WALLET_KEY` | Alternative name for wallet key |

## Development

```bash
# Clone
git clone https://github.com/blockrunai/blockrun-mcp
cd blockrun-mcp

# Install dependencies
npm install

# Development mode (auto-reload)
npm run dev

# Build for production
npm run build

# Test locally
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js
```

## Links

- **Website:** [blockrun.ai](https://blockrun.ai)
- **Documentation:** [docs.blockrun.ai](https://docs.blockrun.ai)
- **Pricing:** [blockrun.ai/pricing](https://blockrun.ai/pricing)
- **GitHub:** [github.com/blockrunai](https://github.com/blockrunai)
- **Twitter:** [@blockaborama](https://twitter.com/blockaborama)

## Support

- **Issues:** [GitHub Issues](https://github.com/blockrunai/blockrun-mcp/issues)
- **Discord:** [Join our Discord](https://discord.gg/blockrun)
- **Email:** hello@blockrun.ai

## License

MIT
