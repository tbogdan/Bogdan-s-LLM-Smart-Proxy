# Bogdan's LLM Smart Proxy

A zero-dependency Node.js proxy that routes requests to 61 free LLM models across 19 providers with automatic failover, capability-based routing, and smart scoring.

## What It Does

- **61 free LLM models across 19 providers** with automatic failover on errors
- **Smart groups**: route by capability (`auto-coding`, `auto-thinking`, etc.) instead of picking a specific model
- **Auto-scoring**: tracks latency, success rate, and ranks providers dynamically
- **Capability detection**: tools, coding, images, video, thinking, context size
- **Thinking detection**: probes for `reasoning_content`, `<think>` tags, and `thinking` fields
- **Request transformation**: adds `enable_thinking` for Qwen3 models, passes `reasoning_effort`
- **Auto-discovery**: scans provider `/models` endpoints every 6h for new free models
- **Zero dependencies**: pure Node.js `http`/`https`, no npm install needed

## Quick Start

```bash
git clone https://github.com/tbogdan/Bogdan-s-LLM-Smart-Proxy && cd Bogdan-s-LLM-Smart-Proxy
chmod +x setup.sh && ./setup.sh
```

Or manually:

```bash
cp .env.example .env
# Edit .env with your API keys
docker compose up -d
```

The proxy runs at `http://localhost:18900`.

## Test It

```bash
# Simple chat
curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto-free","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto-coding","messages":[{"role":"user","content":"Write a fibonacci function"}],"stream":true}'

# Thinking mode
curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto-thinking","messages":[{"role":"user","content":"Solve: what is 15*37?"}]}'
```

## API Reference

### POST /v1/chat/completions

Main routing endpoint. OpenAI-compatible request format.

**Request body:**
```json
{
  "model": "auto-free",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false,
  "max_tokens": 1000,
  "reasoning_effort": "medium"
}
```

The `model` field accepts:
- **Smart group name**: `auto-free`, `auto-tools`, `auto-coding`, `auto-images`, `auto-video`, `auto-text`, `auto-max`, `auto-thinking`
- **Provider model ID**: e.g., `gpt-4o`, `llama-3.3-70b-versatile`, `qwen3-235b-a22b`
- **Provider name**: e.g., `Groq-Llama70B`, `Gemini-2.5-Pro`

Response includes `X-LLM-Provider` header showing which provider handled the request.

### GET /v1/models

List all available models. Supports `?cap=X` filter.

```bash
curl http://localhost:18900/v1/models
curl http://localhost:18900/v1/models?cap=thinking
curl http://localhost:18900/v1/models?cap=coding
```

### GET /v1/capabilities

Capability summary with provider counts per capability.

### GET /health

Full system status: uptime, provider counts, group availability.

### GET /scores

Provider scoring data: latency, success rate, thinking verification count.

### GET /discovery

Discovered models from the last auto-scan.

## Smart Groups

| Group | Routes to | Description |
|-------|-----------|-------------|
| `auto` | All providers (smart) | Detects use case from message, routes to best match, tries all as fallback |
| `auto-free` | All providers | Best available across all providers |
| `auto-tools` | Providers with tool calling | Function calling / tool use |
| `auto-coding` | Providers tagged "coding" | Code generation and editing |
| `auto-images` | Providers with vision | Image understanding |
| `auto-video` | Providers with video | Video understanding |
| `auto-text` | Providers tagged "text" | General text tasks |
| `auto-max` | Providers tagged "max" | Largest context / best quality |
| `auto-thinking` | Providers with reasoning | Chain-of-thought / reasoning |

Groups automatically route to the best-scoring provider that matches the capability. If a provider fails (429, 502, timeout), the proxy immediately tries the next provider in the group. Only returns an error if ALL providers in the group fail.

## Provider List

"Provider" = API service where you create account and get key. "Name" = proxy identifier you can use in `model` field.

