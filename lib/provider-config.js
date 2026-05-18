"use strict";

const SUPPORTED_FAMILIES = ["windsurf", "claude", "codex"];

const GROUPS = {
  "auto-tools": "tools",
  "auto-coding": "coding",
  "auto-text": "text",
  "auto-max": "max",
  "auto-thinking": "thinking",
};

const FALLBACK_MODELS = {
  windsurf: [
    { id: "windsurf/swe-1.6-fast", upstream: "swe-1.6-fast", name: "Windsurf-SWE16Fast", context: 200000, tier: 1 },
    { id: "windsurf/swe-1.6", upstream: "swe-1.6", name: "Windsurf-SWE16", context: 200000, tier: 1 },
    { id: "windsurf/swe-1.5-fast", upstream: "swe-1.5-fast", name: "Windsurf-SWE15Fast", context: 200000, tier: 2 },
  ],
  claude: [
    { id: "claude/claude-opus-4-5", upstream: "claude-opus-4-5", name: "Claude-Opus45", context: 200000, tier: 1 },
    { id: "claude/claude-sonnet-4-5", upstream: "claude-sonnet-4-5", name: "Claude-Sonnet45", context: 200000, tier: 1 },
    { id: "claude/claude-sonnet-4", upstream: "claude-sonnet-4", name: "Claude-Sonnet4", context: 200000, tier: 1 },
    { id: "claude/claude-haiku-4-5", upstream: "claude-haiku-4-5", name: "Claude-Haiku45", context: 200000, tier: 2 },
  ],
  codex: [
    { id: "codex/gpt-5.5", upstream: "gpt-5.5", name: "Codex-GPT55", context: 1000000, tier: 1 },
    { id: "codex/gpt-5.4", upstream: "gpt-5.4", name: "Codex-GPT54", context: 200000, tier: 1 },
    { id: "codex/gpt-5.4-mini", upstream: "gpt-5.4-mini", name: "Codex-GPT54Mini", context: 200000, tier: 1 },
    { id: "codex/gpt-5.3-codex", upstream: "gpt-5.3-codex", name: "Codex-GPT53Codex", context: 200000, tier: 1 },
    { id: "codex/gpt-5.2", upstream: "gpt-5.2", name: "Codex-GPT52", context: 200000, tier: 1 },
  ],
};

function inferCapabilities(modelId) {
  const id = String(modelId || "").toLowerCase();
  const caps = new Set(["text"]);
  if (/claude|gpt|codex|swe/.test(id)) caps.add("coding");
  if (/claude|gpt|codex|swe/.test(id)) caps.add("tools");
  if (/claude|gpt-5|codex|swe/.test(id)) caps.add("thinking");
  if (/opus|sonnet|gpt-5\.5|gpt-5\.4|codex/.test(id)) caps.add("max");
  return [...caps];
}

function providerForModel(family, model) {
  const protocol = family === "claude" ? "anthropic" : family === "windsurf" ? "windsurf" : "openai";
  const keyEnv = family === "claude" ? "CLAUDE_CODE_OAUTH_TOKEN" : family === "windsurf" ? "WINDSURF_API_KEY" : "CODEX_API_KEY";
  const url = family === "codex" ? "http://codex-proxy:10531/v1/chat/completions" : family;
  return {
    name: model.name,
    family,
    protocol,
    url,
    key_env: keyEnv,
    model: model.id,
    upstream_model: model.upstream,
    context: model.context,
    tier: model.tier,
    tc: inferCapabilities(model.id).includes("thinking"),
    caps: inferCapabilities(model.id),
    headers: {},
    seed: true,
  };
}

function buildSeedConfig() {
  const providers = [];
  for (const family of SUPPORTED_FAMILIES) {
    for (const model of FALLBACK_MODELS[family]) {
      providers.push(providerForModel(family, model));
    }
  }
  return { providers, groups: GROUPS };
}

module.exports = {
  SUPPORTED_FAMILIES,
  GROUPS,
  FALLBACK_MODELS,
  inferCapabilities,
  providerForModel,
  buildSeedConfig,
};
