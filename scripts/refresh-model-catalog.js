#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { normalizeInventory } = require("../lib/model-inventory");
const config = require("../lib/provider-config");
function readEnv(file, base = process.env) {
  const env = { ...base };
  if (file && fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) {
        let v = m[2].trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        )
          v = v.slice(1, -1);
        env[m[1]] = v;
      }
    }
  }
  return env;
}
async function refresh({
  env = process.env,
  fetchFn = fetch,
  timeoutMs = 8000,
  registry = require("../lib/provider-catalog").PROVIDERS,
  previous = { models: [] },
  maxPages = 6,
  concurrency = 4,
  fetchWindsurfFn = require("../lib/windsurf-cloud").fetchWindsurfModelConfigs,
} = {}) {
  const { parseCatalogResponse } = require("../lib/provider-catalog");
  const observedAt = new Date().toISOString(),
    observations = [],
    prices = [],
    providers = [],
    limitations = [];
  const queue = [...registry];
  async function scan(def) {
    const report = {
      id: def.id,
      billingBasis: def.billingBasis,
      pricingUrl: def.pricingUrl,
      modelsUrl: def.modelsUrl || null,
      observedAt,
      listingStatus: "not_scanned",
      priceStatus: "not_in_model_response",
      pages: 0,
    };
    const keyEnv = (def.keyEnvs || []).find((k) => env[k]);
    let url = def.modelsUrl,
      headers = {};
    if (def.retired) {
      report.listingStatus = "retired";
      report.retiredAt = def.retiredAt;
      providers.push(report);
      return;
    }
    if (!keyEnv && !def.publicCatalog && def.native !== "codex") {
      report.listingStatus = "missing_credentials";
      providers.push(report);
      return;
    }
    if (keyEnv) headers.Authorization = "Bearer " + env[keyEnv];
    try {
      if (def.native === "windsurf") {
        const rows = await fetchWindsurfFn({
          key: env[keyEnv],
          timeout_ms: timeoutMs,
        });
        if (!Array.isArray(rows) || !rows.length)
          throw new Error("Native model listing unavailable");
        const parsed = parseCatalogResponse(
          def.id,
          { models: rows },
          { source: "windsurf:model-configs", observedAt, schema: def.schema },
        );
        observations.push(
          ...parsed.models.map((m) => ({ ...m, accountRef: keyEnv })),
        );
        report.listingStatus = "listed";
        report.modelCount = parsed.models.length;
        providers.push(report);
        return;
      }
      if (def.native === "codex") {
        const authFile = env.CODEX_AUTH_FILE;
        if (!authFile || !fs.existsSync(authFile)) {
          report.listingStatus = "missing_credentials";
          providers.push(report);
          return;
        }
        const fetchJSONFn = async (target, h) => {
          const r = await fetchFn(target, {
            method: "GET",
            headers: h,
            signal: AbortSignal.timeout(timeoutMs),
          });
          return { status: r.status, data: await r.json() };
        };
        const result = await require("../llm-discovery").discoverEndpointModels(
          { family: "codex", name: "Codex", modelsUrl: null },
          { env, fetchJSONFn },
        );
        if (result.source !== "codex_backend")
          throw new Error("Native account listing unavailable");
        const parsed = parseCatalogResponse(
          def.id,
          { models: result.models },
          {
            source: "https://chatgpt.com/backend-api/codex/models",
            observedAt,
          },
        );
        observations.push(
          ...parsed.models.map((m) => ({
            ...m,
            accountRef: "CODEX_AUTH_FILE",
          })),
        );
        report.listingStatus = "listed";
        report.modelCount = parsed.models.length;
        providers.push(report);
        return;
      }
      if (def.schema === "anthropic") {
        headers = {
          "anthropic-version": "2023-06-01",
          ...(keyEnv === "ANTHROPIC_API_KEY"
            ? { "x-api-key": env[keyEnv] }
            : { Authorization: "Bearer " + env[keyEnv] }),
        };
      }
      if (def.schema === "gemini") headers = { "x-goog-api-key": env[keyEnv] };
      if (def.schema === "copilot") {
        const auth = require("../lib/copilot-token");
        const entry = await auth.exchangeGitHubTokenForCopilotToken(
          env[keyEnv],
          { env, timeoutMs },
        );
        headers = await auth.buildCopilotRuntimeHeaders(
          {
            key: entry.token,
            key_env: "COPILOT_CAPI_TOKEN",
            authHeader: "copilot-runtime",
          },
          {},
          {
            env,
            timeoutMs,
            intent: "model-access",
            interactionType: "model-access",
            includeInteractionHeaders: false,
          },
        );
        if (entry.endpoints?.api)
          url = entry.endpoints.api.replace(/\/$/, "") + "/models";
      }
      if (def.native === "cloudflare") {
        let account = env.CLOUDFLARE_ACCOUNT_ID;
        if (!account) {
          const r = await fetchFn(
            "https://api.cloudflare.com/client/v4/accounts?per_page=50",
            { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) },
          );
          if (!r.ok) {
            report.listingStatus = "account_id_required";
            providers.push(report);
            return;
          }
          const b = await r.json();
          if (b.result?.length !== 1) {
            report.listingStatus = "account_id_required";
            providers.push(report);
            return;
          }
          account = b.result[0].id;
        }
        url =
          "https://api.cloudflare.com/client/v4/accounts/" +
          encodeURIComponent(account) +
          "/ai/models/search";
      }
      if (!url) {
        report.listingStatus = "no_listing_api";
        providers.push(report);
        return;
      }
      const found = [],
        listedPrices = [];
      let next = url;
      while (next && report.pages < maxPages) {
        const response = await fetchFn(next, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          report.listingStatus = "http_" + response.status;
          break;
        }
        const parsed = parseCatalogResponse(def.id, await response.json(), {
          source: def.native === "cloudflare" ? def.pricingUrl : url,
          observedAt,
          schema: def.schema,
        });
        found.push(
          ...parsed.models.map((m) => ({ ...m, accountRef: keyEnv || null })),
        );
        listedPrices.push(...parsed.prices);
        report.pages++;
        if (parsed.afterId) {
          const u = new URL(url);
          u.searchParams.set("after_id", parsed.afterId);
          next = u.href;
        } else if (parsed.nextPageToken) {
          const u = new URL(url);
          u.searchParams.set(
            def.schema === "cohere" ? "page_token" : "pageToken",
            parsed.nextPageToken,
          );
          next = u.href;
        } else if (parsed.nextPage) {
          const u = new URL(url);
          u.searchParams.set("page", String(parsed.nextPage));
          next = u.href;
        } else next = null;
        report.listingStatus = next ? "partial" : "listed";
      }
      const unique = [...new Map(found.map((m) => [m.id, m])).values()];
      observations.push(...unique);
      prices.push(...listedPrices);
      report.modelCount = unique.length;
      report.priceCount = listedPrices.length;
      report.priceStatus = listedPrices.length
        ? "catalog_rates"
        : "not_in_model_response";
    } catch (error) {
      report.listingStatus = Number(error.status)
        ? "http_" + Number(error.status)
        : "listing_unavailable";
    }
    if (report.listingStatus !== "listed") {
      const old = (previous.models || []).filter(
        (m) => m.providerId === def.id,
      );
      const known = new Set(
        observations.filter((m) => m.providerId === def.id).map((m) => m.id),
      );
      observations.push(
        ...old
          .filter((m) => !known.has(m.id))
          .map((m) => ({
            ...m,
            stale: true,
            refreshStatus: report.listingStatus,
          })),
      );
      limitations.push({ family: def.id, reason: report.listingStatus });
    }
    providers.push(report);
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await scan(queue.shift());
    }),
  );
  for (const provider of providers.filter(
    (p) => p.listingStatus !== "listed" && p.listingStatus !== "retired",
  )) {
    const ids = new Set(
      observations.filter((m) => m.providerId === provider.id).map((m) => m.id),
    );
    observations.push(
      ...(previous.models || [])
        .filter((m) => m.providerId === provider.id && !ids.has(m.id))
        .map((m) => ({
          ...m,
          stale: true,
          refreshStatus: provider.listingStatus,
        })),
    );
  }
  const normalized = normalizeInventory({ observations, observedAt });
  // Retain public/account exposure and extra evidence without treating a model listing as inference proof.
  normalized.models = observations;
  normalized.providers = providers.sort((a, b) => a.id.localeCompare(b.id));
  normalized.prices = prices;
  normalized.limitations.push(...limitations);
  normalized.revision = require("../lib/task-store").digest(
    JSON.stringify({
      models: observations,
      prices,
      providers: normalized.providers,
    }),
  );
  return normalized;
}

