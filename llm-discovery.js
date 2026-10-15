#!/usr/bin/env node
"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const anthropicAdapter = require("./lib/anthropic-adapter");
const copilotToken = require("./lib/copilot-token");
const providerAdapters = require("./lib/provider-adapters");
const providerConfig = require("./lib/provider-config");
const providerMetadataOverrides = require("./lib/provider-metadata-overrides");
const routingPolicy = require("./lib/routing-policy");
const windsurfCloud = require("./lib/windsurf-cloud");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || "/data";
const DISCOVERY_FILE = path.join(DATA_DIR, "discovery.json");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");
const SEED_FILE = path.join(__dirname, "seed-providers.json");
const SCAN_INTERVAL = 2 * 60 * 60_000; // 2 hours
const REQUEST_TIMEOUT = 30_000;
const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_REGISTRY_URL = "https://registry.npmjs.org/@openai/codex/latest";
const FALLBACK_CODEX_CLIENT_VERSION = "0.132.0";
const PROBE_PROMPT = "Say hello in one word.";
const PROBE_MAX_TOKENS = 50;

// Thinking model patterns
const THINKING_PATTERNS = [
  /qwen3/i, /qwq/i, /deepseek-v[34]/i, /deepseek.*r1/i, /gpt-oss/i, /kimi/i,
  /gemini-2\.5/i, /gemini-3/i, /magistral/i, /\b(o1|o3|o4)\b/i, /nemotron.*reason/i,
  /gpt-5/i, /claude.*sonnet[- _.]4/i, /claude.*opus/i, /claude.*haiku[- _.]4/i,
];

