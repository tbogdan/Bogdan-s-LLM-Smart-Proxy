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
      ["SILICONFLOW_API_KEY"]="SiliconFlow (sk-...) — free at siliconflow.cn"
      ["CLOUDFLARE_API_KEY"]="Cloudflare Workers AI (cfut_...) — free at dash.cloudflare.com"
      ["BIGMODEL_API_KEY"]="BigModel/GLM — free at open.bigmodel.cn"
    )

    KEY_ORDER=(GROQ_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY SAMBANOVA_API_KEY CEREBRAS_API_KEY NVIDIA_API_KEY ALIBABA_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY COPILOT_TOKEN SILICONFLOW_API_KEY CLOUDFLARE_API_KEY BIGMODEL_API_KEY)

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

# Create data directory
mkdir -p data

echo ""
echo "Building and starting containers..."
docker compose up -d --build

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
echo '    -d '"'"'{"model":"auto-free","messages":[{"role":"user","content":"Hello"}]}'"'"
