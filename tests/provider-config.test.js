"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../lib/provider-config");
const providers = require("../lib/providers");

test("supported families are exactly windsurf, claude, codex, and copilot", () => {
  assert.deepEqual(config.SUPPORTED_FAMILIES, ["windsurf", "claude", "codex", "copilot"]);
});

test("fallback providers are namespaced and belong to supported families", () => {
  const seed = config.buildSeedConfig();
  assert.equal(seed.providers.length > 0, true);
  const families = new Set(seed.providers.map((p) => p.family));
  assert.deepEqual([...families].sort(), ["claude", "codex", "copilot", "windsurf"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.FALLBACK_MODELS).map(([family, models]) => [family, models.length])),
    { windsurf: 101, claude: 9, codex: 6, copilot: 32 },
  );

  for (const provider of seed.providers) {
    assert.equal(config.SUPPORTED_FAMILIES.includes(provider.family), true);
    assert.match(provider.model, /^(windsurf|claude|codex|copilot)\//);
    assert.equal(typeof provider.protocol, "string");
    assert.equal(provider.caps.includes("text"), true);
  }
});

test("smart groups keep existing routing names except removed image and video groups", () => {
  assert.deepEqual(config.GROUPS, {
    "auto-tools": "tools",
    "auto-coding": "coding",
    "coding-sm": "coding-sm",
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking",
  });
});

