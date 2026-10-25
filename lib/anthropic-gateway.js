"use strict";
const upstreamTransport = require("./http-transport");

const crypto = require("crypto");
const compaction = require("./compaction");
const state = require("./state");
const routingPolicy = require("./routing-policy");
const hiddenMemoryMarkers = require("./memory/hidden-markers");
const mediaContent = require("./media-content");
const anthropicAdapter = require("./anthropic-adapter");
const scoring = require("./scoring");

let _handleChatCompletion;
let _taskRuntime;

function init({ handleChatCompletion, taskRuntime }) {
  _taskRuntime = taskRuntime;
  _handleChatCompletion = handleChatCompletion;
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return mediaContent.textFromContent(content);
}

function stripPrivateMarkersFromText(text = "") {
  const withoutAssessment = routingPolicy.stripDifficultyMarkerFromText(String(text || "")).content;
  const withoutTaskStatus = routingPolicy.stripTaskStatusMarkerFromText(withoutAssessment).content;
  const withoutMemory = hiddenMemoryMarkers.stripHiddenMemoryMarkers(withoutTaskStatus).content;
  return stripProxyArtifactLinesFromText(withoutMemory);
}

const PRIVATE_MARKER_PREFIXES = [
  "LLM_PROXY_INTERNAL_ROUTING",
  "LLM_PROXY_TASK_DIFFICULTY",
  "LLM_PROXY_TASK_STATUS",
  "LLM_PROXY_MEMORY",
  "LLM_PROXY_RECALL",
];

const PROXY_ARTIFACT_LINE_RE =
  /^\s*(?:proxy suppressed invalid tool call "[^"]+": .+|historical tool (?:invocation|result)\s*\(\s*already\s+(?:executed|observed)\s*(?:\)|["']?\s*:?).*|past tool (?:invocation|result) \(context only\b.*)\s*$/i;
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>\s*[\s\S]*?<\/task-notification>/ig;
const TOOL_USE_ERROR_BLOCK_RE = /<tool_use_error>\s*[\s\S]*?<\/tool_use_error>/ig;
const SUBAGENT_USAGE_FOOTER_RE = /\n?agentId:\s*[^\n]+\(use SendMessage[^\n]*\)\s*\n?<usage>\s*[\s\S]*?<\/usage>\s*/ig;

const PROXY_ARTIFACT_PREFIXES = [
  "historical tool invocation",
  "historical tool result",
  "past tool invocation",
  "past tool result",
  "proxy suppressed invalid tool call",
];

function stripProxyArtifactLinesFromText(text = "") {
  const original = String(text || "");
  const withoutTaskNotifications = original
    .replace(TASK_NOTIFICATION_BLOCK_RE, "\n")
    .replace(TOOL_USE_ERROR_BLOCK_RE, "\n")
    .replace(SUBAGENT_USAGE_FOOTER_RE, "\n");
  const lines = withoutTaskNotifications.split(/\n/);
  const kept = lines.filter((line) => !PROXY_ARTIFACT_LINE_RE.test(line));
  const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return next === original.trim() ? original : next;
}

function maybeProxyArtifactFragment(text = "") {
  const trimmed = String(text || "").trimStart();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    PROXY_ARTIFACT_PREFIXES.some((prefix) => prefix.startsWith(lower) || lower.startsWith(prefix)) ||
    lower.startsWith("<task-notification") ||
    lower.startsWith("<tool_use_error") ||
    lower.startsWith("agentid:") ||
    lower.startsWith("<usage>")
  );
}

