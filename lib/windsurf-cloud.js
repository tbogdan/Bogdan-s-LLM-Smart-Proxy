"use strict";

const http = require("node:http");
const https = require("node:https");

const { readHostToken } = require("./windsurf-auth");

const WINDSURF_DEFAULT_URL = "https://api.windsurf.com/v1/chat/completions";

function buildHeaders({ key } = {}) {
  const token = key || readHostToken();
  return {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function toWindsurfRequest(provider = {}, input = {}) {
  const output = {
    model: provider.upstream_model || provider.model || input.model,
    messages: input.messages || [],
  };

  if (Array.isArray(input.tools)) output.tools = input.tools;
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

function textFromResponse(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (response.message && response.message.content != null) return response.message.content;
  if (response.content != null) return response.content;
  if (response.output != null) return response.output;
  return "";
}

function toOpenAIResponse(model, response) {
  const normalized = response && typeof response === "object" ? response : { output: response };
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
  const message = {
    role: sourceMessage.role || normalized.role || "assistant",
    content: textFromResponse(normalized),
  };

  return {
    id: normalizeId(normalized.id),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: normalized.finish_reason || normalized.stop_reason || "stop",
      },
    ],
    usage,
  };
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
      },
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function postWindsurf(provider = {}, request) {
  const url = /^https?:\/\//.test(provider.url || "") ? provider.url : WINDSURF_DEFAULT_URL;
  return postJson(url, buildHeaders(provider), request);
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

  try {
    return toOpenAIResponse(input.model, JSON.parse(response.body));
  } catch {
    return toOpenAIResponse(input.model, { output: response.body });
  }
}

module.exports = {
  WINDSURF_DEFAULT_URL,
  buildHeaders,
  toWindsurfRequest,
  toOpenAIResponse,
  postWindsurf,
  callWindsurfCloud,
};
