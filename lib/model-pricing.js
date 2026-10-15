"use strict";
function normalizePriceObservation(o = {}) {
  const basis = o.billingBasis || "unknown";
  const number = (k) =>
    basis === "subscription"
      ? null
      : typeof o[k] === "number" && Number.isFinite(o[k]) && o[k] >= 0
        ? o[k]
        : null;
  const expiry =
    o.validUntil ||
    (o.observedAt && Number.isFinite(Date.parse(o.observedAt))
      ? new Date(Date.parse(o.observedAt) + 7 * 86400000).toISOString()
      : null);
  return {
    billingClass: o.billingClass || null,
    referenceRates:
      basis === "subscription"
        ? Object.fromEntries(
            [
              "inputPerMTok",
              "outputPerMTok",
              "cacheReadPerMTok",
              "cacheWritePerMTok",
              "cacheWrite1hPerMTok",
            ].map((k) => [
              k,
              typeof o[k] === "number" && Number.isFinite(o[k]) && o[k] >= 0
                ? o[k]
                : null,
            ]),
          )
        : o.referenceRates || null,
    creditInputPerMTok: o.creditInputPerMTok ?? null,
    creditOutputPerMTok: o.creditOutputPerMTok ?? null,
    creditCacheReadPerMTok: o.creditCacheReadPerMTok ?? null,
    premiumMultiplier:
      typeof o.premiumMultiplier === "number" ? o.premiumMultiplier : null,
    conditions: o.conditions || null,
    unit: o.unit || "per 1M tokens",
    cacheWrite1hPerMTok: number("cacheWrite1hPerMTok"),
    contextTiers: o.contextTiers || null,
    referenceRateOnly: o.referenceRateOnly === true,
    candidates: o.candidates || undefined,
    applicability: o.applicability || null,
    providerId: o.providerId || null,
    upstreamModel: o.upstreamModel || null,
    billingBasis: basis,
    serviceTier: o.serviceTier || "standard",
    currency: o.currency || "USD",
    inputPerMTok: number("inputPerMTok"),
    outputPerMTok: number("outputPerMTok"),
    cacheReadPerMTok: number("cacheReadPerMTok"),
    cacheWritePerMTok: number("cacheWritePerMTok"),
    longContextThreshold: o.longContextThreshold || null,
    validFrom: o.validFrom || null,
    validUntil: expiry,
    source: o.source || "unknown",
    observedAt: o.observedAt || null,
    status:
      expiry && Date.parse(expiry) < Date.now()
        ? "stale"
        : o.observedAt
          ? "observed"
          : "unknown",
  };
}
function estimatedCost(usage, price) {
  if (
    !price ||
    price.billingBasis !== "api" ||
    price.currency !== "USD" ||
    price.conditions ||
    price.referenceRateOnly ||
    (price.validUntil && Date.parse(price.validUntil) < Date.now())
  )
    return null;
  const input = usage.prompt_tokens ?? usage.input_tokens,
    output = usage.completion_tokens ?? usage.output_tokens;
  if (
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0
  )
    return null;
  if (price.contextTiers) {
    const totalInput =
      input +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    const tier = price.contextTiers.find(
      (t) =>
        (t.minInputTokens === undefined || totalInput >= t.minInputTokens) &&
        (t.maxInputTokens === undefined || totalInput <= t.maxInputTokens),
    );
    if (!tier) return null;
    price = { ...price, ...tier, contextTiers: null };
  }
  if (price.inputPerMTok === null || price.outputPerMTok === null) return null;
  const anthropic =
    usage.prompt_tokens === undefined &&
    (price.providerId === "claude" ||
      "cache_read_input_tokens" in usage ||
      "cache_creation_input_tokens" in usage);
  const read = anthropic
    ? usage.cache_read_input_tokens || 0
    : (usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      0);
  const write =
    usage.cache_creation_input_tokens ??
    usage.prompt_tokens_details?.cache_creation_tokens ??
    0;
  const hour =
    usage.cache_creation?.ephemeral_1h_input_tokens ??
    usage.prompt_tokens_details?.cache_creation_1h_tokens ??
    0;
  if (
    ![read, write, hour].every((n) => Number.isFinite(n) && n >= 0) ||
    hour > write ||
    (!anthropic && read + write > input)
  )
    return null;
  if (
    (read > 0 && price.cacheReadPerMTok === null) ||
    (write > 0 && price.cacheWritePerMTok === null) ||
    (hour > 0 && price.cacheWrite1hPerMTok === null)
  )
    return null;
  const uncached = anthropic ? input : Math.max(0, input - read - write);
  return (
    (uncached * price.inputPerMTok +
      read * (price.cacheReadPerMTok ?? 0) +
      Math.max(0, write - hour) * (price.cacheWritePerMTok ?? 0) +
      hour * (price.cacheWrite1hPerMTok ?? 0) +
      output * price.outputPerMTok) /
    1e6
  );
}

function priceForRoute(route) {
  if (
    route.price_observation?.providerId === route.family &&
    route.price_observation?.upstreamModel === route.upstream_model
  )
    return normalizePriceObservation({
      ...route.price_observation,
      billingBasis: route.billing_basis || route.price_observation.billingBasis,
    });
  const definition = require("./provider-catalog").PROVIDERS.find(
    (p) => p.id === route.family,
  );
  let basis = route.billing_basis || definition?.billingBasis || "unknown";
  if (basis === "mixed")
    basis =
      route.family === "claude" && route.key_env === "ANTHROPIC_API_KEY"
        ? "api"
        : route.family === "ollama" &&
            /^https:\/\/ollama.com/.test(route.url || "")
          ? "api"
          : "subscription";

  const upstream =
    (route.family === "windsurf" && route.windsurf_model_uid) ||
    route.upstream_model ||
    String(route.model || "").replace(/^[^/]+\//, "");
  const catalog = require("../data/model-catalog-evidence.json");
  const tier =
    route.default_service_tier ||
    (/:batch$/.test(upstream)
      ? "batch"
      : /:fast$/.test(upstream) ||
          (route.family === "windsurf" && /-priority$/.test(upstream))
        ? "fast"
        : "standard");
  const rows = (catalog.prices || []).filter(
    (p) =>
      p.providerId === route.family &&
      p.upstreamModel === upstream &&
      p.serviceTier === tier &&
      (!route.billing_currency || p.currency === route.billing_currency),
  );
  if (rows.length === 1)
    return normalizePriceObservation({ ...rows[0], billingBasis: basis });
  if (rows.length > 1)
    return normalizePriceObservation({
      providerId: route.family,
      upstreamModel: upstream,
      billingBasis: basis,
      source: rows[0].source,
      observedAt: rows[0].observedAt,
      conditions:
        "Multiple region/context/plan variants; explicit matching conditions required",
      candidates: rows,
    });
  return normalizePriceObservation({
    providerId: route.family,
    upstreamModel: upstream,
    billingBasis: basis,
  });
}
module.exports = { normalizePriceObservation, estimatedCost, priceForRoute };
