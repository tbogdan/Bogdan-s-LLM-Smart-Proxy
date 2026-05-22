"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  handleEmbeddingsRequest,
  hashTextToEmbedding,
  normalizeEmbeddingInput,
} = require("../lib/embeddings");

test("normalizeEmbeddingInput accepts strings and arrays", () => {
  assert.deepEqual(normalizeEmbeddingInput("hello"), ["hello"]);
  assert.deepEqual(normalizeEmbeddingInput(["hello", 42, null]), ["hello", "42", ""]);
});

test("hashTextToEmbedding returns deterministic normalized vectors", () => {
  const first = hashTextToEmbedding("Memory routing architecture", 64);
  const second = hashTextToEmbedding("Memory routing architecture", 64);

  assert.equal(first.length, 64);
  assert.deepEqual(first, second);
  const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.000001);
});

test("handleEmbeddingsRequest returns OpenAI-compatible embedding response", () => {
  const response = handleEmbeddingsRequest({
    model: "llm-proxy-hash-embedding-1536",
    input: ["memory graph", "routing proxy"],
  }, { LLM_PROXY_EMBEDDING_DIMENSIONS: "32" });

  assert.equal(response.object, "list");
  assert.equal(response.model, "llm-proxy-hash-embedding-1536");
  assert.equal(response.data.length, 2);
  assert.equal(response.data[0].object, "embedding");
  assert.equal(response.data[0].index, 0);
  assert.equal(response.data[0].embedding.length, 32);
  assert.equal(response.usage.total_tokens, response.usage.prompt_tokens);
  assert.ok(response.usage.prompt_tokens > 0);
});
