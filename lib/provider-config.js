"use strict";

const SUPPORTED_FAMILIES = ["windsurf", "claude", "codex"];

const GROUPS = {
  "auto-tools": "tools",
  "auto-coding": "coding",
  "coding-sm": "coding-sm",
  "auto-text": "text",
  "auto-max": "max",
  "auto-thinking": "thinking",
};

const FALLBACK_MODELS = {
  windsurf: [
    { id: "windsurf/adaptive", upstream: "adaptive", windsurf_model_uid: "adaptive", name: "Windsurf-Adaptive", context: 200000, tier: 1 },
    { id: "windsurf/swe-1.6-fast", upstream: "swe-1.6-fast", windsurf_model_uid: "swe-1-6-fast", name: "Windsurf-SWE16Fast", context: 200000, tier: 1 },
    { id: "windsurf/swe-1.6", upstream: "swe-1.6", windsurf_model_uid: "swe-1-6", name: "Windsurf-SWE16", context: 200000, tier: 1 },
    { id: "windsurf/swe-1.5-fast", upstream: "swe-1.5-fast", windsurf_model_uid: "swe-1-5", name: "Windsurf-SWE15Fast", context: 200000, tier: 2 },
    { id: "windsurf/swe-1.5", upstream: "swe-1.5", windsurf_model_uid: "swe-1-5", name: "Windsurf-SWE15", context: 200000, tier: 2 },
    { id: "windsurf/swe-1", upstream: "swe-1", windsurf_model_uid: "swe-1", name: "Windsurf-SWE1", context: 200000, tier: 2 },
    { id: "windsurf/gpt-5.5", upstream: "gpt-5.5", windsurf_model_uid: "gpt-5-5", name: "Windsurf-GPT55", context: 1000000, tier: 1 },
    { id: "windsurf/gpt-5.4", upstream: "gpt-5.4", windsurf_model_uid: "gpt-5-4", name: "Windsurf-GPT54", context: 200000, tier: 1 },
    { id: "windsurf/gpt-5.4-mini", upstream: "gpt-5.4-mini", windsurf_model_uid: "gpt-5-4-mini", name: "Windsurf-GPT54Mini", context: 200000, tier: 1 },
    { id: "windsurf/gpt-5.3-codex-spark", upstream: "gpt-5.3-codex-spark", windsurf_model_uid: "gpt-5-3-codex-spark", name: "Windsurf-GPT53CodexSpark", context: 200000, tier: 1 },
    { id: "windsurf/claude-opus-4.7", upstream: "claude-opus-4.7", windsurf_model_uid: "claude-opus-4-7", name: "Windsurf-ClaudeOpus47", context: 200000, tier: 1 },
    { id: "windsurf/claude-opus-4.6", upstream: "claude-opus-4.6", windsurf_model_uid: "claude-opus-4-6", name: "Windsurf-ClaudeOpus46", context: 200000, tier: 1 },
    { id: "windsurf/claude-sonnet-4.6", upstream: "claude-sonnet-4.6", windsurf_model_uid: "claude-sonnet-4-6", name: "Windsurf-ClaudeSonnet46", context: 200000, tier: 1 },
    { id: "windsurf/gemini-3.1-pro", upstream: "gemini-3.1-pro", windsurf_model_uid: "gemini-3-1-pro", name: "Windsurf-Gemini31Pro", context: 200000, tier: 1 },
    { id: "windsurf/glm-5", upstream: "glm-5", windsurf_model_uid: "glm-5", name: "Windsurf-GLM5", context: 200000, tier: 2 },
    { id: "windsurf/minimax-m2.5", upstream: "minimax-m2.5", windsurf_model_uid: "minimax-m2-5", name: "Windsurf-MinimaxM25", context: 200000, tier: 2 },
    { id: "windsurf/grok-code-fast-1", upstream: "grok-code-fast-1", windsurf_model_uid: "grok-code-fast-1", name: "Windsurf-GrokCodeFast1", context: 200000, tier: 2 },
  ],
  claude: [
    { id: "claude/claude-opus-4-7", upstream: "claude-opus-4-7", name: "Claude-Opus47", context: 1000000, tier: 1 },
    { id: "claude/claude-sonnet-4-6", upstream: "claude-sonnet-4-6", name: "Claude-Sonnet46", context: 1000000, tier: 1 },
    { id: "claude/claude-opus-4-6", upstream: "claude-opus-4-6", name: "Claude-Opus46", context: 1000000, tier: 1 },
    { id: "claude/claude-opus-4-5-20251101", upstream: "claude-opus-4-5-20251101", name: "Claude-Opus45", context: 200000, tier: 1 },
    { id: "claude/claude-haiku-4-5-20251001", upstream: "claude-haiku-4-5-20251001", name: "Claude-Haiku45", context: 200000, tier: 2 },
    { id: "claude/claude-sonnet-4-5-20250929", upstream: "claude-sonnet-4-5-20250929", name: "Claude-Sonnet45", context: 200000, tier: 1 },
    { id: "claude/claude-opus-4-1-20250805", upstream: "claude-opus-4-1-20250805", name: "Claude-Opus41", context: 200000, tier: 1 },
    { id: "claude/claude-opus-4-20250514", upstream: "claude-opus-4-20250514", name: "Claude-Opus4", context: 200000, tier: 1 },
    { id: "claude/claude-sonnet-4-20250514", upstream: "claude-sonnet-4-20250514", name: "Claude-Sonnet4", context: 200000, tier: 1 },
  ],
  codex: [
    { id: "codex/gpt-5.5", upstream: "gpt-5.5", name: "Codex-GPT55", context: 1000000, tier: 1 },
    { id: "codex/gpt-5.4", upstream: "gpt-5.4", name: "Codex-GPT54", context: 200000, tier: 1 },
    { id: "codex/gpt-5.4-mini", upstream: "gpt-5.4-mini", name: "Codex-GPT54Mini", context: 200000, tier: 1 },
    { id: "codex/gpt-5.3-codex", upstream: "gpt-5.3-codex", name: "Codex-GPT53Codex", context: 200000, tier: 1 },
    { id: "codex/gpt-5.2", upstream: "gpt-5.2", name: "Codex-GPT52", context: 200000, tier: 1 },
    { id: "codex/codex-auto-review", upstream: "codex-auto-review", name: "Codex-AutoReview", context: 200000, tier: 2 },
  ],
};

