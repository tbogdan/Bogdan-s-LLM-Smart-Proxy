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

function prepareOpenAICompatibleRequest(provider = {}, reqBody = {}, stream) {
  const body = { ...reqBody, model: provider.upstream_model || provider.model };
  body.stream = stream === true;
  if (!body.stream) delete body.stream_options;
  return body;
}

async function routeAnthropic(provider, reqBody) {
  const converted = anthropic.toAnthropicRequest(provider, reqBody);
  const resp = await anthropic.postAnthropic(provider, converted);
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
  prepareOpenAICompatibleRequest,
  routeNonStreaming,
  windsurfErrorToResponse,
};
