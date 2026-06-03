"use strict";

const SUPPORTED_FAMILIES = ["windsurf", "claude", "codex", "copilot"];

const SUPPORTED_PROTOCOLS = {
  claude: "anthropic",
  codex: "openai",
  copilot: "openai",
  windsurf: "windsurf",
};

const GROUPS = {
  "auto-tools": "tools",
  "auto-assess": "assessment",
  "auto-sm": "text-sm",
  "auto-memory": "memory",
  "auto-coding": "coding",
  "coding-sm": "coding-sm",
  "auto-text": "text",
  "auto-max": "max",
  "auto-thinking": "thinking",
};

const SEED_CATALOG = require("../seed-providers.json");

function fallbackModelFromSeedProvider(provider = {}) {
  const upstream = provider.upstream_model || String(provider.model || "").split("/").slice(1).join("/");
  const model = {
    id: provider.model,
    upstream,
    name: provider.name,
    context: provider.context,
    tier: provider.tier,
  };
  const passthroughFields = [
    "windsurf_model_uid",
    "headers",
    "max_tokens",
    "max_tools",
    "app_cost_tier",
    "cost_multiplier",
    "cost_group",
    "quality_group",
    "speed_group",
    "thinking_effort",
    "thinking_level",
    "description",
    "display_name",
    "source",
    "source_type",
    "created_at",
    "context_window",
    "max_context_window",
    "supported_thinking_efforts",
    "supports_code_execution",
    "supports_context_management",
    "supports_context_compaction",
    "supports_adaptive_thinking",
    "supports_extended_thinking",
    "supports_structured_outputs",
    "supports_pdf_input",
    "supports_parallel_tool_calls",
    "supports_tool_calls",
    "supports_streaming",
    "supports_search_tool",
    "supports_verbosity",
    "default_verbosity",
    "shell_type",
    "apply_patch_tool_type",
    "web_search_tool_type",
    "default_service_tier",
    "service_tiers",
    "additional_speed_tiers",
    "input_modalities",
    "priority",
    "visibility",
    "supported_in_api",
    "truncation_policy",
    "vendor",
    "version",
    "tokenizer",
    "model_picker_enabled",
    "model_picker_category",
    "is_chat_default",
    "is_chat_fallback",
    "supported_endpoints",
  ];
  for (const field of passthroughFields) {
    if (provider[field] !== undefined) model[field] = provider[field];
  }
  return model;
}

function fallbackModelsFromSeed(seedProviders = []) {
  const models = Object.fromEntries(SUPPORTED_FAMILIES.map((family) => [family, []]));
  for (const provider of seedProviders) {
    const family = provider?.family;
    if (!SUPPORTED_FAMILIES.includes(family)) continue;
    if (provider.protocol !== SUPPORTED_PROTOCOLS[family]) continue;
    if (typeof provider.model !== "string" || !provider.model.startsWith(`${family}/`)) continue;
    models[family].push(fallbackModelFromSeedProvider(provider));
  }
  return models;
}

const FALLBACK_MODELS = fallbackModelsFromSeed(SEED_CATALOG.providers || []);

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

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === "" || value === null || value === undefined) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function costMultiplierFromModelData(modelData = {}) {
  const multiplier = firstFiniteNumber(
    modelData.cost_multiplier,
    modelData.costMultiplier,
    modelData.billing?.multiplier,
    modelData.billing_multiplier,
    modelData.multiplier,
  );
  return multiplier === undefined || multiplier < 0 ? undefined : multiplier;
}

