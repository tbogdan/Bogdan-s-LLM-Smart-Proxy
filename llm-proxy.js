#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.LLM_PROXY_PORT || "18900", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const DISCOVERY_FILE = path.join(DATA_DIR, "discovery.json");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");
const SEED_FILE = path.join(__dirname, "seed-providers.json");
const REQUEST_TIMEOUT = 120_000; // 120s per provider attempt
const COOLDOWN_MS = 1000; // per-provider cooldown on 429
const QUOTA_DISABLED_FILE = path.join(DATA_DIR, "quota-disabled.json");
const THINKING_PROBE_INTERVAL = 10 * 60_000; // 10 min

// Ensure data dir
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ---------------------------------------------------------------------------
// Dynamic provider state (loaded from providers.json or seed)
// ---------------------------------------------------------------------------
let PROVIDERS = [];
let GROUPS = {};
let providersVersion = 0;

// ---------------------------------------------------------------------------
// Load seed providers as fallback
// ---------------------------------------------------------------------------
function loadSeedProviders() {
  try {
    const raw = fs.readFileSync(SEED_FILE, "utf8");
    const seed = JSON.parse(raw);
    return hydrateSeedProviders(seed);
  } catch (err) {
    log(`WARN: Failed to load seed-providers.json: ${err.message}`);
    return { providers: [], groups: {} };
  }
}

// ---------------------------------------------------------------------------
// Hydrate seed format into runtime provider objects
// ---------------------------------------------------------------------------
function resolveUrl(url) {
  // Cloudflare: replace /accounts/me/ with actual account ID
  if (url.includes("cloudflare.com") && url.includes("/accounts/me/") && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return url.replace("/accounts/me/", `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/`);
  }
  return url;
}

function hydrateSeedProviders(config) {
  const providers = [];
  for (const p of (config.providers || [])) {
    providers.push({
      name: p.name,
      url: resolveUrl(p.url),
      key: (p.key_env ? process.env[p.key_env] : null) || p.default_key || (p.no_auth ? "anonymous" : ""),
      key_env: p.key_env || "",
      no_auth: !!p.no_auth,
      model: p.model,
      context: p.context || 131072,
      tier: p.tier || 2,
      tc: !!p.tc,
      caps: p.caps || ["text"],
      headers: p.headers || {},
      authHeader: p.auth_style || null,
      kilo: !!p.kilo,
      alive: p.alive !== false,
      seed: true,
    });
  }
  const groups = config.groups || {
    "auto-free": null,
    "auto-tools": "tools",
    "auto-coding": "coding",
    "auto-images": "images",
    "auto-video": "video",
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking",
  };
  return { providers, groups };
}