| Provider | Name | Model | Context | Tier | Capabilities | Auth |
|----------|------|-------|---------|------|-------------|------|
| GitHub Copilot | Copilot-GPT4o | gpt-4o | 128K | 1 | tools, coding, text, images | key |
| GitHub Copilot | Copilot-GPT5mini | gpt-5-mini | 128K | 1 | tools, coding, text, thinking | key |
| GitHub Models | GitHubModels-GPT4o | gpt-4o | 128K | 1 | tools, coding, text, images | key |
| GitHub Models | GitHubModels-GPT41 | gpt-4.1 | 8K | 1 | tools, coding, text | key |
| Mistral | Mistral-Small | mistral-small-latest | 32K | 2 | tools, text | key |
| Mistral | Mistral-Medium | mistral-medium-latest | 32K | 1 | tools, coding, text | key |
| Groq | Groq-Llama70B | llama-3.3-70b-versatile | 131K | 2 | tools, text | key |
| Groq | Groq-GPTOSS120B | openai/gpt-oss-120b | 131K | 1 | tools, coding, text, thinking | key |
| Groq | Groq-Qwen332B | qwen/qwen3-32b | 131K | 2 | tools, coding, text, thinking | key |
| Groq | Groq-Llama4Scout | llama-4-scout-17b-16e | 131K | 2 | tools, text, images | key |
| Cerebras | Cerebras-Qwen235B | qwen-3-235b-a22b-instruct-2507 | 8K | 2 | tools, coding, text, thinking | key |
| SambaNova | SambaNova-Llama70B | Meta-Llama-3.3-70B-Instruct | 131K | 2 | tools, text | key |
| SambaNova | SambaNova-GPTOSS120B | gpt-oss-120b | 131K | 1 | tools, coding, text, thinking | key |
| SambaNova | SambaNova-DSV32 | DeepSeek-V3.2 | 131K | 1 | tools, coding, text, thinking | key |
| SambaNova | SambaNova-Maverick | Llama-4-Maverick-17B | 131K | 2 | tools, text, images | key |
| NVIDIA | NVIDIA-Llama70B | llama-3.3-70b-instruct | 131K | 2 | tools, text | key |
| NVIDIA | NVIDIA-Nemotron120B | nemotron-super-49b-v1 | 131K | 1 | tools, coding, text, max | key |
| NVIDIA | NVIDIA-DSV4Flash | deepseek-ai/deepseek-v4-flash | 131K | 1 | tools, coding, text, thinking | key |
| Gemini | Gemini-2.5-Flash | gemini-2.5-flash | 1M | 1 | tools, coding, text, images, video, thinking | key |
| Gemini | Gemini-2.5-Pro | gemini-2.5-pro | 1M | 1 | tools, coding, text, images, video, max, thinking | key |
| Gemini | Gemini-3-Flash | gemini-3-flash-preview | 1M | 1 | tools, coding, text, images, video | key |
| **LLM7** | **LLM7-Auto** | llm7/auto | 131K | 1 | tools, coding, text, thinking | **none** |
| **OVH** | **OVH-Llama70B** | Meta-Llama-3_3-70B | 131K | 2 | tools, text | **none** |
| **OVH** | **OVH-Qwen332B** | Qwen3-32B | 131K | 2 | tools, coding, text, thinking | **none** |
| **OVH** | **OVH-Qwen3Coder** | Qwen3-Coder-30B | 131K | 1 | tools, coding, text, thinking | **none** |
| **OVH** | **OVH-GPTOSS120B** | gpt-oss-120b | 131K | 1 | tools, coding, text, max, thinking | **none** |
| **OVH** | **OVH-MistralSmall** | Mistral-Small-3.2-24B | 131K | 2 | tools, text | **none** |
| OpenRouter | OR-Qwen3Coder | qwen/qwen3-coder:free | 131K | 1 | tools, coding, text, max, thinking | key |
| OpenRouter | OR-GPTOSS120B | openai/gpt-oss-120b:free | 131K | 1 | tools, coding, text, max, thinking | key |
| OpenRouter | OR-Nemotron120B | nvidia/nemotron-3-super-120b-a12b:free | 131K | 1 | tools, coding, text, max | key |
| OpenRouter | OpenRouter-Free | openrouter/auto | 131K | 2 | tools, text | key |
| OpenRouter | OR-MiniMaxM25 | minimax/minimax-m2.5:free | 131K | 2 | tools, text | key |
| Cloudflare | Cloudflare-Llama70B | llama-3.3-70b-fp8-fast | 131K | 2 | tools, text | key |
| SiliconFlow | SiliconFlow-DSV4Flash | DeepSeek-V4-Flash | 131K | 1 | tools, coding, text, thinking | key |
| SiliconFlow | SiliconFlow-Qwen8B | Qwen3-8B | 32K | 3 | tools, text, thinking | key |
| BigModel | BigModel-GLM4 | glm-4-flash | 131K | 2 | tools, text | key |
| **Kilo** | **Kilo-DSV4Flash** | deepseek-v4-flash:free | 256K | 2 | tools, coding, text, thinking | **none** |
| **Kilo** | **Kilo-Nemotron120B** | nemotron-120b:free | 262K | 2 | tools, coding, text, max | **none** |
| **Kilo** | **Kilo-NemotronReasoning** | nemotron-30b-reasoning:free | 256K | 2 | tools, text, thinking | **none** |
| **Kilo** | **Kilo-Ring1T** | ring-2.6-1t:free | 262K | 2 | tools, coding, text, max | **none** |
| **Kilo** | **Kilo-LagunaM1** | laguna-m.1:free | 131K | 2 | coding | **none** |
| **Kilo** | **Kilo-LagunaXS2** | laguna-xs.2:free | 131K | 3 | coding | **none** |
| **Kilo** | **Kilo-Cobuddy** | cobuddy:free | 131K | 3 | tools, text | **none** |
| **Kilo** | **Kilo-Auto** | openrouter/free | 131K | 3 | text | **none** |
| DeepSeek | DeepSeek-V4Flash | deepseek-v4-flash | 131K | 1 | tools, coding, text, thinking | key |
| DeepSeek | DeepSeek-V3 | deepseek-chat | 131K | 1 | tools, coding, text, thinking | key |
| Alibaba | Alibaba-QwenMax | qwen-max | 131K | 1 | tools, coding, text, max, thinking | key |
| Alibaba | Alibaba-QwenPlus | qwen-plus | 131K | 2 | tools, coding, text, thinking | key |
| Alibaba | Alibaba-QwenTurbo | qwen-turbo | 131K | 2 | tools, text | key |
| Alibaba | Alibaba-Qwen3-235B | qwen3-235b-a22b | 131K | 1 | tools, coding, text, max, thinking | key |
| Alibaba | Alibaba-Qwen3-32B | qwen3-32b | 131K | 2 | tools, coding, text, thinking | key |
| Alibaba | Alibaba-Qwen3Coder | qwen3-coder-plus | 131K | 1 | tools, coding, max, thinking | key |
| Cohere | Cohere-CommandA | command-a-03-2025 | 131K | 1 | tools, coding, text | key |
| Cohere | Cohere-CommandRPlus | command-r-plus | 131K | 1 | tools, coding, text | key |
| Cohere | Cohere-CommandR7B | command-r7b | 131K | 2 | tools, text | key |
| Ollama Cloud | Ollama-GPTOSS120B | gpt-oss:120b | 131K | 1 | tools, coding, text, thinking | key |
| Ollama Cloud | Ollama-Qwen3Coder | qwen3-coder:480b | 131K | 1 | tools, coding, text, max, thinking | key |
| Ollama Cloud | Ollama-DSV31 | deepseek-v3.1:671b | 131K | 1 | tools, coding, text, thinking | key |
| Hugging Face | HF-GPTOSS120B | openai/gpt-oss-120b | 131K | 1 | tools, coding, text, thinking | key |
| Hugging Face | HF-Qwen3Coder | Qwen3-Coder-480B | 131K | 1 | tools, coding, text, max, thinking | key |
| Hugging Face | HF-DeepSeekR1 | DeepSeek-R1 | 131K | 1 | tools, coding, text, thinking | key |

