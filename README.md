# Bogdan's LLM Smart Proxy

Routes requests to 80+ LLM models across 26 sources with automatic failover, smart scoring, and capability-based routing.

## Features

- **80+ models, 26 sources** — auto-discovery every 6h, zero-config for 14 anonymous models
- **Smart groups** — `auto-coding`, `auto-thinking`, `auto-tools` etc. route to best-scored provider
- **Auto-scoring** — tracks latency, success rate, stalling; providers ranked dynamically
- **Auto-learning** — detects provider quirks from errors, adapts requests automatically
- **Codex CLI support** — WebSocket + HTTP SSE `/v1/responses` (Responses API bridge)
- **Context compaction** — 4-layer progressive reduction with drop cache for instant replay
- **Quality control** — garble detection, stalling detection, empty response retry, JSON repair
- **Admin API** — `/ban`, `/unban`, `/banned` for runtime provider management
- **User commands** — type `ban ai 24` in IDE chat to ban current provider for 24h

## Quick Start

```bash
git clone https://github.com/tbogdan/Bogdan-s-LLM-Smart-Proxy && cd Bogdan-s-LLM-Smart-Proxy
cp .env.example .env   # add your API keys
docker compose up -d   # runs at http://localhost:18900
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Main routing (OpenAI-compatible) |
| POST | `/v1/responses` | Responses API (WS + SSE, for Codex CLI) |
| GET | `/v1/models` | List models + groups. `?cap=coding` filter |
| GET | `/v1/capabilities` | Capability summary |
| GET | `/health` | System status |
| GET | `/scores` | Provider scoring data |
| GET | `/stats` | Session token usage |
| GET | `/banned` | Cooldowns + bans with reasons |
| GET | `/discovery` | Auto-discovered models |
| POST | `/ban` | Ban provider: `{"pattern":"DSV4Flash","hours":12}` |
| POST | `/unban` | Clear cooldowns: `{"pattern":"all"}` |

**Model field accepts:** group name (`auto-coding`), model ID (`gpt-4o`), or provider name (`Groq-GPTOSS120B`).

Response includes `X-LLM-Provider`, `X-LLM-Model`, `X-LLM-Tokens-Used` headers.

## Smart Groups

| Group | Routes to |
|-------|-----------|
| `auto` | Best match based on message analysis |
| `auto-coding` | Best coding model |
| `auto-thinking` | Best reasoning model |
| `auto-tools` | Best tool-calling model |
| `auto-images` | Best vision model |
| `auto-text` | Best text/chat model |
| `auto-max` | Best quality overall |

## IDE Integration

**Any OpenAI-compatible client:** Base URL `http://YOUR_SERVER:18900/v1`, API key `proxy`, model `auto-coding`.

```python
# Python
from openai import OpenAI
client = OpenAI(base_url="http://YOUR_SERVER:18900/v1", api_key="proxy")
client.chat.completions.create(model="auto-coding", messages=[{"role":"user","content":"Hello"}])
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
model = "auto-coding"
openai_base_url = "http://YOUR_SERVER:18900/v1"
experimental_realtime_ws_base_url = "ws://YOUR_SERVER:18900/v1"
```

## Free API Keys

14 models work with zero keys (Kilo, OVH, LLM7). Add keys for more:

| Provider | Free key | Models |
|----------|----------|--------|
| Groq | [console.groq.com](https://console.groq.com) | GPT-OSS 120B, Llama 70B, Qwen3 32B |
| Gemini | [aistudio.google.com](https://aistudio.google.com) | Gemini 2.5/3 Flash, 2.5 Pro |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | 20+ free models |
| SambaNova | [cloud.sambanova.ai](https://cloud.sambanova.ai) | GPT-OSS 120B, DeepSeek V3.2 |
| NVIDIA | [build.nvidia.com](https://build.nvidia.com) | Nemotron 120B, DeepSeek V4 |
| Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Qwen3 235B (fastest) |
| Kiro | [kiro.dev](https://kiro.dev) (free AWS ID) | Claude Sonnet 4, Haiku 4.5 |
| Codex | ChatGPT subscription | GPT-5.5/5.4/5.3/5.2 |

Full list: see `.env.example` for all supported providers.

## Architecture

```
Client (IDE / Codex CLI / API)
     │
     ▼
[Smart Proxy :18900]
     ├── /v1/chat/completions → routing.js
     │     ├── 4-layer compaction (90%→75%→50%→20%)
     │     ├── Provider selection (benchmark + compat + stalling decay)
     │     ├── Request transform (tool sanitization, role fixes, dedup)
     │     ├── Stream → garble/stalling/empty detection → failover
     │     └── Emergency provider release if <=2 available
     │
     ├── /v1/responses → responses.js (Codex CLI bridge)
     │     ├── WebSocket: multi-turn with history
     │     └── HTTP SSE: single-turn streaming
     │
     └── /health, /scores, /banned, /ban, /unban, /stats

Modules: state.js, scoring.js, providers.js, compaction.js,
         transforms.js, routing.js, responses.js

[MemPalace MCP :8891]  — persistent memory (optional)
[Kiro Gateway :10088]  — free Claude (optional)
[Codex Proxy :10531]   — GPT-5.x (optional)
[Discovery Daemon]     — scans /models every 6h
```

## Credits

| Tool | Used for |
|------|----------|
| [kiro-openai-gateway](https://pypi.org/project/kiro-openai-gateway/) | Free Claude via AWS |
| [openai-oauth](https://github.com/EvanZhouDev/openai-oauth) | ChatGPT OAuth proxy |
| [MemPalace](https://github.com/MemPalace/mempalace) | Persistent AI memory |
| [RTK](https://github.com/rtk-ai/rtk) | CLI output compression |

## License

MIT
