"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const mediaContent = require("./media-content");
const { stripResponseProxyArtifacts } = require("./responses");

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
  if (typeof content === "string") {
    const stripped = stripResponseProxyArtifacts(content).text;
    return hasNonWhitespaceText(stripped) ? stripped : "";
  }
  if (!Array.isArray(content)) {
    const stripped = stripResponseProxyArtifacts(content == null ? "" : String(content)).text;
    return hasNonWhitespaceText(stripped) ? stripped : "";
  }

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      const stripped = stripResponseProxyArtifacts(part.text).text;
      if (hasNonWhitespaceText(stripped)) blocks.push({ ...part, text: String(stripped) });
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

function isArtifactOnlyAssistantMessage(message) {
  if (!message || message.role !== "assistant") return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  return !anthropicContentHasValue(sanitizeAnthropicContent(convertOpenAIMessage(message).content));
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
      .flatMap((part) => {
        if (part && typeof part === "object" && part.type === "text") {
          if (!hasNonWhitespaceText(part.text)) return null;
          if (isClaudeCodeBillingHeaderText(part.text)) {
            const { cache_control: _cacheControl, ...rest } = part;
            const [firstLine, ...remainingLines] = String(part.text || "").split(/\r?\n/);
            const out = [{ ...rest, text: firstLine.trim() }];
            const remaining = remainingLines.join("\n").trim();
            if (remaining) out.push(textBlockWithCache(remaining, budget));
            return out;
          }
          return addEphemeralCacheControl(part, budget);
        }
        const text = contentToText(part);
        if (isClaudeCodeBillingHeaderText(text)) {
          const [firstLine, ...remainingLines] = String(text || "").split(/\r?\n/);
          const out = [{ type: "text", text: firstLine.trim() }];
          const remaining = remainingLines.join("\n").trim();
          if (remaining) out.push(textBlockWithCache(remaining, budget));
          return out;
        }
        return textBlockWithCache(text, budget);
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

function isClaudeCodeBillingHeaderText(text = "") {
  return /^x-anthropic-billing-header:[ \t]*cc_version=/i.test(String(text || "").trim());
}

function cleanClaudeCodeBillingHeader(value = "") {
  const stripped = String(value || "")
    .replace(/^x-anthropic-billing-header:[ \t]*/i, "")
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .trim();
  const match = stripped.match(/^(cc_version=[^;\s]+;\s*cc_entrypoint=[^;\s]+;\s*cch=[a-f0-9]{5};?)/i);
  return match ? match[1] : "";
}

function hasClaudeCodeSdkSystem(system) {
  const parts = Array.isArray(system) ? system : (system ? [system] : []);
  return parts.some((part) => /Claude Agent SDK/.test(systemPartText(part)));
}

function billingHeaderFromSystem(system) {
  const parts = Array.isArray(system) ? system : (system ? [system] : []);
  for (const part of parts) {
    const text = systemPartText(part).trim();
    if (isClaudeCodeBillingHeaderText(text)) return cleanClaudeCodeBillingHeader(text);
  }
  return "";
}

function hasClaudeCodeBillingSystem(system) {
  return Boolean(billingHeaderFromSystem(system));
}

function withClaudeCodeSdkSystem(system) {
  if (hasClaudeCodeSdkSystem(system)) return system;
  const sdkBlock = { type: "text", text: CLAUDE_CODE_SDK_SYSTEM_TEXT };
  if (!system) return [sdkBlock];
  if (Array.isArray(system)) return [sdkBlock, ...system];
  return [sdkBlock, { type: "text", text: String(system || "") }];
}

function withClaudeCodeBillingSystem(system, billingHeader = "") {
  if (!billingHeader || hasClaudeCodeBillingSystem(system)) return system;
  const billingBlock = { type: "text", text: `x-anthropic-billing-header: ${billingHeader}` };
  if (!system) return [billingBlock];
  if (Array.isArray(system)) return [billingBlock, ...system];
  return [billingBlock, { type: "text", text: String(system || "") }];
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

function claudeCodeRequestShape(input = {}, options = {}) {
  const env = options.env || process.env;
  const shape = input._claudeCodeRequestShape || {};
  const maxTokens = parsePositiveInt(env.CLAUDE_CODE_MAX_TOKENS || env.LLM_PROXY_CLAUDE_CODE_MAX_TOKENS);
  const outputEffort = shape.output_config?.effort || env.CLAUDE_CODE_OUTPUT_EFFORT || env.LLM_PROXY_CLAUDE_CODE_OUTPUT_EFFORT || "";
  const profile = input._claudeCodeProfile || options.profile || {};
  return {
    maxTokens,
    thinking: shape.thinking || input.thinking || { type: "adaptive" },
    contextManagement: shape.context_management || input.context_management || { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    outputConfig: shape.output_config || input.output_config || (outputEffort ? { effort: outputEffort } : undefined),
    profile,
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

function firstUserMessageTextFromAnthropicRequest(request = {}) {
  for (const message of request.messages || []) {
    if (message?.role === "user") return contentToText(message.content);
  }
  return "";
}

function applyClaudeCodeRequestShape(provider, input, output, options = {}) {
  if (!shouldUseClaudeCodeRequestShape(provider, options)) return output;
  const shape = claudeCodeRequestShape(input, options);
  if (shape.maxTokens) output.max_tokens = shape.maxTokens;
  const cacheBudget = { remaining: CLAUDE_CODE_CACHE_CONTROL_LIMIT };
  const billingHeader = billingHeaderFromSystem(output.system) || computeClaudeCodeBillingHeader({
    ...options,
    billingMessageText: options.billingMessageText || firstUserMessageTextFromAnthropicRequest(output),
  });
  const explicitProfile = input._claudeCodeProfile || options.profile || {};
  const claudeMetadata = {
    ...(input.metadata || {}),
    ...(input._claudeCodeMetadata || {}),
  };
  if (!claudeMetadata.user_id && Object.keys(explicitProfile).length > 0) {
    claudeMetadata.user_id = JSON.stringify({
      ...(explicitProfile.deviceId ? { device_id: explicitProfile.deviceId } : {}),
      ...(explicitProfile.accountUuid ? { account_uuid: explicitProfile.accountUuid } : {}),
      ...((input._claudeCodeSessionId || explicitProfile.sessionId)
        ? { session_id: input._claudeCodeSessionId || explicitProfile.sessionId }
        : {}),
    });
  }
  output.metadata = claudeMetadata;
  output.system = normalizeSystemForClaudeCode(
    withClaudeCodeBillingSystem(withClaudeCodeSdkSystem(output.system), billingHeader),
    cacheBudget,
  );
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
  if (hasClaudeCodeSdkSystem(request.system) && hasClaudeCodeBillingSystem(request.system)) return request;
  const cacheBudget = { remaining: CLAUDE_CODE_CACHE_CONTROL_LIMIT };
  const billingHeader = billingHeaderFromSystem(request.system) || computeClaudeCodeBillingHeader({
    ...options,
    billingMessageText: options.billingMessageText || firstUserMessageTextFromAnthropicRequest(request),
  });
  return {
    ...request,
    system: normalizeSystemForClaudeCode(
      withClaudeCodeSdkSystem(withClaudeCodeBillingSystem(request.system, billingHeader)),
      cacheBudget,
    ),
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
  const seenToolUseIds = new Set();
  const pendingToolResultIdsByOriginal = new Map();

  function rememberToolUseId(originalId, remappedId) {
    if (!originalId || !remappedId) return;
    const queue = pendingToolResultIdsByOriginal.get(originalId) || [];
    queue.push(remappedId);
    pendingToolResultIdsByOriginal.set(originalId, queue);
  }

  function takeToolResultId(originalId) {
    const queue = pendingToolResultIdsByOriginal.get(originalId);
    if (!queue || queue.length === 0) return originalId;
    const remappedId = queue.shift();
    if (queue.length === 0) pendingToolResultIdsByOriginal.delete(originalId);
    return remappedId;
  }

  function flushToolResults() {
    if (pendingToolResults.length === 0) return;
    output.messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  }

  const inputMessages = Array.isArray(input.messages) ? [...input.messages] : [];
  while (inputMessages.length > 0 && isArtifactOnlyAssistantMessage(inputMessages[inputMessages.length - 1])) {
    inputMessages.pop();
  }

  for (const message of inputMessages) {
    if (message.role === "system") {
      system.push(contentToText(message.content));
      continue;
    }
    if (message.role === "tool") {
      pendingToolResults.push(toolResultBlock({
        ...message,
        tool_call_id: takeToolResultId(message.tool_call_id),
      }));
      continue;
    }
    const converted = convertOpenAIMessage(message);
    if (!anthropicContentHasValue(sanitizeAnthropicContent(converted.content))) continue;
    if (Array.isArray(converted.content)) {
      const originalToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      let toolUseIndex = 0;
      for (const part of converted.content) {
        if (part?.type !== "tool_use" || !part.id) continue;
        const originalId = originalToolCalls[toolUseIndex]?.id || part.id;
        toolUseIndex += 1;
        if (!seenToolUseIds.has(part.id)) {
          seenToolUseIds.add(part.id);
          rememberToolUseId(originalId, part.id);
          continue;
        }
        let suffix = 0;
        let candidate = part.id;
        do {
          const tail = suffix.toString(36).slice(-2).padStart(2, "0");
          candidate = `${part.id.slice(0, 7)}${tail}`;
          suffix += 1;
        } while (seenToolUseIds.has(candidate));
        part.id = candidate;
        seenToolUseIds.add(part.id);
        rememberToolUseId(originalId, part.id);
      }
    }
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

function claudeCodeBillingSalt(env = process.env) {
  return String(env.CLAUDE_CODE_BILLING_SALT || env.LLM_PROXY_CLAUDE_CODE_BILLING_SALT || "59cf53e54c78").trim();
}

function claudeCodeEntrypoint(env = process.env, options = {}) {
  // Genuine interactive Claude Code CLI sends "(external, cli)"; the "sdk-cli"
  // suffix only appears in headless SDK mode (CLAUDE_CODE_ENTRYPOINT=sdk-cli).
  return String(options.billingEntrypoint || env.CLAUDE_CODE_ENTRYPOINT || env.LLM_PROXY_CLAUDE_CODE_ENTRYPOINT || "cli").trim();
}

function claudeCodeBillingEntrypoint(env = process.env, options = {}) {
  return claudeCodeEntrypoint(env, options);
}

// @anthropic-ai/sdk x-stainless-* fingerprint headers. The genuine Claude Code
// CLI (which bundles the SDK) always emits these; omitting them is a strong
// non-genuine signal. Values are deterministic from the runtime, with env
// overrides so a Linux container can impersonate the captured macOS client.
function claudeCodeStainlessPackageVersion(env = process.env) {
  return String(
    env.CLAUDE_CODE_STAINLESS_PACKAGE_VERSION ||
    env.LLM_PROXY_CLAUDE_CODE_STAINLESS_PACKAGE_VERSION ||
    "0.94.0",
  ).trim();
}

function stainlessOs(env = process.env) {
  const override = String(env.LLM_PROXY_CLAUDE_CODE_OS || "").trim();
  if (override) return override;
  const map = { darwin: "MacOS", win32: "Windows", linux: "Linux" };
  return map[process.platform] || "Unknown";
}

function stainlessArch(env = process.env) {
  const override = String(env.LLM_PROXY_CLAUDE_CODE_ARCH || "").trim();
  if (override) return override;
  const map = { x64: "x64", arm64: "arm64", arm: "arm", ia32: "x32" };
  return map[process.arch] || `other:${process.arch}`;
}

function claudeCodeStainlessHeaders(env = process.env) {
  return {
    "x-stainless-lang": "js",
    "x-stainless-package-version": claudeCodeStainlessPackageVersion(env),
    "x-stainless-os": stainlessOs(env),
    "x-stainless-arch": stainlessArch(env),
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": String(process.version || "").replace(/^v/, ""),
    "x-stainless-retry-count": "0",
  };
}

function sha256Hex(text = "") {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function sampledBillingChars(text = "") {
  const value = String(text || "");
  return [4, 7, 20].map((index) => (index < value.length ? value[index] : "0")).join("");
}

function computeClaudeCodeBillingHeader(options = {}) {
  const env = options.env || process.env;
  const version = claudeCodeVersion(env);
  if (!version) return "";
  if (options.billingHeader) return cleanClaudeCodeBillingHeader(options.billingHeader);
  const messageText = String(options.billingMessageText || "");
  const entrypoint = claudeCodeBillingEntrypoint(env, options);
  const compute = String(env.LLM_PROXY_CLAUDE_CODE_COMPUTE_BILLING_HEADER || "true").toLowerCase() !== "false";
  const suffix = compute
    ? sha256Hex(`${claudeCodeBillingSalt(env)}${sampledBillingChars(messageText)}${version}`).slice(0, 3)
    : (claudeCodeBuild(env) || "000");
  const contentHash = compute ? sha256Hex(messageText).slice(0, 5) : (options.billingContentHash || "00000");
  return `cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${contentHash};`;
}

function claudeCodeBetas(env = process.env) {
  return String(env.CLAUDE_CODE_BETAS || env.LLM_PROXY_CLAUDE_CODE_BETAS || "").trim();
}

function claudeCodeFingerprintHeaders(options = {}) {
  const env = options.env || process.env;
  const version = claudeCodeVersion(env);
  if (!version) return {};
  const headers = {
    accept: "application/json",
    "user-agent": `claude-cli/${version} (external, ${claudeCodeEntrypoint(env, options)})`,
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    ...claudeCodeStainlessHeaders(env),
  };
  const billingHeader = computeClaudeCodeBillingHeader(options);
  if (billingHeader) headers["x-anthropic-billing-header"] = billingHeader;
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
  const headerOptions = {
    ...options,
    billingHeader: billingHeaderFromSystem(request.system) || options.billingHeader,
    billingMessageText: options.billingMessageText || firstUserMessageTextFromAnthropicRequest(request),
  };
  return postJson(url, buildHeaders(provider, headerOptions), sanitizeAnthropicRequestForProvider(provider, request));
}

module.exports = {
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  computeClaudeCodeBillingHeader,
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
