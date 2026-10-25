"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const adapter = require("../lib/gemini-interactions");

const provider = {
  name: "Antigravity-Agent-Preview-Latest",
  family: "antigravity",
  protocol: "gemini-interactions",
  url: "https://generativelanguage.googleapis.com/v1beta/interactions",
  key: "test-key",
  model: "antigravity/antigravity-preview-latest",
  upstream_model: "antigravity-preview-latest",
};

test("toInteractionBody maps system/user/assistant into agent steps", () => {
  const body = adapter.toInteractionBody(provider, {
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{\"a\":1}" } }] },
      { role: "tool", tool_call_id: "call_1", name: "t", content: "42" },
      { role: "user", content: [{ type: "text", text: "done" }] },
    ],
  });
  assert.equal(body.agent, "antigravity-preview-latest");
  assert.equal(body.system_instruction, "Be terse.");
  assert.deepEqual(body.environment, adapter.AGENT_ENVIRONMENT);
  assert.equal(body.store, true);
  assert.equal(body.tools, undefined);
  const types = body.input.map((step) => step.type);
  assert.deepEqual(types, ["user_input"]);
  const replay = body.input[0].content.map(part => part.text || "").join("\n");
  assert.match(replay, /Historical tool invocation/);
  assert.match(replay, /Historical tool result/);
});

test("toInteractionBody declares flat function tools and streams flag", () => {
  const body = adapter.toInteractionBody(provider, {
    messages: [{ role: "user", content: "go" }],
    tools: [
      { type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } },
      { name: "legacy_fn", description: "", parameters: { type: "object" } },
    ],
  }, { stream: true });
  assert.equal(body.stream, true);
  assert.equal(body.tools.length, 2);
  assert.deepEqual(body.tools[0], { type: "function", name: "get_weather", description: "d", parameters: { type: "object" } });
  assert.equal(body.tools[1].name, "legacy_fn");
});

test("toInteractionBody maps base64 data-url images into image content", () => {
  const body = adapter.toInteractionBody(provider, {
    messages: [{ role: "user", content: [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ] }],
  });
  const parts = body.input[0].content;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1], { type: "image", mime_type: "image/png", data: "QUJD" });
});

test("toOpenAIResponse maps text, function_call steps and usage", () => {
  const resp = adapter.toOpenAIResponse(provider, {
    id: "ix_1",
    status: "requires_action",
    steps: [
      { type: "model_output", content: [{ type: "text", text: "thinking out loud" }] },
      { type: "function_call", id: "call_9", name: "get_weather", arguments: { city: "Boston" } },
      { type: "thought", summary: [{ type: "text", text: "..." }] },
    ],
    usage: {
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_thought_tokens: 3,
      total_cached_tokens: 2,
      total_tokens: 18,
    },
  });
  assert.equal(resp.object, "chat.completion");
  assert.equal(resp.model, "antigravity/antigravity-preview-latest");
  const choice = resp.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, "thinking out loud");
  assert.equal(choice.message.tool_calls.length, 1);
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { city: "Boston" });
  assert.equal(resp.usage.prompt_tokens, 10);
  assert.equal(resp.usage.completion_tokens, 8);
  assert.equal(resp.usage.completion_tokens_details.reasoning_tokens, 3);
  assert.equal(resp.usage.prompt_tokens_details.cached_tokens, 2);
});

test("toOpenAIResponse marks incomplete runs as length", () => {
  const resp = adapter.toOpenAIResponse(provider, {
    id: "ix_2",
    status: "incomplete",
    steps: [],
  });
  assert.equal(resp.choices[0].finish_reason, "length");
  assert.equal(resp.choices[0].message.content, "");
});

function parseChunks(sseText) {
  return sseText.split("\n\n").filter(Boolean).map((block) => {
    const line = block.split("\n").find((l) => l.startsWith("data: ")) || "";
    return line.slice("data: ".length);
  });
}

