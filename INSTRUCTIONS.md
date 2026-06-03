# Project LLM Smart Proxy Instructions

Use Project LLM Smart Proxy as a local Docker OpenAI-compatible proxy for Windsurf, Claude, Codex, and GitHub Copilot. The proxy listens on one local endpoint and routes `auto` model requests across the enabled provider families.

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
   ENABLE_COPILOT=true
   ```

3. Authenticate enabled providers on the host.

   ```bash
   node windsurf-auth.js --env-file .env
   claude auth login --console
   node claude-auth.js --env-path .env
   npx @openai/codex login
   mkdir -p data
   cp ~/.codex/auth.json data/codex-auth.json
   node github-copilot-auth.js --env-file .env
   ```

   Choose the Anthropic Console account in the Claude browser flow. The helper extracts Claude Code's login-managed API key, writes `ANTHROPIC_API_KEY`, reads Claude Code profile metadata from `~/.claude.json`, and captures local CLI request defaults for the Anthropic adapter. If needed, you can manually create a key at `https://platform.claude.com/settings/keys`; pass `--session-id <uuid>` to pin a Claude Code session id in `.env`.
   For Copilot, the helper defaults to VS Code GitHub Authentication's public OAuth client id. Override it with `--client-id` if you want to use your own app. The proxy exchanges that GitHub token for a short-lived Copilot runtime token before calling the Copilot LLM endpoint.
   If you use `./setup.sh`, Codex auth is copied automatically from `${CODEX_HOME:-$HOME/.codex}/auth.json` when Codex is enabled.

4. Start Docker.

   ```bash
   docker compose --profile codex up -d --build
   ```

   If Codex is not enabled, omit `--profile codex`.
   When another checkout is already running on the host, set `COMPOSE_PROJECT_NAME`, `LLM_PROXY_PORT`, and `CODEX_PROXY_PORT` in `.env` before starting Docker.

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

- Discovery is scoped to the supported provider families: Windsurf, Claude, Codex, and Copilot.
- Windsurf discovery uses the built-in model catalog. Set `WINDSURF_ENTERPRISE=true` when the source should use the enterprise app API origin.
- Windsurf cloud requests use native Connect/protobuf tool definitions plus app-like compatibility defaults from code and Compose.
- Smart routing is optimized by `LLM_COST_TARGET`, `LLM_THINKING_TARGET`, and `LLM_SPEED_TARGET`; these are soft targets, not hard caps.
- Context compaction uses an internal self-call to the Compose default summary model so compacted turns carry an AI-generated summary in the current request.
- The active memory layer is `lib/memory`. Docker Compose enables the local Neo4j graph backend by default; the in-process backend is only for tests or temporary non-Docker runs.
- Graphiti MCP runs as a semantic sidecar behind the proxy. Keep the proxy's direct Neo4j ledger authoritative for automatic saves, user corrections, and compaction archives.
- Graphiti MCP uses the proxy as its OpenAI-compatible endpoint with `auto-memory`. The local proxy serves `/v1/embeddings`, so a real `OPENAI_API_KEY` is not required for the sidecar path.
- Neo4j and Graphiti MCP stay on the Compose network by default; publish their ports only in an explicit local override when direct host access is needed.
- Use `docker compose --profile codex` when Codex is enabled.
- Restart Docker services after changing `.env` credentials or enable flags.
