"use strict";
const PROVIDERS = require("../config/provider-catalog.json");
const finite = (value) =>
  (typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
function parseCatalogResponse(
  providerId,
  body,
  { source, observedAt = new Date().toISOString(), schema } = {},
) {
  const definition = PROVIDERS.find((p) => p.id === providerId) || {};
  schema ||= definition.schema;
  let rows = Array.isArray(body)
    ? body
    : body.data || body.models || body.result || [];
  if (schema === "nebius" && Array.isArray(rows))
    rows = rows
      .filter((m) => m.status === "active")
      .flatMap((m) =>
        (m.flavors || []).map((f) => ({
          ...f,
          id: f.model_id,
          context_length: f.max_model_len,
        })),
      );
  if (!Array.isArray(rows)) throw new Error("Invalid model catalog shape");
  const models = [],
    prices = [];
  for (const row of rows) {
    const m = typeof row === "string" ? { id: row } : row;
    let id =
      (schema === "windsurf" && (m.modelUid || m.windsurf_model_uid)) ||
      m.id ||
      m.slug ||
      m.name ||
      m.model;
    if (typeof id !== "string" || !id || id.length > 512) continue;
    if (schema === "gemini") id = id.replace(/^models\//, "");
    if (schema === "cloudflare") id = m.name || id;
    const caps = new Set(["text"]);
    const params = m.supported_parameters || [];
    const modalities =
      m.architecture?.input_modalities || m.input_modalities || [];
    if (
      params.includes("tools") ||
      m.capabilities?.function_calling === true ||
      m.capabilities?.supports?.tool_calls === true ||
      m.capabilities?.tools === true
    )
      caps.add("tools");
    if (
      modalities.includes("image") ||
      m.capabilities?.vision === true ||
      m.capabilities?.limits?.vision === true
    )
      caps.add("images");
    if (modalities.includes("video")) caps.add("video");
    if (modalities.includes("audio")) caps.add("audio");
    const model = {
      id,
      providerId,
      upstreamModel: id,
      contextWindow: finite(
        m.context_length ||
          m.contextWindow ||
          m.max_input_tokens ||
          m.context_window?.tokens ||
          (typeof m.context_window === "number" ? m.context_window : null) ||
          m.max_context_length ||
          m.inputTokenLimit ||
          m.capabilities?.limits?.max_context_window_tokens,
      ),
      maxOutputTokens: finite(
        m.top_provider?.max_completion_tokens ||
          m.max_output_tokens ||
          m.max_tokens ||
          m.outputTokenLimit ||
          m.capabilities?.limits?.max_output_tokens,
      ),
      capabilities: [...caps],
      efforts:
        m.reasoning?.supported_efforts || m.supported_thinking_efforts || [],
      aliases: m.aliases || [],
      deprecatedAt: m.deprecation || null,
      replacement: m.deprecation_replacement_model || null,
      source,
      observedAt,
      availability: definition.publicCatalog ? "public" : "exposed",
    };
    if (m.capabilities?.completion_chat === false) model.chatCompatible = false;
    if (schema === "gemini" && Array.isArray(m.supportedGenerationMethods))
      model.chatCompatible =
        m.supportedGenerationMethods.includes("generateContent");
    models.push(model);
    const base = {
      providerId,
      upstreamModel: id,
      billingBasis: "api",
      serviceTier: "standard",
      currency: "USD",
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
      source,
      observedAt,
      unit: "USD per 1M tokens",
    };
    if (schema === "huggingface")
      for (const p of (m.providers || []).filter((p) => p.status === "live")) {
        const qualified = id + ":" + p.provider;
        models.push({
          ...model,
          id: qualified,
          upstreamModel: qualified,
          contextWindow: finite(p.context_length),
          capabilities: [...caps, ...(p.supports_tools ? ["tools"] : [])],
        });
        if (p.pricing)
          prices.push({
            ...base,
            upstreamModel: qualified,
            inputPerMTok: finite(p.pricing.input),
            outputPerMTok: finite(p.pricing.output),
            conditions: null,
            upstreamProvider: p.provider,
          });
      }
    if (schema === "llm7" && m.pricing) {
      const tokens = m.pricing.unit === "1M tokens";
      prices.push({
        ...base,
        currency: m.pricing.currency || "unknown",
        unit: m.pricing.unit,
        inputPerMTok: tokens ? finite(m.pricing.input) : null,
        outputPerMTok: tokens ? finite(m.pricing.output) : null,
        rawPricing: m.pricing,
        conditions: {
          plan: "model allowance and balance requirements apply",
          usageBasedOnly: m.usage_based_only === true,
        },
      });
    }
    if (schema === "nebius")
      prices.push({
        ...base,
        inputPerMTok: finite(m.input_price_per_million_tokens),
        outputPerMTok: finite(m.output_price_per_million_tokens),
        conditions: { regions: m.regions || [], label: m.label || null },
      });

    if (schema === "openrouter" && m.pricing) {
      const rate = (k) => {
        const n = finite(m.pricing[k]);
        return n === null ? null : n * 1e6;
      };
      prices.push({
        providerId,
        upstreamModel: id,
        billingBasis: "api",
        serviceTier: /:batch$/.test(id)
          ? "batch"
          : /:fast$/.test(id)
            ? "fast"
            : "standard",
        currency: "USD",
        inputPerMTok: rate("prompt"),
        outputPerMTok: rate("completion"),
        cacheReadPerMTok: rate("input_cache_read"),
        cacheWritePerMTok: rate("input_cache_write"),
        source,
        observedAt,
        unit: "USD per 1M tokens",
        conditions: m.pricing.prompt === "-1" ? { dynamicRouting: true } : null,
        nonTokenCharges: Object.fromEntries(
          Object.entries(m.pricing).filter(
            ([k]) =>
              ![
                "prompt",
                "completion",
                "input_cache_read",
                "input_cache_write",
              ].includes(k),
          ),
        ),
      });
    }
  }
  return {
    models,
    prices,
    nextPageToken: body.nextPageToken || body.next_page_token || null,
    afterId: body.has_more === true ? body.last_id || rows.at(-1)?.id : null,
    nextPage:
      body.result_info?.page < body.result_info?.total_pages
        ? body.result_info.page + 1
        : null,
  };
}
module.exports = { PROVIDERS, parseCatalogResponse, finite };
