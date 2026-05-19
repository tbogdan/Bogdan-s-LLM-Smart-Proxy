"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const transforms = require("../lib/transforms");
const state = require("../lib/state");

const provider = {
  name: "Codex-Test",
  model: "gpt-5.3-codex",
  url: "http://codex.local/v1/chat/completions",
  key: "test",
  caps: ["tools", "coding"],
  context: 200000,
  tier: 1,
};

test("transformRequest sanitizes tool schemas and tool call history for provider compatibility", () => {
  const request = {
    model: "auto-coding",
    parallel_tool_calls: true,
    tools: [
      {
        type: "function",
        function: {
          name: "bad tool name!",
          strict: true,
          parameters: { type: "object" },
        },
      },
    ],
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Use the tool." },
      {
        role: "assistant",
        content: "Calling the tool now.",
        tool_calls: [
          {
            id: "call_with_symbols_and_too_much_length",
            type: "function",
            function: { name: "bad tool name!", arguments: "{\"x\":1}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_with_symbols_and_too_much_length", content: "ok" },
      { role: "final", content: "invalid role" },
      { role: "user", content: "Continue." },
    ],
  };

  const transformed = transforms.transformRequest(provider, request);
  const toolCall = transformed.messages.find((m) => m.role === "assistant" && m.tool_calls)?.tool_calls[0];
  const toolResult = transformed.messages.find((m) => m.role === "tool");

  assert.equal(transformed.parallel_tool_calls, undefined);
  assert.equal(transformed.tools[0].function.name, "bad_tool_name_");
  assert.equal(transformed.tools[0].function.strict, undefined);
  assert.match(toolCall.id, /^[a-zA-Z0-9]{9}$/);
  assert.equal(toolResult.tool_call_id, toolCall.id);
  assert.equal(transformed.messages.some((m) => m.role === "final"), false);
  assert.equal(transformed.messages.find((m) => m.role === "assistant" && m.tool_calls).content, null);
  assert.equal(transformed.messages.some((m, i, arr) => m.role === "tool" && arr[i + 1]?.role === "user"), false);
});

test("detectStalling catches planning-only cognitive stalls", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "This is a massive task and there are many next steps that will be needed. I probably need to plan more before changing files, and subsequent turns will implement the pieces.",
        },
      },
    ],
  });

  assert.equal(transforms.detectStalling(body), true);
});

test("detectUseCase requests stronger routing after recent complexity stalls", () => {
  const result = transforms.detectUseCase([
    { role: "system", content: "You are a software engineering agent." },
    { role: "user", content: "Implement the refactor." },
    {
      role: "assistant",
      content: "This is a complex implementation that requires more planning and should be broken down into smaller tasks before doing any code.",
    },
  ], { tools: [{ type: "function", function: { name: "edit" } }] });

  assert.equal(result.needsUpgrade, true);
});
