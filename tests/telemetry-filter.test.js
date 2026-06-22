"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NON_STREAMING_TELEMETRY_KEYS,
  isStreamingTelemetryChunk,
  stripNonStreamingTelemetryFields,
} = require("../lib/telemetry-filter");

// ---------------------------------------------------------------------------
// isStreamingTelemetryChunk
// ---------------------------------------------------------------------------

test("isStreamingTelemetryChunk — returns false for non-SSE text", () => {
  assert.equal(isStreamingTelemetryChunk("hello world"), false);
  assert.equal(isStreamingTelemetryChunk(""), false);
  assert.equal(isStreamingTelemetryChunk(null), false);
  assert.equal(isStreamingTelemetryChunk(undefined), false);
});

test("isStreamingTelemetryChunk — returns false for SSE chunks without telemetry", () => {
  const normal = 'data: {"id":"cmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n';
  assert.equal(isStreamingTelemetryChunk(normal), false);
});

test("isStreamingTelemetryChunk — detects inference_id chunk (Fireworks)", () => {
  const chunk = 'data: {"inference_id":"inf-abc123","choices":[]}\n\n';
  assert.equal(isStreamingTelemetryChunk(chunk), true);
});

test("isStreamingTelemetryChunk — detects completion_tokens_per_sec chunk (Fireworks)", () => {
  const chunk = 'data: {"completion_tokens_per_sec":42.5,"choices":[]}\n\n';
  assert.equal(isStreamingTelemetryChunk(chunk), true);
});

test("isStreamingTelemetryChunk — detects producer chunk (routing node)", () => {
  const chunk = 'data: {"producer":"node-7","choices":[]}\n\n';
  assert.equal(isStreamingTelemetryChunk(chunk), true);
});

test("isStreamingTelemetryChunk — detects x_groq timing chunk without choices (Groq)", () => {
  const chunk = 'data: {"x_groq":{"id":"req_01","queue_time":0.003,"prompt_time":0.1}}\n\n';
  assert.equal(isStreamingTelemetryChunk(chunk), true);
});

test("isStreamingTelemetryChunk — does NOT strip x_groq chunk that also has choices", () => {
  // If a chunk has both x_groq and choices it carries inference content too
  const chunk = 'data: {"id":"cmpl-1","x_groq":{"id":"req_01"},"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n';
  assert.equal(isStreamingTelemetryChunk(chunk), false);
});

test("isStreamingTelemetryChunk — detects eval_duration chunk without choices (DeepSeek/Ollama)", () => {
  const chunk = 'data: {"eval_duration":1234567890,"eval_count":42}\n\n';
  assert.equal(isStreamingTelemetryChunk(chunk), true);
});

test("isStreamingTelemetryChunk — detects load_duration chunk without choices (Ollama)", () => {
  const chunk = 'data: {"load_duration":987654321,"total_duration":2000000000}\n\n';
  assert.equal(isStreamingTelemetryChunk(chunk), true);
});

test("isStreamingTelemetryChunk — returns false for malformed JSON in data field", () => {
  const chunk = "data: {not-valid-json}\n\n";
  assert.equal(isStreamingTelemetryChunk(chunk), false);
});

test("isStreamingTelemetryChunk — returns false for data: [DONE]", () => {
  assert.equal(isStreamingTelemetryChunk("data: [DONE]\n\n"), false);
});

// ---------------------------------------------------------------------------
// stripNonStreamingTelemetryFields
// ---------------------------------------------------------------------------

test("stripNonStreamingTelemetryFields — returns original if not JSON object", () => {
  assert.equal(stripNonStreamingTelemetryFields("not json"), "not json");
  assert.equal(stripNonStreamingTelemetryFields("[1,2,3]"), "[1,2,3]");
  assert.equal(stripNonStreamingTelemetryFields(""), "");
  assert.equal(stripNonStreamingTelemetryFields(null), null);
});

test("stripNonStreamingTelemetryFields — returns original if no telemetry keys", () => {
  const body = JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const result = stripNonStreamingTelemetryFields(body);
  assert.equal(result, body);
});

