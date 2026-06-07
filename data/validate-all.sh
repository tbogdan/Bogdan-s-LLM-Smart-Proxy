#!/usr/bin/env bash
# Final validation script — runs all smoke tests + brand scan.
# PASS: exit 0   FAIL: exit 1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
TOTAL_PASS=0
TOTAL_FAIL=0

pass() { echo "PASS [$1]"; TOTAL_PASS=$((TOTAL_PASS + 1)); }
fail() { echo "FAIL [$1]: $2"; TOTAL_FAIL=$((TOTAL_FAIL + 1)); FAIL=1; }

# ---------------------------------------------------------------------------
# 0. Prerequisites
# ---------------------------------------------------------------------------
echo "=== 0. Prerequisites ==="
if command -v node >/dev/null 2>&1; then
  pass "node available ($(node --version))"
else
  fail "node" "node not found — install Node.js"
fi

# ---------------------------------------------------------------------------
# 1. Core module smoke test (npm run smoke:core)
# ---------------------------------------------------------------------------
echo ""
echo "=== 1. Core module smoke ==="
if node -e "
  require('$ROOT/lib/routing-policy');
  require('$ROOT/lib/provider-config');
  require('$ROOT/lib/provider-adapters');
  require('$ROOT/lib/anthropic-gateway');
  require('$ROOT/lib/embeddings');
  require('$ROOT/lib/http-home');
" 2>&1; then
  pass "core modules load"
else
  fail "core modules" "one or more core modules failed to load"
fi

# ---------------------------------------------------------------------------
# 2. Provider config exports
# ---------------------------------------------------------------------------
echo ""
echo "=== 2. Provider config ==="
if node -e "
  const pc = require('$ROOT/lib/provider-config');
  if (!Array.isArray(pc.SUPPORTED_FAMILIES) || pc.SUPPORTED_FAMILIES.length === 0)
    throw new Error('SUPPORTED_FAMILIES missing or empty');
  if (!pc.GROUPS || Object.keys(pc.GROUPS).length === 0)
    throw new Error('GROUPS missing or empty');
  console.log('families:', pc.SUPPORTED_FAMILIES.join(', '));
  console.log('groups:', Object.keys(pc.GROUPS).join(', '));
" 2>&1; then
  pass "provider-config exports"
else
  fail "provider-config" "exports check failed"
fi

# ---------------------------------------------------------------------------
# 3. Routing policy exports
# ---------------------------------------------------------------------------
echo ""
echo "=== 3. Routing policy ==="
if node -e "
  const rp = require('$ROOT/lib/routing-policy');
  const kinds = Object.keys(rp.TASK_KIND_TARGETS || {}).length;
  if (kinds === 0) throw new Error('TASK_KIND_TARGETS empty');
  const effort = Object.keys(rp.EFFORT_LEVELS || {}).length;
  if (effort === 0) throw new Error('EFFORT_LEVELS empty');
  console.log('task kinds:', kinds, 'effort levels:', effort);
" 2>&1; then
  pass "routing-policy exports"
else
  fail "routing-policy" "exports check failed"
fi

# ---------------------------------------------------------------------------
# 4. Memory module load smoke
# ---------------------------------------------------------------------------
echo ""
echo "=== 4. Memory module load smoke ==="
if node "$ROOT/data/memory-load-smoke.js" 2>&1; then
  pass "memory-load-smoke"
else
  fail "memory-load-smoke" "data/memory-load-smoke.js failed"
fi

# ---------------------------------------------------------------------------
# 5. Memory wire smoke (integration check: routing/transforms wired correctly)
# ---------------------------------------------------------------------------
echo ""
echo "=== 5. Memory wire smoke ==="
if node "$ROOT/data/memory-wire-smoke.js" 2>&1; then
  pass "memory-wire-smoke"
else
  fail "memory-wire-smoke" "data/memory-wire-smoke.js failed"
fi

