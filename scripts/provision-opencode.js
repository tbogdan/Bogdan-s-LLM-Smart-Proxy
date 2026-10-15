#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const {
  FAMILIES,
  fetchWorkspaceConfig,
  parseWorkspaceConfig,
} = require("../lib/opencode");
const { readEnv } = require("./refresh-model-catalog");
const { upsertEnvValue } = require("../claude-auth");
async function provision({
  env = process.env,
  config = { providers: [] },
  fetchFn = fetch,
} = {}) {
  const all = { models: [], prices: [], routes: [] },
    orgValues = {};
  for (const family of FAMILIES) {
    const keyEnv =
      family === "opencode-go" ? "OPENCODE_GO_API_KEY" : "OPENCODE_API_KEY";
    const raw = await fetchWorkspaceConfig({ key: env[keyEnv], fetchFn });
    if (!raw.providers[family])
      throw new Error("OpenCode account does not expose " + family);
    const parsed = parseWorkspaceConfig(
      {
        providers: { [family]: raw.providers[family] },
      },
      {
        nativeCompat: env.OPENCODE_NATIVE_COMPAT === "true",
        nativeModels: (config.providers || [])
          .filter(
            (p) =>
              p.access_policy === "native_tool_profile" &&
              require("../lib/free-model-performance").eligible(
                p.benchmark_evidence,
              ),
          )
          .map((p) => p.upstream_model),
      },
    );
    for (const k of ["models", "prices", "routes"]) all[k].push(...parsed[k]);
    const org = raw.providers[family].headers?.["x-opencode-org-id"];
    if (org)
      orgValues[
        family === "opencode-go" ? "OPENCODE_GO_ORG_ID" : "OPENCODE_ORG_ID"
      ] = org;
  }
  const providers = (config.providers || []).map((p) =>
    FAMILIES.includes(p.family)
      ? {
          ...p,
          alive: false,
          disabled_reason: "Not exposed by latest OpenCode workspace config",
        }
      : p,
  );
  for (const row of all.routes) {
    const prior = config.providers?.find(
      (p) => p.family === row.family && p.model === row.model,
    );
    if (prior?.benchmark_evidence) {
      row.benchmark_evidence = prior.benchmark_evidence;
      if (
        row.family === "opencode" &&
        row.billing_class === "free_limited" &&
        env.OPENCODE_NATIVE_COMPAT === "true"
      ) {
        Object.assign(
          row,
          require("../lib/free-model-performance").applyEvidence(
            row,
            prior.benchmark_evidence,
          ),
        );
      }
    }
    const index = providers.findIndex(
      (p) => p.family === row.family && p.model === row.model,
    );
    if (index < 0) providers.push(row);
    else providers[index] = row;
  }
  return {
    ...all,
    orgValues,
    config: {
      ...config,
      providers,
      version: Math.max(Number(config.version) || 0, Date.now()) + 1,
      generated_at: new Date().toISOString(),
    },
  };
}
function atomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, value, { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}
async function main() {
  const args = process.argv.slice(2),
    arg = (name, fallback) => {
      const i = args.indexOf(name);
      return i < 0 ? fallback : args[i + 1];
    };
  const envFile = path.resolve(arg("--env-file", ".env")),
    runtimeDir = path.resolve(
      arg("--runtime-dir", path.join(path.dirname(envFile), "data")),
    );
  let envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const store = arg("--auth-store");
  if (store) {
    const auth = JSON.parse(fs.readFileSync(store));
    for (const [id, key] of [
      ["opencode", "OPENCODE_API_KEY"],
      ["opencode-go", "OPENCODE_GO_API_KEY"],
    ]) {
      if (auth[id]?.type !== "api" || !auth[id]?.key)
        throw new Error("Missing local API credential for " + id);
      envText = upsertEnvValue(envText, key, auth[id].key);
    }
    atomic(envFile, envText);
  }
  const env = readEnv(envFile),
    providerFile = path.join(runtimeDir, "providers.json");
  let config = { providers: [] };
  if (fs.existsSync(providerFile))
    config = JSON.parse(fs.readFileSync(providerFile));
  const result = await provision({ env, config });
  for (const [key, value] of Object.entries(result.orgValues))
    envText = upsertEnvValue(envText, key, value);
  atomic(envFile, envText); // Credentials are never part of routes or public evidence.
  atomic(providerFile, JSON.stringify(result.config, null, 2) + "\n");
  atomic(
    path.join(runtimeDir, "opencode-model-inventory.json"),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        models: result.models,
        prices: result.prices,
      },
      null,
      2,
    ) + "\n",
  );
  const catalogFile = arg("--catalog-output");
  if (catalogFile) {
    let previous = {};
    if (fs.existsSync(catalogFile))
      previous = JSON.parse(fs.readFileSync(catalogFile));
    const catalog = require("../lib/catalog-evidence").mergeCatalogEvidence(
      previous,
      [{ models: result.models, prices: result.prices }],
    );
    atomic(catalogFile, JSON.stringify(catalog, null, 2) + "\n", 0o644);
  }
  console.log(
    JSON.stringify({
      provisioned: FAMILIES.map((id) => ({
        id,
        models: result.routes.filter((p) => p.family === id).length,
        billingClasses: Object.fromEntries(
          ["free_limited", "paid", "subscription_metered", "unknown"].map(
            (c) => [
              c,
              result.routes.filter(
                (p) => p.family === id && p.billing_class === c,
              ).length,
            ],
          ),
        ),
      })),
      runtimeDir,
      secretsPrinted: false,
    }),
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { provision };
