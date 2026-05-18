"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");

const { readHostToken } = require("./windsurf-auth");

const CODEIUM_API_ORIGIN = "https://server.codeium.com";
const GET_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const WINDSURF_DEFAULT_URL = `${CODEIUM_API_ORIGIN}${GET_CHAT_MESSAGE_PATH}`;
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 64000;
const DEFAULT_VERSION = "1.99.0";

const FALLBACK_MODELS = [
  { id: "swe-1.6-fast", name: "SWE 1.6 Fast", modelUid: "swe-1-6-fast", tier: "fast", reasoning: true },
  { id: "swe-1.6", name: "SWE 1.6", modelUid: "swe-1-6", tier: "max", reasoning: true },
  { id: "swe-1.5-fast", name: "SWE 1.5 Fast", modelUid: "swe-1-5", tier: "fast", reasoning: true },
  { id: "adaptive", name: "Adaptive", modelUid: "adaptive", tier: "auto", reasoning: true },
].map((model) => ({
  ...model,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
}));

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

function canonicalModelId(modelId) {
  const raw = String(modelId || "").trim();
  const normalized = raw.replace(/^windsurf\//i, "").replace(/_/g, "-").toLowerCase();
  return MODEL_ALIASES[raw] || MODEL_ALIASES[normalized] || normalized;
}

function resolveModel(modelId) {
  const resolved = canonicalModelId(modelId);
  return (
    FALLBACK_MODELS.find((model) => model.id === resolved || model.modelUid === resolved) ||
    FALLBACK_MODELS.find((model) => model.id === MODEL_ALIASES[resolved]) ||
    FALLBACK_MODELS[0]
  );
}

function buildWindsurfProviders(models = FALLBACK_MODELS) {
  return models.map((model) => ({
    family: "windsurf",
    protocol: "windsurf",
    model: `windsurf/${model.id}`,
    upstream_model: model.id,
    windsurf_model_uid: model.modelUid,
    key_env: "WINDSURF_API_KEY",
    context: model.contextWindow || DEFAULT_CONTEXT_WINDOW,
    tier: model.tier || "auto",
    caps: ["text", "coding", "tools", "thinking"],
    tc: true,
    headers: {},
    seed: true,
  }));
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

function buildHeaders() {
  return {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    accept: "application/connect+proto",
  };
}

function textContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((part) => part && part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

function sourceForRole(role) {
  if (role === "system") return 5;
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

function buildChatPrompt(message) {
  let prompt = textContent(message.content).trim();
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    prompt = `${prompt}\nASSISTANT TOOL_CALLS: ${JSON.stringify(message.tool_calls)}`.trim();
  } else if (message.role === "tool") {
    prompt = `TOOL RESULT${message.tool_call_id ? ` ${message.tool_call_id}` : ""}: ${prompt}`;
  }
  return Buffer.concat([encodeString(1, crypto.randomUUID()), encodeVarintField(2, sourceForRole(message.role)), encodeString(3, prompt)]);
}

function buildGetChatMessageRequest(request, apiKey, version = DEFAULT_VERSION, requestId) {
  const model = request.windsurf_model_uid
    ? { modelUid: request.windsurf_model_uid }
    : resolveModel(request.model || request.upstream_model);
  const prompts = (request.messages || [])
    .map((message) => ({ message, prompt: textContent(message.content).trim() }))
    .filter(({ message, prompt }) => prompt || (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0))
    .map(({ message }) => encodeMessage(3, buildChatPrompt(message)));

  if (prompts.length === 0) throw new Error("No prompt text found in request messages");
  return Buffer.concat([
    encodeMessage(1, buildMetadata(apiKey, version, requestId)),
    ...prompts,
    encodeVarintField(7, 5),
    encodeString(21, model.modelUid),
  ]);
}

function toWindsurfRequest(provider = {}, input = {}) {
  const model = provider.upstream_model || provider.model || input.model;
  const resolved = provider.windsurf_model_uid ? { modelUid: provider.windsurf_model_uid } : resolveModel(model);
  const output = {
    model,
    windsurf_model_uid: resolved.modelUid,
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

function parseConnectText(buffer) {
  const parsed = takeConnectEnvelopes(buffer);
  const chunks = [];
  for (const envelope of parsed.envelopes) {
    if (envelope.flags === 2) {
      const trailer = envelope.body.toString("utf8");
      if (trailer.includes('"error"')) throw new Error(trailer);
      continue;
    }
    for (const field of parseFields(envelope.body)) {
      if (field.fieldNum === 3 && Buffer.isBuffer(field.value)) chunks.push(field.value.toString("utf8"));
    }
  }
  if (parsed.remaining.length > 0) {
    const error = new Error("Windsurf cloud response ended with an incomplete Connect frame");
    error.body = buffer;
    throw error;
  }
  return chunks.join("");
}

function textFromResponse(response) {
  if (response == null) return "";
  if (Buffer.isBuffer(response)) return parseConnectText(response);
  if (typeof response === "string") return response;
  if (response.message && response.message.content != null) return response.message.content;
  if (response.content != null) return response.content;
  if (response.output != null) return response.output;
  return "";
}

function toOpenAIResponse(model, response) {
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
          resolve({ status: response.statusCode, headers: response.headers, body: data });
        });
      },
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function postConnect(provider = {}, request) {
  return new Promise((resolve, reject) => {
    const origin = provider.origin || CODEIUM_API_ORIGIN;
    const path = provider.path || GET_CHAT_MESSAGE_PATH;
    const apiKey = provider.key || readHostToken();
    const version = provider.windsurf_version || provider.version || DEFAULT_VERSION;
    const payload = connectEnvelope(buildGetChatMessageRequest(request, apiKey, version));
    const client = http2.connect(origin);
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      client.close();
      if (error) reject(error);
      else resolve(value);
    }

    client.once("error", finish);
    client.once("connect", () => {
      const stream = client.request({
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

function postWindsurf(provider = {}, request) {
  if (provider.url && /^https?:\/\//.test(provider.url)) {
    return postJson(provider.url, provider.headers || {}, request);
  }
  return postConnect(provider, request);
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
  GET_CHAT_MESSAGE_PATH,
  WINDSURF_DEFAULT_URL,
  FALLBACK_MODELS,
  resolveModel,
  buildWindsurfProviders,
  buildHeaders,
  toWindsurfRequest,
  toOpenAIResponse,
  postWindsurf,
  callWindsurfCloud,
  encodeVarint,
  encodeString,
  encodeMessage,
  encodeVarintField,
  connectEnvelope,
  readVarint,
  parseFields,
  takeConnectEnvelopes,
  buildMetadata,
  buildChatPrompt,
  buildGetChatMessageRequest,
};
