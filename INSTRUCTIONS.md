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
| SiliconFlow | https://cloud.siliconflow.com |
| Cohere | https://dashboard.cohere.com |
| Hugging Face | https://huggingface.co/settings/tokens |
| Ollama Cloud | https://ollama.com |
| Cloudflare | https://dash.cloudflare.com (also need Account ID) |
| BigModel | https://open.bigmodel.cn |
| Cline | https://app.cline.bot (28 free models, 356 total) |

No keys needed for: **Kilo** (anonymous), **OVH**, **LLM7**

### 2b. Enable local gateway proxies (optional — free premium models)

Set `ENABLE_X=true` in `.env` to activate gateway proxies. Each runs as a Docker container and needs a one-time auth:

| Gateway | Enable flag | Auth command | What you get |
|---------|-------------|-------------|--------------|
| **Kiro** | `ENABLE_KIRO=true` | `node kiro-auth.js` | Free Claude Sonnet 4, Haiku 4.5 |
| **Codex** | `ENABLE_CODEX=true` | `npx @openai/codex login` + copy auth.json | GPT-5.4/5.5, o3, o4-mini (ChatGPT sub) |

Auth scripts open a browser URL for login — no manual cookie/token extraction needed.
`setup.sh` runs auth automatically when tokens are missing.

Discovery daemon scans gateway `/v1/models` every 6h — new models auto-provisioned.

### 3. Start

```bash
# Without gateway proxies:
docker compose up -d --build

# With gateway proxies (reads ENABLE_X from .env):
./setup.sh
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
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

## Connect to IDEs and Agents

### Claude Code

Add to Claude Code settings or use as MCP:

```bash
# As OpenAI-compatible provider
# Base URL: http://localhost:18900/v1
# API Key: proxy (any string)
# Model: auto
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

### MemPalace (persistent AI memory — built into proxy)

MemPalace runs as a Docker service alongside the proxy. It auto-saves and auto-recalls context, so LLMs never lose work.

**Built-in features (automatic, no config needed):**
- Auto-saves session progress, task state, architecture decisions, error resolutions, user preferences
- Auto-recalls relevant memories and injects into system prompt on each request
- Resumes context on "continue" — loads last task state and session progress
- Smart context compaction — when context exceeds 80% of provider limit, saves middle to MemPalace and compacts
- Recovery — compacted context recoverable via MemPalace recall

**How it works:**
1. Proxy tracks sessions by system prompt hash (each IDE/project = separate session)
2. On each request, searches MemPalace for relevant memories (project status, preferences, past errors)
3. Injects up to 2000 tokens of memory into system prompt before routing
4. After response, saves task progress, architecture decisions, and corrections
5. When context gets large (>80% of best provider), proactively compacts to 60%
6. If all providers reject for context size, compacts + retries before returning error to IDE

**Direct MCP access (optional — for local IDE integration too):**

```bash
# MemPalace MCP server available at port 8891
# IDE agents can connect directly for manual memory operations
# Add to your MCP config:
{
  "url": "http://YOUR_SERVER:8891/sse"
}
```

**Standalone install (for local dev without proxy):**

```bash
pip install mempalace
mempalace init .
claude mcp add mempalace -- python -m mempalace.mcp_server
claude plugin add mempalace
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

### Autonomous Execution (built into proxy — no install needed)

The proxy automatically injects execution rules into every request:
- UNDERSTAND → PLAN → CONFIRM → EXECUTE → VERIFY → SAVE cycle
- MemPalace auto-save/recall, context compaction, resume on "continue"
- Decision making: discover tech → recall preferences → confirm once → build
- Anti-stalling, violation detection, smart IDE prompt merging

Full reference: `skills/autonomous-loop/SKILL.md`

## Architecture

```
seed-providers.json (source of truth)
        |
        v
[Discovery Daemon] --scan /models endpoints every 6h--> test models
        |                (includes API providers + local gateways)
        |                (auto-provisions new models with heuristic scoring)
        v
/data/providers.json (merged: seed + discovered)
        |
        v
[LLM Proxy :18900] --fs.watch--> hot-reload on change
        |
        +-- /v1/chat/completions  --> group routing + failover
        |       |
        |       +-- recall memories from MemPalace (inject into system prompt)
        |       +-- detect context size → proactive compaction if >80%
        |       +-- auto-learn compat (strip stream_options, tool_choice, content arrays, cap max_tokens)
        |       +-- route to best provider (context-aware, agent-aware, benchmark-scored)
        |       +-- save session/tasks/errors/preferences to MemPalace (async)
        |
        +-- /v1/models            --> list all (filterable by ?cap=X)
        +-- /v1/capabilities      --> capability counts
        +-- /health               --> system status + mempalace status
        +-- /scores               --> provider scoring
        +-- /discovery            --> scan results

[Gateway Proxies (optional, Docker profiles)]
        +-- Kiro Gateway :10088   --> Claude Sonnet 4, Haiku 4.5 (free AWS Builder ID)
        +-- Codex Proxy :10531    --> GPT-5.4/5.5, o3, o4-mini (ChatGPT subscription)

[MemPalace MCP :8891] <-- persistent memory (sessions, tasks, preferences, errors)
        |
        +-- auto-save: session summaries, task progress, architecture, corrections
        +-- auto-recall: project context, task resume, error fixes, preferences
        +-- context compaction: save middle → compact → recover on "continue"
```

## Troubleshooting

**"Provider returned error"**: Proxy tries next provider automatically. If ALL fail, check `/health` for cooldowns.

**No models in `/v1/models`**: Run discovery first: `node llm-discovery.js` or wait for cron (6h).

**Rate limited (429)**: Per-provider 1s cooldown. Proxy auto-routes to next. Add more provider keys for more capacity.

**Thinking not detected**: Some models return reasoning internally. Check `/health` for `thinking_ok` counts.
