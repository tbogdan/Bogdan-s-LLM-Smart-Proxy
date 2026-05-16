#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const mempalace = require("./llm-mempalace");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.LLM_PROXY_PORT || "18900", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const DISCOVERY_FILE = path.join(DATA_DIR, "discovery.json");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");
const SEED_FILE = path.join(__dirname, "seed-providers.json");
const REQUEST_TIMEOUT = 300_000; // 5min per provider attempt (large contexts need time)
const COOLDOWN_MS = 30_000; // 30s per-provider cooldown on 429
const QUOTA_DISABLED_FILE = path.join(DATA_DIR, "quota-disabled.json");
const THINKING_PROBE_INTERVAL = 60 * 60_000; // 1 hour

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
        probeThinking().catch(() => {}); // probe new unverified providers
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

function setCooldown(name, durationMs) {
  const s = getScore(name);
  s.cooldown_until = Date.now() + (durationMs || COOLDOWN_MS);
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

const QUOTA_COOLDOWN_MS = 3.5 * 60 * 60_000; // 3.5 hours — retry after cooldown

function disableProviderQuota(name, reason) {
  quotaDisabled[name] = { time: Date.now(), reason };
  saveQuotaDisabled();
  setCooldown(name, QUOTA_COOLDOWN_MS);
  log(`QUOTA: ${name} cooled 3.5h — ${reason}`);
}

function isQuotaDisabled(name) {
  const entry = quotaDisabled[name];
  if (!entry) return false;
  // Auto-expire after 3.5h
  if (Date.now() - entry.time > QUOTA_COOLDOWN_MS) {
    delete quotaDisabled[name];
    saveQuotaDisabled();
    log(`QUOTA-RETRY: ${name} re-enabled after 3.5h`);
    return false;
  }
  return true;
}

function isQuotaExhaustedError(statusCode, body) {
  if (statusCode === 403 && body.includes("FreeTierOnly")) return true;
  if (statusCode === 403 && body.includes("AllocationQuota")) return true;
  if (statusCode === 429 && body.includes("Free allocated quota exceeded")) return true;
  if (statusCode === 429 && body.includes("AllocationQuota")) return true;
  if (statusCode === 400 && body.includes("Arrearage")) return true;
  if (statusCode === 429 && body.includes("PrepaidBillOverdue")) return true;
  if (statusCode === 429 && body.includes("PostpaidBillOverdue")) return true;
  // SiliconFlow / generic balance errors
  if (statusCode === 403 && /insufficient|balance/i.test(body)) return true;
  if (statusCode === 402) return true; // Payment Required
  // Ollama / generic usage limit
  if (statusCode === 429 && /usage limit|weekly.*limit|monthly.*limit/i.test(body)) return true;
  return false;
}

// Temporary rate limit — cooldown 1 hour, not permanent disable
function isTemporaryRateLimit(statusCode, body) {
  // Gemini quota exceeded
  if (statusCode === 429 && /exceeded.*current quota|quota.*exceeded/i.test(body)) return true;
  // Groq per-org token limit
  if (statusCode === 413 && /too large for model/i.test(body)) return true;
  // SambaNova daily token limit
  if (statusCode === 429 && /token limit|day.*token/i.test(body)) return true;
  // Generic 502 upstream unavailable
  if (statusCode === 502 && /upstream.*unavailable/i.test(body)) return true;
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
  const stallingPenalty = s.stalling > 0 ? Math.min(s.stalling * 0.05, 0.4) : 0; // -0.05 per stall, max -0.4
  return rate * 0.5 + (1 - latPenalty) * 0.3 + tierBonus - stallingPenalty;
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
// Token estimation (~4 chars per token, rough but fast)
// ---------------------------------------------------------------------------
function estimateTokens(messages) {
  let chars = 0;
  for (const m of (messages || [])) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.text) chars += part.text.length;
      }
    }
    if (m.reasoning_content) chars += m.reasoning_content.length;
    // Tool calls (assistant sending tool invocations)
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += (tc.function?.name || "").length;
        chars += (tc.function?.arguments || "").length;
      }
    }
    // Tool results (role=tool responses)
    if (m.role === "tool" && typeof m.content === "string") {
      // already counted above, but ensure tool name counted
      chars += (m.name || "").length;
    }
  }
  return Math.ceil(chars / 4);
}

// Also estimate tools definition array size
function estimateToolsTokens(tools) {
  if (!tools?.length) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4);
}

// ---------------------------------------------------------------------------
// Smart context compaction — save middle to MemPalace, keep edges
// ---------------------------------------------------------------------------
function compactMessages(messages, targetTokens, maxOutputTokens, mempalaceRefs) {
  if (!messages || messages.length < 4) return null;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length < 6) return null;

  const firstUser = nonSystem[0];
  const lastN = nonSystem.slice(-4);
  const middle = nonSystem.slice(1, -4);

  if (middle.length === 0) return null;

  // Build summary with MemPalace references
  let summaryText = `[CONTEXT COMPACTED — ${middle.length} messages saved to memory]\n`;

  if (mempalaceRefs?.length > 0) {
    summaryText += "Saved to MemPalace (use memory recall to load details):\n";
    for (const ref of mempalaceRefs) {
      summaryText += `  → ${ref.title} [room: ${ref.room}] — ${ref.summary} (${ref.preview})\n`;
    }
  } else {
    // Fallback inline summary if no refs
    const middleSummary = middle.map((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      const toolInfo = m.tool_calls?.length ? ` [${m.tool_calls.length} tool calls]` : "";
      return `${m.role}: ${text.substring(0, 80).replace(/\n/g, " ")}${toolInfo}`;
    }).join("\n");
    summaryText += middleSummary.substring(0, 800) + "\n";
  }

  summaryText += "Continue from the most recent context below.";

  const summaryMsg = { role: "assistant", content: summaryText };
  const compacted = [...system, firstUser, summaryMsg, ...lastN];
  const newTokens = estimateTokens(compacted);

  if (newTokens + maxOutputTokens > targetTokens) {
    const lastTwo = nonSystem.slice(-2);
    const aggressiveCompacted = [...system, firstUser, summaryMsg, ...lastTwo];
    return { messages: aggressiveCompacted, removed: nonSystem.length - 3 };
  }

  return { messages: compacted, removed: middle.length };
}

// ---------------------------------------------------------------------------
// Auto-detected provider incompatibilities (learned from errors)
// ---------------------------------------------------------------------------
const COMPAT_FILE = path.join(DATA_DIR, "compat.json");
let providerCompat = {}; // { name: { no_reasoning: bool, no_extra_body: bool, max_tokens_cap: int } }

function loadCompat() {
  try {
    if (fs.existsSync(COMPAT_FILE)) {
      providerCompat = JSON.parse(fs.readFileSync(COMPAT_FILE, "utf8"));
    }
  } catch { providerCompat = {}; }
}

function saveCompat() {
  try { fs.writeFileSync(COMPAT_FILE, JSON.stringify(providerCompat, null, 2)); } catch {}
}

function getCompat(name) {
  if (!providerCompat[name]) providerCompat[name] = {};
  return providerCompat[name];
}

// Get effective context for a provider — uses learned real_context if available
function getEffectiveContext(provider) {
  const compat = getCompat(provider.name);
  if (compat.real_context && compat.real_context < provider.context) {
    return compat.real_context;
  }
  return provider.context || 131072;
}