async function refreshDocuments({
  fetchFn = fetch,
  timeoutMs = 15000,
  sources = require("../lib/catalog-documents").SOURCES,
} = {}) {
  const { parseDocumentCatalog } = require("../lib/catalog-documents");
  const observations = await Promise.all(
    Object.entries(sources).map(async ([id, url]) => {
      try {
        const response = await fetchFn(url, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
          return {
            providers: [{ id, documentStatus: "http_" + response.status }],
          };
        const text = await response.text();
        const parsed = parseDocumentCatalog(id, text, { source: url });
        return {
          ...parsed,
          providers: [
            {
              id,
              documentStatus: "parsed",
              documentSource: url,
              documentSha256: require("node:crypto")
                .createHash("sha256")
                .update(text)
                .digest("hex"),
              documentObservedAt: new Date().toISOString(),
            },
          ],
        };
      } catch {
        return {
          providers: [{ id, documentStatus: "unavailable_or_changed_format" }],
        };
      }
    }),
  );
  return require("../lib/catalog-evidence").mergeCatalogEvidence(
    {},
    observations,
  );
}

async function main() {
  const args = process.argv.slice(2),
    arg = (k, d) => {
      const i = args.indexOf(k);
      return i < 0 ? d : args[i + 1];
    };
  const mode = arg("--mode", "list");
  if (mode !== "list")
    throw new Error(
      "This command lists only; inference probes require explicit separate operator requests.",
    );
  const env = readEnv(arg("--env-file"));
  const runtimeDir = path.resolve(
    arg(
      "--runtime-dir",
      arg("--env-file")
        ? path.join(path.dirname(arg("--env-file")), "data")
        : "data",
    ),
  );
  if (
    !env.CODEX_AUTH_FILE &&
    fs.existsSync(path.join(runtimeDir, "codex-auth.json"))
  )
    env.CODEX_AUTH_FILE = path.join(runtimeDir, "codex-auth.json");
  let previous = {};
  const oldFile = path.join(runtimeDir, "model-inventory.json");
  try {
    previous = JSON.parse(fs.readFileSync(oldFile, "utf8"));
  } catch {}
  const inventory = await refresh({ env, previous });
  const out = arg(
    "--output",
    path.join(
      env.DATA_DIR && env.DATA_DIR !== "/data" ? env.DATA_DIR : "data",
      "model-inventory.json",
    ),
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(inventory, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmp, out);
  const catalogOut = arg("--catalog-output");
  if (catalogOut) {
    let base = {};
    try {
      base = JSON.parse(fs.readFileSync(catalogOut, "utf8"));
    } catch {}
    const documents = await refreshDocuments();
    const catalog = require("../lib/catalog-evidence").mergeCatalogEvidence(
      base,
      [inventory, documents],
    );
    fs.mkdirSync(path.dirname(catalogOut), { recursive: true });
    fs.writeFileSync(
      catalogOut + ".tmp",
      JSON.stringify(catalog, null, 2) + "\n",
      { mode: 0o644 },
    );
    fs.renameSync(catalogOut + ".tmp", catalogOut);
  }
  console.log(
    JSON.stringify({
      output: out,
      models: inventory.models.length,
      limitations: inventory.limitations,
      providers: inventory.providers,
      prices: inventory.prices.length,
      revision: inventory.revision,
    }),
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { refresh, refreshDocuments, readEnv };
