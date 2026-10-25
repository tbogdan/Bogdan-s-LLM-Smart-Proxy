const test = require("node:test"),
  assert = require("node:assert/strict");
const { mergeCatalogEvidence } = require("../lib/catalog-evidence");
test("pricing tables cannot erase measured catalog metadata with placeholders", () => {
  const c = mergeCatalogEvidence({}, [
    {
      models: [
        {
          providerId: "mistral",
          id: "fixture",
          contextWindow: 200000,
          capabilities: ["text", "tools"],
          source: "https://fixture/models",
        },
      ],
    },
    {
      models: [
        {
          providerId: "mistral",
          id: "fixture",
          contextWindow: null,
          capabilities: [],
          source: "https://fixture/prices",
        },
      ],
    },
  ]);
  assert.equal(c.models[0].contextWindow, 200000);
  assert.deepEqual(c.models[0].capabilities, ["text", "tools"]);
  assert.equal(
    c.models[0].fieldSources.contextWindow,
    "https://fixture/models",
  );
});
const {
  priceForRoute,
  estimatedCost,
  normalizePriceObservation,
} = require("../lib/model-pricing");
test("public evidence strips account access and preserves region/currency price variants", () => {
  const result = mergeCatalogEvidence({}, [
    {
      models: [
        {
          providerId: "openai",
          id: "fixture",
          accountRef: "private-account",
          routeId: "private-route",
          availability: "verified",
        },
      ],
      prices: [
        {
          providerId: "openai",
          upstreamModel: "fixture",
          currency: "USD",
          source: "https://fixture/pricing",
          conditions: { region: "US" },
          inputPerMTok: 1,
          outputPerMTok: 2,
        },
        {
          providerId: "openai",
          upstreamModel: "fixture",
          currency: "CNY",
          source: "https://fixture/pricing",
          conditions: { region: "CN" },
          inputPerMTok: 3,
          outputPerMTok: 4,
        },
      ],
    },
  ]);
  assert.equal(result.providers.length, 38);
  assert.equal(result.prices.length, 2);
  assert.ok(!JSON.stringify(result).includes("private-account"));
  assert.equal(result.models[0].availability, undefined);
});
test("subscription reference prices stay visible without being API cost estimates", () => {
  const p = normalizePriceObservation({
    billingBasis: "subscription",
    inputPerMTok: 1,
    outputPerMTok: 5,
    premiumMultiplier: 2,
  });
  assert.equal(p.inputPerMTok, null);
  assert.equal(p.referenceRates.inputPerMTok, 1);
  assert.equal(
    estimatedCost({ prompt_tokens: 10, completion_tokens: 10 }, p),
    null,
  );
});
test("invalid cached-token usage cannot yield a plausible charge", () => {
  const p = normalizePriceObservation({
    billingBasis: "api",
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.1,
  });
  assert.equal(
    estimatedCost(
      {
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 100 },
      },
      p,
    ),
    null,
  );
  assert.equal(
    estimatedCost(
      { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: -10 },
      p,
    ),
    null,
  );
});
test("officially retired provider cannot hydrate as alive from either seed or private config", () => {
  const {
    hydrateSeedProviders,
    hydrateProvidersFile,
  } = require("../lib/providers");
  const row = {
    name: "retired fixture",
    family: "githubmodels",
    model: "githubmodels/fixture",
    upstream_model: "fixture",
    url: "https://models.inference.ai.azure.com/chat/completions",
    protocol: "openai",
    alive: true,
    no_auth: true,
  };
  for (const hydrate of [hydrateSeedProviders, hydrateProvidersFile]) {
    const result = hydrate({ providers: [row] });
    assert.equal(result.providers.length, 1);
    assert.equal(result.providers[0].alive, false);
    assert.match(result.providers[0].disabled_reason, /retired/);
  }
});
test("model retirements disable elapsed IDs without disabling future ones", () => {
  const {
    hydrateProvidersFile,
  } = require("../lib/providers");
  const { PROVIDERS } = require("../lib/provider-catalog");
  const make = (upstream) => ({
    name: upstream,
    family: "xiaomi",
    model: `xiaomi/${upstream}`,
    upstream_model: upstream,
    url: "https://api.xiaomimimo.com/v1/chat/completions",
    protocol: "openai",
    key_env: "XIAOMI_API_KEY",
    caps: ["text"],
  });
  const result = hydrateProvidersFile({
    providers: [make("mimo-v2.5"), make("mimo-v2.6-pro")],
  });
  const definition = PROVIDERS.find((p) => p.id === "xiaomi");
  for (const provider of result.providers) {
    const retirement = definition.modelRetirements.find(
      (r) => r.id === provider.upstream_model,
    );
    const elapsed =
      retirement && Date.parse(retirement.retiredAt) <= Date.now();
    assert.equal(provider.alive, !elapsed);
    if (elapsed) assert.equal(provider.model_status, "retired");
  }
});