function detectIncompatibility(providerName, statusCode, errorBody) {
  const body = String(errorBody);
  const c = getCompat(providerName);
  let changed = false;

  // reasoning_content rejected
  if (body.includes("reasoning_content") && (statusCode === 400 || statusCode === 422)) {
    if (!c.no_reasoning) {
      c.no_reasoning = true;
      changed = true;
      log(`COMPAT: ${providerName} rejects reasoning_content — will strip on future requests`);
    }
  }

  // extra_body / enable_thinking rejected
  if ((body.includes("extra_body") || body.includes("enable_thinking")) && (statusCode === 400 || statusCode === 422)) {
    if (!c.no_extra_body) {
      c.no_extra_body = true;
      changed = true;
      log(`COMPAT: ${providerName} rejects extra_body — will strip on future requests`);
    }
  }

  // max_tokens cap detected (e.g. "Range of max_tokens should be [1, 8192]")
  const maxMatch = body.match(/max_tokens.*?\[1,\s*(\d+)\]/i) || body.match(/max_tokens.*?maximum.*?(\d+)/i) || body.match(/Max size:\s*(\d+)\s*tokens/i);
  if (maxMatch && (statusCode === 400 || statusCode === 422)) {
    const cap = parseInt(maxMatch[1], 10);
    if (cap > 0 && (!c.max_tokens_cap || cap < c.max_tokens_cap)) {
      c.max_tokens_cap = cap;
      changed = true;
      log(`COMPAT: ${providerName} max_tokens capped at ${cap}`);
    }
  }

  // Context size too small (detect actual limit from error)
  const ctxMatch = body.match(/Max size:\s*(\d+)\s*tokens/i) || body.match(/maximum context length.*?(\d+)/i) || body.match(/max.*?(\d+)\s*tokens/i);
  if (ctxMatch && (statusCode === 400 || statusCode === 413)) {
    const limit = parseInt(ctxMatch[1], 10);
    if (limit > 1000 && (!c.real_context || limit < c.real_context)) { // ignore absurd values <1K
      c.real_context = limit;
      changed = true;
      log(`COMPAT: ${providerName} real context limit detected: ${limit} tokens`);
      // Update provider context in memory
      const p = PROVIDERS.find((pr) => pr.name === providerName);
      if (p && p.context > limit) p.context = limit;
    }
  }

  // Tools limit detected (e.g. "maximum number of items is 128")
  const toolsMatch = body.match(/tools.*?maximum.*?(\d+)/i) || body.match(/maximum number of items is (\d+)/i);
  if (toolsMatch && (statusCode === 400 || statusCode === 422)) {
    const cap = parseInt(toolsMatch[1], 10);
    if (cap > 0 && (!c.max_tools || cap < c.max_tools)) {
      c.max_tools = cap;
      changed = true;
      log(`COMPAT: ${providerName} max tools capped at ${cap}`);
    }
  }

  // stream_options rejected when stream=false
  if ((body.includes("stream_options") || body.includes("Stream options")) && (statusCode === 400 || statusCode === 422)) {
    if (!c.no_stream_options) {
      c.no_stream_options = true;
      changed = true;
      log(`COMPAT: ${providerName} rejects stream_options when stream=false — will strip`);
    }
  }

  // tool_choice rejected (no endpoints support it)
  if (body.includes("tool_choice") && (statusCode === 400 || statusCode === 404)) {
    if (!c.no_tool_choice) {
      c.no_tool_choice = true;
      changed = true;
      log(`COMPAT: ${providerName} rejects tool_choice — will strip`);
    }
  }

  // Content array not supported (must be string) — Cloudflare, BigModel
  if ((body.includes("not in 'string'") || body.includes("Type mismatch") || body.includes("调用参数有误")) && (statusCode === 400)) {
    if (!c.no_content_array) {
      c.no_content_array = true;
      changed = true;
      log(`COMPAT: ${providerName} rejects content arrays — will flatten to string`);
    }
  }

  // Character/content length limit (LLM7 anonymous: 8000 chars)
  const charMatch = body.match(/content length.*?exceeds limit of (\d+) characters/i);
  if (charMatch && (statusCode === 400)) {
    const charLimit = parseInt(charMatch[1], 10);
    // Convert chars to approximate tokens (÷4)
    const tokenLimit = Math.floor(charLimit / 4);
    if (tokenLimit > 0 && (!c.real_context || tokenLimit < c.real_context)) {
      c.real_context = tokenLimit;
      changed = true;
      log(`COMPAT: ${providerName} char limit ${charLimit} ≈ ${tokenLimit} tokens`);
      const p = PROVIDERS.find((pr) => pr.name === providerName);
      if (p && p.context > tokenLimit) p.context = tokenLimit;
    }
  }

  // Monthly/quota/usage limit (Kiro 402, Codex 500 "usage limit", etc.)
  if (body.includes("reached the limit") || body.includes("MONTHLY_REQUEST_COUNT") || body.includes("usage limit has been reached")) {
    // Long cooldown — quota limits are typically hourly/daily/monthly
    setCooldown(providerName, 3600_000); // 1 hour cooldown
    log(`QUOTA: ${providerName} quota/usage limit exhausted — cooldown 1h`);
  }

  // Context window from error (Cloudflare format: "exceeded this model context window limit (24000)")
  const cfCtxMatch = body.match(/context window limit \((\d+)\)/i) || body.match(/exceeded.*?(\d+)\)/i);
  if (cfCtxMatch && (statusCode === 413)) {
    const limit = parseInt(cfCtxMatch[1], 10);
    if (limit > 1000 && (!c.real_context || limit < c.real_context)) {
      c.real_context = limit;
      changed = true;
      log(`COMPAT: ${providerName} real context limit detected: ${limit} tokens`);
      const p = PROVIDERS.find((pr) => pr.name === providerName);
      if (p && p.context > limit) p.context = limit;
    }
  }

  // max_tokens must be ≤ N (Groq format: "must be less than or equal to `8192`")
  const maxLteMatch = body.match(/max_tokens.*?less than or equal to.*?(\d+)/i);
  if (maxLteMatch && (statusCode === 400)) {
    const cap = parseInt(maxLteMatch[1], 10);
    if (cap > 0 && (!c.max_tokens_cap || cap < c.max_tokens_cap)) {
      c.max_tokens_cap = cap;
      changed = true;
      log(`COMPAT: ${providerName} max_tokens capped at ${cap}`);
    }
  }

  if (changed) saveCompat();
}

