"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const providerConfig = require("../lib/provider-config");
const seed = require("../seed-providers.json");
const {
  mergeSeedIntoProviders,
} = require("../scripts/merge-seed-into-providers");
const {
  capsFor,
  contextFor,
  displayNameFor,
  tierFor,
} = require("../scripts/refresh-seed-from-catalog");

const CATALOG_FAMILIES = new Set([
  "kimi",
  "xiaomi",
  "together",
  "fireworks",
  "xai",
  "perplexity",
  "nebius",
  "openai",
  "gemini",
  "mistral",
  "groq",
  "cerebras",
  "sambanova",
  "nvidia",
  "deepseek",
  "alibaba",
  "cohere",
  "ollama",
  "siliconflow",
  "bigmodel",
  "ovh",
  "cloudflare",
]);

test("every seed route normalizes to a supported provider with routing metadata", () => {
  for (const raw of seed.providers) {
    const provider = providerConfig.normalizeSeedProvider(raw);
    assert.equal(
      providerConfig.isSupportedProvider(provider),
      true,
      `unsupported seed provider: ${raw.name}`,
    );
    assert.match(provider.model, new RegExp(`^${provider.family}/`));
    assert.ok(Number.isFinite(provider.context) && provider.context > 0);
    assert.ok(Array.isArray(provider.caps) && provider.caps.length > 0);
    assert.ok([1, 2, 3].includes(provider.tier));
  }
});

test("catalog-only seed routes are complete and opt out of inference probes", () => {
  const generated = seed.providers.filter((provider) => provider.probe === false);
  assert.ok(generated.length > 0);
  const names = new Set();
  for (const provider of generated) {
    assert.equal(CATALOG_FAMILIES.has(provider.family), true);
    assert.equal(provider.probe_skip_reason, "catalog_only_no_inference");
    assert.match(provider.source, /^https:\/\//);
    assert.equal(provider.source_type, "public_catalog");
    assert.match(provider.url, /^https:\/\//);
    assert.ok(provider.key_env || provider.no_auth === true);
    assert.equal(names.has(provider.name), false, `duplicate name ${provider.name}`);
    names.add(provider.name);
  }
});

test("merging seed into providers preserves discovered state and adds missing routes", () => {
  const seedFixture = {
    providers: [
      {
        name: "Kimi-K31Pro",
        family: "kimi",
        protocol: "openai",
        url: "https://api.moonshot.ai/v1/chat/completions",
        key_env: "KIMI_API_KEY",
        model: "kimi/kimi-k3.1-pro",
        upstream_model: "kimi-k3.1-pro",
        context: 1048576,
        tier: 1,
        tc: true,
        caps: ["text", "thinking"],
        probe: false,
        probe_skip_reason: "catalog_only_no_inference",
      },
    ],
    groups: {},
  };
  const existing = {
    providers: [
      {
        name: "Groq-Llama",
        family: "groq",
        protocol: "openai",
        url: "https://api.groq.com/openai/v1/chat/completions",
        key_env: "GROQ_API_KEY",
        model: "groq/llama",
        upstream_model: "llama",
        context: 4096,
        caps: ["text"],
        alive: false,
        last_tested: "2026-01-01T00:00:00.000Z",
      },
    ],
    legacy_providers: [{ name: "legacy" }],
    groups: { "auto-text": "text" },
  };
  const merged = mergeSeedIntoProviders(seedFixture, existing);
  assert.equal(merged.added, 1);
  assert.equal(merged.providers.length, 2);
  const preserved = merged.providers.find((provider) => provider.name === "Groq-Llama");
  assert.equal(preserved.alive, false);
  assert.equal(preserved.last_tested, "2026-01-01T00:00:00.000Z");
  const added = merged.providers.find((provider) => provider.family === "kimi");
  assert.equal(added.alive, true);
  assert.equal(added.probe, false);
  assert.deepEqual(merged.legacy_providers, [{ name: "legacy" }]);
  assert.deepEqual(merged.groups, { "auto-text": "text" });
});
test("catalog metadata heuristics stay conservative for known model families", () => {
  assert.equal(contextFor("kimi", "kimi-k3.1-pro", null), 1048576);
  assert.equal(contextFor("cloudflare", "@cf/deepseek-ai/deepseek-v4.1-flash-1017", null), 1048576);
  const nonReasoning = capsFor(
    "xai",
    "grok-4.20-0309-non-reasoning",
    1000000,
    [],
  );
  assert.equal(nonReasoning.includes("thinking"), false);
  assert.equal(nonReasoning.includes("tools"), true);
  const reasoning = capsFor("kimi", "kimi-k3.1-pro", 1048576, []);
  assert.equal(reasoning.includes("thinking"), true);
  assert.equal(tierFor("xiaomi", "mimo-v2.6-pro", 1000000, new Map()), 1);
  assert.equal(tierFor("xiaomi", "mimo-v2.6-flash", 1000000, new Map()), 2);
  assert.equal(
    displayNameFor({ id: "gpt-6-astra", upstreamModel: "gpt-6-astra" }),
    "GPT 6 Astra",
  );
  assert.equal(
    displayNameFor({ id: "mimo-v2.6-pro", upstreamModel: "mimo-v2.6-pro" }),
    "MiMo V2.6 Pro",
  );
});
