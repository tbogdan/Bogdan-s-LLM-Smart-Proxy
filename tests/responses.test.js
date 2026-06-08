"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const responses = require("../lib/responses");
const routing = require("../lib/routing");
const state = require("../lib/state");
const providerAdapters = require("../lib/provider-adapters");

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.body = "";
    this.writableEnded = false;
    this.destroyed = false;
    this.endCalls = 0;
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
  }

  write(chunk) {
    if (this.writableEnded) throw new Error("write after end");
    this.body += chunk.toString();
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.endCalls += 1;
    this.emit("close");
  }
}

function parseSseEvents(body = "") {
  return String(body)
    .split(/\n\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice(6).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

test("translateInput maps Responses API messages, tools, and model aliases to chat completions", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    instructions: "You are careful.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect this repo." }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      { type: "function_call_output", call_id: "call_1", output: "README contents" },
    ],
    tools: [
      { type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" }, strict: true },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
    max_output_tokens: 1234,
  });

  assert.equal(chat.model, "auto-coding");
  assert.equal(chat.stream, true);
  assert.equal(chat.max_tokens, 1234);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "You are careful." },
    { role: "user", content: "Inspect this repo." },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
    },
    { role: "tool", tool_call_id: "call_1", name: "read_file", content: "README contents" },
  ]);
  assert.deepEqual(chat.tools, [
    { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" }, strict: true } },
  ]);
  assert.equal(chat.tool_choice, "required");
  assert.equal(chat.parallel_tool_calls, false);
});

test("translateInput maps Responses function tool_choice objects to Chat Completions shape", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    input: [{ role: "user", content: "Read package.json." }],
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "Read" },
  });

  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "Read" } });
});

test("translateInput forwards detected IDE client metadata for prompt capability scoping", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    input: [{ role: "user", content: "Read package.json." }],
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
  }, { client: "codex" });

  assert.equal(chat._llmProxyClient, "codex");
});

test("translateInput preserves Responses runtime capability contract for routing adapters", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    previous_response_id: "resp_1",
    prompt_cache_key: "cache_1",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use a subagent to inspect logs." }],
    tools: [
      { type: "function", name: "multi_agent_v1.spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      { type: "function", name: "create_goal", parameters: { type: "object" } },
      { type: "mcp", server_label: "mempalace" },
    ],
  }, {
    client: "codex",
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
      "openai-beta": "responses_websockets=2026-02-06",
    },
  });

  assert.equal(chat._llmProxyClient, "codex");
  assert.equal(chat._llmProxyCapabilityContract.client.id, "codex");
  assert.equal(chat._llmProxyCapabilityContract.runtime.surface, "codex");
  assert.equal(chat._llmProxyCapabilityContract.runtime.toolDialect.previousResponseToolContext, true);
  assert.equal(chat._llmProxyCapabilityContract.runtime.toolDialect.promptCacheKey, true);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.subagents, ["multi_agent_v1.spawn_agent"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.plans, ["update_plan"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.goals, ["create_goal"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.mcp, ["mcp:mempalace"]);
  assert.equal(chat.tools.length, 3);
});

test("translateInput maps OpenAI SDK chat-style Responses input and JSON schema format", () => {
  const schema = {
    type: "object",
    properties: { facts: { type: "array", items: { type: "string" } } },
    required: ["facts"],
    additionalProperties: false,
  };

  const chat = responses.translateInput({
    model: "auto-sm",
    input: [
      { role: "system", content: "Extract structured facts." },
      {
        role: "user",
        content: [
          { type: "text", text: "Project uses Graphiti as optional sidecar." },
          { type: "input_text", text: "Canonical memory remains Neo4j." },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "GraphitiFacts",
        schema,
        strict: true,
      },
    },
    max_output_tokens: 321,
  });

  assert.equal(chat.model, "auto-sm");
  assert.equal(chat.max_tokens, 321);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "Extract structured facts." },
    { role: "user", content: "Project uses Graphiti as optional sidecar.\nCanonical memory remains Neo4j." },
  ]);
  assert.deepEqual(chat.response_format, {
    type: "json_schema",
    json_schema: {
      name: "GraphitiFacts",
      schema,
      strict: true,
    },
  });
});

test("translateInput preserves Responses input_image parts as OpenAI image_url parts", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What changed visually?" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      },
    ],
  });

  assert.deepEqual(chat.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "What changed visually?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  ]);
});

