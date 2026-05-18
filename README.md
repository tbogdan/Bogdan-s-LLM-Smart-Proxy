# Project LLM Smart Proxy

Project LLM Smart Proxy is a local Docker OpenAI-compatible smart proxy for exactly three multi-model provider families: Windsurf, Claude, and Codex. It exposes one local endpoint, discovers available models for those families, and routes smart group model names such as `auto` and `auto-coding` to the best available provider.

## Supported Providers

| Provider family | Host authentication | Runtime adapter | Models |
| --- | --- | --- | --- |
| Windsurf | `node windsurf-auth.js --env-file .env` | Native proxy adapter | `windsurf/swe-1.6-fast`, `windsurf/swe-1.6`, `windsurf/swe-1.5-fast` |
| Claude | `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN` | Anthropic Messages adapter | `claude/...` from discovery/seed |
| Codex | `npx @openai/codex login`, then copy `auth.json` into `data/codex-auth.json` | Local Codex proxy container | `codex/gpt-5.5`, `codex/gpt-5.4`, `codex/gpt-5.4-mini`, `codex/gpt-5.3-codex`, `codex/gpt-5.2` |

## Quick Start

```bash
chmod +x setup.sh
./setup.sh
```

The setup script copies `.env.example` to `.env` when needed, prompts for the provider families to enable, and starts Docker Compose with the required profiles.

## Manual Setup

```bash
cp .env.example .env
```

Edit `.env` and enable the provider families you want:

```dotenv
ENABLE_WINDSURF=true
ENABLE_CLAUDE=true
ENABLE_CODEX=true
```

Authenticate enabled providers on the host:

```bash
node windsurf-auth.js --env-file .env
claude setup-token
npx @openai/codex login
mkdir -p data
cp ~/.codex/auth.json data/codex-auth.json
```

For Claude, paste the token from `claude setup-token` into `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

Start Docker with the Codex profile when Codex is enabled:

```bash
docker compose --profile codex up -d --build
```

Without Codex, the base services are enough:

```bash
docker compose up -d --build
```

## Endpoint

- Base URL: `http://localhost:18900/v1`
- API key: any non-empty value, for example `proxy`
- Default model: `auto`

Use this endpoint from OpenAI-compatible SDKs, IDEs, and coding agents.

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
```

## Discovery

The discovery daemon scans only the Windsurf, Claude, and Codex provider families. It merges discovered models with the seed configuration and writes runtime provider data under `data/`.

Discovery is intentionally scoped to the three supported families so `/v1/models`, smart routing, and Docker setup stay aligned.

## Smart Groups

| Group | Purpose |
| --- | --- |
| `auto` | General smart routing across enabled providers |
| `auto-coding` | Coding, editing, and agentic development tasks |
| `auto-thinking` | Reasoning-heavy tasks |
| `auto-tools` | Requests that use tool calls |
| `auto-text` | General text generation and rewriting |
| `auto-max` | Highest-capability or largest-context routing |

Specific provider model IDs such as `windsurf/swe-1.6-fast`, `claude/...`, and `codex/gpt-5.5` can also be requested directly.

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

## Troubleshooting

- Missing `WINDSURF_API_KEY`: run `node windsurf-auth.js --env-file .env`, then restart the proxy.
- Missing `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token`, paste the token into `.env`, then restart the proxy.
- Missing `data/codex-auth.json`: run `npx @openai/codex login`, then `mkdir -p data && cp ~/.codex/auth.json data/codex-auth.json`.
- Empty `/v1/models`: confirm at least one provider family is enabled in `.env`, required credentials are present, and the matching Docker profile is running for Codex.

## References

- [Claude Code authentication docs](https://docs.anthropic.com/en/docs/claude-code)
- [Claude gateway docs](https://docs.anthropic.com/en/api/messages)
- [Upstream GitHub repo](https://github.com/tbogdan/Bogdan-s-LLM-Smart-Proxy)
