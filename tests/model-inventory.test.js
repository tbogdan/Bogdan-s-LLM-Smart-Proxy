const test = require("node:test"),
  assert = require("node:assert/strict");
const { normalizeInventory } = require("../lib/model-inventory");
const { normalizePriceObservation } = require("../lib/model-pricing");
test("inventory does not convert listed models into inference verified and prices retain billing basis", () => {
  const i = normalizeInventory({
    observations: [
      { id: "gpt-test", providerId: "p", availability: "exposed" },
    ],
    observedAt: "2026-10-15T00:00:00Z",
  });
  assert.equal(i.models[0].availability, "exposed");
  assert.ok(i.revision);
  const p = normalizePriceObservation({
    providerId: "p",
    upstreamModel: "m",
    billingBasis: "subscription",
    premiumMultiplier: 2,
    source: "fixture",
  });
  assert.equal(p.inputPerMTok, null);
  assert.equal(p.billingBasis, "subscription");
});
test("expired price observation remains stale and unknown cost never becomes zero", () => {
  const p = normalizePriceObservation({
    validUntil: "2020-01-01",
    inputPerMTok: null,
    source: "fixture",
  });
  assert.equal(p.status, "stale");
  assert.equal(p.inputPerMTok, null);
});

test("route prices never equate subscription access with direct API charges", () => {
  const { priceForRoute } = require("../lib/model-pricing");
  assert.equal(
    priceForRoute({ family: "codex", upstream_model: "gpt-6.1-sol" })
      .inputPerMTok,
    null,
  );
  const direct = priceForRoute({
    family: "openai",
    upstream_model: "gpt-6.1-sol",
    billing_basis: "api",
  });
  assert.equal(direct.inputPerMTok, 2);
  assert.equal(
    priceForRoute({
      family: "openai",
      upstream_model: "unlisted",
      billing_basis: "api",
    }).status,
    "unknown",
  );
});
