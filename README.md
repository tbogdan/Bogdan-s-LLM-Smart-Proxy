# Project LLM Smart Proxy

Project LLM Smart Proxy is a local Docker OpenAI-compatible smart proxy for exactly three multi-model provider families: Windsurf, Claude, and Codex. It exposes one local endpoint, discovers available models for those families, and routes smart group model names such as `auto`, `auto-coding`, and `coding-sm` to the best available provider.

## Supported Providers

| Provider family | Host authentication | Runtime adapter | Models |
| --- | --- | --- | --- |
| Windsurf | `node windsurf-auth.js --env-file .env` | Native proxy adapter | SWE, GPT, Claude, Gemini, GLM, Minimax, and Grok models from the local catalog or overrides |
| Claude | `claude auth login --console`, then `node claude-auth.js --env-path .env` to extract `ANTHROPIC_API_KEY` | Anthropic Messages adapter | `claude/...` from discovery/seed |
| Codex | `npx @openai/codex login`; setup copies `auth.json` into `data/codex-auth.json` | Local Codex proxy container | `codex/gpt-5.5`, `codex/gpt-5.4`, `codex/gpt-5.4-mini`, `codex/gpt-5.3-codex`, `codex/gpt-5.2`, `codex/codex-auto-review` |

## Quick Start

```bash
chmod +x setup.sh
./setup.sh
```

The setup script copies `.env.example` to `.env` when needed, prompts for the provider families to enable, and starts Docker Compose with the required profiles.
When Codex is enabled, it also copies `${CODEX_HOME:-$HOME/.codex}/auth.json` into `data/codex-auth.json` if the file exists.

## Manual Setup

```bash
cp .env.example .env
```

Edit `.env` and enable the provider families you want:

```dotenv
COMPOSE_PROJECT_NAME=llm-proxy
LLM_PROXY_PORT=18900
CODEX_PROXY_PORT=10531
MEMPALACE_PORT=8891
ENABLE_WINDSURF=true
ENABLE_CLAUDE=true
ENABLE_CODEX=true
```

Authenticate enabled providers on the host:

```bash
node windsurf-auth.js --env-file .env
claude auth login --console
node claude-auth.js --env-path .env
npx @openai/codex login
mkdir -p data
cp ~/.codex/auth.json data/codex-auth.json
```

For Claude, choose the Anthropic Console account in the browser flow. The helper reads the login-managed API key from Claude Code's local credential store and writes it to `ANTHROPIC_API_KEY` in `.env`. As a manual fallback, create a key at `https://platform.claude.com/settings/keys` and put it into `ANTHROPIC_API_KEY`.

Start Docker with the Codex profile when Codex is enabled:

```bash
docker compose --profile codex up -d --build
```

Without Codex, the base services are enough:

```bash
docker compose up -d --build
```

To run this proxy beside another checkout on the same Docker host, set a different `COMPOSE_PROJECT_NAME` and host ports in `.env`. Container-internal ports stay unchanged.

## Endpoint

- Base URL: `http://localhost:18900/v1`
- API key: any non-empty value, for example `proxy`
- Default model: `auto`

Use this endpoint from OpenAI-compatible SDKs, IDEs, and coding agents.

For Claude Code as a client, use the Anthropic-compatible bridge on the same service:

```bash
export ANTHROPIC_BASE_URL=http://localhost:18900
export ANTHROPIC_MODEL=auto-coding
export ANTHROPIC_SMALL_FAST_MODEL=coding-sm
claude
```

Project-local Claude Code config can be placed in `.claude/settings.local.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:18900",
    "ANTHROPIC_MODEL": "auto-coding",
    "ANTHROPIC_SMALL_FAST_MODEL": "coding-sm"
  }
}
```

The Claude Code bridge exposes `/v1/messages` and `/v1/messages/count_tokens`.

## Test

```bash
curl http://localhost:18900/v1/chat/completions \
  -H "Authorization: Bearer proxy" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello from Project LLM Smart Proxy"}]}'
```

