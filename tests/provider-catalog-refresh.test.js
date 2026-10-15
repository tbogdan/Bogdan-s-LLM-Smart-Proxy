const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../lib/provider-config");
const { PROVIDERS, parseCatalogResponse } = require("../lib/provider-catalog");
const { refresh } = require("../scripts/refresh-model-catalog");
test("unavailable Windsurf native catalog retains previous inventory as stale", async () => {
  const r = await refresh({
    env: { WINDSURF_API_KEY: "fixture" },
    registry: [PROVIDERS.find((p) => p.id === "windsurf")],
    previous: { models: [{ providerId: "windsurf", id: "old-native" }] },
    fetchWindsurfFn: async () => [],
  });
  assert.equal(r.providers[0].listingStatus, "listing_unavailable");
  assert.equal(r.models[0].id, "old-native");
  assert.equal(r.models[0].stale, true);
});

test("every supported family has explicit model and billing source coverage", () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id).sort(),
    [...config.SUPPORTED_FAMILIES, ...config.LEGACY_FAMILIES].sort(),
  );
  for (const p of PROVIDERS) {
    assert.match(p.pricingUrl, /^https:\/\//);
    assert.ok(p.billingBasis);
    assert.ok(p.modelsUrl || p.native || p.retired);
  }
});

test("reseller per-token prices convert exactly and negative auto-route sentinel stays unknown", () => {
  const r = parseCatalogResponse(
    "openrouter",
    {
      data: [
        {
          id: "vendor/model",
          context_length: 100000,
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
            input_cache_read: "0.00000025",
          },
          supported_parameters: ["tools"],
          architecture: { input_modalities: ["text", "image"] },
        },
        { id: "auto", pricing: { prompt: "-1", completion: "" } },
      ],
    },
    { source: "https://fixture/models", observedAt: "2026-10-15T00:00:00Z" },
  );
  assert.equal(r.prices[0].inputPerMTok, 1);
  assert.equal(r.prices[0].outputPerMTok, 2);
  assert.equal(r.prices[0].cacheReadPerMTok, 0.25);
  assert.equal(r.prices[1].inputPerMTok, null);
  assert.equal(r.prices[1].outputPerMTok, null);
  assert.ok(r.models[0].capabilities.includes("images"));
});

test("listing scan is GET-only, reports missing credentials and follows native pagination", async () => {
  const seen = [];
  const registry = [
    {
      id: "claude",
      modelsUrl: "https://api.anthropic.com/v1/models",
      keyEnvs: ["ANTHROPIC_API_KEY"],
      schema: "anthropic",
      billingBasis: "api",
    },
    {
      id: "openai",
      modelsUrl: "https://api.openai.com/v1/models",
      keyEnvs: ["OPENAI_API_KEY"],
      billingBasis: "api",
    },
  ];
  const r = await refresh({
    registry,
    env: { ANTHROPIC_API_KEY: "fixture-secret" },
    fetchFn: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.ok(!url.includes("completions"));
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          seen.length === 1
            ? { data: [{ id: "one" }], has_more: true, last_id: "one" }
            : { data: [{ id: "two" }], has_more: false },
      };
    },
  });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].includes("after_id=one"));
  assert.equal(r.models.length, 2);
  assert.equal(
    r.providers.find((p) => p.id === "openai").listingStatus,
    "missing_credentials",
  );
  assert.ok(!JSON.stringify(r).includes("fixture-secret"));
});

test("failed listing retains previous models marked stale instead of retiring them", async () => {
  const r = await refresh({
    registry: [
      {
        id: "openai",
        modelsUrl: "https://api.openai.com/v1/models",
        keyEnvs: ["OPENAI_API_KEY"],
        billingBasis: "api",
      },
    ],
    env: { OPENAI_API_KEY: "fixture" },
    previous: {
      models: [
        {
          id: "existing",
          providerId: "openai",
          availability: "exposed",
          source: "fixture",
        },
      ],
    },
    fetchFn: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(r.models[0].id, "existing");
  assert.equal(r.models[0].stale, true);
  assert.equal(r.providers[0].listingStatus, "http_429");
});

test("native account catalogs preserve exact Codex slug and Windsurf UID", () => {
  const codex = parseCatalogResponse("codex", {
    models: [
      {
        slug: "fixture-codex",
        context_window: 300000,
        max_output_tokens: 10000,
        input_modalities: ["text", "image"],
      },
    ],
  });
  assert.equal(codex.models[0].id, "fixture-codex");
  assert.equal(codex.models[0].contextWindow, 300000);
  assert.equal(codex.models[0].maxOutputTokens, 10000);
  const windsurf = parseCatalogResponse("windsurf", {
    models: [{ modelUid: "MODEL_FIXTURE", contextWindow: 200000 }],
  });
  assert.equal(windsurf.models[0].id, "MODEL_FIXTURE");
  assert.equal(windsurf.models[0].contextWindow, 200000);
});