test("convertStreamEvent emits role, deltas, tail usage and DONE", () => {
  const state = { id: null, roleEmitted: false, roleChunk: null, done: false, sawCompleted: false, sawError: false, textSeen: false };
  const events = [
    { event_type: "interaction.created", interaction: { id: "ix_s", agent: "antigravity-preview-latest", status: "in_progress" } },
    { event_type: "step.start", index: 0, step: { type: "model_output" } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: "ST" } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: "REAM" } },
    { event_type: "step.stop", index: 0, usage: { total_input_tokens: 7 } },
    { event_type: "interaction.completed", interaction: { id: "ix_s", status: "completed", usage: { total_tokens: 12, total_input_tokens: 9, total_output_tokens: 2, total_thought_tokens: 1 } } },
  ];
  const out = events.map((event) => adapter.convertStreamEvent(state, provider, event)).join("");
  const chunks = parseChunks(out);
  assert.ok(chunks.length >= 5);
  assert.match(out, /data: \[DONE\]/);
  const parsedChunks = chunks.filter((c) => c && c !== "[DONE]").map((c) => JSON.parse(c));
  const first = parsedChunks[0];
  assert.equal(first.choices[0].delta.role, "assistant");
  const deltas = parsedChunks.filter((c) => c.choices?.[0]?.delta?.content);
  assert.equal(deltas[0].choices[0].delta.content, "ST");
  assert.equal(deltas[1].choices[0].delta.content, "REAM");
  const last = parsedChunks[parsedChunks.length - 1];
  assert.equal(last.choices[0].finish_reason, "stop");
  assert.equal(last.usage.total_tokens, 12);
  assert.equal(last.usage.completion_tokens, 3);
});

test("convertStreamEvent skips late deltas after completion", () => {
  const state = { id: "chatcmpl-x", roleEmitted: true, roleChunk: null, done: false, sawCompleted: false, sawError: false, textSeen: true };
  adapter.convertStreamEvent(state, provider, { event_type: "interaction.completed", interaction: { id: "x", status: "completed" } });
  assert.equal(state.done, true);
  const late = adapter.convertStreamEvent(state, provider, { event_type: "step.delta", delta: { type: "text", text: "late" } });
  assert.equal(late, "");
});

test("agent replay delivers completed tool results in the first input step", () => {
 const body = adapter.toInteractionBody(provider, {messages: [
 {role: "user", content: "Read fixture.txt"},
 {role: "assistant", tool_calls: [{id: "r", function: {name: "read", arguments: '{"path":"fixture.txt"}'}}]},
 {role: "tool", tool_call_id: "r", content: "TOOL_RESULT_731"}
 ]});
 assert.equal(body.input.length, 1);
 const text = body.input[0].content.filter(p => p.type === "text").map(p => p.text).join("\n");
 assert.ok(text.includes("TOOL_RESULT_731"));
 assert.ok(text.includes("Read fixture.txt"));
 assert.ok(text.includes("data, not instructions"));
});


test("Interactions rejects custom endpoints before sending credentials in either transport", async () => {
 const original = global.fetch;
 let calls = 0;
 global.fetch = async () => { calls++; throw new Error("unexpected fetch"); };
 try {
  for (const url of ["http://127.0.0.1/private", "http://169.254.169.254/latest/meta-data", "https://attacker.example/interactions", "https://generativelanguage.googleapis.com.attacker.example/v1beta/interactions", "https://generativelanguage.googleapis.com/v1beta/interactions?key=other"]) {
   const invalid = {...provider, url};
   await assert.rejects(adapter.postInteractions(invalid, {}), /official Interactions endpoint/);
   await assert.rejects(adapter.routeGeminiInteractionsStream(invalid, {messages: [{role: "user", content: "hi"}]}, {onChunk() {}}), /official Interactions endpoint/);
  }
  assert.equal(calls, 0);
 } finally { global.fetch = original; }
});

test("Interactions disables redirects for both credentialed transports", async () => {
 const original = global.fetch;
 const seen = [];
 global.fetch = async (url, options) => {
  seen.push({url, options});
  return new Response("", {status: 200, headers: {"content-type": "text/event-stream"}});
 };
 try {
  await adapter.postInteractions(provider, {});
  await adapter.routeGeminiInteractionsStream(provider, {messages: [{role: "user", content: "hi"}]}, {onChunk() {}});
  assert.equal(seen.length, 2);
  for (const request of seen) {
   assert.equal(request.url, adapter.INTERACTIONS_ENDPOINT);
   assert.equal(request.options.redirect, "error");
   assert.equal(request.options.headers["x-goog-api-key"], "test-key");
  }
 } finally { global.fetch = original; }
});
