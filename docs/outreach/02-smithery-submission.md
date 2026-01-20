# Smithery.ai Submission

## How to Submit

Smithery auto-discovers MCP servers from GitHub. To get listed:

1. **Ensure your repo has a `smithery.yaml`** in the root
2. **Add the `mcp-server` topic** to your GitHub repo
3. Smithery will auto-index within 24-48 hours

## smithery.yaml

Create this file in the repo root:

```yaml
# smithery.yaml
name: BlockRun MCP
description: Access 30+ AI models (GPT-5, Claude, Gemini, Grok) without API keys. Pay-per-use via x402 micropayments on Base.
version: 0.4.1
author: BlockRun
homepage: https://blockrun.ai
repository: https://github.com/blockrunai/blockrun-mcp
license: MIT

# Installation
install:
  npx: "@blockrun/mcp"

# Categories
categories:
  - ai
  - llm
  - payments
  - crypto

# Keywords for search
keywords:
  - gpt-5
  - claude
  - gemini
  - grok
  - deepseek
  - openai
  - anthropic
  - google
  - x402
  - usdc
  - micropayments
  - no-api-key

# Tools provided
tools:
  - name: blockrun_chat
    description: Chat with any AI model
  - name: blockrun_smart
    description: Auto-select best model for task
  - name: blockrun_image
    description: Generate images with DALL-E 3 or Flux
  - name: blockrun_twitter
    description: Real-time X/Twitter search via Grok
  - name: blockrun_models
    description: List available models with pricing
  - name: blockrun_balance
    description: Check USDC wallet balance
  - name: blockrun_wallet
    description: Get wallet address
  - name: blockrun_setup
    description: Setup and funding instructions
  - name: blockrun_budget
    description: Manage session spending limits
```

## Add GitHub Topic

```bash
gh repo edit blockrunai/blockrun-mcp --add-topic mcp-server --add-topic mcp --add-topic ai --add-topic llm
```

## Manual Submission (if auto-discovery fails)

Visit https://smithery.ai/submit and paste:
- GitHub URL: https://github.com/blockrunai/blockrun-mcp
- npm package: @blockrun/mcp
