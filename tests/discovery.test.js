"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const discovery = require("../llm-discovery");
const copilotToken = require("../lib/copilot-token");
const windsurfCloud = require("../lib/windsurf-cloud");

const COPILOT_CLIENT_TEST_OPTIONS = {
  extensionVersion: "0.48.1",
  vscodeVersion: "1.121.0",
  sessionId: "session-123",
  machineId: "machine-123",
  deviceId: "device-123",
  interactionId: "interaction-123",
};

test("getEndpoints returns exactly enabled supported endpoints sorted by name", () => {
  const endpoints = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "ws-key",
    ENABLE_CLAUDE: "true",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ANTHROPIC_API_KEY: "platform-key",
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "codex-key",
    ENABLE_COPILOT: "true",
    COPILOT_GITHUB_TOKEN: "copilot-token",
    WINDSURF_MODELS: "windsurf/custom-model, explicit=explicit_uid",
    GROQ_API_KEY: "old-groq",
    OPENROUTER_API_KEY: "old-openrouter",
    MISTRAL_API_KEY: "old-mistral",
    DEEPSEEK_API_KEY: "old-deepseek",
  });

  assert.deepEqual(endpoints.map((endpoint) => endpoint.name), ["Claude", "Codex", "Copilot", "Windsurf"]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.family), ["claude", "codex", "copilot", "windsurf"]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.protocol), ["anthropic", "openai", "openai", "windsurf"]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.key_env), ["ANTHROPIC_API_KEY", "CODEX_API_KEY", "COPILOT_GITHUB_TOKEN", "WINDSURF_API_KEY"]);
  assert.equal(endpoints[0].headers["x-api-key"], "platform-key");
  assert.equal(endpoints[0].headers.Authorization, undefined);
  assert.equal(endpoints[2].chatUrl, "https://api.githubcopilot.com/chat/completions");
  assert.equal(endpoints[2].modelsUrl, null);
  assert.equal(endpoints[2].headers.Authorization, undefined);
  assert.deepEqual(endpoints[3].models.map((model) => model.id), ["windsurf/custom-model", "windsurf/explicit"]);
  assert.equal(endpoints[3].models[1].windsurf_model_uid, "explicit_uid");
});

test("getEndpoints falls back to Claude OAuth token when Console API key is absent", () => {
  const endpoints = discovery.getEndpoints({
    ENABLE_CLAUDE: "true",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
  });

  assert.equal(endpoints[0].key_env, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(endpoints[0].headers.Authorization, "Bearer claude-oauth");
  assert.equal(endpoints[0].headers["x-api-key"], undefined);
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

  assert.deepEqual([...new Set(seed.providers.map((provider) => provider.family))].sort(), ["claude", "codex", "copilot", "windsurf"]);
  assert.deepEqual(Object.keys(seed.groups).sort(), ["auto-assess", "auto-coding", "auto-max", "auto-sm", "auto-text", "auto-thinking", "auto-tools", "coding-sm"]);
  assert.deepEqual(
    Object.fromEntries(
      ["windsurf", "claude", "codex", "copilot"].map((family) => [
        family,
        seed.providers.filter((provider) => provider.family === family).length,
      ]),
    ),
    { windsurf: 101, claude: 9, codex: 6, copilot: 32 },
  );

  for (const provider of seed.providers) {
    assert.match(provider.model, /^(windsurf|claude|codex|copilot)\//);
  }

  for (const model of ["windsurf/gpt-5-5-low", "windsurf/private-9", "windsurf/deepseek-v4"]) {
    assert.equal(seed.providers.some((provider) => provider.model === model), true, `seed providers should include ${model}`);
  }
});

test("providersFromEndpointModels maps Claude models to namespaced provider entries", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_CLAUDE: "true",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ANTHROPIC_API_KEY: "anthropic-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [
    {
      id: "claude-sonnet-4-6",
      display_name: "Claude Sonnet 4.6",
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: {
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          max: { supported: true },
        },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
        code_execution: { supported: true },
        context_management: { supported: true, compact_20260112: { supported: true } },
      },
    },
    { id: "claude-haiku-4-5", max_input_tokens: 200000, max_tokens: 64000 },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["claude/claude-sonnet-4-6", "claude/claude-haiku-4-5"]);
  assert.deepEqual(providers.map((provider) => provider.upstream_model), ["claude-sonnet-4-6", "claude-haiku-4-5"]);
  assert.equal(providers[0].name, "Claude-claudesonnet46");
  assert.equal(providers[0].family, "claude");
  assert.equal(providers[0].protocol, "anthropic");
  assert.equal(providers[0].key_env, "ANTHROPIC_API_KEY");
  assert.deepEqual(providers[0].headers, {});
  assert.equal(providers[0].alive, true);
  assert.equal(providers[0].seed, false);
  assert.equal(typeof providers[0].last_tested, "string");
  assert.equal(providers[0].context, 1000000);
  assert.equal(providers[0].max_tokens, 128000);
  assert.equal(providers[0].display_name, "Claude Sonnet 4.6");
  assert.deepEqual(providers[0].supported_thinking_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(providers[0].supports_adaptive_thinking, true);
  assert.equal(providers[0].supports_code_execution, true);
  assert.equal(providers[0].supports_context_compaction, true);
  assert.equal(providers[0].cost_group, 3);
  assert.equal(providers[0].quality_group, 4);
  assert.equal(providers[0].speed_group, 4);
  assert.equal(providers[1].context, 200000);
});

