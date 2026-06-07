"use strict";

const DEFAULT_MODEL = "llm-proxy-hash-embedding-1536";
const DEFAULT_DIMENSIONS = 1536;

function toPositiveInt(value, fallback, min = 16, max = 4096) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeEmbeddingInput(input) {
  if (Array.isArray(input)) return input.map((item) => (item == null ? "" : String(item)));
  return [input == null ? "" : String(input)];
}

function estimateTokens(text) {
  const value = String(text || "").trim();
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function embeddingFeatures(text) {
  const normalized = String(text || "").toLowerCase();
  const words = normalized.match(/[a-z0-9_.:/-]+/g) || [];
  const features = [];
  for (const word of words) {
    features.push(`w:${word}`);
    if (word.length >= 5) {
      for (let i = 0; i <= word.length - 3; i += 1) {
        features.push(`c:${word.slice(i, i + 3)}`);
      }
    }
  }
  if (features.length === 0) features.push("empty");
  return features;
}

function hashTextToEmbedding(text, dimensions = DEFAULT_DIMENSIONS) {
  const dims = toPositiveInt(dimensions, DEFAULT_DIMENSIONS);
  const vector = new Array(dims).fill(0);
  const features = embeddingFeatures(text);
  for (const feature of features) {
    const h1 = fnv1a(feature);
    const h2 = fnv1a(feature, 0x12345678);
    const index = h1 % dims;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function handleEmbeddingsRequest(reqBody = {}, env = process.env) {
  const dimensions = toPositiveInt(
    reqBody.dimensions || env.LLM_PROXY_EMBEDDING_DIMENSIONS || env.GRAPHITI_MCP_EMBEDDING_DIMENSIONS,
    DEFAULT_DIMENSIONS,
  );
  const model = reqBody.model || env.LLM_PROXY_EMBEDDING_MODEL || DEFAULT_MODEL;
  const inputs = normalizeEmbeddingInput(reqBody.input);
  const data = inputs.map((input, index) => ({
    object: "embedding",
    embedding: hashTextToEmbedding(input, dimensions),
    index,
  }));
  const promptTokens = inputs.reduce((sum, input) => sum + estimateTokens(input), 0);
  return {
    object: "list",
    data,
    model,
    usage: {
      prompt_tokens: promptTokens,
      total_tokens: promptTokens,
    },
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_DIMENSIONS,
  estimateTokens,
  fnv1a,
  handleEmbeddingsRequest,
  hashTextToEmbedding,
  normalizeEmbeddingInput,
};
