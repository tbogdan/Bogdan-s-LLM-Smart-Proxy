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