test("providersFromEndpointModels maps Codex models to namespaced provider entries", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "codex-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [
    {
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      context_window: 272000,
      max_context_window: 272000,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      input_modalities: ["text", "image"],
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
    },
    { id: "gpt-5.4-mini", max_tokens: 200000, default_reasoning_level: "low" },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["codex/gpt-5.4", "codex/gpt-5.4-mini"]);
  assert.deepEqual(providers.map((provider) => provider.upstream_model), ["gpt-5.4", "gpt-5.4-mini"]);
  assert.equal(providers[0].name, "Codex-gpt54");
  assert.equal(providers[0].family, "codex");
  assert.equal(providers[0].protocol, "openai");
  assert.equal(providers[0].url, "http://codex-proxy:10531/v1/chat/completions");
  assert.equal(providers[0].context, 272000);
  assert.equal(providers[0].context_window, 272000);
  assert.equal(providers[0].max_context_window, 272000);
  assert.equal(providers[0].thinking_effort, "medium");
  assert.deepEqual(providers[0].supported_thinking_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(providers[0].supports_parallel_tool_calls, true);
  assert.equal(providers[0].supports_search_tool, true);
  assert.equal(providers[0].shell_type, "shell_command");
  assert.equal(providers[0].apply_patch_tool_type, "freeform");
  assert.equal(providers[0].cost_group, 3);
  assert.equal(providers[1].context, 200000);
  assert.equal(providers[1].thinking_effort, "low");
});

test("providersFromEndpointModels maps Copilot models to OpenAI-compatible provider entries", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_COPILOT: "true",
    COPILOT_GITHUB_TOKEN: "copilot-token",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [
    { id: "gpt-4.1", name: "GPT-4.1", context_length: 128000, billing: { multiplier: 0 } },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", context_length: 200000, billing: { multiplier: 1 } },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7", context_length: 200000, billing: { multiplier: 15 } },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["copilot/gpt-4.1", "copilot/claude-sonnet-4.6", "copilot/claude-opus-4.7"]);
  assert.equal(providers[0].name, "Copilot-gpt41");
  assert.equal(providers[0].family, "copilot");
  assert.equal(providers[0].protocol, "openai");
  assert.equal(providers[0].url, "https://api.githubcopilot.com/chat/completions");
  assert.equal(providers[0].key_env, "COPILOT_GITHUB_TOKEN");
  assert.equal(providers[0].context, 128000);
  assert.equal(providers[0].caps.includes("coding"), true);
  assert.equal(providers[0].caps.includes("tools"), true);
  assert.equal(providers[0].cost_multiplier, 0);
  assert.equal(providers[0].cost_group, 3);
  assert.equal(providers[1].cost_multiplier, 1);
  assert.equal(providers[1].cost_group, 3);
  assert.equal(providers[2].cost_multiplier, 15);
  assert.equal(providers[2].cost_group, 4);
});

