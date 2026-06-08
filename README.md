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

## Auth Helpers

Use these npm scripts to extract OAuth tokens from installed clients:

```bash
npm run claude-auth    # Claude Code subscription
npm run copilot-auth   # GitHub Copilot subscription
npm run windsurf-auth  # Windsurf IDE subscription
npm run kiro-auth      # Kiro free tier (AWS ID required)
```

Each script opens browser OAuth flow, auto-captures token, and writes to `.env`.

## Supported Sources

OpenAI-compatible APIs, Claude direct, Copilot, Windsurf, Cursor, Claudeweb, Kiro.

**Provider Families:**

| Family | Protocol | Auth Script | Models |
| ------- | -------- | ----------- | ------ |
| `claude` | Anthropic Messages API | `npm run claude-auth` | Claude Sonnet 4, Haiku 4.5, Opus |
| `codex` | OpenAI Responses API | `npx @openai/codex login` | GPT-5.5/5.4/5.3/5.2 |
| `copilot` | OpenAI Chat Completions | `npm run copilot-auth` | GPT-4o, o1, o3, Claude |
| `windsurf` | Windsurf Cloud API | `npm run windsurf-auth` | Claude Sonnet 4, GPT-4o |
| `kiro` | Kiro Gateway | `npm run kiro-auth` | Claude Sonnet 4, Haiku 4.5 |

## Routing Policy and Model Scoring

Provider selection uses multi-factor scoring at request time:

- **Task kind detection** — 24 task categories (direct_answer, code_generation, explanation, documentation, etc.) mapped to provider capability requirements
- **Effort levels** — none / minimal / low / medium / high / xhigh; controls context budget and model tier selection
- **Cost multiplier** — per-provider cost weight balanced against quality score
- **Stalling decay** — providers penalized for slow or stalled streams; score recovers over time
- **Emergency release** — if only 2 providers remain, bans are temporarily lifted to maintain availability

Scoring formula: `base_benchmark + capability_match_bonus + cost_group_bonus - stalling_penalty - error_decay`

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

Core modules: lib/routing-policy.js, lib/provider-config.js,
              lib/provider-adapters.js, lib/anthropic-gateway.js,
              lib/embeddings.js, lib/http-home.js
Legacy modules: state.js, scoring.js, providers.js, compaction.js,
                transforms.js, routing.js, responses.js

[Graphiti MCP :8001]   — graph memory sidecar (Neo4j backend)
[Codex Proxy :10532]   — GPT-5.x (optional, profile: codex)
[Discovery Daemon]     — scans /models every 6h
```

## Validation

Run after install to confirm core runtime is healthy:

```bash
# Smoke test all core runtime modules
npm run smoke:core

# Verify providers load and export expected families/groups
node -e "
  const pc = require('./lib/provider-config');
  const fam = pc.SUPPORTED_FAMILIES.join(', ');
  const grp = Object.keys(pc.GROUPS).join(', ');
  console.log('providers ok — families:', fam);
  console.log('providers ok — groups:', grp);
"

# Verify routing policy loads and exports task kinds
node -e "
  const rp = require('./lib/routing-policy');
  const kinds = Object.keys(rp.TASK_KIND_TARGETS).length;
  const effort = Object.keys(rp.EFFORT_LEVELS).join(', ');
  console.log('routing ok —', kinds, 'task kinds, effort levels:', effort);
"

# Verify auth scripts load
node -e "
  require('./claude-auth');
  require('./github-copilot-auth');
  require('./windsurf-auth');
  console.log('auth ok — claude-auth, github-copilot-auth, windsurf-auth');
"
```

## Deploy Config

### Docker Compose

```bash
# Isolate stack from other compose projects on the host
COMPOSE_PROJECT_NAME=llm-proxy docker compose up -d

# Enable optional gateway profiles
COMPOSE_PROJECT_NAME=llm-proxy docker compose --profile codex up -d   # adds Codex proxy :10532
```

### Ports

| Service | Port | Notes |
|---------|------|-------|
| llm-proxy | 18920 | Main proxy, OpenAI-compatible |
| codex-proxy | 10532 | GPT-5.x via ChatGPT OAuth (profile: codex) |
| graphiti-mcp | 8001 | Graph memory sidecar |
| neo4j | 7475 / 7688 | Graph DB for Graphiti |

### Neo4j / Graphiti Memory (optional)

Persistent semantic memory using a local Neo4j graph store and Graphiti MCP.

**.env settings:**

```env
MEMORY_ENABLED=true
MEMORY_BACKEND=graphiti          # or: local (session-only), neo4j (direct)

NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=graphiti-memory-local

GRAPHITI_MCP_ENABLED=true
GRAPHITI_MCP_URL=http://localhost:8001
```

**Config file:** `config/graphiti-mcp-neo4j.yaml` — customise model, embedding dimensions,
Neo4j connection, and Graphiti group ID.

**Start (neo4j and graphiti-mcp run by default):**

```bash
COMPOSE_PROJECT_NAME=llm-proxy docker compose up -d
```

## Documentation

- [Runtime Architecture](docs/RUNTIME.md) — Core modules, memory stack, data flow
- [Validation Guide](docs/VALIDATION.md) — Smoke tests, endpoint checks, troubleshooting
- [Memory Migration Plan](docs/superpowers/plans/2026-06-07-proxy-memory-deploy-plan.md) — Migration history

## Credits

| Tool | Used for |
|------|----------|
| [kiro-openai-gateway](https://pypi.org/project/kiro-openai-gateway/) | Free Claude via AWS |
| [openai-oauth](https://github.com/EvanZhouDev/openai-oauth) | ChatGPT OAuth proxy |
| [Graphiti](https://github.com/getzep/graphiti) | Graph-based persistent memory |
| [RTK](https://github.com/rtk-ai/rtk) | CLI output compression |

## License

MIT
