"use strict";

const anthropic = require("./anthropic-adapter");
const windsurf = require("./windsurf-cloud");

function protocolOf(provider = {}) {
  return String(provider.protocol || "").trim().toLowerCase();
}

function isOpenAIProtocol(provider = {}) {
  const protocol = protocolOf(provider);
  return protocol === "" || protocol === "openai";
}

function requiresMaxCompletionTokens(provider = {}) {
  const model = String(provider.upstream_model || provider.model || "").toLowerCase();
  const family = String(provider.family || "").toLowerCase();
  return family === "copilot" && /^gpt-5\.([4-9]|\d{2,})(?:$|[-.])/.test(model);
}

function isCodexProvider(provider = {}) {
  const model = String(provider.upstream_model || provider.model || "").toLowerCase();
  const family = String(provider.family || "").toLowerCase();
  const protocol = protocolOf(provider);
  return family === "codex" || protocol === "codex" || model.startsWith("codex/");
}

function normalizeOpenAIChatTokenLimit(provider = {}, body = {}) {
  if (!requiresMaxCompletionTokens(provider)) return body;
  if (body.max_tokens != null && body.max_completion_tokens == null) {
    body.max_completion_tokens = body.max_tokens;
  }
  delete body.max_tokens;
  return body;
}

function normalizeOpenAIUnsupportedParams(provider = {}, body = {}) {
  if (isCodexProvider(provider)) {
    delete body.temperature;
  }
  return body;
}

function hasToolDefinitions(body = {}) {
  return (body.tools?.length || 0) > 0 || (body.functions?.length || 0) > 0;
}

function stripToolControlsWithoutDefinitions(body = {}) {
  if (Array.isArray(body.tools) && body.tools.length === 0) delete body.tools;
  if (Array.isArray(body.functions) && body.functions.length === 0) delete body.functions;
  if (hasToolDefinitions(body)) return body;
  delete body.tool_choice;
  delete body.function_call;
  delete body.parallel_tool_calls;
  return body;
}

function prepareOpenAICompatibleRequest(provider = {}, reqBody = {}, stream) {
  const body = { ...reqBody, model: provider.upstream_model || provider.model };
  body.stream = stream === true;
  if (!body.stream) delete body.stream_options;
  return stripToolControlsWithoutDefinitions(
    normalizeOpenAIUnsupportedParams(provider, normalizeOpenAIChatTokenLimit(provider, body)),
  );
}

async function routeAnthropic(provider, reqBody) {
  const options = { sessionId: reqBody._claudeCodeSessionId };
  const converted = anthropic.toAnthropicRequest(provider, reqBody, options);
  const resp = await anthropic.postAnthropic(provider, converted, options);
  if (resp.status < 200 || resp.status >= 300) return resp;

  if (reqBody.stream === true && /^text\/event-stream/i.test(String(resp.headers?.["content-type"] || ""))) {
    return {
      status: resp.status,
      headers: { ...resp.headers, "content-type": "text/event-stream" },
      body: anthropic.toOpenAIStream(provider.model, resp.body),
    };
  }

  const data = JSON.parse(resp.body);
  return {
    status: resp.status,
    headers: resp.headers || {},
    body: JSON.stringify(anthropic.toOpenAIResponse(provider.model, data)),
  };
}

async function routeAnthropicStream(provider, reqBody, handlers) {
  const options = { sessionId: reqBody._claudeCodeSessionId };
  const converted = anthropic.toAnthropicRequest(provider, { ...reqBody, stream: true }, options);
  const resp = await anthropic.postAnthropic(provider, converted, options);
  if (resp.status < 200 || resp.status >= 300) {
    const error = new Error(`HTTP ${resp.status}: ${resp.body || "Anthropic stream error"}`);
    error.status = resp.status;
    error.headers = resp.headers || {};
    error.body = resp.body || "";
    throw error;
  }
  handlers.onChunk(anthropic.toOpenAIStream(provider.model, resp.body));
}

function windsurfErrorToResponse(error) {
  if (!error || !error.status) return null;
  const body = Buffer.isBuffer(error.body)
    ? error.body.toString("utf8")
    : error.body != null ? String(error.body) : error.message || "";
  return {
    status: error.status,
    headers: error.headers || {},
    body,
  };
}

async function routeWindsurf(provider, reqBody) {
  try {
    const output = await windsurf.callWindsurfCloud(provider, reqBody);
    return { status: 200, headers: {}, body: JSON.stringify(output) };
  } catch (error) {
    const response = windsurfErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}

function isNativeStreamingProtocol(provider = {}) {
  return ["anthropic", "windsurf"].includes(protocolOf(provider));
}

async function routeNativeStream(provider, reqBody, handlers) {
  const protocol = protocolOf(provider);
  if (protocol === "anthropic") return routeAnthropicStream(provider, reqBody, handlers);
  if (protocol === "windsurf") return windsurf.streamWindsurfCloud(provider, reqBody, handlers);
  throw new Error(`Unsupported native streaming protocol: ${provider.protocol}`);
}

async function routeNonStreaming(provider, reqBody, openAIRoute) {
  const protocol = protocolOf(provider);
  if (isOpenAIProtocol(provider) || protocol === "codex") {
    return openAIRoute(provider, reqBody);
  }
  if (protocol === "anthropic") return routeAnthropic(provider, reqBody);
  if (protocol === "windsurf") return routeWindsurf(provider, reqBody);
  throw new Error(`Unsupported provider protocol: ${provider.protocol}`);
}

module.exports = {
  isOpenAIProtocol,
  isNativeStreamingProtocol,
  normalizeOpenAIChatTokenLimit,
  prepareOpenAICompatibleRequest,
  routeNativeStream,
  routeNonStreaming,
  windsurfErrorToResponse,
};
