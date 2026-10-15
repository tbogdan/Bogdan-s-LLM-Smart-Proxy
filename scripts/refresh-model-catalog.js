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
  timeoutMs = 5000,
} = {}) {
  const seed = require("../seed-providers.json").providers.map(
    config.normalizeSeedProvider,
  );
  const observations = [],
    limitations = [],
    seen = new Set();
  for (const p of seed) {
    const keyEnv = config.resolveKeyEnv(p, env),
      key = env[keyEnv];
    if (!key || !/^https?:/.test(p.url || "")) continue;
    const url = p.url.replace(/\/chat\/completions\/?$/, "/models");
    if (url === p.url) continue;
    const id = p.family + "|" + url + "|" + keyEnv;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const headers = { Authorization: "Bearer " + key };
      const r = await fetchFn(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) {
        limitations.push({
          family: p.family,
          status: r.status,
          reason: "listing_unavailable",
        });
        continue;
      }
      const b = await r.json();
      const list = Array.isArray(b) ? b : b.data || b.models || [];
      for (const m of list.slice(0, 3000)) {
        const model = typeof m === "string" ? m : m.id || m.name;
        if (!model || typeof model !== "string") continue;
        observations.push({
          id: model,
          providerId: p.family,
          accountRef: keyEnv,
          availability: "exposed",
          source: url,
          contextWindow: m.context_length || m.context_window || null,
          capabilities: [],
          efforts: [],
        });
      }
    } catch {
      limitations.push({
        family: p.family,
        reason: "listing_failed_or_timed_out",
      });
    }
  }
  const inventory = normalizeInventory({ observations });
  inventory.limitations.push(...limitations);
  return inventory;
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
  const inventory = await refresh({ env });
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
  console.log(
    JSON.stringify({
      output: out,
      models: inventory.models.length,
      limitations: inventory.limitations,
      revision: inventory.revision,
    }),
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { refresh, readEnv };
