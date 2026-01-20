# awesome-mcp-servers PR

## Target Repo
https://github.com/punkpeye/awesome-mcp-servers (79K+ stars)

## Entry to Add

Add to the **"AI Model Access"** or **"LLM Integration"** section:

```markdown
- [blockrun-mcp](https://github.com/blockrunai/blockrun-mcp) 📇 ☁️ - Access 30+ AI models (GPT-5, Claude, Gemini, Grok) without API keys via x402 micropayments
```

## PR Title
```
Add BlockRun MCP - Access 30+ AI models without API keys
```

## PR Description
```markdown
## What is BlockRun MCP?

An MCP server that gives Claude Code access to 30+ AI models from OpenAI, Anthropic, Google, xAI, and DeepSeek - without requiring any API keys.

**Key Features:**
- Zero API keys - No accounts needed with providers
- Pay-per-use - USDC micropayments via x402 protocol
- 30+ models - GPT-5, Claude Opus, Gemini Pro, Grok 3, DeepSeek
- Image generation - DALL-E 3, Flux
- Real-time Twitter/X search via Grok

**Install:**
```bash
claude mcp add blockrun npx @blockrun/mcp
```

**Links:**
- npm: https://www.npmjs.com/package/@blockrun/mcp
- Website: https://blockrun.ai
```

## Steps to Submit

1. Fork https://github.com/punkpeye/awesome-mcp-servers
2. Edit README.md, add entry in appropriate section
3. Create PR with title and description above
4. Wait for review

## Command to Fork & Edit

```bash
gh repo fork punkpeye/awesome-mcp-servers --clone
cd awesome-mcp-servers
# Edit README.md
git add README.md
git commit -m "Add BlockRun MCP - Access 30+ AI models without API keys"
git push origin main
gh pr create --title "Add BlockRun MCP - Access 30+ AI models without API keys" --body-file pr-body.md
```
