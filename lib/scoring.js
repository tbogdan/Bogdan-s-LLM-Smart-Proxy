"use strict";

const fs = require("fs");
const path = require("path");
const state = require("./state");

const COMPAT_FILE = path.join(state.DATA_DIR, "compat.json");

// ---------------------------------------------------------------------------
// Score persistence
// ---------------------------------------------------------------------------

function loadScores() {
  try {
    if (fs.existsSync(state.SCORES_FILE)) {
      state.scores = JSON.parse(fs.readFileSync(state.SCORES_FILE, "utf8"));
    }
  } catch { state.scores = {}; }
}

function saveScores() {
  try { fs.writeFileSync(state.SCORES_FILE, JSON.stringify(state.scores, null, 2)); } catch {}
}

function getScore(name) {
  if (!state.scores[name]) {
    state.scores[name] = { requests: 0, successes: 0, failures: 0, total_latency: 0, avg_latency: 0, success_rate: 1.0, last_error: null, cooldown_until: 0, thinking_ok: 0 };
  }
  return state.scores[name];
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
  s.cooldown_until = Date.now() + (durationMs || state.COOLDOWN_MS);
}

function isOnCooldown(name) {
  const s = getScore(name);
  return Date.now() < (s.cooldown_until || 0);
}

// ---------------------------------------------------------------------------
// Quota exhaustion detection (Alibaba "Free Quota Only" mode)
// ---------------------------------------------------------------------------

function loadQuotaDisabled() {
  try {
    if (fs.existsSync(state.QUOTA_DISABLED_FILE)) {
      state.quotaDisabled = JSON.parse(fs.readFileSync(state.QUOTA_DISABLED_FILE, "utf8"));
    }
  } catch { state.quotaDisabled = {}; }
}

function saveQuotaDisabled() {
  try { fs.writeFileSync(state.QUOTA_DISABLED_FILE, JSON.stringify(state.quotaDisabled, null, 2)); } catch {}
}

function disableProviderQuota(name, reason) {
  state.quotaDisabled[name] = { time: Date.now(), reason };
  saveQuotaDisabled();
  setCooldown(name, state.QUOTA_COOLDOWN_MS);
  state.log(`QUOTA: ${name} cooled 3.5h — ${reason}`);
}

