"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const mediaContent = require("./media-content");

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_CODE_CACHE_CONTROL_LIMIT = 4;
const CLAUDE_CODE_SDK_SYSTEM_TEXT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

function contentToText(content) {
  if (Array.isArray(content)) return mediaContent.textFromContent(content);
  return content == null ? "" : String(content);
}

function hasNonWhitespaceText(value) {
  return String(value == null ? "" : value).trim().length > 0;
}

function textContentBlock(content) {
  const text = contentToText(content);
  return hasNonWhitespaceText(text) ? { type: "text", text } : null;
}

function sanitizeAnthropicContent(content) {
  if (typeof content === "string") return hasNonWhitespaceText(content) ? content : "";
  if (!Array.isArray(content)) {
    const text = content == null ? "" : String(content);
    return hasNonWhitespaceText(text) ? text : "";
  }

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      if (hasNonWhitespaceText(part.text)) blocks.push({ ...part, text: String(part.text) });
      continue;
    }
    blocks.push(part);
  }
  return blocks;
}

function anthropicContentHasValue(content) {
  if (typeof content === "string") return hasNonWhitespaceText(content);
  if (!Array.isArray(content)) return hasNonWhitespaceText(content);
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    if (part.type === "text") return hasNonWhitespaceText(part.text);
    return true;
  });
}

function pushAnthropicMessage(messages, message) {
  const content = sanitizeAnthropicContent(message.content);
  if (!anthropicContentHasValue(content)) return;
  messages.push({ ...message, content });
}

function parseToolArguments(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toolUseBlock(toolCall) {
  const fn = toolCall.function || {};
  return {
    type: "tool_use",
    id: toolCall.id,
    name: fn.name,
    input: parseToolArguments(fn.arguments),
  };
}

function toolResultBlock(message) {
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    content: contentToText(message.content),
  };
}

function convertOpenAIMessage(message) {
  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    const content = [];
    const text = textContentBlock(message.content);
    if (text) content.push(text);
    content.push(...message.tool_calls.map(toolUseBlock));
    return { role: "assistant", content };
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: mediaContent.toAnthropicContent(message.content),
    };
  }
  return {
    role: message.role,
    content: contentToText(message.content),
  };
}

