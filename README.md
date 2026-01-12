# @blockrun/mcp

## The Problem

Want to use GPT-5, Gemini, or DeepSeek in Claude Code? Today you need to:

1. Create accounts with 5+ AI providers
2. Manage 5+ API keys and billing systems
3. Pay $20-100/month minimums per provider
4. Configure each provider separately

**That's too much friction.**

## The Solution

BlockRun MCP gives you access to 30+ AI models with:

- **Zero API keys** - No accounts needed with OpenAI, Google, etc.
- **One wallet** - Single USDC balance for all providers
- **Pay-per-use** - No minimums, $5 gets you started
- **One command** - Install and go

```bash
claude mcp add blockrun npx @blockrun/mcp
```

> **Alternative:** Prefer Python? Try the [BlockRun Skill](https://github.com/BlockRunAI/claude-code-blockrun-agent) (`pip install blockrun-llm`) - same features, different integration style.

## Quick Start

### 1. Install

```bash
claude mcp add blockrun npx @blockrun/mcp
```

A wallet is automatically created for you.

### 2. Get Your Wallet Address

```
You: blockrun setup

Claude: Your wallet address is 0x...
        Send USDC on Base network to fund it.
```

### 3. Fund Your Wallet

Send USDC to your wallet address on **Base** network. Even $5 gets you hundreds of requests.

| Method | Steps |
|--------|-------|
| **From Coinbase** | Send → USDC → Select "Base" network → Paste your address |
| **Bridge** | [bridge.base.org](https://bridge.base.org) → Bridge USDC to Base |
| **Buy Direct** | [Coinbase Onramp](https://www.coinbase.com/onramp) → Buy USDC on Base |

### 4. Start Using

Just ask naturally:

```
You: blockrun ask GPT-5 to explain quantum computing

You: blockrun chat with Claude Opus about this error

You: blockrun generate an image of a mountain sunset
```

## Usage Examples

### Chat with Any Model

```
blockrun ask GPT-5 what causes aurora borealis

blockrun chat with Claude Opus about optimizing this algorithm

blockrun ask Gemini Pro to review this code for security issues
```

**Popular Models:**
- `openai/gpt-5.2` - Most capable OpenAI model
- `anthropic/claude-opus-4` - Best for complex reasoning
- `anthropic/claude-sonnet-4` - Fast & capable (recommended)
- `google/gemini-2.5-pro` - Great for long context (1M tokens)
- `deepseek/deepseek-chat` - Very affordable

### Smart Model Selection

Let BlockRun pick the best model for your needs:

```
blockrun smart fast: what's 2+2

blockrun smart powerful: analyze this complex codebase

blockrun smart cheap: summarize this text
```

| Mode | Models Used | Best For |
|------|-------------|----------|
| `fast` | Gemini Flash, GPT-4o-mini | Quick responses |
| `balanced` | GPT-4o, Claude Sonnet | Daily tasks |
| `powerful` | GPT-5.2, Claude Opus, o3 | Complex work |
| `cheap` | Gemini Flash, DeepSeek | Budget-conscious |
| `reasoning` | o3, o1, DeepSeek Reasoner | Logic & math |

### Generate Images

```
blockrun generate an image of a cyberpunk cityscape

blockrun create a watercolor painting of mountains
```

### List Available Models

```
blockrun list models

blockrun show OpenAI models with pricing
```

### Wallet Management

```
blockrun setup          # First-time setup instructions
blockrun wallet         # Check your wallet address
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
~/.blockrun/.session
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
3. File at `~/.blockrun/.session`
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
Your wallet needs funding. Say `blockrun setup` to get your address and funding instructions.

### "Wallet key required"
The MCP couldn't find or create a wallet. Check that `~/.blockrun/` directory is writable.

### Model not responding
Some models have rate limits. Try `blockrun smart cheap` or `blockrun smart fast` to use alternative models.

### Check wallet balance
Say `blockrun wallet` or visit: `https://basescan.org/address/YOUR_ADDRESS`

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