test("MockResponse converts chat completion SSE text stream into Responses API events", () => {
  const events = [];
  let done = false;
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => { done = true; },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n');
  res.end();

  assert.equal(done, true);
  assert.equal(events[0].type, "response.created");
  assert.equal(events.some((event) => event.type === "response.output_item.added" && event.item.type === "message"), true);
  assert.deepEqual(
    events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta),
    ["Hel", "lo"],
  );
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text, "Hello");
  assert.deepEqual(completed.response.usage, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });
});

test("MockResponse strips split private assessment metadata from Responses API deltas", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"Updated docs.\\n\\n"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"LLM_PROXY_INTERNAL_ROUTING effort=low speed=4"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":" reason=monitoring"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  assert.equal(deltas.includes("Updated docs."), true);
  assert.equal(deltas.includes("effort=low"), false);
  assert.equal(deltas.includes("speed=4"), false);
  assert.equal(deltas.includes("reason=monitoring"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text.includes("effort=low"), false);
});

test("MockResponse strips split speed-only private assessment metadata from Responses API deltas", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"LLM_PROXY_INTERNAL_ROUTING spe"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"ed=4 reason=commit_changes\\n\\nCommitted changes."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  assert.equal(deltas.includes("Committed changes."), true);
  assert.equal(deltas.includes("speed=4"), false);
  assert.equal(deltas.includes("reason=commit_changes"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text.includes("commit_changes"), false);
});

test("MockResponse strips split legacy bare assessment metadata from Responses API deltas", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"eff"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"ort=low speed=4 reason=playwright_smoke\\n\\nSmoke passed."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  assert.equal(deltas.includes("Smoke passed."), true);
  assert.equal(deltas.includes("effort=low"), false);
  assert.equal(deltas.includes("reason=playwright_smoke"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text.includes("playwright_smoke"), false);
});

test("MockResponse converts streaming tool call deltas into Responses function_call events", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  const added = events.find((event) => event.type === "response.output_item.added" && event.item.type === "function_call");
  assert.equal(added.item.call_id, "call_1");
  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  assert.equal(argsDone.name, "read_file");
  assert.equal(argsDone.arguments, "{\"path\":\"README.md\"}");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].type, "function_call");
  assert.equal(completed.response.output[0].arguments, "{\"path\":\"README.md\"}");
});

test("MockResponse keeps distinct output indexes for mixed text and tool call streams", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"I will inspect that."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\""}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"package.json\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  const messageAdded = events.find((event) => event.type === "response.output_item.added" && event.item.type === "message");
  const toolAdded = events.find((event) => event.type === "response.output_item.added" && event.item.type === "function_call");
  const textDone = events.find((event) => event.type === "response.output_text.done");
  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  assert.equal(messageAdded.output_index, 0);
  assert.equal(toolAdded.output_index, 1);
  assert.equal(textDone.output_index, 0);
  assert.equal(argsDone.output_index, 1);

  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(completed.response.output[0].content[0].text, "I will inspect that.");
  assert.equal(completed.response.output[1].arguments, "{\"file_path\":\"package.json\"}");
});

test("MockResponse suppresses mixed visible text for Codex when streaming tool calls", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
    { client: "codex" },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"Need plan skill before implementation."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\""}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"echo test\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  assert.equal(events.some((event) => event.type === "response.output_text.delta"), false);
  assert.equal(events.some((event) => event.type === "response.output_text.done"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["function_call"]);
  assert.equal(completed.response.output[0].arguments, "{\"cmd\":\"echo test\"}");
});

test("MockResponse end is idempotent after routed streams close internally", () => {
  const events = [];
  let doneCalls = 0;
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => { doneCalls += 1; },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();
  res.end();

  assert.equal(doneCalls, 1);
  assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
});

test("mergeHistory trims long Responses conversations even when a system message is pinned first", () => {
  const conversationHistory = [{ role: "system", content: "System rules." }];
  for (let i = 0; i < 420; i += 1) {
    conversationHistory.push({ role: "user", content: `message ${i}` });
  }

  const merged = responses.mergeHistory(
    {
      messages: [{ role: "user", content: "latest turn" }],
    },
    conversationHistory,
  );

  assert.equal(merged.length, 400);
  assert.equal(merged[0].role, "system");
  assert.equal(merged[1].content, "message 22");
  assert.equal(merged.at(-1).content, "latest turn");
});

