"use strict";

const crypto = require("crypto");
const state = require("./state");

let _handleChatCompletion;

function init({ handleChatCompletion }) {
  _handleChatCompletion = handleChatCompletion;
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

const CODEX_MODEL_MAP = {
  "o4-mini": "auto-coding",
  o3: "auto-coding",
  "o3-mini": "auto-coding",
  "gpt-5.5": "auto-coding",
  "gpt-5.4": "auto-coding",
  "gpt-5.4-mini": "auto-coding",
  "gpt-5.3-codex": "auto-coding",
  "gpt-5.2": "auto-coding",
  "codex-auto-review": "auto-coding",
};

function mapModel(model) {
  if (!model) return "auto-coding";
  if (CODEX_MODEL_MAP[model]) return CODEX_MODEL_MAP[model];
  if (model in state.GROUPS) return model;
  if (state.PROVIDERS.some((p) => p.model === model || p.name === model)) return model;
  return "auto-coding";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .filter((part) => part && (part.type === "input_text" || part.type === "text" || part.type === "output_text"))
    .map((part) => part.text || "")
    .join("\n");
}

function translateTool(tool) {
  if (!tool || tool.type !== "function") return null;
  if (tool.function?.name) return tool;
  if (!tool.name) return null;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  };
}

function translateInput(request = {}) {
  const messages = [];
  const model = mapModel(request.model);
  const callNames = {};

  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }

  for (const item of request.input || []) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "message") {
      messages.push({
        role: item.role || "user",
        content: contentToText(item.content),
      });
      continue;
    }

    if (item.type === "function_call") {
      callNames[item.call_id] = item.name;
      const toolCall = {
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments || "{}",
        },
      };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "assistant" && Array.isArray(prev.tool_calls)) {
        prev.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        name: callNames[item.call_id] || item.name || "unknown_tool",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
      continue;
    }

    if (item.type !== "item_reference") {
      state.log(`RESPONSES: unknown input item type: ${item.type}`);
    }
  }

  const tools = (request.tools || []).map(translateTool).filter(Boolean);
  return {
    model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    max_tokens: request.max_output_tokens || request.max_tokens || 16384,
    stream: true,
  };
}

class MockResponse {
  constructor(onEvent, onError, onDone) {
    this.onEvent = onEvent;
    this.onError = onError;
    this.onDone = onDone;
    this.statusCode = null;
    this.headersSent = false;
    this._buffer = "";
    this._responseId = genId("resp");
    this._msgItemId = null;
    this._contentStarted = false;
    this._textContent = "";
    this._toolCalls = {};
    this._toolCallOrder = [];
    this._usage = null;
  }

  setHeader() {}

  writeHead(status) {
    this.statusCode = status;
    this.headersSent = true;
    if (status >= 400) return;
    this.onEvent({
      type: "response.created",
      response: {
        id: this._responseId,
        object: "response",
        status: "in_progress",
        output: [],
      },
    });
  }

