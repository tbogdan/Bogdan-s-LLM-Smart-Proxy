# Project LLM Smart Proxy Instructions

Use Project LLM Smart Proxy as a local Docker OpenAI-compatible proxy for Windsurf, Claude, and Codex. The proxy listens on one local endpoint and routes `auto` model requests across the enabled provider families.

## Setup Steps

1. Copy the environment template.

   ```bash
   cp .env.example .env
   ```

2. Enable the provider families you want in `.env`.

   ```dotenv
   ENABLE_WINDSURF=true
   ENABLE_CLAUDE=true
   ENABLE_CODEX=true
   ```

3. Authenticate enabled providers on the host.

   ```bash
   node windsurf-auth.js --env-file .env
   claude auth login --console
   node claude-auth.js --env-path .env
   npx @openai/codex login
   mkdir -p data
   cp ~/.codex/auth.json data/codex-auth.json
   ```

   Choose the Anthropic Console account in the Claude browser flow. The helper extracts Claude Code's login-managed API key and writes `ANTHROPIC_API_KEY` into `.env`; if needed, you can manually create a key at `https://platform.claude.com/settings/keys`.
   If you use `./setup.sh`, Codex auth is copied automatically from `${CODEX_HOME:-$HOME/.codex}/auth.json` when Codex is enabled.

4. Start Docker.

   ```bash
   docker compose --profile codex up -d --build
   ```

   If Codex is not enabled, omit `--profile codex`.
   When another checkout is already running on the host, set `COMPOSE_PROJECT_NAME`, `LLM_PROXY_PORT`, `CODEX_PROXY_PORT`, and `MEMPALACE_PORT` in `.env` before starting Docker.

5. Verify health.

   ```bash
   curl http://localhost:18900/health
   curl http://localhost:18900/v1/models
   ```

## Client Configuration

- Base URL: `http://localhost:18900/v1`
- API key: `proxy`
- Model: `auto`

OpenAI-compatible clients can also request `auto-coding`, `coding-sm`, `auto-thinking`, `auto-tools`, `auto-text`, `auto-max`, or a specific namespaced model from an enabled provider family.

Claude Code uses Anthropic Messages endpoints instead of OpenAI chat completions. Point it at the proxy root URL:

```bash
export ANTHROPIC_BASE_URL=http://localhost:18900
export ANTHROPIC_MODEL=auto-coding
export ANTHROPIC_SMALL_FAST_MODEL=coding-sm
claude
```

Or add the same values under `env` in `.claude/settings.local.json`.

## Operational Notes

- Discovery is scoped to three provider families: Windsurf, Claude, and Codex.
- Windsurf discovery uses the built-in model catalog unless `WINDSURF_MODELS`, `WINDSURF_MODELS_JSON`, or `WINDSURF_MODELS_URL` is configured.
- Windsurf cloud requests use native Connect/protobuf tool definitions plus app-like `WINDSURF_IDE_VERSION`, `WINDSURF_USER_AGENT`, and `WINDSURF_CONNECT_RETRIES` compatibility settings.
- Smart routing is optimized by `LLM_COST_TARGET`, `LLM_THINKING_TARGET`, and `LLM_SPEED_TARGET`; these are soft targets, not hard caps.
- Context compaction uses an internal self-call to `LLM_PROXY_AI_SUMMARY_MODEL` so compacted turns carry an AI-generated summary in the current request.
- Use `docker compose --profile codex` when Codex is enabled.
- Use `--profile memory` only when MemPalace is enabled with `MEMPALACE_ENABLED=true`.
- Restart Docker services after changing `.env` credentials or enable flags.