test("rememberResponseHistory trims oversized previous_response snapshots", () => {
  const messages = [{ role: "system", content: "System rules." }];
  for (let i = 0; i < 450; i += 1) {
    messages.push({ role: "tool", content: `tool output ${i}: ${"x".repeat(2000)}` });
  }

  responses.rememberResponseHistory("resp_trim_test", messages, {
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
    tool_choice: "required",
  });

  const stored = responses.responseContextForPreviousResponse({ previous_response_id: "resp_trim_test" });
  assert.ok(stored);
  assert.equal(stored.messages[0].role, "system");
  assert.ok(stored.messages.length <= 400);
  const totalChars = stored.messages.reduce((sum, message) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    return sum + content.length;
  }, 0);
  assert.ok(totalChars <= 260000);
  assert.equal(stored.tool_choice, "required");
});

test("handleResponsesHTTP ignores duplicate internal stream closes", async () => {
  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end();
      res.end();
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    { headers: { accept: "text/event-stream" } },
    res,
    JSON.stringify({ model: "gpt-5.4", stream: true, input: "hi" }),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.endCalls, 1);
  assert.equal((res.body.match(/response.completed/g) || []).length, 1);
});

test("handleResponsesHTTP sends translated Responses requests as internal proxy traffic", async () => {
  let capturedReq;
  let capturedOptions;
  responses.init({
    handleChatCompletion: async (req, res, options) => {
      capturedReq = req;
      capturedOptions = options;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_1",
        model: "auto-coding",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    {
      headers: {
        accept: "application/json",
        "user-agent": "Codex Desktop/0.136.0-alpha.2",
        "openai-beta": "responses_websockets=2026-02-06",
      },
    },
    res,
    JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      previous_response_id: "resp_1",
      input: "continue",
      tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
    }),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(capturedOptions.internal, true);
  assert.equal(capturedReq._llmProxyClient, "codex");
  assert.equal(capturedReq._llmProxyCapabilityContract.runtime.surface, "codex");
  assert.equal(capturedReq._llmProxyCapabilityContract.runtime.toolDialect.previousResponseToolContext, true);
  assert.deepEqual(capturedReq._llmProxyCapabilityContract.capabilities.subagents, ["spawn_agent"]);
});

test("handleResponsesHTTP keeps Codex loop alive by returning function_call after hidden continuation", async () => {
  const originalProviders = state.PROVIDERS;
  const originalGroups = state.GROUPS;
  const originalRouteNativeStream = providerAdapters.routeNativeStream;
  const originalLog = state.log;
  const originalWriteFileSync = fs.writeFileSync;
  const originalScores = state.scores;
  const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
  const originalMaxRetries = process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES;
  const calls = [];
  const logs = [];

  try {
    state.PROVIDERS = [{
      name: "Responses-Native-Loop",
      model: "windsurf/responses-native-loop",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
    }];
    state.GROUPS = { "auto-coding": "coding" };
    state.scores = {};
    state.log = (message) => logs.push(String(message));
    fs.writeFileSync = () => {};
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES = "3";
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens: () => {},
    });
    responses.init({ handleChatCompletion: routing.handleChatCompletion });

    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((message) => message.role === "user") || [];
      calls.push({
        provider: provider.name,
        userCount: userMessages.length,
        lastUser: userMessages.at(-1)?.content,
      });

      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: [
          "[5/N] Checking the identity provider route for membership state.",
          "Next step: inspect the membership API response and rerun Playwright.",
        ].join("\n") }, finish_reason: null }] })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }

      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_account_api",
              type: "function",
              function: {
                name: "exec_command",
                arguments: "{\"cmd\":\"curl -s http://localhost:5173/api/user/memberships\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };

    const res = new FakeSseResponse();
    await responses.handleResponsesHTTP(
      { headers: { accept: "text/event-stream" } },
      res,
      JSON.stringify({
        model: "auto-coding",
        stream: true,
        input: [
          { role: "user", content: "Continue fixing the identity provider route and verify it." },
          { type: "function_call", call_id: "call_prev", name: "exec_command", arguments: "{\"cmd\":\"node e2e_membership_test.js\"}" },
          { type: "function_call_output", call_id: "call_prev", output: "[4/N] Subscriptions tab loaded. No active membership card displayed." },
        ],
        tools: [{
          type: "function",
          name: "exec_command",
          parameters: {
            type: "object",
            required: ["cmd"],
            properties: { cmd: { type: "string" } },
            additionalProperties: false,
          },
        }],
      }),
    );

    const events = parseSseEvents(res.body);
    const completed = events.find((event) => event.type === "response.completed");
    const output = completed?.response?.output || [];

    assert.equal(res.statusCode, 200);
    assert.equal(res.endCalls, 1);
    assert.equal(res.body.includes("Checking the identity provider route"), false);
    assert.deepEqual(calls, [
      {
        provider: "Responses-Native-Loop",
        userCount: 1,
        lastUser: "Continue fixing the identity provider route and verify it.",
      },
      {
        provider: "Responses-Native-Loop",
        userCount: 2,
        lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
      },
    ]);
    assert.deepEqual(output.map((item) => item.type), ["function_call"]);
    assert.equal(output[0].name, "exec_command");
    assert.equal(output[0].arguments, "{\"cmd\":\"curl -s http://localhost:5173/api/user/memberships\"}");
    assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Responses-Native-Loop .*output=action_prelude.*action=hidden_continue/);
    assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Responses-Native-Loop retry=1/);
  } finally {
    state.PROVIDERS = originalProviders;
    state.GROUPS = originalGroups;
    state.scores = originalScores;
    state.log = originalLog;
    providerAdapters.routeNativeStream = originalRouteNativeStream;
    fs.writeFileSync = originalWriteFileSync;
    if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
    else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
    if (originalMaxRetries === undefined) delete process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES;
    else process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES = originalMaxRetries;
    routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
  }
});

