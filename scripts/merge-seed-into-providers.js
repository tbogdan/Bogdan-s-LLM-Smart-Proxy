#!/usr/bin/env node
"use strict";

// Merge seed-providers.json into the local runtime providers.json without
// dropping discovered/provisioned routes and without probing any model.
// Missing seed routes are added as alive catalog entries; existing routes keep
// their alive/last_tested/benchmark state. Run with --write to persist.

const fs = require("node:fs");
const path = require("node:path");
const providerConfig = require("../lib/provider-config");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SEED = path.join(ROOT, "seed-providers.json");
const DEFAULT_PROVIDERS = path.join(ROOT, "data/providers.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function upstreamOf(provider) {
  return (
    provider.upstream_model ||
    String(provider.model || "")
      .split("/")
      .slice(1)
      .join("/")
  );
}

function keyOf(provider) {
  return (
    String(provider.family || "") + "|" + String(upstreamOf(provider) || "")
  );
}

function mergeMetadata(target, source) {
  let changed = false;
  if (
    Number.isFinite(source.context) &&
    source.context > 0 &&
    source.context !== target.context &&
    (!Number.isFinite(target.context) ||
      target.context === 4096 ||
      target.context < source.context)
  ) {
    target.context = source.context;
    changed = true;
  }
  if (
    Number.isFinite(source.max_tokens) &&
    source.max_tokens > 0 &&
    !Number.isFinite(target.max_tokens)
  ) {
    target.max_tokens = source.max_tokens;
    changed = true;
  }
  const caps = new Set(target.caps || ["text"]);
  for (const cap of source.caps || []) caps.add(cap);
  if (caps.size !== (target.caps || []).length) {
    target.caps = [...caps];
    changed = true;
  }
  if (caps.has("thinking") && target.tc !== true) {
    target.tc = true;
    changed = true;
  }
  for (const field of [
    "display_name",
    "source",
    "source_type",
    "input_modalities",
  ]) {
    if (target[field] === undefined && source[field] !== undefined) {
      target[field] = source[field];
      changed = true;
    }
  }
  return changed;
}

function mergeSeedIntoProviders(seed, config) {
  const providers = JSON.parse(JSON.stringify(config.providers || []));
  const index = new Map();
  for (let i = 0; i < providers.length; i += 1) {
    const normalized = providerConfig.normalizeSeedProvider(providers[i]);
    index.set(keyOf(normalized), i);
  }
  let added = 0;
  let updated = 0;
  for (const raw of seed.providers || []) {
    const normalized = providerConfig.normalizeSeedProvider(raw);
    const key = keyOf(normalized);
    const existingIndex = index.get(key);
    if (existingIndex !== undefined) {
      if (mergeMetadata(providers[existingIndex], normalized)) updated += 1;
      continue;
    }
    providers.push({
      ...normalized,
      alive: true,
      seed: true,
      last_tested: null,
      source: normalized.source || "seed-catalog-refresh",
      source_type: normalized.source_type || "public_catalog",
    });
    index.set(key, providers.length - 1);
    added += 1;
  }
  return {
    version: Date.now(),
    generated: new Date().toISOString(),
    providers,
    legacy_providers: Array.isArray(config.legacy_providers)
      ? config.legacy_providers
      : [],
    groups: config.groups || seed.groups || providerConfig.GROUPS,
    added,
    updated,
  };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  const write = args.includes("--write");
  const seedPath = path.resolve(arg("--seed", DEFAULT_SEED));
  const providersPath = path.resolve(arg("--providers", DEFAULT_PROVIDERS));
  const seed = readJson(seedPath);
  const config = readJson(providersPath);
  const merged = mergeSeedIntoProviders(seed, config);
  const summary = {
    before: (config.providers || []).length,
    after: merged.providers.length,
    added: merged.added,
    updated: merged.updated,
    written: false,
  };
  if (write) {
    const backup =
      providersPath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(providersPath, backup);
    const tmp = providersPath + "." + process.pid + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: merged.version,
          generated: merged.generated,
          providers: merged.providers,
          legacy_providers: merged.legacy_providers,
          groups: merged.groups,
        },
        null,
        2,
      ) + "\n",
    );
    fs.renameSync(tmp, providersPath);
    summary.backup = backup;
    summary.written = true;
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();

module.exports = { mergeSeedIntoProviders, mergeMetadata, keyOf };
