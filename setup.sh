#!/bin/bash
set -e

echo "=== LLM Smart Proxy Setup ==="
echo ""
echo "14 models across 3 providers work WITHOUT any API keys (Kilo, OVH, LLM7)."
echo "Add more keys for additional providers."
echo ""

# Check for Docker
if ! command -v docker &> /dev/null; then
  echo "ERROR: Docker not installed. Install Docker first."
  exit 1
fi

if ! docker compose version &> /dev/null; then
  echo "ERROR: Docker Compose V2 not available. Update Docker."
  exit 1
fi

# Create .env from example if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env"
  echo ""

  read -p "Configure API keys interactively? (y/N): " INTERACTIVE
  if [[ "$INTERACTIVE" =~ ^[Yy]$ ]]; then
    echo ""
    echo "Press Enter to skip any key you don't have."
    echo "Kilo/OVH/LLM7 work without keys — already configured."
    echo ""

    declare -A KEY_NAMES=(
      ["GROQ_API_KEY"]="Groq (gsk_...) — free at console.groq.com"
      ["GEMINI_API_KEY"]="Google Gemini (AIza...) — free at aistudio.google.com"
      ["OPENROUTER_API_KEY"]="OpenRouter (sk-or-v1-...) — free at openrouter.ai"
      ["SAMBANOVA_API_KEY"]="SambaNova — free at cloud.sambanova.ai"
      ["CEREBRAS_API_KEY"]="Cerebras (csk-...) — free at cerebras.ai"
      ["NVIDIA_API_KEY"]="NVIDIA (nvapi-...) — free at build.nvidia.com"
      ["ALIBABA_API_KEY"]="Alibaba/DashScope (sk-...) — free at dashscope.console.aliyun.com"
      ["MISTRAL_API_KEY"]="Mistral — free at console.mistral.ai"
      ["DEEPSEEK_API_KEY"]="DeepSeek (sk-...) — free at platform.deepseek.com"
      ["COPILOT_TOKEN"]="GitHub Copilot (gho_...) — needs Copilot subscription"
      ["SILICONFLOW_API_KEY"]="SiliconFlow (sk-...) — free at siliconflow.com"
      ["CLOUDFLARE_API_KEY"]="Cloudflare Workers AI (cfut_...) — free at dash.cloudflare.com"
      ["CLOUDFLARE_ACCOUNT_ID"]="Cloudflare Account ID — find at dash.cloudflare.com (required if using Cloudflare)"
      ["COHERE_API_KEY"]="Cohere (trial key) — free at dashboard.cohere.com"
      ["HF_TOKEN"]="Hugging Face (hf_...) — free at huggingface.co/settings/tokens"
      ["OLLAMA_API_KEY"]="Ollama Cloud — free at ollama.com"
      ["LLM7_API_KEY"]="LLM7 (optional, works without) — higher limits with key"
      ["OPENAI_API_KEY"]="OpenAI (sk-proj-...) — at platform.openai.com"
      ["BIGMODEL_API_KEY"]="BigModel/GLM — free at open.bigmodel.cn"
      ["CLINE_API_KEY"]="Cline Provider (sk_...) — free at app.cline.bot (28 free models)"
    )

    KEY_ORDER=(OPENAI_API_KEY GROQ_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY SAMBANOVA_API_KEY CEREBRAS_API_KEY NVIDIA_API_KEY ALIBABA_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY COHERE_API_KEY HF_TOKEN OLLAMA_API_KEY COPILOT_TOKEN SILICONFLOW_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID LLM7_API_KEY BIGMODEL_API_KEY CLINE_API_KEY)

    for KEY in "${KEY_ORDER[@]}"; do
      read -p "${KEY_NAMES[$KEY]}: " VALUE
      if [ -n "$VALUE" ]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
          sed -i '' "s|^${KEY}=.*|${KEY}=${VALUE}|" .env
        else
          sed -i "s|^${KEY}=.*|${KEY}=${VALUE}|" .env
        fi
        echo "  ✓ $KEY"
      fi
    done
    echo ""
  fi
else
  echo ".env exists, skipping key setup."
fi

# Create data and palace directories
mkdir -p data palace

# Build profile flags from ENABLE_X vars in .env
PROFILES=""

# --- Kiro Gateway ---
if grep -q "^ENABLE_KIRO=true" .env 2>/dev/null; then
  PROFILES="$PROFILES --profile kiro"
  CURRENT_TOKEN=$(grep "^REFRESH_TOKEN=" .env 2>/dev/null | cut -d= -f2-)
  if [ -z "$CURRENT_TOKEN" ] || [ "$CURRENT_TOKEN" = "xxx" ]; then
    echo ""
    echo "Kiro enabled but REFRESH_TOKEN not set. Starting browser auth..."
    node kiro-auth.js --env-file .env
  fi
fi

# --- OpenAI Codex Proxy ---
if grep -q "^ENABLE_CODEX=true" .env 2>/dev/null; then
  PROFILES="$PROFILES --profile codex"
  if [ ! -f "data/codex-auth.json" ]; then
    echo ""
    echo "Codex enabled but auth token not found."
    echo "Run: npx @openai/codex login"
    echo "Then: cp ~/.codex/auth.json data/codex-auth.json"
    echo ""
    if command -v npx &> /dev/null; then
      read -p "Run codex login now? (y/N): " CODEX_LOGIN
      if [[ "$CODEX_LOGIN" =~ ^[Yy]$ ]]; then
        npx @openai/codex login
        if [ -f "$HOME/.codex/auth.json" ]; then
          cp "$HOME/.codex/auth.json" data/codex-auth.json
          echo "  ✓ codex-auth.json saved"
        fi
      fi
    fi
  fi
fi

echo ""
echo "Building and starting containers..."
docker compose up -d --build $PROFILES

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Proxy:          http://localhost:18900"
echo "Health:         http://localhost:18900/health"
echo "Models:         http://localhost:18900/v1/models"
echo "Capabilities:   http://localhost:18900/v1/capabilities"
echo ""
echo "Works immediately with 14 models (3 providers: Kilo, OVH, LLM7) — no keys needed."
echo "Add API keys to .env for more providers, then restart:"
echo "  docker compose restart"
echo ""
echo "Test:"
echo '  curl http://localhost:18900/v1/chat/completions \'
echo '    -H "Content-Type: application/json" \'
echo '    -d '"'"'{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'"'"