test("handleResponsesHTTP returns JSON Responses output for non-streaming OpenAI SDK callers", async () => {
  const schema = {
    type: "object",
    properties: { facts: { type: "array", items: { type: "string" } } },
    required: ["facts"],
    additionalProperties: false,
  };
  let capturedReq = null;
  responses.init({
    handleChatCompletion: async (req, res) => {
      capturedReq = req;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 1779437100,
        model: req.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "{\"facts\":[\"Graphiti uses proxy\"]}" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [
        { role: "system", content: "Extract facts." },
        { role: "user", content: [{ type: "text", text: "Use local proxy." }] },
      ],
      text: { format: { type: "json_schema", name: "GraphitiFacts", schema, strict: true } },
    }),
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /application\/json/);
  assert.equal(capturedReq.stream, false);
  assert.deepEqual(capturedReq.messages, [
    { role: "system", content: "Extract facts." },
    { role: "user", content: "Use local proxy." },
  ]);
  assert.deepEqual(capturedReq.response_format, {
    type: "json_schema",
    json_schema: { name: "GraphitiFacts", schema, strict: true },
  });

  const body = JSON.parse(res.body);
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.output[0].type, "message");
  assert.equal(body.output[0].content[0].type, "output_text");
  assert.equal(body.output[0].content[0].text, "{\"facts\":[\"Graphiti uses proxy\"]}");
  assert.deepEqual(body.usage, { input_tokens: 7, output_tokens: 5, total_tokens: 12 });
});

test("handleResponsesHTTP suppresses mixed assistant text when Codex JSON response contains tool calls", async () => {
  const captured = [];
  responses.init({
    handleChatCompletion: async (req, res) => {
      captured.push(JSON.parse(JSON.stringify(req)));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_codex_tool",
        object: "chat.completion",
        created: 1779437101,
        model: req.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Use the known login creds, then run the Playwright flow.",
            tool_calls: [{
              id: "call_exec",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"echo test\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    },
  });

  const makeRes = () => ({
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  });

  const first = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex/1.0" } },
    first,
    JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: "Continue debugging login and run the next tool step." }],
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      tool_choice: "auto",
    }),
  );

  const firstBody = JSON.parse(first.body);
  const functionCall = firstBody.output.find((item) => item.type === "function_call");
  assert.equal(first.statusCode, 200);
  assert.equal(firstBody.output_text, "");
  assert.deepEqual(firstBody.output.map((item) => item.type), ["function_call"]);
  assert.equal(functionCall.name, "exec_command");
  assert.equal(functionCall.arguments, "{\"cmd\":\"echo test\"}");

  const second = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex/1.0" } },
    second,
    JSON.stringify({
      model: "gpt-5.4",
      previous_response_id: firstBody.id,
      input: [{ type: "function_call_output", call_id: functionCall.call_id, output: "ok" }],
    }),
  );

  assert.equal(second.statusCode, 200);
  const replay = captured[1].messages;
  const assistantReplay = replay.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_exec");
  assert.equal(assistantReplay.content, null);
  assert.equal(assistantReplay.tool_calls[0].function.name, "exec_command");
});

