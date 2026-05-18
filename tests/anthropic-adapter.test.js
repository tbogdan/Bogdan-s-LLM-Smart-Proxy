"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const anthropic = require("../lib/anthropic-adapter");

test("converts OpenAI chat request to Anthropic Messages request", () => {
  const provider = { upstream_model: "claude-sonnet-4-5" };
  const input = {
    model: "claude/claude-sonnet-4-5",
    messages: [
      { role: "system", content: "System A" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read file", parameters: { type: "object" } } }],
    max_tokens: 1234,
    temperature: 0.2,
    stream: true,
  };

  const output = anthropic.toAnthropicRequest(provider, input);

  assert.equal(output.model, "claude-sonnet-4-5");
  assert.equal(output.system, "System A");
  assert.equal(output.max_tokens, 1234);
  assert.equal(output.temperature, 0.2);
  assert.equal(output.stream, true);
  assert.deepEqual(output.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(output.tools[0].name, "read_file");
});

test("converts Anthropic response to OpenAI chat completion", () => {
  const output = anthropic.toOpenAIResponse("claude/claude-sonnet-4-5", {
    id: "msg_123",
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [{ type: "text", text: "Hello there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  assert.equal(output.id, "chatcmpl-msg_123");
  assert.equal(output.model, "claude/claude-sonnet-4-5");
  assert.equal(output.choices[0].message.content, "Hello there");
  assert.equal(output.choices[0].finish_reason, "stop");
  assert.deepEqual(output.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test("builds Anthropic headers from OAuth token", () => {
  const headers = anthropic.buildHeaders({ key: "oauth-token" });
  assert.equal(headers.Authorization, "Bearer oauth-token");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
});