## How Routing Works

1. Request arrives (e.g. `model: "auto"` or `model: "auto-coding"`)
2. Proxy detects use case from messages: tools, coding, thinking, images, agent/IDE mode
3. Recalls relevant memories from MemPalace (project context, preferences, past errors)
4. Injects core instructions + recalled memories into system prompt
5. Estimates token count, checks if context exceeds 80% of best provider → proactive compaction
6. Filters providers by: group capability, context size, cooldown, bans, quota
7. Scores and ranks providers:
   - Base score: success rate (50%) + latency (30%) + tier (20%)
   - Smartness bonus: more capabilities, thinking, coding, larger context, known strong models
   - Agent bonus: tier 1 preferred, tools required, small models penalized
   - Compat penalty: auto-learned incompatibilities (reasoning_content, extra_body, max_tokens, tools limit)
   - Stalling penalty: -0.05 per stalling incident
8. Transforms request per provider: strips incompatible fields, caps max_tokens/tools, adds thinking params
9. Routes to highest-scoring provider
10. On failure: auto-learns incompatibility, retries next provider (30s cooldown on 429)
11. On stalling (2x "continue" = 5min cooldown, 3x = ban from group)
12. If context too large: proxy saves full context to MemPalace, compacts messages (keeps system + first task + last 4 messages + summary), retries with smaller context
13. If still too large after proxy compaction: returns `context_length_exceeded` to trigger IDE-side compaction
14. Saves session progress, task state, errors, preferences to MemPalace (async) — recoverable on "continue"