// ---------------------------------------------------------------------------
// Load providers from /data/providers.json (written by discovery)
// ---------------------------------------------------------------------------
function loadProvidersFromFile() {
  try {
    if (!fs.existsSync(PROVIDERS_FILE)) return null;
    const raw = fs.readFileSync(PROVIDERS_FILE, "utf8");
    const config = JSON.parse(raw);
    if (!config.providers || !Array.isArray(config.providers)) return null;
    return config;
  } catch (err) {
    log(`WARN: Failed to parse providers.json: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hydrate providers.json format into runtime objects
// ---------------------------------------------------------------------------
function hydrateProvidersFile(config) {
  const providers = [];
  for (const p of (config.providers || [])) {
    providers.push({
      name: p.name,
      url: resolveUrl(p.url),
      key: (p.key_env ? process.env[p.key_env] : null) || p.default_key || (p.no_auth ? "anonymous" : ""),
      key_env: p.key_env || "",
      no_auth: !!p.no_auth,
      model: p.model,
      context: p.context || 131072,
      tier: p.tier || 2,
      tc: !!p.tc,
      caps: p.caps || ["text"],
      headers: p.headers || {},
      authHeader: p.auth_style || null,
      kilo: !!p.kilo,
      alive: p.alive !== false,
      seed: !!p.seed,
    });
  }
  const groups = config.groups || {
    "auto-free": null,
    "auto-tools": "tools",
    "auto-coding": "coding",
    "auto-images": "images",
    "auto-video": "video",
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking",
  };
  return { providers, groups };
}

// ---------------------------------------------------------------------------
// Load providers: try providers.json first, fall back to seed
// ---------------------------------------------------------------------------
function loadProviders() {
  const fileConfig = loadProvidersFromFile();
  if (fileConfig) {
    const result = hydrateProvidersFile(fileConfig);
    PROVIDERS = result.providers;
    GROUPS = result.groups;
    providersVersion = fileConfig.version || 0;
    const active = PROVIDERS.filter((p) => p.key && p.alive).length;
    log(`Loaded ${PROVIDERS.length} providers from providers.json (${active} active, version ${providersVersion})`);
  } else {
    const seed = loadSeedProviders();
    PROVIDERS = seed.providers;
    GROUPS = seed.groups;
    providersVersion = 0;
    const active = PROVIDERS.filter((p) => p.key && p.alive).length;
    log(`Loaded ${PROVIDERS.length} providers from seed (${active} active, no providers.json yet)`);
  }
}

// ---------------------------------------------------------------------------
// Watch providers.json for changes (hot-reload)
// ---------------------------------------------------------------------------
function watchProvidersFile() {
  let debounce = null;
  const dir = path.dirname(PROVIDERS_FILE);

  // Use fs.watch on the directory (more reliable across platforms for new files)
  try {
    fs.watch(dir, (_eventType, filename) => {
      if (filename !== path.basename(PROVIDERS_FILE)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        log("providers.json changed, reloading...");
        const oldCount = PROVIDERS.length;
        loadProviders();
        log(`Reloaded ${PROVIDERS.length} providers (was ${oldCount})`);
      }, 500); // debounce 500ms to avoid rapid reloads
    });
    log(`Watching ${PROVIDERS_FILE} for changes`);
  } catch (err) {
    log(`WARN: Could not watch providers.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Scoring system
// ---------------------------------------------------------------------------
let scores = {};

function loadScores() {
  try {
    if (fs.existsSync(SCORES_FILE)) {
      scores = JSON.parse(fs.readFileSync(SCORES_FILE, "utf8"));
    }
  } catch { scores = {}; }
}

function saveScores() {
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2)); } catch {}
}

function getScore(name) {
  if (!scores[name]) {
    scores[name] = { requests: 0, successes: 0, failures: 0, total_latency: 0, avg_latency: 0, success_rate: 1.0, last_error: null, cooldown_until: 0, thinking_ok: 0 };
  }
  return scores[name];
}

function recordSuccess(name, latency) {
  const s = getScore(name);
  s.requests++;
  s.successes++;
  s.total_latency += latency;
  s.avg_latency = Math.round(s.total_latency / s.successes);
  s.success_rate = s.successes / s.requests;
  s.last_error = null;
  saveScores();
}

function recordFailure(name, error) {
  const s = getScore(name);
  s.requests++;
  s.failures++;
  s.success_rate = s.requests > 0 ? s.successes / s.requests : 0;
  s.last_error = { message: String(error), time: Date.now() };
  saveScores();
}

function setCooldown(name) {
  const s = getScore(name);
  s.cooldown_until = Date.now() + COOLDOWN_MS;
}

function isOnCooldown(name) {
  const s = getScore(name);
  return Date.now() < (s.cooldown_until || 0);
}

// ---------------------------------------------------------------------------
// Quota exhaustion detection (Alibaba "Free Quota Only" mode)
// ---------------------------------------------------------------------------
let quotaDisabled = {}; // { providerName: { time, reason } }

function loadQuotaDisabled() {
  try {
    if (fs.existsSync(QUOTA_DISABLED_FILE)) {
      quotaDisabled = JSON.parse(fs.readFileSync(QUOTA_DISABLED_FILE, "utf8"));
    }
  } catch { quotaDisabled = {}; }
}

function saveQuotaDisabled() {
  try { fs.writeFileSync(QUOTA_DISABLED_FILE, JSON.stringify(quotaDisabled, null, 2)); } catch {}
}

function disableProviderQuota(name, reason) {
  quotaDisabled[name] = { time: Date.now(), reason };
  const provider = PROVIDERS.find((p) => p.name === name);
  if (provider) provider.alive = false;
  saveQuotaDisabled();
  log(`QUOTA EXHAUSTED: ${name} disabled — ${reason}`);
}

