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
    { windsurf: 3, claude: 4, codex: 5 },
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
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking",
  });
});

test("capabilities are inferred for supported model families", () => {
  assert.deepEqual(config.inferCapabilities("claude/claude-sonnet-4-5").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("codex/gpt-5.5").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("windsurf/swe-1.6-fast").sort(), ["coding", "text", "thinking", "tools"].sort());
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