test("handleResponsesHTTP replays previous_response_id history for tool outputs", async () => {
  const captured = [];
  responses.init({
    handleChatCompletion: async (req, res) => {
      captured.push(JSON.parse(JSON.stringify(req)));
      res.writeHead(200, { "Content-Type": "application/json" });
      if (captured.length === 1) {
        res.end(JSON.stringify({
          id: "chatcmpl_tool",
          object: "chat.completion",
          created: 1779437101,
          model: req.model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_read",
                type: "function",
                function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "chatcmpl_done",
        object: "chat.completion",
        created: 1779437102,
        model: req.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Read result accepted." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      }));
    },
  });

  const makeRes = () => ({
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  });

  const first = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    first,
    JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: "Read package.json." }],
      tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      tool_choice: "required",
    }),
  );
  const firstBody = JSON.parse(first.body);
  const callId = firstBody.output.find((item) => item.type === "function_call").call_id;

  const second = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    second,
    JSON.stringify({
      model: "gpt-5.4",
      previous_response_id: firstBody.id,
      input: [{ type: "function_call_output", call_id: callId, output: "{\"name\":\"llm-proxy\"}" }],
    }),
  );

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(captured[0].tool_choice, "required");
  assert.deepEqual(captured[1].tools, [
    { type: "function", function: { name: "Read", parameters: { type: "object" } } },
  ]);
  assert.equal(captured[1].tool_choice, "required");
  const replay = captured[1].messages;
  const assistantIndex = replay.findIndex((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_read");
  const toolIndex = replay.findIndex((message) => message.role === "tool" && message.tool_call_id === "call_read");
  assert.equal(assistantIndex >= 0, true);
  assert.equal(toolIndex > assistantIndex, true);
});

test("handleResponsesHTTP repairs structured JSON output to match requested schema", async () => {
  const schema = {
    type: "object",
    properties: {
      extracted_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            entity_type_id: { type: "integer" },
          },
          required: ["name", "entity_type_id"],
          additionalProperties: false,
        },
      },
    },
    required: ["extracted_entities"],
    additionalProperties: false,
  };

  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_schema",
        object: "chat.completion",
        created: 1779437200,
        model: "auto-sm",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "LLM_PROXY_TASK_DIFFICULTY level=2 effort=low speed=5 reason=entity_extraction\n\n[{\"entity_name\":\"Graphiti\",\"entity_type_id\":0,\"extra\":\"drop\"}]",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [{ role: "user", content: "Extract entities." }],
      text: { format: { type: "json_schema", name: "ExtractedEntities", schema, strict: true } },
    }),
  );

  const body = JSON.parse(res.body);
  assert.equal(body.output[0].content[0].text, "{\"extracted_entities\":[{\"name\":\"Graphiti\",\"entity_type_id\":0}]}");
});

test("handleResponsesHTTP extracts structured entities from bullet text when JSON is missing", async () => {
  const schema = {
    type: "object",
    properties: {
      extracted_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            entity_type_id: { type: "integer" },
          },
          required: ["name", "entity_type_id"],
          additionalProperties: false,
        },
      },
    },
    required: ["extracted_entities"],
    additionalProperties: false,
  };

  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Entities:\n- Graphiti MCP (entity_type_id=0)\n- local hash embeddings (entity_type_id=0)",
            },
            finish_reason: "stop",
          },
        ],
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [{ role: "user", content: "Extract entities." }],
      text: { format: { type: "json_schema", name: "ExtractedEntities", schema, strict: true } },
    }),
  );

  const body = JSON.parse(res.body);
  assert.equal(body.output[0].content[0].text, "{\"extracted_entities\":[{\"name\":\"Graphiti MCP\",\"entity_type_id\":0},{\"name\":\"local hash embeddings\",\"entity_type_id\":0}]}");
});

test("handleResponsesHTTP falls back to a minimal schema object when structured text is unparseable", async () => {
  const schema = {
    type: "object",
    properties: {
      summarized_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            summary: { type: "string" },
          },
          required: ["name", "summary"],
          additionalProperties: false,
        },
      },
    },
    required: ["summarized_entities"],
    additionalProperties: false,
  };

  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Graphiti MCP is an optional semantic sidecar.",
            },
            finish_reason: "stop",
          },
        ],
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [{ role: "user", content: "Summarize entities." }],
      text: { format: { type: "json_schema", name: "SummarizedEntities", schema, strict: true } },
    }),
  );

  const body = JSON.parse(res.body);
  assert.equal(body.output[0].content[0].text, "{\"summarized_entities\":[]}");
});