function maybePrivateMarkerFragment(text = "") {
  const trimmed = String(text || "").trimStart().replace(/^\[\s*/, "");
  if (!trimmed) return true;
  const upper = trimmed.toUpperCase();
  if (PRIVATE_MARKER_PREFIXES.some((prefix) => prefix.startsWith(upper) || upper.startsWith(prefix))) return true;
  if (maybeProxyArtifactFragment(trimmed)) return true;
  if (routingPolicy.maybeLegacyBareDifficultyMarkerFragment(trimmed)) return true;
  if (routingPolicy.maybeTaskStatusMarkerFragment(trimmed)) return true;
  return /^\s*LLM_PROXY_(?:INTERNAL_ROUTING|TASK_DIFFICULTY|TASK_STATUS)\b[^\r\n]*$/i.test(trimmed);
}

function mapModel(model) {
  if (!model) return "auto-coding";
  if (model in state.GROUPS) return model;
  if (state.PROVIDERS.some((p) => p.model === model || p.name === model)) return model;
  const claudeModel = `claude/${model}`;
  if (state.PROVIDERS.some((p) => p.model === claudeModel || p.upstream_model === model)) return claudeModel;
  return "auto-coding";
}

function directAnthropicProviderForModel(model = "") {
  const requested = String(model || "").trim();
  if (!requested || requested in state.GROUPS) return null;
  const withoutPrefix = requested.replace(/^claude\//, "");
  const withPrefix = requested.startsWith("claude/") ? requested : `claude/${requested}`;
  return (state.PROVIDERS || []).find((provider) => {
    if (!provider?.key || provider.alive === false) return false;
    const family = String(provider.family || provider.source_family || "").toLowerCase();
    const protocol = String(provider.protocol || "").toLowerCase();
    if (family ? family !== "claude" : protocol !== "anthropic") return false;
    return (
      provider.model === requested ||
      provider.model === withPrefix ||
      provider.upstream_model === requested ||
      provider.upstream_model === withoutPrefix
    ) && !scoring.isOnCooldown(provider.name) && !scoring.isQuotaDisabled(provider.name) &&
      _taskRuntime?.isProviderAvailable(provider) !== false;
  }) || null;
}

async function tryDirectClaudeMessagesPassthrough(req, res, request = {}) {
  const provider = directAnthropicProviderForModel(request.model);
  if (!provider || scoring.isOnCooldown(provider.name) || scoring.isQuotaDisabled(provider.name)) return false;
  const headers = req.headers || {};
  const parsed = parseClaudeCodeUserMetadata(request.metadata || {});
  const sessionId = headerValue(headers, "x-claude-code-session-id") || parsed.session_id || "";
  const clientBetas = clientBetasFromHeaders(headers);
  const upstreamOptions = { sessionId, ...(clientBetas.length > 0 ? { clientBetas } : {}) };
  let upstream;
  try {
    upstream = await anthropicAdapter.postAnthropic(provider, request, upstreamOptions);
  } catch (error) {
    if (upstreamTransport.isLocalFailure(error)) throw error;
    _taskRuntime?.observeProviderFailure(provider, error);
    state.log(`ANTHROPIC-PASSTHROUGH-ERR: ${provider.name} status=${Number(error.status || error.statusCode) || 0}`);
    return false;
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    _taskRuntime?.observeProviderFailure(provider, upstream);
    state.log(`ANTHROPIC-PASSTHROUGH-FAIL: ${provider.name} status=${upstream.status}`);
    if (upstream.status === 429) {
      scoring.setCooldown(provider.name, 60 * 60_000, "Anthropic 429 rate limit");
      const scaffolded = anthropicAdapter.withClaudeCodeSdkScaffold(provider, request, { sessionId });
      if (scaffolded !== request) {
        try {
          upstream = await anthropicAdapter.postAnthropic(provider, scaffolded, upstreamOptions);
        } catch (error) {
          if (upstreamTransport.isLocalFailure(error)) throw error;
          _taskRuntime?.observeProviderFailure(provider, error);
          state.log(`ANTHROPIC-PASSTHROUGH-SCAFFOLD-ERR: ${provider.name} status=${Number(error.status || error.statusCode) || 0}`);
          return false;
        }
        if (upstream.status >= 200 && upstream.status < 300) {
          state.log(`ANTHROPIC-PASSTHROUGH-SCAFFOLD-OK: ${provider.name} status=${upstream.status} body=${String(upstream.body || "").length}chars`);
          res.writeHead(upstream.status, upstream.headers || { "content-type": "application/json" });
          res.end(upstream.body || "");
          return true;
        }
        _taskRuntime?.observeProviderFailure(provider, upstream);
        state.log(`ANTHROPIC-PASSTHROUGH-SCAFFOLD-FAIL: ${provider.name} status=${upstream.status}`);
      }
    }
    return false;
  }
  state.log(`ANTHROPIC-PASSTHROUGH-OK: ${provider.name} status=${upstream.status} body=${String(upstream.body || "").length}chars`);
  res.writeHead(upstream.status, upstream.headers || { "content-type": "application/json" });
  res.end(upstream.body || "");
  return true;
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
    const contentParts = [];
    const flushContentParts = () => {
      if (contentParts.length === 0) return;
      const converted = mediaContent.toOpenAIChatContent(contentParts);
      contentParts.length = 0;
      if (Array.isArray(converted)) {
        messages.push({ role: "user", content: converted });
      } else {
        addUserContent(messages, converted);
      }
    };
    for (const part of content) {
      if (part?.type === "tool_result") {
        flushContentParts();
        messages.push({
          role: "tool",
          tool_call_id: part.tool_use_id,
          content: contentToText(part.content),
        });
      } else {
        contentParts.push(part);
      }
    }
    flushContentParts();
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
  // Preserve trusted native failure metadata for response validation without
  // adding unsupported fields to OpenAI tool messages.
  const failedToolCallIds = [...new Set((request.messages || []).flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(part =>
      part?.type === "tool_result" && part.is_error === true && typeof part.tool_use_id === "string",
    ).map(part => part.tool_use_id) : [],
  ))];
  return {
    ...(failedToolCallIds.length ? { _llmProxyFailedToolCallIds: failedToolCallIds } : {}),
    model: mapModel(request.model),
    messages,
    tools: tools.length > 0 ? tools : undefined,
    max_tokens: request.max_tokens || 4096,
    ...(["low", "medium", "high", "xhigh", "max"].includes(request.output_config?.effort)
      ? { reasoning_effort: request.output_config.effort } : {}),
    temperature: request.temperature,
    stream: request.stream === true,
  };
}

function parseClaudeCodeUserMetadata(metadata = {}) {
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

function headerValue(headers = {}, name) {
  const lower = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return "";
}

function attachClaudeCodeContext(chatReq, request = {}, headers = {}) {
  const metadata = request.metadata || {};
  const parsed = parseClaudeCodeUserMetadata(metadata);
  const headerSessionId = headerValue(headers, "x-claude-code-session-id");
  const sessionId = headerSessionId || parsed.session_id || "";
  if (sessionId) chatReq._claudeCodeSessionId = sessionId;
  if (metadata.user_id) chatReq._claudeCodeMetadata = metadata;
  const profile = {
    ...(parsed.device_id ? { deviceId: parsed.device_id } : {}),
    ...(parsed.account_uuid ? { accountUuid: parsed.account_uuid } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  if (Object.keys(profile).length > 0) chatReq._claudeCodeProfile = profile;
  const requestShape = {
    ...(request.thinking ? { thinking: request.thinking } : {}),
    ...(request.context_management ? { context_management: request.context_management } : {}),
    ...(request.output_config ? { output_config: request.output_config } : {}),
  };
  if (Object.keys(requestShape).length > 0) chatReq._claudeCodeRequestShape = requestShape;
  const clientBetas = clientBetasFromHeaders(headers);
  if (clientBetas.length > 0) {
    Object.defineProperty(chatReq, "__llmProxyClientBetas", {
      value: clientBetas,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return chatReq;
}

// Client-sent anthropic-beta values, forwarded so beta-gated fields (new tool
// types, output_config, ToolSearch references) are accepted upstream exactly
// as the client would get talking to Anthropic directly. Strict allowlist on
// shape; total length capped to keep headers safe.
function clientBetasFromHeaders(headers = {}) {
  const raw = headers["anthropic-beta"] ?? headers["Anthropic-Beta"] ?? "";
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const cleaned = [];
  for (const value of values) {
    const beta = String(value || "").trim();
    if (!beta || beta.length > 128) continue;
    if (!/^[a-z0-9_.@-]+$/i.test(beta)) continue;
    if (!cleaned.includes(beta)) cleaned.push(beta);
    if (cleaned.length >= 32) break;
  }
  return cleaned;
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

function normalizeTodoStatus(value = "", index = 0) {
  const status = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (/^(?:complete|completed|done|finished|fixed|closed)$/.test(status)) return "completed";
  if (/^(?:in_progress|active|current|doing|started|working|ongoing)$/.test(status)) return "in_progress";
  if (/^(?:pending|todo|to_do|open|next|queued|planned)$/.test(status)) return "pending";
  return index === 0 ? "in_progress" : "pending";
}

function normalizeTodoEntry(entry, index = 0) {
  if (typeof entry === "string") {
    const content = entry.trim();
    return content
      ? { content, status: normalizeTodoStatus("", index), activeForm: content }
      : null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const content = String(
    entry.content ?? entry.text ?? entry.step ?? entry.title ?? entry.task ?? entry.description ?? entry.name ?? "",
  ).trim();
  if (!content) return null;
  return {
    content,
    status: normalizeTodoStatus(entry.status ?? entry.state ?? entry.phase ?? entry.progress ?? "", index),
    activeForm: String(entry.activeForm ?? entry.active_form ?? entry.presentProgress ?? entry.progressText ?? content).trim() || content,
  };
}

function parseTrackedTodosFromAnthropicMessages(messages = []) {
  let latest = [];
  for (const message of messages || []) {
    const text = contentToText(message?.content || "").trim();
    if (!text) continue;
    if (!/todo list|todowrite|tracking progress/i.test(text)) continue;
    const parsed = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(?:[\[(]?\d+[.)\]]?\s*)?\[(completed|done|finished|fixed|in[_ -]?progress|active|working|started|pending|todo|open|next|queued|planned)\]\s+(.+?)\s*[\])]*$/i);
      if (!match) continue;
      const normalized = normalizeTodoEntry({ content: match[2].trim(), status: match[1] }, parsed.length);
      if (normalized) parsed.push(normalized);
    }
    if (parsed.length > 0) latest = parsed;
  }
  return latest;
}

function repairToolInput(name, input = {}, schema = {}, requestMessages = []) {
  const out = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : input;
  if (!out || typeof out !== "object" || Array.isArray(out)) return { input, changed: false };
  let changed = false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties || {};

  if (
    required.includes("target") &&
    Object.prototype.hasOwnProperty.call(properties, "target") &&
    (out.target == null || out.target === "")
  ) {
    const targetAliases = ["selector", "element", "locator", "query", "css", "xpath", "label"];
    const aliasKey = targetAliases.find((key) => typeof out[key] === "string" && out[key].trim());
    if (aliasKey) {
      out.target = out[aliasKey].trim();
      changed = true;
    }
  }

  if (/^TodoWrite$/i.test(String(name || "").trim())) {
    if (required.includes("todos") || Object.prototype.hasOwnProperty.call(properties, "todos")) {
      const sourceKeys = ["todos", "items", "tasks", "plan", "checklist"];
      const sourceKey = sourceKeys.find((key) => Array.isArray(out[key]) && out[key].length > 0);
      if (!Array.isArray(out.todos) || out.todos.length === 0) {
        const todos = Array.isArray(sourceKey ? out[sourceKey] : null)
          ? out[sourceKey].map((entry, index) => normalizeTodoEntry(entry, index)).filter(Boolean)
          : [];
        if (todos.length > 0) {
          out.todos = todos;
          changed = true;
        }
      } else {
        const todos = out.todos.map((entry, index) => normalizeTodoEntry(entry, index)).filter(Boolean);
        if (todos.length > 0 && JSON.stringify(todos) !== JSON.stringify(out.todos)) {
          out.todos = todos;
          changed = true;
        }
      }
      if (!Array.isArray(out.todos) || out.todos.length === 0) {
        const fallbackContent = String(
          out.todo ?? out.item ?? out.task ?? out.step ?? out.text ?? out.content ?? out.message ?? out.note ?? "",
        ).trim();
        if (fallbackContent) {
          out.todos = [{
            content: fallbackContent,
            status: normalizeTodoStatus(out.status ?? out.state ?? out.phase ?? "", 0),
            activeForm: String(out.activeForm ?? out.active_form ?? fallbackContent).trim() || fallbackContent,
          }];
          changed = true;
        }
      }
      if (!Array.isArray(out.todos) || out.todos.length === 0) {
        const tracked = parseTrackedTodosFromAnthropicMessages(requestMessages);
        if (tracked.length > 0) {
          out.todos = tracked.map((entry, index) => normalizeTodoEntry(entry, index)).filter(Boolean);
          changed = true;
        }
      }
      if (!Array.isArray(out.todos) || out.todos.length === 0) {
        out.todos = [{ content: "Continue active task", status: "in_progress", activeForm: "Continue active task" }];
        changed = true;
      }
    }
  }

  return { input: out, changed };
}

function decodeToolCall(toolCall, schemas, requestMessages = []) {
  const name = toolCall.function?.name || "unknown_tool";
  const schema = schemas.get(name);
  const parsed = parseToolArguments(toolCall.function?.arguments);
  if (!parsed.ok) return { ok: false, name, reason: parsed.reason, schema };
  const repaired = repairToolInput(name, parsed.input, schema, requestMessages);
  const finalInput = repaired.input;
  const invalid = validateToolInput(name, finalInput, schema);
  if (invalid) return { ok: false, name, reason: invalid, schema };
  return {
    ok: true,
    id: toolCall.id || genId("toolu"),
    name,
    input: finalInput,
    raw: repaired.changed ? JSON.stringify(finalInput) : parsed.raw,
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

function contentFromOpenAIMessage(message = {}, requestTools = [], requestMessages = []) {
  const content = [];
  const schemas = toolSchemaMapFromAnthropicTools(requestTools);
  const invalidMessages = [];
  const text = stripPrivateMarkersFromText(contentToText(message.content)).trimEnd();
  if (text) content.push({ type: "text", text });
  for (const toolCall of message.tool_calls || []) {
    const decoded = decodeToolCall(toolCall, schemas, requestMessages);
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

function toAnthropicResponse(openai, requestModel, requestTools = [], requestMessages = []) {
  const choice = openai.choices?.[0] || {};
  const usage = openai.usage || {};
  const content = contentFromOpenAIMessage(choice.message || {}, requestTools, requestMessages);
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
  constructor(clientRes, requestModel, requestTools = [], requestMessages = []) {
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
    this.requestMessages = Array.isArray(requestMessages) ? requestMessages : [];
    this.pendingTools = new Map();
    this.emittedToolCount = 0;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.pendingStopReason = null;
    this.finished = false;
    this.pendingPrivateText = "";
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
      if (choice.message) this._handleMessage(choice.message);
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

  _emitSanitizedText(text, flush = false) {
    this.pendingPrivateText += String(text || "");
    let output = "";

    const hasOpenTaskNotification =
      /<task-notification>/i.test(this.pendingPrivateText) &&
      !/<\/task-notification>/i.test(this.pendingPrivateText);
    const hasOpenUsageFooter =
      /agentId:/i.test(this.pendingPrivateText) &&
      /<usage>/i.test(this.pendingPrivateText) &&
      !/<\/usage>/i.test(this.pendingPrivateText);
    if (!flush && (hasOpenTaskNotification || hasOpenUsageFooter)) {
      return;
    }

    const hasCompleteMultilineArtifact =
      /<task-notification>[\s\S]*<\/task-notification>/i.test(this.pendingPrivateText) ||
      (/agentId:/i.test(this.pendingPrivateText) && /<usage>[\s\S]*<\/usage>/i.test(this.pendingPrivateText));
    if (hasCompleteMultilineArtifact) {
      output += stripPrivateMarkersFromText(this.pendingPrivateText);
      this.pendingPrivateText = "";
    }

    while (true) {
      const newlineIndex = this.pendingPrivateText.search(/\r?\n/);
      if (newlineIndex < 0) break;
      const newlineLength = this.pendingPrivateText[newlineIndex] === "\r" ? 2 : 1;
      const line = this.pendingPrivateText.slice(0, newlineIndex + newlineLength);
      this.pendingPrivateText = this.pendingPrivateText.slice(newlineIndex + newlineLength);
      output += stripPrivateMarkersFromText(line);
    }

    if (this.pendingPrivateText) {
      if (flush || !maybePrivateMarkerFragment(this.pendingPrivateText)) {
        output += stripPrivateMarkersFromText(this.pendingPrivateText);
        this.pendingPrivateText = "";
      }
    }

    this._emitText(output);
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

  _rememberToolDelta(toolCall, fallbackIndex = 0, snapshot = false) {
    // Full choice.message tool calls are snapshots, not new argument fragments.
    // Match their stable ID before positional fallback: final snapshots can omit
    // indexes and reorder calls relative to the streamed deltas.
    const existing = toolCall.id
      ? [...this.pendingTools.entries()].find(([, pending]) => pending.id === toolCall.id)
      : undefined;
    const key = toolCall.index ?? existing?.[0] ?? fallbackIndex;
    const current = this.pendingTools.get(key) || {
      index: key,
      id: toolCall.id,
      type: toolCall.type,
      function: { name: toolCall.function?.name, arguments: "" },
    };
    if (toolCall.id) current.id = toolCall.id;
    if (toolCall.type) current.type = toolCall.type;
    if (toolCall.function?.name) current.function.name = toolCall.function.name;
    if (typeof toolCall.function?.arguments === "string") {
      if (snapshot) current.function.arguments = toolCall.function.arguments;
      else current.function.arguments += toolCall.function.arguments;
    }
    this.pendingTools.set(key, current);
  }

  _flushPendingTools() {
    for (const pending of [...this.pendingTools.values()].sort((a, b) => a.index - b.index)) {
      if (this.toolIndexes.has(pending.index)) continue;
      const decoded = decodeToolCall(pending, this.toolSchemas, this.requestMessages);
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
      this._emitSanitizedText(delta.content);
    }
    for (const [fallbackIndex, toolCall] of (delta.tool_calls || []).entries()) {
      this._rememberToolDelta(toolCall, fallbackIndex);
    }
  }

  _handleMessage(message = {}) {
    const text = contentToText(message.content);
    if (text) this._emitSanitizedText(text);
    for (const [fallbackIndex, toolCall] of (message.tool_calls || []).entries()) {
      this._rememberToolDelta(toolCall, fallbackIndex, true);
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
    this._emitSanitizedText("", true);
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
  return upstreamTransport.withOwnership(async () => {
    try { return await handleMessagesOwned(_req,res,body); }
    catch (error) {
      if (!upstreamTransport.isLocalFailure(error)) throw error;
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy?.(); return; }
      res.writeHead(error.statusCode || 503, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error:{code:error.code,message:error.message}}));
    }
  },res);
}
async function handleMessagesOwned(_req, res, body) {
  if (!_handleChatCompletion) throw new Error("anthropic-gateway.init() was not called");
  let request;
  try { request = JSON.parse(body); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }));
    return;
  }

  if (await tryDirectClaudeMessagesPassthrough(_req, res, request)) return;

  const chatReq = attachClaudeCodeContext(translateRequest(request), request, _req.headers || {});
  // Options come from this trusted bridge, not arbitrary client body fields.
  const routingOptions = { headers: _req.headers,
    ...(chatReq._llmProxyFailedToolCallIds ? { nativeFailedToolCallIds: chatReq._llmProxyFailedToolCallIds } : {}),
  };
  if (request.stream === true) {
    const streamRes = new AnthropicStreamResponse(res, request.model || chatReq.model, request.tools || [], request.messages || []);
    return _handleChatCompletion(chatReq, streamRes, routingOptions);
  }

  const capture = new CaptureResponse();
  await _handleChatCompletion(chatReq, capture, routingOptions);
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
  res.end(JSON.stringify(toAnthropicResponse(openai, request.model || chatReq.model, request.tools || [], request.messages || [])));
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
  clientBetasFromHeaders,
};
