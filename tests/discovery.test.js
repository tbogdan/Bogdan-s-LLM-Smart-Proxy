"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

test("providersFromEndpointModels skips malformed model entries", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "codex-key",
  })[0];

  const providers = discovery.providersFromEndpointModels(endpoint, [
    null,
    "gpt-5",
    {},
    { id: "" },
    { name: "   " },
    { id: "gpt-5.4" },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["codex/gpt-5.4"]);
  assert.equal(providers.some((provider) => provider.model === "codex/undefined"), false);
});

test("providersFromEndpointModels maps Windsurf through windsurfCloud.buildWindsurfProviders", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "windsurf-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [{ id: "ignored" }]);

  assert.deepEqual(providers, windsurfCloud.buildWindsurfProviders());
});

test("shouldProbeSeedProvider skips sentinel adapter providers with credentials", () => {
  assert.equal(
    discovery.shouldProbeSeedProvider({ family: "windsurf", protocol: "windsurf", url: "windsurf", key_env: "WINDSURF_API_KEY" }, { WINDSURF_API_KEY: "ws-key" }),
    false,
  );
  assert.equal(
    discovery.shouldProbeSeedProvider({ family: "claude", protocol: "anthropic", url: "claude", key_env: "CLAUDE_CODE_OAUTH_TOKEN" }, { CLAUDE_CODE_OAUTH_TOKEN: "claude-key" }),
    false,
  );
  assert.equal(
    discovery.shouldProbeSeedProvider({ family: "codex", protocol: "openai", url: "http://codex-proxy:10531/v1/chat/completions", key_env: "CODEX_API_KEY" }, { CODEX_API_KEY: "codex-key" }),
    true,
  );
});

test("mergeProvidersConfig drops unsupported existing providers but keeps supported entries", () => {
  const seed = {
    providers: [
      {
        name: "Claude-Seed",
        family: "claude",
        protocol: "anthropic",
        model: "claude/claude-sonnet-4-5",
        url: "claude",
        key_env: "CLAUDE_CODE_OAUTH_TOKEN",
        headers: {},
      },
    ],
    groups: { "auto-text": "text" },
  };
  const existing = {
    providers: [
      { name: "Groq-Llama", model: "llama-3.3-70b-versatile", url: "https://api.groq.com/openai/v1/chat/completions" },
      { name: "OpenRouter-GPT", family: "openrouter", model: "openrouter/gpt-4o", protocol: "openai" },
      { name: "Codex-Existing", family: "codex", protocol: "openai", model: "codex/gpt-5.4", alive: true, last_tested: "2026-01-01T00:00:00.000Z" },
      { name: "Claude-Seed", family: "claude", protocol: "anthropic", model: "claude/claude-sonnet-4-5", alive: false, last_tested: "2026-01-02T00:00:00.000Z" },
    ],
  };

  const merged = discovery.mergeProvidersConfig(seed, [], existing);

  assert.deepEqual(merged.providers.map((provider) => provider.name).sort(), ["Claude-Seed", "Codex-Existing"]);
  assert.equal(merged.providers.find((provider) => provider.name === "Claude-Seed").alive, false);
  assert.equal(merged.providers.find((provider) => provider.name === "Codex-Existing").last_tested, "2026-01-01T00:00:00.000Z");
});

test("requiring llm-discovery does not create DATA_DIR", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-discovery-import-"));
  const dataDir = path.join(tempRoot, "data");
  const result = spawnSync(process.execPath, ["-e", 'require("./llm-discovery")'], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(dataDir), false);
});