# ---------------------------------------------------------------------------
# 6. No-mempalace smoke (verifies old stack is removed)
# ---------------------------------------------------------------------------
echo ""
echo "=== 6. No-mempalace smoke ==="
if bash "$ROOT/data/smoke-no-mempalace.sh" 2>&1; then
  pass "no-mempalace-smoke"
else
  fail "no-mempalace-smoke" "data/smoke-no-mempalace.sh failed"
fi

# ---------------------------------------------------------------------------
# 7. Brand scan — "legacy-source" must not appear in runtime/config files
# ---------------------------------------------------------------------------
echo ""
echo "=== 7. Brand scan (legacy-source) ==="

BRAND_FILES=(
  "$ROOT/llm-proxy.js"
  "$ROOT/lib/routing.js"
  "$ROOT/lib/transforms.js"
  "$ROOT/lib/memory/index.js"
  "$ROOT/lib/provider-config.js"
  "$ROOT/lib/routing-policy.js"
  "$ROOT/lib/provider-adapters.js"
  "$ROOT/lib/anthropic-gateway.js"
  "$ROOT/docker-compose.yml"
  "$ROOT/.env.example"
  "$ROOT/README.md"
  "$ROOT/INSTRUCTIONS.md"
  "$ROOT/package.json"
)

for f in "${BRAND_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    fail "brand:$(basename "$f")" "file not found: $f"
    continue
  fi
  if grep -qi '\blegacy-source\b' "$f"; then
    fail "brand:$(basename "$f")" "found 'legacy-source' in $f"
  else
    pass "brand:$(basename "$f")"
  fi
done

# ---------------------------------------------------------------------------
# 8. Brand scan — "mempalace" must not appear in runtime/config files
# ---------------------------------------------------------------------------
echo ""
echo "=== 8. Brand scan (mempalace) ==="

MEMPALACE_FILES=(
  "$ROOT/docker-compose.yml"
  "$ROOT/.env.example"
  "$ROOT/llm-proxy.js"
  "$ROOT/lib/routing.js"
  "$ROOT/lib/transforms.js"
  "$ROOT/INSTRUCTIONS.md"
)

for f in "${MEMPALACE_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    fail "mempalace:$(basename "$f")" "file not found: $f"
    continue
  fi
  if grep -qi 'mempalace' "$f"; then
    fail "mempalace:$(basename "$f")" "found 'mempalace' in $f"
  else
    pass "mempalace:$(basename "$f")"
  fi
done

# ---------------------------------------------------------------------------
# 9. Docker compose file is valid YAML (basic parse)
# ---------------------------------------------------------------------------
echo ""
echo "=== 9. docker-compose.yml sanity ==="
if node -e "
  const fs = require('fs');
  const txt = fs.readFileSync('$ROOT/docker-compose.yml', 'utf8');
  if (!txt.includes('llm-proxy:')) throw new Error('llm-proxy service missing');
  if (!txt.includes('18900')) throw new Error('port 18900 missing');
  console.log('compose sanity ok');
" 2>&1; then
  pass "docker-compose sanity"
else
  fail "docker-compose" "sanity check failed"
fi

# ---------------------------------------------------------------------------
# 10. .env.example has memory/Neo4j/Graphiti config blocks
# ---------------------------------------------------------------------------
echo ""
echo "=== 10. .env.example memory config ==="
if node -e "
  const fs = require('fs');
  const txt = fs.readFileSync('$ROOT/.env.example', 'utf8');
  if (!txt.includes('MEMORY_ENABLED')) throw new Error('MEMORY_ENABLED missing');
  if (!txt.includes('NEO4J_URI')) throw new Error('NEO4J_URI missing');
  if (!txt.includes('GRAPHITI_MCP_ENABLED')) throw new Error('GRAPHITI_MCP_ENABLED missing');
  console.log('.env.example memory config ok');
" 2>&1; then
  pass ".env.example memory config"
else
  fail ".env.example" "memory/Neo4j/Graphiti config block missing"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=================================================="
echo "Total PASS: $TOTAL_PASS   Total FAIL: $TOTAL_FAIL"
echo "=================================================="

if [ "$FAIL" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED — see above"
  exit 1
fi
