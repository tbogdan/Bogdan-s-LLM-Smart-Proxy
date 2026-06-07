"use strict";

const fs = require("fs");
const path = require("path");
const state = require("./state");
const routingPolicy = require("./routing-policy");

const COMPAT_FILE = path.join(state.DATA_DIR, "compat.json");

// ---------------------------------------------------------------------------
// Score persistence
// ---------------------------------------------------------------------------

function loadScores() {
  try {
    if (fs.existsSync(state.SCORES_FILE)) {
      state.scores = JSON.parse(fs.readFileSync(state.SCORES_FILE, "utf8"));
      migrateScores();
    }
  } catch { state.scores = {}; }
}

function saveScores() {
  try { fs.writeFileSync(state.SCORES_FILE, JSON.stringify(state.scores, null, 2)); } catch {}
}

function migrateScores() {
  if (!state.scores || typeof state.scores !== "object") return;
  state.scores.__migrations ||= {};
  const migrations = [
    "garble_cooldown_v2",
    "garble_cooldown_v3",
    "garble_cooldown_v4",
    "garble_cooldown_v5",
    "windsurf_invalid_argument_cooldown_v1",
  ];
  const pending = migrations.filter((migration) => !state.scores.__migrations[migration]);
  if (pending.length === 0) return;

  let cleared = 0;
  let windsurfInvalidArgumentCooled = 0;
  const shouldCoolWindsurfInvalidArgument = pending.includes("windsurf_invalid_argument_cooldown_v1");
  for (const [name, score] of Object.entries(state.scores)) {
    if (!score || typeof score !== "object" || name.startsWith("__")) continue;
    const reason = String(score.cooldown_reason || score.last_error?.message || "");
    if (/garbled output/i.test(reason)) {
      score.cooldown_until = 0;
      score.last_error = null;
      score.stalling = 0;
      delete score.cooldown_reason;
      delete score.last_stall_time;
      cleared += 1;
    }
    if (
      shouldCoolWindsurfInvalidArgument &&
      /windsurf/i.test(name) &&
      /invalid_argument/i.test(reason) &&
      Date.now() >= (score.cooldown_until || 0)
    ) {
      score.cooldown_until = Date.now() + 3600_000;
      score.cooldown_reason = "windsurf invalid_argument";
      windsurfInvalidArgumentCooled += 1;
    }
  }

  const appliedAt = new Date().toISOString();
  for (const migration of pending) {
    state.scores.__migrations[migration] = { applied_at: appliedAt, cleared, windsurf_invalid_argument_cooled: windsurfInvalidArgumentCooled };
  }
  if (cleared > 0) {
    state.log(`SCORES-MIGRATION: cleared ${cleared} stale garbled-output cooldowns`);
  }
  if (windsurfInvalidArgumentCooled > 0) {
    state.log(`SCORES-MIGRATION: cooled ${windsurfInvalidArgumentCooled} Windsurf invalid_argument providers`);
  }
  if (cleared > 0 || windsurfInvalidArgumentCooled > 0 || pending.length > 0) saveScores();
}

