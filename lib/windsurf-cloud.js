"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const path = require("node:path");

const providerConfig = require("./provider-config");
const { readHostToken } = require("./windsurf-auth");
const mediaContent = require("./media-content");

const CODEIUM_API_ORIGIN = "https://server.codeium.com";
const WINDSURF_ENTERPRISE_API_ORIGIN = "https://server.enterprise.windsurf.com";
const GET_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const GET_USER_STATUS_PATH = "/exa.api_server_pb.ApiServerService/GetUserStatus";
const GET_CASCADE_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs";
const GET_COMMAND_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCommandModelConfigs";
const WINDSURF_MODEL_CONFIG_PATHS = [GET_USER_STATUS_PATH, GET_CASCADE_MODEL_CONFIGS_PATH, GET_COMMAND_MODEL_CONFIGS_PATH];
const WINDSURF_DEFAULT_URL = `${CODEIUM_API_ORIGIN}${GET_CHAT_MESSAGE_PATH}`;
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 64000;
const DEFAULT_VERSION = "2.3.9";
const DEFAULT_USER_AGENT = "connect-es/1.5.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_STREAM_TIMEOUT_MS = 300000;
const BLOCKED_APP_MODEL_UIDS = new Set(["MODEL_CHAT_11121"]);
const RESERVED_TOOL_DESCRIPTION_NAMES = new Set(["Read", "TaskOutput", "WebSearch"]);

const MODEL_ALIASES = {
  "swe-1-6-fast": "swe-1.6-fast",
  "swe-1.6:fast": "swe-1.6-fast",
  "swe-1-6": "swe-1.6",
  "swe-1-5": "swe-1.5-fast",
  "swe-1-5-fast": "swe-1.5-fast",
  "swe-1.5:fast": "swe-1.5-fast",
  MODEL_SWE_1_6_FAST: "swe-1.6-fast",
  MODEL_SWE_1_6: "swe-1.6",
  MODEL_SWE_1_5: "swe-1.5-fast",
  MODEL_ADAPTIVE: "adaptive",
};

function stripWindsurfPrefix(id) {
  return String(id || "").trim().replace(/^windsurf\//i, "");
}

function ensureWindsurfModelId(id) {
  const raw = stripWindsurfPrefix(id);
  return raw ? `windsurf/${raw}` : "";
}

function uidFromModelId(id) {
  return stripWindsurfPrefix(id)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function canonicalModelId(modelId) {
  const raw = String(modelId || "").trim();
  const normalized = stripWindsurfPrefix(raw).replace(/_/g, "-").toLowerCase();
  return MODEL_ALIASES[raw] || MODEL_ALIASES[normalized] || normalized;
}

function providerNameForModel(modelId) {
  const shortName = stripWindsurfPrefix(modelId)
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 24);
  return `Windsurf-${shortName || "Model"}`;
}

function normalizeModelDef(model) {
  const input = typeof model === "string" ? { id: model } : { ...(model || {}) };
  const idSource = input.id || input.model || input.upstream || input.upstream_model || input.modelUid || input.windsurf_model_uid;
  const catalog = providerConfig.catalogModelFor("windsurf", idSource);
  const namespaced = ensureWindsurfModelId(input.id || input.model || catalog?.id || idSource);
  const id = stripWindsurfPrefix(namespaced);
  const upstream = stripWindsurfPrefix(input.upstream || input.upstream_model || catalog?.upstream || id);
  const modelUid = input.windsurf_model_uid || input.modelUid || catalog?.windsurf_model_uid || uidFromModelId(upstream || id);
  const contextWindow = Number(input.contextWindow || input.context || catalog?.context || DEFAULT_CONTEXT_WINDOW);
  const maxTokens = Number(input.maxTokens || input.max_tokens || catalog?.max_tokens || DEFAULT_MAX_TOKENS);
  const caps = Array.isArray(input.caps) ? input.caps : providerConfig.inferCapabilities(namespaced);
  const appCostTier = Number(input.app_cost_tier || input.costTier || input.cost_tier || 0);
  const costMultiplierSource = input.cost_multiplier ?? input.costMultiplier ?? (Number.isFinite(appCostTier) && appCostTier > 0 ? appCostTier : undefined);
  const costMultiplier = Number(costMultiplierSource);

  return {
    id,
    namespacedId: namespaced,
    upstream,
    name: input.name || catalog?.name || providerNameForModel(namespaced),
    modelUid,
    tier: input.tier || catalog?.tier || 2,
    reasoning: input.reasoning ?? caps.includes("thinking"),
    contextWindow,
    maxTokens,
    caps,
    appCostTier: Number.isFinite(appCostTier) && appCostTier > 0 ? appCostTier : undefined,
    costMultiplier: costMultiplierSource !== undefined && Number.isFinite(costMultiplier) && costMultiplier >= 0 ? costMultiplier : undefined,
    costGroup: input.cost_group ?? input.costGroup ?? catalog?.cost_group,
    qualityGroup: input.quality_group ?? input.qualityGroup ?? catalog?.quality_group,
    speedGroup: input.speed_group ?? input.speedGroup ?? catalog?.speed_group,
    thinkingEffort: input.thinking_effort ?? input.thinkingEffort ?? catalog?.thinking_effort,
    source: input.source ?? catalog?.source,
    description: input.description,
    smartFriendModelUid: input.smart_friend_model_uid || input.smartFriendModelUid,
  };
}

const FALLBACK_MODELS = providerConfig.FALLBACK_MODELS.windsurf.map(normalizeModelDef);

function resolveModel(modelId) {
  if (!String(modelId || "").trim()) return FALLBACK_MODELS[0];
  const resolved = canonicalModelId(modelId);
  return (
    FALLBACK_MODELS.find((model) => model.id === resolved || model.modelUid === resolved) ||
    FALLBACK_MODELS.find((model) => model.id === MODEL_ALIASES[resolved]) ||
    normalizeModelDef(modelId)
  );
}

function buildWindsurfProviders(models = FALLBACK_MODELS) {
  const source = Array.isArray(models) && models.length > 0 ? models : FALLBACK_MODELS;
  return source.map(normalizeModelDef).map((model) => ({
    name: model.name,
    family: "windsurf",
    protocol: "windsurf",
    url: "windsurf",
    model: ensureWindsurfModelId(model.id),
    upstream_model: model.upstream || model.id,
    windsurf_model_uid: model.modelUid,
    key_env: "WINDSURF_API_KEY",
    context: model.contextWindow || DEFAULT_CONTEXT_WINDOW,
    tier: model.tier || 2,
    caps: model.caps,
    tc: model.reasoning !== false && model.caps.includes("thinking"),
    headers: {},
    seed: true,
    max_tokens: model.maxTokens || DEFAULT_MAX_TOKENS,
    app_cost_tier: model.appCostTier,
    cost_multiplier: model.costMultiplier,
    cost_group: model.costGroup,
    quality_group: model.qualityGroup,
    speed_group: model.speedGroup,
    thinking_effort: model.thinkingEffort,
    source: model.source,
    description: model.description,
    smart_friend_model_uid: model.smartFriendModelUid,
  }));
}

function normalizeConfiguredModel(model) {
  if (typeof model === "string") return { id: ensureWindsurfModelId(model) };
  if (!model || typeof model !== "object" || Array.isArray(model)) return null;
  const id = ensureWindsurfModelId(model.id || model.model || model.upstream || model.upstream_model || model.windsurf_model_uid);
  if (!id) return null;
  return { ...model, id };
}

function parseConfiguredModels(env = process.env) {
  const configured = [];
  const json = String(env.WINDSURF_MODELS_JSON || "").trim();
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const models = Array.isArray(parsed) ? parsed : parsed?.models;
      for (const model of (Array.isArray(models) ? models : [])) {
        const normalized = normalizeConfiguredModel(model);
        if (normalized) configured.push(normalized);
      }
    } catch {
      return configured;
    }
  }

  for (const entry of String(env.WINDSURF_MODELS || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      configured.push({ id: ensureWindsurfModelId(trimmed) });
      continue;
    }
    const id = trimmed.slice(0, separator).trim();
    const uid = trimmed.slice(separator + 1).trim();
    if (id) configured.push({ id: ensureWindsurfModelId(id), windsurf_model_uid: uid || undefined });
  }

  return configured;
}