Health and model checks:

```bash
curl http://localhost:18900/health
curl http://localhost:18900/v1/models
curl http://localhost:18900/v1/messages/count_tokens \
  -H "x-api-key: proxy" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto-coding","messages":[{"role":"user","content":"ping"}]}'
```

## Benchmark

The local benchmark compares an expensive direct concrete model with a proxy smart-routing ladder using the same test set. The direct arm bypasses proxy prompt injection, memory injection, content compaction, and routing assessment markers; the proxy arm keeps full optimization enabled and uses the appropriate smart group per case (`auto-text`, `coding-sm`, `auto-coding`, `auto-thinking`, or `auto-max`). Cases are coding-heavy and borrow benchmark shapes from code reasoning, real issue repair, secure coding, tool-use, terminal-agent recovery, and architecture decision tasks. It reports provider/model choices, latency, correctness, weighted correctness by complexity, prompt/completion tokens, estimated cost, cost group, proxy savings percentage, and ASCII comparison charts.

The command is a dry run unless `--run` is present:

```bash
npm run benchmark
npm run benchmark -- --run --max-cases=6
npm run benchmark -- --run --suite=opus
npm run benchmark -- --run --suite=all --max-minutes=5
npm run benchmark -- --run --direct-model=windsurf/claude-opus-4.6 --proxy-model=auto-coding
```

Defaults are intentionally conservative: sequential requests, one repeat, six route-ladder cases, bounded completions, no cost cap, and a runtime guard of a few minutes. Use `--suite=opus` for the Opus-vs-optimized-proxy comparison where the direct arm calls Opus directly and the proxy arm receives natural high-complexity programming, architecture, and logic tasks with proxy cleanup and routing policy enabled. Use `--suite=all` to run the route ladder and Opus comparison in one merged benchmark. Cost is an estimate from model-family pricing and normalized token usage, then summarized as absolute USD plus proxy savings percentage. It can differ from subscription or bundled-provider billing; Windsurf SWE is treated as free.

## Discovery

The discovery daemon scans only the Windsurf, Claude, and Codex provider families. It merges discovered models with the seed configuration and writes runtime provider data under `data/`.

Discovery is intentionally scoped to the three supported families so `/v1/models`, smart routing, and Docker setup stay aligned.

Windsurf does not expose a stable public model list API, so the proxy ships a broader local catalog and supports explicit overrides:

```dotenv
WINDSURF_MODELS=windsurf/custom-model, explicit-model=explicit_model_uid
WINDSURF_MODELS_JSON=[{"id":"windsurf/custom","windsurf_model_uid":"custom_uid","context":200000}]
WINDSURF_MODELS_URL=
WINDSURF_IDE_VERSION=2.3.9
WINDSURF_USER_AGENT=connect-es/1.5.0
WINDSURF_ENTERPRISE=false
WINDSURF_API_ORIGIN=
WINDSURF_CHAT_ORIGIN=
WINDSURF_CONNECT_TIMEOUT_MS=120000
WINDSURF_CONNECT_TIMEOUT_HEADER=true
WINDSURF_INCLUDE_ACCEPT_HEADER=false
WINDSURF_CONNECT_RETRIES=1
```

When overrides are present, discovery uses them instead of the built-in Windsurf catalog.
The compatibility fields mirror the installed Windsurf app transport defaults and can be overridden after an app update. On current Windsurf desktop builds, the language server process exposes the app API origin in its command line as `--api_server_url`; this proxy calls `ApiServerService/GetChatMessage` directly, so `WINDSURF_CHAT_ORIGIN` should usually stay empty or equal to `WINDSURF_API_ORIGIN`. Do not point `WINDSURF_CHAT_ORIGIN` at `--inference_api_server_url` unless the adapter is changed to call an inference-specific RPC. `WINDSURF_INCLUDE_ACCEPT_HEADER=false` keeps the chat Connect request closer to the app's streaming Connect signature; flip it only for compatibility with older server behavior.
Set `WINDSURF_ENTERPRISE=true` to use the enterprise app API origin (`https://server.enterprise.windsurf.com`) without hard-coding `WINDSURF_API_ORIGIN` and `WINDSURF_CHAT_ORIGIN`. Explicit origin variables still win when you need to test another endpoint.

