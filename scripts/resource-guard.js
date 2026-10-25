#!/usr/bin/env node
"use strict";

// Compose accepts zero memory/CPU and -1 PIDs as unlimited. Refuse to start
// either application with those settings, including on an existing Codex image.
function validateResourceEnvironment(env) {
  const invalid = [];
  const memory = String(env.PROXY_RESOURCE_MEMORY || "").trim();
  const match = memory.match(/^(\d+(?:\.\d+)?)\s*(b|[kmgtp](?:i?b)?)?$/i);
  const unit = match?.[2]?.[0]?.toLowerCase() || "b";
  const multiplier = {b:1,k:1024,m:1024**2,g:1024**3,t:1024**4,p:1024**5}[unit];
  const bytes = match ? Math.floor(Number(match[1]) * multiplier) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) invalid.push("memory");
  const cpu = Number(env.PROXY_RESOURCE_CPUS);
  if (!Number.isFinite(cpu) || cpu < 1e-9 || cpu * 1e9 > Number.MAX_SAFE_INTEGER) invalid.push("cpus");
  const pids = Number(env.PROXY_RESOURCE_PIDS);
  if (!Number.isSafeInteger(pids) || pids <= 0) invalid.push("pids");
  return invalid;
}

if (require.main === module) {
  const invalid = validateResourceEnvironment(process.env);
  if (invalid.length) {
    process.stderr.write(`Invalid proxy resource settings: ${invalid.join(", ")}; positive finite limits required. Application was not started.\n`);
    process.exitCode = 1;
  }
}
module.exports = { validateResourceEnvironment };
