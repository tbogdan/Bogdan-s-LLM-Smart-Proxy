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

5. Verify health.

   ```bash
   curl http://localhost:18900/health
   curl http://localhost:18900/v1/models
   ```

## Client Configuration

- Base URL: `http://localhost:18900/v1`
- API key: `proxy`
- Model: `auto`

OpenAI-compatible clients can also request `auto-coding`, `auto-thinking`, `auto-tools`, `auto-text`, `auto-max`, or a specific namespaced model from an enabled provider family.

## Operational Notes

- Discovery is scoped to three provider families: Windsurf, Claude, and Codex.
- Use `docker compose --profile codex` when Codex is enabled.
- Use `--profile memory` only when MemPalace is enabled with `MEMPALACE_ENABLED=true`.
- Restart Docker services after changing `.env` credentials or enable flags.