// ---------------------------------------------------------------------------
// URL normalization hook for discovered provider configs
// ---------------------------------------------------------------------------
function resolveUrl(url) {
  return String(url || "");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function fetchJSON(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(parsed, { method: "GET", headers, timeout: REQUEST_TIMEOUT }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          reject(new Error(`JSON parse error from ${urlStr}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function postJSON(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = mod.request(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Load seed providers
// ---------------------------------------------------------------------------
function loadSeed() {
  try {
    const raw = fs.readFileSync(SEED_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...parsed, providers: (parsed.providers || []).map(providerConfig.normalizeSeedProvider) };
  } catch (err) {
    log(`WARN: Failed to load seed-providers.json: ${err.message}`);
    return { providers: [], groups: {} };
  }
}

// ---------------------------------------------------------------------------
// Provider endpoints to scan for new models
// ---------------------------------------------------------------------------
function getEndpoints(env = process.env) {
  const endpoints = [];

  if (env.ENABLE_CLAUDE === "true" && (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN)) {
    const keyEnv = env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
    const authHeaders = keyEnv === "ANTHROPIC_API_KEY"
      ? { "x-api-key": env[keyEnv] }
      : { Authorization: `Bearer ${env[keyEnv]}` };
    endpoints.push({
      name: "Claude",
      family: "claude",
      protocol: "anthropic",
      modelsUrl: "https://api.anthropic.com/v1/models",
      chatUrl: "https://api.anthropic.com/v1/messages",
      headers: {
        ...authHeaders,
        "anthropic-version": "2023-06-01",
      },
      key_env: keyEnv,
    });
  }

  if (env.ENABLE_CODEX === "true" && env.CODEX_API_KEY) {
    endpoints.push({
      name: "Codex",
      family: "codex",
      protocol: "openai",
      modelsUrl: "http://codex-proxy:10531/v1/models",
      chatUrl: "http://codex-proxy:10531/v1/chat/completions",
      headers: { Authorization: `Bearer ${env.CODEX_API_KEY}` },
      key_env: "CODEX_API_KEY",
      local_gateway: true,
    });
  }

  if (env.ENABLE_COPILOT === "true") {
    const keyEnv = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].find((name) => env[name]);
    if (keyEnv) {
      const configuredModels = String(env.COPILOT_MODELS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((id) => ({ id }));
      const fallbackModels = providerConfig.FALLBACK_MODELS.copilot.map((model) => {
        const { id: _namespacedId, ...metadata } = model;
        return { ...metadata, id: model.upstream || _namespacedId };
      });
      endpoints.push({
        name: "Copilot",
        family: "copilot",
        protocol: "openai",
        modelsUrl: env.COPILOT_MODELS_URL || null,
        models: configuredModels.length > 0 ? configuredModels : fallbackModels,
        chatUrl: providerConfig.runtimeUrlForFamily("copilot"),
        headers: {},
        key_env: keyEnv,
      });
    }
  }

  if (env.ENABLE_WINDSURF === "true" && env.WINDSURF_API_KEY) {
    endpoints.push({
      name: "Windsurf",
      family: "windsurf",
      protocol: "windsurf",
      modelsUrl: env.WINDSURF_MODELS_URL || null,
      models: windsurfCloud.parseConfiguredModels(env),
      chatUrl: "windsurf",
      headers: {},
      key_env: "WINDSURF_API_KEY",
    });
  }

  return endpoints.sort((a, b) => a.name.localeCompare(b.name));
}

function providerName(endpointName, upstreamModel) {
  const shortName = String(upstreamModel || "")
    .split("/")
    .pop()
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 20);
  return `${endpointName}-${shortName}`;
}

function providerKey(provider) {
  if (!provider || typeof provider !== "object") return "";
  if (provider.family && provider.model) return `${provider.family}|${provider.model}`;
  return `name|${provider.name || ""}`;
}

function withDiscoveryName(endpointName, provider) {
  if (provider.name) return provider;
  return {
    ...provider,
    name: providerName(endpointName, provider.upstream_model || provider.model || provider.windsurf_model_uid),
  };
}

function isWindsurfEndpoint(ep) {
  return ep?.protocol === "windsurf" || ep?.family === "windsurf";
}

function isCodexEndpoint(ep) {
  return ep?.family === "codex";
}

function hasWindsurfModelUids(models) {
  return Array.isArray(models) && models.some((model) => (
    model &&
    typeof model === "object" &&
    !Array.isArray(model) &&
    (model.windsurf_model_uid || model.modelUid || model.source === "windsurf_app")
  ));
}

function isProxyVirtualModelEntry(modelData) {
  if (!modelData || typeof modelData !== "object" || Array.isArray(modelData)) return false;
  const upstream = String(modelData.id || modelData.name || modelData.model || "").trim().toLowerCase();
  if (!/^auto(?:-|$)/.test(upstream)) return false;

  const owner = String(modelData.owned_by || modelData.ownedBy || "").trim().toLowerCase();
  const proxyOwned = owner === "llm-proxy" ||
    owner === "Bogdan-llm-smart-proxy" ||
    owner === "Bogdan llm smart proxy" ||
    owner.includes("llm smart proxy");

  return modelData.is_group === true || modelData.provider_count !== undefined || proxyOwned;
}

function filterDiscoverableModelEntries(models) {
  if (!Array.isArray(models)) return [];
  return models.filter((model) => !isProxyVirtualModelEntry(model));
}

function extractModelList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.data?.models)) return data.data.models;
  return null;
}

function providersFromEndpointModels(ep, models) {
  const discoverableModels = filterDiscoverableModelEntries(models);

  if (isWindsurfEndpoint(ep)) {
    const configuredEndpointModels = filterDiscoverableModelEntries(ep.models);
    const hasEndpointModels = Array.isArray(models) && models.length > 0 && (ep.modelsUrl || hasWindsurfModelUids(models));
    if (hasEndpointModels && discoverableModels.length === 0) return [];

    const configuredModels = configuredEndpointModels.length > 0
      ? configuredEndpointModels
      : hasEndpointModels
        ? discoverableModels
        : undefined;
    return windsurfCloud.buildWindsurfProviders(configuredModels).map((provider) => {
      const named = withDiscoveryName(ep.name || "Windsurf", provider);
      const overlaid = providerMetadataOverrides.applyProviderMetadataOverrides(named);
      return {
        ...overlaid,
        ...routingPolicy.classifyProvider(overlaid),
        routing_level: overlaid.routing_level ?? routingPolicy.providerMaxRoutingLevel(overlaid),
      };
    });
  }

  return discoverableModels.filter((modelData) => {
    if (!modelData || typeof modelData !== "object" || Array.isArray(modelData)) return false;
    const upstream = modelData.id || modelData.slug || modelData.model || modelData.name;
    return typeof upstream === "string" && upstream.trim().length > 0;
  }).map((modelData) => {
    const upstream = (modelData.id || modelData.slug || modelData.model || modelData.name).trim();
    const modelId = `${ep.family}/${upstream}`;
    const traits = providerConfig.modelTraitsFor(ep.family, upstream, modelData);
    const caps = [...new Set([...detectCaps(modelId, modelData), ...(traits.caps || []), ...providerConfig.inferCapabilities(modelId)])];
    const tc = traits.tc || caps.includes("thinking") || THINKING_PATTERNS.some((pattern) => pattern.test(modelId));
    const provider = {
      name: providerName(ep.name, upstream),
      family: ep.family,
      protocol: ep.protocol,
      url: ep.chatUrl,
      key_env: ep.key_env,
      model: modelId,
      upstream_model: upstream,
      ...traits,
      context: traits.context || providerConfig.contextForModel(ep.family, upstream, modelData),
      tier: 2,
      tc,
      caps,
      headers: {},
      alive: true,
      seed: false,
      last_tested: new Date().toISOString(),
    };
    const overlaid = providerMetadataOverrides.applyProviderMetadataOverrides(provider);
    return {
      ...overlaid,
      ...routingPolicy.classifyProvider(overlaid),
      routing_level: overlaid.routing_level ?? routingPolicy.providerMaxRoutingLevel(overlaid),
    };
  });
}

function readCodexAuth(env = process.env) {
  const authFile = env.CODEX_AUTH_FILE || path.join(DATA_DIR, "codex-auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
    const tokens = auth.tokens || auth;
    const accessToken = tokens.access_token || tokens.accessToken;
    const accountId = tokens.account_id || tokens.accountId || auth.account_id || auth.accountId;
    if (!accessToken || !accountId) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

async function resolveCodexClientVersion(env = process.env, fetchJSONFn = fetchJSON) {
  if (env.CODEX_CLIENT_VERSION) return env.CODEX_CLIENT_VERSION;
  try {
    const resp = await fetchJSONFn(CODEX_REGISTRY_URL, { accept: "application/json" });
    const version = resp?.data?.version;
    if (resp.status < 400 && typeof version === "string" && version.trim()) return version.trim();
  } catch {}
  return FALLBACK_CODEX_CLIENT_VERSION;
}

async function fetchCodexBackendModels(ep, options = {}) {
  const env = options.env || process.env;
  const fetchJSONFn = options.fetchJSONFn || fetchJSON;
  const auth = readCodexAuth(env);
  if (!auth) return null;

  const clientVersion = await resolveCodexClientVersion(env, fetchJSONFn);
  const baseUrl = String(env.CODEX_BACKEND_URL || CODEX_BACKEND_URL).replace(/\/$/, "");
  const url = `${baseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`;
  const resp = await fetchJSONFn(url, {
    Authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    "OpenAI-Beta": "responses=experimental",
  });
  if (resp.status >= 400 || !Array.isArray(resp.data?.models)) return null;
  return resp.data.models;
}

async function discoverEndpointModels(ep, options = {}) {
  const env = options.env || process.env;
  const fetchJSONFn = options.fetchJSONFn || fetchJSON;
  const fetchCodexBackendModelsFn = options.fetchCodexBackendModelsFn || fetchCodexBackendModels;
  const fetchWindsurfModelConfigsFn = options.fetchWindsurfModelConfigsFn || windsurfCloud.fetchWindsurfModelConfigs;

  if (isCodexEndpoint(ep)) {
    try {
      const models = await fetchCodexBackendModelsFn(ep, { env, fetchJSONFn });
      if (Array.isArray(models) && models.length > 0) return { source: "codex_backend", models };
    } catch {}
  }

  if (ep.modelsUrl) {
    let headers = ep.headers;
    if (copilotToken.isCopilotProvider(ep)) {
      const keyEnv = providerConfig.resolveKeyEnv(ep, env);
      const key = keyEnv ? env[keyEnv] : "";
      const copilotOptions = {
        ...(options.copilotTokenOptions || options),
        env,
        intent: "model-access",
        interactionType: "model-access",
        includeInteractionHeaders: false,
      };
      headers = await copilotToken.buildCopilotRuntimeHeaders(
        { ...ep, key, key_env: keyEnv },
        ep.headers || {},
        copilotOptions,
      );
    }
    const resp = await fetchJSONFn(ep.modelsUrl, headers);
    const models = extractModelList(resp.data);
    if (resp.status >= 400 || !models) {
      const error = new Error(`failed (HTTP ${resp.status})`);
      error.status = resp.status;
      throw error;
    }
    return { source: "models_url", models };
  }

  if (Array.isArray(ep.models) && ep.models.length > 0) {
    return { source: "configured", models: ep.models };
  }

  if (isWindsurfEndpoint(ep)) {
    const keyEnv = providerConfig.resolveKeyEnv(ep, env);
    const key = keyEnv ? env[keyEnv] : "";
    const models = await fetchWindsurfModelConfigsFn({ ...ep, key, key_env: keyEnv });
    if (Array.isArray(models) && models.length > 0) return { source: "windsurf_app", models };
  }

  return { source: "builtin", models: [] };
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------
function detectCaps(modelId, modelData) {
  const caps = ["text"];
  const id = (modelId || "").toLowerCase();

  // Coding — frontier models + code-specialized
  if (/coder|code|codex|starcoder|codellama|deepseek-v[3-9]|laguna|gpt-[45]|claude.*sonnet|claude.*opus|command-a|nemotron.*super|qwen.*max|qwen.*plus|qwen.*235b/i.test(id)) caps.push("coding");

  // Tools — most chat models support tools
  if (modelData?.capabilities?.tools || /gpt|llama|qwen|mistral|gemini|nemotron|glm|deepseek|kimi|ring|claude|command|owl|granite|ministral/i.test(id)) {
    caps.push("tools");
  }

  // Images/vision
  if (/vision|llava|scout|maverick|gemini|gpt-4o|gpt-5|pixtral|claude.*sonnet.*4|claude.*opus|omni/i.test(id)) caps.push("images");

  // Video
  if (/gemini/i.test(id)) caps.push("video");

  // Large context = max
  const family = String(modelId || "").split("/")[0];
  const upstream = String(modelId || "").split("/").slice(1).join("/");
  const ctx = providerConfig.contextForModel(family, upstream, modelData);
  if (ctx >= 128000) caps.push("max");

  // Thinking
  if (THINKING_PATTERNS.some((p) => p.test(id))) caps.push("thinking");

  return [...new Set(caps)];
}

// ---------------------------------------------------------------------------
// Test a model with basic chat
// ---------------------------------------------------------------------------
function probeRequest(provider) {
  const openAICompatible = provider.protocol === "openai" || provider.family === "codex" || provider.family === "copilot";
  const request = {
    model: openAICompatible ? (provider.upstream_model || provider.model) : provider.model,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    max_tokens: PROBE_MAX_TOKENS,
  };
  return openAICompatible ? providerAdapters.normalizeOpenAIChatTokenLimit(provider, request) : request;
}

function parseResponseBody(response) {
  if (response?.data) return response.data;
  if (typeof response?.body !== "string") return response?.body;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

function openAIChatOk(response) {
  return response?.status < 400 && response?.data?.choices?.length > 0;
}

function anthropicChatOk(response) {
  if (!response || response.status >= 400) return false;
  const data = parseResponseBody(response);
  return Array.isArray(data?.content) && data.content.some((part) => part?.type === "text" && part.text);
}

function probeFailureReason(status, body) {
  const data = typeof body === "string" ? (() => {
    try { return JSON.parse(body); } catch { return null; }
  })() : body;
  const text = (typeof body === "string" ? body : JSON.stringify(body || "")).toLowerCase();
  const code = String(data?.error?.code || data?.error?.type || data?.code || data?.type || "").toLowerCase();
  const message = String(data?.error?.message || data?.message || text || "").toLowerCase();
  const combined = `${code} ${message} ${text}`;

  if (status === 429 || /rate[_ -]?limit|too many requests/.test(combined)) return "rate_limited";
  if (/unsupported_api_for_model|not accessible via .*chat\/completions/.test(combined)) return "unsupported_api_for_model";
  if (/permission_denied|permission denied|not allowed|forbidden/.test(combined)) return "permission_denied";
  if (status === 401 || /unauthorized|invalid.*(?:token|key)|authentication/.test(combined)) return "auth_failed";
  if (status === 404 || /model.*not found|unknown model/.test(combined)) return "model_not_found";
  if (status >= 500 || /timeout|temporar|unavailable|gateway/.test(combined)) return "temporary_provider_error";
  return "probe_failed";
}

async function buildOpenAIHeaders(provider, key, options = {}) {
  const headers = { ...(provider.headers || {}) };
  if (copilotToken.isCopilotProvider(provider)) {
    return copilotToken.buildCopilotRuntimeHeaders(
      { ...provider, key, key_env: providerConfig.resolveKeyEnv(provider) },
      headers,
      options.copilotTokenOptions || options,
    );
  }

  if (key && !(provider.no_auth && key === "anonymous")) {
    if (provider.auth_style === "token") {
      headers.Authorization = `token ${key}`;
    } else {
      headers.Authorization = `Bearer ${key}`;
    }
  }
  return headers;
}

async function probeSeedProviderDetailed(provider, key, options = {}) {
  const postJSONFn = options.postJSONFn || postJSON;
  const postAnthropicFn = options.postAnthropicFn || anthropicAdapter.postAnthropic;
  const callWindsurfCloudFn = options.callWindsurfCloudFn || windsurfCloud.callWindsurfCloud;
  const request = probeRequest(provider);
  const keyedProvider = { ...provider, key, key_env: providerConfig.resolveKeyEnv(provider) };

  try {
    if (provider.family === "claude" || provider.protocol === "anthropic") {
      const response = await postAnthropicFn(keyedProvider, anthropicAdapter.toAnthropicRequest(keyedProvider, request));
      const ok = anthropicChatOk(response);
      return {
        ok,
        status: response?.status,
        ...(ok ? {} : { reason: probeFailureReason(response?.status, parseResponseBody(response) || response?.body) }),
      };
    }

    if (provider.family === "windsurf" || provider.protocol === "windsurf") {
      const response = await callWindsurfCloudFn(keyedProvider, request);
      const ok = response?.choices?.length > 0;
      return { ok, ...(ok ? {} : { reason: "invalid_response" }) };
    }

    const url = resolveUrl(providerConfig.resolveProviderUrl(provider));
    const headers = await buildOpenAIHeaders(provider, key, options);
    const response = await postJSONFn(url, headers, request);
    const ok = openAIChatOk(response);
    return {
      ok,
      status: response?.status,
      ...(ok ? {} : { reason: probeFailureReason(response?.status, parseResponseBody(response) || response?.data) }),
    };
  } catch (err) {
    return {
      ok: false,
      status: err?.status || err?.statusCode,
      reason: probeFailureReason(err?.status || err?.statusCode, err?.body || err?.responseBody || err?.message),
    };
  }
}

async function probeSeedProvider(provider, key, options = {}) {
  return (await probeSeedProviderDetailed(provider, key, options)).ok;
}

// ---------------------------------------------------------------------------
// Test thinking capability
// ---------------------------------------------------------------------------
async function testThinking(chatUrl, headers, model) {
  try {
    const body = {
      model,
      messages: [{ role: "user", content: "What is 15 * 37? Return only the final number." }],
      max_tokens: 64,
    };

    // Add enable_thinking for Qwen3 models
    if (/qwen3|qwq/i.test(model)) {
      body.extra_body = { enable_thinking: true };
    }

    const resp = await postJSON(chatUrl, headers, body);
    if (resp.status >= 400 || !resp.data) return false;

    const choice = resp.data.choices?.[0];
    if (!choice) return false;

    if (choice.message?.reasoning_content) return true;
    if (choice.message?.thinking) return true;
    const content = choice.message?.content || "";
    if (/<think>[\s\S]*?<\/think>/i.test(content)) return true;

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test context size by sending progressively larger payloads
// ---------------------------------------------------------------------------
async function testContextSize(chatUrl, headers, model) {
  const sizes = [4096, 16384, 32768, 65536, 131072];
  let maxWorking = 0;

  for (const size of sizes) {
    try {
      // Generate a message roughly `size` tokens (~4 chars per token)
      const padding = "word ".repeat(Math.min(size, 8000)); // limit actual test
      const resp = await postJSON(chatUrl, headers, {
        model,
        messages: [{ role: "user", content: `Count to 3. Context test: ${padding}` }],
        max_tokens: 20,
      });
      if (resp.status < 400 && resp.data?.choices?.length > 0) {
        maxWorking = size;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return maxWorking || 4096;
}

// ---------------------------------------------------------------------------
// Load / save discovery data (raw scan results)
// ---------------------------------------------------------------------------
function loadDiscovery() {
  try {
    if (fs.existsSync(DISCOVERY_FILE)) {
      const data = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
      // Handle old format or missing models array
      if (!Array.isArray(data.models)) {
        log("discovery.json has old/incompatible format, resetting");
        return { models: [], last_scan: null, scan_count: 0 };
      }
      return data;
    }
  } catch {}
  return { models: [], last_scan: null, scan_count: 0 };
}

function saveDiscovery(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function discoveryEntryFromProvider(ep, provider, existing, now) {
  provider = providerMetadataOverrides.applyProviderMetadataOverrides(provider);
  return {
    provider: ep.name,
    name: provider.name,
    model: provider.model,
    upstream_model: provider.upstream_model,
    context_length: provider.context,
    capabilities: provider.caps,
    max_tokens: provider.max_tokens,
    max_tools: provider.max_tools,
    thinking_effort: provider.thinking_effort,
    thinking_level: provider.thinking_level,
    speed_group: provider.speed_group,
    cost_group: provider.cost_group,
    cost_multiplier: provider.cost_multiplier,
    quality_group: provider.quality_group,
    routing_level: provider.routing_level,
    app_cost_tier: provider.app_cost_tier,
    display_name: provider.display_name,
    description: provider.description,
    source: provider.source,
    source_type: provider.source_type,
    created_at: provider.created_at,
    context_window: provider.context_window,
    max_context_window: provider.max_context_window,
    supported_thinking_efforts: provider.supported_thinking_efforts,
    supports_code_execution: provider.supports_code_execution,
    supports_context_management: provider.supports_context_management,
    supports_context_compaction: provider.supports_context_compaction,
    supports_adaptive_thinking: provider.supports_adaptive_thinking,
    supports_extended_thinking: provider.supports_extended_thinking,
    supports_structured_outputs: provider.supports_structured_outputs,
    supports_pdf_input: provider.supports_pdf_input,
    supports_parallel_tool_calls: provider.supports_parallel_tool_calls,
    supports_tool_calls: provider.supports_tool_calls,
    supports_streaming: provider.supports_streaming,
    supports_search_tool: provider.supports_search_tool,
    supports_verbosity: provider.supports_verbosity,
    vendor: provider.vendor,
    version: provider.version,
    tokenizer: provider.tokenizer,
    model_picker_enabled: provider.model_picker_enabled,
    model_picker_category: provider.model_picker_category,
    is_chat_default: provider.is_chat_default,
    is_chat_fallback: provider.is_chat_fallback,
    supported_endpoints: provider.supported_endpoints,
    default_verbosity: provider.default_verbosity,
    shell_type: provider.shell_type,
    apply_patch_tool_type: provider.apply_patch_tool_type,
    web_search_tool_type: provider.web_search_tool_type,
    default_service_tier: provider.default_service_tier,
    service_tiers: provider.service_tiers,
    additional_speed_tiers: provider.additional_speed_tiers,
    input_modalities: provider.input_modalities,
    priority: provider.priority,
    visibility: provider.visibility,
    supported_in_api: provider.supported_in_api,
    truncation_policy: provider.truncation_policy,
    canonical_provider: provider.canonical_provider,
    canonical_model: provider.canonical_model,
    model_status: provider.model_status,
    public_context_length: provider.public_context_length,
    public_max_output_tokens: provider.public_max_output_tokens,
    cost_group_rule_applied: provider.cost_group_rule_applied,
    cost_bucket_reference_usd_per_1m: provider.cost_bucket_reference_usd_per_1m,
    cost_multiplier_basis: provider.cost_multiplier_basis,
    cost_multiplier_original: provider.cost_multiplier_original,
    cost_group_original: provider.cost_group_original,
    cost_basis: provider.cost_basis,
    input_usd_per_1m: provider.input_usd_per_1m,
    cached_input_usd_per_1m: provider.cached_input_usd_per_1m,
    cache_write_usd_per_1m: provider.cache_write_usd_per_1m,
    output_usd_per_1m: provider.output_usd_per_1m,
    blended_3in_1out_usd_per_1m: provider.blended_3in_1out_usd_per_1m,
    price_tier_note: provider.price_tier_note,
    confidence: provider.confidence,
    correction_notes: provider.correction_notes,
    evidence_urls: provider.evidence_urls,
    original_source: provider.original_source,
    original_source_type: provider.original_source_type,
    original_context_length: provider.original_context_length,
    original_max_tokens: provider.original_max_tokens,
    metadata_audit_generated_utc: provider.metadata_audit_generated_utc,
    metadata_audit_source: provider.metadata_audit_source,
    discovered_at: existing?.discovered_at || now,
    refreshed_at: now,
    chat_tested: existing?.chat_tested ?? false,
  };
}

function upsertDiscoveryModel(discovery, ep, provider, options = {}) {
  if (!discovery || typeof discovery !== "object") return { created: false, entry: null };
  if (!Array.isArray(discovery.models)) discovery.models = [];
  if (!provider?.model || !provider?.name) return { created: false, entry: null };

  const providerName = ep?.name || provider.family || provider.provider || "Unknown";
  const now = options.now || new Date().toISOString();
  const idx = discovery.models.findIndex((model) => model.provider === providerName && model.model === provider.model);
  const existing = idx >= 0 ? discovery.models[idx] : null;
  const entry = discoveryEntryFromProvider({ ...ep, name: providerName }, provider, existing, now);

  if (idx >= 0) {
    discovery.models[idx] = entry;
    return { created: false, entry };
  }

  discovery.models.push(entry);
  return { created: true, entry };
}

function providerFamilyName(provider = {}) {
  const family = String(provider.family || "").toLowerCase();
  if (family === "codex") return "Codex";
  if (family === "copilot") return "Copilot";
  if (family === "claude") return "Claude";
  if (family === "windsurf") return "Windsurf";
  return provider.provider || provider.family || "Unknown";
}

function refreshDiscoveryFromProviders(discovery, providerList, options = {}) {
  if (!discovery || typeof discovery !== "object") discovery = {};
  if (!Array.isArray(discovery.models)) discovery.models = [];
  const now = options.now || new Date().toISOString();
  let refreshed = 0;
  let created = 0;

  for (const provider of (providerList || [])) {
    if (!isSupportedProvider(provider)) continue;
    const result = upsertDiscoveryModel(discovery, { name: providerFamilyName(provider) }, provider, { now });
    if (!result.entry) continue;
    refreshed++;
    if (result.created) created++;
  }

  discovery.last_refresh = now;
  return { discovery, refreshed, created };
}

function markMissingDiscoveryModels(discovery, ep, currentProviders, options = {}) {
  if (!discovery || typeof discovery !== "object") return { marked: 0, missing: [] };
  if (!Array.isArray(discovery.models)) discovery.models = [];

  const providerName = ep?.name || ep?.family || "Unknown";
  const now = options.now || new Date().toISOString();
  const currentModels = new Set(
    (currentProviders || [])
      .map((provider) => provider?.model)
      .filter(Boolean),
  );
  let marked = 0;
  const missing = [];

  for (const model of discovery.models) {
    if (!model || model.provider !== providerName) continue;
    if (currentModels.has(model.model)) continue;
    if (model.stale === true && model.alive === false) {
      missing.push(missingProviderFromDiscoveryModel(model, providerName, now));
      continue;
    }

    model.stale = true;
    model.alive = false;
    model.stale_since = model.stale_since || now;
    model.disabled_reason = model.disabled_reason || `missing from ${providerName} discovery scan`;
    missing.push(missingProviderFromDiscoveryModel(model, providerName, now));
    marked++;
  }

  return { marked, missing };
}

function missingProviderFromDiscoveryModel(model, providerName, now) {
  return {
    name: model.name,
    family: inferFamilyFromModel(model.model, providerName),
    model: model.model,
    alive: false,
    last_tested: now,
    reason: "missing_from_catalog",
  };
}

function inferFamilyFromModel(modelId, providerName = "") {
  const family = String(modelId || "").split("/")[0].toLowerCase();
  if (["windsurf", "claude", "codex", "copilot"].includes(family)) return family;
  const fromProvider = String(providerName || "").toLowerCase();
  if (["windsurf", "claude", "codex", "copilot"].includes(fromProvider)) return fromProvider;
  return "";
}

// ---------------------------------------------------------------------------
// Write providers.json: merge seed + discovered
// ---------------------------------------------------------------------------
function isSupportedProvider(provider) {
  return providerConfig.isSupportedProvider(provider);
}

function mergeProvidersConfig(seed, discoveredProviders, existingConfig) {
  const previousStatus = new Map();
  const providerMap = new Map();
  const legacyMap = new Map();
  const refreshFields = [
    "context",
    "caps",
    "tc",
    "tier",
    "headers",
    "upstream_model",
    "max_tokens",
    "max_tools",
    "app_cost_tier",
    "cost_multiplier",
    "cost_group",
    "quality_group",
    "speed_group",
    "thinking_effort",
    "thinking_level",
    "routing_level",
    "description",
    "smart_friend_model_uid",
    "display_name",
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
    "canonical_provider",
    "canonical_model",
    "model_status",
    "public_context_length",
    "public_max_output_tokens",
    "cost_group_rule_applied",
    "cost_bucket_reference_usd_per_1m",
    "cost_multiplier_basis",
    "cost_multiplier_original",
    "cost_group_original",
    "cost_basis",
    "input_usd_per_1m",
    "cached_input_usd_per_1m",
    "cache_write_usd_per_1m",
    "output_usd_per_1m",
    "blended_3in_1out_usd_per_1m",
    "price_tier_note",
    "confidence",
    "correction_notes",
    "evidence_urls",
    "original_source",
    "original_source_type",
    "original_context_length",
    "original_max_tokens",
    "metadata_audit_generated_utc",
    "metadata_audit_source",
    "source",
  ];

  // Use existing providers only as status history; seed + current discovery are
  // the provider list source of truth.
  for (const p of (existingConfig?.providers || [])) {
    if (isSupportedProvider(p)) previousStatus.set(providerKey(p), p);
    else legacyMap.set(providerKey(p), { ...p, alive: false, disabled_reason: "unsupported provider family/protocol/model namespace" });
  }
  for (const p of (existingConfig?.legacy_providers || [])) {
    legacyMap.set(providerKey(p), { ...p, alive: false, disabled_reason: p.disabled_reason || "unsupported provider family/protocol/model namespace" });
  }

  // Layer seed providers on top (source of truth for seed config)
  for (const sp of (seed.providers || [])) {
    if (!isSupportedProvider(sp)) {
      legacyMap.set(providerKey(sp), { ...sp, alive: false, disabled_reason: "unsupported provider family/protocol/model namespace" });
      continue;
    }
    const overlaidSeed = providerMetadataOverrides.applyProviderMetadataOverrides(sp);
    const key = providerKey(overlaidSeed);
    const existing = previousStatus.get(key);
    providerMap.set(key, {
      ...overlaidSeed,
      seed: true,
      alive: existing?.alive ?? true,
      last_tested: existing?.last_tested ?? overlaidSeed.last_tested ?? null,
      ...((existing?.alive === false || overlaidSeed.alive === false) ? { reason: existing?.reason ?? overlaidSeed.reason } : {}),
    });
  }

  // Merge current scan results (update alive status, add new discoveries)
  for (const discoveredProvider of discoveredProviders) {
    const dp = providerMetadataOverrides.applyProviderMetadataOverrides(discoveredProvider);
    if (!isSupportedProvider(dp)) {
      legacyMap.set(providerKey(dp), { ...dp, alive: false, disabled_reason: "unsupported provider family/protocol/model namespace" });
      continue;
    }
    const key = providerKey(dp);
    const previous = previousStatus.get(key);
    if (providerMap.has(key)) {
      const existing = providerMap.get(key);
      const next = {
        ...existing,
      };
      for (const field of refreshFields) {
        if (dp[field] !== undefined && dp[field] !== null) next[field] = dp[field];
      }
      if (!dp.metadata_only) {
        next.alive = dp.alive ?? existing.alive;
        next.last_tested = dp.last_tested ?? existing.last_tested ?? null;
        if (next.alive === false) {
          next.reason = dp.reason ?? existing.reason ?? next.reason;
        } else {
          delete next.reason;
          delete next.disabled_reason;
        }
      }
      providerMap.set(key, next);
    } else if (isSupportedProvider(dp)) {
      const alive = dp.alive ?? previous?.alive ?? true;
      providerMap.set(key, {
        ...dp,
        seed: false,
        alive,
        last_tested: dp.last_tested ?? previous?.last_tested ?? null,
        ...(alive === false ? { reason: dp.reason ?? previous?.reason } : {}),
      });
    }
  }

  return {
    version: Date.now(),
    generated: new Date().toISOString(),
    providers: Array.from(providerMap.values()),
    legacy_providers: Array.from(legacyMap.values()),
    groups: seed.groups || providerConfig.GROUPS,
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeProvidersFile(seed, discoveredProviders) {
  let existingConfig = null;

  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      existingConfig = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    }
  } catch {}

  const config = mergeProvidersConfig(seed, discoveredProviders, existingConfig);

  try {
    ensureDataDir();
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 2));
    log(`Wrote providers.json: ${config.providers.length} providers (version ${config.version})`);
  } catch (err) {
    log(`ERROR: Failed to write providers.json: ${err.message}`);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Test seed providers for alive status
// ---------------------------------------------------------------------------
function loadProvidersFromFile() {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    }
  } catch {}
  return null;
}

function shouldProbeSeedProvider(provider, env = process.env) {
  if (!provider || typeof provider !== "object") return false;
  const keyEnv = providerConfig.resolveKeyEnv(provider, env);
  const key = (keyEnv ? env[keyEnv] : null) || provider.default_key || "";
  if (!key && !provider.no_auth) return true;
  if (provider.family === "claude" || provider.family === "windsurf") return true;
  if (provider.protocol === "anthropic" || provider.protocol === "windsurf") return true;
  const url = providerConfig.resolveProviderUrl(provider);
  if (!/^https?:\/\//.test(String(url || ""))) return false;
  return true;
}

function retestFailedProviderAfterMs(reason = "") {
  const normalized = String(reason || "").toLowerCase();
  if (normalized === "temporary_provider_error") return 15 * 60_000;
  if (normalized === "rate_limited") return 30 * 60_000;
  if (normalized === "probe_failed") return 2 * 60 * 60_000;
  if (normalized === "permission_denied") return 6 * 60 * 60_000;
  if (normalized === "unsupported_api_for_model" || normalized === "model_not_found" || normalized === "auth_failed") {
    return 24 * 60 * 60_000;
  }
  return 2 * 60 * 60_000;
}

function isAvailabilityProofReason(reason = "") {
  return String(reason || "").toLowerCase() === "rate_limited";
}

async function testSeedProviders(seed) {
  const results = [];
  const RETEST_OK_MS = 3.5 * 24 * 60 * 60_000; // retest alive providers every 3.5 days

  // Load existing test results from providers.json
  const existingConfig = loadProvidersFromFile();
  const existingProviders = new Map();
  if (existingConfig?.providers) {
    for (const p of existingConfig.providers) {
      if (p.last_tested) existingProviders.set(providerKey(p), p);
    }
  }

  for (const sp of (seed.providers || [])) {
    const keyEnv = providerConfig.resolveKeyEnv(sp);
    const key = (keyEnv ? process.env[keyEnv] : null) || sp.default_key || "";
    if (!key && !sp.no_auth) {
      results.push({
        ...sp,
        alive: false,
        last_tested: new Date().toISOString(),
        reason: "no_key",
      });
      continue;
    }

    if (!shouldProbeSeedProvider(sp)) {
      const existing = existingProviders.get(providerKey(sp));
      results.push({
        ...sp,
        alive: true,
        last_tested: existing?.last_tested || null,
        reason: "adapter_probe_skipped",
      });
      log(`  SKIP:  ${sp.name} (adapter probe not implemented)`);
      continue;
    }

    // Skip if recently tested — alive <3,5d, dead <6h
    const existing = existingProviders.get(providerKey(sp));
    if (existing?.last_tested) {
      const age = Date.now() - new Date(existing.last_tested).getTime();
      if (existing.alive && age < RETEST_OK_MS) {
        results.push({ ...sp, alive: true, last_tested: existing.last_tested });
        log(`  SKIP:  ${sp.name} (alive, tested ${Math.round(age / 3600000)}h ago)`);
        continue;
      }
      const staleNoKeyNowKeyed = existing.reason === "no_key" && !!key;
      const failRetestMs = retestFailedProviderAfterMs(existing.reason || "probe_failed");
      if (!existing.alive && age < failRetestMs && !staleNoKeyNowKeyed) {
        results.push({ ...sp, alive: false, last_tested: existing.last_tested, reason: existing.reason || "probe_failed" });
        log(`  SKIP:  ${sp.name} (dead, tested ${Math.round(age / 3600000)}h ago)`);
        continue;
      }
    }

    const probeResult = await probeSeedProviderDetailed({ ...sp, key_env: keyEnv }, key);
    const chatOk = probeResult.ok;
    const availabilityOk = chatOk || isAvailabilityProofReason(probeResult.reason);

    results.push({
      ...sp,
      alive: availabilityOk,
      last_tested: new Date().toISOString(),
      ...(chatOk ? {} : { reason: probeResult.reason || "probe_failed" }),
    });

    if (chatOk) {
      log(`  ALIVE: ${sp.name} (${sp.model})`);
    } else if (availabilityOk) {
      log(`  ALIVE: ${sp.name} (${sp.model}) — ${probeResult.reason}`);
    } else {
      log(`  DEAD:  ${sp.name} (${sp.model})`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main discovery scan
// ---------------------------------------------------------------------------
async function runDiscoveryScan() {
  log("Starting discovery scan...");
  const seed = loadSeed();
  const endpoints = getEndpoints();
  const discovery = loadDiscovery();
  const seedKeys = new Set((seed.providers || []).map(providerKey));
  const seedByKey = new Map((seed.providers || []).map((provider) => [providerKey(provider), provider]));
  let newCount = 0;
  let prevNewCount = 0;

  // Phase 1: Test all seed providers for alive status
  log("Phase 1: Testing seed providers...");
  const seedTestResults = await testSeedProviders(seed);

  // Phase 2: Scan endpoints for new models
  log("Phase 2: Scanning for new models...");
  const discoveredProviders = [];

  // Add seed test results
  for (const r of seedTestResults) {
    discoveredProviders.push(r);
  }

  for (const ep of endpoints) {
    log(`Scanning ${ep.name}...`);
    try {
      const discoveryResult = await discoverEndpointModels(ep);
      const models = discoveryResult.models;
      if (discoveryResult.source === "models_url") {
        log(`  ${ep.name}: ${models.length} models found`);
      } else if (discoveryResult.source === "codex_backend") {
        log(`  ${ep.name}: ${models.length} Codex backend model configs found`);
      } else if (discoveryResult.source === "configured") {
        log(`  ${ep.name}: ${models.length} configured models`);
      } else if (discoveryResult.source === "windsurf_app") {
        log(`  ${ep.name}: ${models.length} app model configs found`);
      } else {
        log(`  ${ep.name}: using built-in provider definitions`);
      }

      const endpointProviders = providersFromEndpointModels(ep, models);
      for (const discoveredProvider of endpointProviders) {
        const provider = { ...discoveredProvider, source: discoveredProvider.source || discoveryResult.source };
        if (!provider.name) continue;
        const discoveryUpdate = upsertDiscoveryModel(discovery, ep, provider);
        if (discoveryUpdate.created) {
          newCount++;
          log(`  NEW: ${provider.name} (${provider.model}) caps=[${provider.caps.join(",")}]`);
        }

        if (seedKeys.has(providerKey(provider))) {
          discoveredProviders.push({ ...provider, metadata_only: true });
          continue;
        }

        discoveredProviders.push(provider);
      }

      const staleResult = markMissingDiscoveryModels(discovery, ep, endpointProviders);
      for (const missing of staleResult.missing || []) {
        const seededProvider = seedByKey.get(providerKey(missing));
        if (!seededProvider) continue;
        discoveredProviders.push({
          ...seededProvider,
          alive: false,
          last_tested: missing.last_tested,
          reason: missing.reason,
        });
      }
      if (staleResult.marked > 0) {
        log(`  ${ep.name}: marked ${staleResult.marked} stale discovery models absent from current catalog`);
      }
    } catch (err) {
      log(`  ${ep.name}: error - ${err.message}`);
    }

    // Incremental write: after each endpoint scan, update providers.json
    // so new providers are available to the proxy immediately (hot-reload via fs.watch)
    if (newCount > prevNewCount) {
      writeProvidersFile(seed, discoveredProviders);
      log(`  → Incremental write: ${newCount - prevNewCount} new providers available now`);
    }
    prevNewCount = newCount;
  }

  // Save raw discovery data
  discovery.last_scan = new Date().toISOString();
  discovery.scan_count = (discovery.scan_count || 0) + 1;
  saveDiscovery(discovery);

  // Phase 3: Write merged providers.json
  log("Phase 3: Writing providers.json...");
  writeProvidersFile(seed, discoveredProviders);

  log(`Discovery scan complete. ${newCount} new models found. Total discovery entries: ${discovery.models.length}`);
}

// ---------------------------------------------------------------------------
// Generate initial providers.json from seed (no scanning)
// ---------------------------------------------------------------------------
function generateInitialProvidersFile() {
  if (fs.existsSync(PROVIDERS_FILE)) {
    log("providers.json already exists, skipping initial generation");
    return;
  }

  log("No providers.json found, generating initial from seed...");
  const seed = loadSeed();

  const providers = (seed.providers || []).map((sp) => ({
    ...sp,
    alive: true,
    seed: true,
    last_tested: null,
  }));

  const config = {
    version: 1,
    generated: new Date().toISOString(),
    providers,
    groups: seed.groups || providerConfig.GROUPS,
  };

  try {
    ensureDataDir();
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 2));
    log(`Generated initial providers.json with ${providers.length} seed providers`);
  } catch (err) {
    log(`ERROR: Failed to write initial providers.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function log(msg) {
  console.log(`[${new Date().toISOString()}] [discovery] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  ensureDataDir();
  log("LLM Discovery daemon starting...");
  log(`Scan interval: ${SCAN_INTERVAL / 3600000}h`);
  log(`Data dir: ${DATA_DIR}`);
  log(`Seed file: ${SEED_FILE}`);
  log(`Providers file: ${PROVIDERS_FILE}`);

  // On first run, generate initial providers.json from seed if missing
  generateInitialProvidersFile();

  // Initial scan after 10s
  setTimeout(async () => {
    await runDiscoveryScan().catch((e) => log(`Scan error: ${e.message}`));
  }, 10_000);

  // Periodic scan every 6 hours
  setInterval(async () => {
    await runDiscoveryScan().catch((e) => log(`Scan error: ${e.message}`));
  }, SCAN_INTERVAL);
}

module.exports = {
  getEndpoints,
  discoverEndpointModels,
  providersFromEndpointModels,
  upsertDiscoveryModel,
  refreshDiscoveryFromProviders,
  markMissingDiscoveryModels,
  shouldProbeSeedProvider,
  retestFailedProviderAfterMs,
  probeSeedProviderDetailed,
  probeSeedProvider,
  testSeedProviders,
  mergeProvidersConfig,
  loadSeed,
  writeProvidersFile,
  generateInitialProvidersFile,
  runDiscoveryScan,
};

if (require.main === module) {
  main();
}
