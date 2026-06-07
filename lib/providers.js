"use strict";

const fs = require("fs");
const path = require("path");
const state = require("./state");
const providerConfig = require("./provider-config");

const RUNTIME_METADATA_FIELDS = [
  "max_tokens",
  "max_tools",
  "app_cost_tier",
  "cost_group",
  "quality_group",
  "speed_group",
  "thinking_effort",
  "thinking_level",
  "supported_thinking_efforts",
  "description",
  "display_name",
  "source_type",
  "created_at",
  "source",
  "context_window",
  "max_context_window",
  "supports_code_execution",
  "supports_context_management",
  "supports_context_compaction",
  "supports_adaptive_thinking",
  "supports_extended_thinking",
  "supports_structured_outputs",
  "supports_pdf_input",
  "supports_parallel_tool_calls",
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
  "smart_friend_model_uid",
];

function runtimeMetadata(provider) {
  const metadata = {};
  for (const field of RUNTIME_METADATA_FIELDS) {
    if (provider[field] !== undefined) metadata[field] = provider[field];
  }
  if (metadata.max_tools === undefined && provider.family === "copilot") metadata.max_tools = 128;
  if (
    metadata.max_tools === undefined &&
    provider.family === "windsurf" &&
    /gemini/i.test(`${provider.model || ""} ${provider.upstream_model || ""} ${provider.name || ""}`)
  ) {
    metadata.max_tools = 128;
  }
  return metadata;
}

function mergeSmartGroups(groups = {}) {
  return { ...providerConfig.GROUPS, ...(groups || {}) };
}

// ---------------------------------------------------------------------------
// Load seed-providers.json (bundled fallback)
// ---------------------------------------------------------------------------
function loadSeedProviders() {
  try {
    const raw = fs.readFileSync(state.SEED_FILE, "utf8");
    const seed = JSON.parse(raw);
    return hydrateSeedProviders(seed);
  } catch (err) {
    state.log(`WARN: Failed to load seed-providers.json: ${err.message}`);
    return { providers: [], groups: {} };
  }
}