  write(chunk) {
    if (this.statusCode >= 400) {
      this._buffer += chunk;
      return;
    }

    this._buffer += chunk.toString();
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (parsed.usage) this._usage = parsed.usage;

      this._handleTextDelta(choice.delta);
      this._handleToolDeltas(choice.delta);
      this._handleFinish(choice.finish_reason);
    }
  }

  _handleTextDelta(delta = {}) {
    if (!delta.content) return;
    if (!this._contentStarted) {
      this._contentStarted = true;
      this._msgItemId = genId("msg");
      this.onEvent({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: this._msgItemId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      });
    }
    this._textContent += delta.content;
    this.onEvent({
      type: "response.output_text.delta",
      item_id: this._msgItemId,
      output_index: 0,
      content_index: 0,
      delta: delta.content,
    });
  }

  _handleToolDeltas(delta = {}) {
    if (!Array.isArray(delta.tool_calls)) return;
    for (const tc of delta.tool_calls) {
      const index = tc.index || 0;
      const callId = tc.id || this._toolCallOrder[index] || genId("call");
      if (!this._toolCalls[callId]) {
        this._toolCallOrder[index] = callId;
        this._toolCalls[callId] = {
          name: tc.function?.name || "",
          arguments: "",
          itemId: genId("fc"),
          done: false,
        };
        this.onEvent({
          type: "response.output_item.added",
          output_index: index,
          item: {
            id: this._toolCalls[callId].itemId,
            type: "function_call",
            call_id: callId,
            name: this._toolCalls[callId].name,
            arguments: "",
          },
        });
      }

      const entry = this._toolCalls[callId];
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments) {
        entry.arguments += tc.function.arguments;
        this.onEvent({
          type: "response.function_call_arguments.delta",
          item_id: entry.itemId,
          output_index: index,
          call_id: callId,
          delta: tc.function.arguments,
        });
      }
    }
  }

  _handleFinish(finishReason) {
    if (finishReason === "stop" && this._msgItemId) {
      this.onEvent({
        type: "response.output_text.done",
        item_id: this._msgItemId,
        output_index: 0,
        content_index: 0,
        text: this._textContent,
      });
      this.onEvent({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: this._msgItemId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: this._textContent }],
          status: "completed",
        },
      });
    }

    if (finishReason === "tool_calls") {
      for (let index = 0; index < this._toolCallOrder.length; index++) {
        const callId = this._toolCallOrder[index];
        const entry = this._toolCalls[callId];
        if (!entry || entry.done) continue;
        entry.done = true;
        this.onEvent({
          type: "response.function_call_arguments.done",
          item_id: entry.itemId,
          output_index: index,
          call_id: callId,
          name: entry.name,
          arguments: entry.arguments,
        });
        this.onEvent({
          type: "response.output_item.done",
          output_index: index,
          item: {
            id: entry.itemId,
            type: "function_call",
            call_id: callId,
            name: entry.name,
            arguments: entry.arguments,
            status: "completed",
          },
        });
      }
    }
  }

  end(body) {
    if (this.statusCode >= 400) {
      this.onError(this.statusCode, (this._buffer || "") + (body || ""));
      return;
    }

    const output = [];
    if (this._msgItemId) {
      output.push({
        id: this._msgItemId,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: this._textContent }],
        status: "completed",
      });
    }
    for (const callId of this._toolCallOrder) {
      const entry = this._toolCalls[callId];
      if (!entry) continue;
      output.push({
        id: entry.itemId,
        type: "function_call",
        call_id: callId,
        name: entry.name,
        arguments: entry.arguments,
        status: "completed",
      });
    }

    this.onEvent({
      type: "response.completed",
      response: {
        id: this._responseId,
        object: "response",
        status: "completed",
        output,
        usage: this._usage ? {
          input_tokens: this._usage.prompt_tokens || 0,
          output_tokens: this._usage.completion_tokens || 0,
          total_tokens: this._usage.total_tokens || 0,
        } : undefined,
      },
    });
    this.onDone();
  }
}

function appendAssistantToHistory(history, mockRes) {
  if (!history) return;
  if (mockRes._toolCallOrder.length > 0) {
    history.push({
      role: "assistant",
      content: mockRes._textContent || null,
      tool_calls: mockRes._toolCallOrder.map((callId) => {
        const entry = mockRes._toolCalls[callId];
        return { id: callId, type: "function", function: { name: entry.name, arguments: entry.arguments } };
      }),
    });
  } else if (mockRes._textContent) {
    history.push({ role: "assistant", content: mockRes._textContent });
  }
}

