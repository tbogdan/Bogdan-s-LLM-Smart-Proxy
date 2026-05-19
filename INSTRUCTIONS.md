# LLM Smart Proxy — Setup Instructions

## Quick Setup

```bash
cp .env.example .env   # add API keys
docker compose up -d   # runs at http://localhost:18900
```

Or with auto-setup: `chmod +x setup.sh && ./setup.sh`

## Add API Keys

Edit `.env`. 14 models work without keys (Kilo, OVH, LLM7). Add more:

| Provider | Free key |
|----------|----------|
| Groq | https://console.groq.com |
| Gemini | https://aistudio.google.com |
| OpenRouter | https://openrouter.ai/keys |
| SambaNova | https://cloud.sambanova.ai |
| NVIDIA | https://build.nvidia.com |
| Cerebras | https://cloud.cerebras.ai |

Full list in `.env.example`.

## Gateway Proxies (optional)

| Gateway | Enable | Auth | Models |
|---------|--------|------|--------|
| Kiro | `ENABLE_KIRO=true` | `node kiro-auth.js` | Claude Sonnet 4, Haiku 4.5 |
| Codex | `ENABLE_CODEX=true` | `npx @openai/codex login` | GPT-5.5/5.4/5.3/5.2 |

## Verify

```bash
curl http://localhost:18900/health
curl http://localhost:18900/v1/models
curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

## Connect IDEs

Base URL: `http://HOST:18900/v1`, API key: `proxy`, model: `auto-coding`.

**Codex CLI** (`~/.codex/config.toml`):

```toml
model = "auto-coding"
openai_base_url = "http://HOST:18900/v1"
experimental_realtime_ws_base_url = "ws://HOST:18900/v1"
```

## Optional Tools

```bash
# MemPalace — persistent AI memory (runs as Docker service on :8891)
pip install mempalace && mempalace init .

# RTK — token compression (60-90% savings)
brew install rtk-ai/tap/rtk && rtk init --global

# Caveman — terse responses
claude install-skill caveman https://github.com/anthropics/claude-code-skills

# Superpowers — advanced agent workflows
claude install-skill superpowers https://github.com/anthropics/claude-code-skills
```

## Troubleshooting

- **All providers fail**: check `curl http://HOST:18900/banned`
- **No models**: run `node llm-discovery.js` or wait 6h auto-scan
- **Rate limited**: auto-routes to next provider. Add more keys for capacity.