## Smart Groups

| Group | Purpose |
| --- | --- |
| `auto` | General smart routing across enabled providers |
| `auto-coding` | Coding, editing, and agentic development tasks |
| `coding-sm` | Small/fast coding and tool-capable background tasks, suitable for Claude Code small fast model routing |
| `auto-thinking` | Reasoning-heavy tasks |
| `auto-tools` | Requests that use tool calls |
| `auto-text` | General text generation and rewriting |
| `auto-max` | Highest-capability or largest-context routing |

Specific provider model IDs such as `windsurf/swe-1.6-fast`, `claude/...`, and `codex/gpt-5.5` can also be requested directly.

## Routing Policy

Smart routing uses elastic optimization, not hard caps. The proxy classifies each provider into five cost groups, five speed groups, and a thinking-effort level. It also injects a private first-line task assessment contract:

```text
LLM_PROXY_TASK_DIFFICULTY level=<1-5> effort=<none|minimal|low|medium|high|xhigh> speed=<1-5> reason=<slug>
```

The proxy strips that marker before returning the response. If the selected model says the task needs a materially different level, the proxy reroutes inside the same request.

```dotenv
LLM_COST_TARGET=3
LLM_THINKING_TARGET=medium
LLM_SPEED_TARGET=4
LLM_ROUTING_POLICY=balanced
LLM_PROXY_AI_SUMMARY_MODEL=auto-text
LLM_PROXY_AI_SUMMARY_TIMEOUT_MS=12000
LLM_PROXY_AI_SUMMARY_MAX_TOKENS=500
```

The targets are averages/preferences. Simple prompts are steered toward cheaper/faster models; complex agentic work can exceed the configured cost target when capability is more important.
When context compaction removes old turns, the proxy also makes an internal self-call to `LLM_PROXY_AI_SUMMARY_MODEL` and embeds the AI summary into the compacted context for the current request.

## Docker Profiles

| Profile | When to use |
| --- | --- |
| `codex` | Required when `ENABLE_CODEX=true`; starts the local Codex proxy container using `data/codex-auth.json`. |
| `memory` | Optional; starts MemPalace when `MEMPALACE_ENABLED=true`. |

Examples:

```bash
docker compose --profile codex up -d --build
docker compose --profile memory up -d --build
docker compose --profile codex --profile memory up -d --build
```

Port variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `llm-proxy` | Prefix for Docker Compose container names |
| `LLM_PROXY_PORT` | `18900` | Host port for the OpenAI/Anthropic proxy |
| `CODEX_PROXY_PORT` | `10531` | Host port for the Codex proxy profile |
| `MEMPALACE_PORT` | `8891` | Host port for the MemPalace profile |

## Troubleshooting

- Missing `WINDSURF_API_KEY`: run `node windsurf-auth.js --env-file .env`, then restart the proxy.
- Missing Claude credentials: run `claude auth login --console`, choose Anthropic Console, then run `node claude-auth.js --env-path .env` and restart the proxy. If the helper says you are logged in with a subscription account, run `claude auth logout` and repeat the Console login.
- Missing `data/codex-auth.json`: run `npx @openai/codex login`, then rerun `./setup.sh`; setup copies the auth file into Docker's bind mount target.
- Empty `/v1/models`: confirm at least one provider family is enabled in `.env`, required credentials are present, and the matching Docker profile is running for Codex.

## References

- [Claude Platform API authentication](https://platform.claude.com/docs/en/api/authentication/overview)
- [Claude Code authentication docs](https://code.claude.com/docs/en/authentication)
- [Claude Messages API docs](https://platform.claude.com/docs/en/api/messages)
