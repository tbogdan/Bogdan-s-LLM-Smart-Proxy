#!/usr/bin/env bash
# Bogdan LLM Smart Proxy installer.
set -eo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
mode=install
dry=false
memory=false
for arg in "$@"; do
  case "$arg" in
    doctor) mode=doctor ;;
    --dry-run) dry=true ;;
    --non-interactive) : ;;
    --upgrade) mode=upgrade ;;
    --uninstall) mode=uninstall ;;
    --memory) memory=true ;;
    --help|-h) echo 'Usage: ./setup.sh [doctor|--dry-run|--non-interactive|--memory|--upgrade|--uninstall]'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
get_env() { if [ -f .env ]; then awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit}' .env; fi; }
port=${LLM_PROXY_PORT:-$(get_env LLM_PROXY_PORT)}
port=${port:-18900}
case "$port" in *[!0-9]*|'') echo 'LLM_PROXY_PORT must be numeric' >&2; exit 2;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then echo 'Invalid TCP port' >&2; exit 2; fi
if "$dry"; then
  echo "Dry run: mode=$mode, endpoint=http://localhost:$port; existing configuration preserved."
  echo 'Required: running Docker engine and Docker Compose v2. No files or services changed.'
  exit 0
fi
if ! command -v docker >/dev/null 2>&1; then echo 'Docker missing. Install Docker Desktop or a compatible engine, then rerun.' >&2; exit 1; fi
if ! docker info >/dev/null 2>&1; then echo 'Docker engine unavailable. Start Docker, then rerun.' >&2; exit 1; fi
if ! docker compose version >/dev/null 2>&1; then echo 'Docker Compose v2 required.' >&2; exit 1; fi
CODEX_SOURCE_AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [ "$mode" != doctor ] && [ "$mode" != uninstall ] && [ -d "data/codex-auth.json" ]; then
  if ! rmdir "data/codex-auth.json"; then echo "Codex auth path is a non-empty directory; preserve its contents and repair the mount." >&2; exit 1; fi
fi
profiles=()
if "$memory" || [ "$(get_env MEMORY_BACKEND)" = graphiti ] || [ "$(get_env MEMORY_BACKEND)" = neo4j ]; then profiles+=(--profile memory); fi
if [ "$(get_env ENABLE_CODEX)" = true ]; then
  if [ -f data/codex-auth.json ]; then profiles+=(--profile codex)
  elif [ "$mode" != doctor ] && [ "$mode" != uninstall ] && [ -f "$CODEX_SOURCE_AUTH" ]; then
    mkdir -p data; umask 077; cp "$CODEX_SOURCE_AUTH" "data/codex-auth.json"; profiles+=(--profile codex)
  else echo 'Codex configured but auth missing. Complete Codex login and rerun; other routes can still start.' >&2; fi
fi
if [ "$mode" = doctor ]; then
  exec docker compose "${profiles[@]}" exec -T llm-proxy node scripts/doctor.js
fi
if [ "$mode" = uninstall ]; then
  docker compose "${profiles[@]}" down
  echo 'This installation stopped. Credentials, configuration and data preserved.'
  exit 0
fi
umask 077
if [ ! -f .env ]; then cp .env.example .env; echo 'Created .env. Configure at least one provider credential; no accounts are created automatically.'; fi
mkdir -p data
if "$memory"; then
  cp .env "data/config-backup-$(date +%Y%m%d%H%M%S)-$$.env"
  temp=$(mktemp .env.XXXXXX)
  awk '!/^(MEMORY_ENABLED|MEMORY_BACKEND|GRAPHITI_MCP_ENABLED)=/' .env > "$temp"
  printf '\nMEMORY_ENABLED=true\nMEMORY_BACKEND=graphiti\nGRAPHITI_MCP_ENABLED=true\n' >> "$temp"
  chmod 600 "$temp"; mv "$temp" .env
fi
if [ "$mode" = upgrade ]; then docker compose "${profiles[@]}" build --pull; fi
docker compose "${profiles[@]}" up -d --build
printf '\nProxy: http://localhost:%s\nDiagnostics: ./setup.sh doctor\n' "$port"
echo 'Container startup does not prove provider authentication or inference. Doctor lists readiness without inference charges.'
echo 'Configure one provider in .env; optional inference smoke: docker compose exec llm-proxy node scripts/doctor.js --probe --model FAMILY/MODEL'
