"use strict";

const crypto = require("crypto");
const compaction = require("./compaction");
const state = require("./state");
const routingPolicy = require("./routing-policy");
const hiddenMemoryMarkers = require("./memory/hidden-markers");

let _handleChatCompletion;

function init({ handleChatCompletion }) {
  _handleChatCompletion = handleChatCompletion;
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .filter((part) => part && (part.type === "text" || part.type === "input_text"))
    .map((part) => part.text || "")
    .join("\n");
}

function stripPrivateMarkersFromText(text = "") {
  const withoutAssessment = routingPolicy.stripDifficultyMarkerFromText(String(text || "")).content;
  return hiddenMemoryMarkers.stripHiddenMemoryMarkers(withoutAssessment).content;
}

function mapModel(model) {
  if (!model) return "auto-coding";
  if (model in state.GROUPS) return model;
  if (state.PROVIDERS.some((p) => p.model === model || p.name === model)) return model;
  const claudeModel = `claude/${model}`;
  if (state.PROVIDERS.some((p) => p.model === claudeModel || p.upstream_model === model)) return claudeModel;
  return "auto-coding";
}

function toOpenAITool(tool) {
  if (!tool?.name) return null;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object" },
    },
  };
}

function addUserContent(messages, text) {
  if (!text) return;
  const last = messages[messages.length - 1];
  if (last?.role === "user" && typeof last.content === "string") {
    last.content = last.content ? `${last.content}\n${text}` : text;
  } else {
    messages.push({ role: "user", content: text });
  }
}

function translateMessage(message, messages) {
  const content = message.content;
  if (message.role === "assistant") {
    const textParts = [];
    const toolCalls = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text") textParts.push(part.text || "");
        if (part?.type === "tool_use") {
          toolCalls.push({
            id: part.id || genId("toolu"),
            type: "function",
            function: {
              name: part.name || "unknown_tool",
              arguments: JSON.stringify(part.input || {}),
            },
          });
        }
      }
    } else {
      textParts.push(contentToText(content));
    }
    const text = textParts.filter(Boolean).join("\n");
    messages.push({
      role: "assistant",
      content: toolCalls.length > 0 && !text ? null : text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
    return;
  }

  if (Array.isArray(content)) {
    const textParts = [];
    for (const part of content) {
      if (part?.type === "text") textParts.push(part.text || "");
      if (part?.type === "tool_result") {
        if (textParts.length > 0) {
          addUserContent(messages, textParts.join("\n"));
          textParts.length = 0;
        }
        messages.push({
          role: "tool",
          tool_call_id: part.tool_use_id,
          content: contentToText(part.content),
        });
      }
    }
    if (textParts.length > 0) addUserContent(messages, textParts.join("\n"));
    return;
  }

  addUserContent(messages, contentToText(content));
}

function translateRequest(request = {}) {
  const messages = [];
  const system = contentToText(request.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of request.messages || []) {
    translateMessage(message, messages);
  }

  const tools = (request.tools || []).map(toOpenAITool).filter(Boolean);
  return {
    model: mapModel(request.model),
    messages,
    tools: tools.length > 0 ? tools : undefined,
    max_tokens: request.max_tokens || 4096,
    temperature: request.temperature,
    stream: request.stream === true,
  };
}

function stopReason(finishReason) {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

function toolSchemaMapFromAnthropicTools(tools = []) {
  const schemas = new Map();
  for (const tool of tools || []) {
    if (!tool?.name) continue;
    schemas.set(tool.name, tool.input_schema || {});
  }
  return schemas;
}

function parseToolArguments(value) {
  const raw = value == null || value === "" ? "{}" : String(value);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON arguments" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "non-object arguments" };
  }
  return { ok: true, input, raw };
}

function validateToolInput(name, input, schema) {
  if (!schema) return null;
  for (const field of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] == null || input[field] === "") {
      return `missing required field "${field}"`;
    }
  }
  return null;
}

function decodeToolCall(toolCall, schemas) {
  const name = toolCall.function?.name || "unknown_tool";
  const schema = schemas.get(name);
  const parsed = parseToolArguments(toolCall.function?.arguments);
  if (!parsed.ok) return { ok: false, name, reason: parsed.reason, schema };
  const invalid = validateToolInput(name, parsed.input, schema);
  if (invalid) return { ok: false, name, reason: invalid, schema };
  return {
    ok: true,
    id: toolCall.id || genId("toolu"),
    name,
    input: parsed.input,
    raw: parsed.raw,
  };
}