test("discoverEndpointModels uses built-in Copilot model list without remote catalog by default", async () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_COPILOT: "true",
    COPILOT_GITHUB_TOKEN: "github-token",
  })[0];

  const result = await discovery.discoverEndpointModels(endpoint, {
    env: {
      COPILOT_GITHUB_TOKEN: "github-token",
    },
    requestJSONFn: async () => {
      throw new Error("Copilot token exchange should not run for default model list");
    },
    fetchJSONFn: async () => {
      throw new Error("Copilot model catalog should not be fetched by default");
    },
  });

  assert.equal(result.source, "configured");
  assert.equal(result.models.length, 32);
  assert.equal(result.models.some((model) => model.id === "gpt-4.1"), true);
  assert.equal(result.models.some((model) => model.id === "claude-sonnet-4.6"), true);
  assert.equal(result.models.some((model) => model.id === "gpt-5.4"), true);
  assert.equal(result.models.find((model) => model.id === "gpt-4.1").cost_multiplier, 0);
  assert.equal(result.models.find((model) => model.id === "claude-opus-4.7").cost_multiplier, 15);
});

test("discoverEndpointModels reads explicit Copilot model catalog URL with runtime VS Code headers", async () => {
  copilotToken.clearCopilotTokenCache();
  const endpoint = discovery.getEndpoints({
    ENABLE_COPILOT: "true",
    COPILOT_GITHUB_TOKEN: "github-token",
    COPILOT_MODELS_URL: "https://api.githubcopilot.com/models",
  })[0];
  let tokenRequests = 0;
  let modelCatalogHeaders = null;

  const result = await discovery.discoverEndpointModels(endpoint, {
    env: {
      COPILOT_GITHUB_TOKEN: "github-token",
    },
    requestJSONFn: async (url, headers) => {
      tokenRequests += 1;
      assert.equal(url, "https://api.github.com/copilot_internal/v2/token");
      assert.equal(headers.Authorization, "token github-token");
      assert.equal(headers["User-Agent"], "GitHubCopilotChat/0.48.1");
      assert.equal(headers["X-VSCode-User-Agent-Library-Version"], "node-http");
      assert.equal(headers["Copilot-Integration-Id"], undefined);
      return {
        status: 200,
        data: {
          token: "runtime-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      };
    },
    ...COPILOT_CLIENT_TEST_OPTIONS,
    requestId: "model-request-123",
    fetchJSONFn: async (url, headers) => {
      assert.equal(url, "https://api.githubcopilot.com/models");
      modelCatalogHeaders = headers;
      return {
        status: 200,
        data: {
          models: [
            { id: "gpt-4.1", context_length: 128000 },
            { id: "claude-sonnet-4.6", context_length: 200000 },
          ],
        },
      };
    },
  });

  assert.equal(tokenRequests, 1);
  assert.equal(result.source, "models_url");
  assert.deepEqual(result.models.map((model) => model.id), ["gpt-4.1", "claude-sonnet-4.6"]);
  assert.equal(modelCatalogHeaders.Authorization, "Bearer runtime-token");
  assert.equal(modelCatalogHeaders["User-Agent"], "GitHubCopilotChat/0.48.1");
  assert.equal(modelCatalogHeaders["X-VSCode-User-Agent-Library-Version"], "node-http");
  assert.equal(modelCatalogHeaders["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(modelCatalogHeaders["Editor-Plugin-Version"], "copilot-chat/0.48.1");
  assert.equal(modelCatalogHeaders["Editor-Version"], "vscode/1.121.0");
  assert.equal(modelCatalogHeaders["VScode-SessionId"], "session-123");
  assert.equal(modelCatalogHeaders["VScode-MachineId"], "machine-123");
  assert.equal(modelCatalogHeaders["Editor-Device-Id"], "device-123");
  assert.equal(modelCatalogHeaders["OpenAI-Intent"], "model-access");
  assert.equal(modelCatalogHeaders["X-Request-Id"], "model-request-123");
  assert.equal(modelCatalogHeaders["X-Interaction-Type"], "model-access");
  assert.equal(modelCatalogHeaders["X-Agent-Task-Id"], "model-request-123");
  assert.equal(modelCatalogHeaders["X-Interaction-Id"], undefined);
});

test("discoverEndpointModels reads Codex backend metadata before proxy model list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify({
    tokens: {
      access_token: "codex-access",
      account_id: "account-id",
    },
  }));
  const endpoint = discovery.getEndpoints({
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "codex-key",
  })[0];
  const calls = [];

  const result = await discovery.discoverEndpointModels(endpoint, {
    env: {
      CODEX_AUTH_FILE: authFile,
      CODEX_CLIENT_VERSION: "0.132.0",
      CODEX_BACKEND_URL: "https://chatgpt.example/backend-api/codex",
    },
    fetchJSONFn: async (url, headers) => {
      calls.push({ url, headers });
      assert.equal(url, "https://chatgpt.example/backend-api/codex/models?client_version=0.132.0");
      assert.equal(headers.Authorization, "Bearer codex-access");
      assert.equal(headers["chatgpt-account-id"], "account-id");
      assert.equal(headers["OpenAI-Beta"], "responses=experimental");
      return {
        status: 200,
        data: {
          models: [
            { slug: "gpt-5.5", context_window: 272000, default_reasoning_level: "xhigh" },
          ],
        },
      };
    },
  });

  assert.equal(result.source, "codex_backend");
  assert.deepEqual(result.models.map((model) => model.slug), ["gpt-5.5"]);
  assert.equal(calls.length, 1);
});

