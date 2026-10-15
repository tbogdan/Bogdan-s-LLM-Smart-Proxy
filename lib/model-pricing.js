"use strict";
function normalizePriceObservation(o = {}) {
  const basis = o.billingBasis || "unknown";
  const number = (k) =>
    basis === "subscription"
      ? null
      : typeof o[k] === "number" && Number.isFinite(o[k]) && o[k] >= 0
        ? o[k]
        : null;
  return {
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
    validUntil: o.validUntil || null,
    source: o.source || "unknown",
    observedAt: o.observedAt || null,
    status:
      o.validUntil && Date.parse(o.validUntil) < Date.now()
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
    price.inputPerMTok === null ||
    price.outputPerMTok === null
  )
    return null;
  const input = usage.prompt_tokens ?? usage.input_tokens,
    output = usage.completion_tokens ?? usage.output_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ||
    usage.input_tokens_details?.cached_tokens ||
    0;
  return (
    (Math.max(0, input - cached) * price.inputPerMTok +
      cached * (price.cacheReadPerMTok ?? price.inputPerMTok) +
      output * price.outputPerMTok) /
    1e6
  );
}
function priceForRoute(route) {
  const basis =
    route.billing_basis ||
    (["codex", "copilot", "windsurf", "claude"].includes(route.family)
      ? "subscription"
      : "unknown");
  const upstream =
    route.upstream_model || String(route.model || "").replace(/^[^/]+\//, "");
  const catalog = require("../data/model-catalog-evidence.json");
  const price =
    basis === "api" &&
    catalog.prices.find(
      (p) => p.providerId === route.family && p.upstreamModel === upstream,
    );
  return normalizePriceObservation(
    price || {
      providerId: route.family,
      upstreamModel: upstream,
      billingBasis: basis,
    },
  );
}
module.exports = { normalizePriceObservation, estimatedCost, priceForRoute };