function explicitContextForModel(family, modelData = {}) {
  const limits = modelData.capabilities?.limits || {};
  return firstPositiveNumber(
    modelData.max_input_tokens,
    limits.max_context_window_tokens,
    limits.max_prompt_tokens,
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
  if (/adaptive|claude|gpt[- _.]?(?:4|5)|codex|swe|gemini|glm|grok|copilot/.test(id)) caps.add("thinking");
  if (/adaptive|opus|sonnet|gpt-5\.5|gpt-5\.4|codex|gemini.*pro/.test(id)) caps.add("max");
  return [...caps];
}

function namespacedId(family, id) {
  const value = String(id || "").trim();
  if (!value) return "";
  return value.startsWith(`${family}/`)
    ? value
    : `${family}/${value.replace(/^windsurf\//, "").replace(/^claude\//, "").replace(/^codex\//, "").replace(/^copilot\//, "")}`;
}

function isSupportedProvider(provider) {
  if (!provider || typeof provider !== "object") return false;
  if (!SUPPORTED_FAMILIES.includes(provider.family)) return false;
  if (provider.protocol !== SUPPORTED_PROTOCOLS[provider.family]) return false;
  return typeof provider.model === "string" && provider.model.startsWith(`${provider.family}/`);
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
  if (family === "copilot") return 128000;
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
  const nestedReasoningEfforts = modelData.capabilities?.supports?.reasoning_effort;
  if (Array.isArray(nestedReasoningEfforts)) {
    for (const level of nestedReasoningEfforts) {
      const effort = normalizeEffort(level);
      if (effort) efforts.add(effort);
    }
  }
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
  if (/copilot|gpt[- _.]?4[- _.]?1/.test(text)) return "medium";
  if (/haiku|mini|fast|nano|grok/.test(text)) return "low";
  if (supportedEfforts.length > 0) {
    if (supportedEfforts.includes("medium")) return "medium";
    return supportedEfforts[supportedEfforts.length - 1];
  }
  return "";
}

function outputTokenLimitForModel(family, modelData = {}) {
  const limits = modelData.capabilities?.limits || {};
  return firstPositiveNumber(
    modelData.max_output_tokens,
    limits.max_output_tokens,
    limits.max_non_streaming_output_tokens,
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
    (Array.isArray(modelData.input_modalities) && modelData.input_modalities.includes("image")) ||
    Boolean(modelData.capabilities?.limits?.vision)
  ) {
    caps.add("images");
  }
  if (
    modelData.supports_parallel_tool_calls === true ||
    modelData.capabilities?.supports?.parallel_tool_calls === true ||
    modelData.capabilities?.supports?.tool_calls === true ||
    modelData.apply_patch_tool_type ||
    modelData.shell_type
  ) {
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
  const maxTools = firstPositiveNumber(
    modelData.max_tools,
    modelData.maxTools,
    modelData.max_tool_count,
    modelData.capabilities?.limits?.max_tools,
    modelData.capabilities?.limits?.max_tool_count,
    family === "copilot" ? 128 : undefined,
    family === "windsurf" && /gemini/i.test(`${upstream || ""} ${sourceId || ""}`) ? 128 : undefined,
  );
  if (maxTools) traits.max_tools = maxTools;
  const costMultiplier = costMultiplierFromModelData(modelData);
  if (costMultiplier !== undefined) traits.cost_multiplier = costMultiplier;
  if (modelData.display_name) traits.display_name = modelData.display_name;
  if (modelData.description) traits.description = modelData.description;
  if (modelData.type) traits.source_type = modelData.type;
  if (modelData.created_at) traits.created_at = modelData.created_at;
  if (modelData.context_window != null) traits.context_window = Number(modelData.context_window);
  if (modelData.max_context_window != null) traits.max_context_window = Number(modelData.max_context_window);
  if (modelData.capabilities?.limits?.max_context_window_tokens != null) {
    traits.max_context_window = Number(modelData.capabilities.limits.max_context_window_tokens);
  }
  if (modelData.vendor) traits.vendor = modelData.vendor;
  if (modelData.version) traits.version = modelData.version;
  if (modelData.model_picker_enabled != null) traits.model_picker_enabled = modelData.model_picker_enabled === true;
  if (modelData.model_picker_category) traits.model_picker_category = modelData.model_picker_category;
  if (modelData.is_chat_default != null) traits.is_chat_default = modelData.is_chat_default === true;
  if (modelData.is_chat_fallback != null) traits.is_chat_fallback = modelData.is_chat_fallback === true;
  if (Array.isArray(modelData.supported_endpoints)) traits.supported_endpoints = modelData.supported_endpoints;
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

  if (family === "copilot") {
    const supports = modelData.capabilities?.supports || {};
    if (supports.parallel_tool_calls != null) traits.supports_parallel_tool_calls = supports.parallel_tool_calls === true;
    if (supports.structured_outputs != null) traits.supports_structured_outputs = supports.structured_outputs === true;
    if (supports.tool_calls != null) traits.supports_tool_calls = supports.tool_calls === true;
    if (supports.adaptive_thinking != null) traits.supports_adaptive_thinking = supports.adaptive_thinking === true;
    if (supports.streaming != null) traits.supports_streaming = supports.streaming === true;
    if (modelData.capabilities?.type) traits.source_type = modelData.capabilities.type;
    if (modelData.capabilities?.tokenizer) traits.tokenizer = modelData.capabilities.tokenizer;
  }

  return traits;
}

function providerForModel(family, model) {
  const protocol = family === "claude" ? "anthropic" : family === "windsurf" ? "windsurf" : "openai";
  const keyEnv = family === "claude"
    ? "ANTHROPIC_API_KEY"
    : family === "windsurf"
      ? "WINDSURF_API_KEY"
      : family === "copilot"
        ? "COPILOT_GITHUB_TOKEN"
        : "CODEX_API_KEY";
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
    headers: model.headers || {},
    seed: true,
    ...traits,
  };
  if (family === "windsurf" && model.windsurf_model_uid) provider.windsurf_model_uid = model.windsurf_model_uid;
  return provider;
}

function runtimeUrlForFamily(family) {
  if (family === "codex") return "http://codex-proxy:10531/v1/chat/completions";
  if (family === "copilot") return "https://api.githubcopilot.com/chat/completions";
  if (family === "claude") return "claude";
  if (family === "windsurf") return "windsurf";
  return "";
}

function runtimeModelsUrlForFamily(family) {
  if (family === "copilot") return "https://api.githubcopilot.com/models";
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
  if (provider?.family === "copilot" && keyEnv === "COPILOT_GITHUB_TOKEN") {
    for (const candidate of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
      if (env[candidate]) return candidate;
    }
  }
  return keyEnv;
}

function buildSeedConfig() {
  const providers = (SEED_CATALOG.providers || [])
    .filter((provider) => {
      const family = provider?.family;
      return SUPPORTED_FAMILIES.includes(family) &&
        provider.protocol === SUPPORTED_PROTOCOLS[family] &&
        typeof provider.model === "string" &&
        provider.model.startsWith(`${family}/`);
    })
    .map((provider) => ({ ...provider }));
  return { providers, groups: GROUPS };
}

module.exports = {
  SUPPORTED_FAMILIES,
  SUPPORTED_PROTOCOLS,
  GROUPS,
  FALLBACK_MODELS,
  isSupportedProvider,
  inferCapabilities,
  namespacedId,
  catalogModelFor,
  contextForModel,
  modelTraitsFor,
  providerForModel,
  runtimeUrlForFamily,
  runtimeModelsUrlForFamily,
  resolveProviderUrl,
  resolveKeyEnv,
  buildSeedConfig,
};
