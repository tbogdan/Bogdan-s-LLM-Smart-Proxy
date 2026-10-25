#!/bin/sh
set -eu
node /opt/proxy-resource-guard.js
exec docker-entrypoint.sh "$@"
