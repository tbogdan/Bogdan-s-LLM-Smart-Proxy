#!/usr/bin/env bash
set -euo pipefail
grep -q '18920:18900' docker-compose.yml || { echo "port 18920 not mapped"; exit 1; }
grep -q 'graphiti-mcp' docker-compose.yml || { echo "graphiti-mcp service missing"; exit 1; }
grep -q 'neo4j' docker-compose.yml || { echo "neo4j service missing"; exit 1; }
echo 'compose port isolation ok'
