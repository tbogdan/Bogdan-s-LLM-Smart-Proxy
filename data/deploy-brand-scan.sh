#!/usr/bin/env bash
set -euo pipefail
if grep -rniE 'legacy-source|mempalace' README.md .env.example docker-compose.yml llm-proxy.js lib/ 2>/dev/null; then
  echo 'forbidden branding found'
  exit 1
fi
echo 'deploy branding clean'
