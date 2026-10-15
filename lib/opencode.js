"use strict";
const crypto = require("node:crypto");
const context = require("./task-context");
const SOURCE = "https://opencode.ai/console/api/v2/config";
const FAMILIES = ["opencode", "opencode-go"];
const isOpenCode = (p) => FAMILIES.includes(p?.family);
const finite = (n) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
function parseWorkspaceConfig(
  config,
  {
    observedAt = new Date().toISOString(),
    source = SOURCE,
    nativeCompat = false,
    nativeModels = [],
  } = {},
) {
  const routes = [],
    models = [],
    prices = [];
  for (const family of FAMILIES) {
    const provider = config?.providers?.[family];
    if (!provider) continue;
    for (const [id, m] of Object.entries(provider.models || {})) {
      const pkg = String(m.package || provider.package || "").replace(
        /^aisdk:/,
        "",
      );
      const base = m.settings?.baseURL || provider.settings?.baseURL;
      const target = new URL(base);
      if (
        target.origin !== "https://opencode.ai" ||
        !target.pathname.startsWith("/inference/") ||
        target.username ||
        target.password ||
        target.search ||
        target.hash
      )
        throw new Error("Untrusted OpenCode endpoint origin or path");
      const protocol =
        {
          "@ai-sdk/openai-compatible": "openai",
          "@ai-sdk/mistral": "openai",
          "@ai-sdk/openai": "responses",
          "@ai-sdk/anthropic": "anthropic",
          "@ai-sdk/google": "gemini",
        }[pkg] || "unsupported";
      const suffix =
        protocol === "responses"
          ? "/responses"
          : protocol === "anthropic"
            ? "/messages"
            : protocol === "gemini"
              ? "/models/" + encodeURIComponent(id) + ":generateContent"
              : "/chat/completions";
      const costs = Array.isArray(m.cost) ? m.cost : [];
      const known =
        costs.length > 0 &&
        costs.every(
          (c) => finite(c.input) !== null && finite(c.output) !== null,
        );
      const free = known && costs.every((c) => c.input === 0 && c.output === 0);
      const billing_class = free
        ? "free_limited"
        : !known
          ? "unknown"
          : family === "opencode-go"
            ? "subscription_metered"
            : "paid";
      const basis = family === "opencode-go" ? "subscription" : "api";
      const rate = (c) => ({
        inputPerMTok: finite(c?.input),
        outputPerMTok: finite(c?.output),
        cacheReadPerMTok: finite(c?.cache?.read),
        cacheWritePerMTok: finite(c?.cache?.write),
      });
      const price = {
        providerId: family,
        upstreamModel: id,
        billingBasis: basis,
        serviceTier: "standard",
        currency: "USD",
        ...rate(costs.find((c) => !c.tier) || costs[0]),
        source,
        observedAt,
        unit: "USD per 1M tokens",
        billingClass: billing_class,
      };
      const tiers = costs
        .filter(
          (c) => c.tier?.type === "context" && finite(c.tier.size) !== null,
        )
        .sort((a, b) => a.tier.size - b.tier.size);
      if (tiers.length)
        price.contextTiers = [
          {
            ...rate(costs.find((c) => !c.tier)),
            maxInputTokens: tiers[0].tier.size,
          },
          ...tiers.map((c, i) => ({
            ...rate(c),
            minInputTokens: c.tier.size + 1,
            ...(tiers[i + 1] ? { maxInputTokens: tiers[i + 1].tier.size } : {}),
          })),
        ];
      if (free)
        price.conditions = {
          availability:
            "Free model subject to provider rate, region and promotion limits; refresh before use",
        };
      if (family === "opencode-go")
        price.conditions = {
          ...(price.conditions || {}),
          billing:
            "Included subscription consumption; not a per-request USD charge",
          limits:
            "Per-model 5-hour, weekly and monthly allowances; Go/Go Plus differ",
        };
      if (costs.some((c) => c.tier && c.tier.type !== "context"))
        price.conditions = {
          ...(price.conditions || {}),
          unresolvedTiers: costs.filter(
            (c) => c.tier && c.tier.type !== "context",
          ),
        };
      prices.push(price);
      const caps = [
        "text",
        ...(m.capabilities?.tools ? ["tools", "coding"] : []),
        ...(m.capabilities?.input?.includes("image") ? ["images"] : []),
        ...(m.capabilities?.input?.includes("audio") ? ["audio"] : []),
        ...(m.capabilities?.input?.includes("video") ? ["video"] : []),
      ];
      const row = {
        providerId: family,
        id,
        upstreamModel: id,
        displayName: m.name || id,
        contextWindow: finite(m.limit?.context),
        maxOutputTokens: finite(m.limit?.output),
        capabilities: caps,
        source,
        observedAt,
        billingClass: billing_class,
        upstreamApi: protocol,
        accessPolicy: free ? "native_client_only" : "workspace_api",
      };
      const native =
        nativeCompat &&
        family === "opencode" &&
        ["big-pickle", ...nativeModels].includes(id) &&
        free &&
        ["openai", "responses"].includes(protocol);
      models.push(row);
      routes.push({
        name: family + "/" + id,
        family,
        protocol,
        model: family + "/" + id,
        upstream_model: id,
        url: native
          ? "https://opencode.ai/inference/v1/" +
            (protocol === "responses" ? "responses" : "chat/completions")
          : base.replace(/\/$/, "") + suffix,
        key_env:
          family === "opencode-go" ? "OPENCODE_GO_API_KEY" : "OPENCODE_API_KEY",
        upstream_org_env:
          family === "opencode-go" ? "OPENCODE_GO_ORG_ID" : "OPENCODE_ORG_ID",
        context: row.contextWindow || 32768,
        max_tokens: row.maxOutputTokens || undefined,
        caps,
        tier: 2,
        tc: !!m.capabilities?.reasoning,
        canonical_model: require("./task-routing").canonicalModel({
          family: "opencode",
          upstream_model: id,
        }),
        account_ref: native
          ? "opencode-public-free"
          : family + "-current-account",
        quota_bucket: family === "opencode-go" ? id : "account",
        billing_basis: basis,
        billing_class,
        access_policy: native ? "native_tool_profile" : row.accessPolicy,
        price_observation: price,
        display_name: row.displayName,
        source,
        alive: protocol !== "unsupported" && (!free || native),
        ...(free && !native
          ? {
              disabled_reason:
                "Free tier requires native OpenCode application client; observed HTTP 403 FreeTierError",
            }
          : {}),
        ...(protocol === "unsupported"
          ? { disabled_reason: "Unsupported OpenCode API package " + pkg }
          : {}),
      });
    }
  }
  return { models, prices, routes };
}
function nativeSession(task, createdAt) {
  if (!Number.isFinite(createdAt) || createdAt < 0)
    throw new Error(
      "Native OpenCode profile requires persisted task creation time",
    );
  const stamp = ~(BigInt(Math.trunc(createdAt)) * 4096n + 1n);
  const prefix = Array.from({ length: 6 }, (_, i) =>
    Number((stamp >> BigInt(40 - 8 * i)) & 255n)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return (
    "ses_" +
    prefix +
    crypto.createHash("sha256").update(String(task)).digest("hex").slice(0, 14)
  );
}
function matchingRequestedRoutes(model, providers = []) {
  if (
    typeof model !== "string" ||
    !model ||
    /^(auto(?:-|$)|coding-sm$)/.test(model)
  )
    return [];
  const exact = providers.filter((p) => p.model === model);
  if (exact.length) return exact;
  const names = providers.filter(
    (p) => String(p.name || "").toLowerCase() === model.toLowerCase(),
  );
  return names.length
    ? names
    : providers.filter((p) => String(p.model || "").includes(model));
}
function requestedFreeOnly(model, providers) {
  return matchingRequestedRoutes(model, providers).some(
    (p) => p.billing_class === "free_limited",
  );
}
function nativeRequestCompatible(provider, body = {}) {
  return (
    provider.access_policy !== "native_tool_profile" ||
    (body.tools || []).some(
      (t) =>
        t.type === "function" &&
        t.function?.name === "read" &&
        t.function.parameters?.properties?.path?.type === "string",
    )
  );
}
function buildHeaders(provider, { env = process.env, body = {} } = {}) {
  const task = context.current()?.identity?.key || body._llmProxyTaskId;
  if (!task) throw new Error("OpenCode requires stable task context");
  if (provider.access_policy === "native_tool_profile") {
    const session = nativeSession(
      task,
      context.current()?.runtime?.inspectTask()?.createdAt,
    );
    return {
      "Content-Type": "application/json",
      "User-Agent": "opencode/latest/2.0.26/desktop",
      Authorization: "Bearer public",
      "x-opencode-client": "desktop",
      "x-opencode-project": crypto
        .createHash("sha1")
        .update("llm-smart-proxy")
        .digest("hex"),
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "X-Session-Id": session,
    };
  }
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "bogdan-llm-smart-proxy/1.0.0",
    "x-opencode-session": crypto
      .createHash("sha256")
      .update(String(task))
      .digest("hex"),
  };
  if (provider.key && provider.key !== "anonymous")
    headers.Authorization = "Bearer " + provider.key;
  const org = env[provider.upstream_org_env];
  if (org) headers["x-opencode-org-id"] = org;
  if (provider.protocol === "anthropic")
    headers["anthropic-version"] = "2023-06-01";
  return headers;
}
async function fetchWorkspaceConfig({
  key,
  fetchFn = fetch,
  timeoutMs = 15000,
} = {}) {
  if (!key) throw new Error("Missing OpenCode API key");
  const response = await fetchFn(SOURCE, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + key,
      "User-Agent": "bogdan-llm-smart-proxy/1.0.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw Object.assign(new Error("OpenCode config HTTP " + response.status), {
      status: response.status,
    });
  const config = await response.json();
  if (!config?.providers) throw new Error("Invalid OpenCode workspace config");
  return config;
}
module.exports = {
  FAMILIES,
  SOURCE,
  isOpenCode,
  parseWorkspaceConfig,
  buildHeaders,
  nativeSession,
  matchingRequestedRoutes,
  requestedFreeOnly,
  nativeRequestCompatible,
  fetchWorkspaceConfig,
};