function encodeVarint(value) {
  const bytes = [];
  let current = BigInt(value);
  while (current > 127n) {
    bytes.push(Number(current & 0x7fn) | 0x80);
    current >>= 7n;
  }
  bytes.push(Number(current));
  return bytes;
}

function encodeString(fieldNum, value) {
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.from([...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(bytes.length), ...bytes]);
}

function encodeMessage(fieldNum, value) {
  return Buffer.from([...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(value.length), ...value]);
}

function encodeVarintField(fieldNum, value) {
  return Buffer.from([...encodeVarint((fieldNum << 3) | 0), ...encodeVarint(value)]);
}

function connectEnvelope(payload, flags = 0) {
  const frame = Buffer.alloc(5);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  return Buffer.concat([frame, payload]);
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let next = offset;
  while (next < buffer.length) {
    const byte = buffer[next];
    value |= BigInt(byte & 0x7f) << shift;
    next += 1;
    if (byte < 0x80) return { value, next };
    shift += 7n;
  }
  return null;
}

function parseFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    if (!key) break;
    offset = key.next;
    const fieldNum = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);

    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      if (!value) break;
      fields.push({ fieldNum, wireType, value: value.value });
      offset = value.next;
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      if (!length) break;
      offset = length.next;
      const end = offset + Number(length.value);
      if (end > buffer.length) break;
      fields.push({ fieldNum, wireType, value: buffer.subarray(offset, end) });
      offset = end;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return fields;
}

function takeConnectEnvelopes(buffer) {
  const envelopes = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > buffer.length) break;
    envelopes.push({ flags, body: buffer.subarray(start, end) });
    offset = end;
  }
  return { envelopes, remaining: buffer.subarray(offset) };
}

function stringField(fields, fieldNum) {
  const field = fields.find((candidate) => candidate.fieldNum === fieldNum && Buffer.isBuffer(candidate.value));
  return field ? field.value.toString("utf8").trim() : "";
}

function rawStringField(fields, fieldNum) {
  const field = fields.find((candidate) => candidate.fieldNum === fieldNum && Buffer.isBuffer(candidate.value));
  return field ? field.value.toString("utf8") : "";
}

function hasStringField(fields, fieldNum) {
  return fields.some((candidate) => candidate.fieldNum === fieldNum && Buffer.isBuffer(candidate.value));
}

function boolField(fields, fieldNum) {
  const field = fields.find((candidate) => candidate.fieldNum === fieldNum && candidate.wireType === 0);
  return field ? field.value !== 0n : false;
}

function numberField(fields, fieldNum) {
  const field = fields.find((candidate) => candidate.fieldNum === fieldNum && candidate.wireType === 0);
  return field ? Number(field.value) : 0;
}

function isPlausibleModelUid(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text);
}

function parseClientModelConfig(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const fields = parseFields(buffer);
  const label = stringField(fields, 1);
  const modelUid = stringField(fields, 22);
  if (!label || !isPlausibleModelUid(modelUid)) return null;

  return {
    label,
    modelUid,
    disabled: boolField(fields, 4),
    supportsImages: boolField(fields, 5),
    isRecommended: boolField(fields, 11),
    isPremium: boolField(fields, 7),
    isCapacityLimited: boolField(fields, 20),
    maxTokens: numberField(fields, 18),
    costTier: numberField(fields, 24),
    description: stringField(fields, 27),
    smartFriendModelUid: stringField(fields, 29),
  };
}

function extractClientModelConfigs(buffer, depth = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || depth > 8) return [];
  const direct = parseClientModelConfig(buffer);
  if (direct) return [direct];

  const configs = [];
  for (const field of parseFields(buffer)) {
    if (field.wireType !== 2 || !Buffer.isBuffer(field.value) || field.value.length === 0) continue;
    configs.push(...extractClientModelConfigs(field.value, depth + 1));
  }
  return configs;
}

function bodyBuffersFromConnectOrRaw(body) {
  if (!Buffer.isBuffer(body)) return [];
  const parsed = takeConnectEnvelopes(body);
  if (parsed.envelopes.length > 0 && parsed.remaining.length === 0) {
    return parsed.envelopes
      .filter((envelope) => (envelope.flags & 2) === 0)
      .map((envelope) => envelope.body);
  }
  return [body];
}

