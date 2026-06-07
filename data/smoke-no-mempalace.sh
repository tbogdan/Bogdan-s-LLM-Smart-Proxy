#!/usr/bin/env bash
# Smoke test: verify mempalace stack has been removed from the project.
# PASS: exit 0   FAIL: exit 1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

check_absent() {
  local label="$1"
  local file="$2"
  if [ -e "$file" ]; then
    echo "FAIL [$label]: file still exists: $file"
    FAIL=1
  else
    echo "PASS [$label]: $file absent"
  fi
}

check_no_string() {
  local label="$1"
  local pattern="$2"
  shift 2
  local matches
  matches=$(grep -rn "$pattern" "$@" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "FAIL [$label]: found '$pattern' in:"
    echo "$matches"
    FAIL=1
  else
    echo "PASS [$label]: no '$pattern' found"
  fi
}

# 1. Files must be gone
check_absent "Dockerfile.mempalace absent"  "$ROOT/Dockerfile.mempalace"
check_absent "llm-mempalace.js absent"      "$ROOT/llm-mempalace.js"

# 2. MEMPALACE_URL token must not appear in runtime/config files
check_no_string "MEMPALACE_URL not in .env.example"    "MEMPALACE_URL"   "$ROOT/.env.example"
check_no_string "MEMPALACE_URL not in docker-compose"  "MEMPALACE_URL"   "$ROOT/docker-compose.yml"
check_no_string "MEMPALACE_URL not in llm-proxy.js"    "MEMPALACE_URL"   "$ROOT/llm-proxy.js"

# 3. mempalace-mcp service must be gone from docker-compose
check_no_string "mempalace-mcp not in docker-compose"  "mempalace-mcp"   "$ROOT/docker-compose.yml"

# 4. require('./llm-mempalace') must be gone from JS source
check_no_string "llm-mempalace not in llm-proxy.js"    "llm-mempalace"   "$ROOT/llm-proxy.js"
check_no_string "llm-mempalace not in routing.js"      "llm-mempalace"   "$ROOT/lib/routing.js"
check_no_string "llm-mempalace not in transforms.js"   "llm-mempalace"   "$ROOT/lib/transforms.js"

# 5. INSTRUCTIONS.md must not mention mempalace install
check_no_string "mempalace not in INSTRUCTIONS.md"     "mempalace"       "$ROOT/INSTRUCTIONS.md"

if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "ALL CHECKS PASSED — mempalace stack removed"
  exit 0
else
  echo ""
  echo "SOME CHECKS FAILED — see above"
  exit 1
fi