// ---------------------------------------------------------------------------
// Request transformation
// ---------------------------------------------------------------------------
function transformRequest(provider, reqBody) {
  const body = { ...reqBody };
  body.model = provider.model;

  const compat = getCompat(provider.name);

  // Per-provider context compaction: if messages exceed this provider's effective context,
  // compact to fit (post-routing, provider-specific)
  if (body.messages && body.messages.length > 4) {
    const providerCtx = getEffectiveContext(provider);
    const currentTokens = estimateTokens(body.messages) + (body.max_tokens || 4096);
    if (currentTokens > providerCtx * 0.95) {
      const target = Math.floor(providerCtx * 0.75);
      const compacted = compactMessages(body.messages, target, body.max_tokens || 4096, []);
      if (compacted) {
        body.messages = compacted.messages;
        log(`POST-COMPACT: ${provider.name} context ${currentTokens}tok → ${estimateTokens(body.messages)}tok (provider limit: ${providerCtx})`);
      }
    }
  }

  // Qwen3 models: add enable_thinking (unless provider rejects it)
  if (provider.tc && /qwen3|qwq/i.test(provider.model) && !compat.no_extra_body) {
    if (!body.extra_body) body.extra_body = {};
    body.extra_body.enable_thinking = true;
  }

  // Strip extra_body for providers that reject it (auto-learned)
  if (body.extra_body && compat.no_extra_body) {
    delete body.extra_body;
  }

  // Strip reasoning_content from messages (auto-learned)
  if (body.messages && compat.no_reasoning) {
    body.messages = body.messages.map((m) => {
      if (m.reasoning_content) {
        const { reasoning_content, ...rest } = m;
        return rest;
      }
      return m;
    });
  }

  // Cap max_tokens (auto-learned from provider errors)
  if (compat.max_tokens_cap && body.max_tokens && body.max_tokens > compat.max_tokens_cap) {
    body.max_tokens = compat.max_tokens_cap;
  }

  // Cap tools array (auto-learned — e.g. Groq max 128)
  if (compat.max_tools && body.tools?.length > compat.max_tools) {
    body.tools = body.tools.slice(0, compat.max_tools);
  }

  // Strip stream_options when stream=false or when provider rejects it (auto-learned)
  if (body.stream_options && (!body.stream || compat.no_stream_options)) {
    delete body.stream_options;
  }

  // Strip tool_choice for providers that reject it (auto-learned)
  if (body.tool_choice && compat.no_tool_choice) {
    delete body.tool_choice;
  }

  // Fix empty function_response.name (Gemini rejects empty names)
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function && !tc.function.name) {
            tc.function.name = "unknown_tool";
          }
        }
      }
      // Fix tool role messages with empty name
      if (msg.role === "tool" && !msg.name && msg.tool_call_id) {
        msg.name = "unknown_tool";
      }
    }
  }

  // Flatten multipart content arrays to string for providers that reject them
  // (Cloudflare, BigModel only accept string content)
  if (body.messages && compat.no_content_array) {
    body.messages = body.messages.map((m) => {
      if (Array.isArray(m.content)) {
        const text = m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        return { ...m, content: text || "" };
      }
      return m;
    });
  }

  // Strip orphaned tool responses (tool role messages whose tool_call_id has no matching
  // assistant tool_call — causes 500 on OpenAI/Codex: "No tool call found for function call output")
  if (body.messages) {
    const validCallIds = new Set();
    for (const msg of body.messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) validCallIds.add(tc.id);
        }
      }
    }
    const before = body.messages.length;
    body.messages = body.messages.filter((m) => {
      if (m.role !== "tool") return true;
      if (!m.tool_call_id) return true;
      return validCallIds.has(m.tool_call_id);
    });
    const removed = before - body.messages.length;
    if (removed > 0) log(`TRANSFORM: stripped ${removed} orphaned tool responses`);
  }

  // Inject system instructions — identity, execution rules, memory, date/time
  if (body.messages && body.messages.length > 0) {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toISOString().replace("T", " ").substring(0, 19) + " UTC";

    let PROXY_SYSTEM = [
      `You are Bogdan's LLM Smart Proxy — senior staff engineer. Date: ${dateStr} ${timeStr}.`,
      "",
      "FLOW: UNDERSTAND→PLAN→CONFIRM→EXECUTE→VERIFY→SAVE",
      "UNDERSTAND: Read task. Scan files (package.json, configs, ls). Search memory. git status/log. Identify unknowns.",
      "PLAN: Steps + tech choices (project uses > user prefs > best practice). ONE consolidated confirmation if unknowns.",
      "EXECUTE: ALL steps, ALL files, ALL code in ONE response. Tools directly. [1/N] pattern.",
      "VERIFY: Run build/tests. Fix in same response.",
      "SAVE: Progress to memory with references.",
      "RESUME: \"continue\"/\"remember\" = search memory + git log + read files. No re-planning.",
      "",
      "TOOL STRATEGY:",
      "- Prefer dedicated tools over shell: Read>cat, Edit>sed, Grep>grep, Glob>find, Write>echo",
      "- ALWAYS read a file before editing it. Never guess file contents.",
      "- Make parallel tool calls when independent — don't serialize what can run together.",
      "- For complex/multi-file tasks: break into sub-tasks, execute sequentially, verify each.",
      "- If a tool fails: read error, diagnose root cause, try alternative. Don't retry blindly.",
      "- Verify paths exist before editing. Quote paths with spaces.",
      "- Tool args must be valid. Never pass undefined/null.",
      "",
      "CODE QUALITY:",
      "- Read existing code BEFORE proposing changes. Match existing patterns and conventions.",
      "- Minimal changes — don't refactor/add features beyond what's asked.",
      "- No comments/docstrings unless asked. No type annotations on code you didn't change.",
      "- No commit unless asked. No force push. No skip hooks.",
      "- Security: don't expose .env, credentials, API keys in output or commits.",
      "- On edit: use exact string matching. Include enough context to be unique.",
      "",
      "RULES:",
      "- Complete task fully. No stalling. No \"Let me check\" then stop.",
      "- FORBIDDEN: start with Great/Certainly/Okay/Sure. End with question when you can act.",
      "- On error: read error message, check assumptions, try focused fix. Don't retry identically.",
      "- Concise, direct. User's language. Markdown. Minimize tokens.",
      "- Search codebase + memory BEFORE asking user. Ask only if 4 sources fail.",
      "- <system-reminder> tags = useful info, NOT user input.",
      "",
      "VIOLATIONS (any = failure):",
      "Should I continue?|Shall I proceed?|Doriti sa continui?|Astept confirmarea|",
      "Please specify|Te rog sa mentionezi|Daca ai vreo preferinta|",
      "Let me check+stop|Voi continua cu X+not doing it|Ce urmeaza sa fac+not doing it|",
      "List work without executing|Ask what you can discover|Shell commands as text",
      "",
      "MEMORY: Proxy auto-injects. If MemPalace MCP available:",
      "START: mempalace_search({project} session/tasks/prefs/arch/problems)",
      "WORK: mempalace_add_drawer(title,content,room) — save decisions,progress",
      "END: save summary+refs. LONG CONTEXT: save+summarize+continue.",
      "",
      "DISCOVERY: On session start, identify available capabilities:",
      "- List available tools/functions — note which for file ops, search, browser, git, MCP",
      "- Check for skills/commands (CLAUDE.md, AGENTS.md, .kilo/, slash commands)",
      "- Check for MCP servers — mempalace, playwright, exa, context7, etc.",
      "- Read project config (CLAUDE.md/AGENTS.md/INSTRUCTIONS.md) — follow project rules.",
      "- Mental inventory of capabilities. Right tool for each sub-task. Tool exists = USE IT.",
    ].join("\n");

    // Append recalled memories from MemPalace
    if (reqBody._memoryInjection) {
      PROXY_SYSTEM += reqBody._memoryInjection;
    }

    // Smart merge with existing system message
    if (body.messages[0]?.role === "system") {
      let existingSystem = typeof body.messages[0].content === "string" ? body.messages[0].content : "";

      // Strip previously-injected proxy system prompt (prevents stacking on re-sends)
      const proxyMarker = "You are Bogdan's LLM Smart Proxy";
      const proxyEnd = "Right tool for each sub-task. Tool exists = USE IT.";
      const markerIdx = existingSystem.indexOf(proxyMarker);
      const endIdx = existingSystem.indexOf(proxyEnd);
      if (markerIdx !== -1 && endIdx !== -1) {
        existingSystem = existingSystem.substring(0, markerIdx) + existingSystem.substring(endIdx + proxyEnd.length);
      }

      // Strip previously-injected memory sections
      existingSystem = existingSystem.replace(/\n--- Recalled Memories ---[\s\S]*?(?=\n---|\n\n[A-Z#]|$)/g, "");

      // Replace ANY LLM identity line — keep tool/suggestion instructions
      existingSystem = existingSystem
        .replace(/^You are [^\n]{5,200}\n?/i, "") // any "You are X" identity line
        .replace(/^Tu esti [^\n]{5,200}\n?/i, "") // Romanian identity
        .replace(/# Personality\n[\s\S]*?(?=\n#|\n\n[A-Z])/i, "") // Personality section
        .replace(/# Identity[^\n]*\n[\s\S]*?(?=\n#|\n\n[A-Z])/i, "") // Identity section
        .trim();

      // Remove sections we already cover better
      existingSystem = existingSystem
        .replace(/# Proactiveness\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "") // we handle proactiveness
        .replace(/# Code style\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "") // we handle code style
        .replace(/# Tone and style\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "") // we handle tone
        .replace(/IMPORTANT:\s*-?\s*Answer concisely[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "") // we handle conciseness
        .trim();

      body.messages[0] = { ...body.messages[0], content: PROXY_SYSTEM + "\n\n" + existingSystem };
    } else {
      body.messages = [{ role: "system", content: PROXY_SYSTEM }, ...body.messages];
    }
  }

  // Deduplicate: remove repeated sentences/paragraphs in system message
  // (can happen when proxy injects over IDE's own injected system prompt across turns)
  if (body.messages?.[0]?.role === "system" && typeof body.messages[0].content === "string") {
    const sys = body.messages[0].content;
    const lines = sys.split("\n");
    const seen = new Set();
    const deduped = [];
    let removed = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip dedup for short lines (headers, blank, bullets under 20 chars)
      if (trimmed.length < 20 || trimmed.startsWith("#") || trimmed.startsWith("-")) {
        deduped.push(line);
        continue;
      }
      if (seen.has(trimmed)) {
        removed++;
        continue;
      }
      seen.add(trimmed);
      deduped.push(line);
    }
    if (removed > 0) {
      body.messages[0] = { ...body.messages[0], content: deduped.join("\n") };
      log(`DEDUP: removed ${removed} duplicate lines from system prompt`);
    }
  }

  // Deduplicate: remove consecutive identical messages in history
  // (can happen when compaction summary gets repeated)
  if (body.messages && body.messages.length > 3) {
    const before = body.messages.length;
    body.messages = body.messages.filter((msg, i) => {
      if (i === 0) return true; // keep system
      const prev = body.messages[i - 1];
      if (msg.role !== prev.role) return true;
      if (typeof msg.content !== "string" || typeof prev.content !== "string") return true;
      return msg.content !== prev.content;
    });
    const dupRemoved = before - body.messages.length;
    if (dupRemoved > 0) log(`DEDUP: removed ${dupRemoved} consecutive duplicate messages`);
  }

  // Strip internal proxy fields — providers reject unknown fields (Gemini)
  delete body._sessionLastProvider;
  delete body._memoryInjection;
  delete body._compactRetries;

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
// Stalling detection — model says "Let me check" without acting
// ---------------------------------------------------------------------------
const STALLING_PATTERNS = [
  /^let me (?:check|look|analyze|search|find|see|review|examine)/i,
  /^(?:i'll|i will) (?:check|look|analyze|search|find|review|examine)/i,
  /^(?:let me|i'll) (?:also )?(?:adjust|fix|update|modify)/i,
  /^checking/i,
  /^looking at/i,
  /^searching for/i,
];

// Fake execution: model outputs shell commands as text instead of tool calls
const FAKE_EXEC_PATTERNS = [
  /^(?:npm|npx|yarn|pnpm)\s+(?:run|install|build|start|dev|test)/m,
  /^docker(?:-compose)?\s+(?:build|up|push|pull|run|stop|restart)/m,
  /^(?:ssh|scp|rsync)\s+/m,
  /^(?:git\s+(?:add|commit|push|pull|clone|checkout))/m,
  /^(?:curl|wget)\s+/m,
  /^(?:mkdir|rm|cp|mv|chmod|chown)\s+/m,
  /^(?:cd|ls|cat|pwd)\s+/m,
];

function detectStalling(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    const choice = data.choices?.[0];
    if (!choice) return false;
    const content = (choice.message?.content || "").trim();
    const hasToolCalls = choice.message?.tool_calls?.length > 0;

    // If model made tool calls, not stalling — it acted
    if (hasToolCalls) return false;

    // Empty or very short response with no tool calls = stalling
    if (content.length < 5 && !hasToolCalls) return true;

    // Matches stalling pattern and response is short (< 200 chars)
    if (content.length < 200) {
      for (const pat of STALLING_PATTERNS) {
        if (pat.test(content)) return true;
      }
    }

    // Ends with question mark and short = asking instead of doing
    if (content.length < 300 && content.endsWith("?") && !hasToolCalls) {
      if (/\b(should I|shall I|do you want|would you like|can you)\b/i.test(content)) {
        return true;
      }
    }

    // Fake execution: outputs shell commands as text instead of calling tools
    if (!hasToolCalls) {
      let fakeCount = 0;
      for (const pat of FAKE_EXEC_PATTERNS) {
        if (pat.test(content)) fakeCount++;
      }
      // 2+ shell commands as text with tools available = fake execution
      if (fakeCount >= 2) return true;
    }

    return false;
  } catch {
    return false;
  }
}

function recordStalling(name) {
  const s = getScore(name);
  s.stalling = (s.stalling || 0) + 1;
  log(`STALLING: ${name} (count: ${s.stalling})`);
  saveScores();
}

// Per-group ban list — providers banned from specific groups due to repeated stalling
// Resets on restart (not persisted — stalling is context-dependent, not permanent)
const groupBans = {}; // { "groupName": Set<providerName> }

function banFromGroup(providerName, groupName) {
  if (!groupBans[groupName]) groupBans[groupName] = new Set();
  groupBans[groupName].add(providerName);
}

function isBannedFromGroup(providerName, groupName) {
  return groupBans[groupName]?.has(providerName) || false;
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
// Use-case detection from messages
// ---------------------------------------------------------------------------
function detectUseCase(messages, reqBody) {
  const caps = new Set();
  let isAgent = false;
  const last = messages?.[messages.length - 1];
  const lastContent = (typeof last?.content === "string" ? last.content : "").toLowerCase();

  // Tool definitions in request = IDE/agent → need tools + coding, tier 1
  if (reqBody?.tools?.length > 0 || reqBody?.functions?.length > 0) {
    caps.add("tools");
    caps.add("coding");
    isAgent = true;
  }

  // System prompt patterns for IDEs/agents
  const system = (messages || []).find((m) => m.role === "system");
  const sysContent = (typeof system?.content === "string" ? system.content : "").toLowerCase();
  if (/\b(claude code|cursor|copilot|cline|kilo.code|continue\.dev|aider|opencode)\b/i.test(sysContent)) {
    caps.add("tools");
    caps.add("coding");
    isAgent = true;
  }
  if (/\b(you are .*(assistant|agent|developer|engineer)|software engineering|codebase)\b/i.test(sysContent)) {
    caps.add("coding");
    isAgent = true;
  }

  // Tool calls in assistant messages = ongoing agent conversation
  for (const m of (messages || [])) {
    if (m.role === "assistant" && m.tool_calls?.length > 0) {
      caps.add("tools");
      caps.add("coding");
      isAgent = true;
    }
    if (m.role === "tool") {
      caps.add("tools");
      isAgent = true;
    }
    // Images
    if (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url" || p.type === "image")) {
      caps.add("images");
    }
  }

  // Coding signals in last message
  if (/\b(code|function|class|implement|refactor|debug|fix|write.*script|```|def |const |import |require\(|component|endpoint|api|test|error|bug|tsx?|jsx?|\.py|\.js)\b/i.test(lastContent)) {
    caps.add("coding");
  }

  // Thinking/reasoning signals
  if (/\b(think|reason|step by step|analyze|explain why|solve|prove|math|calculate)\b/i.test(lastContent)) {
    caps.add("thinking");
  }

  return { caps, isAgent };
}

// ---------------------------------------------------------------------------
// Smartness bonus — prefer larger, more capable, smarter models
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Model Knowledge Base — benchmark-backed per-category scoring
// Pattern → { coding, reasoning, tools, chat, vision, speed }
// S=0.5, A=0.35, B=0.2, C=0.05, null=0
// ---------------------------------------------------------------------------
const MODEL_SCORES = [
  // S-tier coding + reasoning
  { pat: /claude.*opus[- _.]4/i,                 coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /claude.*sonnet[- _.]4[._-]5/i,        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /claude.*sonnet[- _.]4(?![._-]5)/i,    coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.35 },
  { pat: /claude.*3[._-]7.*sonnet/i,            coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /claude.*haiku[- _.]4/i,               coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.5 },
  { pat: /claude.*3[._-]5.*sonnet/i,            coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /claude.*3[._-]5.*haiku/i,             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /gpt.*4\.1.*nano/i,                     coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /gpt.*4\.1.*mini/i,                     coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /gpt.*4\.1/i,                           coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.35 },
  { pat: /gemini.*3.*flash/i,                    coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.4 },
  { pat: /deepseek.*v3\.2/i,                     coding: 0.5, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3\.5.*397b/i,                    coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.15 },
  { pat: /qwen.*coder.*480b/i,                   coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.2, vision: 0, speed: 0.15 },
  { pat: /glm.*5\.1/i,                           coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3\.6.*max/i,                     coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  // A-tier
  { pat: /gemini.*2\.5.*pro/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.5, speed: 0.3 },
  { pat: /gemini.*2\.5.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /deepseek.*v4.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /gpt.*oss.*120b/i,                      coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.5 },
  { pat: /qwen.*coder.*(?:plus|next)/i,          coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /qwen.*3\.5.*122b/i,                    coding: 0.35, reasoning: 0.35, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /qwen.*max/i,                           coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /deepseek.*v3\.1/i,                     coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /deepseek.*r1/i,                        coding: 0.35, reasoning: 0.35, tools: 0.2, chat: 0.2, vision: 0, speed: 0.15 },
  { pat: /kimi.*k2\.5/i,                         coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /kimi.*k2\.6/i,                         coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /nemotron.*(?:120b|super)/i,            coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /gpt.*5\.[4-9]/i,                        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /gpt.*5.*pro/i,                         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.2 },
  { pat: /gpt.*5.*codex/i,                       coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /gpt.*5(?!\.\d)(?!.*mini|.*nano|.*pro|.*codex)/i, coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt.*5.*mini/i,                        coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.4 },
  { pat: /gpt.*5.*nano/i,                        coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /o3(?!.*mini)/i,                         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0, speed: 0.2 },
  { pat: /o3.*mini/i,                             coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /o4.*mini/i,                             coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /mistral.*medium/i,                     coding: 0.35, reasoning: 0.2, tools: 0.5, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /glm.*5(?!\.)/i,                        coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /minimax.*m2\.[57]/i,                   coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.35, vision: 0, speed: 0.3 },
  // B-tier
  { pat: /gpt.*4o/i,                             coding: 0.2, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  // gpt-4.1 handled in S/A-tier above
  { pat: /qwen.*235b/i,                          coding: 0.2, reasoning: 0.35, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /qwen.*32b/i,                           coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*plus/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /deepseek.*v3(?!\.)/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /llama.*3\.3.*70b/i,                    coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /llama.*4.*maverick/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.35, speed: 0.4 },
  { pat: /command.*a/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /kimi.*k2(?!\.)/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /laguna.*m\.?1/i,                       coding: 0.2, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.3 },
  { pat: /laguna.*xs/i,                          coding: 0.2, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.4 },
  { pat: /mistral.*small/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /glm.*4/i,                              coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /ring.*2\.6/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  // C-tier
  { pat: /llama.*4.*scout/i,                     coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0.2, speed: 0.4 },
  { pat: /command.*r.*plus/i,                    coding: 0.05, reasoning: 0.05, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /command.*r7b/i,                        coding: 0.05, reasoning: 0.05, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*turbo/i,                         coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /qwen.*(?:8b|14b|4b|0\.6b|1\.7b)/i,    coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /llama.*(?:8b|1b|3b)/i,                 coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /mistral.*(?:7b|8b|nemo)/i,             coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /gemma/i,                               coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /cobuddy/i,                             coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /phi/i,                                 coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
];

// Map group capability → score field
// Map proxy group capability → model score field
const CAP_TO_SCORE = {
  coding: "coding", thinking: "reasoning",
  tools: "tools", text: "chat", images: "vision", video: "vision",
  max: "quality", // max = best overall quality across all categories
};

// Heuristic scoring for models not in MODEL_SCORES — infer tier from name patterns
function inferModelScore(model, category) {
  const m = model.toLowerCase();
  // Size-based tier inference (bigger = generally smarter)
  const sizeMatch = m.match(/(\d+)b(?:\b|_)/);
  const sizeB = sizeMatch ? parseInt(sizeMatch[1]) : 0;
  // Known-good model families (any version) → at least B-tier
  const knownGood = /claude|gpt|gemini|deepseek|qwen|mistral|llama|command|kimi/.test(m);
  // Version hints: higher versions tend to be better
  const hasVersion = /[- _.](?:[4-9]|[1-9]\d)[._-]/.test(m);
  // Reasoning/thinking hints
  const isReasoning = /think|reason|r1|o[1-9]|cot/.test(m);
  // Speed hints
  const isFast = /flash|mini|nano|small|tiny|lite|turbo/.test(m);
  const isBig = /max|ultra|pro|large|mega|super/.test(m);

  let base = 0.1; // absolute minimum
  if (knownGood) base = 0.15;
  if (sizeB >= 70) base = Math.max(base, 0.2);
  if (sizeB >= 200) base = Math.max(base, 0.3);
  if (hasVersion && knownGood) base = Math.max(base, 0.2);
  if (isBig) base = Math.max(base, 0.2);

  if (category === "speed") {
    if (isFast) return 0.5;
    if (sizeB > 0 && sizeB <= 14) return 0.5;
    if (sizeB > 200) return 0.15;
    return 0.3;
  }
  if (category === "vision") return 0; // assume no vision unless explicitly matched
  if (category === "reasoning" && isReasoning) return Math.max(base, 0.3);
  return base;
}

function getModelScore(model, category) {
  const m = (model || "").toLowerCase();
  for (const entry of MODEL_SCORES) {
    if (entry.pat.test(m)) {
      if (category === "quality") {
        // Average of coding + reasoning + tools — overall quality metric
        return ((entry.coding || 0) + (entry.reasoning || 0) + (entry.tools || 0)) / 3;
      }
      return entry[category] || 0;
    }
  }
  // No explicit match — use heuristic inference
  if (category === "quality") {
    return (inferModelScore(m, "coding") + inferModelScore(m, "reasoning") + inferModelScore(m, "tools")) / 3;
  }
  return inferModelScore(m, category);
}

function smartnessBonus(p, groupCap, reqBody) {
  const model = p.model || "";
  const scoreField = CAP_TO_SCORE[groupCap] || "coding"; // default to coding

  // Primary: how good is this model for requested category
  let bonus = getModelScore(model, scoreField);

  // Secondary: speed bonus (fast models preferred when scores close)
  bonus += getModelScore(model, "speed") * 0.15;

  // Context bonus — scales with how much room the provider has for this request
  // Large requests need large context providers more urgently
  const reqTokens = reqBody?._estimatedTokens || 0;
  const effCtx = getEffectiveContext(p);
  if (reqTokens > 0 && effCtx > 0) {
    const utilization = reqTokens / effCtx; // 0.0 = plenty of room, 1.0 = full
    if (utilization < 0.3) bonus += 0.15;       // plenty of headroom
    else if (utilization < 0.6) bonus += 0.05;  // comfortable
    else if (utilization > 0.85) bonus -= 0.2;  // dangerously tight
  } else {
    // Fallback static bonus when no token estimate
    if (effCtx >= 1000000) bonus += 0.1;
    else if (effCtx >= 256000) bonus += 0.05;
    else if (effCtx < 32768) bonus -= 0.1;
  }

  return bonus;
}

// ---------------------------------------------------------------------------
// Provider selection — unified for all groups with smart fallback
// ---------------------------------------------------------------------------
function getProvidersForGroup(groupName, estimatedTokens, reqBody) {
  const cap = GROUPS[groupName];
  const { caps: detectedCaps, isAgent } = detectUseCase(reqBody?.messages, reqBody);

  // All alive providers with enough context
  const all = PROVIDERS.filter((p) => p.key && p.alive !== false)
    .filter((p) => !isOnCooldown(p.name) && !isQuotaDisabled(p.name) && !isBannedFromGroup(p.name, groupName));
  const withContext = estimatedTokens > 0 ? all.filter((p) => getEffectiveContext(p) >= estimatedTokens) : all;

  // Does request carry reasoning_content or need thinking?
  const hasReasoning = (reqBody?.messages || []).some((m) => m.reasoning_content);
  const needsThinking = cap === "thinking" || detectedCaps.has("thinking");
  const needsTools = cap === "tools" || detectedCaps.has("tools") || isAgent;

  // Score each provider: base score + smartness + group match + detected caps + agent boost + compat
  const scored = withContext.map((p) => {
    let bonus = 0;
    const compat = getCompat(p.name);

    // Benchmark-backed model scoring for this group's category
    bonus += smartnessBonus(p, cap, reqBody);

    // Group capability match: strong bonus for matching, but don't exclude non-matching
    if (cap !== null && cap !== undefined) {
      if (p.caps.includes(cap)) bonus += 0.6;
      else bonus -= 0.3; // penalize but still include as fallback
    }

    // Group-specific hard requirements: coding/max need tools+thinking
    if (cap === "coding" || cap === "max") {
      if (p.caps.includes("tools")) bonus += 0.3;
      else bonus -= 0.5;
      if (p.tc || p.caps.includes("thinking")) bonus += 0.2;
      else bonus -= 0.3;
    }

    // Detected use-case bonus (from message analysis)
    for (const dc of detectedCaps) {
      if (p.caps.includes(dc)) bonus += 0.2;
    }

    // Agent/IDE mode: prefer tier 1, require tools
    if (isAgent) {
      if (p.tier === 1) bonus += 0.4;
      if (p.tier === 3) bonus -= 0.4;
      if (!p.caps.includes("tools")) bonus -= 0.8;
    }

    // Learned compat penalties: avoid providers that will fail for this request type
    if (compat.no_reasoning && hasReasoning) bonus -= 0.5;
    if (compat.no_extra_body && needsThinking) bonus -= 0.3;
    if (compat.max_tokens_cap && needsTools) bonus -= 0.1;
    if (compat.no_reasoning && needsThinking) bonus -= 0.3;

    // Session affinity — prefer same provider that worked last in this session
    const lastProv = reqBody?._sessionLastProvider;
    if (lastProv) {
      if (p.name === lastProv) bonus += 0.4; // strong preference for same provider
      else if (p.model === PROVIDERS.find((x) => x.name === lastProv)?.model) bonus += 0.2; // same model different source
    }

    return { provider: p, score: providerScore(p) + bonus };
  });

  return scored.sort((a, b) => b.score - a.score).map((s) => s.provider);
}

// auto group: same logic but no specific group capability filter
function getProvidersForAuto(messages, estimatedTokens, reqBody) {
  const { caps: detectedCaps, isAgent } = detectUseCase(messages, reqBody);
  const hasReasoning = (messages || []).some((m) => m.reasoning_content);
  const needsThinking = detectedCaps.has("thinking");

  const all = PROVIDERS.filter((p) => p.key && p.alive !== false)
    .filter((p) => !isOnCooldown(p.name) && !isQuotaDisabled(p.name) && !isBannedFromGroup(p.name, "auto"));
  const withContext = estimatedTokens > 0 ? all.filter((p) => getEffectiveContext(p) >= estimatedTokens) : all;

  const scored = withContext.map((p) => {
    let bonus = 0;
    const compat = getCompat(p.name);

    // Benchmark-backed model scoring — detect primary category from use case
    const primaryCap = detectedCaps.has("coding") ? "coding"
      : detectedCaps.has("thinking") ? "thinking"
      : detectedCaps.has("images") ? "images"
      : detectedCaps.has("tools") ? "tools"
      : "text";
    bonus += smartnessBonus(p, primaryCap, reqBody);

    for (const cap of detectedCaps) {
      if (p.caps.includes(cap)) bonus += 0.3;
    }
    if (isAgent) {
      if (p.tier === 1) bonus += 0.5;
      if (p.tier === 3) bonus -= 0.5;
      if (!p.caps.includes("tools")) bonus -= 1.0;
    }
    // Learned compat penalties
    if (compat.no_reasoning && hasReasoning) bonus -= 0.5;
    if (compat.no_extra_body && needsThinking) bonus -= 0.3;
    if (compat.no_reasoning && needsThinking) bonus -= 0.3;

    // Session affinity
    const lastProv = reqBody?._sessionLastProvider;
    if (lastProv) {
      if (p.name === lastProv) bonus += 0.4;
      else if (p.model === PROVIDERS.find((x) => x.name === lastProv)?.model) bonus += 0.2;
    }

    return { provider: p, score: providerScore(p) + bonus };
  });

  return scored.sort((a, b) => b.score - a.score).map((s) => s.provider);
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
  body.stream = false; // force non-streaming
  const bodyStr = JSON.stringify(body);
  const headers = buildHeaders(provider);
  const start = Date.now();

  const resp = await makeRequest(provider.url, { method: "POST", headers }, bodyStr);
  const latency = Date.now() - start;

  if (resp.status >= 400) {
    if (isQuotaExhaustedError(resp.status, resp.body)) {
      disableProviderQuota(provider.name, `HTTP ${resp.status}: quota/billing error`);
    }
    if (isTemporaryRateLimit(resp.status, resp.body)) {
      setCooldown(provider.name, 60 * 60_000); // 1 hour cooldown
    } else if (resp.status === 502 || resp.status === 504 || /timeout|idle/i.test(resp.body)) {
      setCooldown(provider.name);
    }
    detectIncompatibility(provider.name, resp.status, resp.body);
    try { mempalace.saveError(mempalace.getSession(reqBody.messages), resp.body.substring(0, 200)); } catch {}
    throw { status: resp.status, body: resp.body, latency };
  }

  // Validate response is OpenAI-compatible (has choices array)
  try {
    const parsed = JSON.parse(resp.body);
    if (!parsed.choices || !Array.isArray(parsed.choices)) {
      // Provider likely only supports streaming — mark stream_only
      const c = getCompat(provider.name);
      if (!c.stream_only) { c.stream_only = true; saveCompat(); log(`COMPAT: ${provider.name} → stream_only (no choices in response)`); }
      throw { status: 502, body: resp.body, latency };
    }
  } catch (e) {
    if (e.status) throw e;
    const c = getCompat(provider.name);
    if (!c.stream_only) { c.stream_only = true; saveCompat(); log(`COMPAT: ${provider.name} → stream_only (unparseable non-stream response)`); }
    throw { status: 502, body: resp.body, latency };
  }

  // Stalling detection — model says "Let me check" and stops without acting
  if (reqBody?.tools?.length > 0 || reqBody?.functions?.length > 0) {
    const stallingDetected = detectStalling(resp.body);
    if (stallingDetected) {
      recordStalling(provider.name);
      throw { status: 422, body: resp.body, latency, stalling: true };
    }
  }

  recordSuccess(provider.name, latency);
  log(`OK: ${provider.name} ${latency}ms`);

  // Session affinity — remember which provider worked
  try { mempalace.setLastProvider(mempalace.getSession(reqBody.messages), provider.name); } catch {}

  // MemPalace: save after successful response
  try {
    const s = mempalace.getSession(reqBody.messages);
    mempalace.triggerSaves(s, reqBody, resp.body);
  } catch { /* graceful degradation */ }

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

    let dataChunks = 0;
    const buffered = [];
    let lastChunkTime = Date.now();

    // Watchdog: kill stream if no data for 90s
    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkTime > 90_000) {
        clearInterval(watchdog);
        log(`STREAM-STALE: ${provider.name} no data for 90s, killing`);
        try { streamReq?.destroy(); } catch {}
      }
    }, 10_000);

    const streamReq = streamRequest(
      provider.url,
      { method: "POST", headers },
      bodyStr,
      (chunk) => {
        lastChunkTime = Date.now();
        const text = chunk.toString();
        if (/data:\s*\{/.test(text)) dataChunks++;

        if (!headersSent) {
          buffered.push(chunk);
          if (dataChunks >= 2) {
            // Commit — flush buffered chunks
            clientRes.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "X-LLM-Provider": provider.name,
            });
            headersSent = true;
            for (const b of buffered) clientRes.write(b);
            buffered.length = 0;
          }
        } else {
          clientRes.write(chunk);
        }
      },
      () => {
        const latency = Date.now() - start;
        clearInterval(watchdog);
        recordSuccess(provider.name, latency);
        log(`STREAM-OK: ${provider.name} ${latency}ms chunks=${dataChunks}`);
        try { mempalace.setLastProvider(mempalace.getSession(reqBody.messages), provider.name); } catch {}
        if (headersSent) {
          clientRes.end();
        }
        resolve({ streamed: true, headersSent });
      },
      (err, statusCode) => {
        const latency = Date.now() - start;
        if (statusCode === 429) setCooldown(provider.name);
        // Timeout/gateway errors — cooldown so failover picks different provider
        if (isTemporaryRateLimit(statusCode, err.message || "")) {
          setCooldown(provider.name, 60 * 60_000);
        } else if (statusCode === 502 || statusCode === 504 || /timeout|idle/i.test(err.message || "")) {
          setCooldown(provider.name);
        }
        if (isQuotaExhaustedError(statusCode, err.message || "")) {
          disableProviderQuota(provider.name, `HTTP ${statusCode}: quota/billing error`);
        }
        clearInterval(watchdog);
        detectIncompatibility(provider.name, statusCode, err.message || "");
        recordFailure(provider.name, err.message);
        log(`STREAM-ERR: ${provider.name} ${latency}ms status=${statusCode} headersSent=${headersSent} chunks=${dataChunks} err=${(err.message || "").substring(0, 80)}`);
        reject({ error: err, statusCode, headersSent, latency });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Main routing with group failover
// ---------------------------------------------------------------------------
async function handleChatCompletion(reqBody, clientRes) {
  const requestedModel = reqBody.model || "auto";
  const isStreaming = reqBody.stream === true;
  const isGroup = requestedModel in GROUPS || requestedModel === "auto";
  const estTokens = estimateTokens(reqBody.messages) + estimateToolsTokens(reqBody.tools);
  const requestedMaxTokens = reqBody.max_tokens || 4096;
  const totalNeeded = estTokens + requestedMaxTokens;
  reqBody._estimatedTokens = totalNeeded; // pass to scoring for context-aware ranking

  // MemPalace: recall memories and inject into context
  const mpSession = mempalace.getSession(reqBody.messages);
  reqBody._sessionLastProvider = mempalace.getLastProvider(mpSession);
  let memoryInjection = "";
  try {
    memoryInjection = await mempalace.recallMemories(mpSession, reqBody);
  } catch { /* graceful degradation */ }
  if (memoryInjection) reqBody._memoryInjection = memoryInjection;

  // Save project context on first request of session
  if (mpSession.requestCount === 1) {
    const sysMsg = reqBody.messages?.find((m) => m.role === "system");
    if (sysMsg) mempalace.saveProjectContext(mpSession, typeof sysMsg.content === "string" ? sysMsg.content : "");
  }

  // Detect "continua loop" — user retrying because previous response was useless
  // Count recent continua/continue messages — if user sends 2+ in a row, provider is stalling
  if (reqBody.messages?.length >= 3) {
    const msgs = reqBody.messages;
    let continuaCount = 0;
    let shortAssistantCount = 0;
    // Scan last 10 messages for stalling patterns
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 10); i--) {
      const m = msgs[i];
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content.trim() : "";
        if (/(?:continu[ea]|continue|go|do it|next|remember|recall|where were we|what were we)/i.test(text) && text.length < 50) {
          continuaCount++;
        }
      }
      if (m.role === "assistant" && !m.tool_calls?.length) {
        const ac = typeof m.content === "string" ? m.content : "";
        // Short response without tool calls = stalling
        if (ac.length < 800) shortAssistantCount++;
        // Fake execution (shell commands as text)
        let fe = 0;
        for (const pat of FAKE_EXEC_PATTERNS) { if (pat.test(ac)) fe++; }
        if (fe >= 1) shortAssistantCount++;
      }
    }
    // Stalling detected — check severity
    if ((continuaCount >= 2 || shortAssistantCount >= 3) && continuaCount + shortAssistantCount >= 3) {
      // Find stalling assistant messages
      for (let i = msgs.length - 2; i >= Math.max(0, msgs.length - 8); i--) {
        const m = msgs[i];
        if (m.role === "assistant" && !m.tool_calls?.length) {
          const aContent = typeof m.content === "string" ? m.content : "";
          let fakeExec = 0;
          for (const pat of FAKE_EXEC_PATTERNS) { if (pat.test(aContent)) fakeExec++; }
          if (fakeExec >= 1 || aContent.length < 500) {
            const topProviders = (requestedModel === "auto"
              ? getProvidersForAuto(reqBody.messages, totalNeeded, reqBody)
              : getProvidersForGroup(requestedModel, totalNeeded, reqBody)
            ).slice(0, 3);
            const banGroup = requestedModel === "auto" ? "auto" : requestedModel;

            if (continuaCount >= 3) {
              // 3+ continua = ban from group
              for (const tp of topProviders) {
                recordStalling(tp.name);
                banFromGroup(tp.name, banGroup);
                mempalace.saveStalling(tp.name, banGroup, "repeated stalling");
              }
              log(`STALL-BAN: ${continuaCount}x continua, banned ${topProviders.map((p) => p.name).join(", ")} from ${banGroup} (${groupBans[banGroup]?.size || 0} total banned)`);
            } else {
              // 2x continua = 5min cooldown only
              for (const tp of topProviders) {
                recordStalling(tp.name);
                setCooldown(tp.name, 5 * 60_000);
              }
              log(`STALL-COOL: ${continuaCount}x continua, ${topProviders.map((p) => p.name).join(", ")} cooled 5min`);
            }
            break;
          }
        }
      }
    }
  }

  // Track compaction frequency per session — if IDE keeps sending huge context after we compact,
  // force IDE-side compaction by returning context_length_exceeded
  if (!global._compactTracker) global._compactTracker = {};
  const ct = global._compactTracker;
  const compactWindow = 5 * 60_000; // 5 minutes
  const maxCompactsBeforeForce = 3;

  // Proactive compaction: if context exceeds 90% of best available provider, compact preemptively
  if (isGroup && reqBody.messages?.length > 6) {
    const bestProviders = requestedModel === "auto"
      ? getProvidersForAuto(reqBody.messages, 0, reqBody)
      : getProvidersForGroup(requestedModel, 0, reqBody);
    if (bestProviders.length > 0) {
      // Use the LARGEST effective context among available providers —
      // only pre-compact if context exceeds even the biggest provider
      const largestEffCtx = Math.max(...bestProviders.map((p) => getEffectiveContext(p)));
      const threshold = Math.floor(largestEffCtx * 0.9); // compact at 90% of largest
      if (totalNeeded > threshold) {
        // Check if this session is in a compaction loop
        const now = Date.now();
        if (!ct[mpSession.id]) ct[mpSession.id] = [];
        ct[mpSession.id] = ct[mpSession.id].filter((t) => now - t < compactWindow);
        ct[mpSession.id].push(now);

        if (ct[mpSession.id].length > maxCompactsBeforeForce) {
          const loopCount = ct[mpSession.id].length;
          log(`COMPACT-LOOP: session ${mpSession.id} compacted ${loopCount}x in ${compactWindow/1000}s — forcing IDE compaction`);
          ct[mpSession.id] = []; // reset counter
          return sendError(clientRes, 400,
            `Context too large (${estTokens} tokens, compacted ${loopCount}x). Please compact your conversation.`,
            { code: "context_length_exceeded" });
        }

        const targetTokens = Math.floor(largestEffCtx * 0.8); // compact to 80% of largest
        let mpRefs = [];
        try { mpRefs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
        const compacted = compactMessages(reqBody.messages, targetTokens, requestedMaxTokens, mpRefs);
        if (compacted) {
          reqBody.messages = compacted.messages;
          const newEst = estimateTokens(reqBody.messages);
          log(`PRE-COMPACT: ${estTokens}tok → ${newEst}tok (${compacted.removed} msgs saved to mempalace, threshold was ${threshold})`);
        }
      }
    }
  }

  if (isGroup) {
    // auto group: detect use case, try all providers with smart ordering
    let providers = requestedModel === "auto"
      ? getProvidersForAuto(reqBody.messages, totalNeeded, reqBody)
      : getProvidersForGroup(requestedModel, totalNeeded, reqBody);

    // Smart compaction: if no providers fit, compact context and retry
    if (providers.length === 0 && reqBody.messages?.length > 4) {
      const allProviders = requestedModel === "auto"
        ? getProvidersForAuto(reqBody.messages, 0, reqBody)
        : getProvidersForGroup(requestedModel, 0, reqBody);

      if (allProviders.length > 0) {
        const maxContext = Math.max(...allProviders.map((p) => getEffectiveContext(p)));
        const targetTokens = Math.floor(maxContext * 0.7); // aim for 70% of max context

        // Save full context to MemPalace before compaction
        let mpRefs2 = [];
        try { mpRefs2 = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}

        // Compact messages: keep system + first user + last N messages that fit
        const compacted = compactMessages(reqBody.messages, targetTokens, requestedMaxTokens, mpRefs2);
        if (compacted) {
          reqBody.messages = compacted.messages;
          const newEstTokens = estimateTokens(reqBody.messages);
          const newTotal = newEstTokens + requestedMaxTokens;
          log(`COMPACT: ${estTokens}tok → ${newEstTokens}tok (removed ${compacted.removed} messages, saved to mempalace)`);

          // Retry provider selection with compacted context
          providers = requestedModel === "auto"
            ? getProvidersForAuto(reqBody.messages, newTotal, reqBody)
            : getProvidersForGroup(requestedModel, newTotal, reqBody);
        }
      }
    }

    if (providers.length === 0) {
      // Check if providers exist but context is too small even after compaction
      const allProviders = requestedModel === "auto"
        ? getProvidersForAuto(reqBody.messages, 0, reqBody)
        : getProvidersForGroup(requestedModel, 0, reqBody);
      if (allProviders.length > 0) {
        const maxContext = Math.max(...allProviders.map((p) => getEffectiveContext(p)));
        const currentTokens = estimateTokens(reqBody.messages);
        const currentTotal = currentTokens + requestedMaxTokens;
        // Return OpenAI-compatible context_length_exceeded error
        // This triggers context compaction in IDE (Kilo Code, Roo Code, Cursor)
        const body = JSON.stringify({
          error: {
            message: `This model's maximum context length is ${maxContext} tokens. However, you requested ${currentTotal} tokens (${currentTokens} in the messages, ${requestedMaxTokens} in the completion). Please reduce the length of the messages or completion.`,
            type: "invalid_request_error",
            param: "messages",
            code: "context_length_exceeded",
          },
        });
        clientRes.writeHead(400, { "Content-Type": "application/json" });
        clientRes.end(body);
        return;
      }
      return sendError(clientRes, 503, "No providers available for group: " + requestedModel);
    }

    const errors = [];
    for (const provider of providers) {
      try {
        log(`Route: ${requestedModel} → ${provider.name} (${provider.model}) via=${provider.name.split("-")[0]} stream_only=${!!getCompat(provider.name).stream_only}`);

        if (isStreaming) {
          const compat = getCompat(provider.name);
          if (compat.stream_only) {
            // Known slow provider — go straight to streaming
            await routeStreamToProvider(provider, reqBody, clientRes);
            return;
          }
          // Try non-streaming first (enables full validation + retry)
          const quickResp = await Promise.race([
            routeToProvider(provider, reqBody),
            new Promise((_, rej) => setTimeout(() => rej({ timeout: true }), 60_000)),
          ]);
          sendAsSSE(clientRes, quickResp.body, provider.name);
          return;
        } else {
          const resp = await routeToProvider(provider, reqBody);
          clientRes.writeHead(resp.status, {
            "Content-Type": "application/json",
            "X-LLM-Provider": provider.name,
          });
          clientRes.end(resp.body);
          return;
        }
      } catch (err) {
        // Non-streaming timed out → mark provider as stream-only, fall back to real streaming
        if (err.timeout && isStreaming) {
          const c = getCompat(provider.name);
          if (!c.stream_only) {
            c.stream_only = true;
            saveCompat();
            log(`COMPAT: ${provider.name} marked stream_only (non-streaming timeout)`);
          }
          try {
            log(`Route: ${requestedModel} → ${provider.name} (streaming fallback)`);
            await routeStreamToProvider(provider, reqBody, clientRes);
            return;
          } catch (streamErr) {
            if (streamErr.headersSent) { clientRes.end(); return; }
          }
        }
        if (err.headersSent) { clientRes.end(); return; }
        const status = err.status || err.statusCode || 500;
        const msg = err.body || err.error?.message || String(err);
        if (status === 429) setCooldown(provider.name);
        recordFailure(provider.name, msg);
        const errFull = typeof msg === "string" ? msg.substring(0, 300) : String(msg).substring(0, 300);
        log(`FAIL: ${provider.name} status=${status} ${err.timeout ? "TIMEOUT" : ""} ${errFull}`);
        errors.push({ provider: provider.name, status, error: typeof msg === "string" ? msg.substring(0, 200) : String(msg) });

        // Mid-loop: if 2+ context errors, compact now instead of burning through all providers
        const isCtxErr = /context.length|too.large|maximum.*token|too large for model/i.test(errFull);
        if (isCtxErr) {
          const ctxErrCount = errors.filter((e) => /context.length|too.large|maximum.*token|too large for model/i.test(e.error)).length;
          if (ctxErrCount >= 2 && reqBody.messages?.length > 4 && !(reqBody._compactRetries >= 3)) {
            reqBody._compactRetries = (reqBody._compactRetries || 0) + 1;
            const ctxs = providers.map((p) => getEffectiveContext(p)).sort((a, b) => a - b);
            const target = Math.floor((ctxs[Math.floor(ctxs.length / 2)] || 131072) * (0.6 - (reqBody._compactRetries - 1) * 0.15));
            let refs = [];
            try { refs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
            const compacted = compactMessages(reqBody.messages, target, requestedMaxTokens, refs);
            if (compacted) {
              reqBody.messages = compacted.messages;
              const newEst = estimateTokens(reqBody.messages);
              log(`MID-COMPACT #${reqBody._compactRetries}: ${estTokens}tok → ${newEst}tok (target=${target}, after ${ctxErrCount} context errors)`);
              return await handleChatCompletion(reqBody, clientRes);
            }
          }
        }
        continue;
      }
    }

    // ALL providers failed — check if context/timeout related, compact and retry
    const contextOrTimeoutErrors = errors.filter((e) =>
      /context.length|too.long|token.*exceed|max.size.*token|too.large|timeout|idle|502|504/i.test(e.error) || e.status === 502 || e.status === 504
    );
    const isContextProblem = contextOrTimeoutErrors.length > errors.length / 3;

    if (isContextProblem && reqBody.messages?.length > 4 && !reqBody._compactRetries) {
      reqBody._compactRetries = 0;
    }
    if (isContextProblem && (reqBody._compactRetries || 0) < 3 && reqBody.messages?.length > 4) {
      reqBody._compactRetries = (reqBody._compactRetries || 0) + 1;
      const allP = requestedModel === "auto"
        ? getProvidersForAuto(reqBody.messages, 0, reqBody)
        : getProvidersForGroup(requestedModel, 0, reqBody);
      const ctxs = allP.map((p) => getEffectiveContext(p)).sort((a, b) => a - b);
      const target = Math.floor((ctxs[Math.floor(ctxs.length / 2)] || 131072) * (0.7 - reqBody._compactRetries * 0.15)); // 70%→55%→40%

      let refs = [];
      try { refs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
      const compacted = compactMessages(reqBody.messages, target, requestedMaxTokens, refs);
      if (compacted) {
        reqBody.messages = compacted.messages;
        const newEst = estimateTokens(reqBody.messages);
        log(`RETRY-COMPACT #${reqBody._compactRetries}: ${estTokens}tok → ${newEst}tok (target=${target}, removed ${compacted.removed} msgs)`);
        // Recursive retry with compacted context
        return await handleChatCompletion(reqBody, clientRes);
      }
    }

    // Final fallback — return context_length_exceeded to trigger IDE compaction
    if (isContextProblem) {
      const maxContext = Math.max(...PROVIDERS.filter((p) => p.key && p.alive !== false).map((p) => getEffectiveContext(p)), 0);
      const currentEst = estimateTokens(reqBody.messages);
      const body = JSON.stringify({
        error: {
          message: `This model's maximum context length is ${maxContext} tokens. However, you requested ${currentEst + requestedMaxTokens} tokens (${currentEst} in the messages, ${requestedMaxTokens} in the completion). Please reduce the length of the messages or completion.`,
          type: "invalid_request_error",
          param: "messages",
          code: "context_length_exceeded",
        },
      });
      clientRes.writeHead(400, { "Content-Type": "application/json" });
      clientRes.end(body);
      return;
    }
    return sendError(clientRes, 503, "All providers in group failed", { group: requestedModel, attempts: errors });
  }

  // Direct provider/model routing
  const provider = findProviderByModel(requestedModel);
  if (!provider) {
    return sendError(clientRes, 404, "Model not found: " + requestedModel);
  }

  try {
    log(`Route: ${requestedModel} → ${provider.name} (${provider.model}) via=${provider.name.split("-")[0]}`);
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
    context_length: getEffectiveContext(p),
    tier: p.tier,
    thinking_capable: p.tc,
  }));

  // Add smart groups
  const groups = Object.keys(GROUPS).map((g) => ({
    id: g,
    object: "model",
    created: 0,
    owned_by: "llm-proxy",
    capabilities: GROUPS[g] === null ? ["all"] : [GROUPS[g]],
    context_length: 131072,
    tier: 0,
    thinking_capable: g === "auto-thinking",
    is_group: true,
    provider_count: getProvidersForGroup(g).length,
  }));

  // Add auto group (smart use-case detection)
  groups.unshift({
    id: "auto",
    object: "model",
    created: 0,
    owned_by: "llm-proxy",
    capabilities: ["all", "auto-detect"],
    context_length: Math.max(...PROVIDERS.filter((p) => p.key && p.alive !== false).map((p) => getEffectiveContext(p)), 0),
    tier: 0,
    thinking_capable: true,
    is_group: true,
    provider_count: PROVIDERS.filter((p) => p.key && p.alive !== false).length,
    description: "Auto-detects use case (coding, thinking, images, tools) and routes to best provider with full fallback",
  });

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
    uptime_human: formatUptime(process.uptime()),
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
    compat_overrides: Object.keys(providerCompat).length > 0 ? Object.keys(providerCompat).length : undefined,
    mempalace: mempalace.mempalaceHealth(),
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
  // Only probe unverified providers, skip after 3 failed attempts
  const thinkingProviders = PROVIDERS.filter((p) => {
    if (!p.key || !p.tc || p.alive === false) return false;
    const s = getScore(p.name);
    if (s.thinking_ok > 0) return false; // already verified
    if ((s._probeAttempts || 0) >= 3) return false; // gave up
    return true;
  });
  if (thinkingProviders.length === 0) return;
  log(`Thinking probe: ${thinkingProviders.length} unverified providers`);
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

      const s = getScore(p.name);
      s._probeAttempts = (s._probeAttempts || 0) + 1;
      if (resp.status < 400 && detectThinking(resp.body)) {
        recordThinkingOk(p.name);
        log(`Thinking OK: ${p.name}`);
      }
    } catch {
      const s = getScore(p.name);
      s._probeAttempts = (s._probeAttempts || 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
// Convert non-streaming response to SSE stream for client
function sendAsSSE(res, responseBody, providerName) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-LLM-Provider": providerName,
  });

  try {
    const data = JSON.parse(responseBody);
    const choice = data.choices?.[0];
    if (!choice) { res.write(`data: ${responseBody}\n\n`); res.write("data: [DONE]\n\n"); res.end(); return; }

    const content = choice.message?.content || "";
    const toolCalls = choice.message?.tool_calls;

    // Send content in chunks for streaming feel
    if (content && !toolCalls?.length) {
      const chunkSize = 20; // ~20 chars per SSE event
      for (let i = 0; i < content.length; i += chunkSize) {
        const delta = content.substring(i, i + chunkSize);
        const chunk = {
          id: data.id || "chatcmpl-proxy",
          object: "chat.completion.chunk",
          created: data.created || Math.floor(Date.now() / 1000),
          model: data.model,
          choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: delta } : { content: delta }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }

    // Send tool calls as single chunk (can't split)
    if (toolCalls?.length) {
      const chunk = {
        id: data.id || "chatcmpl-proxy",
        object: "chat.completion.chunk",
        created: data.created || Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [{ index: 0, delta: { role: "assistant", content: content || null, tool_calls: toolCalls }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Final chunk with finish_reason
    const finalChunk = {
      id: data.id || "chatcmpl-proxy",
      object: "chat.completion.chunk",
      created: data.created || Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
      usage: data.usage,
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
  } catch {
    // Fallback: send raw response as single SSE event
    res.write(`data: ${responseBody}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

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

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
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
      const est = estimateTokens(parsed.messages);
      const model = parsed.model || "auto";
      if (model === "auto") {
        const { caps, isAgent } = detectUseCase(parsed.messages, parsed);
        const sid = mempalace.getSession(parsed.messages).id;
        log(`Request: model=auto stream=${!!parsed.stream} msgs=${parsed.messages?.length || 0} ~${est}tok caps=[${[...caps]}] agent=${isAgent} sid=${sid}`);
      } else {
        const sid = mempalace.getSession(parsed.messages).id;
        log(`Request: model=${model} stream=${!!parsed.stream} msgs=${parsed.messages?.length || 0} ~${est}tok sid=${sid}`);
      }
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
loadCompat();
loadProviders();
watchProvidersFile();

// Re-apply learned context limits to loaded providers (quota disables use cooldown, not alive=false)
for (const [name, c] of Object.entries(providerCompat)) {
  if (c.real_context) {
    const p = PROVIDERS.find((pr) => pr.name === name);
    if (p && p.context > c.real_context) p.context = c.real_context;
  }
}

server.listen(PORT, () => {
  const active = PROVIDERS.filter((p) => p.key && p.alive !== false).length;
  log(`LLM Smart Proxy started on port ${PORT}`);
  log(`Active providers: ${active}/${PROVIDERS.length}`);
  log(`Smart groups: ${Object.keys(GROUPS).join(", ")}`);
  log(`Config source: ${fs.existsSync(PROVIDERS_FILE) ? "providers.json" : "seed-providers.json (fallback)"}`);
  log(`Endpoints: /v1/chat/completions, /v1/models, /v1/capabilities, /health, /scores, /discovery`);
});

// Run thinking probe immediately on startup, then hourly for new unverified only
probeThinking().catch(() => {});

setInterval(() => {
  probeThinking().catch(() => {});
}, THINKING_PROBE_INTERVAL);

// Save scores on exit
process.on("SIGTERM", () => { saveScores(); process.exit(0); });
process.on("SIGINT", () => { saveScores(); process.exit(0); });
