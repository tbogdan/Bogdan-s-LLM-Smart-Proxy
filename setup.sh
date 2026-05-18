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

mkdir -p data palace

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
  CLAUDE_TOKEN="$(get_env CLAUDE_CODE_OAUTH_TOKEN)"
  ANTHROPIC_TOKEN="$(get_env ANTHROPIC_API_KEY)"
  if [ -z "$CLAUDE_TOKEN" ] && [ -z "$ANTHROPIC_TOKEN" ]; then
    echo "Claude enabled. Create a Platform API key at:"
    echo "  https://platform.claude.com/settings/keys"
    read -p "Paste ANTHROPIC_API_KEY, or press Enter to use Claude Code OAuth instead: " ANTHROPIC_KEY_INPUT
    if [ -n "$ANTHROPIC_KEY_INPUT" ]; then
      set_env ANTHROPIC_API_KEY "$ANTHROPIC_KEY_INPUT"
    else
      echo "Fallback OAuth path:"
      echo "  claude setup-token"
      read -p "Paste CLAUDE_CODE_OAUTH_TOKEN, or press Enter to skip: " CLAUDE_CODE_TOKEN_INPUT
      if [ -n "$CLAUDE_CODE_TOKEN_INPUT" ]; then
        set_env CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_TOKEN_INPUT"
      fi
    fi
  fi
fi

echo ""
read -p "Enable Codex proxy? (y/N): " ENABLE_CODEX_INPUT
if [[ "$ENABLE_CODEX_INPUT" =~ ^[Yy]$ ]]; then
  set_env ENABLE_CODEX true
  PROFILES="$PROFILES --profile codex"
  if [ ! -f "data/codex-auth.json" ]; then
    echo "Codex enabled. Create auth with:"
    echo "  npx @openai/codex login"
    echo "Then copy it into this project:"
    echo "  cp ~/.codex/auth.json data/codex-auth.json"
  fi
elif grep -q "^ENABLE_CODEX=true" .env 2>/dev/null; then
  PROFILES="$PROFILES --profile codex"
fi

if grep -q "^MEMPALACE_ENABLED=true" .env 2>/dev/null; then
  PROFILES="$PROFILES --profile memory"
fi

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