function isQuotaDisabled(name) {
  return !!quotaDisabled[name];
}

function isQuotaExhaustedError(statusCode, body) {
  if (statusCode === 403 && body.includes("FreeTierOnly")) return true;
  if (statusCode === 403 && body.includes("AllocationQuota")) return true;
  if (statusCode === 429 && body.includes("Free allocated quota exceeded")) return true;
  if (statusCode === 429 && body.includes("AllocationQuota")) return true;
  if (statusCode === 400 && body.includes("Arrearage")) return true;
  if (statusCode === 429 && body.includes("PrepaidBillOverdue")) return true;
  if (statusCode === 429 && body.includes("PostpaidBillOverdue")) return true;
  return false;
}

function recordThinkingOk(name) {
  const s = getScore(name);
  s.thinking_ok = (s.thinking_ok || 0) + 1;
  saveScores();
}

// Provider scoring for ranking within a group
function providerScore(p) {
  const s = getScore(p.name);
  const rate = s.requests > 0 ? s.success_rate : 1.0;
  const latPenalty = s.avg_latency > 0 ? Math.min(s.avg_latency / 30000, 1) : 0;
  const tierBonus = (4 - p.tier) * 0.2; // tier 1 = 0.6, tier 2 = 0.4, tier 3 = 0.2
  return rate * 0.5 + (1 - latPenalty) * 0.3 + tierBonus;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function makeRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(parsed, options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("utf8") });
      });
    });
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

