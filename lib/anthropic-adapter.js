"use strict";

const http = require("node:http");
const https = require("node:https");

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function contentToText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function textContentBlock(content) {
  const text = contentToText(content);
  return text ? { type: "text", text } : null;
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

function toAnthropicRequest(provider, input) {
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
    flushToolResults();
    output.messages.push(convertOpenAIMessage(message));
  }
  flushToolResults();

  if (system.length > 0) output.system = system.join("\n");
  output.max_tokens = input.max_tokens != null ? input.max_tokens : DEFAULT_MAX_TOKENS;
  if (input.temperature != null) output.temperature = input.temperature;
  if (input.stream != null) output.stream = input.stream;
  if (Array.isArray(input.tools)) {
    output.tools = input.tools.map(toAnthropicTool).filter(Boolean);
  }

  return output;
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

function buildHeaders(provider) {
  const headers = {
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };

  if (usesPlatformApiKey(provider)) {
    headers["x-api-key"] = provider.key;
  } else {
    headers.Authorization = `Bearer ${provider.key}`;
  }

  return headers;
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

function postAnthropic(provider, request) {
  const url = /^https?:\/\//.test(provider.url || "") ? provider.url : DEFAULT_MESSAGES_URL;
  return postJson(url, buildHeaders(provider), request);
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
};