test("capabilities are inferred for supported model families", () => {
  assert.deepEqual(config.inferCapabilities("claude/claude-sonnet-4-5").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("codex/gpt-5.5").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("windsurf/swe-1.6-fast").sort(), ["coding", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("windsurf/adaptive").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("windsurf/claude-opus-4.7").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("copilot/gpt-4.1").sort(), ["coding", "text", "thinking", "tools"].sort());
});

test("fallback catalog includes current discovered and Windsurf picker models", () => {
  const windsurfModels = config.FALLBACK_MODELS.windsurf.map((model) => model.id);
  for (const model of [
    "windsurf/adaptive",
    "windsurf/swe-1.6-fast",
    "windsurf/gpt-5-5-low",
    "windsurf/gpt-5-4-none-priority",
    "windsurf/gpt-5-2-codex-xhigh-priority",
    "windsurf/private-9",
    "windsurf/deepseek-v4",
  ]) {
    assert.equal(windsurfModels.includes(model), true, `fallback Windsurf catalog should include ${model}`);
  }
  assert.deepEqual(config.FALLBACK_MODELS.claude.map((model) => model.upstream), [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
  ]);
  assert.equal(config.FALLBACK_MODELS.codex.some((model) => model.upstream === "codex-auto-review"), true);
  assert.equal(config.FALLBACK_MODELS.copilot.some((model) => model.upstream === "gpt-4.1"), true);
  assert.equal(config.FALLBACK_MODELS.copilot.some((model) => model.upstream === "claude-sonnet-4.6"), true);
  assert.equal(config.FALLBACK_MODELS.copilot.some((model) => model.upstream === "gpt-5.4"), true);
});

test("contextForModel uses explicit provider limits before catalog defaults", () => {
  assert.equal(config.contextForModel("codex", "gpt-5.5", {}), 272000);
  assert.equal(config.contextForModel("codex", "gpt-5.4", {}), 272000);
  assert.equal(config.contextForModel("claude", "claude-opus-4-7", {}), 1000000);
  assert.equal(config.contextForModel("claude", "claude-sonnet-4-5-20250929", { max_input_tokens: 1000000, max_tokens: 64000 }), 1000000);
  assert.equal(config.contextForModel("claude", "claude-haiku-4-5-20251001", { max_tokens: 64000 }), 200000);
  assert.equal(config.contextForModel("windsurf", "claude-opus-4.7", {}), 200000);
  assert.equal(config.contextForModel("copilot", "gpt-4.1", {}), 128000);
  assert.equal(config.contextForModel("codex", "unknown-small", { context_length: 12345 }), 12345);
  assert.equal(config.contextForModel("codex", "gpt-5.5", { context_window: 272000, max_context_window: 1000000 }), 272000);
});

test("modelTraitsFor preserves Claude source capabilities", () => {
  const traits = config.modelTraitsFor("claude", "claude-opus-4-7", {
    type: "model",
    id: "claude-opus-4-7",
    display_name: "Claude Opus 4.7",
    created_at: "2026-04-14T00:00:00Z",
    capabilities: {
      code_execution: { supported: true },
      context_management: { supported: true, compact_20260112: { supported: true } },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        max: { supported: true },
      },
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: { supported: true, types: { adaptive: { supported: true } } },
    },
  });

  assert.equal(traits.display_name, "Claude Opus 4.7");
  assert.equal(traits.source_type, "model");
  assert.equal(traits.context, 1000000);
  assert.deepEqual(traits.supported_thinking_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(traits.thinking_effort, "xhigh");
  assert.equal(traits.supports_code_execution, true);
  assert.equal(traits.supports_context_management, true);
  assert.equal(traits.supports_context_compaction, true);
  assert.equal(traits.supports_adaptive_thinking, true);
  assert.equal(traits.supports_structured_outputs, true);
  assert.equal(traits.supports_pdf_input, true);
  assert.equal(traits.caps.includes("images"), true);
});

test("modelTraitsFor preserves Codex source metadata", () => {
  const traits = config.modelTraitsFor("codex", "gpt-5.5", {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Frontier model for complex coding, research, and real-world work.",
    context_window: 272000,
    max_context_window: 272000,
    default_reasoning_level: "xhigh",
    supported_reasoning_levels: [
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
    ],
    supports_parallel_tool_calls: true,
    supports_search_tool: true,
    input_modalities: ["text", "image"],
    default_verbosity: "low",
    support_verbosity: true,
    shell_type: "shell_command",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    priority: 9,
    visibility: "list",
    supported_in_api: true,
  });

  assert.equal(traits.context, 272000);
  assert.equal(traits.context_window, 272000);
  assert.equal(traits.max_context_window, 272000);
  assert.equal(traits.thinking_effort, "xhigh");
  assert.deepEqual(traits.supported_thinking_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(traits.supports_parallel_tool_calls, true);
  assert.equal(traits.supports_search_tool, true);
  assert.equal(traits.supports_verbosity, true);
  assert.equal(traits.default_verbosity, "low");
  assert.equal(traits.shell_type, "shell_command");
  assert.equal(traits.apply_patch_tool_type, "freeform");
  assert.equal(traits.web_search_tool_type, "text_and_image");
  assert.deepEqual(traits.truncation_policy, { mode: "tokens", limit: 10000 });
  assert.equal(traits.priority, 9);
  assert.equal(traits.visibility, "list");
  assert.equal(traits.supported_in_api, true);
  assert.equal(traits.caps.includes("images"), true);
});

test("model scores recognize discovered Windsurf frontier variants", () => {
  assert.equal(providers.getModelScore("windsurf/gpt-5-5-low", "coding"), 0.5);
  assert.equal(providers.getModelScore("windsurf/gpt-5-5-low", "reasoning"), 0.5);
  assert.equal(providers.getModelScore("windsurf/gpt-5-5-none", "reasoning"), 0.35);

  assert.equal(providers.getModelScore("windsurf/gemini-3-1-pro-high", "reasoning"), 0.5);
  assert.equal(providers.getModelScore("windsurf/gemini-3-1-pro-high", "vision"), 0.5);
  assert.equal(providers.getModelScore("windsurf/google-gemini-3-0-flash-minimal", "reasoning"), 0.2);
  assert.equal(providers.getModelScore("windsurf/google-gemini-3-0-flash-high", "reasoning"), 0.5);

  assert.equal(providers.getModelScore("windsurf/swe-1.6-fast", "coding"), 0.5);
  assert.equal(providers.getModelScore("windsurf/swe-1.6-fast", "speed"), 0.5);
  assert.equal(providers.getModelScore("windsurf/swe-1-5-slow", "coding"), 0.35);
  assert.equal(providers.getModelScore("windsurf/swe-1-5-slow", "speed"), 0.25);
});

test("priority and reasoning effort suffixes affect model scores", () => {
  assert.equal(providers.getModelScore("windsurf/gpt-5-2-codex-xhigh", "coding"), 0.5);
  assert.equal(providers.getModelScore("windsurf/gpt-5-2-codex-xhigh", "reasoning"), 0.5);
  assert.equal(providers.getModelScore("windsurf/gpt-5-2-codex-low", "reasoning"), 0.35);
  assert.equal(providers.getModelScore("windsurf/gpt-5-2-codex-xhigh-priority", "speed") > providers.getModelScore("windsurf/gpt-5-2-codex-xhigh", "speed"), true);
});

test("model score keys include discovered provider aliases for private Windsurf ids", () => {
  const privateProvider = {
    model: "windsurf/private-9",
    name: "Windsurf-GPT51CodexMedium",
    upstream_model: "private-9",
    windsurf_model_uid: "MODEL_PRIVATE_9",
  };

  assert.equal(providers.getModelScore(privateProvider.model, "coding"), 0.1);
  assert.match(providers.scoreKeyForProvider(privateProvider), /Windsurf-GPT51CodexMedium/);
  assert.equal(providers.getModelScore(providers.scoreKeyForProvider(privateProvider), "coding"), 0.5);
  assert.equal(providers.getModelScore(providers.scoreKeyForProvider(privateProvider), "tools"), 0.5);
});

test("routing smartness bonus uses discovered aliases for opaque private model ids", () => {
  const transforms = require("../lib/transforms");
  const privateProvider = {
    model: "windsurf/private-9",
    name: "Windsurf-GPT51CodexMedium",
    upstream_model: "private-9",
    windsurf_model_uid: "MODEL_PRIVATE_9",
    context: 400000,
  };

  assert.equal(transforms.smartnessBonus(privateProvider, "coding", { _estimatedTokens: 100000 }) > 0.5, true);
});

test("providerForModel maps representative provider contracts", () => {
  const codexModel = config.FALLBACK_MODELS.codex[0];
  const codex = config.providerForModel("codex", codexModel);
  assert.equal(codex.protocol, "openai");
  assert.equal(codex.key_env, "CODEX_API_KEY");
  assert.equal(codex.url, "http://codex-proxy:10531/v1/chat/completions");
  assert.equal(codex.upstream_model, codexModel.upstream);
  assert.equal(codex.context, codexModel.context);
  assert.equal(codex.tier, codexModel.tier);
  assert.equal(codex.tc, true);
  assert.deepEqual(codex.headers, {});
  assert.equal(codex.seed, true);

  const claude = config.providerForModel("claude", config.FALLBACK_MODELS.claude[0]);
  assert.equal(claude.protocol, "anthropic");
  assert.equal(claude.key_env, "ANTHROPIC_API_KEY");

  const windsurf = config.providerForModel("windsurf", config.FALLBACK_MODELS.windsurf[0]);
  assert.equal(windsurf.protocol, "windsurf");
  assert.equal(windsurf.key_env, "WINDSURF_API_KEY");

  const copilot = config.providerForModel(
    "copilot",
    config.FALLBACK_MODELS.copilot.find((model) => model.upstream === "gpt-4.1"),
  );
  assert.equal(copilot.protocol, "openai");
  assert.equal(copilot.key_env, "COPILOT_GITHUB_TOKEN");
  assert.equal(copilot.url, "https://api.githubcopilot.com/chat/completions");
  assert.equal(copilot.upstream_model, "gpt-4.1");
  assert.equal(copilot.context, 128000);
});

test("hydrateSeedProviders preserves runtime protocol metadata", () => {
  const hydrated = providers.hydrateSeedProviders({
    providers: [
      {
        name: "Claude-Sonnet45",
        family: "claude",
        protocol: "anthropic",
        url: "claude",
        key_env: "CLAUDE_CODE_OAUTH_TOKEN",
        model: "claude/claude-sonnet-4-5",
        upstream_model: "claude-sonnet-4-5",
        context: 200000,
        tier: 1,
        caps: ["text", "coding", "tools"],
      },
    ],
  });

  assert.equal(hydrated.providers[0].family, "claude");
  assert.equal(hydrated.providers[0].protocol, "anthropic");
  assert.equal(hydrated.providers[0].upstream_model, "claude-sonnet-4-5");
});

test("hydrateProvidersFile supplies runtime URLs for discovered providers missing url", () => {
  const hydrated = providers.hydrateProvidersFile({
    providers: [
      {
        name: "Windsurf-adaptive",
        family: "windsurf",
        protocol: "windsurf",
        key_env: "WINDSURF_API_KEY",
        model: "windsurf/adaptive",
        upstream_model: "adaptive",
      },
      {
        name: "Claude-Discovered",
        family: "claude",
        protocol: "anthropic",
        key_env: "ANTHROPIC_API_KEY",
        model: "claude/claude-sonnet-4-5",
        upstream_model: "claude-sonnet-4-5",
      },
      {
        name: "Codex-Discovered",
        family: "codex",
        protocol: "openai",
        key_env: "CODEX_API_KEY",
        model: "codex/gpt-5.4",
        upstream_model: "gpt-5.4",
        context_window: 272000,
        max_context_window: 1000000,
        cost_group: 3,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "medium",
        supported_thinking_efforts: ["low", "medium", "high", "xhigh"],
        display_name: "GPT-5.4",
        supports_parallel_tool_calls: true,
        supports_search_tool: true,
      },
      {
        name: "Copilot-GPT41",
        family: "copilot",
        protocol: "openai",
        key_env: "COPILOT_GITHUB_TOKEN",
        model: "copilot/gpt-4.1",
        upstream_model: "gpt-4.1",
      },
    ],
  });

  assert.deepEqual(hydrated.providers.map((provider) => provider.url), [
    "windsurf",
    "claude",
    "http://codex-proxy:10531/v1/chat/completions",
    "https://api.githubcopilot.com/chat/completions",
  ]);
  const codex = hydrated.providers.find((provider) => provider.model === "codex/gpt-5.4");
  assert.equal(codex.context_window, 272000);
  assert.equal(codex.max_context_window, 1000000);
  assert.equal(codex.cost_group, 3);
  assert.equal(codex.quality_group, 5);
  assert.equal(codex.speed_group, 3);
  assert.equal(codex.thinking_effort, "medium");
  assert.deepEqual(codex.supported_thinking_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(codex.display_name, "GPT-5.4");
  assert.equal(codex.supports_parallel_tool_calls, true);
  assert.equal(codex.supports_search_tool, true);
});

test("Copilot provider can fall back to GitHub token env names", () => {
  const previousCopilot = process.env.COPILOT_GITHUB_TOKEN;
  const previousGh = process.env.GH_TOKEN;
  const previousGithub = process.env.GITHUB_TOKEN;
  delete process.env.COPILOT_GITHUB_TOKEN;
  process.env.GH_TOKEN = "gho-token";
  delete process.env.GITHUB_TOKEN;

  try {
    const hydrated = providers.hydrateSeedProviders({
      providers: [
        {
          name: "Copilot-GPT41",
          family: "copilot",
          protocol: "openai",
          key_env: "COPILOT_GITHUB_TOKEN",
          model: "copilot/gpt-4.1",
          upstream_model: "gpt-4.1",
        },
      ],
    });

    assert.equal(hydrated.providers[0].key_env, "GH_TOKEN");
    assert.equal(hydrated.providers[0].key, "gho-token");
  } finally {
    if (previousCopilot === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previousCopilot;
    if (previousGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGh;
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithub;
  }
});

test("hydrateProvidersFile drops unsupported runtime providers into legacy_providers", () => {
  const hydrated = providers.hydrateProvidersFile({
    providers: [
      {
        name: "Windsurf-adaptive",
        family: "windsurf",
        protocol: "windsurf",
        key_env: "WINDSURF_API_KEY",
        model: "windsurf/adaptive",
      },
      {
        name: "Removed-FreeRouter",
        family: "openrouter",
        protocol: "openai",
        key_env: "OPENROUTER_API_KEY",
        model: "openrouter/auto",
      },
      {
        name: "Malformed-Codex",
        family: "codex",
        protocol: "openai",
        key_env: "CODEX_API_KEY",
        model: "gpt-5.4",
      },
    ],
  });

  assert.deepEqual(hydrated.providers.map((provider) => provider.name), ["Windsurf-adaptive"]);
  assert.deepEqual(hydrated.legacy_providers.map((provider) => provider.name), ["Removed-FreeRouter", "Malformed-Codex"]);
});

test("hydrateSeedProviders can fall back to Claude OAuth token for legacy provider files", () => {
  const previousOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const hydrated = providers.hydrateSeedProviders({
      providers: [
        {
          name: "Claude-Sonnet45",
          family: "claude",
          protocol: "anthropic",
          url: "claude",
          key_env: "ANTHROPIC_API_KEY",
          model: "claude/claude-sonnet-4-5",
          upstream_model: "claude-sonnet-4-5",
        },
      ],
    });

    assert.equal(hydrated.providers[0].key_env, "CLAUDE_CODE_OAUTH_TOKEN");
    assert.equal(hydrated.providers[0].key, "oauth-token");
  } finally {
    if (previousOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauth;
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  }
});

test("provider adapters identify OpenAI-compatible protocols", () => {
  const adapters = require("../lib/provider-adapters");

  assert.equal(adapters.isOpenAIProtocol({ protocol: "openai" }), true);
  assert.equal(adapters.isOpenAIProtocol({}), true);
  assert.equal(adapters.isOpenAIProtocol({ protocol: "anthropic" }), false);
});

test("provider adapters delegate OpenAI-compatible non-streaming routes", async () => {
  const adapters = require("../lib/provider-adapters");
  const provider = { name: "Codex-GPT55", protocol: "openai" };
  const reqBody = { model: "codex/gpt-5.5", messages: [{ role: "user", content: "Hello" }] };
  let delegatedProvider = null;
  let delegatedBody = null;

  const result = await adapters.routeNonStreaming(provider, reqBody, async (p, body) => {
    delegatedProvider = p;
    delegatedBody = body;
    return { status: 200, headers: {}, body: "{}" };
  });

  assert.equal(result.status, 200);
  assert.equal(delegatedProvider, provider);
  assert.equal(delegatedBody, reqBody);
});

test("provider adapters prepare OpenAI-compatible requests with upstream model for streaming", () => {
  const adapters = require("../lib/provider-adapters");
  const provider = {
    name: "Codex-GPT55",
    model: "codex/gpt-5.5",
    upstream_model: "gpt-5.5",
  };
  const body = adapters.prepareOpenAICompatibleRequest(
    provider,
    { model: "codex/gpt-5.5", stream_options: { include_usage: true }, messages: [{ role: "user", content: "Hello" }] },
    true,
  );

  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("provider adapters convert Windsurf status errors to route responses", () => {
  const adapters = require("../lib/provider-adapters");
  const body = JSON.stringify({ error: "quota exceeded" });
  const response = adapters.windsurfErrorToResponse({ status: 429, headers: { "retry-after": "60" }, body });

  assert.deepEqual(response, {
    status: 429,
    headers: { "retry-after": "60" },
    body,
  });
});
