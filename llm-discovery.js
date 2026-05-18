#!/usr/bin/env node
"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const providerConfig = require("./lib/provider-config");
const windsurfCloud = require("./lib/windsurf-cloud");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || "/data";
const DISCOVERY_FILE = path.join(DATA_DIR, "discovery.json");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");
const SEED_FILE = path.join(__dirname, "seed-providers.json");
const SCAN_INTERVAL = 2 * 60 * 60_000; // 2 hours
const REQUEST_TIMEOUT = 30_000;
const SUPPORTED_PROTOCOLS = {
  claude: "anthropic",
  codex: "openai",
  windsurf: "windsurf",
};

// Thinking model patterns
const THINKING_PATTERNS = [
  /qwen3/i, /qwq/i, /deepseek-v[34]/i, /deepseek.*r1/i, /gpt-oss/i, /kimi/i,
  /gemini-2\.5/i, /gemini-3/i, /magistral/i, /\b(o1|o3|o4)\b/i, /nemotron.*reason/i,
  /gpt-5/i, /claude.*sonnet[- _.]4/i, /claude.*opus/i, /claude.*haiku[- _.]4/i,
];

// ---------------------------------------------------------------------------
// URL resolution (e.g. Cloudflare accounts/me → actual account ID)
// ---------------------------------------------------------------------------
function resolveUrl(url) {
  if (url.includes("cloudflare.com") && url.includes("/accounts/me/") && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return url.replace("/accounts/me/", `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function fetchJSON(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(parsed, { method: "GET", headers, timeout: REQUEST_TIMEOUT }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          reject(new Error(`JSON parse error from ${urlStr}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function postJSON(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = mod.request(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Load seed providers
// ---------------------------------------------------------------------------
function loadSeed() {
  try {
    const raw = fs.readFileSync(SEED_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    log(`WARN: Failed to load seed-providers.json: ${err.message}`);
    return { providers: [], groups: {} };
  }
}

// ---------------------------------------------------------------------------
// Provider endpoints to scan for new models
// ---------------------------------------------------------------------------
function getEndpoints(env = process.env) {
  const endpoints = [];

  if (env.ENABLE_CLAUDE === "true" && (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
    const keyEnv = env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
    endpoints.push({
      name: "Claude",
      family: "claude",
      protocol: "anthropic",
      modelsUrl: "https://api.anthropic.com/v1/models",
      chatUrl: "https://api.anthropic.com/v1/messages",
      headers: {
        Authorization: `Bearer ${env[keyEnv]}`,
        "anthropic-version": "2023-06-01",
      },
      key_env: keyEnv,
    });
  }

  if (env.ENABLE_CODEX === "true" && env.CODEX_API_KEY) {
    endpoints.push({
      name: "Codex",
      family: "codex",
      protocol: "openai",
      modelsUrl: "http://codex-proxy:10531/v1/models",
      chatUrl: "http://codex-proxy:10531/v1/chat/completions",
      headers: { Authorization: `Bearer ${env.CODEX_API_KEY}` },
      key_env: "CODEX_API_KEY",
      local_gateway: true,
    });
  }

  if (env.ENABLE_WINDSURF === "true" && env.WINDSURF_API_KEY) {
    endpoints.push({
      name: "Windsurf",
      family: "windsurf",
      protocol: "windsurf",
      modelsUrl: null,
      chatUrl: "windsurf",
      headers: {},
      key_env: "WINDSURF_API_KEY",
    });
  }

  return endpoints.sort((a, b) => a.name.localeCompare(b.name));
}

function providerName(endpointName, upstreamModel) {
  const shortName = String(upstreamModel || "")
    .split("/")
    .pop()
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 20);
  return `${endpointName}-${shortName}`;
}

function providersFromEndpointModels(ep, models) {
  if (ep.protocol === "windsurf" || ep.family === "windsurf") {
    return windsurfCloud.buildWindsurfProviders();
  }

  return (models || []).filter((modelData) => {
    if (!modelData || typeof modelData !== "object" || Array.isArray(modelData)) return false;
    const upstream = modelData.id || modelData.name;
    return typeof upstream === "string" && upstream.trim().length > 0;
  }).map((modelData) => {
    const upstream = (modelData.id || modelData.name).trim();
    const modelId = `${ep.family}/${upstream}`;
    const caps = detectCaps(modelId, modelData);
    const tc = caps.includes("thinking") || THINKING_PATTERNS.some((pattern) => pattern.test(modelId));
    return {
      name: providerName(ep.name, upstream),
      family: ep.family,
      protocol: ep.protocol,
      url: ep.chatUrl,
      key_env: ep.key_env,
      model: modelId,
      upstream_model: upstream,
      context: modelData.context_length || modelData.max_tokens || 4096,
      tier: 2,
      tc,
      caps,
      headers: {},
      alive: true,
      seed: false,
      last_tested: new Date().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------
function detectCaps(modelId, modelData) {
  const caps = ["text"];
  const id = (modelId || "").toLowerCase();

  // Coding — frontier models + code-specialized
  if (/coder|code|codex|starcoder|codellama|deepseek-v[3-9]|laguna|gpt-[45]|claude.*sonnet|claude.*opus|command-a|nemotron.*super|qwen.*max|qwen.*plus|qwen.*235b/i.test(id)) caps.push("coding");

  // Tools — most chat models support tools
  if (modelData?.capabilities?.tools || /gpt|llama|qwen|mistral|gemini|nemotron|glm|deepseek|kimi|ring|claude|command|owl|granite|ministral/i.test(id)) {
    caps.push("tools");
  }

  // Images/vision
  if (/vision|llava|scout|maverick|gemini|gpt-4o|gpt-5|pixtral|claude.*sonnet.*4|claude.*opus|omni/i.test(id)) caps.push("images");

  // Video
  if (/gemini/i.test(id)) caps.push("video");

  // Large context = max
  const ctx = modelData?.context_length || 0;
  if (ctx >= 128000) caps.push("max");

  // Thinking
  if (THINKING_PATTERNS.some((p) => p.test(id))) caps.push("thinking");

  return [...new Set(caps)];
}

// ---------------------------------------------------------------------------
// Test a model with basic chat
// ---------------------------------------------------------------------------
async function testChat(chatUrl, headers, model) {
  try {
    const resp = await postJSON(chatUrl, headers, {
      model,
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 50,
    });
    return resp.status < 400 && resp.data?.choices?.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test thinking capability
// ---------------------------------------------------------------------------
async function testThinking(chatUrl, headers, model) {
  try {
    const body = {
      model,
      messages: [{ role: "user", content: "What is 15 * 37? Think step by step." }],
      max_tokens: 500,
    };

    // Add enable_thinking for Qwen3 models
    if (/qwen3|qwq/i.test(model)) {
      body.extra_body = { enable_thinking: true };
    }

    const resp = await postJSON(chatUrl, headers, body);
    if (resp.status >= 400 || !resp.data) return false;

    const choice = resp.data.choices?.[0];
    if (!choice) return false;

    if (choice.message?.reasoning_content) return true;
    if (choice.message?.thinking) return true;
    const content = choice.message?.content || "";
    if (/<think>[\s\S]*?<\/think>/i.test(content)) return true;

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test context size by sending progressively larger payloads
// ---------------------------------------------------------------------------
async function testContextSize(chatUrl, headers, model) {
  const sizes = [4096, 16384, 32768, 65536, 131072];
  let maxWorking = 0;

  for (const size of sizes) {
    try {
      // Generate a message roughly `size` tokens (~4 chars per token)
      const padding = "word ".repeat(Math.min(size, 8000)); // limit actual test
      const resp = await postJSON(chatUrl, headers, {
        model,
        messages: [{ role: "user", content: `Count to 3. Context test: ${padding}` }],
        max_tokens: 20,
      });
      if (resp.status < 400 && resp.data?.choices?.length > 0) {
        maxWorking = size;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return maxWorking || 4096;
}

// ---------------------------------------------------------------------------
// Load / save discovery data (raw scan results)
// ---------------------------------------------------------------------------
function loadDiscovery() {
  try {
    if (fs.existsSync(DISCOVERY_FILE)) {
      const data = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
      // Handle old format or missing models array
      if (!Array.isArray(data.models)) {
        log("discovery.json has old/incompatible format, resetting");
        return { models: [], last_scan: null, scan_count: 0 };
      }
      return data;
    }
  } catch {}
  return { models: [], last_scan: null, scan_count: 0 };
}

function saveDiscovery(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

// ---------------------------------------------------------------------------
// Write providers.json: merge seed + discovered
// ---------------------------------------------------------------------------
function isSupportedProvider(provider) {
  if (!provider || typeof provider !== "object") return false;
  if (!providerConfig.SUPPORTED_FAMILIES.includes(provider.family)) return false;
  if (provider.protocol !== SUPPORTED_PROTOCOLS[provider.family]) return false;
  return typeof provider.model === "string" && provider.model.startsWith(`${provider.family}/`);
}

function mergeProvidersConfig(seed, discoveredProviders, existingConfig) {
  const providerMap = new Map();

  // Load existing supported providers first (preserves prior scoped scan cycles).
  for (const p of (existingConfig?.providers || [])) {
    if (isSupportedProvider(p)) providerMap.set(p.name, p);
  }

  // Layer seed providers on top (source of truth for seed config)
  for (const sp of (seed.providers || [])) {
    const existing = providerMap.get(sp.name);
    if (existing) {
      // Keep alive/last_tested from existing, update config from seed
      providerMap.set(sp.name, { ...sp, seed: true, alive: existing.alive, last_tested: existing.last_tested });
    } else {
      providerMap.set(sp.name, { ...sp, seed: true, alive: true });
    }
  }

  // Merge current scan results (update alive status, add new discoveries)
  for (const dp of discoveredProviders) {
    if (providerMap.has(dp.name)) {
      const existing = providerMap.get(dp.name);
      existing.alive = dp.alive;
      existing.last_tested = dp.last_tested;
      providerMap.set(dp.name, existing);
    } else if (isSupportedProvider(dp)) {
      providerMap.set(dp.name, { ...dp, seed: false });
    }
  }

  return {
    version: Date.now(),
    generated: new Date().toISOString(),
    providers: Array.from(providerMap.values()),
    groups: seed.groups || providerConfig.GROUPS,
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeProvidersFile(seed, discoveredProviders) {
  let existingConfig = null;

  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      existingConfig = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    }
  } catch {}

  const config = mergeProvidersConfig(seed, discoveredProviders, existingConfig);

  try {
    ensureDataDir();
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 2));
    log(`Wrote providers.json: ${config.providers.length} providers (version ${config.version})`);
  } catch (err) {
    log(`ERROR: Failed to write providers.json: ${err.message}`);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Test seed providers for alive status
// ---------------------------------------------------------------------------
function loadProvidersFromFile() {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    }
  } catch {}
  return null;
}

function shouldProbeSeedProvider(provider, env = process.env) {
  if (!provider || typeof provider !== "object") return false;
  const key = (provider.key_env ? env[provider.key_env] : null) || provider.default_key || "";
  if (!key && !provider.no_auth) return true;
  if (!/^https?:\/\//.test(String(provider.url || ""))) return false;
  if (provider.family === "claude" || provider.family === "windsurf") return false;
  if (provider.protocol === "anthropic" || provider.protocol === "windsurf") return false;
  return true;
}

async function testSeedProviders(seed) {
  const results = [];
  const RETEST_OK_MS = 3.5 * 24 * 60 * 60_000; // retest alive providers every 3.5 days
  const RETEST_FAIL_MS = 2 * 60 * 60_000; // retest dead providers every 2h

  // Load existing test results from providers.json
  const existingConfig = loadProvidersFromFile();
  const existingProviders = new Map();
  if (existingConfig?.providers) {
    for (const p of existingConfig.providers) {
      if (p.last_tested) existingProviders.set(p.name, p);
    }
  }

  for (const sp of (seed.providers || [])) {
    const key = (sp.key_env ? process.env[sp.key_env] : null) || sp.default_key || "";
    if (!key && !sp.no_auth) {
      results.push({
        name: sp.name,
        alive: false,
        last_tested: new Date().toISOString(),
        reason: "no_key",
      });
      continue;
    }

    if (!shouldProbeSeedProvider(sp)) {
      results.push({
        name: sp.name,
        alive: true,
        last_tested: existingProviders.get(sp.name)?.last_tested || null,
        reason: "adapter_probe_skipped",
      });
      log(`  SKIP:  ${sp.name} (adapter probe not implemented)`);
      continue;
    }

    // Skip if recently tested — alive <3,5d, dead <6h
    const existing = existingProviders.get(sp.name);
    if (existing?.last_tested) {
      const age = Date.now() - new Date(existing.last_tested).getTime();
      if (existing.alive && age < RETEST_OK_MS) {
        results.push({ name: sp.name, alive: true, last_tested: existing.last_tested });
        log(`  SKIP:  ${sp.name} (alive, tested ${Math.round(age / 3600000)}h ago)`);
        continue;
      }
      if (!existing.alive && age < RETEST_FAIL_MS) {
        results.push({ name: sp.name, alive: false, last_tested: existing.last_tested });
        log(`  SKIP:  ${sp.name} (dead, tested ${Math.round(age / 3600000)}h ago)`);
        continue;
      }
    }

    // Build headers for test
    const headers = { ...(sp.headers || {}) };
    if (key && !(sp.no_auth && key === "anonymous" && !sp.kilo)) {
      if (sp.auth_style === "token") {
        headers["Authorization"] = `token ${key}`;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    }

    const chatOk = await testChat(resolveUrl(sp.url), headers, sp.model);

    results.push({
      name: sp.name,
      alive: chatOk,
      last_tested: new Date().toISOString(),
    });

    if (chatOk) {
      log(`  ALIVE: ${sp.name} (${sp.model})`);
    } else {
      log(`  DEAD:  ${sp.name} (${sp.model})`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main discovery scan
// ---------------------------------------------------------------------------
async function runDiscoveryScan() {
  log("Starting discovery scan...");
  const seed = loadSeed();
  const endpoints = getEndpoints();
  const discovery = loadDiscovery();
  const seedNames = new Set((seed.providers || []).map((p) => p.name));
  const knownModels = new Set(discovery.models.map((m) => `${m.provider}|${m.name || ""}|${m.model}`));
  let newCount = 0;
  let prevNewCount = 0;

  // Phase 1: Test all seed providers for alive status
  log("Phase 1: Testing seed providers...");
  const seedTestResults = await testSeedProviders(seed);

  // Phase 2: Scan endpoints for new models
  log("Phase 2: Scanning for new models...");
  const discoveredProviders = [];

  // Add seed test results
  for (const r of seedTestResults) {
    discoveredProviders.push(r);
  }

  for (const ep of endpoints) {
    log(`Scanning ${ep.name}...`);
    try {
      let models = [];
      if (ep.modelsUrl) {
        const resp = await fetchJSON(ep.modelsUrl, ep.headers);
        if (resp.status >= 400 || !resp.data?.data) {
          log(`  ${ep.name}: failed (HTTP ${resp.status})`);
          continue;
        }
        models = resp.data.data;
        log(`  ${ep.name}: ${models.length} models found`);
      } else {
        log(`  ${ep.name}: using built-in provider definitions`);
      }

      for (const provider of providersFromEndpointModels(ep, models)) {
        if (!provider.name || seedNames.has(provider.name)) continue;

        const uniqueKey = `${ep.name}|${provider.name}|${provider.model}`;
        if (knownModels.has(uniqueKey)) continue;

        discovery.models.push({
          provider: ep.name,
          name: provider.name,
          model: provider.model,
          upstream_model: provider.upstream_model,
          context_length: provider.context,
          capabilities: provider.caps,
          discovered_at: new Date().toISOString(),
          chat_tested: false,
        });
        knownModels.add(uniqueKey);
        discoveredProviders.push(provider);
        newCount++;
        log(`  NEW: ${provider.name} (${provider.model}) caps=[${provider.caps.join(",")}]`);
      }
    } catch (err) {
      log(`  ${ep.name}: error - ${err.message}`);
    }

    // Incremental write: after each endpoint scan, update providers.json
    // so new providers are available to the proxy immediately (hot-reload via fs.watch)
    if (newCount > prevNewCount) {
      writeProvidersFile(seed, discoveredProviders);
      log(`  → Incremental write: ${newCount - prevNewCount} new providers available now`);
    }
    prevNewCount = newCount;
  }

  // Save raw discovery data
  discovery.last_scan = new Date().toISOString();
  discovery.scan_count = (discovery.scan_count || 0) + 1;
  saveDiscovery(discovery);

  // Phase 3: Write merged providers.json
  log("Phase 3: Writing providers.json...");
  writeProvidersFile(seed, discoveredProviders);

  log(`Discovery scan complete. ${newCount} new models found. Total discovery entries: ${discovery.models.length}`);
}

// ---------------------------------------------------------------------------
// Generate initial providers.json from seed (no scanning)
// ---------------------------------------------------------------------------
function generateInitialProvidersFile() {
  if (fs.existsSync(PROVIDERS_FILE)) {
    log("providers.json already exists, skipping initial generation");
    return;
  }

  log("No providers.json found, generating initial from seed...");
  const seed = loadSeed();

  const providers = (seed.providers || []).map((sp) => ({
    ...sp,
    alive: true,
    seed: true,
    last_tested: null,
  }));

  const config = {
    version: 1,
    generated: new Date().toISOString(),
    providers,
    groups: seed.groups || providerConfig.GROUPS,
  };

  try {
    ensureDataDir();
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 2));
    log(`Generated initial providers.json with ${providers.length} seed providers`);
  } catch (err) {
    log(`ERROR: Failed to write initial providers.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function log(msg) {
  console.log(`[${new Date().toISOString()}] [discovery] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  ensureDataDir();
  log("LLM Discovery daemon starting...");
  log(`Scan interval: ${SCAN_INTERVAL / 3600000}h`);
  log(`Data dir: ${DATA_DIR}`);
  log(`Seed file: ${SEED_FILE}`);
  log(`Providers file: ${PROVIDERS_FILE}`);

  // On first run, generate initial providers.json from seed if missing
  generateInitialProvidersFile();

  // Initial scan after 10s
  setTimeout(async () => {
    await runDiscoveryScan().catch((e) => log(`Scan error: ${e.message}`));
  }, 10_000);

  // Periodic scan every 6 hours
  setInterval(async () => {
    await runDiscoveryScan().catch((e) => log(`Scan error: ${e.message}`));
  }, SCAN_INTERVAL);
}

module.exports = {
  getEndpoints,
  providersFromEndpointModels,
  shouldProbeSeedProvider,
  mergeProvidersConfig,
  loadSeed,
  writeProvidersFile,
  generateInitialProvidersFile,
  runDiscoveryScan,
};

if (require.main === module) {
  main();
}