function mergeHistory(chatReq, conversationHistory) {
  if (!conversationHistory) return chatReq.messages;
  if (conversationHistory.length === 0) {
    conversationHistory.push(...chatReq.messages);
    return chatReq.messages;
  }

  const systemMsgs = chatReq.messages.filter((m) => m.role === "system");
  const nonSystem = chatReq.messages.filter((m) => m.role !== "system");
  const existingSystem = conversationHistory.find((m) => m.role === "system");
  if (systemMsgs.length > 0 && (!existingSystem || existingSystem.content !== systemMsgs[0].content)) {
    if (existingSystem) existingSystem.content = systemMsgs[0].content;
    else conversationHistory.unshift(systemMsgs[0]);
  }
  conversationHistory.push(...nonSystem);
  while (conversationHistory.length > 400 && conversationHistory[0]?.role !== "system") {
    conversationHistory.shift();
  }
  return [...conversationHistory];
}

async function processRequest(request, emitEvent, emitError, emitDone, conversationHistory) {
  if (!_handleChatCompletion) throw new Error("responses.init() was not called");
  const chatReq = translateInput(request);
  const messages = mergeHistory(chatReq, conversationHistory);
  const fullReq = { ...chatReq, messages };

  state.log(`RESPONSES: model=${request.model || ""}->${chatReq.model} input=${request.input?.length || 0} items msgs=${messages.length} tools=${chatReq.tools?.length || 0}`);

  const mockRes = new MockResponse(
    emitEvent,
    emitError,
    () => {
      appendAssistantToHistory(conversationHistory, mockRes);
      emitDone();
    },
  );

  try {
    await _handleChatCompletion(fullReq, mockRes);
  } catch (err) {
    state.log(`RESPONSES: error: ${err.message || err}`);
    emitError(500, JSON.stringify({ error: { message: String(err.message || err) } }));
  }
}

function handleResponsesWS(ws, req) {
  state.log(`RESPONSES-WS: connection from ${req.socket.remoteAddress}`);
  const conversationHistory = [];
  const pendingItems = [];
  let sessionModel = null;
  let sessionInstructions = null;
  let sessionTools = null;

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error: { message: "Invalid JSON" } }));
      return;
    }

    if (msg.type === "session.update") {
      if (msg.session?.model) sessionModel = msg.session.model;
      if (msg.session?.instructions) sessionInstructions = msg.session.instructions;
      if (msg.session?.tools) sessionTools = msg.session.tools;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "session.updated", session: msg.session || {} }));
      return;
    }

    if (msg.type === "conversation.item.create") {
      if (msg.item) {
        pendingItems.push(msg.item);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "conversation.item.created", item: msg.item }));
      }
      return;
    }

    if (msg.type === "response.create") {
      const request = msg.response ? { ...msg.response, model: msg.response.model || msg.model } : { ...msg };
      delete request.type;
      request.input = [...pendingItems, ...(request.input || [])];
      pendingItems.length = 0;
      if (!request.model && sessionModel) request.model = sessionModel;
      if (!request.instructions && sessionInstructions) request.instructions = sessionInstructions;
      if (!request.tools && sessionTools) request.tools = sessionTools;

      await processRequest(
        request,
        (event) => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); },
        (status, body) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error: { message: body, code: status } })); },
        () => {},
        conversationHistory,
      );
      return;
    }

    state.log(`RESPONSES-WS: unknown event type=${msg.type}`);
  });

  ws.on("close", () => state.log("RESPONSES-WS: closed"));
  ws.on("error", (err) => state.log(`RESPONSES-WS: error: ${err.message}`));
}

async function handleResponsesHTTP(req, res, body) {
  let request;
  try {
    request = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  await processRequest(
    request,
    (event) => { res.write(`data: ${JSON.stringify(event)}\n\n`); },
    (status, bodyText) => { res.write(`data: ${JSON.stringify({ type: "error", error: { message: bodyText, code: status } })}\n\n`); },
    () => { res.end(); },
    null,
  );
}

module.exports = {
  init,
  translateInput,
  MockResponse,
  processRequest,
  handleResponsesWS,
  handleResponsesHTTP,
};