function toolSchemaHint(schema = {}) {
  const required = Array.isArray(schema.required) ? schema.required.filter(Boolean) : [];
  if (required.length === 0) return "Check the tool schema and retry with valid JSON arguments.";
  return `Required fields: ${required.join(", ")}.`;
}

function invalidToolHelp(name, reason, schema = {}) {
  return [
    `Tool call error: The model attempted to call "${name}", but its arguments were invalid: ${reason}.`,
    `${toolSchemaHint(schema)} Retry the tool call with valid JSON matching the schema.`,
  ].join(" ");
}

function contentFromOpenAIMessage(message = {}, requestTools = []) {
  const content = [];
  const schemas = toolSchemaMapFromAnthropicTools(requestTools);
  const invalidMessages = [];
  const text = stripPrivateMarkersFromText(contentToText(message.content)).trimEnd();
  if (text) content.push({ type: "text", text });
  for (const toolCall of message.tool_calls || []) {
    const decoded = decodeToolCall(toolCall, schemas);
    if (!decoded.ok) {
      state.log(`TOOL-INVALID-GATEWAY: ${decoded.name} ${decoded.reason}`);
      invalidMessages.push(invalidToolHelp(decoded.name, decoded.reason, decoded.schema));
      continue;
    }
    content.push({ type: "tool_use", id: decoded.id, name: decoded.name, input: decoded.input });
  }
  if (invalidMessages.length > 0) {
    content.push({ type: "text", text: invalidMessages.join("\n") });
  }
  return content.length > 0 ? content : [{ type: "text", text: "" }];
}

function toAnthropicResponse(openai, requestModel, requestTools = []) {
  const choice = openai.choices?.[0] || {};
  const usage = openai.usage || {};
  const content = contentFromOpenAIMessage(choice.message || {}, requestTools);
  let reason = stopReason(choice.finish_reason);
  if (reason === "tool_use" && !content.some((part) => part.type === "tool_use")) reason = "end_turn";
  return {
    id: genId("msg"),
    type: "message",
    role: "assistant",
    model: requestModel || openai.model || "auto-coding",
    content,
    stop_reason: reason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

class AnthropicStreamResponse {
  constructor(clientRes, requestModel, requestTools = []) {
    this.clientRes = clientRes;
    this.requestModel = requestModel || "auto-coding";
    this.statusCode = 200;
    this.headersSent = false;
    this.buffer = "";
    this.messageId = genId("msg");
    this.started = false;
    this.nextIndex = 0;
    this.textIndex = null;
    this.toolIndexes = new Map();
    this.openBlocks = new Set();
    this.toolSchemas = toolSchemaMapFromAnthropicTools(requestTools);
    this.pendingTools = new Map();
    this.emittedToolCount = 0;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.pendingStopReason = null;
    this.finished = false;
  }

  setHeader() {}

  writeHead(status) {
    if (this.headersSent || this.clientRes.headersSent) {
      this.headersSent = true;
      if (status < 400) this._startMessage();
      return;
    }
    this.statusCode = status;
    this.headersSent = true;
    if (status >= 400) {
      this.clientRes.writeHead(status, { "Content-Type": "application/json" });
      return;
    }
    this.clientRes.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    this._startMessage();
  }

  write(chunk) {
    if (this.clientRes.writableEnded || this.clientRes.finished) return;
    if (!this.headersSent) this.writeHead(this.statusCode || 200);
    if (this.statusCode >= 400) {
      this.clientRes.write(chunk);
      return;
    }
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") {
        this._finish(this.pendingStopReason || "end_turn");
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      this._rememberUsage(parsed.usage);
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      this._handleDelta(choice.delta || {});
      if (choice.finish_reason) this.pendingStopReason = stopReason(choice.finish_reason);
    }
  }

  end(chunk) {
    if (this.clientRes.writableEnded || this.clientRes.finished) return;
    if (chunk) this.write(chunk);
    if (this.statusCode < 400) this._finish(this.pendingStopReason || "end_turn");
    this.clientRes.end();
  }

  _startMessage() {
    if (this.started) return;
    this.started = true;
    sse(this.clientRes, "message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.requestModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  _startTextBlock() {
    if (this.textIndex !== null) return this.textIndex;
    const index = this.nextIndex++;
    this.textIndex = index;
    this.openBlocks.add(index);
    sse(this.clientRes, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    return index;
  }

  _emitText(text) {
    if (!text) return;
    const index = this._startTextBlock();
    sse(this.clientRes, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });
  }

  _startToolBlock(toolCall, rawArguments) {
    const key = toolCall.index ?? 0;
    if (this.toolIndexes.has(key)) return this.toolIndexes.get(key);
    const index = this.nextIndex++;
    this.toolIndexes.set(key, index);
    this.openBlocks.add(index);
    sse(this.clientRes, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: toolCall.id || genId("toolu"),
        name: toolCall.function?.name || "unknown_tool",
        input: {},
      },
    });
    if (rawArguments && rawArguments !== "{}") {
      sse(this.clientRes, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: rawArguments },
      });
    }
    this.emittedToolCount++;
    return index;
  }

  _rememberToolDelta(toolCall, fallbackIndex = 0) {
    const key = toolCall.index ?? fallbackIndex;
    const current = this.pendingTools.get(key) || {
      index: key,
      id: toolCall.id,
      type: toolCall.type,
      function: { name: toolCall.function?.name, arguments: "" },
    };
    if (toolCall.id) current.id = toolCall.id;
    if (toolCall.type) current.type = toolCall.type;
    if (toolCall.function?.name) current.function.name = toolCall.function.name;
    if (toolCall.function?.arguments) current.function.arguments += toolCall.function.arguments;
    this.pendingTools.set(key, current);
  }

  _flushPendingTools() {
    for (const pending of [...this.pendingTools.values()].sort((a, b) => a.index - b.index)) {
      if (this.toolIndexes.has(pending.index)) continue;
      const decoded = decodeToolCall(pending, this.toolSchemas);
      if (!decoded.ok) {
        state.log(`TOOL-INVALID-STREAM-GATEWAY: ${decoded.name} ${decoded.reason} — emitted retry help`);
        this._emitText(invalidToolHelp(decoded.name, decoded.reason, decoded.schema));
        continue;
      }
      this._startToolBlock({
        index: pending.index,
        id: decoded.id,
        function: { name: decoded.name },
      }, decoded.raw);
    }
    this.pendingTools.clear();
  }

  _handleDelta(delta) {
    if (delta.content) {
      this._emitText(stripPrivateMarkersFromText(delta.content));
    }
    for (const [fallbackIndex, toolCall] of (delta.tool_calls || []).entries()) {
      this._rememberToolDelta(toolCall, fallbackIndex);
    }
  }

  _rememberUsage(usage = {}) {
    if (usage.prompt_tokens != null) this.usage.input_tokens = usage.prompt_tokens;
    if (usage.input_tokens != null) this.usage.input_tokens = usage.input_tokens;
    if (usage.completion_tokens != null) this.usage.output_tokens = usage.completion_tokens;
    if (usage.output_tokens != null) this.usage.output_tokens = usage.output_tokens;
  }

  _finish(reason) {
    if (!this.started || this.finished) return;
    this._flushPendingTools();
    if (reason === "tool_use" && this.emittedToolCount === 0) reason = "end_turn";
    for (const index of [...this.openBlocks].sort((a, b) => a - b)) {
      sse(this.clientRes, "content_block_stop", { type: "content_block_stop", index });
    }
    this.openBlocks.clear();
    sse(this.clientRes, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens || 0 },
    });
    sse(this.clientRes, "message_stop", { type: "message_stop" });
    this.finished = true;
  }
}

class CaptureResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = "";
    this.headersSent = false;
  }

  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
  }
  write(chunk) { this.body += chunk.toString(); }
  end(chunk) { if (chunk) this.write(chunk); }
}

async function handleMessagesHTTP(_req, res, body) {
  if (!_handleChatCompletion) throw new Error("anthropic-gateway.init() was not called");
  let request;
  try { request = JSON.parse(body); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }));
    return;
  }

  const chatReq = translateRequest(request);
  if (request.stream === true) {
    const streamRes = new AnthropicStreamResponse(res, request.model || chatReq.model, request.tools || []);
    return _handleChatCompletion(chatReq, streamRes, { headers: _req.headers });
  }

  const capture = new CaptureResponse();
  await _handleChatCompletion(chatReq, capture, { headers: _req.headers });
  if (capture.statusCode >= 400) {
    res.writeHead(capture.statusCode, { "Content-Type": "application/json" });
    res.end(capture.body);
    return;
  }
  let openai;
  try { openai = JSON.parse(capture.body); } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Invalid upstream response" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(toAnthropicResponse(openai, request.model || chatReq.model, request.tools || [])));
}

function handleCountTokens(_req, res, body) {
  let request;
  try { request = JSON.parse(body); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }));
    return;
  }
  const chatReq = translateRequest(request);
  const inputTokens = compaction.estimateTokens(chatReq.messages) + compaction.estimateRequestSchemaTokens(chatReq);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ input_tokens: inputTokens }));
}

module.exports = {
  init,
  translateRequest,
  toAnthropicResponse,
  handleMessagesHTTP,
  handleCountTokens,
};
