const test = require("node:test"),
  assert = require("node:assert/strict");
const perf = require("../lib/free-model-performance");
function evidence() {
  return {
    version: 1,
    source: "native-free-fixtures-v1",
    observedAt: "2026-10-15T10:00:00Z",
    expiresAt: "2026-10-16T10:00:00Z",
    samples: 18,
    transportSuccesses: 18,
    usageObserved: 18,
    checksPassed: 18,
    toolChecks: 2,
    toolPassed: 2,
    streamChecks: 2,
    streamPassed: 2,
    p50LatencyMs: 1000,
    categories: { coding: { samples: 3, passed: 3 } },
  };
}
const now = Date.parse("2026-10-15T12:00:00Z"),
  provider = {
    family: "opencode",
    billing_class: "free_limited",
    billing_basis: "api",
    benchmark_evidence: evidence(),
  };
test("only fresh measured free evidence with protocol proof can affect routing", () => {
  assert.ok(perf.routingBonus(provider, { model: "auto-coding" }, { now }) > 0);
  assert.equal(
    perf.routingBonus({ ...provider, billing_class: "paid" }, {}, { now }),
    0,
  );
  assert.equal(perf.routingBonus(provider, {}, { now: now + 2 * 86400000 }), 0);
  assert.equal(
    perf.routingBonus(
      { ...provider, benchmark_evidence: { ...evidence(), toolPassed: 1 } },
      {},
      { now },
    ),
    0,
  );
  assert.equal(perf.eligible({ ...evidence(), samples: 1 }, { now }), false);
});
test("objective correctness and reliability outrank speed alone, without promoting critical tasks", () => {
  const slow = {
      ...provider,
      benchmark_evidence: { ...evidence(), p50LatencyMs: 3000 },
    },
    fastWrong = {
      ...provider,
      benchmark_evidence: { ...evidence(), checksPassed: 8, p50LatencyMs: 10 },
    };
  assert.ok(
    perf.routingBonus(slow, {}, { now }) >
      perf.routingBonus(fastWrong, {}, { now }),
  );
  assert.equal(
    perf.routingBonus(
      provider,
      { _llmProxyDifficulty: { taskLevel: 5 } },
      { now },
    ),
    0,
  );
});
test("native benchmark candidates must have explicit zero API tariffs from OpenCode", () => {
  const p = {
    family: "opencode",
    model: "opencode/free",
    upstream_model: "free",
    protocol: "openai",
    billing_class: "free_limited",
    billing_basis: "api",
    price_observation: {
      providerId: "opencode",
      upstreamModel: "free",
      inputPerMTok: 0,
      outputPerMTok: 0,
      currency: "USD",
      source: "https://opencode.ai/console/api/v2/config",
      observedAt: "2026-10-15T10:00:00Z",
    },
  };
  assert.equal(
    perf.nativeCandidate(p, { now }).url,
    "https://opencode.ai/inference/v1/chat/completions",
  );
  assert.throws(
    () => perf.nativeCandidate({ ...p, billing_class: "paid" }),
    /free/,
  );
  assert.throws(
    () =>
      perf.nativeCandidate({
        ...p,
        price_observation: {
          providerId: "opencode",
          upstreamModel: "free",
          inputPerMTok: null,
          outputPerMTok: 0,
        },
      }),
    /free/,
  );
});

test("a failed measured coding category cannot be hidden by fast easy replies", () => {
  assert.equal(
    perf.eligible(
      { ...evidence(), categories: { coding: { samples: 3, passed: 0 } } },
      { now },
    ),
    false,
  );
  assert.equal(
    perf.eligible({ ...evidence(), expiresAt: null }, { now }),
    false,
  );
});

test("failed requalification revokes prior native activation instead of leaving a bad model routable", () => {
  const p = {
    family: "opencode",
    model: "opencode/free",
    upstream_model: "free",
    protocol: "openai",
    billing_class: "free_limited",
    billing_basis: "api",
    alive: true,
    access_policy: "native_tool_profile",
    price_observation: {
      providerId: "opencode",
      upstreamModel: "free",
      inputPerMTok: 0,
      outputPerMTok: 0,
      currency: "USD",
      source: "https://opencode.ai/console/api/v2/config",
      observedAt: "2026-10-15T10:00:00Z",
    },
  };
  const bad = perf.applyEvidence(p, { ...evidence(), toolPassed: 0 }, { now });
  assert.equal(bad.alive, false);
  assert.match(bad.disabled_reason, /benchmark/i);
  const good = perf.applyEvidence(p, evidence(), { now });
  assert.equal(good.alive, true);
  assert.equal(good.key, undefined);
});
