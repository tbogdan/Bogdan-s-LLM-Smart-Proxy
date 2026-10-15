const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  normalizePriceObservation,
  estimatedCost,
} = require("../lib/model-pricing");
test("OpenAI Responses cached input remains part of total input", () => {
  const price = normalizePriceObservation({
    providerId: "openai",
    billingBasis: "api",
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
  });
  assert.equal(
    estimatedCost(
      {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 800 },
        output_tokens: 10,
      },
      price,
    ),
    0.00066,
  );
});
test("subscription multipliers never become API USD prices", () => {
  const row = normalizePriceObservation({
    providerId: "fixture-provider",
    upstreamModel: "fixture-model",
    billingBasis: "subscription",
    serviceTier: "standard",
    observedAt: "2026-10-15T00:00:00Z",
    source: "fixture:subscription",
    premiumMultiplier: 2,
  });
  assert.equal(row.inputPerMTok, null);
  assert.equal(row.billingBasis, "subscription");
  assert.equal(row.premiumMultiplier, 2);
});
test("currency and contextual conditions cannot silently produce wrong USD estimate", () => {
  const price = normalizePriceObservation({
    billingBasis: "api",
    currency: "CNY",
    inputPerMTok: 2,
    outputPerMTok: 5,
    conditions: { region: "china" },
    observedAt: "2026-10-15",
  });
  assert.deepEqual(price.conditions, { region: "china" });
  assert.equal(
    estimatedCost({ prompt_tokens: 1000, completion_tokens: 100 }, price),
    null,
  );
});
test("Anthropic cache creation/read tokens are additional to uncached input", () => {
  const p = normalizePriceObservation({
    billingBasis: "api",
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  });
  assert.equal(
    estimatedCost(
      {
        input_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
        output_tokens: 10,
      },
      p,
    ),
    0.001,
  );
});
test("expired promotional prices do not remain usable for cost estimates", () => {
  const p = normalizePriceObservation({
    billingBasis: "api",
    inputPerMTok: 0,
    outputPerMTok: 0,
    validUntil: "2020-01-01",
    observedAt: "2019-01-01",
  });
  assert.equal(
    estimatedCost({ prompt_tokens: 100, completion_tokens: 10 }, p),
    null,
  );
});