function explicitContextForModel(family, modelData = {}) {
  const explicit = (
    modelData.max_input_tokens ||
    modelData.context_length ||
    modelData.context ||
    modelData.contextWindow ||
    modelData.max_context_tokens ||
    modelData.maxContextTokens ||
    modelData.maxTokens ||
    (family === "claude" ? undefined : modelData.max_tokens)
  );
  const value = Number(explicit);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function inferCapabilities(modelId) {
  const id = String(modelId || "").toLowerCase();
  const caps = new Set(["text"]);
  if (/adaptive|claude|gpt|codex|swe|gemini|glm|minimax|grok.*code/.test(id)) caps.add("coding");
  if (/adaptive|claude|gpt|codex|swe|gemini|glm|minimax|grok/.test(id)) caps.add("tools");
  if (/adaptive|claude|gpt-5|codex|swe|gemini|glm|grok/.test(id)) caps.add("thinking");
  if (/adaptive|opus|sonnet|gpt-5\.5|gpt-5\.4|codex|gemini.*pro/.test(id)) caps.add("max");
  return [...caps];
}

function namespacedId(family, id) {
  const value = String(id || "").trim();
  if (!value) return "";
  return value.startsWith(`${family}/`) ? value : `${family}/${value.replace(/^windsurf\//, "").replace(/^claude\//, "").replace(/^codex\//, "")}`;
}

function catalogModelFor(family, modelId) {
  const normalized = namespacedId(family, modelId);
  const upstream = normalized.split("/").slice(1).join("/");
  return (FALLBACK_MODELS[family] || []).find((model) => (
    model.id === normalized ||
    model.upstream === modelId ||
    model.upstream === upstream ||
    model.windsurf_model_uid === modelId
  )) || null;
}

function contextForModel(family, upstream, modelData = {}) {
  const explicit = explicitContextForModel(family, modelData);
  const catalog = catalogModelFor(family, upstream);
  if (explicit) return explicit;
  if (catalog?.context) return catalog.context;
  if (family === "claude" || family === "windsurf") return 200000;
  if (family === "codex") return /gpt-5\.5/i.test(String(upstream || "")) ? 1000000 : 200000;
  return 4096;
}

function providerForModel(family, model) {
  const protocol = family === "claude" ? "anthropic" : family === "windsurf" ? "windsurf" : "openai";
  const keyEnv = family === "claude" ? "ANTHROPIC_API_KEY" : family === "windsurf" ? "WINDSURF_API_KEY" : "CODEX_API_KEY";
  const provider = {
    name: model.name,
    family,
    protocol,
    url: runtimeUrlForFamily(family),
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
  if (family === "windsurf" && model.windsurf_model_uid) provider.windsurf_model_uid = model.windsurf_model_uid;
  return provider;
}

function runtimeUrlForFamily(family) {
  if (family === "codex") return "http://codex-proxy:10531/v1/chat/completions";
  if (family === "claude") return "claude";
  if (family === "windsurf") return "windsurf";
  return "";
}

function resolveProviderUrl(provider) {
  return provider?.url || runtimeUrlForFamily(provider?.family);
}

function resolveKeyEnv(provider, env = process.env) {
  const keyEnv = provider?.key_env || "";
  if (
    provider?.family === "claude" &&
    keyEnv === "CLAUDE_CODE_OAUTH_TOKEN" &&
    !env.CLAUDE_CODE_OAUTH_TOKEN &&
    env.ANTHROPIC_API_KEY
  ) {
    return "ANTHROPIC_API_KEY";
  }
  if (
    provider?.family === "claude" &&
    keyEnv === "ANTHROPIC_API_KEY" &&
    !env.ANTHROPIC_API_KEY &&
    env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    return "CLAUDE_CODE_OAUTH_TOKEN";
  }
  return keyEnv;
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
  namespacedId,
  catalogModelFor,
  contextForModel,
  providerForModel,
  runtimeUrlForFamily,
  resolveProviderUrl,
  resolveKeyEnv,
  buildSeedConfig,
};
