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

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

function normalizeEffort(value, fallback = "") {
  const text = String(value || "").trim().toLowerCase();
  const normalized = text === "max" ? "xhigh" : text;
  return EFFORTS.includes(normalized) ? normalized : fallback;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function explicitContextForModel(family, modelData = {}) {
  return firstPositiveNumber(
    modelData.max_input_tokens,
    modelData.context_length ||
      modelData.context,
    modelData.contextWindow,
    modelData.context_window,
    modelData.max_context_tokens,
    modelData.maxContextTokens,
    modelData.max_context_window,
    modelData.maxTokens,
    family === "claude" ? undefined : modelData.max_tokens,
  );
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

function isSupportedCapability(value) {
  if (value === true) return true;
  return value && typeof value === "object" && value.supported === true;
}

function capability(modelData, name) {
  return modelData?.capabilities?.[name];
}

function supportedEffortsForModel(family, modelData = {}) {
  const efforts = new Set();
  if (Array.isArray(modelData.supported_reasoning_levels)) {
    for (const level of modelData.supported_reasoning_levels) {
      const effort = normalizeEffort(typeof level === "string" ? level : level?.effort);
      if (effort) efforts.add(effort);
    }
  }
  if (Array.isArray(modelData.supported_thinking_efforts)) {
    for (const level of modelData.supported_thinking_efforts) {
      const effort = normalizeEffort(level);
      if (effort) efforts.add(effort);
    }
  }
  const effortCaps = capability(modelData, "effort");
  if (family === "claude" && isSupportedCapability(effortCaps)) {
    for (const effort of ["low", "medium", "high"]) {
      if (isSupportedCapability(effortCaps?.[effort])) efforts.add(effort);
    }
    if (isSupportedCapability(effortCaps?.max) || isSupportedCapability(effortCaps?.xhigh)) {
      efforts.add("xhigh");
    }
  }
  return EFFORTS.filter((effort) => efforts.has(effort));
}

function defaultThinkingEffort(family, upstream, modelData = {}, supportedEfforts = []) {
  const explicit = normalizeEffort(
    modelData.thinking_effort ||
      modelData.default_reasoning_level ||
      modelData.reasoning_effort ||
      modelData.default_effort,
  );
  if (explicit) return explicit;

  const text = [
    family,
    upstream,
    modelData.id,
    modelData.slug,
    modelData.name,
    modelData.display_name,
    modelData.description,
  ].filter(Boolean).join(" ").replace(/_/g, "-").toLowerCase();

  if (/x[- ]?high|max/.test(text)) return "xhigh";
  if (/\bhigh\b/.test(text)) return "high";
  if (/\bmedium\b/.test(text)) return "medium";
  if (/\blow\b/.test(text)) return "low";
  if (/\bminimal\b/.test(text)) return "minimal";
  if (/\bnone\b/.test(text)) return "none";
  if (/opus/.test(text)) return "xhigh";
  if (/gpt[- _.]?5[- _.]?5|gemini.*pro/.test(text)) return "xhigh";
  if (/codex|gpt[- _.]?5[- _.]?[234]|sonnet|gemini|glm|minimax|swe/.test(text)) return "medium";
  if (/haiku|mini|fast|nano|grok/.test(text)) return "low";
  if (supportedEfforts.length > 0) {
    if (supportedEfforts.includes("medium")) return "medium";
    return supportedEfforts[supportedEfforts.length - 1];
  }
  return "";
}

function outputTokenLimitForModel(family, modelData = {}) {
  return firstPositiveNumber(
    modelData.max_output_tokens,
    modelData.maxOutputTokens,
    modelData.max_completion_tokens,
    modelData.maxCompletionTokens,
    modelData.output_token_limit,
    modelData.output_tokens,
    family === "claude" ? modelData.max_tokens : undefined,
  );
}

function modelTraitsFor(family, upstream, modelData = {}) {
  const sourceId = modelData.id || modelData.slug || modelData.model || upstream;
  const modelId = namespacedId(family, sourceId);
  const context = contextForModel(family, upstream || sourceId, modelData);
  const caps = new Set(inferCapabilities(modelId));
  const supportedEfforts = supportedEffortsForModel(family, modelData);

  if (context >= 128000) caps.add("max");
  if (isSupportedCapability(capability(modelData, "code_execution"))) {
    caps.add("coding");
    caps.add("tools");
  }
  if (isSupportedCapability(capability(modelData, "thinking")) || supportedEfforts.length > 0) {
    caps.add("thinking");
  }
  if (
    isSupportedCapability(capability(modelData, "image_input")) ||
    (Array.isArray(modelData.input_modalities) && modelData.input_modalities.includes("image"))
  ) {
    caps.add("images");
  }
  if (modelData.supports_parallel_tool_calls === true || modelData.apply_patch_tool_type || modelData.shell_type) {
    caps.add("tools");
    caps.add("coding");
  }

  const traits = {
    context,
    caps: [...caps],
    tc: caps.has("thinking"),
  };
  const maxTokens = outputTokenLimitForModel(family, modelData);
  if (maxTokens) traits.max_tokens = maxTokens;
  if (modelData.display_name) traits.display_name = modelData.display_name;
  if (modelData.description) traits.description = modelData.description;
  if (modelData.type) traits.source_type = modelData.type;
  if (modelData.created_at) traits.created_at = modelData.created_at;
  if (modelData.context_window != null) traits.context_window = Number(modelData.context_window);
  if (modelData.max_context_window != null) traits.max_context_window = Number(modelData.max_context_window);
  if (modelData.truncation_policy && typeof modelData.truncation_policy === "object") {
    traits.truncation_policy = modelData.truncation_policy;
  }

  if (supportedEfforts.length > 0) traits.supported_thinking_efforts = supportedEfforts;
  const thinkingEffort = defaultThinkingEffort(family, upstream || sourceId, modelData, supportedEfforts);
  if (thinkingEffort) traits.thinking_effort = thinkingEffort;

  if (family === "claude") {
    traits.supports_code_execution = isSupportedCapability(capability(modelData, "code_execution"));
    traits.supports_context_management = isSupportedCapability(capability(modelData, "context_management"));
    traits.supports_context_compaction = isSupportedCapability(capability(modelData, "context_management")?.compact_20260112);
    traits.supports_adaptive_thinking = isSupportedCapability(capability(modelData, "thinking")?.types?.adaptive);
    traits.supports_extended_thinking = isSupportedCapability(capability(modelData, "thinking")?.types?.enabled);
    traits.supports_structured_outputs = isSupportedCapability(capability(modelData, "structured_outputs"));
    traits.supports_pdf_input = isSupportedCapability(capability(modelData, "pdf_input"));
  }

  if (family === "codex") {
    if (modelData.default_verbosity) traits.default_verbosity = modelData.default_verbosity;
    if (modelData.support_verbosity != null) traits.supports_verbosity = modelData.support_verbosity === true;
    if (modelData.supports_parallel_tool_calls != null) traits.supports_parallel_tool_calls = modelData.supports_parallel_tool_calls === true;
    if (modelData.supports_search_tool != null) traits.supports_search_tool = modelData.supports_search_tool === true;
    if (modelData.shell_type) traits.shell_type = modelData.shell_type;
    if (modelData.apply_patch_tool_type) traits.apply_patch_tool_type = modelData.apply_patch_tool_type;
    if (modelData.web_search_tool_type) traits.web_search_tool_type = modelData.web_search_tool_type;
    if (modelData.default_service_tier) traits.default_service_tier = modelData.default_service_tier;
    if (Array.isArray(modelData.service_tiers)) traits.service_tiers = modelData.service_tiers;
    if (Array.isArray(modelData.additional_speed_tiers)) traits.additional_speed_tiers = modelData.additional_speed_tiers;
    if (Array.isArray(modelData.input_modalities)) traits.input_modalities = modelData.input_modalities;
    if (modelData.priority != null) traits.priority = Number(modelData.priority);
    if (modelData.visibility) traits.visibility = modelData.visibility;
    if (modelData.supported_in_api != null) traits.supported_in_api = modelData.supported_in_api === true;
  }

  return traits;
}

function providerForModel(family, model) {
  const protocol = family === "claude" ? "anthropic" : family === "windsurf" ? "windsurf" : "openai";
  const keyEnv = family === "claude" ? "ANTHROPIC_API_KEY" : family === "windsurf" ? "WINDSURF_API_KEY" : "CODEX_API_KEY";
  const traits = modelTraitsFor(family, model.upstream, model);
  const provider = {
    name: model.name,
    family,
    protocol,
    url: runtimeUrlForFamily(family),
    key_env: keyEnv,
    model: model.id,
    upstream_model: model.upstream,
    context: traits.context || model.context,
    tier: model.tier,
    tc: traits.tc,
    caps: traits.caps,
    headers: {},
    seed: true,
    ...traits,
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
  modelTraitsFor,
  providerForModel,
  runtimeUrlForFamily,
  resolveProviderUrl,
  resolveKeyEnv,
  buildSeedConfig,
};