function streamRequest(urlStr, options, body, onData, onEnd, onError) {
  const parsed = new URL(urlStr);
  const mod = parsed.protocol === "https:" ? https : http;
  const req = mod.request(parsed, options, (res) => {
    if (res.statusCode >= 400) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        onError(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`), res.statusCode);
      });
      return;
    }
    res.on("data", onData);
    res.on("end", onEnd);
    res.on("error", onError);
  });
  req.on("error", (e) => onError(e));
  req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(new Error("timeout")); });
  if (body) req.write(body);
  req.end();
  return req;
}

// ---------------------------------------------------------------------------
// Request transformation
// ---------------------------------------------------------------------------
function transformRequest(provider, reqBody) {
  const body = { ...reqBody };
  body.model = provider.model;

  // Qwen3 models: add enable_thinking if thinking capable
  if (provider.tc && /qwen3|qwq/i.test(provider.model)) {
    if (!body.extra_body) body.extra_body = {};
    body.extra_body.enable_thinking = true;
  }

  // Pass through reasoning_effort if present
  // Some providers use it natively

  return body;
}

// ---------------------------------------------------------------------------
// Thinking detection in response
// ---------------------------------------------------------------------------
function detectThinking(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    const choice = data.choices?.[0];
    if (!choice) return false;
    // Check reasoning_content
    if (choice.message?.reasoning_content) return true;
    // Check thinking field
    if (choice.message?.thinking) return true;
    // Check <think> tags
    const content = choice.message?.content || "";
    if (/<think>[\s\S]*?<\/think>/i.test(content)) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Build headers for provider
// ---------------------------------------------------------------------------
function buildHeaders(provider, extraHeaders) {
  const headers = {
    "Content-Type": "application/json",
    ...(provider.headers || {}),
    ...(extraHeaders || {}),
  };

  if (provider.key && !(provider.no_auth && provider.key === "anonymous" && !provider.kilo)) {
    if (provider.authHeader === "token") {
      headers["Authorization"] = `token ${provider.key}`;
    } else {
      headers["Authorization"] = `Bearer ${provider.key}`;
    }
  }

  // Legacy kilo flag support (headers should already be in provider.headers from config)
  if (provider.kilo && !headers["User-Agent"]) {
    headers["User-Agent"] = "Kilo-Code/7.2.0";
    headers["HTTP-Referer"] = "https://kilocode.ai";
    headers["X-Title"] = "Kilo Code";
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Provider selection for groups
// ---------------------------------------------------------------------------
function getProvidersForGroup(groupName) {
  const cap = GROUPS[groupName];
  let candidates;
  if (cap === null || cap === undefined) {
    candidates = PROVIDERS.filter((p) => p.key && p.alive !== false);
  } else {
    candidates = PROVIDERS.filter((p) => p.key && p.alive !== false && p.caps.includes(cap));
  }
  // Sort by score descending, skip cooldowns and quota-disabled
  return candidates
    .filter((p) => !isOnCooldown(p.name) && !isQuotaDisabled(p.name))
    .sort((a, b) => providerScore(b) - providerScore(a));
}

function findProviderByModel(model) {
  const alive = PROVIDERS.filter((p) => p.alive !== false);
  // Exact match
  let p = alive.find((p) => p.model === model && p.key);
  if (p) return p;
  // Name match
  p = alive.find((p) => p.name.toLowerCase() === model.toLowerCase() && p.key);
  if (p) return p;
  // Partial match
  p = alive.find((p) => p.model.includes(model) && p.key);
  return p || null;
}

// ---------------------------------------------------------------------------
// Route a single request to a provider (non-streaming)
// ---------------------------------------------------------------------------
async function routeToProvider(provider, reqBody) {
  const body = transformRequest(provider, reqBody);
  const bodyStr = JSON.stringify(body);
  const headers = buildHeaders(provider);
  const start = Date.now();

  const resp = await makeRequest(provider.url, { method: "POST", headers }, bodyStr);
  const latency = Date.now() - start;

  if (resp.status >= 400) {
    if (isQuotaExhaustedError(resp.status, resp.body)) {
      disableProviderQuota(provider.name, `HTTP ${resp.status}: quota/billing error`);
    }
    throw { status: resp.status, body: resp.body, latency };
  }

  recordSuccess(provider.name, latency);

  // Thinking detection
  if (provider.tc && detectThinking(resp.body)) {
    recordThinkingOk(provider.name);
  }

  return resp;
}

// ---------------------------------------------------------------------------
// Route streaming request to a provider
// ---------------------------------------------------------------------------
function routeStreamToProvider(provider, reqBody, clientRes) {
  return new Promise((resolve, reject) => {
    const body = transformRequest(provider, reqBody);
    body.stream = true;
    const bodyStr = JSON.stringify(body);
    const headers = buildHeaders(provider);
    const start = Date.now();
    let headersSent = false;

    streamRequest(
      provider.url,
      { method: "POST", headers },
      bodyStr,
      (chunk) => {
        if (!headersSent) {
          clientRes.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-LLM-Provider": provider.name,
          });
          headersSent = true;
        }
        clientRes.write(chunk);
      },
      () => {
        const latency = Date.now() - start;
        recordSuccess(provider.name, latency);
        if (headersSent) {
          clientRes.end();
        }
        resolve({ streamed: true, headersSent });
      },
      (err, statusCode) => {
        const latency = Date.now() - start;
        if (statusCode === 429) setCooldown(provider.name);
        if (isQuotaExhaustedError(statusCode, err.message || "")) {
          disableProviderQuota(provider.name, `HTTP ${statusCode}: quota/billing error`);
        }
        recordFailure(provider.name, err.message);
        reject({ error: err, statusCode, headersSent, latency });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Main routing with group failover
// ---------------------------------------------------------------------------
async function handleChatCompletion(reqBody, clientRes) {
  const requestedModel = reqBody.model || "auto-free";
  const isStreaming = reqBody.stream === true;
  const isGroup = requestedModel in GROUPS;

  if (isGroup) {
    const providers = getProvidersForGroup(requestedModel);
    if (providers.length === 0) {
      return sendError(clientRes, 503, "No providers available for group: " + requestedModel);
    }

    const errors = [];
    for (const provider of providers) {
      try {
        if (isStreaming) {
          await routeStreamToProvider(provider, reqBody, clientRes);
          return; // success
        } else {
          const resp = await routeToProvider(provider, reqBody);
          clientRes.writeHead(resp.status, {
            "Content-Type": "application/json",
            "X-LLM-Provider": provider.name,
          });
          clientRes.end(resp.body);
          return; // success
        }
      } catch (err) {
        // If streaming already sent headers, we cannot retry
        if (err.headersSent) {
          clientRes.end();
          return;
        }
        const status = err.status || err.statusCode || 500;
        const msg = err.body || err.error?.message || String(err);
        if (status === 429) setCooldown(provider.name);
        recordFailure(provider.name, msg);
        errors.push({ provider: provider.name, status, error: typeof msg === "string" ? msg.substring(0, 200) : String(msg) });
        continue; // try next provider
      }
    }

    // ALL providers in group failed
    return sendError(clientRes, 503, "All providers in group failed", { group: requestedModel, attempts: errors });
  }

  // Direct provider/model routing
  const provider = findProviderByModel(requestedModel);
  if (!provider) {
    return sendError(clientRes, 404, "Model not found: " + requestedModel);
  }

  try {
    if (isStreaming) {
      await routeStreamToProvider(provider, reqBody, clientRes);
    } else {
      const resp = await routeToProvider(provider, reqBody);
      clientRes.writeHead(resp.status, {
        "Content-Type": "application/json",
        "X-LLM-Provider": provider.name,
      });
      clientRes.end(resp.body);
    }
  } catch (err) {
    if (err.headersSent) { clientRes.end(); return; }
    const status = err.status || err.statusCode || 502;
    recordFailure(provider.name, err.body || err.error?.message || "unknown");
    if (status === 429) setCooldown(provider.name);
    sendError(clientRes, status, "Provider error", { provider: provider.name, detail: typeof err.body === "string" ? err.body.substring(0, 500) : undefined });
  }
}

// ---------------------------------------------------------------------------
// Models endpoint
// ---------------------------------------------------------------------------
function handleModels(query) {
  const capFilter = query.get("cap");
  let list = PROVIDERS.filter((p) => p.key && p.alive !== false);
  if (capFilter) {
    list = list.filter((p) => p.caps.includes(capFilter));
  }

  const models = list.map((p) => ({
    id: p.model,
    object: "model",
    created: 0,
    owned_by: p.name,
    capabilities: p.caps,
    context_length: p.context,
    tier: p.tier,
    thinking_capable: p.tc,
  }));

  // Add smart groups
  const groups = Object.keys(GROUPS).map((g) => ({
    id: g,
    object: "model",
    created: 0,
    owned_by: "llm-proxy",
    capabilities: g === "auto-free" ? ["all"] : [GROUPS[g]],
    context_length: 131072,
    tier: 0,
    thinking_capable: g === "auto-thinking",
    is_group: true,
    provider_count: getProvidersForGroup(g).length,
  }));

  return { object: "list", data: [...groups, ...models] };
}

// ---------------------------------------------------------------------------
// Capabilities endpoint
// ---------------------------------------------------------------------------
function handleCapabilities() {
  const caps = {};
  const allCaps = new Set();
  for (const p of PROVIDERS) {
    if (!p.key || p.alive === false) continue;
    for (const c of p.caps) {
      allCaps.add(c);
      if (!caps[c]) caps[c] = { providers: [], count: 0 };
      caps[c].providers.push(p.name);
      caps[c].count++;
    }
  }
  return {
    capabilities: caps,
    groups: Object.keys(GROUPS).map((g) => ({
      name: g,
      capability: GROUPS[g],
      provider_count: getProvidersForGroup(g).length,
    })),
    total_providers: PROVIDERS.filter((p) => p.key && p.alive !== false).length,
    total_capabilities: allCaps.size,
  };
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------
function handleHealth() {
  const active = PROVIDERS.filter((p) => p.key && p.alive !== false);
  const byTier = { 1: 0, 2: 0, 3: 0 };
  for (const p of active) byTier[p.tier] = (byTier[p.tier] || 0) + 1;

  return {
    status: "ok",
    uptime: process.uptime(),
    providers_version: providersVersion,
    providers_source: fs.existsSync(PROVIDERS_FILE) ? "providers.json" : "seed",
    providers: {
      total: PROVIDERS.length,
      active: active.length,
      by_tier: byTier,
    },
    groups: Object.keys(GROUPS).map((g) => ({
      name: g,
      available: getProvidersForGroup(g).length,
    })),
    quota_disabled: Object.keys(quotaDisabled).length > 0 ? quotaDisabled : undefined,
    scores_file: fs.existsSync(SCORES_FILE),
    discovery_file: fs.existsSync(DISCOVERY_FILE),
    providers_file: fs.existsSync(PROVIDERS_FILE),
  };
}

// ---------------------------------------------------------------------------
// Scores endpoint
// ---------------------------------------------------------------------------
function handleScores() {
  return scores;
}

// ---------------------------------------------------------------------------
// Discovery endpoint
// ---------------------------------------------------------------------------
function handleDiscovery() {
  try {
    if (fs.existsSync(DISCOVERY_FILE)) {
      return JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
    }
  } catch {}
  return { models: [], last_scan: null };
}

// ---------------------------------------------------------------------------
// Thinking probe
// ---------------------------------------------------------------------------
async function probeThinking() {
  const thinkingProviders = PROVIDERS.filter((p) => p.key && p.tc && p.alive !== false);
  for (const p of thinkingProviders) {
    try {
      const body = transformRequest(p, {
        messages: [{ role: "user", content: "What is 15 * 37? Think step by step." }],
        max_tokens: 500,
      });
      const resp = await makeRequest(p.url, {
        method: "POST",
        headers: buildHeaders(p),
      }, JSON.stringify(body));

      if (resp.status < 400 && detectThinking(resp.body)) {
        recordThinkingOk(p.name);
        log(`Thinking OK: ${p.name}`);
      }
    } catch {
      // skip
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function sendError(res, status, message, details) {
  const body = JSON.stringify({ error: { message, type: "proxy_error", ...details } });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    // POST /v1/chat/completions
    if (method === "POST" && pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return sendError(res, 400, "Invalid JSON body");
      }
      log(`Request: model=${parsed.model || "auto-free"} stream=${!!parsed.stream} messages=${parsed.messages?.length || 0}`);
      return await handleChatCompletion(parsed, res);
    }

    // GET /v1/models
    if (method === "GET" && pathname === "/v1/models") {
      return sendJSON(res, handleModels(urlObj.searchParams));
    }

    // GET /v1/capabilities
    if (method === "GET" && pathname === "/v1/capabilities") {
      return sendJSON(res, handleCapabilities());
    }

    // GET /health
    if (method === "GET" && pathname === "/health") {
      return sendJSON(res, handleHealth());
    }

    // GET /scores
    if (method === "GET" && pathname === "/scores") {
      return sendJSON(res, handleScores());
    }

    // GET /discovery
    if (method === "GET" && pathname === "/discovery") {
      return sendJSON(res, handleDiscovery());
    }

    // 404
    sendError(res, 404, "Not found");
  } catch (err) {
    log(`Server error: ${err.message}`);
    sendError(res, 500, "Internal server error", { detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
loadScores();
loadQuotaDisabled();
loadProviders();
watchProvidersFile();

// Re-apply quota disables to loaded providers
for (const name of Object.keys(quotaDisabled)) {
  const p = PROVIDERS.find((pr) => pr.name === name);
  if (p) p.alive = false;
}

server.listen(PORT, () => {
  const active = PROVIDERS.filter((p) => p.key && p.alive !== false).length;
  log(`LLM Smart Proxy started on port ${PORT}`);
  log(`Active providers: ${active}/${PROVIDERS.length}`);
  log(`Smart groups: ${Object.keys(GROUPS).join(", ")}`);
  log(`Config source: ${fs.existsSync(PROVIDERS_FILE) ? "providers.json" : "seed-providers.json (fallback)"}`);
  log(`Endpoints: /v1/chat/completions, /v1/models, /v1/capabilities, /health, /scores, /discovery`);
});

// Run thinking probe on startup (after 5s) and every 10min
setTimeout(() => {
  log("Running initial thinking probe...");
  probeThinking().catch(() => {});
}, 5000);

setInterval(() => {
  log("Running thinking probe...");
  probeThinking().catch(() => {});
}, THINKING_PROBE_INTERVAL);

// Save scores on exit
process.on("SIGTERM", () => { saveScores(); process.exit(0); });
process.on("SIGINT", () => { saveScores(); process.exit(0); });