test("upsertDiscoveryModel refreshes stale seed discovery metadata from source providers", () => {
  const discoveryState = {
    models: [
      {
        provider: "Codex",
        name: "Codex-gpt55",
        model: "codex/gpt-5.5",
        upstream_model: "gpt-5.5",
        context_length: 4096,
        capabilities: ["text", "coding", "tools", "images", "thinking"],
        discovered_at: "2026-05-18T11:03:45.046Z",
        chat_tested: false,
      },
    ],
  };
  const endpoint = { name: "Codex" };
  const provider = {
    name: "Codex-GPT55",
    model: "codex/gpt-5.5",
    upstream_model: "gpt-5.5",
    context: 272000,
    caps: ["text", "coding", "tools", "images", "max", "thinking"],
    thinking_effort: "xhigh",
    speed_group: 4,
    cost_group: 4,
    quality_group: 5,
    display_name: "GPT-5.5",
    context_window: 272000,
    max_context_window: 272000,
    supported_thinking_efforts: ["low", "medium", "high", "xhigh"],
    supports_parallel_tool_calls: true,
    supports_search_tool: true,
    source: "codex_backend",
  };

  const result = discovery.upsertDiscoveryModel(discoveryState, endpoint, provider, {
    now: "2026-05-20T06:50:00.000Z",
  });
  const model = discoveryState.models[0];

  assert.equal(result.created, false);
  assert.equal(model.name, "Codex-GPT55");
  assert.equal(model.context_length, 272000);
  assert.equal(model.source, "codex_backend");
  assert.equal(model.thinking_effort, "xhigh");
  assert.deepEqual(model.supported_thinking_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(model.supports_parallel_tool_calls, true);
  assert.equal(model.supports_search_tool, true);
  assert.equal(model.discovered_at, "2026-05-18T11:03:45.046Z");
  assert.equal(model.refreshed_at, "2026-05-20T06:50:00.000Z");
});

test("refreshDiscoveryFromProviders updates discovery view from loaded providers", () => {
  const discoveryState = {
    models: [
      {
        provider: "Codex",
        name: "Codex-gpt54",
        model: "codex/gpt-5.4",
        upstream_model: "gpt-5.4",
        context_length: 4096,
        capabilities: ["text", "coding"],
        discovered_at: "2026-05-18T11:03:45.046Z",
        chat_tested: false,
      },
    ],
    last_scan: "2026-05-18T11:03:45.047Z",
  };
  const result = discovery.refreshDiscoveryFromProviders(discoveryState, [
    {
      name: "Codex-GPT54",
      family: "codex",
      protocol: "openai",
      model: "codex/gpt-5.4",
      upstream_model: "gpt-5.4",
      context: 272000,
      caps: ["text", "coding", "tools", "images", "max", "thinking"],
      source: "codex_backend",
      max_context_window: 1000000,
      supported_thinking_efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      name: "Auto-Coding",
      family: "virtual",
      protocol: "openai",
      model: "auto-coding",
      context: 1000000,
      caps: ["coding"],
    },
  ], {
    now: "2026-05-20T06:55:00.000Z",
  });
  const model = discoveryState.models[0];

  assert.equal(result.refreshed, 1);
  assert.equal(result.created, 0);
  assert.equal(model.provider, "Codex");
  assert.equal(model.name, "Codex-GPT54");
  assert.equal(model.context_length, 272000);
  assert.equal(model.max_context_window, 1000000);
  assert.equal(model.source, "codex_backend");
  assert.equal(model.refreshed_at, "2026-05-20T06:55:00.000Z");
  assert.equal(discoveryState.last_refresh, "2026-05-20T06:55:00.000Z");
});

test("markMissingDiscoveryModels marks endpoint models absent from a successful scan as stale", () => {
  const discoveryState = {
    models: [
      {
        provider: "Copilot",
        name: "Copilot-gpt41",
        model: "copilot/gpt-4.1",
        refreshed_at: "2026-05-20T06:55:00.000Z",
      },
      {
        provider: "Copilot",
        name: "Copilot-old",
        model: "copilot/old-model",
        refreshed_at: "2026-05-20T06:55:00.000Z",
      },
      {
        provider: "Codex",
        name: "Codex-gpt54",
        model: "codex/gpt-5.4",
        refreshed_at: "2026-05-20T06:55:00.000Z",
      },
    ],
  };

  const result = discovery.markMissingDiscoveryModels(discoveryState, { name: "Copilot" }, [
    { name: "Copilot-gpt41", model: "copilot/gpt-4.1" },
  ], {
    now: "2026-05-21T09:00:00.000Z",
  });

  assert.equal(result.marked, 1);
  assert.equal(discoveryState.models[0].stale, undefined);
  assert.equal(discoveryState.models[1].stale, true);
  assert.equal(discoveryState.models[1].alive, false);
  assert.equal(discoveryState.models[1].stale_since, "2026-05-21T09:00:00.000Z");
  assert.equal(discoveryState.models[2].stale, undefined);
});

test("mergeProvidersConfig refreshes seed provider metadata from model endpoints without changing probe status", () => {
  const seed = {
    groups: {},
    providers: [
      {
        name: "Claude-Sonnet45",
        family: "claude",
        protocol: "anthropic",
        model: "claude/claude-sonnet-4-5-20250929",
        upstream_model: "claude-sonnet-4-5-20250929",
        context: 200000,
        caps: ["text"],
      },
    ],
  };
  const existingConfig = {
    providers: [
      {
        ...seed.providers[0],
        alive: false,
        last_tested: "2026-05-20T00:00:00.000Z",
      },
    ],
  };
  const merged = discovery.mergeProvidersConfig(seed, [
    {
      ...seed.providers[0],
      context: 1000000,
      caps: ["text", "coding", "tools", "thinking", "max"],
      tc: true,
      metadata_only: true,
      alive: true,
      last_tested: "2026-05-20T01:00:00.000Z",
    },
  ], existingConfig);
  const provider = merged.providers[0];

  assert.equal(provider.context, 1000000);
  assert.deepEqual(provider.caps, ["text", "coding", "tools", "thinking", "max"]);
  assert.equal(provider.tc, true);
  assert.equal(provider.alive, false);
  assert.equal(provider.last_tested, "2026-05-20T00:00:00.000Z");
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

test("providersFromEndpointModels ignores proxy virtual model groups from accidental self-discovery", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "codex-key",
  })[0];

  const providers = discovery.providersFromEndpointModels(endpoint, [
    { id: "auto", owned_by: "llm-proxy", is_group: true },
    { id: "auto-tools", owned_by: "llm-proxy", is_group: true, provider_count: 90 },
    { id: "auto-coding", owned_by: "llm-proxy", is_group: true },
    { id: "gpt-5.4", owned_by: "openai" },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["codex/gpt-5.4"]);
});

test("providersFromEndpointModels maps Windsurf providers with discovery names", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "windsurf-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [{ id: "ignored" }]);
  const cloudProviders = windsurfCloud.buildWindsurfProviders();

  assert.equal(providers.length, cloudProviders.length);
  for (const provider of providers) {
    const cloudProvider = cloudProviders.find((candidate) => candidate.model === provider.model);
    assert.ok(cloudProvider);
    assert.equal(typeof provider.name, "string");
    assert.equal(provider.name.length > 0, true);
    assert.equal(provider.name.startsWith("Windsurf-"), true);
    assert.equal(provider.family, cloudProvider.family);
    assert.equal(provider.protocol, cloudProvider.protocol);
    assert.equal(provider.url, "windsurf");
    assert.equal(provider.upstream_model, cloudProvider.upstream_model);
    assert.equal(provider.windsurf_model_uid, cloudProvider.windsurf_model_uid);
  }
  assert.equal(providers.every((provider) => provider.name), true);
});

