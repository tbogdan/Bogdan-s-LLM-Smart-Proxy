const test = require("node:test"),
  assert = require("node:assert/strict");
const { parseWorkspaceConfig, buildHeaders } = require("../lib/opencode");
const context = require("../lib/task-context");
const workspace = {
  providers: {
    opencode: {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: {
        baseURL: "https://opencode.ai/inference/openai/v1",
        apiKey: "DO_NOT_EXPORT",
      },
      headers: { "x-opencode-org-id": "private-org" },
      models: {
        "free-fixture": {
          name: "Free fixture",
          capabilities: { tools: true, input: ["text"] },
          limit: { context: 200000, output: 10000 },
          cost: [{ input: 0, output: 0, cache: { read: 0 } }],
        },
        "gpt-fixture": {
          package: "aisdk:@ai-sdk/openai",
          cost: [
            { input: 2, output: 10, cache: { read: 0.2 } },
            {
              tier: { type: "context", size: 100000 },
              input: 4,
              output: 15,
              cache: { read: 0.4 },
            },
          ],
        },
        "claude-fixture": {
          package: "aisdk:@ai-sdk/anthropic",
          settings: { baseURL: "https://opencode.ai/inference/anthropic/v1" },
          cost: [{ input: 2, output: 10 }],
        },
        "gemini-fixture": {
          package: "aisdk:@ai-sdk/google",
          settings: { baseURL: "https://opencode.ai/inference/google/v1beta" },
          cost: [{ input: 1, output: 3 }],
        },
        "unknown-fixture": { name: "Free in name only" },
        "typed-fixture": { package: "custom:system-one" },
      },
    },
    "opencode-go": {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "https://opencode.ai/inference/go/openai/v1" },
      models: {
        "paid-fixture": {
          cost: [{ input: 0.3, output: 1.2, cache: { read: 0.006 } }],
        },
        "free-fixture": { cost: [{ input: 0, output: 0 }] },
      },
    },
  },
};
test("workspace model formats select correct endpoint and preserve typed unsupported models", () => {
  const r = parseWorkspaceConfig(workspace, {
    observedAt: "2026-10-15T00:00:00Z",
  });
  const by = (id) => r.routes.find((p) => p.model === "opencode/" + id);
  assert.equal(by("gpt-fixture").protocol, "responses");
  assert.equal(
    by("gpt-fixture").url,
    "https://opencode.ai/inference/openai/v1/responses",
  );
  assert.equal(
    by("claude-fixture").url,
    "https://opencode.ai/inference/anthropic/v1/messages",
  );
  assert.equal(
    by("gemini-fixture").url,
    "https://opencode.ai/inference/google/v1beta/models/gemini-fixture:generateContent",
  );
  assert.equal(by("typed-fixture").alive, false);
  assert.match(by("typed-fixture").disabled_reason, /unsupported/i);
  assert.ok(!JSON.stringify(r).includes("DO_NOT_EXPORT"));
  assert.ok(!JSON.stringify(r).includes("private-org"));
});
test("free, paid and subscription metering stay distinct; unknown cost never free", () => {
  const r = parseWorkspaceConfig(workspace);
  const by = (id) => r.routes.find((p) => p.model === id);
  assert.equal(by("opencode/free-fixture").billing_class, "free_limited");
  assert.equal(by("opencode/unknown-fixture").billing_class, "unknown");
  assert.equal(by("opencode/gpt-fixture").billing_class, "paid");
  assert.equal(
    by("opencode-go/paid-fixture").billing_class,
    "subscription_metered",
  );
  const price = r.prices.find(
    (p) => p.providerId === "opencode" && p.upstreamModel === "gpt-fixture",
  );
  assert.equal(price.contextTiers[0].maxInputTokens, 100000);
  assert.equal(price.contextTiers[1].minInputTokens, 100001);
  assert.equal(price.contextTiers[1].outputPerMTok, 15);
  const {
    normalizePriceObservation,
    estimatedCost,
  } = require("../lib/model-pricing");
  const go = normalizePriceObservation(
    r.prices.find(
      (p) =>
        p.providerId === "opencode-go" && p.upstreamModel === "paid-fixture",
    ),
  );
  assert.equal(go.inputPerMTok, null);
  assert.equal(go.referenceRates.inputPerMTok, 0.3);
  assert.equal(
    estimatedCost({ prompt_tokens: 1000, completion_tokens: 100 }, go),
    null,
  );
});
test("native-client-only free tier stays visible in evidence but cannot enter external routing", () => {
  const r = parseWorkspaceConfig(workspace);
  const p = r.routes.find((p) => p.model === "opencode/free-fixture");
  assert.equal(p.billing_class, "free_limited");
  assert.equal(p.alive, false);
  assert.match(p.disabled_reason, /native.*client|OpenCode application/i);
  assert.equal(
    r.models.find((p) => p.providerId === "opencode" && p.id === "free-fixture")
      .accessPolicy,
    "native_client_only",
  );
});
test("workspace configuration cannot send imported credentials to another origin", () => {
  const bad = structuredClone(workspace);
  bad.providers.opencode.models["gpt-fixture"].settings = {
    baseURL: "https://evil.example/inference/openai/v1",
  };
  assert.throws(() => parseWorkspaceConfig(bad), /origin|endpoint/i);
});
test("outbound identity is honest and stable within task, separate across tasks", () => {
  const p = {
    family: "opencode-go",
    key: "fixture-key",
    upstream_org_env: "FIXTURE_ORG",
    headers: {
      "User-Agent": "OpenCode/impersonation",
      "x-opencode-session": "untrusted",
    },
  };
  const get = (key) =>
    context.run({ identity: { key } }, () =>
      buildHeaders(p, { env: { FIXTURE_ORG: "fixture-org" } }),
    );
  const a = get("task-one"),
    b = get("task-one"),
    c = get("task-two");
  assert.equal(a["x-opencode-session"], b["x-opencode-session"]);
  assert.notEqual(a["x-opencode-session"], c["x-opencode-session"]);
  assert.equal(a.Authorization, "Bearer fixture-key");
  assert.match(a["User-Agent"], /bogdan-llm-smart-proxy/);
  assert.equal(a["x-opencode-org-id"], "fixture-org");
  assert.ok(!JSON.stringify(a).includes("impersonation"));
  assert.ok(!JSON.stringify(a).includes("task-one"));
});
test("hydration accepts all gateway formats without confusing other provider protocols", () => {
  const { hydrateProvidersFile } = require("../lib/providers");
  const r = parseWorkspaceConfig(workspace);
  const h = hydrateProvidersFile({ providers: r.routes });
  assert.ok(h.providers.some((p) => p.protocol === "responses"));
  assert.ok(h.providers.some((p) => p.protocol === "gemini"));
  assert.ok(h.providers.some((p) => p.protocol === "anthropic"));
  const p = h.providers.find((p) => p.model === "opencode-go/paid-fixture");
  assert.equal(p.billing_class, "subscription_metered");
  assert.equal(p.billing_basis, "subscription");
});