function getScore(name) {
  if (!state.scores[name]) {
    state.scores[name] = { requests: 0, successes: 0, failures: 0, total_latency: 0, avg_latency: 0, success_rate: 1.0, last_error: null, cooldown_until: 0, thinking_ok: 0, tool_invalid: 0 };
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
  s.cooldown_until = 0;
  delete s.cooldown_reason;
  s.stalling = 0;
  delete s.last_stall_time;
  if (state.stallingTracker[name]) state.stallingTracker[name] = [];
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

function recordToolInvalid(name, error) {
  const s = getScore(name);
  s.tool_invalid = (s.tool_invalid || 0) + 1;
  s.last_tool_invalid_time = Date.now();
  s.last_tool_invalid_error = String(error || "");
  saveScores();
}

function setCooldown(name, durationMs, reason) {
  const s = getScore(name);
  s.cooldown_until = Date.now() + (durationMs || state.COOLDOWN_MS);
  if (reason) s.cooldown_reason = reason;
}

function clearCooldown(name, reason) {
  const s = getScore(name);
  const wasActive = Date.now() < (s.cooldown_until || 0);
  s.cooldown_until = 0;
  if (reason) s.cooldown_cleared_reason = reason;
  delete s.cooldown_reason;
  saveScores();
  return wasActive;
}

function isOnCooldown(name) {
  const s = getScore(name);
  return Date.now() < (s.cooldown_until || 0);
}

function isRecentUnresolvedChronicStalling(name) {
  void name;
  return false;
}

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
  setCooldown(name, state.QUOTA_COOLDOWN_MS, `quota: ${reason}`);
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
  // Generic balance errors
  if (statusCode === 403 && /insufficient|balance/i.test(body)) return true;
  if (statusCode === 402) return true; // Payment Required
  // Generic usage limit
  if (statusCode === 429 && /usage limit|weekly.*limit|monthly.*limit/i.test(body)) return true;
  return false;
}

// Temporary rate limit — cooldown 1 hour, not permanent disable
function isTemporaryRateLimit(statusCode, body) {
  // Quota exceeded
  if (statusCode === 429 && /exceeded.*current quota|quota.*exceeded/i.test(body)) return true;
  // Provider rate limit envelopes can be terse.
  if (statusCode === 429 && /rate[_ -]?limit|too many requests/i.test(body)) return true;
  // Request-level token limit
  if (statusCode === 413 && /too large for model/i.test(body)) return true;
  // Daily token limit
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

function recentIssuePenalty(score = {}) {
  const lastError = score.last_error || null;
  if (!lastError) return 0;
  const lastTime = Number(lastError.time || score.last_stall_time || score.last_tool_invalid_time || 0);
  if (!lastTime) return 0;
  const ageMs = Date.now() - lastTime;
  if (ageMs < 0 || ageMs > 6 * 3600_000) return 0;

  const evidence = `${score.cooldown_reason || ""} ${lastError.message || ""}`.toLowerCase();
  let base = 0.15;
  if (/invalid_argument|permission_denied|tool state mismatch|thought_signature/.test(evidence)) {
    base = 0.65;
  } else if (/text-only response with tools|no prompt text found|missing required field|invalid tool|tool_invalid|garbled/.test(evidence)) {
    base = 0.55;
  } else if (/context window|too large for model|maximum context|context length/.test(evidence)) {
    base = 0.45;
  } else if (/stream aborted|socket hang up|aborted|gateway|timeout|502|503|504/.test(evidence)) {
    base = 0.3;
  } else if (/rate[_ -]?limit|quota|usage limit|daily token|billing/.test(evidence)) {
    base = 0.2;
  }

  const ageHours = ageMs / 3600_000;
  return Math.min(0.75, base * Math.pow(0.5, ageHours / 2));
}

// Provider scoring for ranking within a group
function providerScore(p) {
  const s = getScore(p.name);
  const rate = s.requests > 0 ? s.success_rate : 1.0;
  const latPenalty = s.avg_latency > 0 ? Math.min(s.avg_latency / 20000, 1) : 0;
  const tierBonus = (4 - p.tier) * 0.2; // tier 1 = 0.6, tier 2 = 0.4, tier 3 = 0.2
  const reliabilityPenalty = s.requests >= 5 && rate < 0.72 ? Math.min((0.72 - rate) * 0.75, 0.45) : 0;
  let effectiveToolInvalid = s.tool_invalid || 0;
  if (effectiveToolInvalid > 0 && s.last_tool_invalid_time) {
    const hoursSinceToolInvalid = (Date.now() - s.last_tool_invalid_time) / 3600_000;
    effectiveToolInvalid = effectiveToolInvalid * Math.pow(0.5, hoursSinceToolInvalid / 3);
  }
  const toolInvalidPenalty = effectiveToolInvalid > 0.1 ? Math.min(effectiveToolInvalid * 0.18, 1.2) : 0;
  return rate * 0.5 + (1 - latPenalty) * 0.3 + tierBonus - toolInvalidPenalty - reliabilityPenalty - recentIssuePenalty(s);
}

function getPolicyUsage() {
  if (!state.scores.__routing_policy) {
    state.scores.__routing_policy = { requests: 0, ewma_cost_group: 0, ewma_thinking_level: 0, ewma_speed_group: 0 };
  }
  return state.scores.__routing_policy;
}

function providerPolicyBonus(provider, reqBody) {
  return routingPolicy.providerPolicyBonus(provider, reqBody, {
    env: process.env,
    usage: getPolicyUsage(),
    getEffectiveContext,
  });
}

function recordPolicyUse(provider) {
  const profile = routingPolicy.classifyProvider(provider);
  const usage = getPolicyUsage();
  const alpha = 0.18;
  usage.requests += 1;
  usage.ewma_cost_group = usage.ewma_cost_group ? usage.ewma_cost_group * (1 - alpha) + profile.cost_group * alpha : profile.cost_group;
  usage.ewma_thinking_level = usage.ewma_thinking_level ? usage.ewma_thinking_level * (1 - alpha) + profile.thinking_level * alpha : profile.thinking_level;
  usage.ewma_speed_group = usage.ewma_speed_group ? usage.ewma_speed_group * (1 - alpha) + profile.speed_group * alpha : profile.speed_group;
  saveScores();
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
  const advertised = Number(
    provider.context ||
    provider.context_length ||
    provider.contextWindow ||
    provider.context_window ||
    provider.max_context_window ||
    provider.max_context_tokens ||
    provider.maxContextTokens ||
    0,
  );
  if (compat.real_context && (!advertised || compat.real_context < advertised)) {
    return compat.real_context;
  }
  return advertised || 131072;
}

function rememberRealContext(providerName, compat, limit, reason) {
  if (!(limit > 1000) || (compat.real_context && limit >= compat.real_context)) return false;
  compat.real_context = limit;
  state.log(`COMPAT: ${providerName} real context limit ${reason}: ${limit} tokens`);
  const p = state.PROVIDERS.find((pr) => pr.name === providerName);
  if (p && p.context > limit) p.context = limit;
  return true;
}

function detectIncompatibility(providerName, statusCode, errorBody, meta = {}) {
  const body = String(errorBody);
  const c = getCompat(providerName);
  let changed = false;
  const isCopilot = /copilot/i.test(providerName);

  // reasoning/thinking content rejected
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

  if (/adaptive thinking.*not support|not support.*adaptive thinking/i.test(body) && (statusCode === 400 || statusCode === 422)) {
    if (!c.no_adaptive_thinking) {
      c.no_adaptive_thinking = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects adaptive thinking — will disable adaptive thinking`);
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
  const isOutputTokenLimitError = /\bmax_tokens\b|completion tokens?|output tokens?/i.test(body);
  const ctxMatch = isOutputTokenLimitError
    ? null
    : body.match(/Max size:\s*(\d+)\s*tokens/i) ||
      body.match(/maximum context length.*?(\d+)/i) ||
      body.match(/prompt token count\s+of\s+\d+\s+exceeds\s+(?:the\s+)?limit\s+of\s*(\d+)/i) ||
      body.match(/prompt token count.*?exceeds.*?max(?:imum)? input length(?: of)?\s*(\d+)/i) ||
      body.match(/max(?:imum)? input length(?: of)?\s*(\d+)/i) ||
      body.match(/max.*?(\d+)\s*tokens/i);
  if (ctxMatch && (statusCode === 400 || statusCode === 413)) {
    const limit = parseInt(ctxMatch[1], 10);
    changed = rememberRealContext(providerName, c, limit, "detected") || changed;
  }

  // Some app-backed APIs return only "input exceeds the context window" wrapped
  // in a 500/422 invalid_argument, without a numeric max. Infer a conservative
  // ceiling from the failing request so routing stops selecting that model for
  // similarly large payloads.
  const contextOverflowNoLimit = /input exceeds (?:the )?context window|exceeds (?:the )?context window|context window.*exceed|context length exceeded|too large for model|prompt is too long|prompt too long|prompt token count.*exceeds/i.test(body);
  if (!ctxMatch && contextOverflowNoLimit && statusCode >= 400) {
    const inputTokens = Number(meta.inputTokens || 0);
    const estimatedTokens = Number(meta.estimatedTokens || 0);
    const observed = inputTokens > 0 ? inputTokens : estimatedTokens;
    if (observed > 1000) {
      const advertised = Number(meta.providerContext || 0);
      let inferred = Math.floor(observed * 0.85);
      if (advertised > 1000) inferred = Math.min(inferred, advertised - 1024);
      inferred = Math.max(4096, inferred);
      changed = rememberRealContext(providerName, c, inferred, "inferred from overflow") || changed;
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

  // Tool calling not supported by model.
  if (/tool.calling.*not supported/i.test(body) && statusCode === 400) {
    if (!c.no_tools) {
      c.no_tools = true;
      changed = true;
      state.log(`COMPAT: ${providerName} does not support tool calling — will avoid for tool requests`);
    }
  }

  // Copilot-backed compatibility routes can return only "Bad Request" for
  // tool-bearing payloads they cannot translate. Learn that as a tool support
  // incompatibility so routing stops retrying the same bad API shape.
  if (/^Bad Request$/i.test(body.trim()) && statusCode === 400 && isCopilot) {
    if (meta.isStreaming) {
      if (!c.no_stream) {
        c.no_stream = true;
        changed = true;
        if (c.stream_only) delete c.stream_only;
        state.log(`COMPAT: ${providerName} returned bare Bad Request for streaming — will avoid direct stream requests`);
      }
    } else if (meta.hasTools && !c.no_tools) {
      c.no_tools = true;
      changed = true;
      state.log(`COMPAT: ${providerName} returned bare Bad Request for tools — will avoid for tool requests`);
    }
  }

  if (
    statusCode === 400 &&
    isCopilot &&
    (
      /model_not_supported/i.test(body) ||
      /requested model is not supported/i.test(body)
    )
  ) {
    if (!c.unsupported_model) {
      c.unsupported_model = true;
      changed = true;
      state.log(`COMPAT: ${providerName} model is not supported on this route — will avoid future selection`);
    }
  }

  // Image input not supported by this model or compatibility route.
  const imageUnsupported =
    /not supported for vision|vision.*not supported|image input.*not supported|images?.*not supported by (?:this )?model|does not support (?:image|vision)/i.test(body);
  if (imageUnsupported && statusCode >= 400 && meta.hasImages) {
    if (!c.no_images) {
      c.no_images = true;
      changed = true;
      state.log(`COMPAT: ${providerName} does not support image input — will avoid for image requests`);
    }
  }

  // Some routes support remote image URLs but reject data URLs/base64 media.
  const dataImageUnsupported =
    /URL scheme must be http or https, got data|data\s*URL.*not supported|base64.*image.*not supported|validating image item: image media type not supported|image media type not supported/i.test(body);
  if (dataImageUnsupported && statusCode >= 400 && meta.hasDataImages) {
    if (!c.no_data_images) {
      c.no_data_images = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects data URL images — will avoid for base64 screenshot requests`);
    }
  }

  // parallel_tool_calls not supported.
  if (/parallel_tool_calls.*not supported/i.test(body) && (statusCode === 400 || statusCode === 422)) {
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

  // tool_choice rejected, including through compatibility wrappers that translate upstream errors.
  if (body.includes("tool_choice") && (statusCode === 400 || statusCode === 404 || statusCode === 500)) {
    if (!c.no_tool_choice) {
      c.no_tool_choice = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects tool_choice — will strip`);
    }
  }

  // Content array not supported; retry as plain text.
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
    changed = rememberRealContext(providerName, c, tokenLimit, `inferred from char limit ${charLimit}`) || changed;
  }

  // Monthly/quota/usage limit
  if (body.includes("reached the limit") || body.includes("MONTHLY_REQUEST_COUNT") || body.includes("usage limit has been reached") || body.includes("out of") || body.includes("limit will reset")) {
    setCooldown(providerName, 3600_000, "quota/usage limit");
    state.log(`QUOTA: ${providerName} quota/usage limit exhausted — cooldown 1h`);
  }

  // Daily token limit
  if (body.includes("1-day token limit") || body.includes("rate_limit_daily")) {
    setCooldown(providerName, 3600_000, "daily token limit");
    state.log(`QUOTA: ${providerName} daily token limit — cooldown 1h`);
  }

  // Billing/plan quota
  if (body.includes("exceeded your current quota") || body.includes("check your plan and billing")) {
    setCooldown(providerName, 3600_000, "billing quota exceeded");
    state.log(`QUOTA: ${providerName} billing quota exceeded — cooldown 1h`);
  }

  // Trial key rate limit
  if (body.includes("Trial key") && body.includes("limited to")) {
    setCooldown(providerName, 60_000, "trial rate limit");
    state.log(`RATE: ${providerName} trial key rate limit — cooldown 1min`);
  }

  // Free-tier daily model/request limit
  if (body.includes("free-models-per-day") || body.includes("Add 5 credits to unlock")) {
    setCooldown(providerName, 3600_000, "free-tier daily limit");
    state.log(`QUOTA: ${providerName} free-tier daily limit — cooldown 1h`);
  }

  // Tool-call signature missing; avoid tool-history replay for this provider.
  if (body.includes("thought_signature") && statusCode === 400) {
    if (!c.no_tool_history) {
      c.no_tool_history = true;
      changed = true;
      state.log(`COMPAT: ${providerName} rejects tool history without thought_signature — will avoid for tool-heavy requests`);
    }
    setCooldown(providerName, 300_000, "thought_signature missing");
  }

  // Tool results missing — Codex/OpenAI server-side state mismatch, cooldown briefly
  if (body.includes("Tool results are missing") && statusCode === 500) {
    setCooldown(providerName, 300_000, "tool state mismatch");
    state.log(`COMPAT: ${providerName} tool state mismatch — cooldown 5min`);
  }

  // Windsurf can expose app-discovered model configs that later reject large
  // Claude Code payloads as invalid_argument. Cool the specific model quickly
  // so fallback can settle on a working provider instead of re-trying it.
  if (/windsurf/i.test(providerName) && statusCode >= 400 && /invalid_argument/i.test(body)) {
    setCooldown(providerName, 3600_000, "windsurf invalid_argument");
    state.log(`COMPAT: ${providerName} invalid_argument — cooldown 1h`);
  }

  if (/windsurf/i.test(providerName) && statusCode >= 400 && /permission_denied/i.test(body)) {
    setCooldown(providerName, 3600_000, "windsurf permission_denied");
    state.log(`COMPAT: ${providerName} permission_denied — cooldown 1h`);
  }

  // Socket hang up / streaming failed from providers that reject on quota (Codex free tier)
  if ((body.includes("socket hang up") || body.includes("Streaming request failed")) && /codex/i.test(providerName)) {
    setCooldown(providerName, 3600_000, "connection rejected (quota)");
    state.log(`QUOTA: ${providerName} connection rejected (likely quota) — cooldown 1h`);
  }

  // Codex/OpenAI usage_limit_reached
  if (body.includes("usage_limit_reached") || (body.includes("usage limit") && body.includes("resets"))) {
    setCooldown(providerName, 3600_000, "usage limit reached");
    state.log(`QUOTA: ${providerName} usage limit reached — cooldown 1h`);
  }

  // Credit/quota rate limits. Only match in the prefix to avoid request-body echoes.
  const rateLimitPrefix = body.substring(0, 500);
  const creditOrQuotaLimit =
    /\b(rate[_ -]?limit|too many requests|quota|credits|billing|free[- ]?tier|daily limit)\b/i.test(rateLimitPrefix) ||
    (/\b(?:exceeded|exceeds)\b/i.test(rateLimitPrefix) && /\b(?:quota|credit|daily|monthly|rate|billing|allocation)\b/i.test(rateLimitPrefix));
  if (
    statusCode === 429 &&
    creditOrQuotaLimit
  ) {
    setCooldown(providerName, 3600_000, "provider rate/credit limit");
    state.log(`QUOTA: ${providerName} provider rate/credit limit — cooldown 1h`);
  }

  // Context window from error, e.g. "exceeded this model context window limit (24000)".
  const cfCtxMatch = body.match(/context window limit \((\d+)\)/i) || body.match(/exceeded.*?(\d+)\)/i);
  if (cfCtxMatch && (statusCode === 413)) {
    const limit = parseInt(cfCtxMatch[1], 10);
    changed = rememberRealContext(providerName, c, limit, "detected") || changed;
  }

  // max_tokens must be <= N.
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
// Stalling detection is diagnostic-only. It must not affect provider health.
// ---------------------------------------------------------------------------

function recordStalling(name) {
  state.log(`POSSIBLE-STALL: ${name} observed; no cooldown, ban, or score penalty applied`);
}

// Per-group ban list for non-stall routing safeguards.
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
  clearCooldown,
  isOnCooldown,
  isRecentUnresolvedChronicStalling,
  loadQuotaDisabled,
  saveQuotaDisabled,
  disableProviderQuota,
  isQuotaDisabled,
  isQuotaExhaustedError,
  isTemporaryRateLimit,
  recordThinkingOk,
  providerScore,
  getPolicyUsage,
  providerPolicyBonus,
  recordPolicyUse,
  recordToolInvalid,
  loadCompat,
  saveCompat,
  getCompat,
  getEffectiveContext,
  detectIncompatibility,
  recordStalling,
  banFromGroup,
  isBannedFromGroup,
};