## Adding New Providers

Add to `seed-providers.json` in the `providers` array:

```json
{
  "name": "MyProvider-ModelName",
  "url": "https://api.example.com/v1/chat/completions",
  "key_env": "MY_PROVIDER_KEY",
  "model": "model-id",
  "context": 131072,
  "tier": 1,
  "tc": true,
  "caps": ["tools", "coding", "text", "thinking"],
  "no_auth": false
}
```

Then add key to `.env` and restart. Discovery auto-detects new models from configured endpoints.

## IDE & Agent Integration

### Claude Code (VS Code / JetBrains)

```bash
# Add as OpenAI-compatible provider in settings
# Settings > AI Provider > Custom > OpenAI Compatible
# Base URL: http://YOUR_SERVER:18900/v1
# API Key: any (proxy ignores it)
# Model: auto-free (or any group/provider name)
```

Or in `settings.json`:

```json
{
  "anthropic.baseUrl": "http://YOUR_SERVER:18900/v1"
}
```

### Cursor

Settings > Models > OpenAI API Key: `proxy` > Base URL: `http://YOUR_SERVER:18900/v1`

Model names: `auto-free`, `auto-coding`, `auto-thinking`, or any specific provider like `Groq-GPTOSS120B`.

### DeerFlow / LangChain / LangGraph

```yaml
# config.yaml
models:
  - name: auto-thinking
    use: langchain_openai:ChatOpenAI
    model: auto-thinking
    api_key: "proxy"
    base_url: http://YOUR_SERVER:18900/v1
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://YOUR_SERVER:18900/v1",
    api_key="proxy",  # any string works
)

response = client.chat.completions.create(
    model="auto-coding",
    messages=[{"role": "user", "content": "Write fibonacci"}],
)
```

### OpenAI Node.js SDK

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://YOUR_SERVER:18900/v1",
  apiKey: "proxy",
});

const response = await client.chat.completions.create({
  model: "auto-thinking",
  messages: [{ role: "user", content: "Explain quantum computing" }],
});
```

### Any OpenAI-compatible client

Just change the base URL to `http://YOUR_SERVER:18900/v1`. The proxy accepts any API key (it uses its own keys per provider). Model = group name or provider name from `/v1/models`.

## Get Free API Keys

14 models work with zero keys (Kilo, OVH, LLM7). Add keys for wider coverage:

| Provider | Get free key at | Models |
|----------|----------------|--------|
| Groq | https://console.groq.com | Llama 70B, GPT-OSS 120B, Qwen3 32B, Llama 4 Scout |
| Gemini | https://aistudio.google.com | Gemini 2.5 Flash/Pro, Gemini 3 Flash |
| OpenRouter | https://openrouter.ai/keys | 20+ free models (Qwen3 Coder, GPT-OSS, Nemotron) |
| SambaNova | https://cloud.sambanova.ai | Llama 70B, GPT-OSS 120B, DeepSeek V3.2, Maverick |
| Cerebras | https://cloud.cerebras.ai | Qwen3 235B (fastest inference) |
| NVIDIA | https://build.nvidia.com | Llama 70B, Nemotron 120B, DeepSeek V4 Flash |
| Alibaba | https://dashscope.console.aliyun.com | Qwen Max, Qwen3 235B/32B, Qwen3 Coder ⚠️ |
| Mistral | https://console.mistral.ai | Mistral Small, Medium |
| DeepSeek | https://platform.deepseek.com | DeepSeek V3, V4 Flash |
| SiliconFlow | https://cloud.siliconflow.com | DeepSeek V4 Flash, Qwen3 8B |
| Cohere | https://dashboard.cohere.com | Command A 111B, Command R+, Command R7B |
| Hugging Face | https://huggingface.co/settings/tokens | GPT-OSS 120B, Qwen3 Coder 480B, DeepSeek R1 |
| Ollama Cloud | https://ollama.com | GPT-OSS 120B, Qwen3 Coder, DeepSeek V3.1 |
| Cloudflare | https://dash.cloudflare.com | Llama 70B |
| BigModel | https://open.bigmodel.cn | GLM-4 Flash |
| **Kilo** | **No key needed** | **8 models (anonymous access)** |
| **OVH** | **No key needed** | **5 models (open endpoint)** |
| **LLM7** | **No key needed** | **1 model (open endpoint)** |