test("providersFromEndpointModels maps configured Windsurf models when supplied by endpoint", () => {
  const endpoint = {
    name: "Windsurf",
    family: "windsurf",
    protocol: "windsurf",
    chatUrl: "windsurf",
    key_env: "WINDSURF_API_KEY",
    models: [
      { id: "windsurf/custom-model.x", windsurf_model_uid: "custom_uid", context: 500000, tier: 1 },
    ],
  };
  const providers = discovery.providersFromEndpointModels(endpoint, endpoint.models);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].model, "windsurf/custom-model.x");
  assert.equal(providers[0].upstream_model, "custom-model.x");
  assert.equal(providers[0].windsurf_model_uid, "custom_uid");
  assert.equal(providers[0].context, 500000);
});

test("providersFromEndpointModels maps app-discovered Windsurf models without modelsUrl", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "windsurf-key",
  })[0];
  const providers = discovery.providersFromEndpointModels(endpoint, [
    { id: "windsurf/omega-code-1", upstream: "omega-code-1", windsurf_model_uid: "omega-code-1", name: "Windsurf-OmegaCode1", context: 262144, tier: 1 },
  ]);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].model, "windsurf/omega-code-1");
  assert.equal(providers[0].upstream_model, "omega-code-1");
  assert.equal(providers[0].windsurf_model_uid, "omega-code-1");
  assert.equal(providers[0].context, 262144);
});

