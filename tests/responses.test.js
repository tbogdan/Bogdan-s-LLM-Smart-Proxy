"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const responses = require("../lib/responses");

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
  res.write('data: {"choices":[{"delta":{"content":"effort=low speed=4"},"finish_reason":null}]}\n\n');
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
