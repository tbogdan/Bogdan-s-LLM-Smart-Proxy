#!/usr/bin/env bash
# Smoke test: validate docker-compose.yml syntax and expected structure.
# PASS: exit 0   FAIL: exit 1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="$ROOT/docker-compose.yml"
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "PASS [$label]"
  else
    echo "FAIL [$label]"
    FAIL=1
  fi
}

check_contains() {
  local label="$1"
  local pattern="$2"
  if grep -q "$pattern" "$COMPOSE"; then
    echo "PASS [$label]"
  else
    echo "FAIL [$label]: pattern not found: $pattern"
    FAIL=1
  fi
}

check_absent() {
  local label="$1"
  local pattern="$2"
  if grep -q "$pattern" "$COMPOSE"; then
    echo "FAIL [$label]: banned pattern found: $pattern"
    FAIL=1
  else
    echo "PASS [$label]"
  fi
}

# 1. Compose config dry-run validation
echo "--- docker compose config dry-run ---"
# Create a temporary .env if none exists so compose can parse env_file directive
TEMP_ENV=0
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  TEMP_ENV=1
fi

if docker compose -f "$COMPOSE" config --quiet 2>&1; then
  echo "PASS [compose config syntax]"
else
  echo "FAIL [compose config syntax]"
  FAIL=1
fi

[ "$TEMP_ENV" -eq 1 ] && rm -f "$ROOT/.env"

echo ""
echo "--- structural checks ---"

# 2. Project name
check_contains "COMPOSE_PROJECT_NAME=llm-proxy-docker" "^name: llm-proxy-docker"

# 3. Required services present
check_contains "service: llm-proxy"    "llm-proxy:"
check_contains "service: neo4j"        "neo4j:"
check_contains "service: graphiti-mcp" "graphiti-mcp:"
check_contains "service: codex-proxy"  "codex-proxy:"

# 4. Port mappings
check_contains "port 18920:18900 (llm-proxy external)"  "18920:18900"
check_contains "port 10532:10531 (codex external)"      "10532:10531"
check_contains "port 7475:7474 (neo4j http external)"   "7475:7474"
check_contains "port 7688:7687 (neo4j bolt external)"   "7688:7687"

# 5. codex-proxy has profile codex
check_contains "codex profile" "profiles: \[codex\]"

# 6. No banned branding strings
check_absent "no 'legacy-source' string" -i "legacy-source"

# 7. No old port conflicts (old ports must not appear as-is)
check_absent "no raw 18900:18900" '"18900:18900"'
check_absent "no raw 10531:10531" '"10531:10531"'
check_absent "no raw 7474:7474"   '"7474:7474"'
check_absent "no raw 7687:7687"   '"7687:7687"'

if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "ALL CHECKS PASSED — compose stack validated"
  exit 0
else
  echo ""
  echo "SOME CHECKS FAILED — see above"
  exit 1
fi