test("providersFromEndpointModels ignores proxy virtual groups before Windsurf normalization", () => {
  const endpoint = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "windsurf-key",
  })[0];

  const providers = discovery.providersFromEndpointModels(endpoint, [
    { id: "auto-tools", owned_by: "llm-proxy", is_group: true, provider_count: 90 },
    { id: "windsurf/swe-1.6", upstream: "swe-1.6", windsurf_model_uid: "swe-1.6" },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["windsurf/swe-1.6"]);
});

test("discoverEndpointModels asks Windsurf app configs before built-in fallback", async () => {
  let capturedProvider = null;
  const endpoint = discovery.getEndpoints({
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "windsurf-key",
  })[0];
  const result = await discovery.discoverEndpointModels(endpoint, {
    env: { WINDSURF_API_KEY: "windsurf-key" },
    fetchWindsurfModelConfigsFn: async (provider) => {
      capturedProvider = provider;
      return [
        { id: "windsurf/omega-code-1", upstream: "omega-code-1", windsurf_model_uid: "omega-code-1" },
      ];
    },
  });

  assert.equal(capturedProvider.key, "windsurf-key");
  assert.equal(capturedProvider.key_env, "WINDSURF_API_KEY");
  assert.equal(result.source, "windsurf_app");
  assert.deepEqual(result.models.map((model) => model.id), ["windsurf/omega-code-1"]);
});

test("shouldProbeSeedProvider probes sentinel adapter providers with credentials", () => {
  assert.equal(
    discovery.shouldProbeSeedProvider({ family: "windsurf", protocol: "windsurf", url: "windsurf", key_env: "WINDSURF_API_KEY" }, { WINDSURF_API_KEY: "ws-key" }),
    true,
  );
  assert.equal(
    discovery.shouldProbeSeedProvider({ family: "claude", protocol: "anthropic", url: "claude", key_env: "CLAUDE_CODE_OAUTH_TOKEN" }, { CLAUDE_CODE_OAUTH_TOKEN: "claude-key" }),
    true,
  );
  assert.equal(
    discovery.shouldProbeSeedProvider({ family: "codex", protocol: "openai", url: "http://codex-proxy:10531/v1/chat/completions", key_env: "CODEX_API_KEY" }, { CODEX_API_KEY: "codex-key" }),
    true,
  );
});

test("probeSeedProvider uses Anthropic Messages probe for Claude providers", async () => {
  let capturedProvider = null;
  let capturedRequest = null;
  const ok = await discovery.probeSeedProvider(
    {
      name: "Claude-Sonnet45",
      family: "claude",
      protocol: "anthropic",
      url: "claude",
      key_env: "ANTHROPIC_API_KEY",
      model: "claude/claude-sonnet-4-5",
      upstream_model: "claude-sonnet-4-5",
    },
    "sk-ant-api03-test",
    {
      postAnthropicFn: async (provider, request) => {
        capturedProvider = provider;
        capturedRequest = request;
        return {
          status: 200,
          body: JSON.stringify({
            id: "msg_test",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 8, output_tokens: 1 },
          }),
        };
      },
    },
  );

  assert.equal(ok, true);
  assert.equal(capturedProvider.key, "sk-ant-api03-test");
  assert.equal(capturedProvider.key_env, "ANTHROPIC_API_KEY");
  assert.equal(capturedRequest.model, "claude-sonnet-4-5");
  assert.deepEqual(capturedRequest.messages, [{ role: "user", content: "Say hello in one word." }]);
  assert.equal(capturedRequest.max_tokens, 50);
});

