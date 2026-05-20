"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../lib/provider-config");
const providers = require("../lib/providers");

test("supported families are exactly windsurf, claude, and codex", () => {
  assert.deepEqual(config.SUPPORTED_FAMILIES, ["windsurf", "claude", "codex"]);
});

test("fallback providers are namespaced and belong to supported families", () => {
  const seed = config.buildSeedConfig();
  assert.equal(seed.providers.length > 0, true);
  const families = new Set(seed.providers.map((p) => p.family));
  assert.deepEqual([...families].sort(), ["claude", "codex", "windsurf"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.FALLBACK_MODELS).map(([family, models]) => [family, models.length])),
    { windsurf: 17, claude: 9, codex: 6 },
  );

  for (const provider of seed.providers) {
    assert.equal(config.SUPPORTED_FAMILIES.includes(provider.family), true);
    assert.match(provider.model, /^(windsurf|claude|codex)\//);
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
});

test("fallback catalog includes current discovered and Windsurf picker models", () => {
  assert.deepEqual(
    config.FALLBACK_MODELS.windsurf.map((model) => model.id),
    [
      "windsurf/adaptive",
      "windsurf/swe-1.6-fast",
      "windsurf/swe-1.6",
      "windsurf/swe-1.5-fast",
      "windsurf/swe-1.5",
      "windsurf/swe-1",
      "windsurf/gpt-5.5",
      "windsurf/gpt-5.4",
      "windsurf/gpt-5.4-mini",
      "windsurf/gpt-5.3-codex-spark",
      "windsurf/claude-opus-4.7",
      "windsurf/claude-opus-4.6",
      "windsurf/claude-sonnet-4.6",
      "windsurf/gemini-3.1-pro",
      "windsurf/glm-5",
      "windsurf/minimax-m2.5",
      "windsurf/grok-code-fast-1",
    ],
  );
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
});

test("contextForModel uses explicit provider limits before catalog defaults", () => {
  assert.equal(config.contextForModel("codex", "gpt-5.5", {}), 1000000);
  assert.equal(config.contextForModel("codex", "gpt-5.4", {}), 200000);
  assert.equal(config.contextForModel("claude", "claude-opus-4-7", {}), 1000000);
  assert.equal(config.contextForModel("claude", "claude-sonnet-4-5-20250929", { max_input_tokens: 1000000, max_tokens: 64000 }), 1000000);
  assert.equal(config.contextForModel("claude", "claude-haiku-4-5-20251001", { max_tokens: 64000 }), 200000);
  assert.equal(config.contextForModel("windsurf", "claude-opus-4.7", {}), 200000);
  assert.equal(config.contextForModel("codex", "unknown-small", { context_length: 12345 }), 12345);
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
      },
    ],
  });

  assert.deepEqual(hydrated.providers.map((provider) => provider.url), [
    "windsurf",
    "claude",
    "http://codex-proxy:10531/v1/chat/completions",
  ]);
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
