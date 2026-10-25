"use strict";

// Idempotent curator for the Antigravity provider family:
// adds/refreshes gemini-interactions routes in data/providers.json.
// Writes a timestamped backup before mutating.

const fs = require("fs");
const path = require("path");

const PROVIDERS_FILE = path.join(__dirname, "..", "data", "providers.json");
const BASE = "https://generativelanguage.googleapis.com/v1beta/interactions";

const AGENTS = [
  { id: "antigravity-preview-latest", name: "Antigravity-Agent-Preview-Latest" },
  { id: "antigravity-preview-09-2026", name: "Antigravity-Agent-Preview-09-2026" },
  { id: "antigravity-preview-05-2026", name: "Antigravity-Agent-Preview-05-2026" },
];

function routeFor(agent) {
  return {
    name: agent.name,
    url: BASE,
    key_env: "GEMINI_API_KEY",
    model: `antigravity/${agent.id}`,
    context: 1048576,
    tier: 1,
    tc: true,
    caps: ["tools", "coding", "text", "images", "thinking", "max"],
    headers: {},
    family: "antigravity",
    protocol: "gemini-interactions",
    upstream_model: agent.id,
    seed: false,
    alive: true,
    last_tested: new Date().toISOString(),
    max_tokens: 65536,
    source: "gemini-interactions:curated",
    source_type: "local_curated",
    input_modalities: ["text", "image"],
  };
}

const raw = fs.readFileSync(PROVIDERS_FILE, "utf8");
const config = JSON.parse(raw);
const backup = path.join(__dirname, "..", "data", `providers.json.bak-antigravity-${Date.now()}`);
fs.writeFileSync(backup, raw, { mode: 0o600 });

const existing = new Map();
for (const provider of config.providers) {
  if (provider.family === "antigravity" && provider.upstream_model) existing.set(provider.upstream_model, provider);
}

let added = 0;
let refreshed = 0;
for (const agent of AGENTS) {
  const desired = routeFor(agent);
  if (existing.has(agent.id)) {
    const current = existing.get(agent.id);
    for (const [key, value] of Object.entries(desired)) {
      if (JSON.stringify(current[key]) !== JSON.stringify(value)) current[key] = value;
    }
    refreshed += 1;
  } else {
    config.providers.push(desired);
    added += 1;
  }
}

fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 1) + "\n");
console.log(JSON.stringify({ added, refreshed, backup: path.relative(process.cwd(), backup), total: config.providers.length }, null, 2));
