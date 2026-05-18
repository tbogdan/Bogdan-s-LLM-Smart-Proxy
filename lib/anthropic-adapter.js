"use strict";

const http = require("node:http");
const https = require("node:https");

const ANTHROPIC_VERSION = "2023-06-01";
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

  for (const message of input.messages || []) {
    if (message.role === "system") {
      system.push(contentToText(message.content));
      continue;
    }
    output.messages.push({
      role: message.role,
      content: contentToText(message.content),
    });
  }

  if (system.length > 0) output.system = system.join("\n");
  if (input.max_tokens != null) output.max_tokens = input.max_tokens;
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
  const inputTokens = response.usage && response.usage.input_tokens ? response.usage.input_tokens : 0;
  const outputTokens = response.usage && response.usage.output_tokens ? response.usage.output_tokens : 0;
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
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function buildHeaders(provider) {
  return {
    Authorization: `Bearer ${provider.key}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
}

function requestJson(url, headers, body) {
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
          let parsed = {};
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              reject(error);
              return;
            }
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(`Anthropic request failed with status ${response.statusCode}`);
            error.statusCode = response.statusCode;
            error.body = parsed;
            reject(error);
            return;
          }
          resolve(parsed);
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
  return requestJson(url, buildHeaders(provider), request);
}

module.exports = {
  ANTHROPIC_VERSION,
  toAnthropicRequest,
  toOpenAIResponse,
  buildHeaders,
  postAnthropic,
};