function isQuotaDisabled(name) {
  const entry = state.quotaDisabled[name];
  if (!entry) return false;
  // Auto-expire after 3.5h
  if (Date.now() - entry.time > state.QUOTA_COOLDOWN_MS) {
    delete state.quotaDisabled[name];
    saveQuotaDisabled();
    state.log(`QUOTA-RETRY: ${name} re-enabled after 3.5h`);
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
// Auto-detected provider incompatibilities (learned from errors)
// ---------------------------------------------------------------------------

function loadCompat() {
  try {
    if (fs.existsSync(COMPAT_FILE)) {
      state.providerCompat = JSON.parse(fs.readFileSync(COMPAT_FILE, "utf8"));
    }
  } catch { state.providerCompat = {}; }
}

function saveCompat() {
  try { fs.writeFileSync(COMPAT_FILE, JSON.stringify(state.providerCompat, null, 2)); } catch {}
}

function getCompat(name) {
  if (!state.providerCompat[name]) state.providerCompat[name] = {};
  return state.providerCompat[name];
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

  // reasoning/thinking content rejected (Groq, Cohere: "thinking content is not allowed")
  if ((body.includes("reasoning_content") || body.includes("reasoning_content' is unsupported") || body.includes("thinking content is not allowed")) && (statusCode === 400 || statusCode === 422)) {
    if (!c.no_reasoning) {
      c.no_reasoning = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects reasoning_content — will strip on future requests`);
    }
  }

  // extra_body / enable_thinking rejected
  if ((body.includes("extra_body") || body.includes("enable_thinking")) && (statusCode === 400 || statusCode === 422)) {
    if (!c.no_extra_body) {
      c.no_extra_body = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects extra_body — will strip on future requests`);
    }
  }

  // max_tokens cap detected (e.g. "Range of max_tokens should be [1, 8192]")
  // Only match explicit limit messages, not request body dumps
  const errOnly = body.substring(0, 500); // limit to error message, not full request dump
  const maxMatch = errOnly.match(/max_tokens.*?\[1,\s*(\d+)\]/i) || errOnly.match(/Max size:\s*(\d+)\s*tokens/i);
  if (maxMatch && (statusCode === 400 || statusCode === 422)) {
    const cap = parseInt(maxMatch[1], 10);
    if (cap > 0 && (!c.max_tokens_cap || cap < c.max_tokens_cap)) {
      c.max_tokens_cap = cap;
      changed = true;
      state.log(`COMPAT: ${providerName} max_tokens capped at ${cap}`);
    }
  }

  // Context size too small (detect actual limit from error)
  const ctxMatch = body.match(/Max size:\s*(\d+)\s*tokens/i) || body.match(/maximum context length.*?(\d+)/i) || body.match(/max.*?(\d+)\s*tokens/i);
  if (ctxMatch && (statusCode === 400 || statusCode === 413)) {
    const limit = parseInt(ctxMatch[1], 10);
    if (limit > 1000 && (!c.real_context || limit < c.real_context)) { // ignore absurd values <1K
      c.real_context = limit;
      changed = true;
      state.log(`COMPAT: ${providerName} real context limit detected: ${limit} tokens`);
      // Update provider context in memory
      const p = state.PROVIDERS.find((pr) => pr.name === providerName);
      if (p && p.context > limit) p.context = limit;
    }
  }

  // Tools limit detected (e.g. "maximum number of items is 128")
  const toolsMatch = errOnly.match(/tools.*?maximum.*?(\d+)/i) || errOnly.match(/maximum number of items is (\d+)/i);
  if (toolsMatch && (statusCode === 400 || statusCode === 422)) {
    const cap = parseInt(toolsMatch[1], 10);
    if (cap > 0 && (!c.max_tools || cap < c.max_tools)) {
      c.max_tools = cap;
      changed = true;
      state.log(`COMPAT: ${providerName} max tools capped at ${cap}`);
    }
  }

  // Tool calling not supported by model (Groq compound-mini etc)
  if (/tool.calling.*not supported/i.test(body) && (statusCode === 400)) {
    if (!c.no_tools) {
      c.no_tools = true;
      changed = true;
      state.log(`COMPAT: ${providerName} does not support tool calling — will avoid for tool requests`);
    }
  }

  // parallel_tool_calls not supported (Cohere)
  if (/parallel_tool_calls.*not supported/i.test(body) && (statusCode === 422)) {
    if (!c.no_parallel_tools) {
      c.no_parallel_tools = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects parallel_tool_calls`);
    }
  }

  // stream_options rejected when stream=false
  if ((body.includes("stream_options") || body.includes("Stream options")) && (statusCode === 400 || statusCode === 422)) {
    if (!c.no_stream_options) {
      c.no_stream_options = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects stream_options when stream=false — will strip`);
    }
  }

  // tool_choice rejected (no endpoints support it) — also through wrappers (Cline 500 wrapping 404)
  if (body.includes("tool_choice") && (statusCode === 400 || statusCode === 404 || statusCode === 500)) {
    if (!c.no_tool_choice) {
      c.no_tool_choice = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects tool_choice — will strip`);
    }
  }

  // Content array not supported (must be string) — Cloudflare, BigModel
  if ((body.includes("not in 'string'") || body.includes("Type mismatch") || body.includes("调用参数有误")) && (statusCode === 400)) {
    if (!c.no_content_array) {
      c.no_content_array = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects content arrays — will flatten to string`);
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
      state.log(`COMPAT: ${providerName} char limit ${charLimit} ≈ ${tokenLimit} tokens`);
      const p = state.PROVIDERS.find((pr) => pr.name === providerName);
      if (p && p.context > tokenLimit) p.context = tokenLimit;
    }
  }

  // Monthly/quota/usage limit (Kiro 402, Codex 500 "usage limit", socket hang up, etc.)
  if (body.includes("reached the limit") || body.includes("MONTHLY_REQUEST_COUNT") || body.includes("usage limit has been reached") || body.includes("out of") || body.includes("limit will reset")) {
    setCooldown(providerName, 3600_000); // 1 hour cooldown
    state.log(`QUOTA: ${providerName} quota/usage limit exhausted — cooldown 1h`);
  }

  // Daily token limit (SambaNova: "Request would exceed the 1-day token limit")
  if (body.includes("1-day token limit") || body.includes("rate_limit_daily")) {
    setCooldown(providerName, 3600_000); // 1 hour cooldown (daily resets)
    state.log(`QUOTA: ${providerName} daily token limit — cooldown 1h`);
  }

  // Billing/plan quota (Gemini: "exceeded your current quota", OpenAI: "exceeded your current quota")
  if (body.includes("exceeded your current quota") || body.includes("check your plan and billing")) {
    setCooldown(providerName, 3600_000); // 1 hour cooldown
    state.log(`QUOTA: ${providerName} billing quota exceeded — cooldown 1h`);
  }

  // Trial key rate limit (Cohere: "limited to 20 API calls / minute")
  if (body.includes("Trial key") && body.includes("limited to")) {
    setCooldown(providerName, 60_000); // 1 min cooldown for per-minute limits
    state.log(`RATE: ${providerName} trial key rate limit — cooldown 1min`);
  }

  // OpenRouter free-models-per-day limit
  if (body.includes("free-models-per-day") || body.includes("Add 5 credits to unlock")) {
    setCooldown(providerName, 3600_000);
    state.log(`QUOTA: ${providerName} OpenRouter free daily limit — cooldown 1h`);
  }

  // Gemini thought_signature missing — Gemini rejects replayed tool calls without original signature
  // Mark provider as incompatible with tool history replay (OpenAI-compat layer can't preserve signatures)
  if (body.includes("thought_signature") && statusCode === 400) {
    if (!c.no_tool_history) {
      c.no_tool_history = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects tool history without thought_signature — will avoid for tool-heavy requests`);
    }
    setCooldown(providerName, 300_000); // 5min cooldown for immediate failover
  }

  // Tool results missing — Codex/OpenAI server-side state mismatch, cooldown briefly
  if (body.includes("Tool results are missing") && statusCode === 500) {
    setCooldown(providerName, 300_000); // 5 min cooldown
    state.log(`COMPAT: ${providerName} tool state mismatch — cooldown 5min`);
  }

  // Socket hang up / streaming failed from providers that reject on quota (Codex free tier)
  if ((body.includes("socket hang up") || body.includes("Streaming request failed")) && /codex/i.test(providerName)) {
    setCooldown(providerName, 3600_000);
    state.log(`QUOTA: ${providerName} connection rejected (likely quota) — cooldown 1h`);
  }

  // Codex/OpenAI usage_limit_reached
  if (body.includes("usage_limit_reached") || (body.includes("usage limit") && body.includes("resets"))) {
    setCooldown(providerName, 3600_000);
    state.log(`QUOTA: ${providerName} usage limit reached — cooldown 1h`);
  }

  // NVIDIA rate limits (1000 credits/month free tier)
  // Only match in first 500 chars to avoid false positives from request body echo
  const nvidiaErr = body.substring(0, 500);
  if ((nvidiaErr.includes("rate limit") || nvidiaErr.includes("credits") || nvidiaErr.includes("exceeded")) && /NVIDIA/i.test(providerName) && statusCode === 429) {
    setCooldown(providerName, 3600_000);
    state.log(`QUOTA: ${providerName} NVIDIA rate limit — cooldown 1h`);
  }

  // Context window from error (Cloudflare format: "exceeded this model context window limit (24000)")
  const cfCtxMatch = body.match(/context window limit \((\d+)\)/i) || body.match(/exceeded.*?(\d+)\)/i);
  if (cfCtxMatch && (statusCode === 413)) {
    const limit = parseInt(cfCtxMatch[1], 10);
    if (limit > 1000 && (!c.real_context || limit < c.real_context)) {
      c.real_context = limit;
      changed = true;
      state.log(`COMPAT: ${providerName} real context limit detected: ${limit} tokens`);
      const p = state.PROVIDERS.find((pr) => pr.name === providerName);
      if (p && p.context > limit) p.context = limit;
    }
  }

  // max_tokens must be ≤ N (Groq format: "must be less than or equal to `8192`")
  const maxLteMatch = body.match(/max.tokens.*?less than or equal to.*?(\d+)/i);
  if (maxLteMatch && (statusCode === 400)) {
    const cap = parseInt(maxLteMatch[1], 10);
    if (cap > 0 && (!c.max_tokens_cap || cap < c.max_tokens_cap)) {
      c.max_tokens_cap = cap;
      changed = true;
      state.log(`COMPAT: ${providerName} max_tokens capped at ${cap}`);
    }
  }

  if (changed) saveCompat();
}

// ---------------------------------------------------------------------------
// Stalling detection and group bans
// ---------------------------------------------------------------------------

function recordStalling(name) {
  const s = getScore(name);
  s.stalling = (s.stalling || 0) + 1;
  state.log(`STALLING: ${name} (count: ${s.stalling})`);
  saveScores();

  // Track recent stallings — 3+ in 5 min = cooldown 1h
  if (!state.stallingTracker[name]) state.stallingTracker[name] = [];
  const now = Date.now();
  state.stallingTracker[name] = state.stallingTracker[name].filter(t => now - t < 300_000); // 5 min window
  state.stallingTracker[name].push(now);
  if (state.stallingTracker[name].length >= 3) {
    if (!isOnCooldown(name)) {
      setCooldown(name, 3600_000);
      state.log(`STALL-COOLDOWN: ${name} stalled 3x in 5min — cooldown 1h`);
    }
    state.stallingTracker[name] = [];
  }
}

// Per-group ban list — providers banned from specific groups due to repeated stalling
// Resets on restart (not persisted — stalling is context-dependent, not permanent)
function banFromGroup(providerName, groupName) {
  if (!state.groupBans[groupName]) state.groupBans[groupName] = new Set();
  state.groupBans[groupName].add(providerName);
}

function isBannedFromGroup(providerName, groupName) {
  return state.groupBans[groupName]?.has(providerName) || false;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadScores,
  saveScores,
  getScore,
  recordSuccess,
  recordFailure,
  setCooldown,
  isOnCooldown,
  loadQuotaDisabled,
  saveQuotaDisabled,
  disableProviderQuota,
  isQuotaDisabled,
  isQuotaExhaustedError,
  isTemporaryRateLimit,
  recordThinkingOk,
  providerScore,
  loadCompat,
  saveCompat,
  getCompat,
  getEffectiveContext,
  detectIncompatibility,
  recordStalling,
  banFromGroup,
  isBannedFromGroup,
};
