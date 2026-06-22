# Bogdan LLM Smart Proxy Instructions

Use Bogdan LLM Smart Proxy as a local Docker OpenAI-compatible proxy for Windsurf, Claude, Codex, and GitHub Copilot. The proxy listens on one local endpoint and routes `auto` model requests across the enabled provider families.

## Setup Steps

1. Copy the environment template.

   ```bash
   cp .env.example .env
   ```

2. Enable the provider families you want in `.env`. Keep current host ports unless another checkout already owns them.

   ```dotenv
   LLM_PROXY_PORT=18900
   CODEX_PROXY_PORT=10531
   ENABLE_WINDSURF=true
   ENABLE_CLAUDE=true
   ENABLE_CODEX=true
   LLM_PROXY_CODEX_VIRTUAL_SUBAGENTS=true
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

For Codex CLI or plugin, use llm-proxy on port 18900:

```toml
# ~/.codex/config.toml
model = "auto-coding"
model_provider = "llm-proxy"

[model_providers.llm-proxy]
name = "Bogdan LLM Smart Proxy (OpenAI-compatible)"
base_url = "http://localhost:18900/v1"
env_key = "OPENAI_API_KEY"
```

```bash
export OPENAI_API_KEY=proxy
```

Do not point Codex at codex-proxy on port 10531 for normal use. codex-proxy is only the OAuth/auth shim container that llm-proxy uses as a Codex backend.

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
- Host ports: llm-proxy listens on `LLM_PROXY_PORT=18900`; codex-proxy listens on `CODEX_PROXY_PORT=10531` and exists only for Codex OAuth/auth refresh.
- Keep `LLM_PROXY_CODEX_VIRTUAL_SUBAGENTS=true` unless you need to disable Codex subagent synthesis for debugging. It lets Codex subagents work through llm-proxy by mapping to native `multi_agent_v1` tools.
- Windsurf discovery uses the built-in model catalog. Set `WINDSURF_ENTERPRISE=true` when the source should use the enterprise app API origin.
- Windsurf cloud requests use native Connect/protobuf tool definitions plus app-like compatibility defaults from code and Compose.
- Smart routing is optimized by `LLM_COST_TARGET`, `LLM_THINKING_TARGET`, `LLM_SPEED_TARGET`, and `LLM_ROUTING_POLICY`; these are soft targets, not hard caps.
- Context pressure raises `contextLevel` only when the current context tier would leave less than 30% unused headroom. Large context alone should prefer a same-capability provider with a larger window before upgrading to a higher capability tier.
- Context compaction can add an AI summary through an internal self-call to `/v1/chat/completions` using `LLM_PROXY_AI_SUMMARY_MODEL` (default `auto-text`), and summaries are cached by digest.
- The active memory layer is `lib/memory`. Docker Compose enables the local Neo4j graph backend by default; the in-process backend is only for tests or temporary non-Docker runs.
- Graphiti MCP runs as a semantic sidecar behind the proxy. Keep the proxy's direct Neo4j ledger authoritative for automatic saves, user corrections, and compaction archives.
- Graphiti MCP uses the proxy as its OpenAI-compatible endpoint with `auto-memory`. The local proxy serves `/v1/embeddings`, so a real `OPENAI_API_KEY` is not required for the sidecar path.
- Neo4j and Graphiti MCP stay on the Compose network by default; publish their ports only in an explicit local override when direct host access is needed.
- Use `docker compose --profile codex` when Codex is enabled.
- Restart Docker services after changing `.env` credentials or enable flags.