function slugFromModelConfig(config) {
  const source = config.modelUid || config.label || "model";
  return String(source)
    .replace(/^MODEL_/i, "")
    .replace(/_/g, "-")
    .replace(/[^a-z0-9.-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || uidFromModelId(config.label || "model");
}

function normalizedConfigText(config = {}) {
  return [
    config.label,
    config.modelUid,
    config.description,
    config.smartFriendModelUid,
  ].filter(Boolean).join(" ").replace(/_/g, "-").toLowerCase();
}

function inferThinkingEffortFromAppConfig(config = {}) {
  const text = normalizedConfigText(config);
  if (/\bx[- ]?high\b/.test(text)) return "xhigh";
  if (/\bhigh\b/.test(text)) return "high";
  if (/\bmedium\b/.test(text)) return "medium";
  if (/\blow\b/.test(text)) return "low";
  if (/\bminimal\b/.test(text)) return "minimal";
  if (/\bnone\b|no[- ]?thinking|without[- ]?thinking/.test(text)) return "none";
  if (/thinking/.test(text)) return /opus/.test(text) ? "xhigh" : "high";
  if (/opus/.test(text)) return "xhigh";
  if (/gemini.*pro/.test(text)) return "high";
  if (/sonnet|gpt-5|codex|swe|gemini|glm|minimax/.test(text)) return "medium";
  return undefined;
}

function inferSpeedGroupFromAppConfig(config = {}, effort = "") {
  const text = normalizedConfigText(config);
  if (/priority|fast|flash|minimal|mini|haiku|swe.*fast/.test(text)) return 5;
  if (/\blow\b|sonnet|glm|minimax|swe/.test(text)) return 4;
  if (/opus|pro|x[- ]?high|high/.test(text)) return 3;
  if (effort === "xhigh") return 2;
  return undefined;
}

function inferQualityGroupFromAppConfig(config = {}) {
  const text = normalizedConfigText(config);
  if (/opus|gpt-5-5|gemini.*pro/.test(text)) return 5;
  if (/sonnet|codex|gemini.*flash|glm|minimax|swe-1-6|swe-1-5/.test(text)) return 4;
  if (/mini|haiku|grok|swe-1/.test(text)) return 3;
  return undefined;
}

function inferCostGroupFromAppConfig(config = {}, qualityGroup = 0) {
  const text = normalizedConfigText(config);
  if (/gemini.*flash|swe/.test(text)) return 1;
  if (/mini|haiku|glm|minimax|grok/.test(text)) return 2;
  if (/sonnet|gpt-5-2|gpt-5-3|gpt-5-4/.test(text)) return 3;
  if (/opus|gpt-5-5|gemini.*pro/.test(text)) return 4;
  const explicit = Number(config.costTier || 0);
  if (Number.isFinite(explicit) && explicit >= 1 && explicit <= 5) return explicit;
  return qualityGroup ? Math.max(1, Math.min(5, qualityGroup)) : undefined;
}

function normalizeAppModelConfig(config) {
  if (BLOCKED_APP_MODEL_UIDS.has(config.modelUid)) return null;

  const catalog = providerConfig.catalogModelFor("windsurf", config.modelUid) || providerConfig.catalogModelFor("windsurf", config.label);
  const slug = slugFromModelConfig(config);
  const id = catalog?.id || ensureWindsurfModelId(slug);
  const caps = new Set(catalog?.caps || providerConfig.inferCapabilities(id));
  if (config.supportsImages) caps.add("images");
  if (config.maxTokens >= 128000) caps.add("max");
  const thinkingEffort = inferThinkingEffortFromAppConfig(config);
  const qualityGroup = inferQualityGroupFromAppConfig(config);
  const speedGroup = inferSpeedGroupFromAppConfig(config, thinkingEffort);
  const costGroup = inferCostGroupFromAppConfig(config, qualityGroup);

  return {
    id,
    upstream: catalog?.upstream || stripWindsurfPrefix(id),
    name: catalog?.name || providerNameForModel(config.label || slug),
    windsurf_model_uid: config.modelUid,
    modelUid: config.modelUid,
    context: catalog?.context || (config.maxTokens >= 32768 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW),
    max_tokens: config.maxTokens || catalog?.max_tokens || DEFAULT_MAX_TOKENS,
    tier: catalog?.tier || (config.isRecommended || config.isPremium || config.costTier === 1 ? 1 : 2),
    caps: [...caps],
    app_cost_tier: config.costTier || undefined,
    cost_multiplier: config.costTier || undefined,
    cost_group: costGroup,
    quality_group: qualityGroup,
    speed_group: speedGroup,
    thinking_effort: thinkingEffort,
    description: config.description || undefined,
    smart_friend_model_uid: config.smartFriendModelUid || undefined,
    source: "windsurf_app",
  };
}

function parseWindsurfModelConfigs(body) {
  const models = [];
  const seen = new Set();

  for (const buffer of bodyBuffersFromConnectOrRaw(body)) {
    for (const config of extractClientModelConfigs(buffer)) {
      if (config.disabled || !config.modelUid || seen.has(config.modelUid)) continue;
      seen.add(config.modelUid);
      const model = normalizeAppModelConfig(config);
      if (model) models.push(model);
    }
  }

  return models;
}

function envFlag(name, env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env[name] || "").trim().toLowerCase());
}

function windsurfEnterpriseEnabled(env = process.env) {
  return envFlag("WINDSURF_ENTERPRISE", env) || envFlag("windsurf_enterprise", env);
}

function envDisabled(name, env = process.env) {
  return ["0", "false", "no", "off"].includes(String(env[name] || "").trim().toLowerCase());
}

function positiveTimeoutMs(value, fallback) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : fallback;
}

