"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../lib/provider-config");

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
  assert.equal(claude.key_env, "CLAUDE_CODE_OAUTH_TOKEN");

  const windsurf = config.providerForModel("windsurf", config.FALLBACK_MODELS.windsurf[0]);
  assert.equal(windsurf.protocol, "windsurf");
  assert.equal(windsurf.key_env, "WINDSURF_API_KEY");
});