test("stripNonStreamingTelemetryFields — strips system_fingerprint (OpenAI)", () => {
  const body = JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o",
    system_fingerprint: "fp_abc123xyz",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "system_fingerprint"), false);
  assert.equal(parsed.id, "chatcmpl-1");
  assert.equal(parsed.choices.length, 1);
  assert.deepEqual(parsed.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("stripNonStreamingTelemetryFields — strips x_groq (Groq)", () => {
  const body = JSON.stringify({
    id: "chatcmpl-groq-1",
    object: "chat.completion",
    model: "llama3-70b",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    x_groq: { id: "req_abc", queue_time: 0.003, prompt_time: 0.12, completion_time: 0.07, total_time: 0.2 },
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "x_groq"), false);
  assert.equal(parsed.model, "llama3-70b");
  assert.equal(parsed.choices[0].message.content, "Hi");
});

test("stripNonStreamingTelemetryFields — strips inference_id (Fireworks)", () => {
  const body = JSON.stringify({
    id: "fw-1",
    object: "chat.completion",
    model: "fw-model",
    inference_id: "inf-xyz",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "inference_id"), false);
  assert.equal(parsed.choices[0].message.content, "ok");
});

test("stripNonStreamingTelemetryFields — strips service_tier", () => {
  const body = JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion",
    model: "gpt-4o-mini",
    service_tier: "default",
    choices: [{ index: 0, message: { role: "assistant", content: "Yes" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "service_tier"), false);
  assert.equal(parsed.id, "cmpl-1");
});

test("stripNonStreamingTelemetryFields — strips Ollama timing fields", () => {
  const body = JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "llama3",
    choices: [{ index: 0, message: { role: "assistant", content: "Sure" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    eval_count: 30,
    eval_duration: 1234567890,
    prompt_eval_count: 100,
    prompt_eval_duration: 987654321,
    total_duration: 2345678901,
    load_duration: 111222333,
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  for (const key of ["eval_count", "eval_duration", "prompt_eval_count", "prompt_eval_duration", "total_duration", "load_duration"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, key), false, `${key} should be stripped`);
  }
  assert.equal(parsed.choices[0].message.content, "Sure");
  assert.deepEqual(parsed.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
});

test("stripNonStreamingTelemetryFields — strips multiple telemetry keys at once", () => {
  const body = JSON.stringify({
    id: "cmpl-multi",
    object: "chat.completion",
    model: "mixed-provider",
    system_fingerprint: "fp_1",
    x_groq: { id: "req_1" },
    inference_id: "inf_1",
    service_tier: "scale",
    choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  for (const key of ["system_fingerprint", "x_groq", "inference_id", "service_tier"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, key), false, `${key} should be stripped`);
  }
  assert.equal(parsed.id, "cmpl-multi");
  assert.equal(parsed.choices[0].message.content, "Done");
  assert.equal(parsed.usage.total_tokens, 30);
});

test("stripNonStreamingTelemetryFields — preserves all inference fields", () => {
  const body = JSON.stringify({
    id: "cmpl-preserve",
    object: "chat.completion",
    created: 1717200000,
    model: "gpt-4o",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Preserved" },
      finish_reason: "stop",
      logprobs: null,
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    system_fingerprint: "should_be_removed",
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  assert.equal(parsed.id, "cmpl-preserve");
  assert.equal(parsed.object, "chat.completion");
  assert.equal(parsed.created, 1717200000);
  assert.equal(parsed.model, "gpt-4o");
  assert.equal(parsed.choices[0].message.content, "Preserved");
  assert.equal(parsed.usage.prompt_tokens, 100);
  assert.equal(parsed.usage.prompt_tokens_details.cached_tokens, 20);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "system_fingerprint"), false);
});

test("stripNonStreamingTelemetryFields — does not touch nested fields (only top-level)", () => {
  // inference_id nested inside choices should NOT be stripped
  const body = JSON.stringify({
    id: "cmpl-nested",
    object: "chat.completion",
    model: "test",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok", inference_id: "nested-should-stay" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
  const result = stripNonStreamingTelemetryFields(body);
  const parsed = JSON.parse(result);
  assert.equal(parsed.choices[0].message.inference_id, "nested-should-stay");
});

// ---------------------------------------------------------------------------
// NON_STREAMING_TELEMETRY_KEYS — set membership sanity check
// ---------------------------------------------------------------------------

test("NON_STREAMING_TELEMETRY_KEYS — contains expected provider-specific keys", () => {
  assert.equal(NON_STREAMING_TELEMETRY_KEYS.has("system_fingerprint"), true);
  assert.equal(NON_STREAMING_TELEMETRY_KEYS.has("x_groq"), true);
  assert.equal(NON_STREAMING_TELEMETRY_KEYS.has("inference_id"), true);
  assert.equal(NON_STREAMING_TELEMETRY_KEYS.has("service_tier"), true);
});

test("NON_STREAMING_TELEMETRY_KEYS — does NOT contain inference-essential fields", () => {
  for (const key of ["id", "object", "created", "model", "choices", "usage"]) {
    assert.equal(NON_STREAMING_TELEMETRY_KEYS.has(key), false, `${key} must not be in telemetry keys`);
  }
});