function windsurfTimeoutMs(provider = {}, env = process.env) {
  return positiveTimeoutMs(provider.timeout_ms || env.WINDSURF_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
}

function windsurfStreamTimeoutMs(provider = {}, env = process.env) {
  return positiveTimeoutMs(
    provider.stream_timeout_ms ||
      provider.windsurf_stream_timeout_ms ||
      env.WINDSURF_CONNECT_STREAM_TIMEOUT_MS ||
      env.WINDSURF_STREAM_TIMEOUT_MS ||
      provider.timeout_ms ||
      env.WINDSURF_CONNECT_TIMEOUT_MS,
    DEFAULT_STREAM_TIMEOUT_MS,
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text.replace(/\/+$/, "");
  }
  return "";
}

function resolveWindsurfOrigin(provider = {}, options = {}) {
  const env = options.env || process.env;
  const kind = String(options.kind || "chat").toLowerCase();
  const defaultOrigin = windsurfEnterpriseEnabled(env) ? WINDSURF_ENTERPRISE_API_ORIGIN : CODEIUM_API_ORIGIN;
  if (kind === "config") {
    return firstNonEmpty(provider.origin, provider.api_origin, provider.windsurf_api_origin, env.WINDSURF_API_ORIGIN, env.windsurf_api_origin, defaultOrigin);
  }
  return firstNonEmpty(
    provider.origin,
    provider.chat_origin,
    provider.windsurf_chat_origin,
    env.WINDSURF_CHAT_ORIGIN,
    env.windsurf_chat_origin,
    env.WINDSURF_API_ORIGIN,
    env.windsurf_api_origin,
    defaultOrigin,
  );
}

function buildHeaders(provider = {}, options = {}) {
  const headers = {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    "user-agent": provider.windsurf_user_agent || process.env.WINDSURF_USER_AGENT || DEFAULT_USER_AGENT,
  };
  const timeoutMs = positiveTimeoutMs(options.timeoutMs, windsurfTimeoutMs(provider));
  const includeTimeout = provider.include_timeout_header !== false && !envDisabled("WINDSURF_CONNECT_TIMEOUT_HEADER");
  if (includeTimeout) {
    headers["connect-timeout-ms"] = String(timeoutMs);
  }
  if (provider.include_accept_header || envFlag("WINDSURF_INCLUDE_ACCEPT_HEADER")) {
    headers.accept = "application/connect+proto";
  }
  return headers;
}

function textContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return mediaContent.textFromContent(content, { imagePlaceholder: true });
}

function normalizeMessagesForWindsurf(messages = []) {
  if (!Array.isArray(messages)) return [];
  const systemText = messages
    .filter((message) => message && message.role === "system")
    .map((message) => textContent(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const rest = messages.filter((message) => message && message.role !== "system");
  if (!systemText) return rest;

  const firstUserIndex = rest.findIndex((message) => message.role === "user");
  const prefix = `System instructions:\n${systemText}`;
  if (firstUserIndex === -1) {
    return [{ role: "user", content: prefix }, ...rest];
  }

  return rest.map((message, index) => {
    if (index !== firstUserIndex) return message;
    const userText = textContent(message.content).trim();
    return {
      ...message,
      content: userText ? `${prefix}\n\nUser request:\n${userText}` : prefix,
    };
  });
}

function sourceForRole(role) {
  if (role === "system") return 5;
  if (role === "assistant") return 2;
  if (role === "tool") return 4;
  return 1;
}

function buildMetadata(apiKey, version = DEFAULT_VERSION, requestId = crypto.randomUUID()) {
  return Buffer.concat([
    encodeString(3, apiKey),
    encodeString(1, "windsurf"),
    encodeString(7, version),
    encodeString(2, version),
    encodeString(12, "windsurf"),
    encodeString(10, requestId),
    encodeString(4, "en-US"),
    encodeString(28, "windsurf"),
  ]);
}

function buildChatToolCall(toolCall = {}) {
  const fn = toolCall.function || {};
  const name = fn.name || toolCall.name || "";
  const args = typeof fn.arguments === "string"
    ? fn.arguments
    : typeof toolCall.arguments === "string"
      ? toolCall.arguments
      : JSON.stringify(fn.arguments || toolCall.arguments || {});
  return Buffer.concat([
    encodeString(1, toolCall.id || `call_${crypto.randomUUID().replace(/-/g, "")}`),
    encodeString(2, name),
    encodeString(3, args),
    ...(toolCall.is_custom_tool_call ? [encodeVarintField(6, 1)] : []),
  ]);
}

function buildChatPrompt(message) {
  let prompt = textContent(message.content).trim();
  const parts = [
    encodeString(1, crypto.randomUUID()),
    encodeVarintField(2, sourceForRole(message.role)),
  ];

  if (prompt) parts.push(encodeString(3, prompt));
  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) parts.push(encodeMessage(6, buildChatToolCall(toolCall)));
  }
  if (message.role === "tool") {
    if (message.tool_call_id) parts.push(encodeString(7, message.tool_call_id));
    if (message.tool_result_is_error || message.is_error) parts.push(encodeVarintField(9, 1));
  }
  return Buffer.concat(parts);
}

function toolDefinitionFromOpenAI(tool = {}) {
  const fn = tool.function || tool;
  const name = fn.name || tool.name;
  if (!name) return null;
  const parameters = fn.parameters || tool.parameters || { type: "object", properties: {} };
  const schema = typeof parameters === "string" ? parameters : JSON.stringify(parameters);
  const parts = [
    encodeString(1, name),
    encodeString(3, schema),
  ];
  const description = windsurfToolDescription(name, fn.description || tool.description);
  const required = parameters && typeof parameters === "object" && Array.isArray(parameters.required) ? parameters.required : [];
  if (description) parts.push(encodeString(2, description));
  if (fn.strict !== false && tool.strict !== false && (fn.strict === true || tool.strict === true || required.length > 0)) {
    parts.push(encodeVarintField(12, 1));
  }
  return Buffer.concat(parts);
}

function windsurfToolDescription(name, description) {
  const raw = String(description || "");
  if (!raw) return "";
  const mode = String(process.env.WINDSURF_STRIP_TOOL_DESCRIPTIONS || "").trim().toLowerCase();
  if (["1", "true", "all", "yes"].includes(mode)) return "";
  const configured = String(process.env.WINDSURF_STRIP_TOOL_DESCRIPTION_NAMES || "").trim();
  const reserved = configured
    ? new Set(configured.split(",").map((entry) => entry.trim()).filter(Boolean))
    : RESERVED_TOOL_DESCRIPTION_NAMES;
  // Windsurf rejects custom descriptions for these built-in Claude Code tool names.
  if (reserved.has(name)) return "";
  return raw;
}