// ---------------------------------------------------------------------------
// Hydrate URL — resolve Cloudflare account placeholder + provider-config URL
// ---------------------------------------------------------------------------
function resolveUrl(url) {
  const resolved = String(url || "");
  // Cloudflare: replace /accounts/me/ with actual account ID if env var is set
  if (resolved.includes("cloudflare.com") && resolved.includes("/accounts/me/") && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return resolved.replace("/accounts/me/", `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Hydrate a single "supported-family" provider entry (windsurf/claude/codex/copilot)
// ---------------------------------------------------------------------------
function hydrateNewProvider(p, isSeed) {
  const keyEnv = providerConfig.resolveKeyEnv(p);
  return {
    name: p.name,
    url: resolveUrl(providerConfig.resolveProviderUrl(p)),
    key: (keyEnv ? process.env[keyEnv] : null) || p.default_key || (p.no_auth ? "anonymous" : ""),
    key_env: keyEnv,
    no_auth: !!p.no_auth,
    model: p.model,
    family: p.family || "",
    protocol: p.protocol || "openai",
    upstream_model: p.upstream_model || p.model,
    context: p.context || 131072,
    tier: p.tier || 2,
    tc: !!p.tc,
    caps: p.caps || ["text"],
    headers: p.headers || {},
    authHeader: p.auth_style || null,
    alive: p.alive !== false,
    windsurf_model_uid: p.windsurf_model_uid,
    windsurf_version: p.windsurf_version,
    origin: p.origin,
    path: p.path,
    seed: !!isSeed,
    ...runtimeMetadata(p),
  };
}

// ---------------------------------------------------------------------------
// Hydrate a "legacy-family" provider entry (OpenAI, Groq, Ollama, etc.)
// These use old-style fields (key_env, auth_style, kilo, no_auth, etc.)
// ---------------------------------------------------------------------------
function hydrateLegacyProvider(p, isSeed) {
  return {
    name: p.name,
    url: resolveUrl(p.url),
    key: (p.key_env ? process.env[p.key_env] : null) || p.default_key || (p.no_auth ? "anonymous" : ""),
    key_env: p.key_env || "",
    no_auth: !!p.no_auth,
    model: p.model,
    family: p.family || "",
    protocol: p.protocol || "openai",
    upstream_model: p.upstream_model || p.model,
    context: p.context || 131072,
    tier: p.tier || 2,
    tc: !!p.tc,
    caps: p.caps || ["text"],
    headers: p.headers || {},
    authHeader: p.auth_style || null,
    kilo: !!p.kilo,
    alive: p.alive !== false,
    seed: !!isSeed,
    ...runtimeMetadata(p),
  };
}

// ---------------------------------------------------------------------------
// Hydrate seed format into runtime provider objects
// Supports UNION: windsurf/claude/codex/copilot via providerConfig,
// plus all legacy families (OpenAI, OpenRouter, Groq, Ollama, etc.) directly.
// ---------------------------------------------------------------------------
function hydrateSeedProviders(config) {
  const providers = [];
  const legacyProviders = [];
  for (const p of (config.providers || [])) {
    if (providerConfig.isSupportedProvider(p)) {
      providers.push(hydrateNewProvider(p, true));
    } else if (p.family && providerConfig.SUPPORTED_FAMILIES.includes(p.family)) {
      // Supported family but fails validation (wrong namespace/protocol) — disable
      legacyProviders.push({ ...p, disabled_reason: "unsupported provider family/protocol/model namespace" });
    } else {
      // Legacy family (OpenAI, Groq, Ollama, etc.) — hydrate and include
      providers.push(hydrateLegacyProvider(p, true));
    }
  }
  const groups = mergeSmartGroups(config.groups);
  return { providers, groups, legacy_providers: legacyProviders };
}

// ---------------------------------------------------------------------------
// Load providers from /data/providers.json (written by discovery)
// ---------------------------------------------------------------------------
function loadProvidersFromFile() {
  try {
    if (!fs.existsSync(state.PROVIDERS_FILE)) return null;
    const raw = fs.readFileSync(state.PROVIDERS_FILE, "utf8");
    const config = JSON.parse(raw);
    if (!config.providers || !Array.isArray(config.providers)) return null;
    return config;
  } catch (err) {
    state.log(`WARN: Failed to parse providers.json: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hydrate providers.json format into runtime objects
// Same union logic as seed hydration.
// ---------------------------------------------------------------------------
function hydrateProvidersFile(config) {
  const providers = [];
  const legacyProviders = [];
  for (const p of (config.providers || [])) {
    if (providerConfig.isSupportedProvider(p)) {
      providers.push(hydrateNewProvider(p, !!p.seed));
    } else if (p.family && providerConfig.SUPPORTED_FAMILIES.includes(p.family)) {
      // Supported family but fails validation — disable
      legacyProviders.push({ ...p, disabled_reason: "unsupported provider family/protocol/model namespace" });
    } else {
      // Legacy family (OpenAI, Groq, Ollama, etc.) — hydrate and include
      providers.push(hydrateLegacyProvider(p, !!p.seed));
    }
  }
  const groups = mergeSmartGroups(config.groups);
  return {
    providers,
    groups,
    legacy_providers: [
      ...(Array.isArray(config.legacy_providers) ? config.legacy_providers : []),
      ...legacyProviders,
    ],
  };
}

// ---------------------------------------------------------------------------
// Load providers: try providers.json first, fall back to seed
// ---------------------------------------------------------------------------
function loadProviders() {
  const fileConfig = loadProvidersFromFile();
  if (fileConfig) {
    const result = hydrateProvidersFile(fileConfig);
    state.PROVIDERS = result.providers;
    state.GROUPS = result.groups;
    state.providersVersion = fileConfig.version || 0;
    const active = state.PROVIDERS.filter((p) => p.key && p.alive).length;
    state.log(`Loaded ${state.PROVIDERS.length} providers from providers.json (${active} active, version ${state.providersVersion})`);
    if (result.legacy_providers?.length > 0) {
      state.log(`Loaded providers.json with ${result.legacy_providers.length} unsupported legacy provider entries disabled`);
    }
  } else {
    const seed = loadSeedProviders();
    state.PROVIDERS = seed.providers;
    state.GROUPS = seed.groups;
    state.providersVersion = 0;
    const active = state.PROVIDERS.filter((p) => p.key && p.alive).length;
    state.log(`Loaded ${state.PROVIDERS.length} providers from seed (${active} active, no providers.json yet)`);
    if (seed.legacy_providers?.length > 0) {
      state.log(`Seed contains ${seed.legacy_providers.length} unsupported legacy provider entries disabled`);
    }
  }
}

// ---------------------------------------------------------------------------
// Watch providers.json for changes (hot-reload)
// ---------------------------------------------------------------------------
function watchProvidersFile(onReload) {
  let debounce = null;
  const dir = path.dirname(state.PROVIDERS_FILE);

  // Use fs.watch on the directory (more reliable across platforms for new files)
  try {
    fs.watch(dir, (_eventType, filename) => {
      if (filename !== path.basename(state.PROVIDERS_FILE)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.log("providers.json changed, reloading...");
        const oldCount = state.PROVIDERS.length;
        loadProviders();
        state.log(`Reloaded ${state.PROVIDERS.length} providers (was ${oldCount})`);
        if (onReload) onReload(); // probe new unverified providers
      }, 500); // debounce 500ms to avoid rapid reloads
    });
    state.log(`Watching ${state.PROVIDERS_FILE} for changes`);
  } catch (err) {
    state.log(`WARN: Could not watch providers.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Model Knowledge Base — benchmark-backed per-category scoring
// Pattern → { coding: N, reasoning: N, tools: N, chat: N, vision: N, speed: N }
// S=0.5, A=0.35, B=0.2, C=0.05, null=0
// ---------------------------------------------------------------------------
const MODEL_SCORES = [
  // Windsurf/Codex/Copilot app-discovered aliases (2026-05): exact/private names first.
  { pat: /claude.*opus.*4[- _.]?8/i,             coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.18 },
  { pat: /claude.*opus.*4[- _.]?7/i,             coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /claude.*opus.*4[- _.]?6.*1m/i,        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.1 },
  { pat: /claude.*opus.*4[- _.]?6.*thinking/i,  coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /claude.*opus.*4[- _.]?6/i,            coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /claude.*opus.*4[- _.]?5.*thinking/i,  coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /claude.*opus.*4[- _.]?5/i,            coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.18 },
  { pat: /claude.*sonnet.*4[- _.]?6.*thinking/i,coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /claude.*sonnet.*4[- _.]?6/i,          coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.35 },
  { pat: /claude.*sonnet.*4[- _.]?5.*thinking/i,coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.28 },
  { pat: /claude.*sonnet.*4[- _.]?5/i,          coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.35 },
  { pat: /claude.*sonnet.*4(?![- _.]?[5-9])/i,  coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.35 },
  { pat: /claude.*haiku.*4[- _.]?5/i,           coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.5 },

  { pat: /gpt[- _.]?5[- _.]?5.*(?:none|no[- _.]?thinking|nothinking)/i, coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.4 },
  { pat: /gpt[- _.]?5[- _.]?5.*(?:low|medium|high|xhigh|thinking)/i,    coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.35 },
  { pat: /gpt[- _.]?5[- _.]?5/i,                coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.35 },
  { pat: /gpt[- _.]?5[- _.]?4.*mini.*(?:high|xhigh)/i,   coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /gpt[- _.]?5[- _.]?4.*mini.*medium/i,  coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.45 },
  { pat: /gpt[- _.]?5[- _.]?4.*mini.*(?:low|none|minimal|no[- _.]?thinking|nothinking)/i, coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.5 },
  { pat: /gpt[- _.]?5[- _.]?4.*mini/i,          coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.45 },
  { pat: /gpt[- _.]?5[- _.]?4/i,                coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },

  { pat: /gpt[- _.]?5[- _.]?3.*codex/i,         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt[- _.]?5[- _.]?2.*codex.*low.*(?:priority|fast)/i,          coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.45 },
  { pat: /gpt[- _.]?5[- _.]?2.*codex.*(?:medium|high|xhigh).*(?:priority|fast)/i, coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.42 },
  { pat: /gpt[- _.]?5[- _.]?2.*codex.*low/i,    coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt[- _.]?5[- _.]?2.*codex.*(?:medium|high|xhigh)/i, coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.25 },
  { pat: /gpt[- _.]?5[- _.]?2.*codex/i,         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt[- _.]?5[- _.]?2.*(?:none|no[- _.]?thinking|nothinking).*(?:priority|fast)/i, coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.48 },
  { pat: /gpt[- _.]?5[- _.]?2.*low.*(?:priority|fast)/i,                 coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.45 },
  { pat: /gpt[- _.]?5[- _.]?2.*(?:medium|high|xhigh).*(?:priority|fast)/i,coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.42 },
  { pat: /gpt[- _.]?5[- _.]?2.*(?:none|no[- _.]?thinking|nothinking)/i,   coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.4 },
  { pat: /gpt[- _.]?5[- _.]?2.*low/i,            coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.35 },
  { pat: /gpt[- _.]?5[- _.]?2.*(?:medium|high|xhigh)/i, coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.3 },
  { pat: /gpt[- _.]?5[- _.]?2/i,                coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.3 },
  { pat: /gpt[- _.]?5[- _.]?1.*codex.*mini/i,   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.2, vision: 0.35, speed: 0.48 },
  { pat: /gpt[- _.]?5[- _.]?1.*codex.*low/i,    coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /gpt[- _.]?5[- _.]?1.*codex.*(?:medium|high|max)/i, coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt[- _.]?5[- _.]?1.*codex/i,         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt[- _.]?5[- _.]?1.*(?:none|no[- _.]?thinking|nothinking)/i,   coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.45 },
  { pat: /gpt[- _.]?5[- _.]?1.*(?:low|medium|high|xhigh|thinking)/i,      coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /gpt[- _.]?5(?:[^0-9]|$)/i,            coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.3 },

  { pat: /gemini.*3[- _.]?1.*pro.*high/i,       coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.25 },
  { pat: /gemini.*3[- _.]?1.*pro.*low/i,        coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.35 },
  { pat: /gemini.*3[- _.]?1.*pro/i,             coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /gemini.*3[- _.]?0.*flash.*(?:minimal|none|no[- _.]?thinking)/i, coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.5 },
  { pat: /gemini.*3[- _.]?0.*flash.*low/i,      coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.5 },
  { pat: /gemini.*3[- _.]?0.*flash.*medium/i,   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.45 },
  { pat: /gemini.*3[- _.]?0.*flash.*high/i,     coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.4 },
  { pat: /gemini.*3.*flash/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.45 },

  { pat: /(?:swe[- _.]?1[- _.]?6.*fast|swe16fast)/i, coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /(?:swe[- _.]?1[- _.]?6|swe16)/i,      coding: 0.5, reasoning: 0.35, tools: 0.5, chat: 0.2, vision: 0, speed: 0.35 },
  { pat: /(?:swe[- _.]?1[- _.]?5.*slow|swe15(?!fast))/i, coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.25 },
  { pat: /(?:swe[- _.]?1[- _.]?5|swe15fast)/i,  coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /swe[- _.]?1(?![- _.]?[56])/i,         coding: 0.2, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.4 },

  { pat: /deepseek.*v4.*flash/i,                coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.45 },
  { pat: /deepseek.*v4/i,                       coding: 0.5, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /kimi.*k2[- _.]?6/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.35 },
  { pat: /kimi.*k2[- _.]?5/i,                   coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.3 },
  { pat: /glm.*5/i,                             coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /minimax.*m2[- _.]?5/i,                coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /grok.*code.*fast/i,                   coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /gpt.*oss.*120b/i,                     coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.5 },
  { pat: /chat[- _.]?gpt[- _.]?4[- _.]?1/i,     coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.35 },
  { pat: /chat[- _.]?gpt[- _.]?4o/i,            coding: 0.2, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /o3.*high/i,                           coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0, speed: 0.15 },

  // S-tier coding + reasoning (frontier models)
  { pat: /claude.*opus[- _.]4/i,                 coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /claude.*sonnet[- _.]4[._-]5/i,        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /claude.*sonnet[- _.]4(?![._-]5)/i,    coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.35 },
  { pat: /claude.*3[._-]7.*sonnet/i,            coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /claude.*haiku[- _.]4/i,               coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.5 },
  { pat: /claude.*3[._-]5.*sonnet/i,            coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /claude.*3[._-]5.*haiku/i,             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /gpt.*5\.5/i,                           coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.3 },
  { pat: /gemini.*3\.1.*pro/i,                   coding: 0.5, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0.5, speed: 0.3 },
  { pat: /gpt.*4\.1.*nano/i,                     coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /gpt.*4\.1.*mini/i,                     coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /gpt.*4\.1/i,                           coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.35 },
  { pat: /gemini.*3.*flash/i,                    coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.4 },
  { pat: /deepseek.*v3\.2/i,                     coding: 0.5, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3\.5.*397b/i,                    coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.15 },
  { pat: /qwen.*coder.*480b/i,                   coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.2, vision: 0, speed: 0.15 },
  { pat: /glm.*5\.1/i,                           coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3\.6.*max/i,                     coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  // A-tier
  { pat: /gemini.*2\.5.*pro/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.5, speed: 0.3 },
  { pat: /gemini.*2\.5.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /deepseek.*v4.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /qwen.*coder.*(?:plus|next)/i,          coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /qwen.*coder/i,                        coding: 0.35, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*3\.5.*122b/i,                    coding: 0.35, reasoning: 0.35, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /qwen.*max/i,                           coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /deepseek.*v3\.1/i,                     coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /deepseek.*r1/i,                        coding: 0.35, reasoning: 0.35, tools: 0.2, chat: 0.2, vision: 0, speed: 0.15 },
  { pat: /kimi.*k2\.5/i,                         coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /kimi.*k2\.6/i,                         coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /nemotron.*(?:120b|super)/i,            coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /gpt.*5\.[4-9]/i,                        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /gpt.*5\.[2-3]/i,                        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.3 },
  { pat: /gpt.*5.*pro/i,                         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.2 },
  { pat: /gpt.*5.*codex/i,                       coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /gpt.*5(?!\.\d)(?!.*mini|.*nano|.*pro|.*codex)/i, coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt.*5.*mini/i,                        coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.4 },
  { pat: /gpt.*5.*nano/i,                        coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /o3(?!.*mini)/i,                         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0, speed: 0.2 },
  { pat: /o3.*mini/i,                             coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /o4.*mini/i,                             coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /mistral.*medium/i,                     coding: 0.35, reasoning: 0.2, tools: 0.5, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /glm.*5(?!\.)/i,                        coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /minimax.*m2\.[57]/i,                   coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.35, vision: 0, speed: 0.3 },
  // B-tier
  { pat: /gpt.*4o/i,                             coding: 0.2, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  // gpt-4.1 handled in S/A-tier above
  { pat: /qwen.*235b/i,                          coding: 0.2, reasoning: 0.35, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /qwen.*32b/i,                           coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*plus/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /deepseek.*v3(?!\.)/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /llama.*3[\._-]3.*70b/i,                coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /llama.*4.*maverick/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.35, speed: 0.4 },
  { pat: /command.*a/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /kimi.*k2(?!\.)/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /laguna.*m\.?1/i,                       coding: 0.2, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.3 },
  { pat: /laguna.*xs/i,                          coding: 0.2, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.4 },
  { pat: /mistral.*small/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /glm.*4/i,                              coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /ring.*2\.6/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /owl.*alpha/i,                          coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.05 },
  { pat: /nemotron.*(?:30b|nano.*omni)/i,        coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /qwen.*coder.*30b/i,                    coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /deepseek.*chat/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /gemini.*3\.1.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.5 },
  { pat: /gemini.*3\.0.*pro/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.5, speed: 0.3 },
  { pat: /grok.*3/i,                             coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /grok.*code/i,                          coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /mistral.*medium.*3/i,                  coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  // C-tier
  { pat: /llama.*4.*scout/i,                     coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0.2, speed: 0.4 },
  { pat: /command.*r.*plus/i,                    coding: 0.05, reasoning: 0.05, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /command.*r7b/i,                        coding: 0.05, reasoning: 0.05, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*turbo/i,                         coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /qwen.*(?:8b|14b|4b|0\.6b|1\.7b)/i,    coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /llama.*(?:8b|1b|3b)/i,                 coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /mistral.*(?:7b|8b|nemo)/i,             coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /gemma/i,                               coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /cobuddy/i,                             coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /phi/i,                                 coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /mistral.*large.*675b/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.2 },
  { pat: /mistral.*small.*119b/i,                coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /mistral.*nemotron/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3.*next/i,                       coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /solar/i,                               coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /step.*flash/i,                         coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /sarvam/i,                              coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /stockmark/i,                           coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.2 },
  { pat: /ministral/i,                           coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /mixtral/i,                             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /nemotron.*nano.*vl/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.35, speed: 0.4 },
  { pat: /gpt.*oss.*20b/i,                       coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /llama.*3\.2.*vision/i,                 coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.35, speed: 0.35 },
  { pat: /compound/i,                             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /seed.*oss/i,                           coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /mistral.*vibe/i,                       coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /(?:^|\/)(?:auto|free)(?:$|[-_/])/i,   coding: 0.15, reasoning: 0.15, tools: 0.15, chat: 0.15, vision: 0, speed: 0.3 },
  { pat: /llm7/i,                                coding: 0.15, reasoning: 0.15, tools: 0.15, chat: 0.15, vision: 0, speed: 0.3 },
  { pat: /perceptron/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /granite/i,                             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
];

// Map proxy group capability → model score field
const CAP_TO_SCORE = {
  coding: "coding", thinking: "reasoning",
  tools: "tools", text: "chat", images: "vision", video: "vision",
  max: "quality", // max = best overall quality across all categories
};

// Build a composite scoring key from provider fields (for Windsurf/Codex/Copilot with
// multi-part identity: model, name, upstream_model, windsurf_model_uid)
function scoreKeyForProvider(provider) {
  if (!provider || typeof provider !== "object") return "";
  const parts = [
    provider.model,
    provider.name,
    provider.upstream_model,
    provider.windsurf_model_uid,
  ]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim());

  return [...new Set(parts)].join(" ");
}

// Heuristic scoring for models not in MODEL_SCORES — infer tier from name patterns
function inferModelScore(model, category) {
  const m = String(model || "").toLowerCase();
  // Size-based tier inference (bigger = generally smarter)
  const sizeMatch = m.match(/(\d+)b(?:\b|_)/);
  const sizeB = sizeMatch ? parseInt(sizeMatch[1]) : 0;
  // Known-good model families (any version) → at least B-tier
  const knownGood = /claude|gpt|gemini|deepseek|qwen|mistral|llama|command|kimi|codex|swe|glm|minimax|grok/.test(m);
  // Version hints: higher versions tend to be better
  const hasVersion = /[- _.](?:[4-9]|[1-9]\d)[._-]/.test(m);
  // Reasoning/thinking hints
  const isReasoning = /think|reason|r1|o[1-9]|cot|xhigh|high|medium/.test(m);
  // Speed hints
  const isFast = /flash|fast|priority|mini|nano|small|tiny|lite|turbo/.test(m);
  const isBig = /max|ultra|pro|large|mega|super/.test(m);

  let base = 0.1; // absolute minimum
  if (knownGood) base = 0.15;
  if (sizeB >= 70) base = Math.max(base, 0.2);
  if (sizeB >= 200) base = Math.max(base, 0.3);
  if (hasVersion && knownGood) base = Math.max(base, 0.2);
  if (isBig) base = Math.max(base, 0.2);

  if (category === "speed") {
    if (isFast) return 0.5;
    if (sizeB > 0 && sizeB <= 14) return 0.5;
    if (sizeB > 200) return 0.15;
    return 0.3;
  }
  if (category === "vision") return /vision|image|multimodal/.test(m) ? 0.2 : 0;
  if (category === "reasoning" && isReasoning) return Math.max(base, 0.3);
  return base;
}

function getModelScore(model, category) {
  const m = (model || "").toLowerCase();
  for (const entry of MODEL_SCORES) {
    if (entry.pat.test(m)) {
      if (category === "quality") {
        // Average of coding + reasoning + tools — overall quality metric
        return ((entry.coding || 0) + (entry.reasoning || 0) + (entry.tools || 0)) / 3;
      }
      return entry[category] || 0;
    }
  }
  // No explicit match — use heuristic inference
  if (category === "quality") {
    return (inferModelScore(m, "coding") + inferModelScore(m, "reasoning") + inferModelScore(m, "tools")) / 3;
  }
  return inferModelScore(m, category);
}

module.exports = {
  loadSeedProviders,
  resolveUrl,
  hydrateSeedProviders,
  mergeSmartGroups,
  loadProvidersFromFile,
  hydrateProvidersFile,
  loadProviders,
  watchProvidersFile,
  MODEL_SCORES,
  CAP_TO_SCORE,
  scoreKeyForProvider,
  inferModelScore,
  getModelScore,
};
