"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const discovery = require("../llm-discovery");
const windsurfCloud = require("../lib/windsurf-cloud");

test("getEndpoints returns exactly enabled supported endpoints sorted by name", () => {
  const endpoints = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "ws-key",
    ENABLE_CLAUDE: "true",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "codex-key",
    GROQ_API_KEY: "old-groq",
    OPENROUTER_API_KEY: "old-openrouter",
    MISTRAL_API_KEY: "old-mistral",
    DEEPSEEK_API_KEY: "old-deepseek",
  });

  assert.deepEqual(endpoints.map((endpoint) => endpoint.name), ["Claude", "Codex", "Windsurf"]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.family), ["claude", "codex", "windsurf"]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.protocol), ["anthropic", "openai", "windsurf"]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.key_env), ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "WINDSURF_API_KEY"]);
});

test("getEndpoints ignores old provider keys without supported enable flags", () => {
  const endpoints = discovery.getEndpoints({
    GROQ_API_KEY: "old-groq",
    OPENROUTER_API_KEY: "old-openrouter",
    CEREBRAS_API_KEY: "old-cerebras",
    SAMBANOVA_API_KEY: "old-sambanova",
    NVIDIA_API_KEY: "old-nvidia",
    MISTRAL_API_KEY: "old-mistral",
    DEEPSEEK_API_KEY: "old-deepseek",
    OPENAI_API_KEY: "old-openai",
  });

  assert.deepEqual(endpoints, []);
});

test("loadSeed returns exactly scoped provider families and groups", () => {
  const seed = discovery.loadSeed();

  assert.deepEqual([...new Set(seed.providers.map((provider) => provider.family))].sort(), ["claude", "codex", "windsurf"]);
  assert.deepEqual(Object.keys(seed.groups).sort(), ["auto-coding", "auto-max", "auto-text", "auto-thinking", "auto-tools"]);

  for (const provider of seed.providers) {
    assert.match(provider.model, /^(windsurf|claude|codex)\//);
  }
});

test("providersFromEndpointModels maps Claude models to namespaced provider entries", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_CLAUDE: "true",
    ANTHROPIC_API_KEY: "anthropic-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [
    { id: "claude-sonnet-4-5", context_length: 200000 },
    { id: "claude-haiku-4-5", context_length: 200000 },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["claude/claude-sonnet-4-5", "claude/claude-haiku-4-5"]);
  assert.deepEqual(providers.map((provider) => provider.upstream_model), ["claude-sonnet-4-5", "claude-haiku-4-5"]);
  assert.equal(providers[0].name, "Claude-claudesonnet45");
  assert.equal(providers[0].family, "claude");
  assert.equal(providers[0].protocol, "anthropic");
  assert.equal(providers[0].key_env, "ANTHROPIC_API_KEY");
  assert.deepEqual(providers[0].headers, {});
  assert.equal(providers[0].alive, true);
  assert.equal(providers[0].seed, false);
  assert.equal(typeof providers[0].last_tested, "string");
});

test("providersFromEndpointModels maps Codex models to namespaced provider entries", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "codex-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [
    { id: "gpt-5.4", context_length: 200000 },
    { id: "gpt-5.4-mini", max_tokens: 200000 },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["codex/gpt-5.4", "codex/gpt-5.4-mini"]);
  assert.deepEqual(providers.map((provider) => provider.upstream_model), ["gpt-5.4", "gpt-5.4-mini"]);
  assert.equal(providers[0].name, "Codex-gpt54");
  assert.equal(providers[0].family, "codex");
  assert.equal(providers[0].protocol, "openai");
  assert.equal(providers[0].url, "http://codex-proxy:10531/v1/chat/completions");
});

test("providersFromEndpointModels maps Windsurf through windsurfCloud.buildWindsurfProviders", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "windsurf-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [{ id: "ignored" }]);

  assert.deepEqual(providers, windsurfCloud.buildWindsurfProviders());
});