function toolDefinitionsFromRequest(request = {}) {
  const tools = [];
  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      if (!tool || (tool.type && tool.type !== "function")) continue;
      const encoded = toolDefinitionFromOpenAI(tool);
      if (encoded) tools.push(encoded);
    }
  }
  if (Array.isArray(request.functions)) {
    for (const fn of request.functions) {
      const encoded = toolDefinitionFromOpenAI(fn);
      if (encoded) tools.push(encoded);
    }
  }
  return tools;
}

function latestPromptText(messages = []) {
  const prompts = messages
    .map((message) => ({ role: message.role, prompt: textContent(message.content).trim() }))
    .filter((entry) => entry.prompt);
  const lastUser = [...prompts].reverse().find((entry) => entry.role === "user");
  return (lastUser || prompts[prompts.length - 1] || {}).prompt || "";
}

function buildGetChatMessageRequest(request, apiKey, version = DEFAULT_VERSION, requestId) {
  const model = request.windsurf_model_uid
    ? { modelUid: request.windsurf_model_uid }
    : resolveModel(request.model || request.upstream_model);
  const prompts = (request.messages || [])
    .map((message) => ({ message, prompt: textContent(message.content).trim() }))
    .filter(({ message, prompt }) => prompt || (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0))
    .map(({ message }) => encodeMessage(3, buildChatPrompt(message)));
  const promptText = latestPromptText(request.messages || []);
  const toolDefinitions = toolDefinitionsFromRequest(request);

  if (prompts.length === 0) throw new Error("No prompt text found in request messages");
  return Buffer.concat([
    encodeMessage(1, buildMetadata(apiKey, version, requestId)),
    encodeString(2, promptText),
    ...prompts,
    encodeVarintField(7, 5),
    ...toolDefinitions.map((tool) => encodeMessage(10, tool)),
    ...(request.parallel_tool_calls === false || request.disable_parallel_tool_calls === true ? [encodeVarintField(11, 1)] : []),
    encodeString(21, model.modelUid),
  ]);
}

function buildModelConfigRequest(apiKey, version = DEFAULT_VERSION, requestId = crypto.randomUUID()) {
  return encodeMessage(1, buildMetadata(apiKey, version, requestId));
}

function toWindsurfRequest(provider = {}, input = {}) {
  const model = provider.upstream_model || provider.model || input.model;
  const resolved = provider.windsurf_model_uid ? { modelUid: provider.windsurf_model_uid } : resolveModel(model);
  const output = {
    model,
    windsurf_model_uid: resolved.modelUid,
    messages: normalizeMessagesForWindsurf(input.messages || []),
  };
  if (Array.isArray(input.tools)) output.tools = input.tools;
  if (Array.isArray(input.functions)) output.functions = input.functions;
  if (input.tool_choice != null) output.tool_choice = input.tool_choice;
  if (input.parallel_tool_calls != null) output.parallel_tool_calls = input.parallel_tool_calls;
  if (input.temperature != null) output.temperature = input.temperature;
  if (input.stream != null) output.stream = input.stream;
  return output;
}

function normalizeUsage(usage = {}) {
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function normalizeId(id) {
  if (!id) return "chatcmpl-windsurf";
  return String(id).startsWith("chatcmpl-") ? String(id) : `chatcmpl-${id}`;
}

function parseChatToolCall(buffer) {
  const fields = parseFields(buffer);
  const id = stringField(fields, 1) || `call_${crypto.randomUUID().replace(/-/g, "")}`;
  const name = stringField(fields, 2);
  const args = rawStringField(fields, 3) || "{}";
  if (!name) return null;
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: args,
    },
  };
}

function parseChatToolCallDelta(buffer) {
  const fields = parseFields(buffer);
  return {
    id: stringField(fields, 1),
    name: stringField(fields, 2),
    arguments: rawStringField(fields, 3),
    hasArguments: hasStringField(fields, 3),
  };
}