test("probeSeedProvider uses Windsurf cloud probe for Windsurf providers", async () => {
  let capturedProvider = null;
  let capturedInput = null;
  const ok = await discovery.probeSeedProvider(
    {
      name: "Windsurf-SWE16Fast",
      family: "windsurf",
      protocol: "windsurf",
      url: "windsurf",
      key_env: "WINDSURF_API_KEY",
      model: "windsurf/swe-1.6-fast",
      upstream_model: "swe-1.6-fast",
      windsurf_model_uid: "swe-1-6-fast",
    },
    "ws-key",
    {
      callWindsurfCloudFn: async (provider, input) => {
        capturedProvider = provider;
        capturedInput = input;
        return { choices: [{ message: { role: "assistant", content: "Hello" } }] };
      },
    },
  );

  assert.equal(ok, true);
  assert.equal(capturedProvider.key, "ws-key");
  assert.equal(capturedInput.model, "windsurf/swe-1.6-fast");
  assert.deepEqual(capturedInput.messages, [{ role: "user", content: "Say hello in one word." }]);
  assert.equal(capturedInput.max_tokens, 50);
});

test("probeSeedProvider exchanges Copilot GitHub token before OpenAI-compatible probe", async () => {
  copilotToken.clearCopilotTokenCache();
  let tokenRequests = 0;
  let tokenAuth = "";
  let capturedHeaders = null;
  let capturedRequest = null;

  const ok = await discovery.probeSeedProvider(
    {
      name: "Copilot-GPT41",
      family: "copilot",
      protocol: "openai",
      url: "https://api.githubcopilot.com/chat/completions",
      key_env: "COPILOT_GITHUB_TOKEN",
      model: "copilot/gpt-4.1",
      upstream_model: "gpt-4.1",
    },
    "ghu_source",
    {
      tokenUrl: "https://github.example/copilot_internal/v2/token",
      ...COPILOT_CLIENT_TEST_OPTIONS,
      requestId: "probe-request-123",
      requestJSONFn: async (url, headers) => {
        tokenRequests += 1;
        tokenAuth = headers.Authorization || "";
        assert.equal(url, "https://github.example/copilot_internal/v2/token");
        assert.equal(headers["User-Agent"], "GitHubCopilotChat/0.48.1");
        return {
          status: 200,
          data: {
            token: "capi-runtime-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_in: 1800,
          },
        };
      },
      postJSONFn: async (url, headers, request) => {
        assert.equal(url, "https://api.githubcopilot.com/chat/completions");
        capturedHeaders = headers;
        capturedRequest = request;
        return { status: 200, data: { choices: [{ message: { role: "assistant", content: "Hello" } }] } };
      },
    },
  );

  assert.equal(ok, true);
  assert.equal(tokenRequests, 1);
  assert.equal(tokenAuth, "token ghu_source");
  assert.equal(capturedHeaders.Authorization, "Bearer capi-runtime-token");
  assert.equal(capturedHeaders["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(capturedHeaders["User-Agent"], "GitHubCopilotChat/0.48.1");
  assert.equal(capturedHeaders["OpenAI-Intent"], "conversation-panel");
  assert.equal(capturedHeaders["X-Request-Id"], "probe-request-123");
  assert.equal(capturedHeaders["X-Interaction-Id"], "interaction-123");
  assert.equal(capturedHeaders["X-Initiator"], "user");
  assert.equal(capturedRequest.model, "gpt-4.1");
  assert.deepEqual(capturedRequest.messages, [{ role: "user", content: "Say hello in one word." }]);
});

test("testSeedProviders re-probes recent no_key Copilot providers when token appears", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-discovery-copilot-reprobe-"));
  const script = `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const discovery = require("./llm-discovery");

let hits = 0;
const old = new Date(Date.now() - 10 * 60_000).toISOString();
const dataDir = process.env.DATA_DIR;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/chat/completions") {
    hits += 1;
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello" } }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", async () => {
  const url = "http://127.0.0.1:" + server.address().port + "/chat/completions";
  const provider = {
    name: "Copilot-GPT41",
    family: "copilot",
    protocol: "openai",
    model: "copilot/gpt-4.1",
    upstream_model: "gpt-4.1",
    url,
    key_env: "COPILOT_CAPI_TOKEN",
    authHeader: "copilot-runtime",
  };
  fs.writeFileSync(path.join(dataDir, "providers.json"), JSON.stringify({
    providers: [{ ...provider, alive: false, last_tested: old, reason: "no_key" }],
  }));
  const result = await discovery.testSeedProviders({ providers: [provider] });
  console.log("RESULT " + JSON.stringify({ result: result[0], hits }));
  server.close(() => process.exit(0));
});
`;

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dataDir, COPILOT_CAPI_TOKEN: "runtime-token" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, result.stdout);
  const parsed = JSON.parse(line.slice("RESULT ".length));
  assert.equal(parsed.hits, 1);
  assert.equal(parsed.result.alive, true);
  assert.equal(parsed.result.reason, undefined);
  assert.notEqual(parsed.result.last_tested, undefined);
  assert.notEqual(parsed.result.last_tested, JSON.parse(fs.readFileSync(path.join(dataDir, "providers.json"), "utf8")).providers[0].last_tested);
});