> ⚠️ **Alibaba free tier**: Each model gets 1M tokens free for 90 days. After that, requests are **charged silently** by default. To stay safe, enable **"Free Quota Only"** mode in the [Alibaba console](https://dashscope.console.aliyun.com) — the proxy will auto-detect the 403 error and disable the provider.

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `COPILOT_TOKEN` | GitHub Copilot token | `gho_xxxx` |
| `MISTRAL_API_KEY` | Mistral AI API key | `xxx` |
| `GROQ_API_KEY` | Groq API key | `gsk_xxxx` |
| `CEREBRAS_API_KEY` | Cerebras API key | `csk-xxxx` |
| `SAMBANOVA_API_KEY` | SambaNova API key | `xxx` |
| `NVIDIA_API_KEY` | NVIDIA API key | `nvapi-xxxx` |
| `GEMINI_API_KEY` | Google Gemini API key | `AIzaxxxx` |
| `OPENROUTER_API_KEY` | OpenRouter API key | `sk-or-v1-xxxx` |
| `CLOUDFLARE_API_KEY` | Cloudflare Workers AI token | `cfut_xxxx` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (required for Workers AI) | `e0c9xxxx` |
| `SILICONFLOW_API_KEY` | SiliconFlow API key | `sk-xxxx` |
| `BIGMODEL_API_KEY` | BigModel (GLM) API key | `xxx` |
| `DEEPSEEK_API_KEY` | DeepSeek API key | `sk-xxxx` |
| `COHERE_API_KEY` | Cohere API key | `xxx` |
| `HF_TOKEN` | Hugging Face token | `hf_xxxx` |
| `OLLAMA_API_KEY` | Ollama Cloud API key | `xxx` |
| `KILO_TOKEN` | Kilo Code token (optional, uses anonymous by default) | `anonymous` |
| `ALIBABA_API_KEY` | Alibaba DashScope API key | `sk-xxxx` |
| `LLM7_API_KEY` | LLM7 (optional, works without — key gives higher limits) | |
| `OVH_API_KEY` | OVH AI (no key needed, works without) | |
| `LLM_PROXY_PORT` | Proxy port (default: 18900) | `18900` |
| `DATA_DIR` | Data directory (default: /data) | `/data` |

## Recommended Tools

Tools that complement the proxy. See [`INSTRUCTIONS.md`](INSTRUCTIONS.md) for an LLM-readable version that AI agents can follow to auto-install everything.

### MemPalace -- Persistent AI Memory

Stores context, decisions, and progress across sessions.

```bash
# Install package
pip install mempalace

# Initialize palace in your project
mempalace init .

# Add MCP server to Claude Code
claude mcp add mempalace -- python -m mempalace.mcp_server

# Install Claude Code skill + hooks (auto-memory on every session)
claude plugin add mempalace

# Verify
mempalace status
```

**For other agents (DeerFlow, Cursor, OpenCode):**

```bash
# MCP server config (add to your agent's MCP config):
{
  "command": "python3",
  "args": ["-m", "mempalace.mcp_server"],
  "env": { "MEMPALACE_DIR": "/path/to/palace" }
}

# Or run as standalone HTTP MCP:
python -m mempalace mcp --http --port 8891
```

Key tools: `mempalace_search`, `mempalace_add_drawer`, `mempalace_list_rooms`, `mempalace_get_drawer`

Docs: [mempalace.tech/guides/setup](https://www.mempalace.tech/guides/setup) | [GitHub](https://github.com/MemPalace/mempalace)

### RTK -- Rust Token Killer (60-90% token savings)

CLI proxy that compresses command output before it reaches AI context.

```bash
# macOS
brew install rtk-ai/tap/rtk

# Linux/macOS (quick install)
curl -fsSL https://rtk-ai.app/install.sh | sh

# Or via Cargo
cargo install rtk

# Setup Claude Code hook (one-time, auto-rewrites bash commands)
rtk init --global

# Restart Claude Code after init
```

Savings: cargo test 91%, git status 80%, find 78%.

Docs: [rtk-ai.app](https://www.rtk-ai.app/) | [GitHub](https://github.com/rtk-ai/rtk)

### Caveman Mode -- Terse Responses (~75% fewer tokens)

Compresses AI responses to essentials during active work.

```bash
# Install in Claude Code (one-time)
claude install-skill caveman https://github.com/anthropics/claude-code-skills

# Or add to CLAUDE.md:
# @caveman — activate with /caveman full

# Activate per session:
/caveman full

# Levels: lite, full (default), ultra
# Disable: "stop caveman" or "normal mode"
```

**For other agents:** Add to system prompt:
> "Respond terse. Drop articles/filler. Fragments OK. Technical terms exact. Code unchanged."

### Superpowers -- Advanced Agent Capabilities

Eval-first execution, parallel agents, git worktrees.

```bash
# Install in Claude Code (one-time)
claude install-skill superpowers https://github.com/anthropics/claude-code-skills

# Or add to CLAUDE.md:
# @superpowers — brainstorming, TDD, dispatching, verification

# Activate per session:
/superpowers
```

Key sub-skills: `brainstorming`, `test-driven`, `dispatching`, `verification`, `writing-plans`

### Autonomous Execution (built into proxy)

The proxy injects execution rules into every request automatically. No separate installation needed. See `skills/autonomous-loop/SKILL.md` for the full reference.

**Injected automatically:**

- Senior engineer identity with UNDERSTAND → PLAN → CONFIRM → EXECUTE → VERIFY → SAVE cycle
- MemPalace integration (auto-save/recall, context compaction, resume protocol)
- Decision making (discover tech → recall preferences → confirm once → build)
- Anti-stalling rules and violation detection
- Date/time awareness, user language detection
- Smart merge with IDE system prompts (replaces identity, keeps tool instructions)

## Memory (MemPalace)

The proxy includes an optional persistent memory system. When enabled, it:
- **Auto-saves** session progress, task state, architecture decisions, error resolutions, and user preferences
- **Auto-recalls** relevant memories and injects them into the system prompt on each request
- **Resumes context** when user says "continue" -- loads last task state and session progress

Memory runs as a Docker service (`mempalace-mcp` on port 8891). IDEs can also connect directly.

Disable with `MEMPALACE_ENABLED=false` in `.env`. Proxy works normally without it.

## Architecture

```
Client Request
     |
     v
[LLM Smart Proxy :18900]
     |
     +-- /v1/chat/completions --> Recall Memories --> Compact if needed
     |                                  |
     |                           Group Router --> Provider 1 --> Provider 2 --> ...
     |                                  |
     |                           Score & Rank (agent-aware, compat-aware)
     |                           Transform Request (strip incompatible fields)
     |                           Detect Thinking / Stalling
     |                           Save to MemPalace (async)
     |
     +-- /v1/models           --> List all providers + groups
     +-- /v1/capabilities     --> Capability summary
     +-- /health              --> System status + MemPalace status
     +-- /scores              --> Scoring data
     +-- /discovery           --> Discovered models

[MemPalace MCP :8891]         --> Persistent memory (sessions, tasks, errors, preferences)

[LLM Discovery Daemon]
     |
     +-- Every 6h: scan /models endpoints
     +-- Test new models: chat, thinking, context
     +-- Save to /data/discovery.json
```

## License

MIT