function parseJsonObjectText(value = "") {
  try {
    const parsed = JSON.parse(String(value || "").trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}

function mergeWindsurfToolArguments(previous = "", incoming = "") {
  const prev = String(previous || "");
  const next = String(incoming || "");
  if (!next) return prev;
  if (!prev) return next;

  const appended = prev + next;
  if (parseJsonObjectText(appended)) return appended;
  if (next === prev || prev.startsWith(next)) return prev;
  if (next.startsWith(prev)) return next;

  const prevObj = parseJsonObjectText(prev);
  const nextObj = parseJsonObjectText(next);
  if (nextObj) {
    if (!prevObj || prev === "{}" || Object.keys(nextObj).length >= Object.keys(prevObj).length) return next;
  }

  return appended;
}

function parseConnectResult(buffer) {
  const parsed = takeConnectEnvelopes(buffer);
  const chunks = [];
  const toolCalls = [];
  const toolCallById = new Map();
  let currentToolCall = null;
  for (const envelope of parsed.envelopes) {
    if ((envelope.flags & 2) !== 0) {
      const trailer = envelope.body.toString("utf8");
      if (trailer.includes('"error"')) throw new Error(trailer);
      continue;
    }
    for (const field of parseFields(envelope.body)) {
      if (field.fieldNum === 3 && Buffer.isBuffer(field.value)) chunks.push(field.value.toString("utf8"));
      if (field.fieldNum === 6 && Buffer.isBuffer(field.value)) {
        const delta = parseChatToolCallDelta(field.value);
        const hasIdentity = Boolean(delta.id || delta.name);
        const id = delta.id || currentToolCall?.id || `call_${crypto.randomUUID().replace(/-/g, "")}`;
        let toolCall = delta.id ? toolCallById.get(delta.id) : null;

        if (!toolCall && hasIdentity) {
          toolCall = {
            id,
            type: "function",
            function: {
              name: delta.name || "",
              arguments: "",
            },
          };
          toolCalls.push(toolCall);
          toolCallById.set(id, toolCall);
        } else if (!toolCall) {
          toolCall = currentToolCall;
        }

        if (!toolCall) continue;
        if (delta.name) toolCall.function.name = delta.name;
        if (delta.hasArguments) {
          toolCall.function.arguments = mergeWindsurfToolArguments(toolCall.function.arguments, delta.arguments);
        }
        currentToolCall = toolCall;
      }
    }
  }
  for (const toolCall of toolCalls) {
    if (!toolCall.function.arguments) toolCall.function.arguments = "{}";
  }
  if (parsed.remaining.length > 0) {
    const error = new Error("Windsurf cloud response ended with an incomplete Connect frame");
    error.body = buffer;
    throw error;
  }
  return { text: chunks.join(""), tool_calls: toolCalls.filter((toolCall) => toolCall.function.name) };
}

function openAIStreamChunk(id, model, created, delta = {}, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

function createOpenAIStreamFrameParser(model) {
  let remaining = Buffer.alloc(0);
  let roleSent = false;
  let finished = false;
  let sawToolCall = false;
  let currentToolCallId = "";
  let nextToolCallIndex = 0;
  const id = "chatcmpl-windsurf";
  const created = Math.floor(Date.now() / 1000);
  const toolCallIndexes = new Map();
  const toolCallArguments = new Map();
  const emittedToolCallArguments = new Map();

  function ensureRole(chunks) {
    if (roleSent) return;
    roleSent = true;
    chunks.push(openAIStreamChunk(id, model, created, { role: "assistant" }, null));
  }

  function toolIndex(toolCallId) {
    const key = toolCallId || currentToolCallId || `call_${nextToolCallIndex}`;
    if (!toolCallIndexes.has(key)) toolCallIndexes.set(key, nextToolCallIndex++);
    return toolCallIndexes.get(key);
  }

  function argumentDeltaFor(toolCallId, incoming = "") {
    const previous = toolCallArguments.get(toolCallId) || "";
    const merged = mergeWindsurfToolArguments(previous, incoming);
    toolCallArguments.set(toolCallId, merged);

    const parsedMerged = parseJsonObjectText(merged);
    if (!parsedMerged) return "";

    const emitted = emittedToolCallArguments.get(toolCallId) || "";
    if (!emitted && Object.keys(parsedMerged).length === 0) return "";
    if (!emitted) {
      emittedToolCallArguments.set(toolCallId, merged);
      return merged;
    }
    if (merged === emitted || emitted.startsWith(merged)) return "";
    if (merged.startsWith(emitted)) {
      const suffix = merged.slice(emitted.length);
      emittedToolCallArguments.set(toolCallId, merged);
      return suffix;
    }
    return "";
  }

  function flushPendingToolArguments(chunks) {
    for (const [toolCallId, merged] of toolCallArguments.entries()) {
      if (!parseJsonObjectText(merged)) continue;
      if (emittedToolCallArguments.get(toolCallId)) continue;
      emittedToolCallArguments.set(toolCallId, merged);
      chunks.push(openAIStreamChunk(id, model, created, {
        tool_calls: [{
          index: toolIndex(toolCallId),
          function: { arguments: merged },
        }],
      }, null));
    }
  }

  function finish(chunks) {
    if (finished) return;
    finished = true;
    flushPendingToolArguments(chunks);
    chunks.push(openAIStreamChunk(id, model, created, {}, sawToolCall ? "tool_calls" : "stop"));
  }

  return {
    push(chunk) {
      if (finished || !chunk || chunk.length === 0) return [];
      remaining = Buffer.concat([remaining, Buffer.from(chunk)]);
      const parsed = takeConnectEnvelopes(remaining);
      remaining = parsed.remaining;
      const chunks = [];

      for (const envelope of parsed.envelopes) {
        if ((envelope.flags & 2) !== 0) {
          const trailer = envelope.body.toString("utf8");
          if (trailer.includes('"error"')) throw new Error(trailer);
          finish(chunks);
          continue;
        }

        for (const field of parseFields(envelope.body)) {
          if (field.fieldNum === 3 && Buffer.isBuffer(field.value)) {
            ensureRole(chunks);
            chunks.push(openAIStreamChunk(id, model, created, { content: field.value.toString("utf8") }, null));
          }
          if (field.fieldNum === 6 && Buffer.isBuffer(field.value)) {
            const delta = parseChatToolCallDelta(field.value);
            const hasDelta = Boolean(delta.id || delta.name || delta.hasArguments);
            if (!hasDelta) continue;
            sawToolCall = true;
            const toolCallId = delta.id || currentToolCallId || `call_${crypto.randomUUID().replace(/-/g, "")}`;
            currentToolCallId = toolCallId;
            const argumentDelta = delta.hasArguments ? argumentDeltaFor(toolCallId, delta.arguments) : "";
            if (!delta.id && !delta.name && !argumentDelta) continue;
            ensureRole(chunks);
            const toolCall = { index: toolIndex(toolCallId) };
            if (delta.id) toolCall.id = delta.id;
            if (delta.name || argumentDelta) {
              toolCall.function = {};
              if (delta.name) {
                toolCall.type = "function";
                toolCall.function.name = delta.name;
              }
              if (argumentDelta) toolCall.function.arguments = argumentDelta;
            }
            chunks.push(openAIStreamChunk(id, model, created, { tool_calls: [toolCall] }, null));
          }
        }
      }

      return chunks;
    },
    end() {
      const chunks = [];
      if (remaining.length > 0) {
        const error = new Error("Windsurf cloud response ended with an incomplete Connect frame");
        error.body = remaining;
        throw error;
      }
      finish(chunks);
      return chunks;
    },
  };
}

function parseConnectText(buffer) {
  return parseConnectResult(buffer).text;
}

function textFromResponse(response) {
  if (response == null) return "";
  if (Buffer.isBuffer(response)) return parseConnectText(response);
  if (typeof response === "string") return response;
  if (response.message && response.message.content != null) return textContent(response.message.content);
  if (response.content != null) return textContent(response.content);
  if (response.output != null) return textContent(response.output);
  return "";
}

function toOpenAIResponse(model, response) {
  if (Buffer.isBuffer(response)) {
    const result = parseConnectResult(response);
    const message = {
      role: "assistant",
      content: result.tool_calls.length > 0 && !result.text ? null : result.text,
    };
    if (result.tool_calls.length > 0) message.tool_calls = result.tool_calls;
    return {
      id: "chatcmpl-windsurf",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: result.tool_calls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  const normalized = response && typeof response === "object" && !Buffer.isBuffer(response) ? response : { output: response };
  const usage = normalizeUsage(normalized.usage);

  if (Array.isArray(normalized.choices)) {
    return {
      id: normalizeId(normalized.id),
      object: normalized.object || "chat.completion",
      created: normalized.created || Math.floor(Date.now() / 1000),
      model,
      choices: normalized.choices,
      usage,
    };
  }

  const sourceMessage = normalized.message && typeof normalized.message === "object" ? normalized.message : {};
  return {
    id: normalizeId(normalized.id),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: sourceMessage.role || normalized.role || "assistant",
          content: textFromResponse(normalized.output != null ? normalized.output : normalized),
        },
        finish_reason: normalized.finish_reason || normalized.stop_reason || "stop",
      },
    ],
    usage,
  };
}

function postJson(url, headers, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const payload = JSON.stringify(body);
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    }

    const request = client.request(
      target,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          finish(null, { status: response.statusCode, headers: response.headers, body: data });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`Windsurf HTTP request timeout after ${timeoutMs}ms`);
      request.destroy(error);
      finish(error);
    });
    request.on("error", finish);
    request.write(payload);
    request.end();
  });
}

