"use strict";

const crypto = require("crypto");
const state = require("./state");

// Late-bound
let _handleChatCompletion;

function init({ handleChatCompletion }) {
  _handleChatCompletion = handleChatCompletion;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------
function genId(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// Model mapping — Codex model names → proxy groups
// ---------------------------------------------------------------------------
const CODEX_MODEL_MAP = {
  "o4-mini": "auto-coding",
  "o3": "auto-coding",
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
  if (state.PROVIDERS.some(p => p.model === model || p.name === model)) return model;
  return "auto-coding";
}

// ---------------------------------------------------------------------------
// Input translation: Responses API → Chat Completions
// ---------------------------------------------------------------------------
function translateInput(request) {
  const messages = [];
  const model = mapModel(request.model);

  // Instructions → system message
  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }

  // Build map of function_call names by call_id for tool response name lookup
  const callNames = {};

  for (const item of (request.input || [])) {
    switch (item.type) {
      case "message": {
        let content = "";
        if (typeof item.content === "string") {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content
            .filter(p => p.type === "input_text" || p.type === "text")
            .map(p => p.text)
            .join("\n");
        }
        messages.push({ role: item.role || "user", content });
        break;
      }

      case "function_call": {
        callNames[item.call_id] = item.name;
        // Merge with previous assistant tool_calls if possible
        const prev = messages[messages.length - 1];
        if (prev && prev.role === "assistant" && prev.tool_calls) {
          prev.tool_calls.push({
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments || "{}" },
          });
        } else {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: item.arguments || "{}" },
            }],
          });
        }
        break;
      }

      case "function_call_output": {
        const name = callNames[item.call_id] || "unknown_tool";
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          name,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
        break;
      }

      case "item_reference":
        break; // stateless proxy, no server-side state

      default:
        state.log(`RESPONSES: unknown input item type: ${item.type}`);
    }
  }

  // Translate tools: Responses API format → Chat Completions format
  // Responses: {type:"function", name:"x", parameters:{...}}
  // Chat Completions: {type:"function", function:{name:"x", parameters:{...}}}
  let tools = request.tools;
  if (tools?.length > 0) {
    tools = tools.map(t => {
      // Already in Chat Completions format
      if (t.function?.name) return t;
      // Responses API format — wrap in function object
      if (t.name) return {
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters, strict: t.strict },
      };
      // Invalid tool — skip
      return null;
    }).filter(Boolean);
  }

  return {
    model,
    messages,
    tools: tools || undefined,
    max_tokens: request.max_output_tokens || 16384,
    stream: true,
  };
}