function toAnthropicTool(tool) {
  if (!tool || tool.type !== "function" || !tool.function) return null;
  return {
    name: tool.function.name,
    description: tool.function.description || "",
    input_schema: tool.function.parameters || { type: "object" },
  };
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function parseMetadataUserId(metadata = {}) {
  const raw = metadata?.user_id;
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function addEphemeralCacheControl(block, budget) {
  if (!block || typeof block !== "object") return block;
  if (block.cache_control) {
    if (!budget || budget.remaining > 0) {
      if (budget) budget.remaining -= 1;
      return block;
    }
    const { cache_control: _cacheControl, ...rest } = block;
    return rest;
  }
  if (budget && budget.remaining <= 0) return block;
  if (budget) budget.remaining -= 1;
  return { ...block, cache_control: { type: "ephemeral" } };
}

function textBlockWithCache(text, budget) {
  const value = String(text || "");
  if (!hasNonWhitespaceText(value)) return null;
  return addEphemeralCacheControl({ type: "text", text: value }, budget);
}

function normalizeSystemForClaudeCode(system, budget) {
  if (!system) return undefined;
  if (Array.isArray(system)) {
    const parts = system
      .map((part) => {
        if (part && typeof part === "object" && part.type === "text") {
          if (!hasNonWhitespaceText(part.text)) return null;
          return addEphemeralCacheControl(part, budget);
        }
        return textBlockWithCache(contentToText(part), budget);
      })
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  const block = textBlockWithCache(system, budget);
  return block ? [block] : undefined;
}

function systemPartText(part) {
  if (typeof part === "string") return part;
  if (part && typeof part === "object" && part.type === "text") return String(part.text || "");
  return contentToText(part);
}

function hasClaudeCodeSdkSystem(system) {
  const parts = Array.isArray(system) ? system : (system ? [system] : []);
  return parts.some((part) => /Claude Agent SDK/.test(systemPartText(part)));
}

function withClaudeCodeSdkSystem(system) {
  if (hasClaudeCodeSdkSystem(system)) return system;
  const sdkBlock = { type: "text", text: CLAUDE_CODE_SDK_SYSTEM_TEXT };
  if (!system) return [sdkBlock];
  if (Array.isArray(system)) return [sdkBlock, ...system];
  return [sdkBlock, { type: "text", text: String(system || "") }];
}

function normalizeMessageContentForClaudeCode(content, budget) {
  if (Array.isArray(content)) {
    if (content.length === 0) return content;
    const copy = content
      .map((part) => (part && typeof part === "object" ? { ...part } : part))
      .filter((part) => !(part && typeof part === "object" && part.type === "text" && !hasNonWhitespaceText(part.text)));
    if (copy.length === 0) return [];
    for (let i = copy.length - 1; i >= 0; i -= 1) {
      if (copy[i] && typeof copy[i] === "object") {
        copy[i] = addEphemeralCacheControl(copy[i], budget);
        return copy;
      }
    }
    return copy;
  }
  const block = textBlockWithCache(content, budget);
  return block ? [block] : [];
}

function claudeCodeVersion(env = process.env) {
  return String(env.CLAUDE_CODE_VERSION || env.LLM_PROXY_CLAUDE_CODE_VERSION || "").trim();
}

function claudeCodeProfile(input = {}, options = {}) {
  const env = options.env || process.env;
  const metadata = input._claudeCodeMetadata || input.metadata || {};
  const parsed = parseMetadataUserId(metadata);
  const profile = input._claudeCodeProfile || {};
  const sessionId = options.sessionId ||
    input._claudeCodeSessionId ||
    profile.sessionId ||
    parsed.session_id ||
    env.CLAUDE_CODE_SESSION_ID ||
    randomId();
  return {
    deviceId: profile.deviceId || parsed.device_id || env.CLAUDE_CODE_DEVICE_ID || "",
    accountUuid: profile.accountUuid || parsed.account_uuid || env.CLAUDE_CODE_ACCOUNT_UUID || "",
    sessionId,
  };
}

function claudeCodeRequestShape(input = {}, options = {}) {
  const env = options.env || process.env;
  const shape = input._claudeCodeRequestShape || {};
  const maxTokens = parsePositiveInt(env.CLAUDE_CODE_MAX_TOKENS || env.LLM_PROXY_CLAUDE_CODE_MAX_TOKENS);
  const outputEffort = shape.output_config?.effort || env.CLAUDE_CODE_OUTPUT_EFFORT || env.LLM_PROXY_CLAUDE_CODE_OUTPUT_EFFORT || "";
  return {
    maxTokens,
    thinking: shape.thinking || input.thinking || { type: "adaptive" },
    contextManagement: shape.context_management || input.context_management || { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    outputConfig: shape.output_config || input.output_config || (outputEffort ? { effort: outputEffort } : undefined),
  };
}

function thinkingRequiresDefaultTemperature(thinking) {
  if (!thinking || typeof thinking !== "object") return false;
  const type = String(thinking.type || "").trim().toLowerCase();
  return type && type !== "disabled" && type !== "none";
}

function thinkingType(thinking = null) {
  if (!thinking || typeof thinking !== "object") return "";
  return String(thinking.type || "").trim().toLowerCase();
}

function providerRejectsAdaptiveThinking(provider = {}) {
  let compat = {};
  if (provider.name) {
    try {
      compat = require("./scoring").getCompat(provider.name);
    } catch {
      compat = {};
    }
  }
  return compat.no_adaptive_thinking === true || provider.supports_adaptive_thinking === false;
}

function claudeCodeThinkingSupported(provider = {}, input = {}, thinking = null) {
  if (thinkingType(thinking || input.thinking) === "adaptive" && providerRejectsAdaptiveThinking(provider)) {
    return false;
  }
  const text = [
    provider.upstream_model,
    provider.model,
    provider.name,
    input.model,
  ].filter(Boolean).join(" ").toLowerCase();
  return !/\bhaiku\b/.test(text);
}

function shouldUseClaudeCodeRequestShape(provider = {}, options = {}) {
  const env = options.env || process.env;
  return useClaudeCodeFingerprint(provider, env) && !!claudeCodeVersion(env);
}

function applyClaudeCodeRequestShape(provider, input, output, options = {}) {
  if (!shouldUseClaudeCodeRequestShape(provider, options)) return output;
  const profile = claudeCodeProfile(input, options);
  const shape = claudeCodeRequestShape(input, options);
  if (shape.maxTokens) output.max_tokens = shape.maxTokens;
  const cacheBudget = { remaining: CLAUDE_CODE_CACHE_CONTROL_LIMIT };
  output.metadata = {
    ...(input.metadata || {}),
    ...(input._claudeCodeMetadata || {}),
    user_id: JSON.stringify({
      device_id: profile.deviceId,
      account_uuid: profile.accountUuid,
      session_id: profile.sessionId,
    }),
  };
  output.system = normalizeSystemForClaudeCode(withClaudeCodeSdkSystem(output.system), cacheBudget);
  output.messages = (output.messages || []).map((message) => ({ ...message }));
  for (let i = output.messages.length - 1; i >= 0; i -= 1) {
    output.messages[i].content = normalizeMessageContentForClaudeCode(output.messages[i].content, cacheBudget);
  }
  output.messages = output.messages.filter((message) => anthropicContentHasValue(message.content));
  if (!Array.isArray(output.tools)) output.tools = [];
  if (claudeCodeThinkingSupported(provider, input, shape.thinking)) {
    output.thinking = shape.thinking;
    if (thinkingRequiresDefaultTemperature(output.thinking) && output.temperature != null && Number(output.temperature) !== 1) {
      delete output.temperature;
    }
    output.context_management = shape.contextManagement;
    if (shape.outputConfig) output.output_config = shape.outputConfig;
  }
  return output;
}

function withClaudeCodeSdkScaffold(provider = {}, request = {}, options = {}) {
  if (!shouldUseClaudeCodeRequestShape(provider, options)) return request;
  if (hasClaudeCodeSdkSystem(request.system)) return request;
  const cacheBudget = { remaining: CLAUDE_CODE_CACHE_CONTROL_LIMIT };
  return {
    ...request,
    system: normalizeSystemForClaudeCode(withClaudeCodeSdkSystem(request.system), cacheBudget),
  };
}

function sanitizeAnthropicRequestForProvider(provider = {}, request = {}) {
  if (!request || typeof request !== "object") return request;
  if (thinkingType(request.thinking) !== "adaptive" || !providerRejectsAdaptiveThinking(provider)) return request;
  const sanitized = { ...request };
  delete sanitized.thinking;
  delete sanitized.context_management;
  delete sanitized.output_config;
  return sanitized;
}

function toAnthropicRequest(provider, input, options = {}) {
  const output = {
    model: provider.upstream_model || input.model,
    messages: [],
  };
  const system = [];
  let pendingToolResults = [];

  function flushToolResults() {
    if (pendingToolResults.length === 0) return;
    output.messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  }

  for (const message of input.messages || []) {
    if (message.role === "system") {
      system.push(contentToText(message.content));
      continue;
    }
    if (message.role === "tool") {
      pendingToolResults.push(toolResultBlock(message));
      continue;
    }
    const converted = convertOpenAIMessage(message);
    if (!anthropicContentHasValue(sanitizeAnthropicContent(converted.content))) continue;
    flushToolResults();
    pushAnthropicMessage(output.messages, converted);
  }
  flushToolResults();

  const systemText = system.filter((part) => hasNonWhitespaceText(part)).join("\n");
  if (systemText) output.system = systemText;
  output.max_tokens = input.max_tokens != null ? input.max_tokens : DEFAULT_MAX_TOKENS;
  if (input.temperature != null) output.temperature = input.temperature;
  if (input.stream != null) output.stream = input.stream;
  if (Array.isArray(input.tools)) {
    output.tools = input.tools.map(toAnthropicTool).filter(Boolean);
  }

  return applyClaudeCodeRequestShape(provider, input, output, options);
}

function finishReason(stopReason) {
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  return stopReason || null;
}

function parseSseEvents(body) {
  return String(body || "")
    .split(/\n\n/)
    .map((event) =>
      event
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
    )
    .filter(Boolean);
}

function anthropicUsageToOpenAI(usage = {}) {
  const uncachedInputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const inputTokens = uncachedInputTokens + cacheCreationTokens + cacheReadTokens;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(cacheCreationTokens || cacheReadTokens ? {
      prompt_tokens_details: {
        cached_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_read_tokens: cacheReadTokens,
      },
      input_tokens_details: {
        cached_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_read_tokens: cacheReadTokens,
      },
    } : {}),
  };
}

function hasUsage(usage = {}) {
  return Boolean(
    usage.input_tokens ||
    usage.output_tokens ||
    usage.cache_creation_input_tokens ||
    usage.cache_read_input_tokens
  );
}

function streamChunk(id, model, delta, finishReasonValue, usage) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReasonValue == null ? null : finishReasonValue,
      },
    ],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function toSseData(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function toOpenAIStream(model, anthropicSseBody) {
  let id = "chatcmpl-anthropic";
  const chunks = [];
  const usage = {};

  function mergeUsage(next = {}) {
    if (next.input_tokens != null) usage.input_tokens = next.input_tokens;
    if (next.output_tokens != null) usage.output_tokens = next.output_tokens;
    if (next.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = next.cache_creation_input_tokens;
    if (next.cache_read_input_tokens != null) usage.cache_read_input_tokens = next.cache_read_input_tokens;
  }

  for (const data of parseSseEvents(anthropicSseBody)) {
    if (data === "[DONE]") {
      chunks.push("data: [DONE]\n\n");
      continue;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    if (event.type === "message_start") {
      if (event.message && event.message.id) id = `chatcmpl-${event.message.id}`;
      mergeUsage(event.message?.usage);
      chunks.push(toSseData(streamChunk(id, model, { role: event.message && event.message.role ? event.message.role : "assistant" }, null)));
    } else if (event.type === "content_block_start" && event.content_block && event.content_block.type === "tool_use") {
      chunks.push(
        toSseData(
          streamChunk(
            id,
            model,
            {
              tool_calls: [
                {
                  index: event.index || 0,
                  id: event.content_block.id,
                  type: "function",
                  function: { name: event.content_block.name, arguments: "" },
                },
              ],
            },
            null
          )
        )
      );
    } else if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") {
      chunks.push(toSseData(streamChunk(id, model, { content: event.delta.text || "" }, null)));
    } else if (event.type === "content_block_delta" && event.delta && event.delta.type === "input_json_delta") {
      chunks.push(
        toSseData(
          streamChunk(
            id,
            model,
            { tool_calls: [{ index: event.index || 0, function: { arguments: event.delta.partial_json || "" } }] },
            null
          )
        )
      );
    } else if (event.type === "message_delta") {
      mergeUsage(event.usage);
      const stopReason = event.delta && event.delta.stop_reason;
      if (stopReason) {
        chunks.push(toSseData(streamChunk(
          id,
          model,
          {},
          finishReason(stopReason),
          hasUsage(usage) ? anthropicUsageToOpenAI(usage) : undefined
        )));
      }
    } else if (event.type === "message_stop") {
      chunks.push("data: [DONE]\n\n");
    }
  }

  return chunks.join("");
}

function textFromAnthropicContent(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function toolCallsFromAnthropicContent(content) {
  if (!Array.isArray(content)) return undefined;
  const calls = content
    .filter((part) => part && part.type === "tool_use")
    .map((part) => ({
      id: part.id,
      type: "function",
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input || {}),
      },
    }));
  return calls.length > 0 ? calls : undefined;
}

function toOpenAIResponse(model, response) {
  const usage = anthropicUsageToOpenAI(response.usage || {});
  const message = {
    role: response.role || "assistant",
    content: textFromAnthropicContent(response.content),
  };
  const toolCalls = toolCallsFromAnthropicContent(response.content);
  if (toolCalls) {
    message.tool_calls = toolCalls;
    if (!message.content) message.content = null;
  }

  return {
    id: `chatcmpl-${response.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason(response.stop_reason),
      },
    ],
    usage,
  };
}

function usesPlatformApiKey(provider = {}) {
  return provider.key_env === "ANTHROPIC_API_KEY" || /^sk-ant-api/i.test(provider.key || "");
}

function isClaudeAnthropicProvider(provider = {}) {
  const family = String(provider.family || provider.source_family || "").trim().toLowerCase();
  const protocol = String(provider.protocol || "").trim().toLowerCase();
  const model = String(provider.model || provider.upstream_model || "").trim().toLowerCase();
  const name = String(provider.name || "").trim().toLowerCase();
  return family === "claude" || protocol === "anthropic" || model.startsWith("claude/") || name.startsWith("claude-");
}

function useClaudeCodeFingerprint(provider = {}, env = process.env) {
  if (String(env.LLM_PROXY_CLAUDE_CODE_FINGERPRINT || "true").toLowerCase() === "false") return false;
  if (provider.key_env === "CLAUDE_CODE_OAUTH_TOKEN") return true;
  return isClaudeAnthropicProvider(provider);
}

function claudeCodeBuild(env = process.env) {
  return String(env.CLAUDE_CODE_BILLING_BUILD || env.LLM_PROXY_CLAUDE_CODE_BUILD || "").trim();
}

function claudeCodeBetas(env = process.env) {
  return String(env.CLAUDE_CODE_BETAS || env.LLM_PROXY_CLAUDE_CODE_BETAS || "").trim();
}

function stainlessPackageVersion(env = process.env) {
  return String(env.CLAUDE_CODE_STAINLESS_PACKAGE_VERSION || env.LLM_PROXY_CLAUDE_CODE_STAINLESS_PACKAGE_VERSION || "").trim();
}

function stainlessOs() {
  if (process.platform === "darwin") return "MacOS";
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
}

function claudeCodeFingerprintHeaders(options = {}) {
  const env = options.env || process.env;
  const version = claudeCodeVersion(env);
  if (!version) return {};
  const build = claudeCodeBuild(env);
  const sessionId = options.sessionId || randomId();
  const clientRequestId = options.clientRequestId || randomId();
  const headers = {
    accept: "application/json",
    "user-agent": `claude-cli/${version} (external, sdk-cli)`,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
    "x-client-request-id": clientRequestId,
    "x-stainless-arch": process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": stainlessOs(),
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (build) headers["x-anthropic-billing-header"] = `cc_version=${version}.${build}; cc_entrypoint=sdk-cli; cch=00000;`;
  const packageVersion = stainlessPackageVersion(env);
  if (packageVersion) headers["x-stainless-package-version"] = packageVersion;
  const betas = claudeCodeBetas(env);
  if (betas) headers["anthropic-beta"] = betas;
  return headers;
}

function buildHeaders(provider, options = {}) {
  const env = options.env || process.env;
  const headers = {
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };

  if (usesPlatformApiKey(provider)) {
    headers["x-api-key"] = provider.key;
  } else {
    headers.Authorization = `Bearer ${provider.key}`;
  }

  if (useClaudeCodeFingerprint(provider, env)) {
    Object.assign(headers, claudeCodeFingerprintHeaders(options));
  }

  return headers;
}

function appendClaudeCodeBetaQuery(urlStr) {
  const target = new URL(urlStr);
  if (!target.searchParams.has("beta")) target.searchParams.set("beta", "true");
  return target.toString();
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const payload = JSON.stringify(body);
    const request = client.request(
      target,
      {
        method: "POST",
        headers: {
          ...headers,
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
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: data,
          });
        });
      }
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function postAnthropic(provider, request, options = {}) {
  const env = options.env || process.env;
  let url = /^https?:\/\//.test(provider.url || "") ? provider.url : DEFAULT_MESSAGES_URL;
  if (useClaudeCodeFingerprint(provider, env) && claudeCodeVersion(env)) url = appendClaudeCodeBetaQuery(url);
  return postJson(url, buildHeaders(provider, options), sanitizeAnthropicRequestForProvider(provider, request));
}

module.exports = {
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  toAnthropicRequest,
  toOpenAIResponse,
  toOpenAIStream,
  usesPlatformApiKey,
  buildHeaders,
  postAnthropic,
  parseMetadataUserId,
  hasClaudeCodeSdkSystem,
  withClaudeCodeSdkScaffold,
  sanitizeAnthropicRequestForProvider,
};