function isRetryableTransportError(error) {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error?.code || error?.message || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postConnectEnvelopeOnce(provider = {}, payload) {
  return new Promise((resolve, reject) => {
    const origin = resolveWindsurfOrigin(provider, { kind: "chat" });
    const path = provider.path || GET_CHAT_MESSAGE_PATH;
    const timeoutMs = windsurfTimeoutMs(provider);
    const client = http2.connect(origin);
    let settled = false;
    let stream;
    const timeout = setTimeout(() => {
      const error = new Error(`Windsurf Connect request timeout after ${timeoutMs}ms`);
      if (stream) stream.close(http2.constants.NGHTTP2_CANCEL);
      client.destroy(error);
      finish(error);
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.close();
      if (error) reject(error);
      else resolve(value);
    }

    client.once("error", finish);
    client.once("connect", () => {
      stream = client.request({
        ":method": "POST",
        ":path": path,
        ...buildHeaders(provider),
      });
      const chunks = [];
      let headers = {};
      stream.once("response", (responseHeaders) => {
        headers = responseHeaders;
      });
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("error", finish);
      stream.once("end", () => {
        finish(null, {
          status: Number(headers[":status"] || 0),
          headers,
          body: Buffer.concat(chunks),
        });
      });
      stream.end(payload);
    });
  });
}

async function postConnectEnvelope(provider = {}, payload) {
  const attempts = Number(provider.windsurf_retries ?? process.env.WINDSURF_CONNECT_RETRIES ?? 1) + 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await postConnectEnvelopeOnce(provider, payload);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableTransportError(error)) throw error;
      await sleep(Math.min(250 * attempt, 1000));
    }
  }
  throw lastError;
}

function postConnect(provider = {}, request) {
  const apiKey = provider.key || readHostToken();
  const version = provider.windsurf_version || provider.version || process.env.WINDSURF_IDE_VERSION || DEFAULT_VERSION;
  const rawRequest = buildGetChatMessageRequest(request, apiKey, version);
  const payload = connectEnvelope(rawRequest);
  dumpWindsurfDebug("request", provider, request, {
    version,
    rawRequest,
    payload,
    headers: buildHeaders(provider),
  });
  return postConnectEnvelope(provider, payload).then((response) => {
    dumpWindsurfDebug("response", provider, request, { response });
    return response;
  });
}

function streamWindsurfCloud(provider = {}, input = {}, handlers = {}) {
  const request = toWindsurfRequest(provider, { ...input, stream: true });
  const apiKey = provider.key || readHostToken();
  const version = provider.windsurf_version || provider.version || process.env.WINDSURF_IDE_VERSION || DEFAULT_VERSION;
  const rawRequest = buildGetChatMessageRequest(request, apiKey, version);
  const payload = connectEnvelope(rawRequest);
  const parser = createOpenAIStreamFrameParser(input.model || provider.model || request.model);
  const timeoutMs = windsurfStreamTimeoutMs(provider);

  dumpWindsurfDebug("request", provider, request, {
    version,
    rawRequest,
    payload,
    headers: buildHeaders(provider, { timeoutMs }),
  });

  return new Promise((resolve, reject) => {
    const origin = resolveWindsurfOrigin(provider, { kind: "chat" });
    const path = provider.path || GET_CHAT_MESSAGE_PATH;
    const client = http2.connect(origin);
    let stream;
    let settled = false;
    let status = 0;
    let headers = {};
    const errorChunks = [];
    const debugChunks = shouldDumpWindsurfDebug() ? [] : null;
    let timeout;
    function armTimeout() {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const error = new Error(`Windsurf Connect stream timeout after ${timeoutMs}ms`);
        if (stream) stream.close(http2.constants.NGHTTP2_CANCEL);
        client.destroy(error);
        finish(error);
      }, timeoutMs);
    }
    armTimeout();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.close();
      if (error) reject(error);
      else resolve(value);
    }

    client.once("error", finish);
    client.once("connect", () => {
      stream = client.request({
        ":method": "POST",
        ":path": path,
        ...buildHeaders(provider, { timeoutMs }),
      });
      stream.once("response", (responseHeaders) => {
        headers = responseHeaders;
        status = Number(headers[":status"] || 0);
        handlers.onHeaders?.(status, headers);
        armTimeout();
      });
      stream.on("data", (chunk) => {
        armTimeout();
        const copy = Buffer.from(chunk);
        if (debugChunks) debugChunks.push(copy);
        if (status >= 400) {
          errorChunks.push(copy);
          return;
        }
        try {
          for (const sseChunk of parser.push(copy)) handlers.onChunk?.(sseChunk);
        } catch (error) {
          finish(error);
        }
      });
      stream.once("error", finish);
      stream.once("end", () => {
        if (status >= 400) {
          const error = new Error(`Windsurf cloud stream failed with status ${status}`);
          error.status = status;
          error.headers = headers;
          error.body = Buffer.concat(errorChunks);
          finish(error);
          return;
        }
        try {
          for (const sseChunk of parser.end()) handlers.onChunk?.(sseChunk);
          handlers.onChunk?.("data: [DONE]\n\n");
          if (debugChunks) {
            dumpWindsurfDebug("response", provider, request, {
              response: { status, headers, body: Buffer.concat(debugChunks) },
            });
          }
          finish(null, { status, headers });
        } catch (error) {
          finish(error);
        }
      });
      stream.end(payload);
    });
  });
}

function shouldDumpWindsurfDebug() {
  return process.env.DEV_MODE === "true" || process.env.WINDSURF_DEBUG_RAW === "true";
}

function sanitizeResponseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/authorization|cookie|token|key/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function dumpWindsurfDebug(kind, provider = {}, request = {}, data = {}) {
  if (!shouldDumpWindsurfDebug()) return;
  try {
    const dataDir = process.env.DATA_DIR || "/data";
    fs.mkdirSync(dataDir, { recursive: true });
    const target = path.join(dataDir, `dev-last-windsurf-${kind}.json`);
    const toolCount = (request.tools || []).length + (request.functions || []).length;
    const messageCount = (request.messages || []).length;
    const meta = {
      kind,
      provider: provider.name,
      model: provider.model || request.model,
      upstream_model: provider.upstream_model,
      windsurf_model_uid: request.windsurf_model_uid || provider.windsurf_model_uid,
      origin: resolveWindsurfOrigin(provider, { kind: kind === "model-config" ? "config" : "chat" }),
      path: provider.path || GET_CHAT_MESSAGE_PATH,
      messages: messageCount,
      tools: toolCount,
      stream: request.stream === true,
      request_bytes: data.payload?.length,
      proto_bytes: data.rawRequest?.length,
      headers: data.headers ? sanitizeResponseHeaders(data.headers) : undefined,
      response_status: data.response?.status,
      response_headers: data.response ? sanitizeResponseHeaders(data.response.headers || {}) : undefined,
      response_bytes: Buffer.isBuffer(data.response?.body) ? data.response.body.length : undefined,
      response_preview: Buffer.isBuffer(data.response?.body)
        ? data.response.body.toString("utf8").slice(0, 500)
        : undefined,
    };
    fs.writeFileSync(target, JSON.stringify(meta, null, 2), { mode: 0o600 });
  } catch {}
}

function postModelConfigProto(provider = {}, payload) {
  return new Promise((resolve, reject) => {
    const origin = resolveWindsurfOrigin(provider, { kind: "config" });
    const path = provider.path;
    const timeoutMs = windsurfTimeoutMs(provider);
    const client = http2.connect(origin);
    let settled = false;
    let stream;
    const timeout = setTimeout(() => {
      const error = new Error(`Windsurf model config request timeout after ${timeoutMs}ms`);
      if (stream) stream.close(http2.constants.NGHTTP2_CANCEL);
      client.destroy(error);
      finish(error);
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.close();
      if (error) reject(error);
      else resolve(value);
    }

    client.once("error", finish);
    client.once("connect", () => {
      stream = client.request({
        ":method": "POST",
        ":path": path,
        "content-type": "application/proto",
        accept: "application/proto",
        "user-agent": provider.windsurf_user_agent || process.env.WINDSURF_USER_AGENT || DEFAULT_USER_AGENT,
      });
      const chunks = [];
      let headers = {};
      stream.once("response", (responseHeaders) => {
        headers = responseHeaders;
      });
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("error", finish);
      stream.once("end", () => {
        finish(null, {
          status: Number(headers[":status"] || 0),
          headers,
          body: Buffer.concat(chunks),
        });
      });
      stream.end(payload);
    });
  });
}

function postWindsurf(provider = {}, request) {
  if (provider.url && /^https?:\/\//.test(provider.url)) {
    return postJson(provider.url, provider.headers || {}, request, windsurfTimeoutMs(provider));
  }
  return postConnect(provider, request);
}

async function fetchWindsurfModelConfigs(provider = {}, options = {}) {
  const apiKey = provider.key || readHostToken();
  if (!apiKey) return [];

  const version = provider.windsurf_version || provider.version || process.env.WINDSURF_IDE_VERSION || DEFAULT_VERSION;
  const requestId = provider.request_id || crypto.randomUUID();
  const paths = options.paths || WINDSURF_MODEL_CONFIG_PATHS;
  const postFn = options.postModelConfigFn || postModelConfigProto;
  const models = [];
  const seen = new Set();

  for (const path of paths) {
    try {
      const payload = buildModelConfigRequest(apiKey, version, requestId);
      const response = await postFn({ ...provider, path }, payload);
      if (!response || response.status < 200 || response.status >= 300 || !Buffer.isBuffer(response.body)) continue;
      for (const model of parseWindsurfModelConfigs(response.body)) {
        const key = model.windsurf_model_uid || model.id;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        models.push(model);
      }
    } catch {
      // Some Windsurf app config RPCs are version-gated or intentionally
      // unimplemented; discovery keeps trying the remaining endpoints.
    }
  }

  return models;
}

async function callWindsurfCloud(provider = {}, input = {}) {
  const request = toWindsurfRequest(provider, input);
  const response = await postWindsurf(provider, request);

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Windsurf cloud request failed with status ${response.status}`);
    error.status = response.status;
    error.body = response.body;
    throw error;
  }

  if (Buffer.isBuffer(response.body)) return toOpenAIResponse(input.model, response.body);
  try {
    return toOpenAIResponse(input.model, JSON.parse(response.body));
  } catch {
    return toOpenAIResponse(input.model, { output: response.body });
  }
}

module.exports = {
  CODEIUM_API_ORIGIN,
  WINDSURF_ENTERPRISE_API_ORIGIN,
  GET_CHAT_MESSAGE_PATH,
  GET_USER_STATUS_PATH,
  GET_CASCADE_MODEL_CONFIGS_PATH,
  GET_COMMAND_MODEL_CONFIGS_PATH,
  WINDSURF_MODEL_CONFIG_PATHS,
  WINDSURF_DEFAULT_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
  FALLBACK_MODELS,
  resolveModel,
  buildWindsurfProviders,
  parseWindsurfModelConfigs,
  parseConfiguredModels,
  resolveWindsurfOrigin,
  buildHeaders,
  toWindsurfRequest,
  toOpenAIResponse,
  fetchWindsurfModelConfigs,
  createOpenAIStreamFrameParser,
  postWindsurf,
  streamWindsurfCloud,
  postModelConfigProto,
  callWindsurfCloud,
  encodeVarint,
  encodeString,
  encodeMessage,
  encodeVarintField,
  connectEnvelope,
  readVarint,
  parseFields,
  takeConnectEnvelopes,
  parseConnectResult,
  buildMetadata,
  buildChatToolCall,
  buildChatPrompt,
  buildGetChatMessageRequest,
  buildModelConfigRequest,
  toolDefinitionFromOpenAI,
  windsurfToolDescription,
};
