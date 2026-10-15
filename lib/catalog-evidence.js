"use strict";
const crypto = require("node:crypto");
const { PROVIDERS } = require("./provider-catalog");

// Only public model observations belong in the distributable catalog. Account
// access remains in the private inventory and is never inferred from this file.
function publicModel(model) {
  const fields = [
    "providerId",
    "id",
    "upstreamModel",
    "displayName",
    'billingClass', 'upstreamApi', 'accessPolicy',
    "contextWindow",
    "maxOutputTokens",
    "capabilities",
    "efforts",
    "aliases",
    "deprecatedAt",
    "replacement",
    "source",
    "observedAt",
    "chatCompatible",
    "identityStatus",
  ];
  return Object.fromEntries(
    fields.filter((k) => model[k] !== undefined).map((k) => [k, model[k]]),
  );
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
function priceKey(p) {
  return JSON.stringify(
    stable([
      p.providerId,
      p.upstreamModel,
      p.serviceTier || "standard",
      p.currency || "USD",
      p.conditions || null,
      p.source,
    ]),
  );
}
function mergeCatalogEvidence(
  base = {},
  updates = [],
  { observedAt = new Date().toISOString() } = {},
) {
  const models = new Map(),
    prices = new Map(),
    reports = new Map();
  for (const input of [base, ...updates]) {
    for (const m of input.models || []) {
      if (!m.providerId || !m.id || m.stale) continue;
      const key = m.providerId + ":" + m.id;
      const prior = models.get(key) || {};
      const values = Object.fromEntries(
        Object.entries(publicModel(m)).filter(
          ([, v]) => v !== null && !(Array.isArray(v) && v.length === 0),
        ),
      );
      const fieldSources = { ...prior.fieldSources, ...m.fieldSources };
      for (const field of Object.keys(values))
        if (!["providerId", "id", "source", "observedAt"].includes(field))
          fieldSources[field] = m.fieldSources?.[field] || m.source;
      models.set(key, { ...prior, ...values, fieldSources });
    }
    for (const p of input.prices || []) {
      if (
        !p.providerId ||
        !p.upstreamModel ||
        !/^https:\/\//.test(p.source || "")
      )
        continue;
      prices.set(priceKey(p), { ...p });
    }
    for (const p of input.providers || [])
      reports.set(p.id, { ...reports.get(p.id), ...p });
  }
  const result = {
    observedAt,
    note: "Official public evidence. Public listing does not prove account access or successful inference. Conditions, currencies, service tiers and non-token charges must be respected. Unknown is not free. No new quality scores are inferred.",
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      billingBasis: p.billingBasis,
      modelsUrl: p.modelsUrl,
      pricingUrl: p.pricingUrl,
      ...(p.retired ? { status: "retired", retiredAt: p.retiredAt } : {}),
      ...reports.get(p.id),
    })),
    models: [...models.values()].sort((a, b) =>
      (a.providerId + ":" + a.id).localeCompare(b.providerId + ":" + b.id),
    ),
    prices: [...prices.values()].sort((a, b) =>
      priceKey(a).localeCompare(priceKey(b)),
    ),
  };
  for (const p of result.providers) {
    p.publicModelCount = result.models.filter(
      (m) => m.providerId === p.id,
    ).length;
    const rows = result.prices.filter((r) => r.providerId === p.id);
    p.priceObservationCount = rows.length;
    p.tokenPriceCount = rows.filter(
      (r) =>
        Number.isFinite(r.inputPerMTok) && Number.isFinite(r.outputPerMTok),
    ).length;
    p.priceStatus = p.tokenPriceCount
      ? "published_scoped_rates"
      : rows.some(
            (r) =>
              Number.isFinite(r.premiumMultiplier) ||
              Number.isFinite(r.creditInputPerMTok),
          )
        ? "credits_or_multiplier"
        : "unknown_or_non_token";
  }
  result.sources = [
    ...new Set(
      [...result.models, ...result.prices].map((r) => r.source).filter(Boolean),
    ),
  ].sort();
  result.revision = crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(result)))
    .digest("hex");
  return result;
}
module.exports = { mergeCatalogEvidence, publicModel, priceKey };