test("testSeedProviders records probe_failed instead of preserving stale no_key on keyed failures", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-discovery-copilot-fail-"));
  const script = `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const discovery = require("./llm-discovery");

let hits = 0;
const old = new Date(Date.now() - 10 * 60_000).toISOString();
const dataDir = process.env.DATA_DIR;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/chat/completions") {
    hits += 1;
    req.resume();
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "probe failed" } }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", async () => {
  const url = "http://127.0.0.1:" + server.address().port + "/chat/completions";
  const provider = {
    name: "Copilot-GPT41",
    family: "copilot",
    protocol: "openai",
    model: "copilot/gpt-4.1",
    upstream_model: "gpt-4.1",
    url,
    key_env: "COPILOT_CAPI_TOKEN",
    authHeader: "copilot-runtime",
  };
  fs.writeFileSync(path.join(dataDir, "providers.json"), JSON.stringify({
    providers: [{ ...provider, alive: false, last_tested: old, reason: "no_key" }],
  }));
  const result = await discovery.testSeedProviders({ providers: [provider] });
  console.log("RESULT " + JSON.stringify({ result: result[0], hits }));
  server.close(() => process.exit(0));
});
`;

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dataDir, COPILOT_CAPI_TOKEN: "runtime-token" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, result.stdout);
  const parsed = JSON.parse(line.slice("RESULT ".length));
  assert.equal(parsed.hits, 1);
  assert.equal(parsed.result.alive, false);
  assert.equal(parsed.result.reason, "probe_failed");
});

test("mergeProvidersConfig drops unsupported existing providers but keeps supported entries", () => {
  const seed = {
    providers: [
      {
        name: "Codex-GPT54",
        family: "codex",
        protocol: "openai",
        model: "codex/gpt-5.4",
        url: "http://codex-proxy:10531/v1/chat/completions",
        key_env: "CODEX_API_KEY",
        headers: {},
      },
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
      { name: "Codex-Stale", family: "codex", protocol: "openai", model: "codex/old-model", alive: true, last_tested: "2026-01-03T00:00:00.000Z" },
      { name: "Claude-Seed", family: "claude", protocol: "anthropic", model: "claude/claude-sonnet-4-5", alive: false, last_tested: "2026-01-02T00:00:00.000Z" },
    ],
  };

  const merged = discovery.mergeProvidersConfig(seed, [], existing);

  assert.deepEqual(merged.providers.map((provider) => provider.name).sort(), ["Claude-Seed", "Codex-GPT54"]);
  assert.equal(merged.providers.find((provider) => provider.name === "Claude-Seed").alive, false);
  assert.equal(merged.providers.filter((provider) => provider.model === "codex/gpt-5.4").length, 1);
  assert.equal(merged.providers.find((provider) => provider.name === "Codex-GPT54").alive, true);
  assert.equal(merged.providers.find((provider) => provider.name === "Codex-GPT54").last_tested, "2026-01-01T00:00:00.000Z");
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
