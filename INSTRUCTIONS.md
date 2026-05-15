# LLM Smart Proxy — Setup Instructions for AI Agents

These instructions are for LLMs (Claude, GPT, Gemini, etc.) to automatically set up the proxy.

## Quick Setup (1 command)

```bash
cd llm-proxy-docker && chmod +x setup.sh && ./setup.sh
```

## Manual Setup (step by step)

### 1. Copy environment file

```bash
cp .env.example .env
```

### 2. Add API keys (optional — 14 models work without any keys)

Edit `.env` and add keys for providers you want. Free keys available at:

| Provider | Get free key at |
|----------|----------------|
| Groq | https://console.groq.com |
| Gemini | https://aistudio.google.com |
| OpenRouter | https://openrouter.ai/keys |
| SambaNova | https://cloud.sambanova.ai |
| Cerebras | https://cloud.cerebras.ai |
| NVIDIA | https://build.nvidia.com |
| Alibaba | https://dashscope.console.aliyun.com |
| Mistral | https://console.mistral.ai |
| DeepSeek | https://platform.deepseek.com |
| SiliconFlow | https://cloud.siliconflow.cn |
| Cloudflare | https://dash.cloudflare.com |
| BigModel | https://open.bigmodel.cn |

No keys needed for: **Kilo** (anonymous), **OVH**, **LLM7**

### 3. Start

```bash
docker compose up -d --build
```

### 4. Verify

```bash
# Health check
curl http://localhost:18900/health

# List models
curl http://localhost:18900/v1/models

# Test chat
curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto-free","messages":[{"role":"user","content":"Hello"}]}'
```

## Connect to IDEs and Agents

### Claude Code

Add to Claude Code settings or use as MCP:

```bash
# As OpenAI-compatible provider
# Base URL: http://localhost:18900/v1
# API Key: proxy (any string)
# Model: auto-free
```

### DeerFlow

In `config.yaml` models section:

```yaml
- name: auto-thinking
  use: langchain_openai:ChatOpenAI
  model: auto-thinking
  api_key: "proxy"
  base_url: http://HOST:18900/v1
```

Run model sync:

```bash
node sync-proxy-models.js  # generates DeerFlow config from proxy
```

### Any OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:18900/v1", api_key="proxy")
r = client.chat.completions.create(model="auto-coding", messages=[{"role":"user","content":"hi"}])
```

## Install Recommended Tools

### MemPalace (persistent AI memory)

```bash
# Install package + MCP + skill + hooks
pip install mempalace
mempalace init .
claude mcp add mempalace -- python -m mempalace.mcp_server
claude plugin add mempalace

# For DeerFlow/other agents — add MCP config:
# command: python3 -m mempalace.mcp_server
# env: MEMPALACE_DIR=/path/to/palace

# Verify
mempalace status
```

### RTK (token savings 60-90%)

```bash
# macOS
brew install rtk-ai/tap/rtk

# Linux/macOS
curl -fsSL https://rtk-ai.app/install.sh | sh

# Or cargo
cargo install rtk

# Setup Claude Code hook (auto-rewrites bash commands)
rtk init --global
# Restart Claude Code after init
```

### Caveman Mode (terse responses ~75% fewer tokens)

```bash
# Install skill in Claude Code
claude install-skill caveman https://github.com/anthropics/claude-code-skills

# Activate per session
/caveman full

# For other agents: add to system prompt:
# "Respond terse. Drop articles/filler. Fragments OK. Technical terms exact."
```

### Superpowers (advanced agent capabilities)

```bash
# Install skill in Claude Code
claude install-skill superpowers https://github.com/anthropics/claude-code-skills

# Activate per session
/superpowers

# Key sub-skills: brainstorming, test-driven, dispatching, verification
```

### Autonomous Loop (never-stop execution)

```bash
# Claude Code — copy to project
cp -r skills/autonomous-loop/ .claude/skills/

# Or add to CLAUDE.md
echo 'Read and follow skills/autonomous-loop/SKILL.md' >> CLAUDE.md

# DeerFlow — copy to skills
cp -r skills/autonomous-loop/ /path/to/deer-flow/skills/custom/
```

Core rules:
- Execute all tasks without stopping or asking
- Save progress to MemPalace during work
- Resume with "continua" — reads MemPalace, continues from saved state
- On error: try alternative, continue. Never stop for one failure.
- Long context: save to MemPalace, summarize, continue

## Architecture

```
seed-providers.json (source of truth)
        |
        v
[Discovery Daemon] --scan /models endpoints every 6h--> test models
        |
        v
/data/providers.json (merged: seed + discovered)
        |
        v
[LLM Proxy :18900] --fs.watch--> hot-reload on change
        |
        +-- /v1/chat/completions  --> group routing + failover
        +-- /v1/models            --> list all (filterable by ?cap=X)
        +-- /v1/capabilities      --> capability counts
        +-- /health               --> system status
        +-- /scores               --> provider scoring
        +-- /discovery            --> scan results
```

## Troubleshooting

**"Provider returned error"**: Proxy tries next provider automatically. If ALL fail, check `/health` for cooldowns.

**No models in `/v1/models`**: Run discovery first: `node llm-discovery.js` or wait for cron (6h).

**Rate limited (429)**: Per-provider 1s cooldown. Proxy auto-routes to next. Add more provider keys for more capacity.

**Thinking not detected**: Some models return reasoning internally. Check `/health` for `thinking_ok` counts.