// ---------------------------------------------------------------------------
// MockResponse — captures handleChatCompletion SSE output → Responses API events
// ---------------------------------------------------------------------------
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
    this._toolCalls = {}; // call_id → {name, arguments, itemId, done}
    this._contentStarted = false;
    this._textContent = "";
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

    // Parse SSE chunks: "data: {...}\n\n"
    this._buffer += chunk.toString();
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      // Text content delta
      if (choice.delta?.content) {
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
        this._textContent += choice.delta.content;
        this.onEvent({
          type: "response.output_text.delta",
          item_id: this._msgItemId,
          output_index: 0,
          content_index: 0,
          delta: choice.delta.content,
        });
      }

      // Tool call deltas
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const callId = tc.id || Object.keys(this._toolCalls).find(k => !this._toolCalls[k].done) || genId("call");
          if (!this._toolCalls[callId]) {
            this._toolCalls[callId] = { name: "", arguments: "", itemId: genId("fc"), done: false };
            this.onEvent({
              type: "response.output_item.added",
              output_index: Object.keys(this._toolCalls).length - 1,
              item: {
                id: this._toolCalls[callId].itemId,
                type: "function_call",
                call_id: callId,
                name: tc.function?.name || "",
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
              output_index: Object.keys(this._toolCalls).indexOf(callId),
              call_id: callId,
              delta: tc.function.arguments,
            });
          }
        }
      }

      // Finish: text stop
      if (choice.finish_reason === "stop" && this._msgItemId) {
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

      // Finish: tool calls
      if (choice.finish_reason === "tool_calls") {
        let idx = 0;
        for (const [callId, entry] of Object.entries(this._toolCalls)) {
          if (!entry.done) {
            entry.done = true;
            this.onEvent({
              type: "response.function_call_arguments.done",
              item_id: entry.itemId,
              output_index: idx,
              call_id: callId,
              name: entry.name,
              arguments: entry.arguments,
            });
            this.onEvent({
              type: "response.output_item.done",
              output_index: idx,
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
          idx++;
        }
      }

      if (parsed.usage) this._usage = parsed.usage;
    }
  }

  end(body) {
    if (this.statusCode >= 400) {
      const errBody = (this._buffer || "") + (body || "");
      this.onError(this.statusCode, errBody);
      return;
    }

    // Build output items
    const outputItems = [];
    if (this._msgItemId) {
      outputItems.push({
        id: this._msgItemId,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: this._textContent }],
        status: "completed",
      });
    }
    for (const [callId, entry] of Object.entries(this._toolCalls)) {
      outputItems.push({
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
        output: outputItems,
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

// ---------------------------------------------------------------------------
// Process a single Responses API request through the proxy pipeline
// conversationHistory: array of chat completion messages accumulated across turns (mutated)
// ---------------------------------------------------------------------------
async function processRequest(request, emitEvent, emitError, emitDone, conversationHistory) {
  const chatReq = translateInput(request);

  // Merge with conversation history: prepend history before current turn's messages
  // First message might be system (from instructions) — keep at front
  let allMessages;
  if (conversationHistory && conversationHistory.length > 0) {
    const systemMsgs = chatReq.messages.filter(m => m.role === "system");
    const nonSystemNew = chatReq.messages.filter(m => m.role !== "system");
    // History already has system from first turn — only add new system if different
    const existingSystem = conversationHistory.find(m => m.role === "system");
    if (systemMsgs.length > 0 && (!existingSystem || existingSystem.content !== systemMsgs[0].content)) {
      // New/different system prompt — update it
      if (existingSystem) existingSystem.content = systemMsgs[0].content;
      else conversationHistory.unshift(systemMsgs[0]);
    }
    // Append new non-system messages to history
    conversationHistory.push(...nonSystemNew);
    allMessages = [...conversationHistory];
  } else {
    // First turn — seed history
    if (conversationHistory) conversationHistory.push(...chatReq.messages);
    allMessages = chatReq.messages;
  }

  const fullReq = { ...chatReq, messages: allMessages };
  state.log(`RESPONSES: model=${request.model}→${chatReq.model} input=${request.input?.length || 0} items → ${chatReq.messages.length} new msgs, ${allMessages.length} total msgs, tools=${chatReq.tools?.length || 0}`);

  const mockRes = new MockResponse(
    emitEvent,
    emitError,
    () => {
      // After successful response, append assistant response to history
      if (conversationHistory && mockRes._textContent) {
        conversationHistory.push({ role: "assistant", content: mockRes._textContent });
      }
      if (conversationHistory && Object.keys(mockRes._toolCalls).length > 0) {
        const toolCallsArr = Object.entries(mockRes._toolCalls).map(([callId, entry]) => ({
          id: callId, type: "function", function: { name: entry.name, arguments: entry.arguments },
        }));
        conversationHistory.push({ role: "assistant", content: mockRes._textContent || null, tool_calls: toolCallsArr });
      }
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

// ---------------------------------------------------------------------------
// WebSocket handler — multi-turn conversation over persistent connection
// ---------------------------------------------------------------------------
function handleResponsesWS(ws, req) {
  state.log(`RESPONSES-WS: connection from ${req.socket.remoteAddress} url=${req.url} headers=${JSON.stringify({upgrade:req.headers.upgrade, origin:req.headers.origin, 'sec-websocket-protocol':req.headers['sec-websocket-protocol']})}`);
  const conversationHistory = []; // accumulates messages across turns

  ws.on("message", async (data) => {
    const raw = data.toString();
    state.log(`RESPONSES-WS: recv ${raw.length}chars: ${raw.substring(0, 300)}`);
    let request;
    try {
      request = JSON.parse(raw);
    } catch (e) {
      state.log(`RESPONSES-WS: JSON parse error: ${e.message}`);
      ws.send(JSON.stringify({ type: "error", error: { message: "Invalid JSON" } }));
      return;
    }

    const rInput = request.input || request.response?.input || [];
    const rTools = request.tools || request.response?.tools || [];
    state.log(`RESPONSES-WS: type=${request.type} model=${request.model || request.response?.model} input=${rInput.length} tools=${rTools.length} keys=${Object.keys(request).join(",")}`);
    if (rInput.length > 0) state.log(`RESPONSES-WS: input[0]=${JSON.stringify(rInput[0]).substring(0, 200)}`);
    if (rInput.length === 0) state.log(`RESPONSES-WS: NO INPUT — instructions=${(request.instructions||"").substring(0,100)}`);

    // Handle response.create wrapper — two formats:
    // 1. Realtime API: {type:"response.create", response:{model, input, tools, ...}}
    // 2. Codex CLI: {type:"response.create", model, input, tools, instructions, ...} (flat)
    if (request.type === "response.create") {
      if (request.response) {
        request = { ...request.response, model: request.response.model || request.model };
      }
      // Flat format — already correct, just strip type field
    }

    await processRequest(
      request,
      (event) => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); },
      (status, body) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error: { message: body, code: status } })); },
      () => { /* turn done — connection stays open */ },
      conversationHistory,
    );
  });

  ws.on("close", () => state.log(`RESPONSES-WS: closed`));
  ws.on("error", (err) => state.log(`RESPONSES-WS: error: ${err.message}`));
}

// ---------------------------------------------------------------------------
// HTTP SSE handler — single turn per POST request
// ---------------------------------------------------------------------------
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
    (status, errBody) => { res.write(`data: ${JSON.stringify({ type: "error", error: { message: errBody, code: status } })}\n\n`); },
    () => { res.end(); },
    null, // HTTP SSE is stateless — no conversation history
  );
}

module.exports = {
  init,
  handleResponsesWS,
  handleResponsesHTTP,
};
