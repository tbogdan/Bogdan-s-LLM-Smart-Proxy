#!/bin/bash
set -e

echo "=== Project LLM Smart Proxy Setup ==="
echo ""

if ! command -v docker &> /dev/null; then
  echo "ERROR: Docker not installed. Install Docker first."
  exit 1
fi

if ! docker compose version &> /dev/null; then
  echo "ERROR: Docker Compose V2 not available. Update Docker."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
else
  echo ".env exists; preserving current values."
fi

mkdir -p data

set_env() {
  KEY="$1"
  VALUE="$2"
  TMP_FILE=".env.tmp.$$"

  awk -v key="$KEY" -v value="$VALUE" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) {
        print key "=" value
      }
    }
  ' .env > "$TMP_FILE"
  mv "$TMP_FILE" .env
}

get_env() {
  KEY="$1"
  awk -F= -v key="$KEY" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null
}

remove_env() {
  KEY="$1"
  TMP_FILE=".env.tmp.$$"

  awk -F= -v key="$KEY" '$1 != key { print }' .env > "$TMP_FILE"
  mv "$TMP_FILE" .env
}

CODEX_SOURCE_AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"

ensure_codex_auth() {
  if [ -f "data/codex-auth.json" ]; then
    echo "Codex auth already available at data/codex-auth.json."
    return
  fi

  if [ -d "data/codex-auth.json" ]; then
    if rmdir "data/codex-auth.json" 2>/dev/null; then
      echo "Removed empty data/codex-auth.json directory created by Docker bind mount."
    else
      echo "ERROR: data/codex-auth.json is a non-empty directory. Remove it and rerun setup after Codex login."
      exit 1
    fi
  fi

  if [ -f "$CODEX_SOURCE_AUTH" ]; then
    cp "$CODEX_SOURCE_AUTH" "data/codex-auth.json"
    chmod 600 "data/codex-auth.json" 2>/dev/null || true
    echo "Copied Codex auth into data/codex-auth.json."
  else
    echo "Codex enabled. Create auth with:"
    echo "  npx @openai/codex login"
    echo "Then rerun setup, or copy it into this project:"
    echo "  cp ~/.codex/auth.json data/codex-auth.json"
  fi
}

PROFILES=""

echo ""
read -p "Enable Windsurf provider? (y/N): " ENABLE_WINDSURF_INPUT
if [[ "$ENABLE_WINDSURF_INPUT" =~ ^[Yy]$ ]]; then
  set_env ENABLE_WINDSURF true
  if [ -z "$(get_env WINDSURF_API_KEY)" ]; then
    echo "Windsurf enabled. To populate WINDSURF_API_KEY, run:"
    echo "  node windsurf-auth.js --env-file .env"
  fi
fi

echo ""
read -p "Enable Claude provider? (y/N): " ENABLE_CLAUDE_INPUT
if [[ "$ENABLE_CLAUDE_INPUT" =~ ^[Yy]$ ]]; then
  set_env ENABLE_CLAUDE true
  ANTHROPIC_TOKEN="$(get_env ANTHROPIC_API_KEY)"
  if [ -z "$ANTHROPIC_TOKEN" ]; then
    echo "Claude enabled. Authenticate with Anthropic Console, then extract the managed key:"
    echo "  claude auth login --console"
    echo "  node claude-auth.js --env-path .env"
    read -p "Run extraction now if you already completed Console login? (y/N): " CLAUDE_EXTRACT_INPUT
    if [[ "$CLAUDE_EXTRACT_INPUT" =~ ^[Yy]$ ]]; then
      node claude-auth.js --env-path .env
    fi
  fi
fi

echo ""
read -p "Enable Codex proxy? (y/N): " ENABLE_CODEX_INPUT
if [[ "$ENABLE_CODEX_INPUT" =~ ^[Yy]$ ]]; then
  set_env ENABLE_CODEX true
  PROFILES="$PROFILES --profile codex"
  ensure_codex_auth
