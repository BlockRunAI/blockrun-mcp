# Hacker News Launch

## Post Type
Show HN (for launching new projects)

## Title Options (pick one)

**Option A (Problem-focused):**
```
Show HN: Use GPT-5, Gemini, Grok in Claude Code without managing API keys
```

**Option B (Solution-focused):**
```
Show HN: BlockRun MCP – One wallet for 30+ AI models, no API keys
```

**Option C (Technical):**
```
Show HN: x402 micropayments for AI – access any model without API keys
```

## Post URL
```
https://github.com/blockrunai/blockrun-mcp
```

## First Comment (post immediately after submitting)

```
Hi HN, I built BlockRun MCP because I was frustrated managing 5+ API keys and billing accounts just to use different AI models in Claude Code.

The problem:
- Want to use GPT-5 for one task, Claude for another, Gemini for long context
- Each provider needs: account signup, API key, separate billing, $20-100/mo minimum
- That's too much friction for exploration

The solution:
- One command: `claude mcp add blockrun npx @blockrun/mcp`
- Auto-generated crypto wallet (like MetaMask, but automatic)
- Pay per request with USDC on Base network
- $5 gets you ~1000+ requests across all models

How it works:
1. Install the MCP server
2. Fund your wallet with USDC on Base (from Coinbase, etc.)
3. Use naturally: "ask GPT-5 about X" or "generate an image of Y"

Under the hood, it uses x402 - an HTTP payment protocol where APIs return 402 Payment Required, your wallet signs the payment locally, and the request completes. Your private key never leaves your machine.

Available models: GPT-5.2, Claude Opus 4, Gemini 2.5 Pro, Grok 3, DeepSeek V3, DALL-E 3, Flux, and more.

Would love feedback! Especially on:
- Is the value prop clear?
- Would you use this?
- What models/features would you want?

GitHub: https://github.com/blockrunai/blockrun-mcp
npm: https://npmjs.com/package/@blockrun/mcp
```

## Best Time to Post
- Tuesday-Thursday
- 8-10 AM EST (when HN traffic peaks)
- Avoid weekends

## Tips
1. Respond to every comment quickly (first 2-3 hours are critical)
2. Be honest about limitations
3. Don't be defensive about criticism
4. Upvote with your account right after posting
