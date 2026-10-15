"use strict";
function eligible(e, { now = Date.now() } = {}) {
  if (e?.plannedSamples !== undefined && (!Number.isInteger(e.plannedSamples) || e.plannedSamples < 12 || e.samples < e.plannedSamples)) return false;
  if (
    !e ||
    !Number.isFinite(Date.parse(e.expiresAt)) ||
    e.version !== 1 ||
    e.source !== "native-free-fixtures-v1" ||
    !Number.isFinite(Date.parse(e.observedAt)) ||
    Date.parse(e.observedAt) > now + 300000 ||
    Date.parse(e.expiresAt) <= now ||
    Date.parse(e.expiresAt) > Date.parse(e.observedAt) + 86400000
  )
    return false;
  if (
    Object.values(e.categories || {}).some(
      (c) =>
        !Number.isFinite(c.samples) ||
        !Number.isFinite(c.passed) ||
        c.samples < 0 ||
        c.passed < 0 ||
        c.passed > c.samples ||
        (c.samples >= 2 && c.passed / c.samples < 0.8),
    )
  )
    return false;
  return (
    [
      e.samples,
      e.transportSuccesses,
      e.checksPassed,
      e.toolChecks,
      e.toolPassed,
      e.streamChecks,
      e.streamPassed,
      e.p50LatencyMs,
    ].every((n) => Number.isFinite(n) && n >= 0) &&
    e.samples >= 12 &&
    e.usageObserved === e.transportSuccesses &&
    e.transportSuccesses <= e.samples &&
    e.checksPassed <= e.transportSuccesses &&
    e.transportSuccesses / e.samples >= 0.95 &&
    e.checksPassed / e.samples >= 0.8 &&
    e.toolChecks >= 2 &&
    e.toolChecks <= e.samples &&
    e.streamChecks <= e.samples &&
    e.toolPassed === e.toolChecks &&
    e.streamChecks >= 2 &&
    e.streamPassed === e.streamChecks
  );
}
function routingBonus(provider, body = {}, options = {}) {
  const e = provider.benchmark_evidence;
  if (
    provider.billing_class !== "free_limited" ||
    provider.billing_basis !== "api" ||
    !eligible(e, options) ||
    (body._llmProxyDifficulty?.taskLevel || 0) >= 4
  )
    return 0;
  const category = /coding/.test(body.model || "")
      ? "coding"
      : /text|summary/.test(body.model || "")
        ? "summary"
        : "exact",
    c = e.categories?.[category];
  return Math.min(
    0.23,
    (0.08 * e.checksPassed) / e.samples +
      (0.05 * e.transportSuccesses) / e.samples +
      0.05 * (1 - Math.min(e.p50LatencyMs / 20000, 1)) +
      (c?.samples >= 2 ? (0.05 * c.passed) / c.samples : 0),
  );
}
function nativeCandidate(p, { now = Date.now() } = {}) {
  const price = p.price_observation;
  if (
    p.family !== "opencode" ||
    !p.upstream_model ||
    p.model !== "opencode/" + p.upstream_model ||
    price?.providerId !== "opencode" ||
    price?.upstreamModel !== p.upstream_model ||
    p.billing_class !== "free_limited" ||
    p.billing_basis !== "api" ||
    !["openai", "responses"].includes(p.protocol) ||
    price?.inputPerMTok !== 0 ||
    price?.outputPerMTok !== 0 ||
    price.currency !== "USD" ||
    price.source !== "https://opencode.ai/console/api/v2/config" ||
    !Number.isFinite(Date.parse(price.observedAt)) ||
    Date.parse(price.observedAt) > now + 300000 ||
    now - Date.parse(price.observedAt) > 7 * 86400000 ||
    (price.contextTiers || []).some(
      (t) => t.inputPerMTok !== 0 || t.outputPerMTok !== 0,
    )
  )
    throw new Error(
      "Native benchmark accepts explicit zero-tariff OpenCode free models only",
    );
  return {
    ...p,
    url:
      "https://opencode.ai/inference/v1/" +
      (p.protocol === "responses" ? "responses" : "chat/completions"),
    access_policy: "native_tool_profile",
    account_ref: "opencode-public-free",
    alive: true,
    key: "public",
    disabled_reason: undefined,
  };
}
function applyEvidence(provider, evidence, options = {}) {
  if (!evidence || !evidence.samples) return provider;
  if (!eligible(evidence, options))
    return {
      ...provider,
      benchmark_evidence: evidence,
      alive: false,
      disabled_reason:
        "Free-model benchmark failed requalification; rerun after resolving availability or protocol errors",
    };
  const candidate = nativeCandidate(provider, options);
  delete candidate.key;
  return { ...candidate, benchmark_evidence: evidence };
}
module.exports = { eligible, routingBonus, nativeCandidate, applyEvidence };