elif grep -q "^ENABLE_CODEX=true" .env 2>/dev/null; then
  PROFILES="$PROFILES --profile codex"
  ensure_codex_auth
fi

echo ""
read -p "Enable GitHub Copilot provider? (y/N): " ENABLE_COPILOT_INPUT
if [[ "$ENABLE_COPILOT_INPUT" =~ ^[Yy]$ ]]; then
  set_env ENABLE_COPILOT true
  if [ -z "$(get_env COPILOT_GITHUB_TOKEN)" ]; then
    echo "Copilot enabled. Run device-flow auth:"
    echo "  node github-copilot-auth.js --env-file .env"
    echo "Pass --client-id if you want to override the OAuth app."
    echo "Or set COPILOT_GITHUB_TOKEN manually before restarting Docker."
  fi
fi

for KEY in \
  MEMPALACE_ENABLED \
  MEMPALACE_URL \
  MEMPALACE_MAX_INJECT_TOKENS \
  MEMPALACE_PORT \
  MEMORY_ENABLED \
  MEMORY_BACKEND \
  MEMORY_MAX_INJECT_TOKENS \
  MEMORY_ARCHIVE_MAX_CHARS \
  GRAPHITI_NEO4J_URI \
  GRAPHITI_NEO4J_USER \
  GRAPHITI_NEO4J_PASSWORD \
  GRAPHITI_NEO4J_DATABASE \
  GRAPHITI_NEO4J_PORT \
  GRAPHITI_NEO4J_HTTP_PORT \
  GRAPHITI_MCP_ENABLED \
  GRAPHITI_MCP_URL \
  GRAPHITI_MCP_PUBLIC_URL \
  GRAPHITI_MCP_PORT \
  GRAPHITI_MCP_GROUP_ID \
  GRAPHITI_MCP_MODEL_NAME \
  GRAPHITI_MCP_API_KEY \
  GRAPHITI_MCP_OPENAI_API_URL \
  GRAPHITI_MCP_EMBEDDING_MODEL \
  GRAPHITI_MCP_EMBEDDING_DIMENSIONS \
  GRAPHITI_MCP_SEMAPHORE_LIMIT \
  GRAPHITI_MCP_TIMEOUT_MS \
  GRAPHITI_MCP_WRITE_TIMEOUT_MS \
  GRAPHITI_MCP_SEARCH_TIMEOUT_MS \
  GRAPHITI_MCP_OUTBOX_BATCH \
  GRAPHITI_TELEMETRY_ENABLED \
  LLM_PROXY_AI_SUMMARY_MODEL \
  LLM_PROXY_AI_SUMMARY_TIMEOUT_MS \
  LLM_PROXY_AI_SUMMARY_MAX_TOKENS \
  LLM_PROXY_AI_SUMMARY_MIN_MESSAGES \
  LLM_PROXY_EMBEDDING_MODEL \
  LLM_PROXY_EMBEDDING_DIMENSIONS \
  CODEX_API_KEY \
  WINDSURF_MODELS \
  WINDSURF_MODELS_JSON \
  WINDSURF_MODELS_URL \
  WINDSURF_IDE_VERSION \
  WINDSURF_USER_AGENT \
  WINDSURF_API_ORIGIN \
  WINDSURF_CHAT_ORIGIN \
  WINDSURF_CONNECT_TIMEOUT_MS \
  WINDSURF_CONNECT_TIMEOUT_HEADER \
  WINDSURF_INCLUDE_ACCEPT_HEADER \
  WINDSURF_CONNECT_RETRIES \
  GITHUB_COPILOT_CLIENT_ID \
  GITHUB_COPILOT_SCOPE \
  COPILOT_MODELS \
  COPILOT_MODELS_URL
do
  remove_env "$KEY"
done

echo ""
echo "Building and starting containers..."
docker compose $PROFILES up -d --build

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Proxy:  http://localhost:18900"
echo "Health: http://localhost:18900/health"
echo "Models: http://localhost:18900/v1/models"
echo ""
