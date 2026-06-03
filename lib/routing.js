"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const state = require("./state");
const scoring = require("./scoring");
const compaction = require("./compaction");
const transforms = require("./transforms");
const providers = require("./providers");
const providerAdapters = require("./provider-adapters");
const routingPolicy = require("./routing-policy");
const memory = require("./memory");
const hiddenMemoryMarkers = require("./memory/hidden-markers");
const humanApproval = require("./human-approval");
const mediaContent = require("./media-content");

// Late-bound dependencies from entry point (set via init())
let _sendError;
let _trackSessionTokens;

function init({ sendError, trackSessionTokens }) {
  _sendError = sendError;
  _trackSessionTokens = trackSessionTokens;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Build OpenAI-compatible usage headers for IDE/client consumption
function buildUsageHeaders(provider, reqBody, usage) {
  const effCtx = scoring.getEffectiveContext(provider);
  const policyProfile = routingPolicy.classifyProvider(provider);
  const inputTokens = usage?.prompt_tokens || estimateRequestInputTokens(reqBody);
  const outputTokens = usage?.completion_tokens || 0;
  const totalTokens = inputTokens + outputTokens;
  const cachedInputTokens = cachedInputTokensFromUsage(usage);
  const remaining = Math.max(0, effCtx - totalTokens);
  const sid = memory.getSession(reqBody.messages)?.id;
  const ss = sid ? state.sessionStats[sid] : null;
  const routeTrace = reqBody._routeTrace || null;
  const routeTraceHeader = routeTrace ? encodeJsonHeader(routeTrace) : "";
  const memoryStats = reqBody._memoryStats || {};
  const compactionStats = reqBody._compactionStats || {};
  const routeWarnings = Array.isArray(reqBody._routeWarnings) ? reqBody._routeWarnings.filter(Boolean) : [];

  const headers = {
    "X-LLM-Provider": provider.name,
    "X-LLM-Model": provider.model,
    "X-LLM-Context-Length": String(effCtx),
    "X-LLM-Tokens-Used": String(totalTokens),
    "X-LLM-Tokens-Remaining": String(remaining),
    "X-LLM-Prompt-Tokens": String(inputTokens),
    "X-LLM-Completion-Tokens": String(outputTokens),
    "X-LLM-Cached-Input-Tokens": String(cachedInputTokens),
    "X-LLM-Cost-Group": String(policyProfile.cost_group),
    ...(provider.cost_multiplier !== undefined && provider.cost_multiplier !== null ? {
      "X-LLM-Cost-Multiplier": String(provider.cost_multiplier),
    } : {}),
    "X-LLM-Thinking-Effort": policyProfile.thinking_effort,
    "X-LLM-Speed-Group": String(policyProfile.speed_group),
    ...(ss ? {
      "X-LLM-Session-Requests": String(ss.requests),
      "X-LLM-Session-Total-Tokens": String(ss.totalInputTokens + ss.totalOutputTokens),
      "X-LLM-Session-Cached-Input-Tokens": String(ss.cachedInputTokens || 0),
    } : {}),
  };
  if (routeTraceHeader) headers["X-LLM-Route-Trace"] = routeTraceHeader;
  if (routeTrace) {
    headers["X-LLM-Route-Task"] = String(routeTrace.task_kind || "");
    headers["X-LLM-Route-Gate"] = String(routeTrace.gate || "none");
    headers["X-LLM-Route-Shape"] = String(routeTrace.shape || "");
    headers["X-LLM-Assessment-Source"] = String(routeTrace.assessment_source || "");
  }
  headers["X-LLM-Memory-Injected-Tokens"] = String(Number(memoryStats.injected_tokens || 0));
  headers["X-LLM-Memory-Recall-Retries"] = String(Number(memoryStats.recall_retries || 0));
  headers["X-LLM-Compaction-Archive-Refs"] = String(Number(compactionStats.archive_refs || 0));
  headers["X-LLM-Compaction-AI-Summary"] = compactionStats.ai_summary_used ? "true" : "false";
  headers["X-LLM-Compaction-Phase"] = String(compactionStats.phase || "");
  if (routeWarnings.length > 0) headers["X-LLM-Warning"] = routeWarnings.join("; ").substring(0, 500);
  return headers;
}

function cachedInputTokensFromUsage(usage = {}) {
  return Number(
    usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens
      ?? usage?.prompt_tokens_details?.cache_read_tokens
      ?? usage?.input_tokens_details?.cache_read_tokens
      ?? usage?.cache_read_input_tokens
      ?? 0,
  ) || 0;
}

function recordCachedInputTokens(sessionId, providerName, cachedTokens) {
  if (!sessionId || !cachedTokens || !state.sessionStats[sessionId]) return;
  const session = state.sessionStats[sessionId];
  session.cachedInputTokens = (session.cachedInputTokens || 0) + cachedTokens;
  if (providerName && session.providers?.[providerName]) {
    session.providers[providerName].cachedInput = (session.providers[providerName].cachedInput || 0) + cachedTokens;
  }
}

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
    req.setTimeout(state.REQUEST_TIMEOUT, () => { req.destroy(new Error("timeout")); });
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
  req.setTimeout(state.REQUEST_TIMEOUT, () => { req.destroy(new Error("timeout")); });
  if (body) req.write(body);
  req.end();
  return req;
}

function hasRequiredToolContract(reqBody = {}) {
  if (reqBody._llmProxyRequiredToolContract || reqBody._llmProxyOriginalRequiredToolContract) return true;
  const toolChoice = reqBody.tool_choice;
  if (toolChoice === "required" || toolChoice === "any") return true;
  if (toolChoice && typeof toolChoice === "object") {
    const type = String(toolChoice.type || "").trim().toLowerCase();
    return type !== "auto" && type !== "none";
  }
  const functionCall = reqBody.function_call;
  if (functionCall && functionCall !== "auto" && functionCall !== "none") return true;
  return false;
}

function responseValidationRequest(reqBody = {}, transformedBody = {}) {
  const originalRequiredToolContract = hasRequiredToolContract(reqBody);
  const merged = { ...(reqBody || {}), ...(transformedBody || {}) };
  for (const key of ["tools", "functions", "tool_choice", "function_call", "parallel_tool_calls"]) {
    if (Object.prototype.hasOwnProperty.call(transformedBody || {}, key)) {
      merged[key] = transformedBody[key];
    } else {
      delete merged[key];
    }
  }
  if (reqBody._llmProxyDifficulty && !merged._llmProxyDifficulty) merged._llmProxyDifficulty = reqBody._llmProxyDifficulty;
  if (reqBody._llmProxyCompactedContext && !merged._llmProxyCompactedContext) merged._llmProxyCompactedContext = reqBody._llmProxyCompactedContext;
  if (reqBody._inputTokens && !merged._inputTokens) merged._inputTokens = reqBody._inputTokens;
  if (reqBody._estimatedTokens && !merged._estimatedTokens) merged._estimatedTokens = reqBody._estimatedTokens;
  if (originalRequiredToolContract) merged._llmProxyRequiredToolContract = true;
  if (requestHasToolHistory(reqBody) && !merged._llmProxyOriginalHasToolHistory) merged._llmProxyOriginalHasToolHistory = true;
  const originalUserText = latestHumanUserText(reqBody);
  if (originalUserText && !merged._llmProxyOriginalLastUserText) merged._llmProxyOriginalLastUserText = originalUserText;
  return merged;
}

function isDirectNoToolRequest(reqBody = {}) {
  const hasToolHistory = (reqBody.messages || []).some((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls?.length > 0));
  if (hasToolHistory) return false;
  if (hasRequiredToolContract(reqBody)) return false;
  return routingPolicy.isPassiveNoToolRequest(reqBody);
}

function budgetBodyForRequest(reqBody = {}) {
  if (!isDirectNoToolRequest(reqBody)) return reqBody;
  return { ...reqBody, tools: undefined, functions: undefined };
}

function estimateRequestInputTokens(reqBody = {}) {
  const budgetBody = budgetBodyForRequest(reqBody);
  return compaction.estimateTokens(budgetBody.messages) + compaction.estimateRequestSchemaTokens(budgetBody);
}

const EXTERNAL_PROXY_FIELD_RE = /^_(?:llmProxy|assessment|memory|routeTrace|routeWarnings|sessionLastProvider|claudeCode|inputTokens|estimatedTokens|compactRetries|preRouteCompactRetries|midCompactRetries|postCompactRetries|compactionStats|skipAISummary)/;

function stripExternalProxyFields(value, path = []) {
  if (path[0] === "tools" || path[0] === "functions" || path[0] === "response_format") return value;
  if (Array.isArray(value)) return value.map((child, idx) => stripExternalProxyFields(child, path.concat(String(idx))));
  if (!value || typeof value !== "object") return value;

  const cleaned = {};
  for (const [key, child] of Object.entries(value)) {
    if (EXTERNAL_PROXY_FIELD_RE.test(key)) continue;
    cleaned[key] = stripExternalProxyFields(child, path.concat(key));
  }

  if (cleaned.role === "developer") {
    cleaned.role = "user";
    cleaned.content = `Client-supplied developer message (untrusted):\n${messageContentText(cleaned.content)}`;
  }
  return cleaned;
}

function encodeJsonHeader(value) {
  try {
    const json = JSON.stringify(value);
    if (!json || json.length > 12000) return "";
    return Buffer.from(json, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  } catch {
    return "";
  }
}

function providerTraceSource(provider = {}) {
  const name = String(provider.name || "").trim();
  if (name) return name.split("-")[0] || name;
  const family = String(provider.family || provider.source_family || "").trim();
  if (family) return family;
  const model = String(provider.model || "").trim();
  const prefix = model.match(/^([a-z][a-z0-9_-]*)\//i)?.[1];
  return prefix || String(provider.protocol || provider.via || "unknown");
}

function claudeEquivalentModelKey(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text.includes("claude")) return "";
  const match = text.match(/\bclaude[-_ .]?(opus|sonnet|haiku)[-_ .]*(\d+)(?:[-_ .]*(\d+))?/i);
  if (!match) return "";
  let major = String(match[2] || "");
  let minor = String(match[3] || "");
  if (!minor && major.length >= 2 && major.length <= 3) {
    minor = major.slice(1);
    major = major.slice(0, 1);
  }
  return `claude:${match[1].toLowerCase()}:${major}:${minor || "0"}`;
}

function providerClaudeEquivalentModelKey(provider = {}) {
  return claudeEquivalentModelKey([
    provider.model,
    provider.upstream_model,
    provider.name,
  ].filter(Boolean).join(" "));
}

function isDirectClaudeLargeProvider(provider = {}) {
  const family = String(provider.family || provider.source_family || "").trim().toLowerCase();
  const protocol = String(provider.protocol || "").trim().toLowerCase();
  const model = String(provider.model || provider.upstream_model || "").trim().toLowerCase();
  const name = String(provider.name || "").trim().toLowerCase();
  const directClaude =
    family === "claude" ||
    protocol === "anthropic" ||
    model.startsWith("claude/") ||
    name.startsWith("claude-");
  if (!directClaude) return false;
  if (/\bhaiku\b/.test(`${name} ${model}`)) return false;
  return routingPolicy.providerMaxRoutingLevel(provider) >= 4;
}

function coolDirectClaudeLargePeers(triggerProvider = {}, durationMs = 60 * 60_000) {
  let cooled = 0;
  for (const candidate of state.PROVIDERS || []) {
    if (!candidate?.name || !isDirectClaudeLargeProvider(candidate)) continue;
    scoring.setCooldown(candidate.name, durationMs, `direct Claude rate limit via ${triggerProvider.name || "unknown"}`);
    cooled += 1;
  }
  if (cooled > 1) {
    state.log(`RATE-COHORT: ${triggerProvider.name || "Claude"} cooled ${cooled} direct Claude large provider(s) after shared rate limit`);
  }
  return cooled;
}

function getDirectModelFallbackProviders(requestedModel = "", failedProvider = {}, reqBody = {}) {
  const key = claudeEquivalentModelKey(requestedModel) || providerClaudeEquivalentModelKey(failedProvider);
  if (!key) return [];
  const estimatedTokens = Number(reqBody._estimatedTokens || 0);
  const requiresTools = (
    (reqBody.tools?.length || 0) > 0 ||
    (reqBody.functions?.length || 0) > 0 ||
    requestHasEffectiveToolHistory(reqBody) ||
    hasRequiredToolContract(reqBody)
  );

  return (state.PROVIDERS || [])
    .filter((candidate) => candidate?.name && candidate.key && candidate.alive !== false)
    .filter((candidate) => candidate.name !== failedProvider.name)
    .filter((candidate) => providerClaudeEquivalentModelKey(candidate) === key)
    .filter((candidate) => !scoring.isOnCooldown(candidate.name) && !scoring.isQuotaDisabled(candidate.name))
    .filter((candidate) => !requiresTools || (candidate.caps || []).includes("tools"))
    .filter((candidate) => !requestHasImageInput(reqBody) || providerSupportsImageInput(candidate, reqBody))
    .filter((candidate) => providerCanFitRoutedRequest(candidate, estimatedTokens, reqBody))
    .sort((a, b) => (
      scoring.providerScore(b) + scoring.providerPolicyBonus(b, reqBody)
    ) - (
      scoring.providerScore(a) + scoring.providerPolicyBonus(a, reqBody)
    ));
}

function providerTraceCandidate(provider = {}, rank = 0) {
  const profile = routingPolicy.classifyProvider(provider);
  const score = Number.isFinite(provider._lastRoutingScore) ? provider._lastRoutingScore : scoring.providerScore(provider);
  const candidate = {
    rank,
    provider: provider.name || "",
    model: provider.model || "",
    source: providerTraceSource(provider),
    score: Number.isFinite(score) ? Number(score.toFixed(4)) : null,
    cost_group: profile.cost_group,
    quality_group: profile.quality_group,
    thinking_effort: profile.thinking_effort,
    thinking_level: profile.thinking_level,
    speed_group: profile.speed_group,
    context: scoring.getEffectiveContext(provider),
  };
  if (Number.isFinite(provider._routingDiversityPenalty) && provider._routingDiversityPenalty > 0) {
    candidate.diversity_penalty = Number(provider._routingDiversityPenalty.toFixed(4));
  }
  return candidate;
}

function routeProfileTrace(requestedModel, reqBody = {}, currentTokens = 0) {
  const profile = routingPolicy.effectiveRequestProfile(reqBody);
  const stepShape = profile.stepShape || {};
  return {
    requested_model: requestedModel,
    assessment_source: reqBody._llmProxyDifficulty ? "assessment" : "heuristic",
    task_kind: profile.taskKind || "general",
    gate: stepShape.gate || "none",
    shape: stepShape.shape || "unknown",
    route_profile: {
      level: profile.level,
      task_level: profile.taskLevel,
      context_level: profile.contextLevel,
      cost_target: profile.costTarget,
      thinking_level: profile.thinkingLevel,
      thinking_effort: profile.effort || profile.thinkingEffort || "",
      speed_target: profile.speedTarget,
      input_tokens: currentTokens,
      estimated_tokens: Number(reqBody._estimatedTokens || 0),
      tools: (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0),
    },
  };
}

function uniqueSources(providers = []) {
  return [...new Set(providers.map(providerTraceSource).filter(Boolean))];
}

function setRouteTrace(reqBody = {}, requestedModel = "", rawProviders = [], routedProviders = [], gatedProviders = [], currentTokens = 0) {
  reqBody._routeTrace = {
    ...routeProfileTrace(requestedModel, reqBody, currentTokens),
    eligible_sources: uniqueSources(routedProviders),
    gated_sources: uniqueSources(gatedProviders),
    candidates: routedProviders.slice(0, 3).map((provider, idx) => providerTraceCandidate(provider, idx + 1)),
  };
  if (Array.isArray(rawProviders) && rawProviders.length > routedProviders.length) {
    reqBody._routeTrace.raw_candidate_count = rawProviders.length;
  }
  reqBody._routeTrace.candidate_count = routedProviders.length;
}

function markRouteSelected(reqBody = {}, provider = {}) {
  if (!reqBody._routeTrace) return;
  reqBody._routeTrace.selected_source = providerTraceSource(provider);
  reqBody._routeTrace.selected_provider = provider.name || "";
  reqBody._routeTrace.selected_model = provider.model || "";
}

function markRouteFailure(reqBody = {}, provider = {}, status = 0, error = "") {
  if (!reqBody._routeTrace) return;
  const source = providerTraceSource(provider);
  reqBody._routeTrace.failed_sources = reqBody._routeTrace.failed_sources || [];
  reqBody._routeTrace.failures = reqBody._routeTrace.failures || [];
  reqBody._routeTrace.failed_sources.push(source);
  reqBody._routeTrace.failures.push({
    source,
    provider: provider.name || "",
    status,
    error: String(error || "").substring(0, 160),
  });
}

function addRouteWarning(reqBody = {}, warning = "") {
  const text = String(warning || "").trim();
  if (!text) return;
  reqBody._routeWarnings = reqBody._routeWarnings || [];
  if (!reqBody._routeWarnings.includes(text)) reqBody._routeWarnings.push(text);
}

function recordPostRouteAssessmentTrace(reqBody = {}, provider = {}, markerProfile = null, origin = "post_route", stream = false) {
  if (!reqBody._routeTrace || !markerProfile) return;
  reqBody._routeTrace.post_route_assessment = {
    origin,
    stream: !!stream,
    provider: provider.name || "",
    source: providerTraceSource(provider),
    level: markerProfile.level,
    task_level: markerProfile.taskLevel,
    context_level: markerProfile.contextLevel,
    effort: markerProfile.effort || markerProfile.thinkingEffort || "",
    speed: markerProfile.speedTarget,
    reason: markerProfile.reason || markerProfile.taskKind || "",
  };
}

function ensureMemoryStats(reqBody = {}) {
  if (!reqBody._memoryStats) {
    reqBody._memoryStats = { injected_tokens: 0, recall_retries: 0 };
  }
  return reqBody._memoryStats;
}

function recordMemoryInjection(reqBody = {}, text = "") {
  if (!text) return;
  const stats = ensureMemoryStats(reqBody);
  stats.injected_tokens += compaction.estimateTokens([{ role: "system", content: String(text) }]);
}

function recordMemoryRecallRetry(reqBody = {}) {
  const stats = ensureMemoryStats(reqBody);
  stats.recall_retries += 1;
}

function ensureCompactionStats(reqBody = {}) {
  if (!reqBody._compactionStats) {
    reqBody._compactionStats = { archive_refs: 0, ai_summary_used: false, phase: "" };
  }
  return reqBody._compactionStats;
}

function recordCompactionTelemetry(reqBody = {}, phase = "", refs = [], compacted = null) {
  if (!compacted) return;
  const stats = ensureCompactionStats(reqBody);
  stats.archive_refs += Array.isArray(refs) ? refs.length : 0;
  stats.ai_summary_used = !!(stats.ai_summary_used || compacted.aiSummaryUsed);
  stats.phase = phase || stats.phase || "";
  reqBody._llmProxyCompactedContext = true;
  reqBody._llmProxyCompactedPhase = phase || reqBody._llmProxyCompactedPhase || "unknown";
}

function providerCanFitRoutedRequest(provider, estimatedTokens, reqBody = {}) {
  const effectiveContext = scoring.getEffectiveContext(provider);
  if (estimatedTokens <= 0 || effectiveContext >= estimatedTokens) return true;

  const requestedMaxTokens = Number(reqBody?.max_tokens || 4096);
  const inputTokens = Number(reqBody?._inputTokens || estimateRequestInputTokens(reqBody) || 0);
  const oversizeFromOutputReserve = requestedMaxTokens > 0
    && inputTokens > 0
    && estimatedTokens <= inputTokens + requestedMaxTokens + 1024;
  if (!oversizeFromOutputReserve) return false;

  return inputTokens < effectiveContext;
}

const PRE_ROUTE_COMPACT_POLICIES = new Set(["economy", "balanced", "speed"]);

function preRouteCompactTargetRatio() {
  const ratio = Number(process.env.LLM_PROXY_PRECOMPACT_TARGET_RATIO || "0.8");
  if (!Number.isFinite(ratio)) return 0.8;
  return Math.max(0.5, Math.min(0.85, ratio));
}

function getProvidersForRequestedModel(requestedModel, estimatedTokens, reqBody = {}) {
  return requestedModel === "auto"
    ? getProvidersForAuto(reqBody.messages, estimatedTokens, reqBody)
    : getProvidersForGroup(requestedModel, estimatedTokens, reqBody);
}

function providerEffectiveCostGroup(provider = {}) {
  const profile = routingPolicy.classifyProvider(provider);
  const multiplier = routingPolicy.costMultiplierForProvider(provider);
  if (multiplier === null || multiplier === undefined) return profile.cost_group;
  return Math.min(profile.cost_group, routingPolicy.costGroupFromCostMultiplier(multiplier));
}

function isFrontierContextRequest(reqBody = {}, requestedModel = "", profile = {}) {
  const requestText = lastUserText(reqBody);
  const observedTokens = Number(reqBody._inputTokens || reqBody._estimatedTokens || 0);
  const hasTools = ((reqBody.tools?.length || 0) + (reqBody.functions?.length || 0)) > 0;
  const hasToolHistory = (reqBody.messages || []).some((message) => message.role === "tool" || message.tool_calls?.length > 0);
  const taskKind = profile.taskKind || "general";
  const explicitMillionContext = /\b(one[- ]?million|1m|million[- ]token|1m[- ]?context|million[- ]?context|large[- ]context|long[- ]context)\b/i.test(requestText);
  const explicitHighRisk = /\b(?:deep research|production incident|hard bug|threat\s+model|privilege\s+bypass|security\s+(?:review|audit)|destructive|human\s+sign[- ]?off|before\s+release)\b/i.test(requestText);
  const hugeToolRecovery =
    observedTokens >= 180000 &&
    (hasTools || hasToolHistory) &&
    (taskKind === "edit_recovery" || taskKind === "architecture_recovery");

  if (requestedModel === "auto-max" && (explicitMillionContext || explicitHighRisk)) return true;
  return profile.contextLevel >= 5 && (explicitMillionContext || explicitHighRisk || hugeToolRecovery || observedTokens >= 500000);
}

function isEfficientPreCompactProvider(provider = {}, reqBody = {}, targets = {}, requestProfile = {}) {
  const profile = routingPolicy.classifyProvider(provider);
  const effectiveCost = providerEffectiveCostGroup(provider);
  const taskKind = requestProfile.taskKind || "general";
  const stepShape = requestProfile.stepShape || {};
  const reviewOrRiskTask =
    taskKind === "completion_review" ||
    taskKind === "code_review" ||
    taskKind === "security_review" ||
    taskKind === "debugging" ||
    taskKind === "refactor" ||
    stepShape.shape === "review" ||
    stepShape.shape === "security";
  const minimumQuality = reviewOrRiskTask || Number(requestProfile.taskLevel || 0) >= 4 ? 4 : 3;
  const minimumThinking = stepShape.shape === "security" || taskKind === "security_review" ? 3 : 0;

  if (effectiveCost > Number(targets.costTarget || 3)) return false;
  if (profile.quality_group < minimumQuality) return false;
  if (profile.thinking_level < minimumThinking) return false;
  return true;
}

function preRouteCompactionEligibility(reqBody = {}, requestedModel = "", currentTotalNeeded = 0, options = {}) {
  if (!options.isGroup) return null;
  if (options.bypassProxyOptimizations) return null;
  if (options.isSummarizationRequest) return null;
  if (reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return null;
  if ((reqBody._preRouteCompactRetries || 0) >= 1) return null;
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length < 6) return null;
  if (!Number.isFinite(currentTotalNeeded) || currentTotalNeeded <= 0) return null;

  const targets = routingPolicy.getPolicyTargets();
  if (!PRE_ROUTE_COMPACT_POLICIES.has(targets.routingPolicy)) return null;
  if (targets.costTarget > 3) return null;

  const requestProfile = routingPolicy.effectiveRequestProfile(reqBody);
  if (isFrontierContextRequest(reqBody, requestedModel, requestProfile)) return null;

  return { targets, requestProfile };
}

function findPreRouteCompactionPlan(reqBody = {}, requestedModel = "", currentTotalNeeded = 0, requestedMaxTokens = 4096, options = {}) {
  const eligibility = preRouteCompactionEligibility(reqBody, requestedModel, currentTotalNeeded, options);
  if (!eligibility) return null;

  const { targets, requestProfile } = eligibility;
  const currentProviders = getProvidersForRequestedModel(requestedModel, currentTotalNeeded, reqBody);
  const currentTop = currentProviders[0] || null;
  const availableProviders = getProvidersForRequestedModel(requestedModel, 0, reqBody);
  if (availableProviders.length === 0) return null;

  const schemaTokens = compaction.estimateRequestSchemaTokens(reqBody);
  const ratio = preRouteCompactTargetRatio();
  const currentTopCost = currentTop ? providerEffectiveCostGroup(currentTop) : Infinity;

  for (const targetProvider of availableProviders) {
    const targetContext = scoring.getEffectiveContext(targetProvider);
    if (!Number.isFinite(targetContext) || targetContext <= requestedMaxTokens + schemaTokens + 512) continue;
    if (providerCanFitRoutedRequest(targetProvider, currentTotalNeeded, reqBody)) continue;
    if (!isEfficientPreCompactProvider(targetProvider, reqBody, targets, requestProfile)) continue;

    const compactTargetTokens = Math.floor((targetContext - schemaTokens) * ratio);
    if (compactTargetTokens <= requestedMaxTokens + 256) continue;
    const simulatedTotalNeeded = compactTargetTokens + schemaTokens;
    if (simulatedTotalNeeded >= currentTotalNeeded) continue;

    const simulatedReq = {
      ...reqBody,
      _inputTokens: Math.max(1, simulatedTotalNeeded - requestedMaxTokens),
      _estimatedTokens: simulatedTotalNeeded,
      _llmProxyPreCompactSimulation: true,
    };
    const simulatedProviders = getProvidersForRequestedModel(requestedModel, simulatedTotalNeeded, simulatedReq);
    const simulatedTop = simulatedProviders[0] || null;
    if (!simulatedTop) continue;
    if (currentTop && simulatedTop.name === currentTop.name) continue;
    if (!isEfficientPreCompactProvider(simulatedTop, simulatedReq, targets, requestProfile)) continue;

    const simulatedTopCost = providerEffectiveCostGroup(simulatedTop);
    if (currentTop && simulatedTopCost > currentTopCost) continue;

    return {
      policy: targets.routingPolicy,
      costTarget: targets.costTarget,
      currentTop,
      simulatedTop,
      targetProvider,
      targetContext,
      compactTargetTokens,
      simulatedTotalNeeded,
      availableCount: availableProviders.length,
      currentCount: currentProviders.length,
    };
  }

  return null;
}

async function maybeApplyPreRouteCompaction(reqBody = {}, requestedModel = "", currentTokens = 0, currentTotalNeeded = 0, requestedMaxTokens = 4096, mpSession = null, options = {}) {
  const plan = findPreRouteCompactionPlan(reqBody, requestedModel, currentTotalNeeded, requestedMaxTokens, options);
  if (!plan) return null;

  state.log(
    `PRECOMPACT-DRYRUN: policy=${plan.policy} cost_target=${plan.costTarget} ` +
    `current=${plan.currentTop?.name || "none"} simulated=${plan.simulatedTop.name} ` +
    `target_provider=${plan.targetProvider.name} target_ctx=${plan.targetContext} ` +
    `target=${plan.compactTargetTokens}tok input=${currentTokens}tok total=${currentTotalNeeded}tok ` +
    `providers=${plan.currentCount}/${plan.availableCount}`,
  );

  reqBody._preRouteCompactRetries = (reqBody._preRouteCompactRetries || 0) + 1;
  let refs = [];
  try { refs = await memory.archiveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
  const originalMessages = reqBody.messages;
  const compacted = await compaction.compactMessagesAsync(
    originalMessages,
    plan.compactTargetTokens,
    requestedMaxTokens,
    refs,
    mpSession?.id,
  );
  if (!compacted) {
    state.log(`PRECOMPACT-SKIP: compaction failed for target=${plan.compactTargetTokens}tok route=${plan.simulatedTop.name}`);
    return null;
  }

  recordCompactionTelemetry(reqBody, "pre", refs, compacted);
  compaction.recordCompactionDrops(mpSession?.id, originalMessages, compacted.messages);
  reqBody.messages = compacted.messages;

  try {
    if (mpSession?.id) {
      const lastMsg = originalMessages[originalMessages.length - 1];
      state.sessionCompactCache[mpSession.id] = {
        compactedMessages: compacted.messages,
        originalMsgCount: originalMessages.length,
        lastOriginalContent: messageContentText(lastMsg?.content),
        timestamp: Date.now(),
      };
    }
  } catch {}

  const newInputTokens = estimateRequestInputTokens(reqBody);
  const newTotalNeeded = newInputTokens + requestedMaxTokens;
  reqBody._inputTokens = newInputTokens;
  reqBody._estimatedTokens = newTotalNeeded;
  state.log(
    `PRECOMPACT: ${plan.currentTop?.name || "none"} -> ${plan.simulatedTop.name} ` +
    `${currentTokens}tok -> ${newInputTokens}tok total=${newTotalNeeded}tok ai_summary=${compacted.aiSummaryUsed ? "true" : "false"}`,
  );

  return {
    ...plan,
    inputTokens: newInputTokens,
    totalNeeded: newTotalNeeded,
  };
}

function providersForRequestedModelAtAnyContext(requestedModel = "", reqBody = {}) {
  if (requestedModel === "auto") return getProvidersForAuto(reqBody.messages, 0, reqBody);
  if (requestedModel in state.GROUPS) return getProvidersForGroup(requestedModel, 0, reqBody);
  const provider = findProviderByModel(requestedModel);
  return provider ? [provider] : [];
}

function maxContextForRequestedModel(requestedModel = "", reqBody = {}) {
  const candidates = providersForRequestedModelAtAnyContext(requestedModel, reqBody);
  return Math.max(...candidates.map((provider) => scoring.getEffectiveContext(provider)), 0);
}

function emergencyCompactionBreadthFloor(candidateCount = 0, env = process.env) {
  const configured = Number(env.LLM_PROXY_EMERGENCY_COMPACT_MIN_PROVIDERS || "");
  const baseline = Number.isFinite(configured) && configured > 0 ? configured : 4;
  const scaled = Math.ceil(Number(candidateCount || 0) * 0.1);
  return Math.max(2, Math.min(12, Math.max(baseline, scaled)));
}

function quietlyGateLargeModelProviders(providers = [], reqBody = {}, requestedModel = "", isGroup = false) {
  if (!isGroup || !isLargeAssessmentGatedGroup(requestedModel)) return providers;
  if (reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return providers;
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) return providers;
  const profile = reqBody._llmProxyDifficulty || null;
  let gated = providers.filter((provider) => assessmentAllowsProvider(profile, provider));
  if (profile && providers.length > 0 && gated.length === 0 && assessmentRequestedLevel(profile) >= 4) {
    gated = upwardAssessmentFallbackProviders(providers, profile);
    if (gated.length === 0) {
      gated = providers.filter((provider) => assessmentAllowsProvider(profile, provider, { enforceLevelFloor: false }));
    }
  }
  return gated;
}

function emergencyCompactionTargetPlan(reqBody = {}, requestedModel = "", requestedMaxTokens = 4096, schemaTokens = 0, maxContext = 0, env = process.env) {
  const isGroup = requestedModel in state.GROUPS || requestedModel === "auto";
  const requestProfile = routingPolicy.effectiveRequestProfile(reqBody, env);
  const requestText = lastUserText(reqBody);
  const explicitMillionContext = /\b(one[- ]?million|1m|million[- ]token|1m[- ]?context|million[- ]?context|large[- ]context|long[- ]context)\b/i.test(requestText);
  const explicitHighRisk = /\b(?:deep research|production incident|hard bug|threat\s+model|privilege\s+bypass|security\s+(?:review|audit)|destructive|human\s+sign[- ]?off|before\s+release)\b/i.test(requestText);
  if ((requestedModel === "auto-max" || Number(requestProfile.contextLevel || 0) >= 5) && (explicitMillionContext || explicitHighRisk)) {
    return {
      targetContext: maxContext,
      fallbackCount: 1,
      candidateCount: 1,
      minFallbackProviders: 1,
      reason: "frontier",
    };
  }

  const rawCandidates = providersForRequestedModelAtAnyContext(requestedModel, reqBody);
  const gatedCandidates = quietlyGateLargeModelProviders(rawCandidates, reqBody, requestedModel, isGroup);
  const minimumUsefulContext = Number(requestedMaxTokens || 0) + Number(schemaTokens || 0) + 512;
  const boundedCandidates = gatedCandidates.filter((provider) => {
    const context = scoring.getEffectiveContext(provider);
    return Number.isFinite(context) && context <= maxContext && context > minimumUsefulContext;
  });
  const requestedLevel = Math.max(
    Number(requestProfile.level || 0),
    Number(requestProfile.taskLevel || 0),
    Number(requestProfile.contextLevel || 0),
  );
  const levelCandidates = requestedLevel >= 4
    ? boundedCandidates.filter((provider) => routingPolicy.providerMaxRoutingLevel(provider) >= 4)
    : boundedCandidates;
  const candidates = levelCandidates.length >= 2 ? levelCandidates : boundedCandidates;
  if (candidates.length < 2) {
    return {
      targetContext: maxContext,
      fallbackCount: candidates.length,
      candidateCount: candidates.length,
      minFallbackProviders: 1,
      reason: "max_context",
    };
  }

  const minFallbackProviders = emergencyCompactionBreadthFloor(candidates.length, env);
  const contexts = [...new Set(candidates.map((provider) => scoring.getEffectiveContext(provider)))]
    .filter((context) => Number.isFinite(context) && context > minimumUsefulContext)
    .sort((a, b) => b - a);
  let bestFallback = null;
  for (const context of contexts) {
    const cohort = candidates.filter((provider) => scoring.getEffectiveContext(provider) >= context);
    const entry = {
      targetContext: context,
      fallbackCount: cohort.length,
      candidateCount: candidates.length,
      minFallbackProviders,
      reason: cohort.length >= minFallbackProviders ? "fallback_breadth" : "fallback_pair",
    };
    if (cohort.length >= minFallbackProviders) return entry;
    if (!bestFallback && cohort.length >= 2) bestFallback = entry;
  }

  return bestFallback || {
    targetContext: maxContext,
    fallbackCount: candidates.filter((provider) => scoring.getEffectiveContext(provider) >= maxContext).length,
    candidateCount: candidates.length,
    minFallbackProviders,
    reason: "max_context",
  };
}

async function maybeApplyEmergencyContextCompaction(reqBody = {}, requestedModel = "", requestedMaxTokens = 4096, mpSession = null, options = {}) {
  if (options.bypassProxyOptimizations || options.isSummarizationRequest) return null;
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length < 6) return null;
  if (reqBody._emergencyContextCompactRetries >= 1) return null;

  const maxContext = maxContextForRequestedModel(requestedModel, reqBody);
  if (!maxContext) return null;

  const currentInputTokens = estimateRequestInputTokens(reqBody);
  const schemaTokens = compaction.estimateRequestSchemaTokens(reqBody);
  const requestedTotal = currentInputTokens + requestedMaxTokens;
  if (requestedTotal <= maxContext) return null;

  const targetPlan = emergencyCompactionTargetPlan(reqBody, requestedModel, requestedMaxTokens, schemaTokens, maxContext);
  const targetContext = Math.min(maxContext, targetPlan.targetContext || maxContext);
  const compactTargetTokens = Math.floor((targetContext - schemaTokens) * 0.88);
  if (compactTargetTokens <= requestedMaxTokens + 512) return null;

  reqBody._emergencyContextCompactRetries = (reqBody._emergencyContextCompactRetries || 0) + 1;
  state.log(
    `IDE-COMPACT: input ${currentInputTokens}tok + ${requestedMaxTokens}max > ${maxContext}ctx ` +
    `schema=${schemaTokens}tok target=${compactTargetTokens}tok fallback_ctx=${targetContext} ` +
    `fallback_providers=${targetPlan.fallbackCount}/${targetPlan.candidateCount} ` +
    `min_fallback=${targetPlan.minFallbackProviders} reason=${targetPlan.reason} — trying local compaction`,
  );

  let refs = [];
  try { refs = await memory.archiveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
  const originalMessages = reqBody.messages;
  const compacted = await compaction.compactMessagesAsync(
    originalMessages,
    compactTargetTokens,
    requestedMaxTokens,
    refs,
    mpSession?.id,
  );
  if (!compacted) {
    state.log(`IDE-COMPACT-SKIP: compaction failed for target=${compactTargetTokens}tok max_ctx=${maxContext}`);
    return null;
  }

  recordCompactionTelemetry(reqBody, "emergency", refs, compacted);
  compaction.recordCompactionDrops(mpSession?.id, originalMessages, compacted.messages);
  reqBody.messages = compacted.messages;

  try {
    if (mpSession?.id) {
      const lastMsg = originalMessages[originalMessages.length - 1];
      state.sessionCompactCache[mpSession.id] = {
        compactedMessages: compacted.messages,
        originalMsgCount: originalMessages.length,
        lastOriginalContent: messageContentText(lastMsg?.content),
        timestamp: Date.now(),
      };
    }
  } catch {}

  const newInputTokens = estimateRequestInputTokens(reqBody);
  const newTotalNeeded = newInputTokens + requestedMaxTokens;
  reqBody._inputTokens = newInputTokens;
  reqBody._estimatedTokens = newTotalNeeded;
  state.log(`IDE-COMPACT: ${currentInputTokens}tok -> ${newInputTokens}tok total=${newTotalNeeded}tok ai_summary=${compacted.aiSummaryUsed ? "true" : "false"}`);
  return {
    inputTokens: newInputTokens,
    totalNeeded: newTotalNeeded,
    maxContext,
  };
}

function providerDescriptor(provider = {}) {
  return `${provider.name || ""} ${provider.model || ""} ${provider.upstream_model || ""}`.toLowerCase();
}

function isHeavyTextProvider(provider = {}) {
  const text = providerDescriptor(provider);
  const small = /\b(?:haiku|mini|flash|small|tiny|lite|nano|free|fast|classifier|swe[-_ .]?1|gpt[-_ .]?3(?:\.5|5)|turbo)\b/i.test(text);
  if (/(?:sonnet|opus|xhigh|high[-_ ]?thinking)/i.test(text)) return true;
  if (/\bgpt[-_ .]?4o(?![-_ .]?mini)\b/i.test(text)) return true;
  if (/\bgpt[-_ .]?4(?![-_ .]?o[-_ .]?mini)\b/i.test(text)) return true;
  if (/\b(?:pro|max)\b/i.test(text) && !small) return true;
  const profile = routingPolicy.classifyProvider(provider);
  return profile.thinking_level >= 4 && !small;
}

function isSmallAssessmentProvider(provider = {}) {
  const text = providerDescriptor(provider);
  return /\b(?:haiku|mini|flash|small|tiny|lite|nano|free|fast|classifier|gpt[-_ .]?3(?:\.5|5)|turbo)\b/i.test(text);
}

function providerSourceKey(provider = {}) {
  const explicit = String(provider.family || provider.source_family || "").trim().toLowerCase();
  if (explicit) return explicit;
  const model = String(provider.model || "").trim().toLowerCase();
  const prefix = model.match(/^([a-z][a-z0-9_-]*)\//)?.[1];
  if (prefix) return prefix;
  return String(provider.protocol || provider.via || "").trim().toLowerCase();
}

function requestHasToolHistory(reqBody = {}) {
  return (reqBody?.messages || []).some((m) => (
    m?.role === "tool" ||
    (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
  ));
}

function requestHasFlattenedToolHistory(reqBody = {}) {
  return (reqBody?.messages || []).some((m) => looksLikeToolHistoryReplay(messageContentText(m?.content)));
}

function requestHasEffectiveToolHistory(reqBody = {}) {
  return !!reqBody._llmProxyOriginalHasToolHistory ||
    requestHasToolHistory(reqBody) ||
    requestHasFlattenedToolHistory(reqBody);
}

function requestHasCompactedContext(reqBody = {}) {
  return !!(
    reqBody?._llmProxyCompactedContext ||
    reqBody?._compactionStats?.phase ||
    reqBody?._preRouteCompactRetries ||
    reqBody?._midCompactRetries ||
    reqBody?._postCompactRetries ||
    reqBody?._emergencyContextCompactRetries
  );
}

function requestHasImageInput(reqBody = {}) {
  return mediaContent.messagesHaveImages(reqBody?.messages || []);
}

function requestHasDataImageInput(reqBody = {}) {
  return mediaContent.messagesHaveDataImages(reqBody?.messages || []);
}

function providerSupportsImageInput(provider = {}, reqBody = {}) {
  const compat = scoring.getCompat(provider.name);
  if (compat.no_images) return false;
  if (compat.no_data_images && requestHasDataImageInput(reqBody)) return false;
  return mediaContent.providerSupportsImageInput(provider);
}

function setHiddenProviderNumber(provider = {}, key = "", value = 0) {
  try {
    Object.defineProperty(provider, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    provider[key] = value;
  }
}

function routingDiversityEnabled(env = process.env) {
  const mode = String(env.LLM_ROUTING_DIVERSITY || "balanced").trim().toLowerCase();
  return !["0", "false", "off", "disabled", "none"].includes(mode);
}

function routingDiversityScoreBand(env = process.env) {
  const raw = Number(env.LLM_ROUTING_DIVERSITY_SCORE_BAND);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.75;
}

function routingDiversityClassScoreBand(env = process.env) {
  const raw = Number(env.LLM_ROUTING_DIVERSITY_CLASS_SCORE_BAND);
  return Number.isFinite(raw) && raw >= 0 ? raw : Math.max(1.75, routingDiversityScoreBand(env));
}

function routingDiversityClassPenaltyCap(env = process.env) {
  const raw = Number(env.LLM_ROUTING_DIVERSITY_CLASS_PENALTY_CAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2.5;
}

function routingDiversityRepeatThreshold(env = process.env) {
  return clampInt(env.LLM_ROUTING_DIVERSITY_REPEAT_THRESHOLD, 1, 50, 3);
}

function routingDiversitySevereRepeatThreshold(env = process.env) {
  const repeatThreshold = routingDiversityRepeatThreshold(env);
  return clampInt(
    env.LLM_ROUTING_DIVERSITY_SEVERE_REPEAT_THRESHOLD,
    repeatThreshold,
    200,
    Math.max(12, repeatThreshold * 6),
  );
}

function routingDiversityClusterRepeatThreshold(env = process.env) {
  const repeatThreshold = routingDiversityRepeatThreshold(env);
  return clampInt(
    env.LLM_ROUTING_DIVERSITY_CLUSTER_REPEAT_THRESHOLD,
    repeatThreshold,
    200,
    Math.max(12, repeatThreshold * 4),
  );
}

function routingDiversityCapabilityClass(provider = {}, requestedModel = "") {
  const caps = new Set(provider.caps || []);
  const group = String(requestedModel || "").toLowerCase();
  if (group.includes("memory")) return "memory";
  if (group.includes("assess") || group.includes("text-sm")) return "light-text";
  if (caps.has("coding") && caps.has("tools")) return "coding-tools";
  if (caps.has("tools")) return "tools";
  if (caps.has("text")) return "text";
  return "generic";
}

function routingDiversityProfileBucket(value, cuts = []) {
  const number = Number(value) || 0;
  for (const [limit, label] of cuts) {
    if (number <= limit) return label;
  }
  return cuts.at(-1)?.[1] || "unknown";
}

function providerDiversityClassKey(provider = {}, requestedModel = "") {
  const capabilityClass = routingDiversityCapabilityClass(provider, requestedModel);
  if (capabilityClass === "memory") return "memory";
  const profile = routingPolicy.classifyProvider(provider);
  const routingLevel = routingPolicy.providerMaxRoutingLevel(provider);
  const quality = routingDiversityProfileBucket(profile.quality_group, [[2, "light"], [3, "standard"], [4, "strong"], [5, "frontier"]]);
  const cost = routingDiversityProfileBucket(profile.cost_group, [[1, "free"], [3, "mainstream"], [5, "premium"]]);
  const speed = routingDiversityProfileBucket(profile.speed_group, [[2, "slow"], [3, "steady"], [5, "fast"]]);
  return `${capabilityClass}|rl:${routingLevel}|q:${quality}|c:${cost}|s:${speed}`;
}

function providerDiversitySourceClassKey(provider = {}, requestedModel = "") {
  const capabilityClass = routingDiversityCapabilityClass(provider, requestedModel);
  if (capabilityClass === "memory") return "memory";
  const profile = routingPolicy.classifyProvider(provider);
  const routingLevel = routingPolicy.providerMaxRoutingLevel(provider);
  const quality = routingDiversityProfileBucket(profile.quality_group, [[2, "light"], [3, "standard"], [5, "frontier"]]);
  const thinking = routingDiversityProfileBucket(profile.thinking_level, [[2, "light"], [3, "medium"], [5, "deep"]]);
  return `${capabilityClass}|rl:${routingLevel}|q:${quality}|think:${thinking}`;
}

function providerDiversitySourcePenaltyClassKey(provider = {}, requestedModel = "") {
  const capabilityClass = routingDiversityCapabilityClass(provider, requestedModel);
  if (capabilityClass === "memory") return "memory";
  const profile = routingPolicy.classifyProvider(provider);
  const routingLevel = routingPolicy.providerMaxRoutingLevel(provider);
  const quality = routingDiversityProfileBucket(profile.quality_group, [[2, "light"], [3, "standard"], [5, "frontier"]]);
  return `${capabilityClass}|rl:${routingLevel}|q:${quality}`;
}

function providerDiversityModelClass(provider = {}) {
  const text = String(provider.upstream_model || provider.model || provider.name || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9_-]*\//, "")
    .replace(/model_/g, "")
    .replace(/[_.]+/g, "-")
    .replace(/-?(?:none|minimal|low|medium|high|xhigh)(?:-thinking)?$/g, "")
    .replace(/-?thinking$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/claude-sonnet-4-6/.test(text)) return "claude-sonnet-4-6";
  if (/gpt-5-1-codex-mini/.test(text)) return "gpt-5-1-codex-mini";
  if (/gpt-5-4-mini/.test(text)) return "gpt-5-4-mini";
  if (/gpt-5-4/.test(text)) return "gpt-5-4";
  if (/gpt-5-2.*codex/.test(text)) return "gpt-5-2-codex";
  if (/gpt-5-2/.test(text)) return "gpt-5-2";
  if (/gpt-5-mini/.test(text)) return "gpt-5-mini";
  return text;
}

function providerDiversityModelGroupKey(provider = {}) {
  const modelClass = providerDiversityModelClass(provider);
  if (!modelClass || modelClass === "test-model") return "";
  return `model:${modelClass}|rl:${routingPolicy.providerMaxRoutingLevel(provider)}`;
}

function providerDiversityGroupKeys(provider = {}, requestedModel = "") {
  const keys = [];
  const modelKey = providerDiversityModelGroupKey(provider);
  if (modelKey) keys.push(modelKey);
  keys.push(providerDiversityClassKey(provider, requestedModel));
  return [...new Set(keys)];
}

function providerDiversityRotationKeys(provider = {}, requestedModel = "") {
  const capabilityClass = routingDiversityCapabilityClass(provider, requestedModel);
  if (capabilityClass === "memory") return ["memory"];
  const modelKey = providerDiversityModelGroupKey(provider);
  if (modelKey && capabilityClass !== "light-text") return [modelKey];
  return [providerDiversityClassKey(provider, requestedModel)];
}

function providersAreDiversityPeers(a = {}, b = {}, requestedModel = "") {
  if (!a || !b) return false;
  const bKeys = new Set(providerDiversityGroupKeys(b, requestedModel));
  return providerDiversityGroupKeys(a, requestedModel).some((key) => bKeys.has(key));
}

function providersAreDiversityRotationPeers(a = {}, b = {}, requestedModel = "") {
  if (!a || !b) return false;
  const bKeys = new Set(providerDiversityRotationKeys(b, requestedModel));
  return providerDiversityRotationKeys(a, requestedModel).some((key) => bKeys.has(key));
}

function isHighRiskRoutingProfile(profile = {}) {
  const stepShape = profile.stepShape || {};
  const shape = String(stepShape.shape || "").toLowerCase();
  const gate = String(stepShape.gate || "").toLowerCase();
  const taskKind = String(profile.taskKind || "").toLowerCase();
  if (shape === "security" || shape === "destructive") return true;
  if (gate === "human_signoff") return true;
  if (taskKind === "security_review") return true;
  return false;
}

function currentUserSupportsHighRiskProfile(reqBody = {}, profile = {}) {
  if (!isHighRiskRoutingProfile(profile)) return true;
  const text = normalizeRoutingText(lastUserText(reqBody));
  if (!text) return false;
  const stepShape = profile.stepShape || {};
  const shape = String(stepShape.shape || "").toLowerCase();
  const taskKind = String(profile.taskKind || "").toLowerCase();
  const explicitSecurityReview =
    /\b(?:security\s+(?:review|audit)|threat\s+model|vulnerabilit(?:y|ies)|sql\s+injection|xss|csrf|exploit(?:ability)?|privilege\s+bypass)\b/.test(text) ||
    (
      /\b(?:review|audit|inspect|verify|check|analy[sz]e)\b/.test(text) &&
      /\b(?:auth|authentication|authorization|permission|privilege|secret|credential|token|bypass)\b/.test(text)
    );
  const explicitDestructive =
    /\b(?:delete|remove|drop|destroy|wipe|truncate|migrate|restart|deploy|rollback)\b/.test(text) &&
    /\b(?:production|prod|real\s+(?:data|database|users?)|irreversible|destructive)\b/.test(text);
  if (shape === "security" || taskKind === "security_review") return explicitSecurityReview;
  if (shape === "destructive") return explicitDestructive;
  return explicitSecurityReview || explicitDestructive;
}

function sanitizedContinuationProfile(reqBody = {}, profile = {}) {
  const contextLevel = clampInt(profile.contextLevel || profile.level, 1, 5, 3);
  const taskLevel = Math.min(clampInt(profile.taskLevel || profile.level, 1, 5, 3), 3);
  const level = Math.max(taskLevel, contextLevel);
  return {
    ...profile,
    level,
    label: level <= 2 ? "simple" : level === 3 ? "standard" : level === 4 ? "complex" : "deep",
    taskKind: "agentic_coding",
    reason: "continuation_guard",
    taskLevel,
    contextLevel,
    costTarget: 3,
    speedTarget: 4,
    thinkingLevel: 3,
    thinkingEffort: "medium",
    stepShape: {
      shape: "write_heavy",
      valueCenter: "typing",
      posture: "type_cheap",
      gate: "run_behavior",
      summary: "Continuation guard: stale high-risk context was ignored because the current user message did not request high-risk work.",
    },
    source: "continuation_guard",
  };
}

function sessionStatsForRouting(reqBody = {}, options = {}) {
  if (options.sessionStats) return options.sessionStats;
  let session;
  try { session = memory.getSession(reqBody.messages); } catch { session = null; }
  return session?.id ? state.sessionStats[session.id] : null;
}

function routeDiversityStatsForRouting(requestedModel = "", options = {}) {
  if (options.routeDiversityStats) return options.routeDiversityStats;
  return state.routeDiversityStats?.[requestedModel] || null;
}

function statsProviderRequests(stats = {}, providerName = "") {
  return Number(stats?.providers?.[providerName]?.requests || 0);
}

function sourceRequestCounts(...statsList) {
  const byProvider = {};
  for (const stats of statsList) {
    for (const [providerName, row] of Object.entries(stats?.providers || {})) {
      byProvider[providerName] = Math.max(byProvider[providerName] || 0, Number(row?.requests || 0));
    }
  }

  const counts = {};
  const providersByName = new Map(state.PROVIDERS.map((provider) => [provider.name, provider]));
  for (const [providerName, requests] of Object.entries(byProvider)) {
    const provider = providersByName.get(providerName) || { name: providerName };
    const source = providerSourceKey(provider) || providerTraceSource(provider).toLowerCase();
    counts[source] = (counts[source] || 0) + Number(requests || 0);
  }
  return counts;
}

function recordRouteDiversityUse(reqBody = {}, providerName = "") {
  const groupName = String(reqBody?.model || "").trim();
  if (!providerName || !(groupName in state.GROUPS)) return;
  if (!state.routeDiversityStats[groupName]) {
    state.routeDiversityStats[groupName] = { requests: 0, providers: {}, lastProvider: "", startTime: Date.now(), lastRequest: 0 };
  }
  const stats = state.routeDiversityStats[groupName];
  stats.requests = Number(stats.requests || 0) + 1;
  stats.lastProvider = providerName;
  stats.lastRequest = Date.now();
  if (!stats.providers[providerName]) stats.providers[providerName] = { requests: 0 };
  stats.providers[providerName].requests = Number(stats.providers[providerName].requests || 0) + 1;

  if (stats.requests > 400) {
    stats.requests = 0;
    for (const row of Object.values(stats.providers)) {
      row.requests = Math.ceil(Number(row.requests || 0) / 2);
      stats.requests += row.requests;
    }
  }
}

function applyRoutingDiversityScores(providers = [], reqBody = {}, requestedModel = "", isGroup = false, options = {}) {
  const env = options.env || process.env;
  if (!isGroup || providers.length < 2 || !routingDiversityEnabled(env)) return providers;

  const profile = routingPolicy.effectiveRequestProfile(reqBody, env);
  if (isHighRiskRoutingProfile(profile)) {
    for (const provider of providers) setHiddenProviderNumber(provider, "_routingDiversityPenalty", 0);
    return providers;
  }

  const sessionStats = sessionStatsForRouting(reqBody, options) || {};
  const routeDiversityStats = routeDiversityStatsForRouting(requestedModel, options) || {};
  const routeDiversityLeader = Object.entries(routeDiversityStats.providers || {})
    .sort((a, b) => Number(b[1]?.requests || 0) - Number(a[1]?.requests || 0))[0]?.[0] || "";
  const lastProviderName = sessionStats.lastProvider || reqBody._sessionLastProvider || routeDiversityStats.lastProvider || routeDiversityLeader || "";
  if (!lastProviderName) return providers;

  const repeatThreshold = routingDiversityRepeatThreshold(options.env || process.env);
  const lastProviderRequests = Math.max(
    statsProviderRequests(sessionStats, lastProviderName),
    statsProviderRequests(routeDiversityStats, lastProviderName),
  );

  const band = routingDiversityScoreBand(env);
  const classBand = routingDiversityClassScoreBand(env);
  const classPenaltyCap = routingDiversityClassPenaltyCap(env);
  const standardRoutingFloor = Math.max(
    Number(profile.level || 0),
    Number(profile.taskLevel || 0),
    Number(profile.thinkingLevel || 0),
  ) >= 3;
  const providerScoreForDiversity = (provider) => (
    Number.isFinite(provider?._lastRoutingScore) ? provider._lastRoutingScore : scoring.providerScore(provider)
  );
  const originalDiversityScores = new Map(
    providers.map((provider) => [provider.name, providerScoreForDiversity(provider)]),
  );
  const originalScoreForDiversity = (provider) => (
    originalDiversityScores.has(provider?.name)
      ? originalDiversityScores.get(provider.name)
      : providerScoreForDiversity(provider)
  );
  const providerRequestCount = (provider) => Math.max(
    statsProviderRequests(sessionStats, provider?.name),
    statsProviderRequests(routeDiversityStats, provider?.name),
  );
  const modelEntriesForKey = (modelKey) => modelKey
    ? providers
      .filter((provider) => providerDiversityModelGroupKey(provider) === modelKey)
      .map((provider) => ({
        provider,
        score: originalScoreForDiversity(provider),
        requests: providerRequestCount(provider),
        source: providerSourceKey(provider),
      }))
    : [];
  const modelClusterRequestTotal = (entries) => entries.reduce((sum, entry) => sum + Number(entry.requests || 0), 0);
  const topScore = Number.isFinite(providers[0]?._lastRoutingScore)
    ? originalScoreForDiversity(providers[0])
    : scoring.providerScore(providers[0]);
  const lastProviderCandidate = providers.find((provider) => provider.name === lastProviderName);
  const lastProvider = state.PROVIDERS.find((provider) => provider.name === lastProviderName) || lastProviderCandidate || { name: lastProviderName };
  const lastProviderRoutingLevel = routingPolicy.providerMaxRoutingLevel(lastProviderCandidate || lastProvider);
  const lastSource = providerSourceKey(lastProvider) || providerTraceSource(lastProvider).toLowerCase();
  const sourceCounts = sourceRequestCounts(sessionStats, routeDiversityStats);
  const closeSources = new Set(
    providers
      .filter((provider) => {
        const score = providerScoreForDiversity(provider);
        return topScore - score <= band;
      })
      .map(providerSourceKey)
      .filter(Boolean),
  );
  const closeOtherSourceExists = closeSources.size > 1 && closeSources.has(lastSource);
  const classEntries = providers.flatMap((provider) => providerDiversityRotationKeys(provider, requestedModel).map((key) => ({
    provider,
    score: originalScoreForDiversity(provider),
    requests: providerRequestCount(provider),
    key,
  })));
  const candidateClassKeys = new Set();
  if (providers[0]) {
    for (const key of providerDiversityRotationKeys(providers[0], requestedModel)) candidateClassKeys.add(key);
  }
  if (lastProviderCandidate) {
    for (const key of providerDiversityRotationKeys(lastProviderCandidate, requestedModel)) candidateClassKeys.add(key);
  }
  let classRotationLeader = null;
  let classRotationTarget = null;
  let classRotationKey = "";
  let classRequestFloor = Infinity;

  for (const key of candidateClassKeys) {
    const entries = classEntries.filter((entry) => entry.key === key);
    if (entries.length < 2) continue;
    const floor = Math.min(...entries.map((entry) => entry.requests));
    const leaders = entries
      .filter((entry) => entry.requests >= repeatThreshold && entry.requests - floor >= repeatThreshold)
      .sort((a, b) => b.requests - a.requests || b.score - a.score);

    for (const leader of leaders) {
      const leaderExploreBand = classBand + Math.min(1.25, Math.max(0, leader.requests - repeatThreshold) * 0.04);
      const alternatives = entries
        .filter((entry) => entry.provider.name !== leader.provider.name && entry.requests <= leader.requests - repeatThreshold)
        .filter((entry) => {
          const scoreGap = leader.score - entry.score;
          const coldPeer = entry.requests <= Math.max(1, Math.floor(leader.requests * 0.2));
          return scoreGap <= (coldPeer ? leaderExploreBand : classBand);
        });
      if (alternatives.length === 0) continue;

      alternatives.sort((a, b) => {
        const leaderSource = providerSourceKey(leader.provider);
        const aSource = providerSourceKey(a.provider);
        const bSource = providerSourceKey(b.provider);
        const aSourceDeficit = Math.max(0, Number(sourceCounts[leaderSource] || 0) - Number(sourceCounts[aSource] || 0));
        const bSourceDeficit = Math.max(0, Number(sourceCounts[leaderSource] || 0) - Number(sourceCounts[bSource] || 0));
        const aSourceBonus = aSource && leaderSource && aSource !== leaderSource ? Math.min(0.35, aSourceDeficit * 0.012) : 0;
        const bSourceBonus = bSource && leaderSource && bSource !== leaderSource ? Math.min(0.35, bSourceDeficit * 0.012) : 0;
        const aBalanced = a.score + Math.min(0.45, Math.max(0, leader.requests - a.requests) * 0.018) + aSourceBonus;
        const bBalanced = b.score + Math.min(0.45, Math.max(0, leader.requests - b.requests) * 0.018) + bSourceBonus;
        return bBalanced - aBalanced || b.score - a.score || a.requests - b.requests;
      });
      classRotationLeader = leader;
      classRotationTarget = alternatives[0];
      classRotationKey = key;
      classRequestFloor = floor;
      break;
    }
    if (classRotationTarget) break;
  }

  const lastSourceRequests = Math.max(Number(sourceCounts[lastSource] || 0), lastProviderRequests);
  const clusterRepeatThreshold = routingDiversityClusterRepeatThreshold(env);
  const lastModelKey = providerDiversityModelGroupKey(lastProviderCandidate || lastProvider);
  const lastModelEntries = modelEntriesForKey(lastModelKey);
  const lastModelRequests = modelClusterRequestTotal(lastModelEntries);
  const sameModelSourceExploreBonus = lastModelRequests >= clusterRepeatThreshold
    ? Math.min(0.85, 0.35 + Math.max(0, lastModelRequests - clusterRepeatThreshold) * 0.035)
    : 0;
  const sourceExploreBand = classBand +
    Math.min(1.25, Math.max(0, lastSourceRequests - repeatThreshold) * 0.06) +
    sameModelSourceExploreBonus;
  let sourceRotationTarget = null;
  if (lastSource && lastSourceRequests >= repeatThreshold) {
    const sourceAlternatives = providers
      .map((provider) => ({
        provider,
        score: originalScoreForDiversity(provider),
        requests: providerRequestCount(provider),
        source: providerSourceKey(provider),
        routingLevel: routingPolicy.providerMaxRoutingLevel(provider),
      }))
      .filter((entry) => entry.source && entry.source !== lastSource)
      .filter((entry) => entry.routingLevel === lastProviderRoutingLevel)
      .filter((entry) => providersAreDiversityRotationPeers(entry.provider, lastProviderCandidate || lastProvider || providers[0], requestedModel))
      .filter((entry) => Number(sourceCounts[entry.source] || 0) <= lastSourceRequests - repeatThreshold)
      .filter((entry) => topScore - entry.score <= sourceExploreBand);

    if (sourceAlternatives.length > 0) {
      sourceAlternatives.sort((a, b) => {
        const aSourceDeficit = Math.max(0, lastSourceRequests - Number(sourceCounts[a.source] || 0));
        const bSourceDeficit = Math.max(0, lastSourceRequests - Number(sourceCounts[b.source] || 0));
        const aSameModel = lastProviderCandidate && providerDiversityModelGroupKey(a.provider) && providerDiversityModelGroupKey(a.provider) === providerDiversityModelGroupKey(lastProviderCandidate) ? 0.25 : 0;
        const bSameModel = lastProviderCandidate && providerDiversityModelGroupKey(b.provider) && providerDiversityModelGroupKey(b.provider) === providerDiversityModelGroupKey(lastProviderCandidate) ? 0.25 : 0;
        const aBalanced = a.score + Math.min(0.7, aSourceDeficit * 0.025) + Math.min(0.35, Math.max(0, lastProviderRequests - a.requests) * 0.015) + aSameModel;
        const bBalanced = b.score + Math.min(0.7, bSourceDeficit * 0.025) + Math.min(0.35, Math.max(0, lastProviderRequests - b.requests) * 0.015) + bSameModel;
        return bBalanced - aBalanced || b.score - a.score || a.requests - b.requests;
      });
      sourceRotationTarget = sourceAlternatives[0];
    }
  }

  let sourceClassRotationTarget = null;
  let sourceClassRotationKey = "";
  let sourceClassPenaltyKey = "";
  if (!sourceRotationTarget && lastSource && lastSourceRequests >= repeatThreshold) {
    const sourceClassReferenceProvider = lastProviderCandidate || lastProvider || providers[0];
    sourceClassRotationKey = providerDiversitySourceClassKey(sourceClassReferenceProvider, requestedModel);
    sourceClassPenaltyKey = providerDiversitySourcePenaltyClassKey(sourceClassReferenceProvider, requestedModel);
    const sourceClassExploreBand = Math.min(
      classBand + 0.25,
      band + 0.60 + Math.min(0.95, Math.max(0, lastSourceRequests - repeatThreshold) * 0.05),
    );
    const sourceAlternatives = providers
      .map((provider) => ({
        provider,
        score: originalScoreForDiversity(provider),
        requests: providerRequestCount(provider),
        source: providerSourceKey(provider),
        routingLevel: routingPolicy.providerMaxRoutingLevel(provider),
        classKey: providerDiversitySourceClassKey(provider, requestedModel),
      }))
      .filter((entry) => entry.source && entry.source !== lastSource)
      .filter((entry) => entry.routingLevel === lastProviderRoutingLevel)
      .filter((entry) => entry.classKey === sourceClassRotationKey)
      .filter((entry) => Number(sourceCounts[entry.source] || 0) <= lastSourceRequests - repeatThreshold)
      .filter((entry) => topScore - entry.score <= sourceClassExploreBand);

    if (sourceAlternatives.length > 0) {
      sourceAlternatives.sort((a, b) => {
        const aSourceDeficit = Math.max(0, lastSourceRequests - Number(sourceCounts[a.source] || 0));
        const bSourceDeficit = Math.max(0, lastSourceRequests - Number(sourceCounts[b.source] || 0));
        const aBalanced = a.score + Math.min(0.85, aSourceDeficit * 0.032) + Math.min(0.35, Math.max(0, lastProviderRequests - a.requests) * 0.015);
        const bBalanced = b.score + Math.min(0.85, bSourceDeficit * 0.032) + Math.min(0.35, Math.max(0, lastProviderRequests - b.requests) * 0.015);
        return bBalanced - aBalanced || b.score - a.score || a.requests - b.requests;
      });
      sourceClassRotationTarget = sourceAlternatives[0];
    }
  }

  let capabilityRotationTarget = null;
  let capabilityRotationModelKey = "";
  let capabilityRotationLeader = null;
  if (!sourceRotationTarget) {
    const severeRepeatThreshold = routingDiversitySevereRepeatThreshold(env);
    const modelLeader = classRotationLeader ||
      classEntries
        .filter((entry) => providerDiversityModelGroupKey(entry.provider))
        .sort((a, b) => b.requests - a.requests || b.score - a.score)[0] ||
      null;
    const modelKey = modelLeader ? providerDiversityModelGroupKey(modelLeader.provider) : "";
    const modelEntries = modelEntriesForKey(modelKey);
    const modelClusterRequests = modelClusterRequestTotal(modelEntries);
    const hasColdSameModelPeer = modelEntries.some((entry) => (
      entry.provider.name !== modelLeader?.provider?.name &&
      entry.requests < repeatThreshold &&
      modelLeader.score - entry.score <= classBand + 1.25
    ));
    const modelClusterExhausted = modelEntries.length > 0 &&
      !hasColdSameModelPeer &&
      modelEntries.every((entry) => entry.requests >= repeatThreshold || entry.provider.name === modelLeader?.provider?.name);
    const aggregateClusterOverused =
      modelClusterRequests >= clusterRepeatThreshold &&
      modelEntries.some((entry) => entry.requests >= repeatThreshold);
    const individualClusterOverused = modelLeader?.requests >= severeRepeatThreshold && modelClusterExhausted;
    if (modelLeader && modelKey && (individualClusterOverused || aggregateClusterOverused)) {
      const capabilityKey = providerDiversityClassKey(modelLeader.provider, requestedModel);
      const leaderSource = providerSourceKey(modelLeader.provider);
      const referenceRequests = Math.max(
        Number(modelLeader.requests || 0),
        Math.max(0, modelClusterRequests - repeatThreshold),
      );
      const exploreBand = classBand +
        Math.min(1.25, Math.max(0, modelLeader.requests - severeRepeatThreshold) * 0.04) +
        (aggregateClusterOverused
          ? Math.min(0.9, 0.55 + Math.max(0, modelClusterRequests - clusterRepeatThreshold) * 0.045)
          : 0);
      const alternatives = providers
        .map((provider) => ({
          provider,
          score: originalScoreForDiversity(provider),
          requests: providerRequestCount(provider),
          source: providerSourceKey(provider),
        }))
        .filter((entry) => providerDiversityModelGroupKey(entry.provider) !== modelKey)
        .filter((entry) => providerDiversityClassKey(entry.provider, requestedModel) === capabilityKey)
        .filter((entry) => entry.requests <= referenceRequests - repeatThreshold)
        .filter((entry) => modelLeader.score - entry.score <= exploreBand);

      if (alternatives.length > 0) {
        alternatives.sort((a, b) => {
          const aSourceDeficit = Math.max(0, Number(sourceCounts[leaderSource] || 0) - Number(sourceCounts[a.source] || 0));
          const bSourceDeficit = Math.max(0, Number(sourceCounts[leaderSource] || 0) - Number(sourceCounts[b.source] || 0));
          const aSourceBonus = a.source && leaderSource && a.source !== leaderSource ? Math.min(0.45, aSourceDeficit * 0.012) : 0;
          const bSourceBonus = b.source && leaderSource && b.source !== leaderSource ? Math.min(0.45, bSourceDeficit * 0.012) : 0;
          const aBalanced = a.score + Math.min(0.65, Math.max(0, referenceRequests - a.requests) * 0.018) + aSourceBonus;
          const bBalanced = b.score + Math.min(0.65, Math.max(0, referenceRequests - b.requests) * 0.018) + bSourceBonus;
          return bBalanced - aBalanced || b.score - a.score || a.requests - b.requests;
        });
        capabilityRotationLeader = { ...modelLeader, requests: Math.max(modelLeader.requests, modelClusterRequests) };
        capabilityRotationModelKey = modelKey;
        capabilityRotationTarget = alternatives[0];
      }
    }
  }

  if (
    lastProviderRequests < repeatThreshold &&
    !classRotationTarget &&
    !sourceRotationTarget &&
    !sourceClassRotationTarget &&
    !capabilityRotationTarget
  ) return providers;

  const scored = providers.map((provider) => {
    const score = originalScoreForDiversity(provider);
    let penalty = 0;
    let boost = 0;
    if (topScore - score <= band) {
      if (provider.name === lastProviderName && provider.name !== classRotationTarget?.provider?.name) {
        penalty += 0.38;
        penalty += Math.min(0.62, Math.max(0, lastProviderRequests - repeatThreshold + 1) * 0.075);
      }
      const source = providerSourceKey(provider);
      if (closeOtherSourceExists && source && source === lastSource && Number(sourceCounts[source] || 0) >= repeatThreshold) {
        penalty += 0.12;
      }
    }
    if (classRotationTarget && classRotationLeader && provider.name === classRotationLeader.provider.name) {
      const needed = score - classRotationTarget.score + 0.06;
      if (needed > penalty) penalty = Math.max(penalty, Math.min(classPenaltyCap, needed));
    } else if (classRotationTarget && providerDiversityRotationKeys(provider, requestedModel).includes(classRotationKey)) {
      const ownRequests = providerRequestCount(provider);
      const overuse = ownRequests - classRequestFloor;
      if (overuse >= repeatThreshold && topScore - score <= classBand) {
        penalty += Math.min(0.45, overuse * 0.035);
      }
    }
    if (
      sourceRotationTarget &&
      providerSourceKey(provider) === lastSource &&
      provider.name !== sourceRotationTarget.provider.name &&
      providersAreDiversityRotationPeers(provider, sourceRotationTarget.provider, requestedModel)
    ) {
      const needed = score - sourceRotationTarget.score + 0.06;
      if (needed > penalty) penalty = Math.max(penalty, Math.min(classPenaltyCap, needed));
    }
    if (
      sourceClassRotationTarget &&
      providerSourceKey(provider) === lastSource &&
      provider.name !== sourceClassRotationTarget.provider.name &&
      providerDiversitySourcePenaltyClassKey(provider, requestedModel) === sourceClassPenaltyKey
    ) {
      const needed = score - sourceClassRotationTarget.score + 0.06;
      if (needed > penalty) penalty = Math.max(penalty, Math.min(classPenaltyCap, needed));
    }
    if (capabilityRotationTarget && providerDiversityModelGroupKey(provider) === capabilityRotationModelKey) {
      const needed = score - capabilityRotationTarget.score + 0.06;
      if (needed > penalty) penalty = Math.max(penalty, Math.min(classPenaltyCap, needed));
    }
    if (standardRoutingFloor) {
      const providerRoutingLevel = routingPolicy.providerMaxRoutingLevel(provider);
      if (providerRoutingLevel < 3) {
        penalty += 0.85 + (3 - providerRoutingLevel) * 0.20;
      }
    }
    if (classRotationTarget && provider.name === classRotationTarget.provider.name) {
      const bestOtherScore = providers
        .filter((candidate) => candidate.name !== classRotationLeader?.provider?.name && candidate.name !== provider.name)
        .reduce((max, candidate) => Math.max(max, originalScoreForDiversity(candidate)), -Infinity);
      const requestDeficit = Math.max(0, Number(classRotationLeader?.requests || lastProviderRequests) - providerRequestCount(provider));
      const explorationCap = Math.min(0.85, 0.28 + requestDeficit * 0.018);
      const needed = Number.isFinite(bestOtherScore) ? bestOtherScore - score + 0.06 : 0;
      const targetSource = providerSourceKey(provider);
      const overusedSourceTarget = sourceRotationTarget && targetSource === lastSource && sourceRotationTarget.provider.name !== provider.name;
      const overusedModelTarget = capabilityRotationTarget && provider.name !== capabilityRotationTarget.provider.name;
      if (!overusedSourceTarget && !overusedModelTarget) {
        if (needed > 0 && needed <= explorationCap) {
          boost = needed;
        } else if (needed <= 0 && requestDeficit >= repeatThreshold) {
          boost = Math.min(0.18, explorationCap);
        }
      }
    }
    if (sourceRotationTarget && provider.name === sourceRotationTarget.provider.name) {
      const targetModelKey = providerDiversityModelGroupKey(provider);
      const sourceTargetSameModel = !!targetModelKey && targetModelKey === providerDiversityModelGroupKey(lastProviderCandidate || lastProvider);
      const bestCompetitorScore = providers
        .filter((candidate) => candidate.name !== provider.name)
        .reduce((max, candidate) => {
          const candidateScore = originalScoreForDiversity(candidate);
          const sameSourceRotatedModel =
            providerSourceKey(candidate) === lastSource &&
            providersAreDiversityRotationPeers(candidate, sourceRotationTarget.provider, requestedModel);
          const adjustedCandidateScore = sameSourceRotatedModel
            ? candidateScore - Math.min(classPenaltyCap, Math.max(0, candidateScore - sourceRotationTarget.score + 0.06))
            : candidateScore;
          return Math.max(max, adjustedCandidateScore);
        }, -Infinity);
      const needed = Number.isFinite(bestCompetitorScore) ? bestCompetitorScore - score + 0.06 : 0;
      const sourceDeficit = Math.max(0, lastSourceRequests - Number(sourceCounts[sourceRotationTarget.source] || 0));
      const sourceBoostCap = sourceTargetSameModel
        ? Math.min(1.05, 0.34 + sourceDeficit * 0.035)
        : Math.min(0.65, 0.18 + sourceDeficit * 0.015);
      if (needed > 0 && needed <= sourceBoostCap) boost = Math.max(boost, needed);
    }
    if (sourceClassRotationTarget && provider.name === sourceClassRotationTarget.provider.name) {
      const bestCompetitorScore = providers
        .filter((candidate) => candidate.name !== provider.name)
        .reduce((max, candidate) => {
          const candidateScore = originalScoreForDiversity(candidate);
          const sameSourceSameClass =
            providerSourceKey(candidate) === lastSource &&
            providerDiversitySourcePenaltyClassKey(candidate, requestedModel) === sourceClassPenaltyKey;
          const adjustedCandidateScore = sameSourceSameClass
            ? candidateScore - Math.min(classPenaltyCap, Math.max(0, candidateScore - sourceClassRotationTarget.score + 0.06))
            : candidateScore;
          return Math.max(max, adjustedCandidateScore);
        }, -Infinity);
      const needed = Number.isFinite(bestCompetitorScore) ? bestCompetitorScore - score + 0.06 : 0;
      const sourceDeficit = Math.max(0, lastSourceRequests - Number(sourceCounts[sourceClassRotationTarget.source] || 0));
      const sourceBoostCap = Math.min(0.9, 0.22 + sourceDeficit * 0.028);
      if (needed > 0 && needed <= sourceBoostCap) boost = Math.max(boost, needed);
    }
    if (capabilityRotationTarget && provider.name === capabilityRotationTarget.provider.name) {
      const bestCompetitorScore = providers
        .filter((candidate) => candidate.name !== provider.name)
        .reduce((max, candidate) => Math.max(
          max,
          originalScoreForDiversity(candidate) - (
            providerDiversityModelGroupKey(candidate) === capabilityRotationModelKey
              ? Math.min(classPenaltyCap, Math.max(0, originalScoreForDiversity(candidate) - capabilityRotationTarget.score + 0.06))
              : 0
          ),
        ), -Infinity);
      const needed = Number.isFinite(bestCompetitorScore) ? bestCompetitorScore - score + 0.06 : 0;
      const requestDeficit = Math.max(0, Number(capabilityRotationLeader?.requests || lastProviderRequests) - providerRequestCount(provider));
      const capabilityBoostCap = Math.min(0.75, 0.18 + requestDeficit * 0.014);
      if (needed > 0 && needed <= capabilityBoostCap) boost = Math.max(boost, needed);
    }
    const adjustedScore = score - penalty + boost;
    setHiddenProviderNumber(provider, "_routingDiversityPenalty", penalty);
    setHiddenProviderNumber(provider, "_routingDiversityBoost", boost);
    setHiddenProviderNumber(provider, "_lastRoutingScore", adjustedScore);
    return { provider, score: adjustedScore, penalty, originalScore: score };
  });

  scored.sort((a, b) => b.score - a.score);
  const changed = scored[0]?.provider?.name && scored[0].provider.name !== providers[0]?.name;
  if (changed) {
    const top = scored[0];
    const previous = providers[0];
    const previousPenalty = Number(previous._routingDiversityPenalty || 0);
    const repeatForLog = Number(classRotationLeader?.requests || lastProviderRequests);
    const classBalance = classRotationLeader && classRotationLeader.provider.name !== lastProviderName
      ? ` class_leader=${classRotationLeader.provider.name}:${classRotationLeader.requests} last=${lastProviderName}:${lastProviderRequests}`
      : "";
    let sourceBalance = "";
    if (sourceRotationTarget) {
      const actualSource = providerSourceKey(top.provider) || providerTraceSource(top.provider).toLowerCase();
      sourceBalance = top.provider.name === sourceRotationTarget.provider.name
        ? ` source=${lastSource}->${sourceRotationTarget.source}`
        : ` source_target=${lastSource}->${sourceRotationTarget.source}:${sourceRotationTarget.provider.name} actual_source=${lastSource}->${actualSource}`;
    } else if (sourceClassRotationTarget) {
      const actualSource = providerSourceKey(top.provider) || providerTraceSource(top.provider).toLowerCase();
      sourceBalance = top.provider.name === sourceClassRotationTarget.provider.name
        ? ` source_class=${lastSource}->${sourceClassRotationTarget.source}`
        : ` source_class_target=${lastSource}->${sourceClassRotationTarget.source}:${sourceClassRotationTarget.provider.name} actual_source=${lastSource}->${actualSource}`;
    }
    const capabilityBalance = capabilityRotationTarget
      ? ` capability=${providerDiversityModelClass(capabilityRotationLeader?.provider)}->${providerDiversityModelClass(capabilityRotationTarget.provider)}`
      : "";
    state.log(
      `ROUTING-DIVERSITY: ${requestedModel} ${previous.name}->${top.provider.name} ` +
      `repeat=${repeatForLog}${classBalance}${sourceBalance}${capabilityBalance} penalty=${previousPenalty.toFixed(2)} band=${band} class_band=${classBand}`,
    );
  }
  return scored.map((entry) => entry.provider);
}

function sourceCoverageFallbackScore(provider = {}, routeCap = "", reqBody = {}) {
  const profile = routingPolicy.classifyProvider(provider);
  const descriptor = providerDescriptor(provider).toLowerCase();
  let score = scoring.providerScore(provider) + scoring.providerPolicyBonus(provider, reqBody);

  if ((provider.caps || []).includes("text")) score += 1.0;
  if (profile.quality_group >= 4) score += 0.8;
  if (profile.speed_group >= 4) score += 0.35;
  if (profile.cost_group <= 2) score += 0.35;
  if (isHeavyTextProvider(provider)) score -= 1.5;

  if (routeCap === "memory") {
    if (provider.supports_structured_outputs === true) score += 2.0;
    if (/\b(?:gpt[-_ .]?4o[-_ .]?mini|gpt[-_ .]?5.*mini|codex.*mini|haiku|sonnet|mini)\b/i.test(descriptor)) score += 1.2;
    if (/\b(?:gemini.*flash|flash|gpt[-_ .]?3(?:\.5|5)|turbo[-_ .]?0613)\b/i.test(descriptor)) score -= 1.5;
  } else if (routeCap === "assessment" || routeCap === "text-sm") {
    if (isSmallAssessmentProvider(provider)) score += 1.0;
  }

  return score;
}

function preserveSourceCoverage(primary = [], fallbackPool = [], routeCap = "", reqBody = {}) {
  const result = [...primary];
  const seenProviders = new Set(result.map((provider) => provider.name || provider.model || provider.url).filter(Boolean));
  const presentSources = new Set(result.map(providerSourceKey).filter(Boolean));
  const bestMissing = new Map();

  for (const provider of fallbackPool) {
    const source = providerSourceKey(provider);
    if (!source || presentSources.has(source)) continue;
    const key = provider.name || provider.model || provider.url;
    if (key && seenProviders.has(key)) continue;
    const current = bestMissing.get(source);
    const score = sourceCoverageFallbackScore(provider, routeCap, reqBody);
    if (!current || score > current.score) bestMissing.set(source, { provider, score });
  }

  for (const [source, entry] of bestMissing.entries()) {
    presentSources.add(source);
    const key = entry.provider.name || entry.provider.model || entry.provider.url;
    if (key) seenProviders.add(key);
    result.push(entry.provider);
  }

  return result;
}

function getProvidersForGroup(groupName, estimatedTokens, reqBody) {
  const cap = state.GROUPS[groupName];
  const directNoToolTask = isDirectNoToolRequest(reqBody);
  const routeCap = cap === "text-sm" || cap === "assessment" || cap === "memory" ? cap : (directNoToolTask ? "text" : cap);
  const scoreCap = routeCap === "coding-sm" || routeCap === "text-sm"
    ? routeCap.replace("-sm", "")
    : routeCap === "assessment" || routeCap === "memory" ? "text" : routeCap;
  const { caps: detectedCaps, isAgent, needsUpgrade } = transforms.detectUseCase(reqBody?.messages, reqBody);

  // All alive providers with enough context
  const all = state.PROVIDERS.filter((p) => p.key && p.alive !== false)
    .filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isRecentUnresolvedChronicStalling(p.name) && !scoring.isQuotaDisabled(p.name) && !scoring.isBannedFromGroup(p.name, groupName))
    .filter((p) => !(reqBody?._assessmentSkipProviders || []).includes(p.name));

  // Does request carry reasoning_content or need thinking?
  const hasReasoning = (reqBody?.messages || []).some((m) => m.reasoning_content);
  const needsThinking = routeCap === "thinking" || detectedCaps.has("thinking");
  const needsTools = routeCap === "tools" || routeCap === "coding-sm" || detectedCaps.has("tools") || isAgent;
  const needsImages = detectedCaps.has("images") || requestHasImageInput(reqBody);
  const hasToolHistory = requestHasToolHistory(reqBody);
  const requestCarriesTools = !directNoToolTask && (
    (reqBody?.tools?.length || 0) > 0 ||
    (reqBody?.functions?.length || 0) > 0 ||
    hasToolHistory ||
    (reqBody?.messages || []).some((m) => m.role === "tool")
  );
  const hardViable = requestCarriesTools ? all.filter((p) => (p.caps || []).includes("tools")) : all;
  const hardWithContext = estimatedTokens > 0 ? hardViable.filter((p) => providerCanFitRoutedRequest(p, estimatedTokens, reqBody)) : hardViable;
  const imageCompatible = needsImages ? hardWithContext.filter((p) => providerSupportsImageInput(p, reqBody)) : [];
  const hasImageCompatibleProviders = needsImages && imageCompatible.length > 0;
  let viable = hasImageCompatibleProviders ? imageCompatible : hardWithContext;
  if (routeCap === "assessment" || routeCap === "memory" || routeCap === "text-sm" || groupName === "auto-text") {
    viable = viable.filter((p) => !isHeavyTextProvider(p));
  }
  if (routeCap === "assessment") {
    const small = viable.filter((p) => isSmallAssessmentProvider(p));
    if (small.length > 0) viable = small;
  }
  const coveragePool = hasImageCompatibleProviders ? imageCompatible : hardWithContext;
  const withContext = preserveSourceCoverage(viable, coveragePool, routeCap, reqBody);

  // Score each provider: base score + smartness + group match + detected caps + agent boost + compat
  const scored = withContext.map((p) => {
    let bonus = 0;
    const compat = scoring.getCompat(p.name);

    // Benchmark-backed model scoring for this group's category
    bonus += transforms.smartnessBonus(p, scoreCap, reqBody);
    bonus += scoring.providerPolicyBonus(p, reqBody);

    // Group capability match: strong bonus for matching, but don't exclude non-matching
    if (routeCap === "assessment") {
      const profile = routingPolicy.classifyProvider(p);
      const multiplier = routingPolicy.costMultiplierForProvider(p);
      const text = `${p.name || ""} ${p.model || ""} ${p.upstream_model || ""}`.toLowerCase();

      if (p.caps.includes("text")) bonus += 1.0;
      else bonus -= 99;

      if (multiplier !== null) {
        if (multiplier <= 0) bonus += 8.0;
        else if (multiplier <= 0.1) bonus += 6.0;
        else if (multiplier <= 0.33) bonus += 4.5;
        else if (multiplier <= 0.75) bonus += 2.5;
        else if (multiplier <= 1) bonus += 1.0;
        else bonus -= Math.min(7.0, Math.log10(multiplier + 1) * 4.5);
      } else {
        if (profile.cost_group <= 1) bonus += 4.0;
        else if (profile.cost_group === 2) bonus += 1.5;
        else if (profile.cost_group === 3) bonus -= 1.0;
        else bonus -= 5.0;
      }

      if (profile.cost_group <= 1) bonus += 1.5;
      else if (profile.cost_group === 2) bonus += 0.4;
      else if (profile.cost_group >= 4) bonus -= 2.5;

      if (profile.thinking_level <= 1) bonus += 1.0;
      else if (profile.thinking_level <= 2) bonus += 0.5;
      else if (profile.thinking_level >= 4) bonus -= 1.5;
      if (profile.speed_group >= 5) bonus += 0.35;
      else if (profile.speed_group <= 2) bonus -= 0.25;
      if (profile.quality_group < 2) bonus -= 1.0;
      if (/\b(tiny|nano|mini|small|lite|flash|free|classifier)\b/i.test(text)) bonus += 0.8;
      if (/\b(haiku|sonnet|opus|pro|max|xhigh|high[-_ ]?thinking)\b/i.test(text)) bonus -= 0.9;
      if (p.caps.includes("tools")) bonus -= 0.5;
      if (p.caps.includes("max")) bonus -= 1.0;
    } else if (routeCap === "memory") {
      const profile = routingPolicy.classifyProvider(p);
      const multiplier = routingPolicy.costMultiplierForProvider(p);
      const text = `${p.name || ""} ${p.model || ""} ${p.upstream_model || ""}`.toLowerCase();
      const structured = p.supports_structured_outputs === true ||
        (Array.isArray(p.supported_endpoints) && p.supported_endpoints.some((endpoint) => /responses|structured/i.test(String(endpoint))));
      const reliableMini = /\b(?:gpt[-_ .]?4o[-_ .]?mini|gpt[-_ .]?5(?:[-_ .]?\d+)?[-_ .]?mini|gpt[-_ .]?5[-_ .]?mini|codex.*mini|claude.*haiku|haiku|sonnet|mini)\b/i.test(text);
      const flashFamily = /\b(?:gemini.*flash|flash)\b/i.test(text);
      const legacyClassifier = /\b(?:gpt[-_ .]?3(?:\.5|5)|gpt[-_ .]?4[-_ .]?0613|turbo[-_ .]?0613)\b/i.test(text);

      if (p.caps.includes("text")) bonus += 1.0;
      else bonus -= 99;

      if (structured) bonus += 3.5;
      if (reliableMini) bonus += 2.8;
      if (p.protocol === "openai" || p.family === "copilot" || p.family === "codex") bonus += 1.1;
      if (profile.quality_group >= 4) bonus += 1.0;
      else if (profile.quality_group < 3) bonus -= 1.5;

      if (profile.cost_group <= 2) bonus += 0.9;
      else if (profile.cost_group === 3) bonus += 0.25;
      else bonus -= 1.6;
      if (multiplier !== null) {
        if (multiplier <= 0.33) bonus += 0.8;
        else if (multiplier > 1) bonus -= Math.min(1.8, Math.log10(multiplier + 1) * 1.2);
      }

      if (profile.thinking_level >= 5) bonus -= 1.0;
      else if (profile.thinking_level >= 3) bonus += 0.25;
      if (profile.speed_group <= 2) bonus -= 0.35;
      if (flashFamily) bonus -= 4.0;
      if (legacyClassifier) bonus -= 5.0;
      if (/\b(?:opus|pro|max|xhigh|high[-_ ]?thinking)\b/i.test(text) || p.caps.includes("max")) bonus -= 1.8;
      if (p.caps.includes("tools")) bonus -= 0.15;
    } else if (routeCap === "text" || routeCap === "text-sm") {
      const profile = routingPolicy.classifyProvider(p);
      const multiplier = routingPolicy.costMultiplierForProvider(p);
      const text = `${p.name || ""} ${p.model || ""} ${p.upstream_model || ""}`.toLowerCase();
      const modernLight = /\b(?:gpt[-_ .]?4o[-_ .]?mini|gpt[-_ .]?5[-_ .]?mini|gpt[-_ .]?5[-_ .]?4.*mini|gemini.*flash|claude.*haiku|haiku|mini|flash|lite|nano)\b/i.test(text);
      const legacyClassifier = /\b(?:gpt[-_ .]?3(?:\.5|5)|gpt[-_ .]?4[-_ .]?0613|turbo[-_ .]?0613)\b/i.test(text);

      if (p.caps.includes("text")) bonus += 0.8;
      else bonus -= 99;

      if (profile.cost_group <= 1) bonus += 1.2;
      else if (profile.cost_group === 2) bonus += 0.75;
      else if (profile.cost_group === 3) bonus -= routeCap === "text-sm" ? 0.5 : 0.15;
      else bonus -= 2.5;

      if (multiplier !== null) {
        if (multiplier <= 0) bonus += 1.8;
        else if (multiplier <= 0.33) bonus += 1.2;
        else if (multiplier <= 1) bonus += 0.45;
        else bonus -= Math.min(2.2, Math.log10(multiplier + 1) * 1.3);
      }

      if (profile.speed_group >= 5) bonus += 0.6;
      else if (profile.speed_group >= 4) bonus += 0.35;
      if (profile.thinking_level <= 2) bonus += 0.45;
      else if (profile.thinking_level >= 4) bonus -= routeCap === "text-sm" ? 1.0 : 0.55;
      if (/\b(mini|flash|haiku|small|tiny|lite|nano|free|fast|minimal)\b/i.test(text)) bonus += routeCap === "text-sm" ? 1.7 : 1.1;
      if (modernLight) bonus += routeCap === "text-sm" ? 4.0 : 2.2;
      if (legacyClassifier) bonus -= routeCap === "text-sm" ? 6.0 : 4.0;
      if ((/\b(sonnet|opus|claude(?!.*haiku)|pro|max|xhigh|high[-_ ]?thinking)\b/i.test(text) || p.caps.includes("max")) && !modernLight) {
        bonus -= routeCap === "text-sm" ? 5.5 : 4.0;
      }
      if (routeCap === "text-sm" && p.caps.includes("tools")) bonus -= 0.25;
    } else if (routeCap === "coding-sm") {
      const profile = routingPolicy.classifyProvider(p);
      const ctx = scoring.getEffectiveContext(p);
      const text = `${p.name || ""} ${p.model || ""} ${p.upstream_model || ""}`.toLowerCase();

      if (p.caps.includes("coding") && p.caps.includes("tools")) bonus += 0.8;
      else bonus -= 99;

      if (profile.speed_group >= 4) bonus += 0.35;
      if (profile.cost_group <= 3) bonus += 0.25;
      if (profile.cost_group >= 5) bonus -= 0.8;
      if (profile.thinking_level <= 3) bonus += 0.12;
      if (ctx <= 200000) bonus += 0.35;
      else if (ctx <= 400000) bonus += 0.12;
      else if (ctx >= 800000) bonus -= 0.7;
      if (p.caps.includes("max")) bonus -= 0.65;
      if (/\bopus\b/i.test(text)) bonus -= 2.4;
      if (/\b(sonnet|mini|fast|haiku|flash|swe|glm|minimax|grok|auto[-_]?review|priority)\b/i.test(text)) bonus += 0.35;
    } else if (routeCap !== null && routeCap !== undefined) {
      if (p.caps.includes(routeCap)) bonus += 0.6;
      else bonus -= 0.3; // penalize but still include as fallback
    }

    // Group-specific hard requirements: coding/max need tools+thinking
    if (routeCap === "coding" || routeCap === "coding-sm" || routeCap === "max") {
      if (p.caps.includes("tools")) bonus += 0.3;
      else bonus -= 0.5;
      if (p.tc || p.caps.includes("thinking")) bonus += 0.2;
      else bonus -= 0.3;
    }

    // Detected use-case bonus (from message analysis)
    for (const dc of detectedCaps) {
      if (p.caps.includes(dc)) bonus += 0.2;
    }
    if (needsImages) {
      if (providerSupportsImageInput(p, reqBody)) bonus += 0.8;
      else if (hasImageCompatibleProviders) bonus -= 99;
      else if (String(p.protocol || "").trim().toLowerCase() === "windsurf") bonus -= 1.2;
    }

    // Agent/IDE mode: prefer tier 1, require tools
    if (isAgent) {
      if (p.tier === 1) bonus += 0.4;
      if (p.tier === 3) bonus -= 0.4;
      if (!p.caps.includes("tools")) bonus -= 0.8;
    }

    if (needsUpgrade) {
      if (p.tier === 1) bonus += 0.8;
      if (p.tier === 3) bonus -= 1.0;
      if (p.tc) bonus += 0.3;
    }

    // Learned compat penalties: avoid providers that will fail for this request type
    if (compat.no_reasoning && hasReasoning) bonus -= 0.5;
    if (compat.no_extra_body && needsThinking) bonus -= 0.3;
    if (compat.max_tokens_cap && needsTools) bonus -= 0.1;
    if (compat.no_reasoning && needsThinking) bonus -= 0.3;
    if (compat.no_tool_history && hasToolHistory) bonus -= 99;
    if (compat.no_tools && needsTools) bonus -= 99;

    // Session affinity — prefer same provider that worked last in this session
    const lastProv = reqBody?._sessionLastProvider;
    if (lastProv) {
      const requestProfile = routingPolicy.effectiveRequestProfile(reqBody);
      const providerProfile = routingPolicy.classifyProvider(p);
      const affinity = providerProfile.cost_group > requestProfile.costTarget ? 0.12 : 0.24;
      if (p.name === lastProv) bonus += affinity;
      else if (p.model === state.PROVIDERS.find((x) => x.name === lastProv)?.model) bonus += affinity / 2;
    }

    return { provider: p, score: scoring.providerScore(p) + bonus };
  });

  const adjusted = routingPolicy.applySourceLocalCostMultiplierScores(scored, reqBody, { env: process.env });
  return adjusted.sort((a, b) => b.score - a.score).map((s) => withRoutingScore(s.provider, s.score));
}

// auto group: same logic but no specific group capability filter
function getProvidersForAuto(messages, estimatedTokens, reqBody) {
  const { caps: detectedCaps, isAgent, needsUpgrade } = transforms.detectUseCase(messages, reqBody);
  const hasReasoning = (messages || []).some((m) => m.reasoning_content);
  const needsThinking = detectedCaps.has("thinking");
  const needsTools = detectedCaps.has("tools") || isAgent;
  const needsImages = detectedCaps.has("images") || mediaContent.messagesHaveImages(messages || []);
  const hasToolHistory = requestHasToolHistory(reqBody);
  const directNoToolTask = isDirectNoToolRequest(reqBody);

  const all = state.PROVIDERS.filter((p) => p.key && p.alive !== false)
    .filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isRecentUnresolvedChronicStalling(p.name) && !scoring.isQuotaDisabled(p.name) && !scoring.isBannedFromGroup(p.name, "auto"))
    .filter((p) => !(reqBody?._assessmentSkipProviders || []).includes(p.name));
  const requestCarriesTools = !directNoToolTask && (
    (reqBody?.tools?.length || 0) > 0 ||
    (reqBody?.functions?.length || 0) > 0 ||
    hasToolHistory ||
    (messages || []).some((m) => m.role === "tool")
  );
  const viable = requestCarriesTools ? all.filter((p) => (p.caps || []).includes("tools")) : all;
  const hardWithContext = estimatedTokens > 0 ? viable.filter((p) => providerCanFitRoutedRequest(p, estimatedTokens, reqBody)) : viable;
  const imageCompatible = needsImages ? hardWithContext.filter((p) => providerSupportsImageInput(p, reqBody)) : [];
  const hasImageCompatibleProviders = needsImages && imageCompatible.length > 0;
  const withContext = hasImageCompatibleProviders ? imageCompatible : hardWithContext;

  const scored = withContext.map((p) => {
    let bonus = 0;
    const compat = scoring.getCompat(p.name);

    // Benchmark-backed model scoring — detect primary category from use case
    const primaryCap = detectedCaps.has("coding") ? "coding"
      : detectedCaps.has("thinking") ? "thinking"
      : detectedCaps.has("images") ? "images"
      : detectedCaps.has("tools") ? "tools"
      : "text";
    bonus += transforms.smartnessBonus(p, primaryCap, reqBody);
    bonus += scoring.providerPolicyBonus(p, reqBody);

    for (const cap of detectedCaps) {
      if (p.caps.includes(cap)) bonus += 0.3;
    }
    if (needsImages) {
      if (providerSupportsImageInput(p, reqBody)) bonus += 0.8;
      else if (hasImageCompatibleProviders) bonus -= 99;
      else if (String(p.protocol || "").trim().toLowerCase() === "windsurf") bonus -= 1.2;
    }
    if (isAgent) {
      if (p.tier === 1) bonus += 0.5;
      if (p.tier === 3) bonus -= 0.5;
      if (!p.caps.includes("tools")) bonus -= 1.0;
    }
    if (needsUpgrade) {
      if (p.tier === 1) bonus += 0.8;
      if (p.tier === 3) bonus -= 1.0;
      if (p.tc) bonus += 0.3;
    }
    // Learned compat penalties
    if (compat.no_reasoning && hasReasoning) bonus -= 0.5;
    if (compat.no_extra_body && needsThinking) bonus -= 0.3;
    if (compat.no_reasoning && needsThinking) bonus -= 0.3;
    if (compat.no_tool_history && hasToolHistory) bonus -= 99;
    if (compat.no_tools && needsTools) bonus -= 99;

    // Session affinity
    const lastProv = reqBody?._sessionLastProvider;
    if (lastProv) {
      const requestProfile = routingPolicy.effectiveRequestProfile(reqBody);
      const providerProfile = routingPolicy.classifyProvider(p);
      const affinity = providerProfile.cost_group > requestProfile.costTarget ? 0.12 : 0.24;
      if (p.name === lastProv) bonus += affinity;
      else if (p.model === state.PROVIDERS.find((x) => x.name === lastProv)?.model) bonus += affinity / 2;
    }

    return { provider: p, score: scoring.providerScore(p) + bonus };
  });

  const adjusted = routingPolicy.applySourceLocalCostMultiplierScores(scored, reqBody, { env: process.env });
  return adjusted.sort((a, b) => b.score - a.score).map((s) => withRoutingScore(s.provider, s.score));
}

function withRoutingScore(provider, score) {
  try {
    Object.defineProperty(provider, "_lastRoutingScore", {
      value: score,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {}
  return provider;
}

function formatRoutingProfileForLog(requestedModel, reqBody = {}, estTokens = 0) {
  const profile = routingPolicy.effectiveRequestProfile(reqBody);
  const source = profile.source || (reqBody._llmProxyDifficulty ? "assessment" : "heuristic");
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const effort = profile.effort || profile.thinkingEffort || "unknown";
  const estimated = Number(reqBody._estimatedTokens || 0);
  const stepShape = profile.stepShape || {};
  return [
    `ROUTING-PROFILE: ${requestedModel}`,
    `level=${profile.level}/${profile.label || "unknown"}`,
    `source=${source}`,
    `task=${profile.taskKind || "general"}`,
    `shape=${stepShape.shape || "unknown"}`,
    `gate=${stepShape.gate || "none"}`,
    `cost=${profile.costTarget}`,
    `thinking=${profile.thinkingLevel}/${effort}`,
    `speed=${profile.speedTarget}`,
    `input=${estTokens}tok`,
    `estimated=${estimated}tok`,
    `tools=${toolCount}`,
  ].join(" ") + formatContextEscalationForLog(profile, reqBody);
}

function routingAssessmentReason(profile = {}) {
  if (profile.reason) return String(profile.reason);
  if (profile.taskKind === "direct_answer") return "exact_reply";
  return String(profile.taskKind || profile.label || "general")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "general";
}

function contextEscalationReason(reqBody = {}) {
  const estimated = Number(reqBody._estimatedTokens || reqBody._inputTokens || 0);
  if (estimated > 150000) return "tokens>150k";
  if (estimated > 60000) return "tokens>60k";
  if (estimated > 12000) return "tokens>12k";
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  if (toolCount >= 50) return "tools>=50";
  return "context";
}

function formatContextEscalationForLog(profile = {}, reqBody = {}) {
  const taskLevel = Number(profile.taskLevel || 0);
  const contextLevel = Number(profile.contextLevel || 0);
  const finalLevel = Number(profile.level || 0);
  if (!taskLevel || !contextLevel || !finalLevel) return "";
  const fields = [
    `task_level=${taskLevel}`,
    `context_level=${contextLevel}`,
  ];
  if (contextLevel > taskLevel && finalLevel > taskLevel) {
    fields.push(`context_escalation=${taskLevel}->${finalLevel}`, `context_reason=${contextEscalationReason(reqBody)}`);
  } else {
    fields.push("context_escalation=none");
  }
  return ` ${fields.join(" ")}`;
}

function formatRoutingAssessmentForLog(provider, reqBody = {}) {
  const profile = routingPolicy.effectiveRequestProfile(reqBody);
  const source = profile.source || (reqBody._llmProxyDifficulty ? "assessment" : "heuristic");
  const effort = profile.effort || profile.thinkingEffort || "unknown";
  const stepShape = profile.stepShape || {};
  const providerRouteLevel = routingPolicy.providerMaxRoutingLevel(provider);
  return [
    `ASSESS: ${provider.name}`,
    `route_level=${providerRouteLevel}`,
    `request_level=${profile.level}`,
    `effort=${effort}`,
    `speed=${profile.speedTarget}`,
    `reason=${routingAssessmentReason(profile)}`,
    `source=${source}`,
    `task=${profile.taskKind || "general"}`,
    `shape=${stepShape.shape || "unknown"}`,
    `gate=${stepShape.gate || "none"}`,
    `cost=${profile.costTarget}`,
    `thinking=${profile.thinkingLevel}`,
  ].join(" ") + formatContextEscalationForLog(profile, reqBody);
}

function formatProviderCandidateForLog(provider) {
  const ctx = scoring.getEffectiveContext(provider);
  const finalScore = Number.isFinite(provider._lastRoutingScore) ? provider._lastRoutingScore : scoring.providerScore(provider);
  const baseScore = scoring.providerScore(provider);
  const profile = routingPolicy.classifyProvider(provider);
  const routingLevel = routingPolicy.providerMaxRoutingLevel(provider);
  const source = providerSourceKey(provider) || providerTraceSource(provider).toLowerCase();
  const modelClass = providerDiversityModelClass(provider);
  const multiplier = routingPolicy.costMultiplierForProvider(provider);
  const cost = multiplier === null ? String(profile.cost_group) : `${profile.cost_group},x=${multiplier}`;
  const diversity = Number.isFinite(provider._routingDiversityPenalty) && provider._routingDiversityPenalty > 0
    ? `,div=-${provider._routingDiversityPenalty.toFixed(2)}`
    : "";
  const diversityBoost = Number.isFinite(provider._routingDiversityBoost) && provider._routingDiversityBoost >= 0.005
    ? `,boost=${provider._routingDiversityBoost.toFixed(2)}`
    : "";
  return `${provider.name}(${provider.model},src=${source},mc=${modelClass},rl=${routingLevel},ctx=${ctx},score=${finalScore.toFixed(2)},base=${baseScore.toFixed(2)}${diversity}${diversityBoost},cost=${cost},quality=${profile.quality_group},think=${profile.thinking_effort},speed=${profile.speed_group})`;
}

function findProviderByModel(model) {
  const alive = state.PROVIDERS.filter((p) => p.alive !== false && p.key);

  // Find all matches, prefer non-cooldown
  function bestOf(candidates) {
    if (candidates.length === 0) return null;
    const available = candidates.filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isQuotaDisabled(p.name));
    if (available.length > 0) {
      // Return highest-scored available provider
      return available.sort((a, b) => scoring.providerScore(b) - scoring.providerScore(a))[0];
    }
    return candidates[0]; // fallback to first match even if on cooldown
  }

  // Exact model match (multiple sources may have same model)
  let matches = alive.filter((p) => p.model === model);
  if (matches.length > 0) return bestOf(matches);
  // Name match
  matches = alive.filter((p) => p.name.toLowerCase() === model.toLowerCase());
  if (matches.length > 0) return bestOf(matches);
  // Partial match
  matches = alive.filter((p) => p.model.includes(model));
  return bestOf(matches);
}

function canUseOpenAIStreaming(provider) {
  const protocol = String(provider.protocol || "").trim().toLowerCase();
  return providerAdapters.isOpenAIProtocol(provider) || protocol === "codex";
}

function canUseNativeStreaming(provider) {
  return providerAdapters.isNativeStreamingProtocol(provider);
}

function isWindsurfNativeProvider(provider = {}) {
  const protocol = String(provider.protocol || "").trim().toLowerCase();
  const family = String(provider.family || provider.source_family || "").trim().toLowerCase();
  const model = String(provider.model || provider.upstream_model || "").trim().toLowerCase();
  const name = String(provider.name || "").trim().toLowerCase();
  return protocol === "windsurf" || family === "windsurf" || model.startsWith("windsurf/") || name.startsWith("windsurf-");
}

function windsurfZeroChunkTimeoutCooldownMs() {
  return clampInt(process.env.WINDSURF_ZERO_CHUNK_TIMEOUT_COOLDOWN_MS, 60_000, 3600_000, 600_000);
}

function isWindsurfZeroChunkNativeTimeout(provider = {}, status = 0, body = "", chunks = 0) {
  if (chunks !== 0 || !isWindsurfNativeProvider(provider)) return false;
  const text = String(body || "");
  return (status === 502 || status === 504 || /timeout|idle/i.test(text)) &&
    /windsurf connect stream timeout|connect stream timeout|native stream.*timeout|stream timeout|idle/i.test(text);
}

function cooldownWindsurfNativeTimeoutPeers(provider = {}, status = 0, body = "", chunks = 0) {
  if (!isWindsurfZeroChunkNativeTimeout(provider, status, body, chunks)) return;
  const durationMs = windsurfZeroChunkTimeoutCooldownMs();
  const modelClass = providerDiversityModelClass(provider);
  scoring.setCooldown(provider.name, durationMs, "zero-chunk native stream timeout");
  if (!modelClass) return;

  let peers = 0;
  for (const candidate of state.PROVIDERS || []) {
    if (!candidate || candidate.name === provider.name || !isWindsurfNativeProvider(candidate)) continue;
    if (providerDiversityModelClass(candidate) !== modelClass) continue;
    scoring.setCooldown(candidate.name, durationMs, `peer zero-chunk native stream timeout: ${provider.name}`);
    peers += 1;
  }
  if (peers > 0) {
    state.log(`WINDSURF-STREAM-COOLDOWN: ${provider.name} zero-chunk timeout cooled ${peers} ${modelClass} peer(s) for ${durationMs}ms`);
  }
}

function extractSseTextForDiagnostics(sse = "") {
  const parts = [];
  for (const line of String(sse || "").split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.+)$/);
    if (!match) continue;
    const payload = match[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      const choice = parsed.choices?.[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === "string") parts.push(delta.content);
      if (typeof delta.reasoning === "string") parts.push(delta.reasoning);
      if (typeof delta.reasoning_content === "string") parts.push(delta.reasoning_content);
      if (typeof choice.message?.content === "string") parts.push(choice.message.content);
      if (typeof choice.text === "string") parts.push(choice.text);
    } catch {}
  }
  return parts.join("");
}

function sanitizedToolName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_.\-:]/g, "_").substring(0, 128);
}

function toolSchemaMap(reqBody = {}) {
  const map = new Map();
  const addSchema = (name, schema = {}) => {
    if (!name) return;
    map.set(name, schema);
    map.set(sanitizedToolName(name), schema);
  };
  for (const tool of reqBody.tools || []) {
    const fn = tool?.function || {};
    addSchema(fn.name, fn.parameters || {});
  }
  for (const fn of reqBody.functions || []) {
    addSchema(fn.name, fn.parameters || {});
  }
  return map;
}

function validateGeneratedToolCalls(responseBody, reqBody = {}) {
  const schemas = toolSchemaMap(reqBody);
  if (schemas.size === 0) return null;

  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { return null; }

  const validateCall = (kind, name, rawArgs) => {
    const schema = schemas.get(name);
    if (!schema) return null;

    let args;
    try { args = JSON.parse(rawArgs || "{}"); } catch {
      return `${kind} "${name}" generated invalid JSON arguments`;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return `${kind} "${name}" generated non-object arguments`;
    }

    for (const field of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(args, field) || args[field] == null || args[field] === "") {
        return `${kind} "${name}" missing required field "${field}"`;
      }
    }
    return null;
  };

  for (const choice of parsed.choices || []) {
    for (const toolCall of choice.message?.tool_calls || []) {
      const name = toolCall.function?.name || "";
      const invalid = validateCall("tool", name, toolCall.function?.arguments);
      if (invalid) return invalid;
    }
    const legacyCall = choice.message?.function_call;
    if (legacyCall?.name) {
      const invalid = validateCall("tool", legacyCall.name, legacyCall.arguments);
      if (invalid) return invalid;
    }
  }
  return null;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLooseJsonStringField(raw = "", field = "") {
  const re = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`, "g");
  const match = re.exec(String(raw || ""));
  if (!match) return undefined;
  let out = "";
  for (let i = match.index + match[0].length; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else out += next;
      i += 1;
      continue;
    }
    if (ch === "\"") {
      const rest = raw.slice(i + 1);
      if (/^\s*(?:,\s*"[A-Za-z0-9_.:-]+"\s*:|\})/.test(rest)) return out;
    }
    out += ch;
  }
  return out;
}

function parseLooseToolArgs(rawArgs = "{}", schema = {}) {
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}

  const properties = schema.properties || {};
  const fields = [...new Set([...Object.keys(properties), ...(schema.required || [])])];
  if (fields.length === 0) return null;

  const parsed = {};
  for (const field of fields) {
    const prop = properties[field] || {};
    const stringValue = extractLooseJsonStringField(rawArgs, field);
    if (stringValue !== undefined) {
      parsed[field] = stringValue;
      continue;
    }

    const numberMatch = String(rawArgs || "").match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (numberMatch) {
      parsed[field] = Number(numberMatch[1]);
      continue;
    }

    const booleanMatch = String(rawArgs || "").match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*(true|false)\\b`, "i"));
    if (booleanMatch) {
      parsed[field] = booleanMatch[1].toLowerCase() === "true";
      continue;
    }

    if (prop.type === "array" || prop.type === "object") {
      const valueMatch = String(rawArgs || "").match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\})(?:\\s*,\\s*"|\\s*\\})`));
      if (valueMatch) {
        try { parsed[field] = JSON.parse(valueMatch[1]); } catch {}
      }
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function validateToolArgsObject(kind, name, args = {}, schema = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `${kind} "${name}" generated non-object arguments`;
  }
  for (const field of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(args, field) || args[field] == null || args[field] === "") {
      return `${kind} "${name}" missing required field "${field}"`;
    }
  }
  return null;
}

function requestToolDefinitions(reqBody = {}) {
  const definitions = [];
  const seen = new Set();
  const add = (name, schema = {}) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    definitions.push({ name, schema: schema || {} });
  };
  for (const tool of reqBody.tools || []) {
    const fn = tool?.function || {};
    add(fn.name, fn.parameters || {});
  }
  for (const fn of reqBody.functions || []) {
    add(fn.name, fn.parameters || {});
  }
  return definitions;
}

function hasQuotedField(raw = "", field = "") {
  return new RegExp(`"${escapeRegExp(field)}"\\s*:`, "m").test(String(raw || ""));
}

function hasEmbeddedToolCallShape(raw = "", toolName = "", fields = []) {
  const text = String(raw || "");
  const namedJson = new RegExp(`\\b${escapeRegExp(toolName)}\\b\\s*[:=]?\\s*\\{`, "i").test(text);
  if (namedJson) return true;

  const fieldAlternation = fields.filter(Boolean).map(escapeRegExp).join("|");
  if (!fieldAlternation) return false;
  return new RegExp(
    `(?:^|[\\s,{])(?:true|false|null|-?\\d+(?:\\.\\d+)?|"[^"\\n]{0,240}")\\s*,\\s*"(?:${fieldAlternation})"\\s*:`,
    "m",
  ).test(text);
}

function embeddedToolArgumentSignal(content = "", reqBody = {}, { requireAllRequired = true } = {}) {
  const text = String(content || "");
  if (!text.trim() || looksLikeToolHistoryReplay(text)) return null;

  const candidates = [];
  for (const { name, schema } of requestToolDefinitions(reqBody)) {
    const required = Array.isArray(schema.required) ? schema.required.filter(Boolean) : [];
    if (required.length === 0) continue;

    const properties = schema.properties || {};
    const propertyNames = [...new Set([...Object.keys(properties), ...required])];
    const requiredHits = required.filter((field) => hasQuotedField(text, field)).length;
    const propertyHits = propertyNames.filter((field) => hasQuotedField(text, field)).length;
    const nameMentioned = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text);
    const toolCallShape = hasEmbeddedToolCallShape(text, name, propertyNames);

    const canInferTool =
      toolCallShape &&
      (required.length >= 2 ||
        nameMentioned ||
        (required.includes("old_string") && required.includes("new_string")));
    if (!canInferTool) continue;

    if (requireAllRequired) {
      if (requiredHits !== required.length) continue;
    } else if (requiredHits === 0 && !(nameMentioned && propertyHits > 0)) {
      continue;
    }

    const args = parseLooseToolArgs(text, schema);
    const invalid = requireAllRequired
      ? validateToolArgsObject("tool", name, args, schema)
      : null;
    const score = requiredHits * 10 + propertyHits + (nameMentioned ? 5 : 0);
    candidates.push({ name, schema, args, invalid, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[1] && candidates[1].score === candidates[0].score) {
    return { invalid: "embedded tool argument text matches multiple tool schemas" };
  }
  return candidates[0];
}

function parseEmbeddedToolArgumentText(content = "", reqBody = {}) {
  const candidate = embeddedToolArgumentSignal(content, reqBody, { requireAllRequired: true });
  if (!candidate) return { toolCalls: null };
  if (candidate.invalid) return { invalid: candidate.invalid };

  const idHash = crypto
    .createHash("sha256")
    .update(`embedded:${candidate.name}:${JSON.stringify(candidate.args)}`)
    .digest("hex")
    .slice(0, 16);
  return {
    toolCalls: [{
      id: `call_proxy_${idHash}`,
      type: "function",
      function: {
        name: candidate.name,
        arguments: JSON.stringify(candidate.args),
      },
    }],
  };
}

function looksLikeEmbeddedToolArgumentText(content = "", reqBody = {}) {
  return Boolean(embeddedToolArgumentSignal(content, reqBody, { requireAllRequired: false }));
}

function parseImitatedToolCallText(content = "", reqBody = {}) {
  const schemas = toolSchemaMap(reqBody);
  if (schemas.size === 0) return { toolCalls: null };

  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { toolCalls: null };
  if (!lines.every((line) => /^Tool call:\s*/i.test(line))) {
    return parseEmbeddedToolArgumentText(content, reqBody);
  }

  const toolCalls = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^Tool call:\s*([A-Za-z0-9_.:-]+)\s+(\{[\s\S]*\})\s*$/i);
    if (!match) return { invalid: "imitated tool call text is not parseable" };
    const name = match[1];
    const rawArgs = match[2];
    const schema = schemas.get(name) || schemas.get(sanitizedToolName(name));
    if (!schema) return { invalid: `imitated tool call "${name}" is not in current tool schema` };

    const args = parseLooseToolArgs(rawArgs, schema);
    const invalid = validateToolArgsObject("tool", name, args, schema);
    if (invalid) return { invalid };

    const idHash = crypto.createHash("sha256").update(`${index}:${name}:${JSON.stringify(args)}`).digest("hex").slice(0, 16);
    toolCalls.push({
      id: `call_proxy_${idHash}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
  }

  return { toolCalls };
}

function syntheticToolCallResponse(toolCalls = [], model = "llm-proxy") {
  return JSON.stringify({
    id: `chatcmpl-proxy-tools-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
      },
      finish_reason: "tool_calls",
    }],
  });
}

function normalizeImitatedToolCallResponse(responseBody, reqBody = {}, provider = {}) {
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { return { changed: false }; }
  const choice = parsed.choices?.[0];
  const message = choice?.message;
  if (!message || (message.tool_calls || []).length > 0 || message.function_call) return { changed: false };

  const content = messageContentText(message.content);
  const result = parseImitatedToolCallText(content, reqBody);
  if (result.invalid) return { changed: false, invalid: result.invalid };
  if (!result.toolCalls?.length) return { changed: false };

  message.content = null;
  message.tool_calls = result.toolCalls;
  choice.finish_reason = "tool_calls";
  parsed.model = parsed.model || provider.model;
  return { changed: true, body: JSON.stringify(parsed), count: result.toolCalls.length };
}

function createStreamToolCallAccumulator(reqBody = {}) {
  const calls = [];
  let sawToolCalls = false;
  let complete = false;

  function mergeToolCall(deltaCall = {}) {
    sawToolCalls = true;
    const idx = Number.isInteger(deltaCall.index) ? deltaCall.index : calls.length;
    const current = calls[idx] || { id: undefined, type: "function", function: { name: "", arguments: "" } };
    if (deltaCall.id) current.id = deltaCall.id;
    if (deltaCall.type) current.type = deltaCall.type;
    if (!current.function) current.function = { name: "", arguments: "" };
    const fn = deltaCall.function || {};
    if (fn.name) {
      if (!current.function.name) current.function.name = fn.name;
      else if (fn.name !== current.function.name && !current.function.name.endsWith(fn.name)) current.function.name += fn.name;
    }
    if (typeof fn.arguments === "string") current.function.arguments = `${current.function.arguments || ""}${fn.arguments}`;
    calls[idx] = current;
  }

  function ingest(chunkText) {
    for (const line of String(chunkText || "").split("\n")) {
      const match = line.match(/^data:\s*(.+)$/);
      if (!match) continue;
      const payload = match[1].trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      for (const choice of parsed.choices || []) {
        const delta = choice.delta || {};
        for (const deltaCall of delta.tool_calls || []) mergeToolCall(deltaCall);
        for (const messageCall of choice.message?.tool_calls || []) mergeToolCall(messageCall);
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") complete = true;
      }
    }
  }

  function asResponseBody() {
    return JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.filter(Boolean),
        },
      }],
    });
  }

  function validateIfComplete(force = false) {
    if (!sawToolCalls || (!complete && !force)) return null;
    return validateGeneratedToolCalls(asResponseBody(), reqBody);
  }

  return {
    ingest,
    validateIfComplete,
    hasPendingToolCalls: () => sawToolCalls && !complete,
    asResponseBody,
  };
}

function lastUserText(reqBody = {}) {
  const messages = reqBody.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return mediaContent.textFromContent(message.content);
  }
  return "";
}

function latestHumanUserText(reqBody = {}) {
  const messages = reqBody.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const text = messageContentText(message.content).trim();
    if (!text) continue;
    if (looksLikeToolHistoryReplay(text)) continue;
    if (/^\s*(?:<tool_result\b|tool_result:|tool result\b|historical tool result\b)/i.test(text)) continue;
    return text;
  }
  return "";
}

function fingerprintValue(value = "") {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try { text = JSON.stringify(value ?? ""); } catch { text = String(value ?? ""); }
  }
  return {
    length: text.length,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function assessmentCacheFingerprint(reqBody = {}) {
  const messages = (reqBody.messages || []).map((message) => ({
    role: message?.role || "",
    tool_call_id: String(message?.tool_call_id || "").slice(0, 160),
    content: fingerprintValue(message?.content ?? ""),
    text: fingerprintValue(messageContentText(message?.content)),
    tool_calls: (message?.tool_calls || []).map((toolCall) => ({
      id: String(toolCall?.id || "").slice(0, 160),
      name: String(toolCall?.function?.name || toolCall?.name || "").slice(0, 160),
      args: fingerprintValue(toolCall?.function?.arguments ?? toolCall?.arguments ?? ""),
    })),
  }));
  return JSON.stringify(messages);
}

function assessmentCacheMessageCount(reqBody = {}) {
  return Array.isArray(reqBody.messages) ? reqBody.messages.length : 0;
}

function normalizeRoutingText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return mediaContent.textFromContent(content);
  return "";
}

const INERT_CONTINUATION_PHRASES = [
  "continue",
  "continua",
  "continuing",
  "go",
  "go on",
  "proceed",
  "next",
  "wake up",
];

function normalizedInertContinuationText(content = "") {
  return normalizeRoutingText(content)
    .replace(/[`"'*_\[\](){}<>]/g, " ")
    .replace(/[.!?:;,\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInertContinuationText(content = "") {
  const text = normalizedInertContinuationText(content);
  if (!text) return false;
  return INERT_CONTINUATION_PHRASES.includes(text);
}

function hasToolAccess(reqBody = {}) {
  return ((reqBody.tools?.length || 0) + (reqBody.functions?.length || 0)) > 0;
}

function looksLikeToolActionPrelude(content = "", { allowPrefix = false } = {}) {
  const raw = String(content || "").trim();
  if (raw.length < 20 || raw.length > (allowPrefix ? 2000 : 1400)) return false;
  if (looksLikeSubstantiveReport(raw)) return false;

  const normalized = normalizeRoutingText(raw);
  const lines = raw.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const terminalGo = /(?:^|\n)\s*(?:go|continue|proceed|do it|run it)[.!?\s]*$/i.test(raw) ||
    /\b(?:go|continue|proceed|do it|run it)\s*[.!?]?\s*$/.test(normalized);
  const pathMatches = raw.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|toml|py|sh|go|rs|java|kt|swift|php|rb|sql|config)(?:\b|$)/g) || [];
  const actionMatches = normalized.match(/\b(?:check|read|inspect|review|re-read|reread|open|look at|verify|compare|run|test|build|scan|search|grep|rg|sed|cat)\b/g) || [];
  const futureIntent = /\b(?:i will|i ll|i'll|next|then|now|let me|need to|going to|still need|re-read|reread)\b/.test(normalized);
  const imperative = /(?:^|\n)\s*(?:check|read|inspect|review|open|run|verify|compare|test|build|scan|search)\b/i.test(raw);
  const enoughActionEvidence =
    pathMatches.length >= 2 ||
    actionMatches.length >= 2 ||
    (pathMatches.length >= 1 && actionMatches.length >= 1);

  if (!enoughActionEvidence) return false;
  if (!(futureIntent || imperative || terminalGo || lines.length >= 3)) return false;
  return allowPrefix || terminalGo;
}

function isPossibleInertContinuationPrefix(content = "") {
  const text = normalizedInertContinuationText(content);
  if (!text || text.length > 24) return false;
  return INERT_CONTINUATION_PHRASES.some((phrase) => phrase.startsWith(text));
}

function canUseHiddenContinuationForOutput(reqBody = {}, content = "", { allowPrefix = false } = {}) {
  if (!hasToolAccess(reqBody)) return false;
  if (asksExactReply(reqBody)) return false;
  if (allowPrefix) {
    return isPossibleInertContinuationPrefix(content) ||
      isInertContinuationText(content) ||
      looksLikeToolActionPrelude(content, { allowPrefix: true });
  }
  return isInertContinuationText(content) || looksLikeToolActionPrelude(content);
}

function toolWorkIntentText(reqBody = {}) {
  return [
    reqBody._llmProxyOriginalLastUserText,
    latestHumanUserText(reqBody),
    lastUserText(reqBody),
  ].filter(Boolean).join("\n");
}

function userAsksForToolAction(reqBody = {}) {
  const text = normalizeRoutingText(toolWorkIntentText(reqBody));
  if (!text) return false;
  return isInertContinuationText(text) ||
    /\b(?:continue|continua|go|proceed|run|ruleaza|rulat|execute|executa|execution|live|not dry[- ]?run|nu mai da cu dry|nu[^\n]{0,80}dry[- ]?run|fix|repar|repair|implement|implementeaz|edit|editeaz|modify|modific|write|scrie|create|creeaz|add|adauga|remove|sterge|delete|deploy|restart|build|test|testeaz|verify|verifica|commit|push|update|fa update)\b/.test(text);
}

function userAsksOnlyForReport(reqBody = {}) {
  const text = normalizeRoutingText(toolWorkIntentText(reqBody));
  if (!text) return false;
  const reportAsk = /\b(?:why|de ce|ce are|what happened|explain|explica|analyse|analyze|analiz|review|audit|diagnos|root cause|cauza|logs?|loguri|evaluate|evalueaz|summary|summar|sintez)\b/.test(text);
  return reportAsk && !userAsksForToolAction(reqBody);
}

function requestLooksLikeActiveToolWork(reqBody = {}) {
  if (!hasToolAccess(reqBody)) return false;
  if (asksExactReply(reqBody)) return false;
  if (!requestHasEffectiveToolHistory(reqBody)) return false;
  if (isDirectNoToolRequest(reqBody)) return false;

  const actionIntent = userAsksForToolAction(reqBody);
  if (userAsksOnlyForReport(reqBody) && !actionIntent) return false;
  if (actionIntent) return true;

  const profile = routingPolicy.effectiveRequestProfile(reqBody);
  const task = String(profile.taskKind || "").toLowerCase();
  const shape = String(profile.stepShape?.shape || "").toLowerCase();
  const gate = String(profile.stepShape?.gate || "").toLowerCase();
  return /^(?:agentic_coding|edit_recovery)$/.test(task) ||
    /^(?:write_heavy|review)$/.test(shape) ||
    /^(?:run_behavior|read_diff)$/.test(gate);
}

function shouldContinuePrematureToolWork(reqBody = {}, content = "", marker = null, { allowPrefix = false } = {}) {
  const text = String(content || "").trim();
  if (!text) return false;
  if (!requestLooksLikeActiveToolWork(reqBody)) return false;
  if (looksLikeToolHistoryReplay(text)) return false;
  if (/^\s*Tool call:\s*/i.test(text)) return false;
  if (looksLikeEmbeddedToolArgumentText(text, reqBody)) return false;
  if (looksLikeCompletedWorkReport(text) || looksLikeSubstantiveReport(text)) return false;
  if (marker && marker.level <= 2 && !userAsksForToolAction(reqBody)) return false;

  const limit = allowPrefix ? 1200 : 900;
  if (text.length > limit) return false;
  if (allowPrefix && text.length < 80) return true;

  const normalized = normalizeRoutingText(text);
  const futureOrIncomplete =
    /\b(?:i will|i'll|i am going to|let me|next|then|still need|needs? to|need to|todo|not done|not finished|not complete|voi|o sa|urmeaza|trebuie|mai trebuie|inca)\b/.test(normalized);
  const progressWithoutAction =
    /\b(?:found|located|looks like|it looks|root cause|issue|problem|dry[- ]?run|rendered|vars?|writer|path|file|live run|execution|am gasit|pare|problema|cauza)\b/.test(normalized);

  return futureOrIncomplete || (text.length <= 360 && progressWithoutAction);
}

function shouldHoldTextOnlyToolOutput(reqBody = {}, content = "", marker = null, { allowPrefix = false } = {}) {
  if (!hasToolAccess(reqBody)) return false;
  if (asksExactReply(reqBody)) return false;
  if (hasRequiredToolContract(reqBody)) return true;
  if (looksLikeToolHistoryReplay(content)) return true;
  if (/^\s*Tool call:\s*/i.test(String(content || ""))) return true;
  if (looksLikeEmbeddedToolArgumentText(content, reqBody)) return true;
  if (shouldContinuePrematureToolWork(reqBody, content, marker, { allowPrefix })) return true;
  return false;
}

function appendHiddenContinueMessage(reqBody = {}) {
  reqBody.messages = [...(reqBody.messages || []), { role: "user", content: "continue" }];
  return reqBody;
}

async function retryWithHiddenContinue(reqBody = {}, clientRes, options = {}, provider = {}, err = {}) {
  const retries = clampInt(reqBody._hiddenContinuationRetries, 0, 10, 0);
  if (retries >= 2) {
    if (provider?.name) scoring.recordStalling(provider.name);
    state.log(`HIDDEN-CONTINUE-LIMIT: ${provider?.name || "unknown"} retry=${retries} text="${String(err.continuationText || "").substring(0, 40)}"`);
    return false;
  }
  reqBody._hiddenContinuationRetries = retries + 1;
  appendHiddenContinueMessage(reqBody);
  state.log(`HIDDEN-CONTINUE-RETRY: ${provider?.name || "unknown"} retry=${reqBody._hiddenContinuationRetries} appended hidden user message "continue"`);
  await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
  return true;
}

function requestWantsStructuredJson(reqBody = {}) {
  const format = reqBody.response_format || reqBody.text?.format || reqBody.text_format;
  return format?.type === "json_schema" || format?.type === "json_object";
}

function jsonTextCandidates(text) {
  const stripped = routingPolicy.stripDifficultyMarkerFromText(String(text || "")).content.trim();
  const candidates = [stripped];
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const firstObject = stripped.indexOf("{");
  const lastObject = stripped.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(stripped.slice(firstObject, lastObject + 1));
  const firstArray = stripped.indexOf("[");
  const lastArray = stripped.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(stripped.slice(firstArray, lastArray + 1));
  return [...new Set(candidates.filter(Boolean))];
}

function textContainsJsonValue(text) {
  for (const candidate of jsonTextCandidates(text)) {
    try {
      JSON.parse(candidate);
      return true;
    } catch {}
  }
  return false;
}

function isStructuredJsonResponseBody(responseBody, reqBody = {}) {
  if (!requestWantsStructuredJson(reqBody)) return false;
  try {
    const parsed = JSON.parse(responseBody);
    const content = messageContentText(parsed.choices?.[0]?.message?.content);
    return textContainsJsonValue(content);
  } catch {
    return false;
  }
}

function stripHiddenMemoryMarkersFromContent(content) {
  let recall = null;
  const memoryOps = [];
  let changed = false;

  function absorb(result) {
    if (result.recall && !recall) recall = result.recall;
    if (Array.isArray(result.memories) && result.memories.length > 0) {
      memoryOps.push(...result.memories);
    } else if (result.memory) {
      memoryOps.push(result.memory);
    }
  }

  if (typeof content === "string") {
    const result = hiddenMemoryMarkers.stripHiddenMemoryMarkers(content);
    absorb(result);
    changed = result.content !== content || !!result.recall || !!result.memory;
    return { content: result.content, recall, memoryOps, changed };
  }

  if (Array.isArray(content)) {
    const next = content.map((part) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const result = hiddenMemoryMarkers.stripHiddenMemoryMarkers(part.text);
      absorb(result);
      if (result.content !== part.text || result.recall || result.memory) {
        changed = true;
        return { ...part, text: result.content };
      }
      return part;
    });
    return { content: next, recall, memoryOps, changed };
  }

  return { content, recall, memoryOps, changed: false };
}

function stripHiddenMemoryMarkersFromResponseBody(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    let changed = false;
    let recall = null;
    const memoryOps = [];

    for (const choice of parsed.choices || []) {
      for (const message of [choice?.message, choice?.delta]) {
        if (!message || !Object.prototype.hasOwnProperty.call(message, "content")) continue;
        const result = stripHiddenMemoryMarkersFromContent(message.content);
        if (!result.changed) continue;
        message.content = result.content;
        changed = true;
        if (result.recall && !recall) recall = result.recall;
        memoryOps.push(...result.memoryOps);
      }
    }

    return {
      body: changed ? JSON.stringify(parsed) : responseBody,
      changed,
      recall,
      memoryOps,
    };
  } catch {
    return { body: responseBody, changed: false, recall: null, memoryOps: [] };
  }
}

const PROXY_CACHE_ARTIFACT_LINE_RE =
  /^\s*(?:proxy suppressed invalid tool call "[^"]+": .+|tool call error:\s+the model attempted to call "[^"]+".+|llm_proxy_task_difficulty\b.*|historical tool (?:invocation|result)\s*\(\s*already\s+(?:executed|observed)\s*(?:\)|["']?\s*:?).*|past tool (?:invocation|result) \(context only\b.*)\s*$/i;

function stripProxyArtifactLines(text = "") {
  let cleanedText = String(text || "");
  let changed = false;

  const difficulty = routingPolicy.stripDifficultyMarkerFromText(cleanedText, { includeLegacyBare: true });
  if (difficulty.changed) {
    cleanedText = difficulty.content;
    changed = true;
  }

  const memoryMarkers = hiddenMemoryMarkers.stripHiddenMemoryMarkers(cleanedText);
  if (memoryMarkers.content !== cleanedText || memoryMarkers.recall || memoryMarkers.memory || (memoryMarkers.memories || []).length > 0) {
    cleanedText = memoryMarkers.content;
    changed = true;
  }

  const lines = cleanedText.split(/\n/);
  const kept = lines.filter((line) => !PROXY_CACHE_ARTIFACT_LINE_RE.test(line));
  if (kept.length !== lines.length) changed = true;
  if (!changed) return { changed: false, text: String(text || "") };
  return { changed: true, text: kept.join("\n").trim() };
}

function stripCachedProxyArtifacts(reqBody = {}) {
  if (!Array.isArray(reqBody.messages)) return 0;
  let changed = 0;
  const messages = [];

  for (const message of reqBody.messages) {
    if (message?.role !== "assistant") {
      messages.push(message);
      continue;
    }

    if (typeof message.content === "string") {
      if (!message.tool_calls?.length && isInertContinuationText(message.content)) {
        changed++;
        continue;
      }
      const cleaned = stripProxyArtifactLines(message.content);
      if (!cleaned.changed) {
        messages.push(message);
      } else if (cleaned.text || message.tool_calls?.length) {
        messages.push({ ...message, content: cleaned.text || null });
        changed++;
      } else {
        changed++;
      }
      continue;
    }

    if (Array.isArray(message.content)) {
      const rawText = messageContentText(message.content);
      if (!message.tool_calls?.length && isInertContinuationText(rawText)) {
        changed++;
        continue;
      }
      let partChanged = false;
      const parts = message.content
        .map((part) => {
          if (part?.type !== "text") return part;
          const cleaned = stripProxyArtifactLines(part.text || "");
          if (!cleaned.changed) return part;
          partChanged = true;
          return cleaned.text ? { ...part, text: cleaned.text } : null;
        })
        .filter(Boolean);
      if (partChanged) changed++;
      if (parts.length > 0 || message.tool_calls?.length) {
        messages.push(partChanged ? { ...message, content: parts.length > 0 ? parts : null } : message);
      }
      continue;
    }

    messages.push(message);
  }

  if (changed > 0) {
    reqBody.messages = messages;
    state.log(`PROXY-CACHE-STRIP: removed ${changed} cached proxy assistant artifact${changed === 1 ? "" : "s"}`);
  }
  return changed;
}

function stripProxyArtifactLinesFromResponseBody(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    let changed = false;
    let artifactOnly = false;

    const stripContent = (content) => {
      if (typeof content === "string") {
        const cleaned = stripProxyArtifactLines(content);
        return cleaned.changed
          ? { changed: true, content: cleaned.text || "" }
          : { changed: false, content };
      }

      if (Array.isArray(content)) {
        let partChanged = false;
        const parts = content
          .map((part) => {
            if (part?.type !== "text") return part;
            const cleaned = stripProxyArtifactLines(part.text || "");
            if (!cleaned.changed) return part;
            partChanged = true;
            return cleaned.text ? { ...part, text: cleaned.text } : null;
          })
          .filter(Boolean);
        return {
          changed: partChanged,
          content: parts.length > 0 ? parts : "",
        };
      }

      return { changed: false, content };
    };

    for (const choice of parsed.choices || []) {
      for (const message of [choice?.message, choice?.delta]) {
        if (!message || !Object.prototype.hasOwnProperty.call(message, "content")) continue;
        const beforeText = messageContentText(message.content).trim();
        const result = stripContent(message.content);
        if (!result.changed) continue;

        message.content = result.content;
        changed = true;
        const afterText = messageContentText(message.content).trim();
        const hasToolCalls = (message.tool_calls?.length || 0) > 0;
        if (beforeText && !afterText && !hasToolCalls) artifactOnly = true;
      }
    }

    return {
      body: changed ? JSON.stringify(parsed) : responseBody,
      changed,
      artifactOnly,
    };
  } catch {
    return { body: responseBody, changed: false, artifactOnly: false };
  }
}

function looksLikeSubstantiveReport(content = "") {
  const text = String(content || "").trim();
  if (text.length < 140) return false;
  if (looksLikeToolHistoryReplay(text)) return false;
  const normalized = normalizeRoutingText(text);
  const head = normalized.slice(0, 1200);
  const reportLead = /(analiz|analysis|strategi|strategy|stare|current state|what i found|recomand|recommend|improvement|imbunatat|project scan|full project scan|deep scan|scan done|full scan complete)/.test(head);
  const completedWorkLead = /(continuat|completed|done|finished|implemented|fixed|updated|changed|changes|schimbari|modificari|actualizat|adaugat|reparat|implementat)/.test(head);
  const diagnosticLead = /(diagnos|root cause|current (?:error|failure)|failure|failed|works now|now works|script|bug|evidence|observed|resolved|status=)/.test(head);
  const structured = /(^|\n)\s*(#{1,4}\s|\*\*[^*\n]+\*\*|[-*]\s|\d+\.|```)/m.test(text);
  const evidenceRich = /(```|`[^`\n]+`|\b(?:status|returncode|traceback|stack|ansible|docker|npm|pytest|node|curl|git|command|test|tests|failure|failed|error|evidence)\b|[a-z0-9_.-]+\.(?:py|js|ts|md|json|ya?ml|sh)\b)/.test(normalized);
  const actionable = /(recomand|recommend|strategi|strategy|priorit|impact|effort|risc|risk|next steps|pasi|pasii|fix|fixed|implemented|changed|changes|schimbari|modificari|actualizat|adaugat|reparat|implementat|improvement|imbunatat|stabiliz|optimiz|observabil|regression|teste|tests|test_unit|diagnos|root cause|error|failure|failed|evidence|verify|verification|command|run|\.py|\.js|\.ts|\.md|\.sh)/.test(normalized);
  const fakeShellOnly = /^(?:git|npm|npx|docker|curl|rg|sed|cat|ls|pwd|python|node)\s+/m.test(text) && text.split(/\n/).length < 4;
  return !fakeShellOnly && (reportLead || completedWorkLead || diagnosticLead) && (structured || evidenceRich) && actionable;
}

function looksLikeCoherentInvestigationNarrative(content = "") {
  const text = String(content || "").trim();
  if (text.length < 500) return false;
  if (looksLikeToolHistoryReplay(text)) return false;

  const normalized = normalizeRoutingText(text);
  const head = normalized.slice(0, 1600);
  const investigationLead =
    /^(?:i(?:'ll| will| am going to)|let me|voi|o sa)\s+(?:investigate|inspect|analy[sz]e|review|trace|check|look into)\b/.test(head) ||
    /\b(?:i(?:'ll| will| am going to)|let me|voi|o sa)\s+(?:investigate|inspect|analy[sz]e|review|trace|check|look into)\b/.test(head);
  const planLike =
    /(^|\n)\s*(?:plan|approach|steps|next steps|pasi|pasii)\s*[:：]?/i.test(text) ||
    (text.match(/^\s*\d+\.\s+/gm) || []).length >= 2;
  const pathMatches = text.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|css|scss|svg|json|ya?ml|toml|sh|py|md|html|config)(?:\b|$)/g) || [];
  const domainSignals = normalized.match(/\b(?:repo|next\.?js|component|asset|path|static|public|css|chunk|docker|curl|logs|routing|provider|tool|request|response|implementation|test|tests)\b/g) || [];
  const words = normalized.split(/\s+/).filter((word) => /^[a-z][a-z0-9_-]{2,}$/.test(word));

  return investigationLead && planLike && pathMatches.length >= 2 && domainSignals.length >= 4 && words.length >= 60;
}

function looksLikeCoherentGarbleFalsePositive(content = "") {
  return looksLikeSubstantiveReport(content) || looksLikeCoherentInvestigationNarrative(content);
}

function looksLikeCompletedWorkReport(content = "") {
  const text = String(content || "").trim();
  if (text.length < 25 || text.length > 1200) return false;
  if (looksLikeToolHistoryReplay(text)) return false;
  const normalized = normalizeRoutingText(text);
  const head = normalized.slice(0, 240);
  const completionLead = /^(?:done|completed|finished|fixed|updated|changed|implemented|added|created|removed|resolved|pushed|committed|deployed|ran|verified|tested|continuat|gata|terminat|reparat|actualizat|implementat|adaugat|sters|urcat|deployat|rulat|verificat)\b/.test(head) ||
    /\b(?:done|completed|finished|fixed|updated|changed|implemented|added|created|removed|resolved|pushed|committed|deployed|continuat|gata|terminat|reparat|actualizat|implementat|adaugat)\b[.!:]/.test(head);
  if (!completionLead) return false;
  if (/^(?:i will|i'll|i am going to|let me|next i(?:'ll| will)|voi|o sa)\b/.test(head)) return false;

  const completedAction = /\b(?:added|fixed|updated|changed|implemented|created|removed|resolved|pushed|committed|deployed|ran|verified|tested|cleared|wired|converted|normalized|synced|rebuilt|started|stopped|restarted|adaugat|reparat|actualizat|modificat|implementat|creat|sters|rezolvat|urcat|deployat|rulat|verificat|sincronizat|rebuild)\b/.test(normalized);
  const resultEvidence = /(^|\n)\s*[-*]\s+/.test(text) ||
    /\b(?:pushed|committed|deployed|tests? passed|verified|rebuilt|started|health ok|status=ok|urcat|deployat|teste(?:le)? au trecut|verificat)\b/.test(normalized) ||
    /[a-z0-9_.-]+\.(?:py|js|ts|tsx|jsx|css|scss|md|json|ya?ml|toml|sh|go|rs|java|kt|swift|php|rb|sql)\b/.test(normalized);

  return completedAction && (text.length >= 60 || resultEvidence);
}

function looksLikeAssessmentRerouteOnly(content = "") {
  const text = normalizeRoutingText(content);
  if (!text) return true;
  if (text.length > 180) return false;
  return /\b(?:reroute|escalate|upgrade)\b/.test(text) ||
    /\b(?:need|needs|requires?|should use|cannot finish|can't finish)\b.*\b(?:deeper|stronger|larger|higher|more capable|xhigh|opus|sonnet|frontier|model|pass|review)\b/.test(text);
}

function asksIdentityQuestion(reqBody = {}) {
  const userText = normalizeRoutingText(lastUserText(reqBody));
  return /\b(who are you|what is your name|your name|identity|cum te cheama|cum te numesti|cine esti|numele tau|ce nume ai)\b/.test(userText);
}

function asksExactReply(reqBody = {}) {
  const text = lastUserText(reqBody);
  return /^\s*(reply exactly|say exactly)\b/i.test(text) || /^\s*(hello|hi|ok|ping)[\s.!?]*$/i.test(text);
}

function isDeterministicDirectAnswerRequest(reqBody = {}, profile = null) {
  const effective = profile || routingPolicy.effectiveRequestProfile(reqBody);
  return (
    effective?.taskKind === "direct_answer" ||
    effective?.stepShape?.shape === "direct" ||
    asksIdentityQuestion(reqBody) ||
    asksExactReply(reqBody)
  );
}

function isProxyIdentityAnswer(content = "") {
  return /\bProject\s+llm\s+smart\s+proxy\b/.test(normalizeRoutingText(content));
}

const TOOL_HISTORY_REPLAY_MARKER_RE =
  /^\s*(?:historical tool (?:invocation|result)\s*\(\s*already\s+(?:executed|observed)\s*(?:\)|["']?\s*:?)|past tool (?:invocation|result) \(context only\b)/im;
const TOOL_HISTORY_REPLAY_HEADER_RE =
  /^(?:Bash|Read|Edit|MultiEdit|Write|Grep|Glob|LS|List|WebFetch|NotebookRead|NotebookEdit|TodoWrite|Task)\b/i;
const TOOL_HISTORY_REPLAY_COMMAND_RE =
  /[A-Za-z0-9_.-]+\.(?:sh|js|ts|tsx|jsx|css|scss|md|json|ya?ml|toml|py|go|rs|java|kt|swift|php|rb|sql)\b|^(?:cd|file|xxd|cat|sed|rg|grep|ls|pwd|npm|npx|node|python|git|docker|curl|find)\b/i;

function looksLikeToolHistoryReplay(content = "") {
  const text = String(content || "").trim();
  if (!text) return false;
  if (TOOL_HISTORY_REPLAY_MARKER_RE.test(text)) return true;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const scanLimit = Math.min(lines.length, 12);
  for (let i = 0; i < scanLimit; i += 1) {
    if (!TOOL_HISTORY_REPLAY_HEADER_RE.test(lines[i])) continue;
    const nextLines = lines.slice(i + 1, Math.min(lines.length, i + 8));
    const sawOut = nextLines.some((line) => /^OUT\b/i.test(line));
    const sawIn = nextLines.some((line) => /^IN\b/i.test(line));
    const sawCommandLikeLine = nextLines.some((line) => TOOL_HISTORY_REPLAY_COMMAND_RE.test(line));
    if (sawOut && (sawIn || sawCommandLikeLine)) return true;
  }
  return false;
}

function allowsTextOnlyAnswer(reqBody = {}, content = "", marker = null) {
  if (hasRequiredToolContract(reqBody)) return false;
  if (isDirectNoToolRequest(reqBody)) return true;
  if (asksExactReply(reqBody)) return true;
  if (looksLikeToolHistoryReplay(content)) return false;
  if (marker && marker.level <= 2) return true;
  const profile = routingPolicy.effectiveRequestProfile(reqBody);
  if (profile.taskKind === "direct_answer" || profile.stepShape?.shape === "direct") return true;
  if (asksIdentityQuestion(reqBody) && isProxyIdentityAnswer(content)) return true;
  if (looksLikeCompletedWorkReport(content)) return true;
  if (looksLikeSubstantiveReport(content)) return true;
  const userText = normalizeRoutingText(lastUserText(reqBody));
  const asksForReport = /(analiz|analyse|analyze|strategi|strategy|plan|descri|describe|explic|explain|review|audit|recomand|recommend|summary|summar|sintez|diagnos|root cause|cauz)/.test(userText);
  const asksForEdit = /(implementeaz|implement|modific|modify|fix|repar|editeaz|edit|scrie|write|creeaz|create|adauga|add|sterge|delete|remove|ruleaz|run|execut|deploy|commit|build|testeaz|test)/.test(userText);
  const substantive = content.length >= 500 && /(^|\n)\s*(#{1,4}\s|[-*]\s|\d+\.\s|\*\*)/m.test(content);
  if (asksForReport && !asksForEdit && substantive) return true;

  // Optional tools are affordances, not an execution contract. A normal text
  // response should remain valid unless the request explicitly required a tool
  // call or the model is replaying cached tool history.
  return true;
}

function estimateTextTokens(text = "") {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function normalizeZeroUsage(responseBody, transformedBody = {}) {
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { return { body: responseBody, usage: null }; }
  const choice = parsed.choices?.[0] || null;
  const content = messageContentText(choice?.message?.content);
  const usage = parsed.usage || {};
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0)
    || compaction.estimateTokens(transformedBody.messages)
    + compaction.estimateRequestSchemaTokens(transformedBody);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0)
    || estimateTextTokens(content);
  const total = Number(usage.total_tokens || 0) || (prompt + completion);

  if (usage.prompt_tokens === prompt && usage.completion_tokens === completion && usage.total_tokens === total) {
    return { body: responseBody, usage };
  }

  parsed.usage = {
    ...usage,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Math.max(total, prompt + completion),
  };
  return { body: JSON.stringify(parsed), usage: parsed.usage };
}

function syntheticAssistantResponse(content = "") {
  return JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: String(content || ""),
      },
    }],
  });
}

function optionHeader(options = {}, name = "") {
  const headers = options.headers || {};
  const key = String(name || "").toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (String(headerName).toLowerCase() === key) return String(value || "");
  }
  return "";
}

function detectIdeClient(reqBody = {}, options = {}) {
  const haystack = [
    optionHeader(options, "user-agent"),
    optionHeader(options, "x-client-name"),
    optionHeader(options, "x-requested-with"),
    optionHeader(options, "anthropic-client"),
    optionHeader(options, "openai-organization"),
    reqBody.model,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/(?:claude[-_ ]?code|anthropic\.claude|claude)/i.test(haystack)) {
    return {
      id: "claude_code",
      action: "Claude Code: run /compact or start a fresh task, then retry the same instruction.",
    };
  }
  if (/(?:windsurf|cascade|codeium)/i.test(haystack)) {
    return {
      id: "windsurf",
      action: "Windsurf: compact or start a new Cascade conversation, then retry the same instruction.",
    };
  }
  if (/(?:codex|openai-codex)/i.test(haystack)) {
    return {
      id: "codex",
      action: "Codex: start a fresh thread or compact the conversation, then retry the same instruction.",
    };
  }
  if (/(?:copilot|github[-_ ]?copilot|vscode)/i.test(haystack)) {
    return {
      id: "copilot",
      action: "Copilot: start a new chat or clear the current chat context, then retry the same instruction.",
    };
  }
  return {
    id: "generic",
    action: "Client: compact or start a fresh conversation, then retry the same instruction.",
  };
}

function contextCompactionGuidance(reqBody = {}, details = {}, options = {}) {
  const client = detectIdeClient(reqBody, options);
  const inputTokens = Math.max(0, Number(details.inputTokens || reqBody._inputTokens || 0));
  const maxContext = Math.max(0, Number(details.maxContext || 0));
  const requestedTokens = Math.max(0, Number(details.requestedTokens || inputTokens + (reqBody.max_tokens || 4096)));
  const reason = String(details.reason || "context_overflow");

  return [
    "LLM_PROXY_CONTEXT_COMPACTION_REQUIRED",
    `client=${client.id} reason=${reason} input_tokens=${inputTokens} requested_tokens=${requestedTokens} max_context=${maxContext}`,
    "The proxy compacted locally when possible, but this request still does not fit any configured provider.",
    client.action,
  ].join("\n");
}

function writeContextCompactionGuidance(clientRes, reqBody = {}, details = {}, options = {}) {
  const body = syntheticAssistantResponse(contextCompactionGuidance(reqBody, details, options));
  state.log(
    `IDE-COMPACT-GUIDANCE: client=${detectIdeClient(reqBody, options).id} ` +
    `reason=${details.reason || "context_overflow"} input=${details.inputTokens || reqBody._inputTokens || 0}tok max_ctx=${details.maxContext || 0}`,
  );
  if (reqBody.stream === true) {
    sendAsSSE(clientRes, body, { name: "LLM-Proxy", model: "llm-proxy" }, reqBody);
    return;
  }
  clientRes.writeHead(200, { "Content-Type": "application/json" });
  clientRes.end(body);
}

function isContextOverflowErrorText(text = "") {
  return /context.length|context window|context_length_exceeded|input exceeds|too.large|maximum.*token|too large for model|token.*exceed|max.size.*token/i.test(String(text || ""));
}

function routeErrorText(error = {}) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  if (error?.body !== undefined) {
    if (typeof error.body === "string") return error.body;
    try { return JSON.stringify(error.body); } catch { return String(error.body); }
  }
  if (error?.error !== undefined) {
    if (typeof error.error === "string") return error.error;
    if (error.error instanceof Error) return error.error.message || String(error.error);
    if (error.error?.message) return String(error.error.message);
    try { return JSON.stringify(error.error); } catch { return String(error.error); }
  }
  if (error?.message) return String(error.message);
  if (error?.timeout) return "timeout";
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {}
  return String(error || "unknown");
}

function routeErrorStatus(error = {}) {
  const status = Number(error?.status || error?.statusCode || error?.error?.status || error?.error?.statusCode || 0);
  if (status > 0) return status;
  return error?.timeout ? 504 : 500;
}

function truncatedForAssessment(text = "", maxChars = 4000) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function recentUserMessagesForAssessment(reqBody = {}) {
  return (reqBody.messages || [])
    .filter((message) => message?.role === "user")
    .slice(-3)
    .map((message) => truncatedForAssessment(messageContentText(message.content), 1600));
}

function compactToolCallSummary(message = {}) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls
    .map((toolCall) => {
      const id = String(toolCall?.id || "unknown").slice(0, 80);
      const name = String(toolCall?.function?.name || toolCall?.name || "tool").slice(0, 120);
      const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? "";
      let args = typeof rawArgs === "string" ? rawArgs : "";
      if (!args && rawArgs && typeof rawArgs === "object") {
        try { args = JSON.stringify(rawArgs); } catch { args = String(rawArgs); }
      }
      return `${id} ${name} args=${truncatedForAssessment(String(args || "").replace(/\s+/g, " "), 500)}`;
    })
    .join("; ");
}

function recentAssistantToolEvidenceForAssessment(reqBody = {}) {
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const progressMessages = messages
    .slice(Math.max(0, lastUserIdx + 1))
    .filter((message) => message?.role === "assistant" || message?.role === "tool")
    .slice(-8);

  const lines = [];
  for (const message of progressMessages) {
    if (message.role === "assistant") {
      const parts = [];
      const toolSummary = compactToolCallSummary(message);
      const content = messageContentText(message.content).trim();
      if (toolSummary) parts.push(`tool_calls=${toolSummary}`);
      if (content) parts.push(`content=${truncatedForAssessment(content, 900)}`);
      if (parts.length > 0) lines.push(`assistant: ${parts.join(" | ")}`);
      continue;
    }

    const content = messageContentText(message.content).trim();
    if (content) {
      lines.push(`tool_result:${message.tool_call_id || "unknown"}: ${truncatedForAssessment(content, 1200)}`);
    }
  }

  return lines.join("\n");
}

function hasAssistantOrToolAfterLatestUser(reqBody = {}) {
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return false;
  return messages
    .slice(lastUserIdx + 1)
    .some((message) => message?.role === "assistant" || message?.role === "tool" || message?.tool_calls?.length > 0);
}

function hasContinuationAssessmentUpgradeSignal(reqBody = {}, heuristic = {}) {
  const evidence = normalizeRoutingText(recentAssistantToolEvidenceForAssessment(reqBody));
  if (!evidence) return false;
  const hardTask = Number(heuristic.taskLevel || heuristic.level || 0) >= 4 || Number(heuristic.contextLevel || 0) >= 5;
  const upgradeSignal =
    /\b(?:upgrade|reroute|underpowered|too weak|capability|frontier|opus|high thinking|xhigh|context length|context_length|maximum context|token limit|invalid tool|tool invalid|schema invalid|stalling|no-tools|model failed|provider failed)\b/.test(evidence);
  return hardTask && upgradeSignal;
}

function shouldUseAiTaskAssessment(reqBody = {}, requestedModel = "", isGroup = false, heuristic = {}) {
  const mode = String(process.env.LLM_PROXY_AI_ASSESSMENT || "auto").trim().toLowerCase();
  if (mode === "0" || mode === "false" || mode === "off" || mode === "disabled") return false;
  if (!isGroup) return false;
  if (reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary || reqBody._llmProxyDifficulty) return false;
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) return false;
  if (isDeterministicDirectAnswerRequest(reqBody, heuristic)) return false;

  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const inputTokens = Number(reqBody._inputTokens || reqBody._estimatedTokens || 0);
  const lastText = lastUserText(reqBody);
  const noisyRoutingDiagnostic =
    /\b(?:ROUTING-PROFILE|ASSESS:|Route:|REROUTE:|reason=|task=|shape=|gate=|source=heuristic)\b/i.test(lastText) ||
    /\b(?:routing|routeaza|intra|gresit|aiurea|opus|sonnet|provider|clasificare|detectia)\b/i.test(lastText);
  if (mode === "always" || mode === "1" || mode === "true") return true;

  const requestedAutoCoding = requestedModel === "auto" || /auto-(?:coding|tools|max|thinking)/i.test(requestedModel);
  const largeOrToolCached = toolCount >= 50 || inputTokens > 30000 || reqBody.messages.length > 40;
  const riskyHeuristic =
    Number(heuristic.level || 0) >= 4 ||
    heuristic.taskKind === "security_review" ||
    heuristic.stepShape?.shape === "security" ||
    heuristic.stepShape?.gate === "human_signoff";
  const unsupportedHighRiskContinuation =
    hasAssistantOrToolAfterLatestUser(reqBody) &&
    isHighRiskRoutingProfile(heuristic) &&
    !currentUserSupportsHighRiskProfile(reqBody, heuristic);
  if (
    hasAssistantOrToolAfterLatestUser(reqBody) &&
    !unsupportedHighRiskContinuation &&
    !hasContinuationAssessmentUpgradeSignal(reqBody, heuristic)
  ) {
    return false;
  }
  if (requiresLargeModelAssessmentForSelection(reqBody, requestedModel, isGroup)) return true;
  return requestedAutoCoding && largeOrToolCached && (riskyHeuristic || noisyRoutingDiagnostic);
}

function isHumanApprovalGate(profile = {}) {
  const gate = profile.stepShape?.gate || "";
  return gate === "human_signoff";
}

function isLargeAssessmentGatedGroup(requestedModel = "") {
  const model = String(requestedModel || "").toLowerCase();
  return model === "auto" || /^(auto-coding|auto-tools|auto-thinking|auto-max|coding-sm)$/.test(model);
}

function providerIsLowAutoTier(provider = {}) {
  const profile = routingPolicy.classifyProvider(provider);
  const text = `${provider.name || ""} ${provider.model || ""} ${provider.upstream_model || ""}`.toLowerCase();
  if (/\b(?:opus|sonnet|pro|max|xhigh|high[-_ ]?thinking)\b/.test(text)) return false;
  if (profile.cost_group <= 1) return true;
  if (profile.cost_group <= 2 && profile.thinking_level <= 3) return true;
  if (profile.cost_group <= 3 && /\b(?:mini|haiku|swe|flash|classifier|small|lite|nano|free)\b/.test(text)) return true;
  return false;
}

function providerIsKnownLargeAutoTier(provider = {}) {
  const profile = routingPolicy.classifyProvider(provider);
  const text = `${provider.name || ""} ${provider.model || ""} ${provider.upstream_model || ""}`.toLowerCase();
  const caps = provider.caps || [];
  if (caps.includes("max")) return true;
  if (profile.cost_group >= 4 || profile.thinking_level >= 4 || profile.quality_group >= 5) return true;
  return /\b(?:opus|sonnet|pro|max|xhigh|high[-_ ]?thinking|gpt[-_./ ]?[45]|o[134](?:[-_./ ]|$)|gemini[-_./ ]?3[-_./ ]?pro|gemini.*pro|claude[-_./ ]?4)\b/.test(text);
}

function providerRequiresAiAssessment(provider = {}) {
  if (providerIsLowAutoTier(provider)) return false;
  return providerIsKnownLargeAutoTier(provider);
}

function requiresLargeModelAssessmentForSelection(reqBody = {}, requestedModel = "", isGroup = false) {
  if (!isGroup || !isLargeAssessmentGatedGroup(requestedModel)) return false;
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) return false;
  const estimated = Number(reqBody._estimatedTokens || reqBody._inputTokens || 0);
  const candidates = requestedModel === "auto"
    ? getProvidersForAuto(reqBody.messages, estimated, reqBody)
    : getProvidersForGroup(requestedModel, estimated, reqBody);
  const top = candidates[0];
  if (!top) return false;
  if (providerRequiresAiAssessment(top)) {
    state.log(`AI-ASSESS-GATE: top=${top.name} requires assessment before large-model access`);
    return true;
  }
  return false;
}

function assessmentRequestedLevel(profile = {}) {
  return Math.max(
    Number(profile.level || 0),
    Number(profile.taskLevel || 0),
    Number(profile.contextLevel || 0),
    Number(profile.thinkingLevel || 0),
    profile.stepShape?.gate === "human_signoff" || profile.stepShape?.gate === "dry_run_first" ? 5 : 0,
  );
}

function upwardAssessmentFallbackProviders(providers = [], profile = {}) {
  const requestedLevel = assessmentRequestedLevel(profile);
  if (requestedLevel < 4) return [];
  return providers.filter((provider) => {
    if (routingPolicy.providerMaxRoutingLevel(provider) <= requestedLevel) return false;
    return assessmentAllowsProvider(profile, provider, { allowUpwardFallback: true });
  });
}

function assessmentAllowsProvider(profile = {}, provider = {}, options = {}) {
  if (!profile) return !providerRequiresAiAssessment(provider);
  const requestedLevel = assessmentRequestedLevel(profile);
  const providerRouteLevel = routingPolicy.providerMaxRoutingLevel(provider);
  if (options.enforceLevelFloor !== false) {
    if (requestedLevel >= 4 && providerRouteLevel < 4) return false;
    if (requestedLevel >= 3 && providerRouteLevel < 3) return false;
  }
  if (options.allowUpwardFallback && providerRouteLevel > requestedLevel) return true;
  if (!providerRequiresAiAssessment(provider)) return true;
  const providerProfile = routingPolicy.classifyProvider(provider);
  const taskLevel = Number(profile.taskLevel || profile.level || 0);
  const contextLevel = Number(profile.contextLevel || 0);
  const costTarget = Number(profile.costTarget || profile.level || 0);
  const thinkingLevel = Number(profile.thinkingLevel || 0);
  const highRiskGate = profile.stepShape?.gate === "human_signoff" || profile.stepShape?.gate === "dry_run_first";
  const needsStrong = taskLevel >= 4 || contextLevel >= 5 || costTarget >= 4 || thinkingLevel >= 4 || highRiskGate;
  const needsMedium = taskLevel >= 3 || contextLevel >= 4 || costTarget >= 3 || thinkingLevel >= 3;
  if (providerProfile.cost_group >= 4 || providerProfile.thinking_level >= 4) {
    return needsStrong;
  }
  return needsMedium;
}

function shouldRelaxAssessmentLevelFloor(requestedModel = "", profile = {}) {
  if (String(process.env.LLM_PROXY_RELAX_ASSESSMENT_LEVEL_FLOOR || "").toLowerCase() === "true") return true;
  if (assessmentRequestedLevel(profile) < 4) return true;
  const model = String(requestedModel || "").toLowerCase();
  if (/^(auto|auto-coding|auto-tools|auto-thinking|auto-max|coding-sm)$/.test(model)) return false;
  return true;
}

function gateLargeModelProviders(providers = [], reqBody = {}, requestedModel = "", isGroup = false) {
  if (!isGroup || !isLargeAssessmentGatedGroup(requestedModel)) return providers;
  if (reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return providers;
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) return providers;
  const profile = reqBody._llmProxyDifficulty || null;
  if (isDeterministicDirectAnswerRequest(reqBody, profile)) return providers;
  let gated = providers.filter((provider) => assessmentAllowsProvider(profile, provider));
  if (profile && providers.length > 0 && gated.length === 0 && assessmentRequestedLevel(profile) >= 4) {
    gated = upwardAssessmentFallbackProviders(providers, profile);
    if (gated.length > 0) {
      state.log(`AI-ASSESS-GATE: escalated upward after filtering all level ${assessmentRequestedLevel(profile)} providers`);
    } else if (shouldRelaxAssessmentLevelFloor(requestedModel, profile)) {
      gated = providers.filter((provider) => assessmentAllowsProvider(profile, provider, { enforceLevelFloor: false }));
      if (gated.length > 0) {
        state.log(`AI-ASSESS-GATE: relaxed level floor as final fallback after filtering all level ${assessmentRequestedLevel(profile)} providers`);
      }
    } else {
      state.log(`AI-ASSESS-GATE: kept level floor after filtering all level ${assessmentRequestedLevel(profile)} providers`);
    }
  }
  const dropped = providers.length - gated.length;
  if (dropped > 0) {
    state.log(`AI-ASSESS-GATE: ${profile ? "assessment-limited" : "ungated"} large providers filtered=${dropped} kept=${gated.length}`);
  }
  return gated;
}

function groupRouteCapForFallback(groupName = "", reqBody = {}) {
  if (groupName === "auto") return null;
  const cap = state.GROUPS[groupName];
  const directNoToolTask = isDirectNoToolRequest(reqBody);
  if (cap === "text-sm" || cap === "assessment" || cap === "memory") return cap;
  return directNoToolTask ? "text" : cap;
}

function groupScoreCapForFallback(groupName = "", reqBody = {}) {
  const routeCap = groupRouteCapForFallback(groupName, reqBody);
  if (routeCap === "coding-sm" || routeCap === "text-sm") return routeCap.replace("-sm", "");
  if (routeCap === "assessment" || routeCap === "memory") return "text";
  if (routeCap) return routeCap;
  const detected = transforms.detectUseCase(reqBody?.messages, reqBody).caps;
  if (detected.has("coding")) return "coding";
  if (detected.has("thinking")) return "thinking";
  if (detected.has("images")) return "images";
  if (detected.has("tools")) return "tools";
  return "text";
}

function requestCarriesRoutedTools(reqBody = {}) {
  if (isDirectNoToolRequest(reqBody)) return false;
  return (
    (reqBody?.tools?.length || 0) > 0 ||
    (reqBody?.functions?.length || 0) > 0 ||
    requestHasToolHistory(reqBody) ||
    (reqBody?.messages || []).some((message) => message.role === "tool")
  );
}

function providerCompatibleForNearLevelFallback(provider = {}, requestedModel = "", estimatedTokens = 0, reqBody = {}, options = {}) {
  if (!provider?.name || !provider.key || provider.alive === false) return false;
  if (!options.includeCooldown && scoring.isOnCooldown(provider.name)) return false;
  if (scoring.isRecentUnresolvedChronicStalling(provider.name)) return false;
  if (scoring.isQuotaDisabled(provider.name)) return false;
  const banGroup = requestedModel === "auto" ? "auto" : requestedModel;
  if (scoring.isBannedFromGroup(provider.name, banGroup)) return false;

  const routeCap = groupRouteCapForFallback(requestedModel, reqBody);
  const detected = transforms.detectUseCase(reqBody?.messages, reqBody);
  const needsTools = routeCap === "tools" || routeCap === "coding-sm" || detected.caps.has("tools") || detected.isAgent || requestCarriesRoutedTools(reqBody);
  if (needsTools && !(provider.caps || []).includes("tools")) return false;

  const needsImages = detected.caps.has("images") || requestHasImageInput(reqBody);
  if (needsImages && !providerSupportsImageInput(provider, reqBody)) return false;

  if (estimatedTokens > 0 && !providerCanFitRoutedRequest(provider, estimatedTokens, reqBody)) return false;
  return true;
}

function nearLevelFallbackScore(provider = {}, requestedLevel = 0, requestedModel = "", reqBody = {}, stage = {}) {
  const providerLevel = routingPolicy.providerMaxRoutingLevel(provider);
  let score = scoring.providerScore(provider)
    + transforms.smartnessBonus(provider, groupScoreCapForFallback(requestedModel, reqBody), reqBody)
    + scoring.providerPolicyBonus(provider, reqBody);
  score -= Math.abs(providerLevel - requestedLevel) * 0.2;
  score += providerLevel >= requestedLevel ? 0.12 : -0.12;
  if (stage.includeCooldown) score -= 0.05;
  return score;
}

function nearLevelFallbackStages(requestedLevel = 0) {
  const stages = [];
  const add = (label, minLevel, maxLevel, includeCooldown, band) => {
    const min = Math.max(1, minLevel);
    const max = Math.min(5, maxLevel);
    if (min <= max) stages.push({ label, minLevel: min, maxLevel: max, includeCooldown, band });
  };
  add("level+1-active", requestedLevel, requestedLevel + 1, false, 1);
  add("level-1-active", requestedLevel - 1, requestedLevel - 1, false, 1);
  add("level+1-cooldown", requestedLevel, requestedLevel + 1, true, 1);
  add("level-1-cooldown", requestedLevel - 1, requestedLevel - 1, true, 1);
  add("level+2-active", requestedLevel + 2, requestedLevel + 2, false, 2);
  add("level-2-active", requestedLevel - 2, requestedLevel - 2, false, 2);
  add("level+2-cooldown", requestedLevel + 2, requestedLevel + 2, true, 2);
  add("level-2-cooldown", requestedLevel - 2, requestedLevel - 2, true, 2);
  return stages;
}

function nearLevelAssessmentFallbackProviders(requestedModel = "", reqBody = {}, estimatedTokens = 0) {
  if (!isLargeAssessmentGatedGroup(requestedModel)) return { providers: [], cleared: 0, stages: [] };
  if (reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return { providers: [], cleared: 0, stages: [] };
  const profile = reqBody._llmProxyDifficulty || routingPolicy.effectiveRequestProfile(reqBody);
  const requestedLevel = assessmentRequestedLevel(profile);
  if (requestedLevel < 4) return { providers: [], cleared: 0, stages: [] };

  const selected = [];
  const stageHits = [];
  const seen = new Set();
  let cleared = 0;
  for (const stage of nearLevelFallbackStages(requestedLevel)) {
    const candidates = (state.PROVIDERS || [])
      .filter((provider) => provider?.name && !seen.has(provider.name))
      .filter((provider) => providerCompatibleForNearLevelFallback(provider, requestedModel, estimatedTokens, reqBody, stage))
      .filter((provider) => {
        const providerLevel = routingPolicy.providerMaxRoutingLevel(provider);
        return providerLevel >= stage.minLevel && providerLevel <= stage.maxLevel;
      })
      .map((provider) => ({
        provider,
        score: nearLevelFallbackScore(provider, requestedLevel, requestedModel, reqBody, stage),
      }))
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) continue;
    stageHits.push(`${stage.label}:${candidates.length}`);
    for (const entry of candidates) {
      const provider = entry.provider;
      seen.add(provider.name);
      if (stage.includeCooldown && scoring.clearCooldown(provider.name, "near-level fallback")) {
        cleared += 1;
      }
      provider._nearLevelFallbackStage = stage.label;
      selected.push(withRoutingScore(provider, entry.score));
    }
  }
  return { providers: selected, cleared, stages: stageHits };
}

function buildAiTaskAssessmentRequest(reqBody = {}, heuristic = {}) {
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const allowedReasons = Object.keys(routingPolicy.TASK_KIND_TARGETS).join(", ");
  const recentEvidence = recentAssistantToolEvidenceForAssessment(reqBody);
  const system = [
    "You are an LLM proxy routing classifier.",
    "You are invisible to the user. Return minified JSON only, with no prose and no markdown.",
    "Schema: {\"level\":1-5,\"taskLevel\":1-5,\"contextLevel\":1-5,\"effort\":\"none|minimal|low|medium|high|xhigh\",\"speed\":1-5,\"reason\":\"one_allowed_reason\"}.",
    "taskLevel is only the current user task complexity. contextLevel is transcript/tool/cache pressure. level is max(taskLevel, contextLevel).",
    "Never raise taskLevel just because input_tokens, estimated_tokens, tools, cached IDE content, or old logs are large.",
    "The reason value must be one item from allowed_reasons; never output the literal words slug or one_allowed_reason.",
    "Classify the likely next route after the current response or tool call, anchored in the current user request.",
    "Use recent assistant/tool evidence only when it reflects progress after the current user request, including screenshot/browser/video/media failures, binary file read errors, test output, tool errors, DOM/render findings, or frame-by-frame findings.",
    "Do not classify stale assistant/tool output, cached IDE transcript, or prior proxy diagnostics as current task intent.",
    "Treat tokens like ROUTING-PROFILE, ASSESS, reason=security_review, task=security_review, shape=security, and provider names as diagnostic evidence unless the user explicitly asks for a real security review.",
  ].join("\n");
  const userParts = [
    `requested_model=${reqBody.model || "auto"}`,
    `input_tokens=${Number(reqBody._inputTokens || 0)}`,
    `estimated_tokens=${Number(reqBody._estimatedTokens || 0)}`,
    `tools=${toolCount}`,
    `allowed_reasons=${allowedReasons}`,
    "",
    "Current user message:",
    truncatedForAssessment(lastUserText(reqBody), 2200),
  ];
  if (recentEvidence) {
    userParts.push(
      "",
      "Recent assistant/tool evidence for next-route classification:",
      recentEvidence,
    );
  }
  const user = userParts.join("\n");

  return {
    model: process.env.LLM_PROXY_AI_ASSESSMENT_MODEL || "auto-assess",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: clampInt(process.env.LLM_PROXY_AI_ASSESSMENT_MAX_TOKENS, 16, 128, 48),
    stream: false,
    _llmProxyInternalAssessment: true,
    _llmProxyBypassOptimizations: true,
    _skipAISummary: true,
  };
}

function parseAiTaskAssessmentText(text = "") {
  const marker = routingPolicy.parseDifficultyMarker(text);
  if (marker) return marker;

  const raw = String(text || "").trim();
  const jsonText = raw.startsWith("{") ? raw : (raw.match(/\{[\s\S]*\}/)?.[0] || "");
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    return {
      level: parsed.level,
      effort: parsed.effort || parsed.thinkingEffort,
      speed: parsed.speed || parsed.speedTarget,
      reason: parsed.reason || parsed.taskKind || "general",
      taskKind: parsed.taskKind,
      taskLevel: parsed.taskLevel,
      contextLevel: parsed.contextLevel,
      costTarget: parsed.costTarget,
      thinkingLevel: parsed.thinkingLevel,
    };
  } catch {
    return null;
  }
}

function extractAiTaskAssessment(respBody = "") {
  try {
    const parsed = JSON.parse(respBody || "{}");
    const choice = parsed.choices?.[0] || {};
    return parseAiTaskAssessmentText(messageContentText(choice.message?.content));
  } catch {
    return parseAiTaskAssessmentText(respBody);
  }
}

function providerVia(provider = {}) {
  return String(provider.name || "").split("-")[0] || provider.family || provider.protocol || "unknown";
}

function assessmentProviderMetadata(provider = {}, assessmentReq = {}) {
  const profile = routingPolicy.classifyProvider(provider);
  const costMultiplier = routingPolicy.costMultiplierForProvider(provider);
  return {
    provider: provider.name || "unknown",
    model: provider.model || "unknown",
    upstreamModel: provider.upstream_model || provider.upstreamModel || "",
    via: providerVia(provider),
    requestedModel: assessmentReq.model || "auto-assess",
    origin: assessmentReq.origin || "hidden_call",
    context: scoring.getEffectiveContext(provider),
    costGroup: profile.cost_group,
    costMultiplier,
    qualityGroup: profile.quality_group,
    speedGroup: profile.speed_group,
    thinkingEffort: profile.thinking_effort,
    thinkingLevel: profile.thinking_level,
    temperature: assessmentReq.temperature,
    maxTokens: assessmentReq.max_tokens,
    stream: !!assessmentReq.stream,
  };
}

function attachAssessmentProviderMetadata(profile = {}, provider = {}, assessmentReq = {}) {
  return attachAssessmentMetadataObject(profile, assessmentProviderMetadata(provider, assessmentReq));
}

function attachAssessmentMetadataObject(profile = {}, metadata = {}) {
  Object.defineProperty(profile, "_assessmentProvider", {
    value: metadata,
    enumerable: false,
    configurable: true,
  });
  return profile;
}

function formatAssessmentProviderMetadataForLog(profile = {}) {
  const meta = profile._assessmentProvider;
  if (!meta) return "";
  const fields = [
    `assessor=${meta.provider || "unknown"}`,
    `assessor_model=${meta.model || "unknown"}`,
    `assessor_via=${meta.via || "unknown"}`,
    `assessor_ctx=${Number(meta.context || 0)}`,
    `assessor_cost=${meta.costGroup || "unknown"}`,
    ...(meta.costMultiplier === null || meta.costMultiplier === undefined ? [] : [`assessor_cost_multiplier=${meta.costMultiplier}`]),
    `assessor_quality=${meta.qualityGroup || "unknown"}`,
    `assessor_think=${meta.thinkingEffort || "unknown"}`,
    `assessor_speed=${meta.speedGroup || "unknown"}`,
    `assessment_model=${meta.requestedModel || "auto-assess"}`,
    `assessment_origin=${meta.origin || "hidden_call"}`,
    `assessment_temp=${meta.temperature ?? "unknown"}`,
    `assessment_max_tokens=${meta.maxTokens ?? "unknown"}`,
    `assessment_stream=${meta.stream ? "true" : "false"}`,
    ...(meta.responseProvider ? [`assessment_response_provider=${meta.responseProvider}`] : []),
  ];
  if (meta.upstreamModel) fields.splice(3, 0, `assessor_upstream_model=${meta.upstreamModel}`);
  return ` ${fields.join(" ")}`;
}

function logAssessmentProfile(profile = {}) {
  const stepShape = profile.stepShape || {};
  state.log(
    `AI-ASSESS: level=${profile.level} effort=${profile.thinkingEffort} speed=${profile.speedTarget} ` +
    `reason=${profile.reason || "none"} task=${profile.taskKind || "general"} shape=${stepShape.shape || "unknown"} ` +
    `gate=${stepShape.gate || "none"} cost=${profile.costTarget} thinking=${profile.thinkingLevel}` +
    formatContextEscalationForLog(profile) +
    formatAssessmentProviderMetadataForLog(profile),
  );
}

function assessmentProviderShortName(provider = {}) {
  return provider.name || provider.model || provider.upstream_model || provider.url || "unknown";
}

function diversifyAssessmentProviderCandidates(candidates = [], limit = 6) {
  const ordered = candidates.filter(Boolean);
  if (ordered.length <= 1) return ordered.slice(0, limit);

  const selected = [];
  const seenProviders = new Set();
  const seenSources = new Set();
  const seenModelClasses = new Set();
  const add = (provider) => {
    const providerKey = assessmentProviderShortName(provider);
    if (seenProviders.has(providerKey) || selected.length >= limit) return false;
    selected.push(provider);
    seenProviders.add(providerKey);
    const source = providerSourceKey(provider) || providerTraceSource(provider).toLowerCase();
    const modelClass = providerDiversityModelClass(provider);
    if (source) seenSources.add(source);
    if (modelClass) seenModelClasses.add(modelClass);
    return true;
  };

  add(ordered[0]);

  for (const provider of ordered) {
    const source = providerSourceKey(provider) || providerTraceSource(provider).toLowerCase();
    const modelClass = providerDiversityModelClass(provider);
    if (source && modelClass && !seenSources.has(source) && !seenModelClasses.has(modelClass)) add(provider);
  }
  for (const provider of ordered) {
    const source = providerSourceKey(provider) || providerTraceSource(provider).toLowerCase();
    if (source && !seenSources.has(source)) add(provider);
  }
  for (const provider of ordered) {
    const modelClass = providerDiversityModelClass(provider);
    if (modelClass && !seenModelClasses.has(modelClass)) add(provider);
  }
  for (const provider of ordered) add(provider);

  return selected;
}

function selectAiTaskAssessmentProviders(assessmentReq = {}) {
  const model = assessmentReq.model || "auto-assess";
  const estimated = estimateRequestInputTokens(assessmentReq) + Number(assessmentReq.max_tokens || 80);
  const limit = clampInt(process.env.LLM_PROXY_AI_ASSESSMENT_MAX_PROVIDERS, 1, 10, 6);
  if (model === "auto") {
    return diversifyAssessmentProviderCandidates(getProvidersForAuto(assessmentReq.messages, estimated, assessmentReq), limit);
  }
  if (model in state.GROUPS) {
    const candidates = getProvidersForGroup(model, estimated, assessmentReq);
    const ordered = reorderAssessmentProviders(model, candidates);
    const diversified = diversifyAssessmentProviderCandidates(ordered, limit);
    const oldTop = ordered.slice(0, Math.min(3, ordered.length)).map(assessmentProviderShortName).join(",");
    const newTop = diversified.slice(0, Math.min(3, diversified.length)).map(assessmentProviderShortName).join(",");
    if (oldTop && newTop && oldTop !== newTop) {
      state.log(`AI-ASSESS-DIVERSITY: ${model} ${oldTop} -> ${newTop}`);
    }
    return diversified;
  }
  const provider = findProviderByModel(model);
  return provider ? [provider] : [];
}

function assessmentPriceRank(provider = {}) {
  const profile = routingPolicy.classifyProvider(provider);
  const multiplier = routingPolicy.costMultiplierForProvider(provider);
  if (multiplier !== null && multiplier !== undefined) {
    if (multiplier <= 0) return 0;
    if (multiplier <= 0.1) return 1;
    if (multiplier <= 0.33) return 2;
    if (multiplier <= 0.75) return 3;
    if (multiplier <= 1) return 4;
    return 5 + Math.min(10, Math.log10(multiplier + 1));
  }
  return profile.cost_group;
}

function reorderAssessmentProviders(model, candidates = []) {
  if (state.GROUPS[model] !== "assessment") return candidates;
  const ranked = (provider) => {
    const profile = routingPolicy.classifyProvider(provider);
    return {
      provider,
      profile,
      price: assessmentPriceRank(provider),
      score: Number.isFinite(provider._lastRoutingScore) ? provider._lastRoutingScore : scoring.providerScore(provider),
    };
  };
  const rows = candidates.map(ranked);
  const lowThinking = rows.filter((row) => row.profile.thinking_level <= 2 && row.profile.cost_group <= 2);
  if (lowThinking.length === 0) return candidates;
  const bestPrice = Math.min(...lowThinking.map((row) => row.price));
  const preferred = lowThinking.filter((row) => row.price === bestPrice);
  const preferredNames = new Set(preferred.map((row) => row.provider.name));
  preferred.sort((a, b) =>
    a.price - b.price ||
    a.profile.thinking_level - b.profile.thinking_level ||
    b.profile.speed_group - a.profile.speed_group ||
    b.score - a.score
  );
  return [
    ...preferred.map((row) => row.provider),
    ...candidates.filter((provider) => !preferredNames.has(provider.name)),
  ];
}

async function requestAiTaskAssessment(reqBody = {}, heuristic = {}) {
  const assessmentReq = buildAiTaskAssessmentRequest(reqBody, heuristic);
  assessmentReq._inputTokens = estimateRequestInputTokens(assessmentReq);
  assessmentReq._estimatedTokens = assessmentReq._inputTokens + Number(assessmentReq.max_tokens || 80);
  const candidates = selectAiTaskAssessmentProviders(assessmentReq);
  if (!candidates.length) {
    state.log(`AI-ASSESS-SKIP: no provider for ${assessmentReq.model}`);
    return null;
  }

  const timeoutMs = clampInt(process.env.LLM_PROXY_AI_ASSESSMENT_TIMEOUT_MS, 500, 30000, 5000);
  for (const provider of candidates) {
    const work = routeToProvider(provider, assessmentReq, { allowAssessmentReroute: false })
      .then((resp) => ({ resp }))
      .catch((error) => ({ error }));
    const timed = await Promise.race([
      work,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
    ]);

    if (timed.timeout) {
      state.log(`AI-ASSESS-SKIP: ${provider.name} timed out after ${timeoutMs}ms`);
      work.catch(() => {});
      continue;
    }
    if (timed.error) {
      state.log(`AI-ASSESS-SKIP: ${provider.name} failed: ${timed.error.message || timed.error.body || timed.error.status || "unknown"}`);
      continue;
    }

    const assessment = extractAiTaskAssessment(timed.resp?.body || "");
    if (!assessment) {
      state.log(`AI-ASSESS-SKIP: ${provider.name} returned unparsable assessment`);
      continue;
    }
    const profile = routingPolicy.profileFromTrustedTaskAssessment(reqBody, assessment);
    return attachAssessmentProviderMetadata(profile, provider, assessmentReq);
  }
  return null;
}

async function applyAiTaskAssessmentIfNeeded(reqBody = {}, requestedModel = "", isGroup = false, assessmentOptions = {}) {
  const heuristic = assessmentOptions.heuristic || routingPolicy.assessRequestDifficulty(reqBody.messages || [], reqBody);
  const shouldAssess = typeof assessmentOptions.shouldAssess === "boolean"
    ? assessmentOptions.shouldAssess
    : shouldUseAiTaskAssessment(reqBody, requestedModel, isGroup, heuristic);
  if (!shouldAssess) return null;
  const profile = await requestAiTaskAssessment(reqBody, heuristic);
  if (!profile) return null;
  if (isHighRiskRoutingProfile(profile) && !currentUserSupportsHighRiskProfile(reqBody, profile)) {
    state.log(`AI-ASSESS-DROP: unsupported high-risk assessment task=${profile.taskKind || "general"} for current user message`);
    return null;
  }
  reqBody._llmProxyDifficulty = profile;
  logAssessmentProfile(profile);
  return profile;
}

function cachePostRouteAssessment(reqBody = {}, provider = {}, markerProfile = null, stream = false, origin = "post_route") {
  if (!markerProfile || reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return null;
  let session;
  try { session = memory.getSession(reqBody.messages); } catch { session = null; }
  if (!session?.id) return null;

  const cachedProfile = { ...markerProfile };
  const requestMeta = {
    model: origin === "post_route_fallback" ? "post-route-fallback" : "post-route",
    origin,
    temperature: 0,
    max_tokens: 0,
    stream,
  };
  if (origin === "post_route_fallback" && markerProfile._assessmentProvider) {
    attachAssessmentMetadataObject(cachedProfile, {
      ...markerProfile._assessmentProvider,
      requestedModel: requestMeta.model,
      origin,
      temperature: requestMeta.temperature,
      maxTokens: requestMeta.max_tokens,
      stream,
      responseProvider: provider.name || "unknown",
    });
  } else {
    attachAssessmentProviderMetadata(cachedProfile, provider, requestMeta);
  }
  state.sessionAssessmentCache[session.id] = {
    profile: cachedProfile,
    timestamp: Date.now(),
    lastUserText: lastUserText(reqBody),
    provider: provider.name || "unknown",
    origin,
    messageCount: assessmentCacheMessageCount(reqBody),
    transcriptFingerprint: assessmentCacheFingerprint(reqBody),
  };
  recordPostRouteAssessmentTrace(reqBody, provider, cachedProfile, origin, stream);
  state.log(`AI-ASSESS-CACHE: stored ${origin === "post_route_fallback" ? "fallback " : ""}post-route assessment from ${provider.name || "unknown"} for session ${session.id}`);
  return cachedProfile;
}

function assessmentCacheMaxHits(env = process.env) {
  return clampInt(env.LLM_PROXY_ASSESSMENT_CACHE_MAX_HITS, 0, 100, 3);
}

function assessmentCacheProfileKey(profile = {}) {
  const stepShape = profile.stepShape || {};
  return [
    profile.taskKind || "general",
    profile.taskLevel || profile.level || 3,
    profile.contextLevel || profile.level || 3,
    profile.thinkingLevel || profile.thinkingEffort || profile.effort || "",
    stepShape.shape || "",
    stepShape.gate || "",
    stepShape.posture || "",
  ].join("|");
}

function applyCachedPostRouteAssessmentIfAvailable(reqBody = {}, requestedModel = "", isGroup = false) {
  if (!isGroup || reqBody._llmProxyDifficulty || reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return null;
  let session;
  try { session = memory.getSession(reqBody.messages); } catch { session = null; }
  const entry = session?.id ? state.sessionAssessmentCache[session.id] : null;
  if (!entry?.profile) return null;

  const ageMs = Date.now() - Number(entry.timestamp || 0);
  const currentUserText = lastUserText(reqBody);
  if (ageMs > 600_000 || (entry.lastUserText && entry.lastUserText !== currentUserText)) {
    delete state.sessionAssessmentCache[session.id];
    if (state.sessionAssessmentCacheStats) delete state.sessionAssessmentCacheStats[session.id];
    state.log(`AI-ASSESS-CACHE-DROP: stale post-route assessment for session ${session.id}`);
    return null;
  }
  if (isHighRiskRoutingProfile(entry.profile) && !currentUserSupportsHighRiskProfile(reqBody, entry.profile)) {
    delete state.sessionAssessmentCache[session.id];
    if (state.sessionAssessmentCacheStats) delete state.sessionAssessmentCacheStats[session.id];
    state.log(`AI-ASSESS-CACHE-DROP: stale high-risk post-route assessment for session ${session.id}`);
    return null;
  }

  const maxHits = assessmentCacheMaxHits(process.env);
  const profileKey = assessmentCacheProfileKey(entry.profile);
  const stats = state.sessionAssessmentCacheStats?.[session.id] || { hits: 0, profileKey };
  if (stats.profileKey !== profileKey) {
    stats.hits = 0;
    stats.profileKey = profileKey;
  }
  if (maxHits > 0 && stats.hits >= maxHits && !isHighRiskRoutingProfile(entry.profile)) {
    delete state.sessionAssessmentCache[session.id];
    state.sessionAssessmentCacheStats[session.id] = {
      ...stats,
      hits: 0,
      droppedAt: Date.now(),
    };
    state.log(`AI-ASSESS-CACHE-DROP: repeat limit for session ${session.id} hits=${stats.hits} max=${maxHits}`);
    return null;
  }

  delete state.sessionAssessmentCache[session.id];
  stats.hits += 1;
  stats.lastHitAt = Date.now();
  state.sessionAssessmentCacheStats[session.id] = stats;
  reqBody._llmProxyDifficulty = entry.profile;
  state.log(`AI-ASSESS-CACHE-HIT: session ${session.id} provider=${entry.provider || "unknown"} age_ms=${ageMs} hits=${stats.hits}`);
  logAssessmentProfile(entry.profile);
  return entry.profile;
}

async function prepareNonStreamingRequest(provider, reqBody) {
  const body = await transforms.transformRequest(provider, reqBody);
  body.stream = false; // force non-streaming
  delete body.stream_options; // stream_options invalid when stream=false
  return body;
}

function dedupeConsecutiveIdempotentToolCalls(reqBody = {}) {
  const messages = reqBody.messages || [];
  if (messages.length < 4) return 0;

  const idempotentToolRe = /^(read|glob|grep|search|find|ripgrep|rg|cat|file|notebookread|list_dir|view_file)$/i;
  const calls = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== "assistant" || msg.tool_calls?.length !== 1) continue;
    const toolCall = msg.tool_calls[0];
    const name = toolCall.function?.name || "";
    if (!idempotentToolRe.test(name)) continue;
    const key = `${name}:${toolCall.function?.arguments || ""}`;
    let responseIdx = -1;
    for (let j = i + 1; j < messages.length && j <= i + 3; j += 1) {
      if (messages[j].role === "tool" && messages[j].tool_call_id === toolCall.id) {
        responseIdx = j;
        break;
      }
    }
    calls.push({ idx: i, key, responseIdx });
  }

  const toRemove = new Set();
  for (let i = 0; i < calls.length - 1; i += 1) {
    if (calls[i].key !== calls[i + 1].key) continue;
    let onlyToolsBetween = true;
    const gapStart = Math.max(calls[i].idx, calls[i].responseIdx) + 1;
    const gapEnd = calls[i + 1].idx;
    for (let j = gapStart; j < gapEnd; j += 1) {
      if (messages[j].role !== "tool") {
        onlyToolsBetween = false;
        break;
      }
    }
    if (!onlyToolsBetween) continue;
    toRemove.add(calls[i].idx);
    if (calls[i].responseIdx >= 0) toRemove.add(calls[i].responseIdx);
  }

  if (toRemove.size === 0) return 0;
  const removedKeys = new Set(calls.filter((call) => toRemove.has(call.idx)).map((call) => call.key));
  reqBody.messages = messages.filter((_, idx) => !toRemove.has(idx));
  state.log(`CONSEC-DEDUP-EARLY: removed ${toRemove.size} consecutive identical read calls (${[...removedKeys].map((key) => {
    const [name, ...rest] = key.split(":");
    return `${name}(args=${rest.join(":").length}ch)`;
  }).join(",")})`);
  return toRemove.size;
}

async function routeOpenAICompatibleProvider(provider, reqBody) {
  const body = providerAdapters.prepareOpenAICompatibleRequest(provider, reqBody, false);
  const bodyStr = JSON.stringify(body);
  const headers = await transforms.buildRuntimeHeaders(provider);
  return makeRequest(provider.url, { method: "POST", headers }, bodyStr);
}

async function routeToProvider(provider, reqBody, options = {}) {
  const body = await prepareNonStreamingRequest(provider, reqBody);
  const validationReq = responseValidationRequest(reqBody, body);
  const toolParsingReq = hasToolAccess(validationReq) ? validationReq : reqBody;
  const bodyStr = JSON.stringify(body);
  const start = Date.now();

  if (state.DEV_MODE) {
    state.log(`DEV-REQ: ${provider.name} (${provider.model}) ctx=${scoring.getEffectiveContext(provider)} body=${bodyStr.length}chars msgs=${body.messages?.length}`);
    try { fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-request.json"), bodyStr); } catch {}
  }

  const resp = await providerAdapters.routeNonStreaming(provider, body, routeOpenAICompatibleProvider);
  const latency = Date.now() - start;

  if (state.DEV_MODE) {
    state.log(`DEV-RESP: ${provider.name} status=${resp.status} ${latency}ms body=${(resp.body || "").length}chars`);
    try { fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-response.json"), resp.body || ""); } catch {}
  }

  if (resp.status >= 400) {
    const errPreview = (resp.body || "").substring(0, 200);
    state.log(`FAIL: ${provider.name} status=${resp.status}  ${errPreview}`);
    const toolCount = (validationReq.tools?.length || 0) + (validationReq.functions?.length || 0);
    state.log(`API-ERROR: ${provider.name} status=${resp.status} model=${provider.model} tools=${toolCount} messages=${body.messages?.length || 0} body=${errPreview}`);
    if (scoring.isQuotaExhaustedError(resp.status, resp.body)) {
      scoring.disableProviderQuota(provider.name, `HTTP ${resp.status}: quota/billing error`);
    }
    if (scoring.isTemporaryRateLimit(resp.status, resp.body)) {
      scoring.setCooldown(provider.name, 60 * 60_000, `rate limit HTTP ${resp.status}`);
    } else if (resp.status === 502 || resp.status === 504 || /timeout|idle/i.test(resp.body)) {
      scoring.setCooldown(provider.name, undefined, `HTTP ${resp.status} gateway/timeout`);
    }
    scoring.detectIncompatibility(provider.name, resp.status, resp.body, {
      inputTokens: validationReq._inputTokens,
      estimatedTokens: validationReq._estimatedTokens,
      providerContext: scoring.getEffectiveContext(provider),
      hasTools: toolCount > 0,
      hasToolHistory: requestHasToolHistory(validationReq),
      hasImages: requestHasImageInput(validationReq),
      hasDataImages: requestHasDataImageInput(validationReq),
      compactedContext: requestHasCompactedContext(validationReq),
    });
    try { memory.saveError(memory.getSession(reqBody.messages), errPreview); } catch {}
    throw { status: resp.status, body: resp.body, latency, logged: true };
  }

    // Unwrap compatibility-wrapper responses shaped as {"data": {...}, "success": true}.
  try {
    const wrapped = JSON.parse(resp.body);
    if (wrapped.data?.choices && wrapped.success !== undefined) {
      resp.body = JSON.stringify(wrapped.data);
    }
    // Also handle {"error": "...", "success": false}
    if (wrapped.success === false && wrapped.error) {
      throw { status: 502, body: resp.body, latency };
    }
  } catch (e) {
    if (e.status) throw e; // re-throw our own errors
  }

  // Validate response is OpenAI-compatible (has choices array)
  try {
    const parsed = JSON.parse(resp.body);
    if (!parsed.choices || !Array.isArray(parsed.choices)) {
      // Provider likely only supports streaming — mark stream_only
      const c = scoring.getCompat(provider.name);
      if (!c.stream_only) { c.stream_only = true; scoring.saveCompat(); state.log(`COMPAT: ${provider.name} → stream_only (no choices in response)`); }
      throw { status: 502, body: resp.body, latency };
    }
  } catch (e) {
    if (e.status) throw e;
    const c = scoring.getCompat(provider.name);
    if (!c.stream_only) { c.stream_only = true; scoring.saveCompat(); state.log(`COMPAT: ${provider.name} → stream_only (unparseable non-stream response)`); }
    throw { status: 502, body: resp.body, latency };
  }

  const imitatedToolText = normalizeImitatedToolCallResponse(resp.body, toolParsingReq, provider);
  if (imitatedToolText.invalid) {
    state.log(`TOOL-TEXT-INVALID: ${provider.name} ${imitatedToolText.invalid} — reroute`);
    scoring.recordToolInvalid(provider.name, imitatedToolText.invalid);
    scoring.recordFailure(provider.name, imitatedToolText.invalid);
    throw { status: 422, body: imitatedToolText.invalid, latency, logged: true, failureRecorded: true };
  }
  if (imitatedToolText.changed) {
    resp.body = imitatedToolText.body;
    state.log(`TOOL-TEXT-NORMALIZE: ${provider.name} converted ${imitatedToolText.count} text tool call(s)`);
  }

  const invalidTool = validateGeneratedToolCalls(resp.body, toolParsingReq);
  if (invalidTool) {
    state.log(`TOOL-INVALID: ${provider.name} ${invalidTool} — reroute`);
    scoring.recordToolInvalid(provider.name, invalidTool);
    scoring.recordFailure(provider.name, invalidTool);
    scoring.setCooldown(provider.name, 300_000, "invalid tool arguments");
    throw { status: 422, body: invalidTool, latency, logged: true, failureRecorded: true };
  }

  let postRouteMarkerProfile = null;
  const markerResult = routingPolicy.stripDifficultyMarkerFromResponseBody(resp.body);
  if (markerResult.changed) {
    resp.body = markerResult.body;
  }
  if (markerResult.marker) {
    const markerProfile = routingPolicy.profileFromAssessmentMarker(reqBody, markerResult.marker);
    postRouteMarkerProfile = markerProfile;
    const providerRouteLevel = routingPolicy.providerMaxRoutingLevel(provider);
    state.log(
      `ASSESS: ${provider.name} route_level=${providerRouteLevel} request_level=${markerProfile.level} effort=${markerProfile.thinkingEffort} speed=${markerProfile.speedTarget} ` +
      `reason=${markerProfile.reason || "none"} task=${markerProfile.taskKind || "general"} cost=${markerProfile.costTarget} thinking=${markerProfile.thinkingLevel}`,
    );
    try {
      const parsed = JSON.parse(resp.body);
      const choice = parsed.choices?.[0] || null;
      const textContent = messageContentText(choice?.message?.content);
      const hasToolCalls = (choice?.message?.tool_calls?.length || 0) > 0;
      if (!hasToolCalls && textContent.trim().length === 0) {
        cachePostRouteAssessment(reqBody, provider, markerProfile, false, "post_route_marker_only");
        scoring.recordStalling(provider.name);
        state.log(`MARKER-ONLY: ${provider.name} returned assessment without assistant content — cached for next route and reroute`);
        throw { status: 422, body: resp.body, latency, stalling: true, logged: true };
      }
      if (
        !hasToolCalls &&
        routingPolicy.shouldRerouteForMarker(provider, markerResult.marker, reqBody) &&
        looksLikeAssessmentRerouteOnly(textContent)
      ) {
        state.log(
          `REROUTE-ASSESS: ${provider.name} compact marker requested stronger route ` +
          `level=${markerProfile.level} effort=${markerProfile.thinkingEffort} speed=${markerProfile.speedTarget}`,
        );
        throw {
          status: 409,
          body: "assessment requested reroute",
          latency,
          rerouteAssessment: markerResult.marker,
          rerouteProfile: markerProfile,
          logged: true,
        };
      }
    } catch (e) {
      if (e.status) throw e;
    }
    // A usable response keeps flowing to the client; the marker is a next-route hint.
    // Marker-only responses are handled above as stalling and can still fail over.
  }

  const memoryMarkerResult = stripHiddenMemoryMarkersFromResponseBody(resp.body);
  if (memoryMarkerResult.changed) {
    resp.body = memoryMarkerResult.body;
    if (memoryMarkerResult.memoryOps.length > 0) {
      reqBody._memoryOps = [...(reqBody._memoryOps || []), ...memoryMarkerResult.memoryOps];
      try { memory.applyMemoryOps(memory.getSession(reqBody.messages), reqBody, memoryMarkerResult.memoryOps); } catch {}
      state.log(`MEMORY-MARKER: ${provider.name} ops=${memoryMarkerResult.memoryOps.map((op) => op.op).join(",")}`);
    }
    if (memoryMarkerResult.recall) {
      state.log(`RECALL-MARKER: ${provider.name} q="${memoryMarkerResult.recall.query.substring(0, 80)}" reason=${memoryMarkerResult.recall.reason}`);
      throw {
        status: 409,
        body: "memory recall requested",
        latency,
        memoryRecall: memoryMarkerResult.recall,
        logged: true,
      };
    }
  }

  const proxyArtifactResult = stripProxyArtifactLinesFromResponseBody(resp.body);
  if (proxyArtifactResult.changed) {
    resp.body = proxyArtifactResult.body;
    state.log(`PROXY-RESP-STRIP: ${provider.name} removed cached proxy artifact text`);
    if (proxyArtifactResult.artifactOnly) {
      scoring.recordStalling(provider.name);
      throw { status: 422, body: "proxy artifact-only response", latency, stalling: true, logged: true };
    }
  }

  try {
    const parsed = JSON.parse(resp.body);
    const choice = parsed.choices?.[0] || null;
    const textContent = messageContentText(choice?.message?.content);
    const hasToolCalls = (choice?.message?.tool_calls?.length || 0) > 0;
    const visibleIdentityProbe = !reqBody._llmProxyInternalAssessment && !reqBody._llmProxyInternalSummary;
    if (choice && visibleIdentityProbe && asksIdentityQuestion(reqBody) && !hasToolCalls && textContent.trim().length > 0 && !isProxyIdentityAnswer(textContent)) {
      scoring.recordStalling(provider.name);
      state.log(`IDENTITY-MISMATCH: ${provider.name} responded with non-proxy identity — reroute`);
      throw { status: 422, body: "non-proxy identity answer", latency, stalling: true, logged: true };
    }
  } catch (e) {
    if (e.status) throw e;
  }

  // Stalling detection — model says "Let me check" and stops without acting
  if (validationReq?.tools?.length > 0 || validationReq?.functions?.length > 0) {
    let choice = null;
    let textContent = "";
    let hasToolCalls = false;
    let textOnlyAllowed = false;
    try {
      const parsed = JSON.parse(resp.body);
      choice = parsed.choices?.[0] || null;
      textContent = messageContentText(choice?.message?.content);
      hasToolCalls = (choice?.message?.tool_calls?.length || 0) > 0;
      textOnlyAllowed = allowsTextOnlyAnswer(validationReq, textContent, markerResult.marker);
    } catch {}

    if (choice && !hasToolCalls && canUseHiddenContinuationForOutput(validationReq, textContent)) {
      state.log(`HIDDEN-CONTINUE: ${provider.name} returned inert continuation; appending hidden user continue`);
      throw {
        status: 422,
        body: "inert continuation",
        latency,
        logged: true,
        hiddenContinuation: true,
        continuationText: textContent.trim(),
      };
    }

    if (choice && !hasToolCalls && shouldContinuePrematureToolWork(validationReq, textContent, markerResult.marker)) {
      state.log(`HIDDEN-CONTINUE-PROGRESS: ${provider.name} returned short tool-work progress; appending hidden user continue`);
      throw {
        status: 422,
        body: "text-only progress without tool call",
        latency,
        logged: true,
        hiddenContinuation: true,
        continuationText: textContent.trim(),
      };
    }

    if (!textOnlyAllowed) {
      const stallingDetected = transforms.detectStalling(resp.body);
      if (stallingDetected) {
        scoring.recordStalling(provider.name);
        throw { status: 422, body: "stalling response", latency, stalling: true, logged: true };
      }
    }

    if (choice && textOnlyAllowed && !hasToolCalls && textContent.length > 20 && validationReq.tools?.length > 0) {
      state.log(`TEXT-ONLY-OK: ${provider.name} accepted text response (${textContent.length} chars) with ${validationReq.tools.length} tools available`);
    }

    // Text-only response when tools are available means the provider is a poor fit
    // for agent requests; fail over before the IDE treats it as progress.
    if (choice && !textOnlyAllowed && !hasToolCalls && textContent.length > 20) {
      scoring.recordStalling(provider.name);
      state.log(`NO-TOOLS: ${provider.name} responded with text-only (${textContent.length} chars) when ${validationReq.tools?.length || 0} tools available — stalling+retry`);
      throw { status: 422, body: "text-only response with required tools", latency, stalling: true, logged: true };
    }
  }

  // Detect garbled output in non-streaming response
  try {
    const parsed = JSON.parse(resp.body);
    const message = parsed.choices?.[0]?.message || {};
    const content = messageContentText(message.content) + (message.reasoning || "") + (message.reasoning_content || "");
    const garbled = content.length > 30 &&
      !isStructuredJsonResponseBody(resp.body, validationReq) &&
      compaction.detectGarbledText(content);
    if (garbled && !looksLikeCoherentGarbleFalsePositive(content)) {
      state.log(`GARBLE-DETECTED: ${provider.name} content="${content.substring(0, 100)}..."`);
      scoring.recordFailure(provider.name, "garbled output");
      scoring.setCooldown(provider.name, 3600_000, "garbled output");
      throw { status: 502, body: resp.body, latency, garbled: true, failureRecorded: true };
    } else if (garbled) {
      state.log(`GARBLE-SKIP: ${provider.name} accepted coherent diagnostic text despite repeated phrases`);
    }
  } catch (e) { if (e.garbled) throw e; }

  const normalized = normalizeZeroUsage(resp.body, body);
  resp.body = normalized.body;

  scoring.recordSuccess(provider.name, latency);
  scoring.recordPolicyUse(provider);
  const cacheProfile = postRouteMarkerProfile || reqBody._llmProxyDifficulty || null;
  if (cacheProfile) {
    cachePostRouteAssessment(
      reqBody,
      provider,
      cacheProfile,
      false,
      postRouteMarkerProfile ? "post_route" : "post_route_fallback",
    );
  }

  // Extract usage stats from response
  let usage = normalized.usage;
  if (!usage) {
    try {
      const parsed = JSON.parse(resp.body);
      usage = parsed.usage || null;
    } catch {}
  }
  const cachedTokens = cachedInputTokensFromUsage(usage);
  const usageStr = usage
    ? ` usage[in=${usage.prompt_tokens||0} out=${usage.completion_tokens||0} total=${usage.total_tokens||0}${cachedTokens ? ` cached=${cachedTokens}` : ""}]`
    : "";
  state.log(`OK: ${provider.name} ${latency}ms${usageStr}`);

  // Track provider-level usage from response
  {
    const sid = memory.getSession(reqBody.messages).id;
    const inTok = usage?.prompt_tokens || estimateRequestInputTokens(body);
    const outTok = usage?.completion_tokens || 0;
    _trackSessionTokens(sid, inTok, outTok, provider.name);
    recordCachedInputTokens(sid, provider.name, cachedTokens);
    recordRouteDiversityUse(reqBody, provider.name);
  }

  // Session affinity — remember which provider worked
  try { memory.setLastProvider(memory.getSession(reqBody.messages), provider.name); } catch {}
  // Track in sessionStats for reliable cross-request lookups
  try { const sid = memory.getSession(reqBody.messages).id; if (state.sessionStats[sid]) state.sessionStats[sid].lastProvider = provider.name; } catch {}

  // Memory: save after successful response
  try {
    const s = memory.getSession(reqBody.messages);
    reqBody._servedProvider = provider.name;
    memory.triggerSaves(s, reqBody, resp.body);
  } catch { /* graceful degradation */ }

  // Thinking detection
  if (provider.tc && transforms.detectThinking(resp.body)) {
    scoring.recordThinkingOk(provider.name);
  }

  return resp;
}

function createStreamDifficultyMarkerFilter(providerName, onMarker, onMemoryMarker, onRecallMarker) {
  let pending = "";
  let trailingPending = "";
  let decided = false;
  let logged = false;
  let proxyArtifactLogged = false;
  let suppressOrphanMarkerTails = false;
  const memoryMarkerRe = /^\s*\[?\s*LLM_PROXY_(?:MEMORY|RECALL)\b[^\r\n]*(?:\]?\s*)?(?:\r?\n|$)/i;
  const markerPrefixes = ["LLM_PROXY_INTERNAL_ROUTING", "LLM_PROXY_TASK_DIFFICULTY", "LLM_PROXY_MEMORY", "LLM_PROXY_RECALL"];

  function maybeMarkerPrefix(text) {
    const trimmed = String(text || "").trimStart();
    if (!trimmed) return true;
    const upper = trimmed.replace(/^\[\s*/, "").toUpperCase();
    if (markerPrefixes.some((prefix) => prefix.startsWith(upper))) return true;
    if (routingPolicy.maybeLegacyBareDifficultyMarkerFragment(trimmed)) return true;
    return /^\[?\s*LLM_PROXY_(?:INTERNAL_ROUTING|TASK_DIFFICULTY|MEMORY|RECALL)\b/i.test(trimmed) && !/[\r\n]/.test(trimmed) && trimmed.length < 320;
  }

  function difficultyMarkerMatchIsComplete(match, text = "") {
    if (!match) return false;
    const markerText = match[0] || "";
    if (!markerText) return false;
    if (markerText.length < String(text || "").length) return true;
    if (/[\r\n]/.test(markerText)) return true;
    if (/\]\s*$/.test(markerText)) return true;
    return /\s$/.test(markerText);
  }

  function maybePrivateMarkerFragment(text = "") {
    const trimmed = String(text || "").trimStart().replace(/^\[\s*/, "");
    if (!trimmed) return true;
    const upper = trimmed.toUpperCase();
    if (markerPrefixes.some((prefix) => prefix.startsWith(upper) || upper.startsWith(prefix))) return true;
    if (routingPolicy.maybeLegacyBareDifficultyMarkerFragment(trimmed)) return true;
    return /^\s*LLM_PROXY_(?:INTERNAL_ROUTING|TASK_DIFFICULTY)\b[^\r\n]*$/i.test(trimmed);
  }

  function emitMemoryResults(result) {
    const markers = Array.isArray(result.memories) && result.memories.length > 0
      ? result.memories
      : (result.memory ? [result.memory] : []);
    for (const marker of markers) {
      if (typeof onMemoryMarker === "function") {
        try { onMemoryMarker(marker); } catch {}
      }
    }
    if (result.recall && typeof onRecallMarker === "function") {
      try { onRecallMarker(result.recall); } catch {}
    }
  }

  function stripPrivateMarkers(text) {
    if (suppressOrphanMarkerTails && routingPolicy.isOrphanReasonContinuationLine(text)) return "";
    const difficultyResult = routingPolicy.stripDifficultyMarkerFromText(text);
    if (difficultyResult.marker && typeof onMarker === "function") {
      try { onMarker(difficultyResult.marker); } catch {}
    }
    if (difficultyResult.changed && !logged) {
      state.log(`ASSESS-STREAM: ${providerName} stripped private difficulty marker`);
      logged = true;
    }
    const memoryResult = hiddenMemoryMarkers.stripHiddenMemoryMarkers(difficultyResult.content);
    if (memoryResult.content !== difficultyResult.content || memoryResult.recall || memoryResult.memory || (memoryResult.memories || []).length > 0) {
      emitMemoryResults(memoryResult);
      if (!logged) {
        state.log(`MEMORY-STREAM: ${providerName} stripped private memory marker`);
        logged = true;
      }
    }
    const artifactResult = stripProxyArtifactLines(memoryResult.content);
    const finalText = artifactResult.changed ? artifactResult.text : memoryResult.content;
    if (artifactResult.changed && !proxyArtifactLogged) {
      state.log(`PROXY-RESP-STREAM-STRIP: ${providerName} removed cached proxy artifact text`);
      proxyArtifactLogged = true;
    }
    suppressOrphanMarkerTails = difficultyResult.changed && !String(finalText || "").trim();
    if (!difficultyResult.changed && String(finalText || "").trim()) suppressOrphanMarkerTails = false;
    return finalText;
  }

  function stripBufferedPrivateMarkers(text, flush = false) {
    trailingPending += String(text || "");
    let output = "";

    while (true) {
      const newlineIndex = trailingPending.search(/\r?\n/);
      if (newlineIndex < 0) break;
      const newlineLength = trailingPending[newlineIndex] === "\r" ? 2 : 1;
      const line = trailingPending.slice(0, newlineIndex + newlineLength);
      trailingPending = trailingPending.slice(newlineIndex + newlineLength);
      if (suppressOrphanMarkerTails && (!line.trim() || routingPolicy.isOrphanReasonContinuationLine(line))) {
        continue;
      }
      output += stripPrivateMarkers(line);
    }

    if (trailingPending) {
      if (suppressOrphanMarkerTails && (!trailingPending.trim() || routingPolicy.isOrphanReasonContinuationLine(trailingPending))) {
        if (flush) trailingPending = "";
        return output;
      }
      if (flush || !maybePrivateMarkerFragment(trailingPending)) {
        output += stripPrivateMarkers(trailingPending);
        trailingPending = "";
      }
    }

    return output;
  }

  function filterContent(content, flush = false) {
    if (decided) return stripBufferedPrivateMarkers(content, flush);
    pending += content;
    const markerMatch = routingPolicy.matchDifficultyMarkerText(pending);
    if (difficultyMarkerMatchIsComplete(markerMatch, pending)) {
      decided = true;
      const marker = routingPolicy.parseDifficultyMarker(markerMatch[0]);
      const split = routingPolicy.splitAttachedUppercaseFromMarkerText(markerMatch[0]);
      const visible = (split.attachedText + pending.slice(markerMatch[0].length)).replace(/^[\s:;,\-.]+/, "").trimStart();
      pending = "";
      suppressOrphanMarkerTails = !visible.trim();
      if (!logged) {
        state.log(`ASSESS-STREAM: ${providerName} stripped private difficulty marker`);
        logged = true;
      }
      if (marker && typeof onMarker === "function") {
        try { onMarker(marker); } catch {}
      }
      return visible;
    }
    const malformedMarkerMatch = pending.match(/^\s*LLM_PROXY_(?:INTERNAL_ROUTING|TASK_DIFFICULTY)\b[^\r\n]*(?:\r?\n|$)/i);
    if (malformedMarkerMatch && /[\r\n]/.test(pending)) {
      decided = true;
      const visible = pending.slice(malformedMarkerMatch[0].length).trimStart();
      pending = "";
      suppressOrphanMarkerTails = !visible.trim();
      if (!logged) {
        state.log(`ASSESS-STREAM: ${providerName} stripped malformed private difficulty marker`);
        logged = true;
      }
      return visible;
    }
    const memoryMarkerMatch = pending.match(memoryMarkerRe);
    if (memoryMarkerMatch) {
      decided = true;
      const result = hiddenMemoryMarkers.stripHiddenMemoryMarkers(pending);
      pending = "";
      if (!logged) {
        state.log(`MEMORY-STREAM: ${providerName} stripped private memory marker`);
        logged = true;
      }
      emitMemoryResults(result);
      return result.content;
    }
    if (flush) {
      decided = true;
      const visible = stripPrivateMarkers(pending);
      pending = "";
      return visible;
    }
    if (pending.length > 320 || !maybeMarkerPrefix(pending)) {
      decided = true;
      const visible = pending;
      pending = "";
      return visible;
    }
    return "";
  }

  function emptyContentOnlyDelta(parsed) {
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta;
    if (!delta || delta.content !== "" || choice.finish_reason) return false;
    return Object.keys(delta).length === 1;
  }

  function contentSseChunk(content) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}`;
  }

  return function filterSseChunk(chunkText, flush = false) {
    const out = [];
    if (flush) {
      const flushed = filterContent("", true);
      if (flushed) out.push(contentSseChunk(flushed));
      return out.join("\n");
    }
    for (const line of String(chunkText).split("\n")) {
      if (!line.startsWith("data: ")) {
        out.push(line);
        continue;
      }
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") {
        if (data === "[DONE]") {
          const flushed = filterContent("", true);
          if (flushed) out.push(contentSseChunk(flushed));
        }
        out.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (typeof delta?.content === "string") {
          delta.content = filterContent(delta.content);
          if (emptyContentOnlyDelta(parsed)) continue;
          out.push(`data: ${JSON.stringify(parsed)}`);
          continue;
        }
        if (parsed.choices?.[0]?.finish_reason) {
          const flushed = filterContent("", true);
          if (flushed) out.push(contentSseChunk(flushed));
        }
      } catch {}
      out.push(line);
    }
    return out.join("\n");
  };
}

// ---------------------------------------------------------------------------
// Route streaming request to a provider
// ---------------------------------------------------------------------------
async function routeStreamToProvider(provider, reqBody, clientRes) {
  const transformedBody = await transforms.transformRequest(provider, reqBody);
  const validationReq = responseValidationRequest(reqBody, transformedBody);
  const toolParsingReq = hasToolAccess(validationReq) ? validationReq : reqBody;
  const body = providerAdapters.prepareOpenAICompatibleRequest(provider, transformedBody, true);
  const bodyStr = JSON.stringify(body);
  const headers = await transforms.buildRuntimeHeaders(provider);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    if (state.DEV_MODE) {
      state.log(`DEV-STREAM-REQ: ${provider.name} (${provider.model}) ctx=${scoring.getEffectiveContext(provider)} body=${bodyStr.length}chars msgs=${body.messages?.length}`);
      try { fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-request.json"), bodyStr); } catch {}
    }
    let headersSent = false;

    let dataChunks = 0;
    let hasToolCallsInStream = false;
    const buffered = [];
    let lastChunkTime = Date.now();

    // Watchdog: kill stream if no data for 90s
    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkTime > 90_000) {
        clearInterval(watchdog);
        state.log(`STREAM-STALE: ${provider.name} no data for 90s, killing`);
        try { streamReq?.destroy(); } catch {}
      }
    }, 10_000);

    let streamedContent = ""; // accumulate content for garble detection
    let streamedVisibleContent = "";
    let lastDataChunk = ""; // keep last SSE data for usage extraction
    let streamLoopAborted = false;
    let streamRejected = false;
    let streamAssessmentMarker = null;
    let streamMemoryRecall = null;
    const streamMemoryOps = [];
    const filterDifficultyMarker = createStreamDifficultyMarkerFilter(
      provider.name,
      (marker) => { streamAssessmentMarker = marker; },
      (marker) => { streamMemoryOps.push(marker); },
      (marker) => { streamMemoryRecall = marker; },
    );
    const streamToolCalls = createStreamToolCallAccumulator(toolParsingReq);

    function rejectInvalidStreamToolCall(invalidTool) {
      if (streamRejected) return;
      streamRejected = true;
      streamLoopAborted = true;
      clearInterval(watchdog);
      state.log(`TOOL-INVALID-STREAM: ${provider.name} ${invalidTool} — rejecting before flush`);
      scoring.recordToolInvalid(provider.name, invalidTool);
      scoring.recordFailure(provider.name, invalidTool);
      scoring.setCooldown(provider.name, 300_000, "invalid streamed tool arguments");
      if (headersSent) {
        try { clientRes.write("data: [DONE]\n\n"); } catch {}
        try { clientRes.end(); } catch {}
        reject({ error: new Error(invalidTool), statusCode: 422, headersSent: true, latency: Date.now() - start });
      } else {
        try { streamReq?.destroy?.(); } catch {}
        reject({ error: new Error(invalidTool), statusCode: 422, headersSent: false, latency: Date.now() - start });
      }
    }

    const streamReq = streamRequest(
      provider.url,
      { method: "POST", headers },
      bodyStr,
      (chunk) => {
        lastChunkTime = Date.now();
        const text = filterDifficultyMarker(chunk.toString());
        if (streamMemoryRecall && !headersSent && !streamRejected) {
          streamRejected = true;
          streamLoopAborted = true;
          clearInterval(watchdog);
          try { streamReq?.destroy?.(); } catch {}
          reject({
            error: new Error("memory recall requested"),
            statusCode: 409,
            headersSent: false,
            latency: Date.now() - start,
            memoryRecall: streamMemoryRecall,
          });
          return;
        }
        if (!text) return;
        const filteredChunk = Buffer.from(text, "utf8");
        if (/data:\s*\{/.test(text)) dataChunks++;
        streamedVisibleContent += extractSseTextForDiagnostics(text);

        // Extract content + reasoning from SSE for garble detection
        for (const field of [/"content"\s*:\s*"([^"]{0,500})"/, /"reasoning_content"\s*:\s*"([^"]{0,500})"/, /"reasoning"\s*:\s*"([^"]{0,500})"/]) {
          const m = text.match(field);
          if (m) streamedContent += m[1];
        }
        if (/"tool_calls"/.test(text)) hasToolCallsInStream = true;
        streamToolCalls.ingest(text);
        const invalidTool = streamToolCalls.validateIfComplete(false);
        if (invalidTool) {
          rejectInvalidStreamToolCall(invalidTool);
          return;
        }
        // Keep last data chunk for usage extraction
        if (/data:\s*\{/.test(text)) lastDataChunk = text;

        if (dataChunks > 0 && dataChunks % 100 === 0 && streamedContent.length > 500 && !streamLoopAborted) {
          const sentences = streamedContent.split(/[.!?\n]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 15);
          if (sentences.length > 20) {
            const counts = {};
            for (const sentence of sentences) counts[sentence] = (counts[sentence] || 0) + 1;
            const maxRepeat = Math.max(0, ...Object.values(counts));
            const uniqueRatio = Object.keys(counts).length / sentences.length;
            if (maxRepeat >= 10 || (uniqueRatio < 0.2 && sentences.length > 30)) {
              streamLoopAborted = true;
              state.log(`STREAM-LOOP-ABORT: ${provider.name} ${dataChunks} chunks - sentence repeated ${maxRepeat}x, unique=${Math.round(uniqueRatio * 100)}%. Aborting stream.`);
              scoring.recordStalling(provider.name);
              scoring.setCooldown(provider.name, 900_000, "stream loop detected");
              if (headersSent) {
                clientRes.write("data: [DONE]\n\n");
                clientRes.end();
              }
              try { streamReq.destroy?.(); } catch {}
            }
          }
        }

        if (streamLoopAborted) return;

        if (!headersSent) {
          buffered.push(filteredChunk);
          const holdTextOnlyToolOutput = !hasToolCallsInStream &&
            shouldHoldTextOnlyToolOutput(toolParsingReq, streamedVisibleContent || streamedContent, streamAssessmentMarker, { allowPrefix: true });
          const shouldContinueToolWork = !hasToolCallsInStream &&
            shouldContinuePrematureToolWork(toolParsingReq, streamedVisibleContent || streamedContent, streamAssessmentMarker, { allowPrefix: true });
          if (
            dataChunks >= 3 &&
            !streamToolCalls.hasPendingToolCalls() &&
            !canUseHiddenContinuationForOutput(validationReq, streamedVisibleContent || streamedContent, { allowPrefix: true }) &&
            !shouldContinueToolWork &&
            !holdTextOnlyToolOutput
          ) {
            // Commit — flush buffered chunks after 15 clean chunks (enough to detect garble)
            clientRes.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...buildUsageHeaders(provider, reqBody, null),
            });
            headersSent = true;
            for (const b of buffered) clientRes.write(b);
            buffered.length = 0;
          }
        } else {
          const chunkStr = text;
          if (/data:\s*\{/.test(chunkStr)) {
            const jsonMatch = chunkStr.match(/data:\s*(\{.+\})/);
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (parsed.inference_id || parsed.completion_tokens_per_sec || parsed.producer) {
                  state.log(`FILTER-TELEMETRY: ${provider.name} — stripped telemetry chunk`);
                  return;
                }
              } catch {}
            }
          }
          clientRes.write(filteredChunk);
        }
      },
      () => {
        const latency = Date.now() - start;
        clearInterval(watchdog);
        if (streamRejected) return;

        const flushedTail = filterDifficultyMarker("", true);
        if (flushedTail) {
          const filteredChunk = Buffer.from(flushedTail, "utf8");
          if (/data:\s*\{/.test(flushedTail)) dataChunks++;
          streamedVisibleContent += extractSseTextForDiagnostics(flushedTail);
          for (const field of [/"content"\s*:\s*"([^"]{0,500})"/, /"reasoning_content"\s*:\s*"([^"]{0,500})"/, /"reasoning"\s*:\s*"([^"]{0,500})"/]) {
            const m = flushedTail.match(field);
            if (m) streamedContent += m[1];
          }
          if (!headersSent) buffered.push(filteredChunk);
          else clientRes.write(filteredChunk);
        }

        const invalidToolOnEnd = streamToolCalls.validateIfComplete(true);
        if (invalidToolOnEnd) {
          rejectInvalidStreamToolCall(invalidToolOnEnd);
          return;
        }

        if (dataChunks === 0 && !headersSent) {
          state.log(`EMPTY-STREAM: ${provider.name} 0 data chunks — rejecting for failover`);
          scoring.recordStalling(provider.name);
          reject({ error: new Error("empty stream"), statusCode: 502, headersSent: false, latency });
          return;
        }

        if (dataChunks <= 1 && !hasToolCallsInStream && streamedContent.replace(/\\[nrt"]/g, "").length < 10 && !headersSent) {
          state.log(`LOW-STREAM: ${provider.name} ${dataChunks} chunks, no useful content — rejecting for failover`);
          scoring.recordStalling(provider.name);
          reject({ error: new Error("empty response"), statusCode: 502, headersSent: false, latency });
          return;
        }

        if (!headersSent && !hasToolCallsInStream) {
          const imitatedToolText = parseImitatedToolCallText(streamedVisibleContent || streamedContent, toolParsingReq);
          if (imitatedToolText.invalid) {
            state.log(`TOOL-TEXT-STREAM-INVALID: ${provider.name} ${imitatedToolText.invalid} — rejecting before flush`);
            scoring.recordToolInvalid(provider.name, imitatedToolText.invalid);
            scoring.recordFailure(provider.name, imitatedToolText.invalid);
            reject({
              error: new Error(imitatedToolText.invalid),
              statusCode: 422,
              headersSent: false,
              latency,
            });
            return;
          }
          if (imitatedToolText.toolCalls?.length) {
            state.log(`TOOL-TEXT-STREAM-NORMALIZE: ${provider.name} converted ${imitatedToolText.toolCalls.length} text tool call(s)`);
            scoring.recordSuccess(provider.name, latency);
            scoring.recordPolicyUse(provider);
            sendAsSSE(clientRes, syntheticToolCallResponse(imitatedToolText.toolCalls, provider.model), provider, reqBody);
            resolve({ streamed: true, headersSent: true });
            return;
          }
        }

        if (!headersSent && !hasToolCallsInStream && canUseHiddenContinuationForOutput(validationReq, streamedVisibleContent || streamedContent)) {
          state.log(`HIDDEN-CONTINUE-STREAM: ${provider.name} returned inert continuation; appending hidden user continue`);
          reject({
            error: new Error("inert continuation"),
            statusCode: 422,
            headersSent: false,
            latency,
            hiddenContinuation: true,
            continuationText: (streamedVisibleContent || streamedContent || "").trim(),
          });
          return;
        }

        if (!headersSent && !hasToolCallsInStream && shouldContinuePrematureToolWork(toolParsingReq, streamedVisibleContent || streamedContent, streamAssessmentMarker)) {
          state.log(`HIDDEN-CONTINUE-STREAM-PROGRESS: ${provider.name} returned short tool-work progress; appending hidden user continue`);
          reject({
            error: new Error("text-only progress without tool call"),
            statusCode: 422,
            headersSent: false,
            latency,
            hiddenContinuation: true,
            continuationText: (streamedVisibleContent || streamedContent || "").trim(),
          });
          return;
        }

        if (
          !headersSent &&
          !hasToolCallsInStream &&
          shouldHoldTextOnlyToolOutput(toolParsingReq, streamedVisibleContent || streamedContent, streamAssessmentMarker) &&
          !allowsTextOnlyAnswer(validationReq, streamedVisibleContent || streamedContent, streamAssessmentMarker)
        ) {
          state.log(`NO-TOOLS-STREAM-BUFFERED: ${provider.name} text-only with ${validationReq.tools?.length || 0} tools available — rejecting before flush`);
          scoring.recordStalling(provider.name);
          reject({
            error: new Error("text-only response with tools available"),
            statusCode: 422,
            headersSent: false,
            latency,
            stalling: true,
          });
          return;
        }

        scoring.recordSuccess(provider.name, latency);
        scoring.recordPolicyUse(provider);

        if (dataChunks <= 2) {
          const scLen = streamedContent.replace(/\\[nrt"]/g, "").length;
          state.log(`LOW-CHUNKS: ${provider.name} ${dataChunks} chunks ${latency}ms — streamedContent=${scLen}chars tools=${hasToolCallsInStream} headersSent=${headersSent}`);
          addRouteWarning(reqBody, "post_stream_low_chunks");
        }

        // Detect bad responses that technically "succeed" but are useless:
        // 1. Tiny response after long wait (provider stalling)
        // 2. Fast response with few chunks and no real content (thinking-only garbage)
        // 3. Only reasoning/thinking content with no actual response
        const hasRealContent = /"content"\s*:\s*"[^"]{10,}"/.test(streamedContent) ||
                               streamedContent.replace(/\\[nrt"]/g, "").length > 50;
        const thinkingOnly = !hasRealContent && (/"reasoning/.test(streamedContent) || /"thinking/.test(streamedContent));

        if (dataChunks <= 5 && latency > 60000) {
          state.log(`TINY-RESPONSE: ${provider.name} only ${dataChunks} chunks in ${latency}ms — likely stalling`);
          addRouteWarning(reqBody, "post_stream_tiny_response");
          scoring.recordStalling(provider.name);
        } else if (thinkingOnly && dataChunks < 20 && latency < 15000) {
          // Fast response with only thinking/reasoning, no real content = garbled thinking
          state.log(`THINKING-ONLY: ${provider.name} ${dataChunks} chunks ${latency}ms — only reasoning, no content. Likely garbled.`);
          addRouteWarning(reqBody, "post_stream_thinking_only");
          scoring.recordStalling(provider.name);
          scoring.setCooldown(provider.name, 300_000, "thinking-only stream");
        } else if (!hasToolCallsInStream && hasRealContent && validationReq?.tools?.length > 0 && dataChunks >= 1 && !allowsTextOnlyAnswer(validationReq, streamedContent, null)) {
          state.log(`NO-TOOLS-STREAM: ${provider.name} text-only (${dataChunks} chunks) with ${validationReq.tools.length} tools available`);
          addRouteWarning(reqBody, "post_stream_text_only_with_tools");
        } else if (dataChunks > 10 && hasRealContent) {
          const garbled = streamedContent.length > 200 && compaction.detectGarbledText(streamedContent);
          if (garbled && !looksLikeCoherentGarbleFalsePositive(streamedContent)) {
            state.log(`GARBLE-STREAM: ${provider.name} ${dataChunks} chunks — garbled content detected post-stream`);
            addRouteWarning(reqBody, "post_stream_garbled");
            scoring.recordStalling(provider.name);
            scoring.setCooldown(provider.name, 900_000, "garbled stream output");
          } else if (garbled) {
            state.log(`GARBLE-STREAM-SKIP: ${provider.name} accepted coherent diagnostic text despite repeated phrases`);
          } else {
            if (state.stallingTracker[provider.name]) state.stallingTracker[provider.name] = [];
          }
        }

        // Extract usage from last SSE chunk (many providers include it)
        let streamUsage = null;
        try {
          const jsonMatch = lastDataChunk.match(/data:\s*(\{.+\})/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1]);
            streamUsage = parsed.usage || null;
          }
        } catch {}
        const cachedTokens = cachedInputTokensFromUsage(streamUsage);
        const usageStr = streamUsage
          ? ` usage[in=${streamUsage.prompt_tokens||0} out=${streamUsage.completion_tokens||0} total=${streamUsage.total_tokens||0}${cachedTokens ? ` cached=${cachedTokens}` : ""}]`
          : "";
        state.log(`STREAM-OK: ${provider.name} ${latency}ms chunks=${dataChunks}${usageStr}`);
        if (streamAssessmentMarker) {
          cachePostRouteAssessment(
            reqBody,
            provider,
            routingPolicy.profileFromAssessmentMarker(reqBody, streamAssessmentMarker),
            true,
          );
        } else if (reqBody._llmProxyDifficulty) {
          cachePostRouteAssessment(reqBody, provider, reqBody._llmProxyDifficulty, true, "post_route_fallback");
        }

        // Track provider-level usage
        try {
          const sid = memory.getSession(reqBody.messages).id;
          const inTok = streamUsage?.prompt_tokens || estimateRequestInputTokens(transformedBody);
          const outTok = streamUsage?.completion_tokens || 0;
          _trackSessionTokens(sid, inTok, outTok, provider.name);
          recordCachedInputTokens(sid, provider.name, cachedTokens);
          recordRouteDiversityUse(reqBody, provider.name);
        } catch {}

        try { memory.setLastProvider(memory.getSession(reqBody.messages), provider.name); } catch {}
        try { const sid2 = memory.getSession(reqBody.messages).id; if (state.sessionStats[sid2]) state.sessionStats[sid2].lastProvider = provider.name; } catch {}
        if (streamMemoryOps.length > 0) {
          try { memory.applyMemoryOps(memory.getSession(reqBody.messages), reqBody, streamMemoryOps); } catch {}
          state.log(`MEMORY-STREAM: ${provider.name} ops=${streamMemoryOps.map((op) => op.op).join(",")}`);
        }
        try {
          const session = memory.getSession(reqBody.messages);
          reqBody._servedProvider = provider.name;
          const saveBody = hasToolCallsInStream
            ? streamToolCalls.asResponseBody()
            : syntheticAssistantResponse(streamedVisibleContent || streamedContent);
          memory.triggerSaves(session, reqBody, saveBody);
        } catch {}
        if (!headersSent && buffered.length > 0) {
          clientRes.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...buildUsageHeaders(provider, reqBody, null),
          });
          headersSent = true;
          for (const b of buffered) clientRes.write(b);
          buffered.length = 0;
          state.log(`FLUSH-BUFFER: ${provider.name} — flushed ${dataChunks} buffered chunks on stream end`);
        }
        if (headersSent) {
          clientRes.end();
        }
        resolve({ streamed: true, headersSent });
      },
      (err, statusCode) => {
        const latency = Date.now() - start;
        if (statusCode === 429) scoring.setCooldown(provider.name, undefined, "HTTP 429 stream rate limit");
        // Timeout/gateway errors — cooldown so failover picks different provider
        if (scoring.isTemporaryRateLimit(statusCode, err.message || "")) {
          scoring.setCooldown(provider.name, 60 * 60_000, `stream rate limit HTTP ${statusCode}`);
        } else if (statusCode === 502 || statusCode === 504 || /timeout|idle/i.test(err.message || "")) {
          scoring.setCooldown(provider.name, undefined, `stream HTTP ${statusCode} gateway/timeout`);
        }
        if (scoring.isQuotaExhaustedError(statusCode, err.message || "")) {
          scoring.disableProviderQuota(provider.name, `HTTP ${statusCode}: quota/billing error`);
        }
        clearInterval(watchdog);
        scoring.detectIncompatibility(provider.name, statusCode, err.message || "", {
          inputTokens: validationReq._inputTokens,
          estimatedTokens: validationReq._estimatedTokens,
          providerContext: scoring.getEffectiveContext(provider),
          hasTools: ((validationReq.tools?.length || 0) + (validationReq.functions?.length || 0)) > 0,
          hasToolHistory: requestHasToolHistory(validationReq),
          hasImages: requestHasImageInput(validationReq),
          hasDataImages: requestHasDataImageInput(validationReq),
          compactedContext: requestHasCompactedContext(validationReq),
        });
        scoring.recordFailure(provider.name, err.message);
        state.log(`STREAM-ERR: ${provider.name} ${latency}ms status=${statusCode} headersSent=${headersSent} chunks=${dataChunks} err=${(err.message || "").substring(0, 80)}`);

        // Stream abort with minimal data = likely quota/stall — cooldown
        if (dataChunks <= 2 && /aborted|socket hang up|ECONNRESET/i.test(err.message || "")) {
          scoring.setCooldown(provider.name, 3600_000, "stream aborted");
          state.log(`STREAM-STALL: ${provider.name} aborted after ${dataChunks} chunks — cooldown 1h`);
        }

        reject({ error: err, statusCode, headersSent, latency });
      }
    );
  });
}

async function routeNativeStreamToProvider(provider, reqBody, clientRes) {
  const transformedBody = await transforms.transformRequest(provider, reqBody);
  const validationReq = responseValidationRequest(reqBody, transformedBody);
  const toolParsingReq = hasToolAccess(validationReq) ? validationReq : reqBody;
  const start = Date.now();
  let headersSent = false;
  let chunks = 0;
  let streamedContent = "";
  let streamAssessmentMarker = null;
  const streamMemoryOps = [];
  const buffered = [];
  let hasUsefulNativeOutput = false;
  let hasToolCallsInStream = false;
  const streamToolCalls = createStreamToolCallAccumulator(toolParsingReq);
  const filterDifficultyMarker = createStreamDifficultyMarkerFilter(
    provider.name,
    (marker) => { streamAssessmentMarker = marker; },
    (marker) => { streamMemoryOps.push(marker); },
  );

  if (state.DEV_MODE) {
    const bodyStr = JSON.stringify(transformedBody);
    state.log(`DEV-NATIVE-STREAM-REQ: ${provider.name} (${provider.model}) ctx=${scoring.getEffectiveContext(provider)} body=${bodyStr.length}chars msgs=${transformedBody.messages?.length}`);
    try { fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-request.json"), bodyStr); } catch {}
  }

  function writeHeaders() {
    if (headersSent) return;
    clientRes.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...buildUsageHeaders(provider, reqBody, null),
    });
    headersSent = true;
  }

  function flushBuffered() {
    if (buffered.length === 0) return;
    writeHeaders();
    for (const chunk of buffered) clientRes.write(chunk);
    buffered.length = 0;
  }

  function processFilteredNativeChunk(filteredChunk) {
    if (!filteredChunk) return;
    const chunkText = String(filteredChunk || "");
    const diagnosticText = extractSseTextForDiagnostics(chunkText);
    streamToolCalls.ingest(chunkText);
    const invalidTool = streamToolCalls.validateIfComplete(false);
    if (invalidTool) {
      const error = new Error(invalidTool);
      error.status = 422;
      error.body = invalidTool;
      throw error;
    }

    chunks += 1;
    streamedContent += diagnosticText;
    const holdTextOnlyToolOutput = !hasToolCallsInStream &&
      shouldHoldTextOnlyToolOutput(toolParsingReq, streamedContent, streamAssessmentMarker, { allowPrefix: true });
    const shouldContinueToolWork = !hasToolCallsInStream &&
      shouldContinuePrematureToolWork(toolParsingReq, streamedContent, streamAssessmentMarker, { allowPrefix: true });
    if (diagnosticText.trim() && !canUseHiddenContinuationForOutput(validationReq, streamedContent, { allowPrefix: true }) && !shouldContinueToolWork && !holdTextOnlyToolOutput) {
      hasUsefulNativeOutput = true;
    }
    if (/"tool_calls"\s*:/.test(chunkText)) {
      hasToolCallsInStream = true;
      hasUsefulNativeOutput = true;
    }

    const filteredBuffer = Buffer.from(chunkText, "utf8");
    if (!headersSent) {
      buffered.push(filteredBuffer);
      if (hasUsefulNativeOutput && !streamToolCalls.hasPendingToolCalls()) {
        flushBuffered();
      }
      return;
    }
    clientRes.write(filteredBuffer);
  }

  try {
    await providerAdapters.routeNativeStream(provider, transformedBody, {
      onChunk(chunk) {
        const filteredChunk = filterDifficultyMarker(String(chunk || ""));
        processFilteredNativeChunk(filteredChunk);
      },
    });
    const flushedTail = filterDifficultyMarker("", true);
    if (flushedTail) processFilteredNativeChunk(flushedTail);

    const invalidToolOnEnd = streamToolCalls.validateIfComplete(true);
    if (invalidToolOnEnd) {
      const error = new Error(invalidToolOnEnd);
      error.status = 422;
      error.body = invalidToolOnEnd;
      throw error;
    }
  } catch (error) {
    const latency = Date.now() - start;
    const status = error.status || 502;
    const body = Buffer.isBuffer(error.body) ? error.body.toString("utf8") : (error.body || error.message || "native stream error");
    if (scoring.isTemporaryRateLimit(status, body)) {
      scoring.setCooldown(provider.name, 60 * 60_000, `native stream rate limit HTTP ${status}`);
    } else if (status === 502 || status === 504 || /timeout|idle/i.test(body)) {
      scoring.setCooldown(provider.name, undefined, `native stream HTTP ${status} gateway/timeout`);
    }
    cooldownWindsurfNativeTimeoutPeers(provider, status, body, chunks);
    if (scoring.isQuotaExhaustedError(status, body)) {
      scoring.disableProviderQuota(provider.name, `HTTP ${status}: quota/billing error`);
    }
    scoring.detectIncompatibility(provider.name, status, body, {
      inputTokens: validationReq._inputTokens,
      estimatedTokens: validationReq._estimatedTokens,
      providerContext: scoring.getEffectiveContext(provider),
      hasTools: ((validationReq.tools?.length || 0) + (validationReq.functions?.length || 0)) > 0,
      hasToolHistory: requestHasToolHistory(validationReq),
      hasImages: requestHasImageInput(validationReq),
      hasDataImages: requestHasDataImageInput(validationReq),
      compactedContext: requestHasCompactedContext(validationReq),
    });
    scoring.recordFailure(provider.name, body);
    if (headersSent) {
      state.log(`NATIVE-STREAM-ERR: ${provider.name} ${latency}ms headersSent=true chunks=${chunks} err=${String(error.message || error).substring(0, 100)}`);
      try { clientRes.write("data: [DONE]\n\n"); } catch {}
      clientRes.end();
      throw { headersSent: true, failureRecorded: true };
    }
    state.log(`NATIVE-STREAM-ERR: ${provider.name} ${latency}ms status=${status} chunks=${chunks} err=${String(body || error).substring(0, 100)}`);
    throw {
      status,
      body,
      latency,
      logged: true,
      failureRecorded: true,
    };
  }

  const latency = Date.now() - start;
  if (!headersSent && !hasToolCallsInStream) {
    const imitatedToolText = parseImitatedToolCallText(streamedContent, toolParsingReq);
    if (imitatedToolText.invalid) {
      state.log(`TOOL-TEXT-NATIVE-INVALID: ${provider.name} ${imitatedToolText.invalid} — rejecting before flush`);
      scoring.recordToolInvalid(provider.name, imitatedToolText.invalid);
      scoring.recordFailure(provider.name, imitatedToolText.invalid);
      throw {
        status: 422,
        body: imitatedToolText.invalid,
        latency,
        logged: true,
        failureRecorded: true,
      };
    }
    if (imitatedToolText.toolCalls?.length) {
      state.log(`TOOL-TEXT-NATIVE-NORMALIZE: ${provider.name} converted ${imitatedToolText.toolCalls.length} text tool call(s)`);
      scoring.recordSuccess(provider.name, latency);
      scoring.recordPolicyUse(provider);
      sendAsSSE(clientRes, syntheticToolCallResponse(imitatedToolText.toolCalls, provider.model), provider, reqBody);
      return;
    }
  }
  if (!headersSent && !hasToolCallsInStream && canUseHiddenContinuationForOutput(validationReq, streamedContent)) {
    state.log(`HIDDEN-CONTINUE-NATIVE: ${provider.name} returned inert continuation; appending hidden user continue`);
    throw {
      status: 422,
      body: "inert continuation",
      latency,
      logged: true,
      hiddenContinuation: true,
      continuationText: streamedContent.trim(),
    };
  }
  if (!headersSent && !hasToolCallsInStream && shouldContinuePrematureToolWork(toolParsingReq, streamedContent, streamAssessmentMarker)) {
    state.log(`HIDDEN-CONTINUE-NATIVE-PROGRESS: ${provider.name} returned short tool-work progress; appending hidden user continue`);
    throw {
      status: 422,
      body: "text-only progress without tool call",
      latency,
      logged: true,
      hiddenContinuation: true,
      continuationText: streamedContent.trim(),
    };
  }
  if (
    !headersSent &&
    !hasToolCallsInStream &&
    shouldHoldTextOnlyToolOutput(toolParsingReq, streamedContent, streamAssessmentMarker) &&
    !allowsTextOnlyAnswer(validationReq, streamedContent, streamAssessmentMarker)
  ) {
    scoring.recordStalling(provider.name);
    state.log(`NO-TOOLS-NATIVE-BUFFERED: ${provider.name} text-only with ${validationReq.tools?.length || 0} tools available — rejecting before flush`);
    throw {
      status: 422,
      body: "text-only response with tools available",
      latency,
      logged: true,
      stalling: true,
    };
  }
  if (!hasUsefulNativeOutput && !headersSent) {
    scoring.recordStalling(provider.name);
    state.log(`EMPTY-NATIVE-STREAM: ${provider.name} ${latency}ms chunks=${chunks} — no visible content or tool calls`);
    throw {
      status: 502,
      body: "empty native stream",
      latency,
      logged: true,
    };
  }
  if (!headersSent) flushBuffered();
  scoring.recordSuccess(provider.name, latency);
  scoring.recordPolicyUse(provider);
  try {
    const sid = memory.getSession(reqBody.messages).id;
    const inTok = estimateRequestInputTokens(transformedBody);
    const outTok = streamedContent.trim() ? estimateTextTokens(streamedContent) : 0;
    _trackSessionTokens(sid, inTok, outTok, provider.name);
    recordRouteDiversityUse(reqBody, provider.name);
  } catch {}
  if (streamAssessmentMarker) {
    cachePostRouteAssessment(
      reqBody,
      provider,
      routingPolicy.profileFromAssessmentMarker(reqBody, streamAssessmentMarker),
      true,
    );
  } else if (reqBody._llmProxyDifficulty) {
    cachePostRouteAssessment(reqBody, provider, reqBody._llmProxyDifficulty, true, "post_route_fallback");
  }
  try { memory.setLastProvider(memory.getSession(reqBody.messages), provider.name); } catch {}
  try { const sid2 = memory.getSession(reqBody.messages).id; if (state.sessionStats[sid2]) state.sessionStats[sid2].lastProvider = provider.name; } catch {}
  if (streamMemoryOps.length > 0) {
    try { memory.applyMemoryOps(memory.getSession(reqBody.messages), reqBody, streamMemoryOps); } catch {}
    state.log(`MEMORY-NATIVE-STREAM: ${provider.name} ops=${streamMemoryOps.map((op) => op.op).join(",")}`);
  }
  try {
    const session = memory.getSession(reqBody.messages);
    reqBody._servedProvider = provider.name;
    memory.triggerSaves(session, reqBody, syntheticAssistantResponse(streamedContent));
  } catch {}
  const garbled = streamedContent.length > 200 && compaction.detectGarbledText(streamedContent);
  if (garbled && !looksLikeCoherentGarbleFalsePositive(streamedContent)) {
    state.log(`GARBLE-NATIVE-STREAM: ${provider.name} chunks=${chunks} — garbled content detected post-stream`);
    addRouteWarning(reqBody, "post_stream_garbled");
    scoring.recordStalling(provider.name);
    scoring.setCooldown(provider.name, 900_000, "garbled native stream output");
  } else if (garbled) {
    state.log(`GARBLE-NATIVE-STREAM-SKIP: ${provider.name} accepted coherent diagnostic text despite repeated phrases`);
  }
  const estimatedOut = streamedContent.trim() ? estimateTextTokens(streamedContent) : 0;
  state.log(`NATIVE-STREAM-OK: ${provider.name} ${latency}ms chunks=${chunks} usage[out_est=${estimatedOut}] tools=${hasToolCallsInStream}`);
  clientRes.end();
}

async function handleChatCompletion(reqBody, clientRes, options = {}) {
  if (!options.internal) {
    reqBody = stripExternalProxyFields(reqBody || {});
  }

  const requestedModel = reqBody.model || "auto";
  const isStreaming = reqBody.stream === true;
  const isGroup = requestedModel in state.GROUPS || requestedModel === "auto";
  const nonStreamingFallbackTimeoutMs = clampInt(process.env.LLM_PROXY_NON_STREAMING_FALLBACK_TIMEOUT_MS, 500, 120000, 60_000);
  const bypassProxyOptimizations = !!reqBody._llmProxyBypassOptimizations;
  const approvalToken = !bypassProxyOptimizations ? humanApproval.extractApprovalToken(reqBody, options) : "";
  if (approvalToken) reqBody._llmProxyHumanApprovalToken = approvalToken;

  // Intercept "ban ai XX" — only trigger on LAST user message, strip from all others
  const BAN_RE = /\bban\s+ai\s+(\d+)\b/i;
  // Find last user message
  let banMatch = null;
  let lastUserIdx = -1;
  if (reqBody.messages) {
    for (let bi = reqBody.messages.length - 1; bi >= 0; bi--) {
      if (reqBody.messages[bi]?.role === "user") { lastUserIdx = bi; break; }
    }
    if (lastUserIdx >= 0) {
      const m = reqBody.messages[lastUserIdx];
      const text = messageContentText(m.content);
      banMatch = text.match(BAN_RE);
    }
  }
  if (banMatch) {
    const banHours = parseInt(banMatch[1], 10);
    const banSid = memory.getSession(reqBody.messages)?.id;
    const banSs = banSid ? state.sessionStats[banSid] : null;
    const banProvider = banSs?.lastProvider;

    // Always strip "ban ai XX" from all messages (clears IDE cache residue)
    reqBody.messages = reqBody.messages.map(m => {
      if (typeof m.content === "string" && BAN_RE.test(m.content)) {
        const cleaned = m.content.replace(BAN_RE, "").trim();
        return cleaned ? { ...m, content: cleaned } : null;
      }
      if (Array.isArray(m.content)) {
        const parts = m.content.map(p => mediaContent.TEXT_PART_TYPES.has(p?.type) && BAN_RE.test(p.text || "") ? { ...p, text: (p.text || "").replace(BAN_RE, "").trim() } : p)
          .filter(p => !mediaContent.TEXT_PART_TYPES.has(p?.type) || p.text);
        return parts.length > 0 ? { ...m, content: parts } : null;
      }
      return m;
    }).filter(Boolean);

    if (banProvider && banHours > 0) {
      // Have a provider to ban — apply cooldown and return confirmation
      scoring.setCooldown(banProvider, banHours * 60 * 60_000);
      state.log(`USER-BAN: ${banProvider} banned for ${banHours}h by user command`);
      const msg = `Banned **${banProvider}** for ${banHours} hour${banHours > 1 ? "s" : ""}. Will use other providers.`;
      if (isStreaming) {
        clientRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        clientRes.write(`data: ${JSON.stringify({ id: "chatcmpl-ban", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "llm-proxy", choices: [{ index: 0, delta: { role: "assistant", content: msg }, finish_reason: null }] })}\n\n`);
        clientRes.write(`data: ${JSON.stringify({ id: "chatcmpl-ban", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "llm-proxy", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        clientRes.write("data: [DONE]\n\n");
        clientRes.end();
      } else {
        clientRes.writeHead(200, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({
          id: "chatcmpl-ban", object: "chat.completion", created: Math.floor(Date.now() / 1000),
          model: "llm-proxy", choices: [{ index: 0, message: { role: "assistant", content: msg }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      }
      return;
    }
    // No provider to ban (stale cache, fresh restart) — just strip and continue routing normally
    state.log(`BAN-STRIP: stripped stale "ban ai" from messages, continuing routing (no lastProvider)`)
  }

  // Permanent filter: strip any leftover "ban ai XX" from cached IDE messages
  if (reqBody.messages) {
    for (const m of reqBody.messages) {
      if (typeof m.content === "string" && BAN_RE.test(m.content)) {
        m.content = m.content.replace(BAN_RE, "").trim();
      } else if (Array.isArray(m.content)) {
        m.content = m.content
          .map((p) => mediaContent.TEXT_PART_TYPES.has(p?.type) && BAN_RE.test(p.text || "") ? { ...p, text: (p.text || "").replace(BAN_RE, "").trim() } : p)
          .filter((p) => !mediaContent.TEXT_PART_TYPES.has(p?.type) || p.text);
      }
    }
  }

  if (!bypassProxyOptimizations) {
    const removedApprovalArtifacts = humanApproval.stripApprovalArtifacts(reqBody, approvalToken);
    if (removedApprovalArtifacts > 0) {
      state.log(`HUMAN-APPROVAL-STRIP: removed ${removedApprovalArtifacts} cached approval artifact${removedApprovalArtifacts === 1 ? "" : "s"}`);
    }
    stripCachedProxyArtifacts(reqBody);
  }
  if (!bypassProxyOptimizations) dedupeConsecutiveIdempotentToolCalls(reqBody);

  const estTokens = estimateRequestInputTokens(reqBody);
  const requestedMaxTokens = reqBody.max_tokens || 4096;
  const totalNeeded = estTokens + requestedMaxTokens;
  reqBody._inputTokens = estTokens;
  reqBody._estimatedTokens = totalNeeded; // pass to scoring for context-aware ranking

  // Session compact cache: if IDE sends context we already compacted,
  // replace old portion with compact version, keep only truly new messages
  const sid = memory.getSession(reqBody.messages)?.id;
  if (!bypassProxyOptimizations && sid && state.sessionCompactCache[sid] && reqBody.messages?.length > 20) {
    const cache = state.sessionCompactCache[sid];
    const cacheAge = Date.now() - cache.timestamp;
    if (cacheAge < 600_000 && reqBody.messages.length >= cache.originalMsgCount) {
      // Find new messages: those that weren't in original set (by role+content hash)
      const lastCachedMsg = cache.lastOriginalContent;
      let splitIdx = -1;
      // Find where old context ends in IDE's messages
      for (let i = reqBody.messages.length - 1; i >= 0; i--) {
        const content = messageContentText(reqBody.messages[i].content);
        if (content === lastCachedMsg) {
          splitIdx = i + 1;
          break;
        }
      }
      if (splitIdx === -1) {
        // Can't find split point — fall back to position-based
        splitIdx = cache.originalMsgCount;
      }
      const newMsgs = reqBody.messages.slice(splitIdx);
      reqBody.messages = [...cache.compactedMessages, ...newMsgs];
      const newEst = estimateRequestInputTokens(reqBody);
      state.log(`CACHE-HIT: session ${sid} (${cache.originalMsgCount}→${cache.compactedMessages.length} cached + ${newMsgs.length} new = ${reqBody.messages.length} msgs, ${estTokens}→${newEst}tok)`);
      reqBody._inputTokens = newEst;
      reqBody._estimatedTokens = newEst + requestedMaxTokens;
      reqBody._llmProxyCompactedContext = true;
      reqBody._llmProxyCompactedPhase = reqBody._llmProxyCompactedPhase || "cache";
    } else if (cacheAge >= 600_000) {
      delete state.sessionCompactCache[sid];
    }
  }
  if (!bypassProxyOptimizations && sid && reqBody.messages?.length > 20) {
    const beforeDrops = reqBody.messages.length;
    reqBody.messages = compaction.applyCachedTruncations(reqBody.messages);
    reqBody.messages = compaction.applyCompactionDrops(sid, reqBody.messages);
    if (reqBody.messages.length < beforeDrops) {
      reqBody._llmProxyCompactedContext = true;
      reqBody._llmProxyCompactedPhase = reqBody._llmProxyCompactedPhase || "drop-cache";
    }
  }

  // Re-estimate after potential cache hit
  let currentTokens = estimateRequestInputTokens(reqBody);
  let currentTotalNeeded = currentTokens + requestedMaxTokens;
  reqBody._inputTokens = currentTokens;
  reqBody._estimatedTokens = currentTotalNeeded;

  if (!bypassProxyOptimizations) {
    applyCachedPostRouteAssessmentIfAvailable(reqBody, requestedModel, isGroup);
    const initialApprovalProfile = reqBody._llmProxyDifficulty || routingPolicy.effectiveRequestProfile(reqBody);
    const needsAiAssessment = shouldUseAiTaskAssessment(reqBody, requestedModel, isGroup, initialApprovalProfile);
    let approvalSatisfied = false;

    const initialApprovalResult = humanApproval.enforce(reqBody, initialApprovalProfile, {
      ...options,
      approveOnly: needsAiAssessment,
    });
    if (!initialApprovalResult.ok) {
      state.log(`HUMAN-APPROVAL-BLOCK: gate=${initialApprovalResult.record.gate} task=${initialApprovalResult.record.task_kind} challenge=${initialApprovalResult.record.challenge} request=${initialApprovalResult.record.request_hash.substring(0, 12)}`);
      humanApproval.writeBlockedResponse(clientRes, initialApprovalResult, reqBody);
      return;
    }
    if (initialApprovalResult.approved) {
      approvalSatisfied = true;
      state.log(`HUMAN-APPROVAL-OK: gate=${initialApprovalResult.record.gate} task=${initialApprovalResult.record.task_kind} approval=${initialApprovalResult.record.approval_id} request=${initialApprovalResult.record.request_hash.substring(0, 12)}`);
    }

    await applyAiTaskAssessmentIfNeeded(reqBody, requestedModel, isGroup, {
      heuristic: initialApprovalProfile,
      shouldAssess: needsAiAssessment,
    });
    const continuationWithoutUpgrade = hasAssistantOrToolAfterLatestUser(reqBody) && !hasContinuationAssessmentUpgradeSignal(reqBody, initialApprovalProfile);
    if (
      !reqBody._llmProxyDifficulty &&
      continuationWithoutUpgrade &&
      isHighRiskRoutingProfile(initialApprovalProfile) &&
      !currentUserSupportsHighRiskProfile(reqBody, initialApprovalProfile)
    ) {
      reqBody._llmProxyDifficulty = sanitizedContinuationProfile(reqBody, initialApprovalProfile);
      state.log(`AI-ASSESS-CONTINUATION-SKIP: ignored high-risk heuristic task=${initialApprovalProfile.taskKind || "general"} without current high-risk intent`);
    } else if (!reqBody._llmProxyDifficulty && continuationWithoutUpgrade) {
      reqBody._llmProxyDifficulty = {
        ...initialApprovalProfile,
        source: "continuation_heuristic",
      };
      state.log(`AI-ASSESS-CONTINUATION: reused heuristic profile for same-user agent continuation task=${initialApprovalProfile.taskKind || "general"}`);
    }
    const finalApprovalProfile = reqBody._llmProxyDifficulty || routingPolicy.effectiveRequestProfile(reqBody);
    if (!approvalSatisfied) {
      const approvalResult = humanApproval.enforce(reqBody, finalApprovalProfile, options);
      if (!approvalResult.ok) {
        state.log(`HUMAN-APPROVAL-BLOCK: gate=${approvalResult.record.gate} task=${approvalResult.record.task_kind} challenge=${approvalResult.record.challenge} request=${approvalResult.record.request_hash.substring(0, 12)}`);
        humanApproval.writeBlockedResponse(clientRes, approvalResult, reqBody);
        return;
      }
      if (approvalResult.approved) {
        approvalSatisfied = true;
        state.log(`HUMAN-APPROVAL-OK: gate=${approvalResult.record.gate} task=${approvalResult.record.task_kind} approval=${approvalResult.record.approval_id} request=${approvalResult.record.request_hash.substring(0, 12)}`);
      }
    }
  }

  // Detect summarization requests — IDE asking to compact/summarize context
  // These bypass context limits entirely (the whole point is to summarize large context)
  const lastMsg = reqBody.messages?.[reqBody.messages.length - 1];
  const lastContent = messageContentText(lastMsg?.content).trim();
  const isSummarizationRequest = lastContent.length < 200 && /\b(summariz|what did we|what have we|recap|context|compaction|condense|shorten|compress|so far|up to now|overview of .*(session|conversation|work|progress))\b/i.test(lastContent);

  // Memory: recall memories and inject into context
  const mpSession = memory.getSession(reqBody.messages);

  if (!bypassProxyOptimizations) {
    const preCompact = await maybeApplyPreRouteCompaction(
      reqBody,
      requestedModel,
      currentTokens,
      currentTotalNeeded,
      requestedMaxTokens,
      mpSession,
      { isGroup, bypassProxyOptimizations, isSummarizationRequest },
    );
    if (preCompact) {
      currentTokens = preCompact.inputTokens;
      currentTotalNeeded = preCompact.totalNeeded;
    }
  }

  // Early check: if input exceeds 90% of best available context, tell IDE to compact.
  // Summarization requests skip this check entirely — they need full context to summarize.
  if (isGroup && reqBody.messages?.length > 20 && !isSummarizationRequest) {
    const candidates = requestedModel === "auto"
      ? getProvidersForAuto(reqBody.messages, 0, reqBody)
      : getProvidersForGroup(requestedModel, 0, reqBody);
    const bestCtx = Math.max(...candidates.map(p => scoring.getEffectiveContext(p)), 0);
    if (bestCtx > 0 && currentTokens > bestCtx * 0.9) {
      const compacted = await maybeApplyEmergencyContextCompaction(
        reqBody,
        requestedModel,
        requestedMaxTokens,
        mpSession,
        { ...options, bypassProxyOptimizations, isSummarizationRequest },
      );
      if (compacted) {
        currentTokens = compacted.inputTokens;
        currentTotalNeeded = compacted.totalNeeded;
      } else {
        writeContextCompactionGuidance(clientRes, reqBody, {
          reason: "too_large_for_best_context",
          inputTokens: currentTokens,
          requestedTokens: currentTokens + requestedMaxTokens,
          maxContext: bestCtx,
        }, options);
        return;
      }
    }
  }

  // Create/update session metadata before routing; successful providers record usage.
  _trackSessionTokens(mpSession.id, 0, 0);
  // Get last provider from session stats first; memory session state is a fallback.
  const ss = state.sessionStats[mpSession.id];
  reqBody._sessionLastProvider = ss?.lastProvider || memory.getLastProvider(mpSession);
  let memoryInjection = "";
  if (!bypassProxyOptimizations) {
    try {
      memoryInjection = await memory.recallMemories(mpSession, reqBody);
    } catch { /* graceful degradation */ }
  }
  if (memoryInjection) {
    reqBody._memoryInjection = [reqBody._memoryInjection, memoryInjection].filter(Boolean).join("\n");
    recordMemoryInjection(reqBody, memoryInjection);
  }

  // Save project context on first request of session
  if (mpSession.requestCount === 1) {
    const sysMsg = reqBody.messages?.find((m) => m.role === "system");
    if (sysMsg) memory.saveProjectContext(mpSession, messageContentText(sysMsg.content));
  }

  // Detect "continua loop" — user retrying because previous response was useless
  // Skip if last request was < 2s ago (IDE auto-retry, not user action)
  const lastReqTime = ss?.lastRequest || 0;
  const timeSinceLastReq = Date.now() - lastReqTime;
  if (reqBody.messages?.length >= 3 && timeSinceLastReq > 2000) {
    const msgs = reqBody.messages;
    let continuaCount = 0;
    let shortAssistantCount = 0;
    // Scan last 10 messages for stalling patterns
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 10); i--) {
      const m = msgs[i];
      if (m.role === "user") {
        const text = messageContentText(m.content).trim();
        if (/(?:continu[ea]|continue|go|do it|next|remember|recall|where were we|what were we)/i.test(text) && text.length < 50) {
          continuaCount++;
        }
      }
      if (m.role === "assistant" && !m.tool_calls?.length) {
        const ac = messageContentText(m.content);
        // Short response without tool calls = stalling
        if (ac.length < 800) shortAssistantCount++;
        // Fake execution (shell commands as text)
        let fe = 0;
        for (const pat of transforms.FAKE_EXEC_PATTERNS) { if (pat.test(ac)) fe++; }
        if (fe >= 1) shortAssistantCount++;
      }
    }
    // Stalling detected — penalize only the provider that actually served the stalling response
    if ((continuaCount >= 2 || shortAssistantCount >= 3) && continuaCount + shortAssistantCount >= 3) {
      // Identify the provider that actually responded (session affinity tracks this)
      const stallingProvider = reqBody._sessionLastProvider;
      if (stallingProvider) {
        const banGroup = requestedModel === "auto" ? "auto" : requestedModel;

        if (continuaCount >= 3) {
          scoring.recordStalling(stallingProvider);
          scoring.banFromGroup(stallingProvider, banGroup);
          memory.saveStalling(stallingProvider, banGroup, "repeated stalling");
          state.log(`STALL-BAN: ${continuaCount}x continua, banned ${stallingProvider} from ${banGroup}`);
        } else {
          scoring.recordStalling(stallingProvider);
          scoring.setCooldown(stallingProvider, 5 * 60_000);
          state.log(`STALL-COOL: ${continuaCount}x continua, ${stallingProvider} cooled 5min`);
        }
      }
    }
  }

  // From here onward, routing remains normal. Pre-route compaction may have already
  // reduced the request only when a dry-run proved it changes the route to a cheaper
  // acceptable provider. transformRequest and provider retries still provide the
  // per-provider safety net.

  if (isGroup) {
    // auto group: detect use case, try all providers with smart ordering
    const rawProviders = requestedModel === "auto"
      ? getProvidersForAuto(reqBody.messages, currentTotalNeeded, reqBody)
      : getProvidersForGroup(requestedModel, currentTotalNeeded, reqBody);
    const keptAfterGate = new Set(gateLargeModelProviders(rawProviders, reqBody, requestedModel, isGroup).map((provider) => provider.name));
    let providers = rawProviders.filter((provider) => keptAfterGate.has(provider.name));
    const gatedProviders = rawProviders.filter((provider) => !keptAfterGate.has(provider.name));
    providers = applyRoutingDiversityScores(providers, reqBody, requestedModel, isGroup);
    setRouteTrace(reqBody, requestedModel, rawProviders, providers, gatedProviders, currentTokens);

    const nearLevelFallback = nearLevelAssessmentFallbackProviders(requestedModel, reqBody, currentTotalNeeded);
    if (nearLevelFallback.providers.length > 0) {
      const existingProviderNames = new Set(providers.map((provider) => provider.name));
      const fallbackExtras = nearLevelFallback.providers.filter((provider) => !existingProviderNames.has(provider.name));
      if (fallbackExtras.length > 0) {
        const primaryCount = providers.length;
        providers = primaryCount > 0
          ? [...providers, ...fallbackExtras]
          : applyRoutingDiversityScores(fallbackExtras, reqBody, requestedModel, isGroup);
        const fallbackNames = new Set(providers.map((provider) => provider.name));
        const fallbackGatedProviders = state.PROVIDERS.filter((provider) => provider?.name && !fallbackNames.has(provider.name));
        setRouteTrace(reqBody, requestedModel, rawProviders, providers, fallbackGatedProviders, currentTokens);
        const requestedLevel = assessmentRequestedLevel(reqBody._llmProxyDifficulty || routingPolicy.effectiveRequestProfile(reqBody));
        state.log(
          `AI-ASSESS-GATE-${primaryCount > 0 ? "BACKSTOP" : "FALLBACK"}: ${requestedModel} request_level=${requestedLevel} ` +
          `primary=${primaryCount} fallback=${fallbackExtras.length} providers=${providers.length} cooldown_cleared=${nearLevelFallback.cleared} ` +
          `stages=${nearLevelFallback.stages.join(",") || "none"} ` +
          `fallback_top=${fallbackExtras.slice(0, 5).map((provider) => provider.name).join(",")}`,
        );
      }
    }

    if (providers.length === 0) {
	      // Check if providers exist but context is too small even after compaction
	      const allProviders = requestedModel === "auto"
	        ? getProvidersForAuto(reqBody.messages, 0, reqBody)
	        : getProvidersForGroup(requestedModel, 0, reqBody);
      const gatedAllProviders = gateLargeModelProviders(allProviders, reqBody, requestedModel, isGroup);
      if (gatedAllProviders.length > 0) {
        const maxContext = Math.max(...gatedAllProviders.map((p) => scoring.getEffectiveContext(p)));
        const currentTokens = estimateRequestInputTokens(reqBody);
        const currentTotal = currentTokens + requestedMaxTokens;
        const compacted = await maybeApplyEmergencyContextCompaction(
          reqBody,
          requestedModel,
          requestedMaxTokens,
          mpSession,
          { ...options, bypassProxyOptimizations, isSummarizationRequest },
        );
        if (compacted) {
          return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
        }
        writeContextCompactionGuidance(clientRes, reqBody, {
          reason: "no_provider_fits_context",
          inputTokens: currentTokens,
          requestedTokens: currentTotal,
          maxContext,
        }, options);
        return;
      }
      return _sendError(clientRes, 503, "No providers available for group: " + requestedModel);
    }

    // Log routing decision with scoring rationale
    if (providers.length > 0) {
      state.log(formatRoutingProfileForLog(requestedModel, reqBody, currentTokens));
      const topCandidates = providers.slice(0, 5).map(formatProviderCandidateForLog);
      state.log(`ROUTING: ${requestedModel} candidates=[${topCandidates.join(", ")}] total=${providers.length} input=${currentTokens}tok`);
    }

    const errors = [];
    for (const provider of providers) {
      if (scoring.isOnCooldown(provider.name)) {
        state.log(`REROUTE-SKIP: ${provider.name} cooled during current route → trying next provider`);
        continue;
      }
      try {
        const pCtx = scoring.getEffectiveContext(provider);
        state.log(formatRoutingAssessmentForLog(provider, reqBody));
        state.log(`Route: ${requestedModel} → ${provider.name} (${provider.model}) via=${provider.name.split("-")[0]} ctx=${pCtx} stream_only=${!!scoring.getCompat(provider.name).stream_only}`);
        markRouteSelected(reqBody, provider);

        if (isStreaming) {
          if (canUseNativeStreaming(provider)) {
            await routeNativeStreamToProvider(provider, reqBody, clientRes);
            return;
          }
          const compat = scoring.getCompat(provider.name);
          if (compat.stream_only && canUseOpenAIStreaming(provider)) {
            // Known slow provider — go straight to streaming
            await routeStreamToProvider(provider, reqBody, clientRes);
            return;
          }
          // Try non-streaming first (enables full validation + retry)
          const quickResp = await Promise.race([
            routeToProvider(provider, reqBody, { allowAssessmentReroute: true }),
            new Promise((_, rej) => setTimeout(() => rej({
              timeout: true,
              message: `non-streaming validation timed out after ${nonStreamingFallbackTimeoutMs}ms`,
            }), nonStreamingFallbackTimeoutMs)),
          ]);
          sendAsSSE(clientRes, quickResp.body, provider, reqBody);
          return;
        } else {
          const resp = await routeToProvider(provider, reqBody, { allowAssessmentReroute: true });
          let usage = null;
          try { usage = JSON.parse(resp.body).usage; } catch {}
          clientRes.writeHead(resp.status, {
            "Content-Type": "application/json",
            ...buildUsageHeaders(provider, reqBody, usage),
          });
          clientRes.end(resp.body);
          return;
        }
      } catch (err) {
        let routeErr = err;
        if (err.hiddenContinuation && !err.headersSent) {
          if (await retryWithHiddenContinue(reqBody, clientRes, options, provider, err)) return;
        }
        if (err.memoryRecall) {
          const retries = reqBody._memoryRecallRetries || 0;
          if (retries < 1) {
            reqBody._memoryRecallRetries = retries + 1;
            recordMemoryRecallRetry(reqBody);
            try {
              const recallInjection = await memory.recallForMarker(mpSession, reqBody, err.memoryRecall);
              if (recallInjection) {
                reqBody._memoryInjection = [reqBody._memoryInjection, recallInjection].filter(Boolean).join("\n");
                recordMemoryInjection(reqBody, recallInjection);
                state.log(`REROUTE-MEMORY: recall injected for query="${err.memoryRecall.query.substring(0, 80)}"`);
                return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
              }
            } catch (recallErr) {
              state.log(`REROUTE-MEMORY: recall failed ${String(recallErr?.message || recallErr).substring(0, 100)}`);
            }
          }
          state.log(`REROUTE-MEMORY: retry budget exhausted for query="${err.memoryRecall.query.substring(0, 80)}"`);
        }
        if (err.rerouteAssessment) {
          reqBody._assessmentReroutes = (reqBody._assessmentReroutes || 0) + 1;
          if (err.rerouteProfile) {
            reqBody._llmProxyDifficulty = err.rerouteProfile;
          } else {
            try {
              reqBody._llmProxyDifficulty = routingPolicy.profileFromAssessmentMarker(reqBody, err.rerouteAssessment);
            } catch {}
          }
          state.log(`REROUTE-ASSESS: ${provider.name} requested level=${err.rerouteAssessment.level} effort=${err.rerouteAssessment.effort} speed=${err.rerouteAssessment.speed} → recomputing candidates`);
          return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
        }
        // Non-streaming timed out → mark provider as stream-only, fall back to real streaming
        if (err.timeout && isStreaming) {
          const c = scoring.getCompat(provider.name);
          if (!c.stream_only) {
            c.stream_only = true;
            scoring.saveCompat();
            state.log(`COMPAT: ${provider.name} marked stream_only (non-streaming timeout)`);
          }
          try {
            state.log(`Route: ${requestedModel} → ${provider.name} (streaming fallback)`);
            if (canUseOpenAIStreaming(provider)) {
              await routeStreamToProvider(provider, reqBody, clientRes);
              return;
            }
          } catch (streamErr) {
            if (streamErr.headersSent) { clientRes.end(); return; }
            routeErr = streamErr;
          }
        }
        if (routeErr.headersSent) { clientRes.end(); return; }
        const status = routeErrorStatus(routeErr);
        const msg = routeErrorText(routeErr);
        // Don't override longer cooldowns already set by routeToProvider/detectIncompatibility
        if (status === 429 && !scoring.isOnCooldown(provider.name)) scoring.setCooldown(provider.name);
        if (!routeErr.failureRecorded) scoring.recordFailure(provider.name, msg);
        const errFull = typeof msg === "string" ? msg.substring(0, 300) : String(msg).substring(0, 300);
        const isCtxErr = isContextOverflowErrorText(errFull);
        const isTimeout = !!routeErr.timeout || status === 504 || status === 502 || /timeout|idle/i.test(errFull);
        if (!routeErr.logged) state.log(`FAIL: ${provider.name} status=${status} ${isTimeout ? "TIMEOUT" : ""} ${errFull}`);
        markRouteFailure(reqBody, provider, status, errFull);
        errors.push({ provider: provider.name, status, error: typeof msg === "string" ? msg.substring(0, 200) : String(msg), timeout: isTimeout, context: isCtxErr });

        // Categorize error for routing decisions
        const isRateLimit = status === 429 || /rate.limit|too many requests/i.test(errFull);
        const isQuota = /usage limit|quota|reached the limit|MONTHLY|out of.*messages/i.test(errFull);
        const isSocketDrop = /socket hang up/i.test(errFull) && /codex/i.test(provider.name);

        if (isCtxErr) {
          state.log(`REROUTE: ${provider.name} context too large (${scoring.getEffectiveContext(provider)} ctx) → trying next provider with larger context`);
        } else if (isRateLimit) {
          state.log(`REROUTE: ${provider.name} rate limited → trying next provider`);
          if (isDirectClaudeLargeProvider(provider)) {
            const cooled = coolDirectClaudeLargePeers(provider);
            if (cooled > 1) reqBody._directClaudeRateLimitCohortCooled = true;
          }
        } else if (isQuota || isSocketDrop) {
          state.log(`REROUTE: ${provider.name} quota exhausted → trying next provider (cooldown 1h)`);
          scoring.setCooldown(provider.name, 3600_000);
        } else if (isTimeout) {
          state.log(`REROUTE: ${provider.name} timeout/502 → trying next provider`);
        } else {
          state.log(`REROUTE: ${provider.name} error ${status} → trying next provider`);
        }

        // Step 2: Mid-loop — after 2+ context errors from different providers,
        // compact at 80% of the failing provider's effective context and retry
        if (isCtxErr) {
          const ctxErrCount = errors.filter((e) => isContextOverflowErrorText(e.error)).length;
          const midRetries = reqBody._midCompactRetries || 0;
          if (ctxErrCount >= 2 && midRetries < 2 && reqBody.messages?.length > 4) {
            reqBody._midCompactRetries = midRetries + 1;
            const failedCtx = scoring.getEffectiveContext(provider);
            const target = Math.floor(failedCtx * 0.8);
            state.log(`MID-COMPACT: 2+ context errors → compacting to 80% of ${provider.name} ctx (${failedCtx} → target ${target}tok)`);
            let refs = [];
            try { refs = await memory.archiveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
            const originalMessages = reqBody.messages;
            const compacted = await compaction.compactMessagesAsync(originalMessages, target, requestedMaxTokens, refs, mpSession.id);
            if (compacted) {
              recordCompactionTelemetry(reqBody, "mid", refs, compacted);
              compaction.recordCompactionDrops(mpSession.id, originalMessages, compacted.messages);
              reqBody.messages = compacted.messages;
              const newEst = estimateRequestInputTokens(reqBody);
              state.log(`MID-COMPACT #${reqBody._midCompactRetries}: ${estTokens}tok → ${newEst}tok → retrying all providers`);
              return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
            }
          }
        }
        continue;
      }
    }

    if (reqBody._directClaudeRateLimitCohortCooled && (reqBody._directClaudeRateLimitFallbackRetries || 0) < 1) {
      reqBody._directClaudeRateLimitFallbackRetries = (reqBody._directClaudeRateLimitFallbackRetries || 0) + 1;
      state.log("REROUTE: direct Claude rate-limit cohort cooled → recomputing candidates");
      return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
    }

    // Step 4: ALL providers failed — progressive compaction at current effective context
    const contextErrors = errors.filter((e) => e.context || isContextOverflowErrorText(e.error));
    const contextOrTimeoutErrors = errors.filter((e) => e.context || e.timeout || isContextOverflowErrorText(e.error) || /too.long|timeout|idle|502|504/i.test(e.error) || e.status === 502 || e.status === 504);
    const isContextProblem = contextErrors.length > errors.length / 3;

    state.log(`ALL-FAILED: ${errors.length} errors (${contextOrTimeoutErrors.length} context/timeout, ${errors.length - contextOrTimeoutErrors.length} other) isContextProblem=${isContextProblem}`);

    if (isContextProblem && reqBody.messages?.length > 4) {
      const postRetries = reqBody._postCompactRetries || 0;
      const targets = [0.7, 0.55];
      if (postRetries < targets.length) {
        reqBody._postCompactRetries = postRetries + 1;
        reqBody._midCompactRetries = 0;
        const allP = requestedModel === "auto"
          ? getProvidersForAuto(reqBody.messages, 0, reqBody)
          : getProvidersForGroup(requestedModel, 0, reqBody);
        const maxCtx = Math.max(...allP.map((p) => scoring.getEffectiveContext(p)), 131072);
        const target = Math.floor(maxCtx * targets[postRetries]);

        state.log(`POST-COMPACT: all providers failed → compact to ${Math.round(targets[postRetries]*100)}% of max ctx ${maxCtx} = ${target}tok (attempt #${postRetries + 1})`);
        let refs = [];
        try { refs = await memory.archiveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
        const originalMessages = reqBody.messages;
        const compacted = await compaction.compactMessagesAsync(originalMessages, target, requestedMaxTokens, refs, mpSession.id);
        if (compacted) {
          recordCompactionTelemetry(reqBody, "post", refs, compacted);
          compaction.recordCompactionDrops(mpSession.id, originalMessages, compacted.messages);
          reqBody.messages = compacted.messages;
          const newEst = estimateRequestInputTokens(reqBody);
          state.log(`POST-COMPACT #${postRetries + 1}: ${estTokens}tok → ${newEst}tok → retrying all providers`);
          return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
        } else {
          state.log(`POST-COMPACT #${postRetries + 1}: compaction failed (messages too short to compact further)`);
        }
      }
    }

    // Step 5: Everything failed — surface controlled client guidance instead of
    // leaking upstream context-length errors into the IDE transcript.
    if (isContextProblem) {
      const maxContext = Math.max(...state.PROVIDERS.filter((p) => p.key && p.alive !== false).map((p) => scoring.getEffectiveContext(p)), 0);
      const currentEst = estimateRequestInputTokens(reqBody);
      state.log(`CONTEXT-EXHAUSTED: all compaction attempts exhausted. ${currentEst}tok + ${requestedMaxTokens}max_tokens > ${maxContext} max_ctx`);
      writeContextCompactionGuidance(clientRes, reqBody, {
        reason: "compaction_exhausted",
        inputTokens: currentEst,
        requestedTokens: currentEst + requestedMaxTokens,
        maxContext,
      }, options);
      return;
    }
    return _sendError(clientRes, 503, "All providers in group failed", { group: requestedModel, attempts: errors });
  }

  // Direct provider/model routing
  const primaryProvider = findProviderByModel(requestedModel);
  if (!primaryProvider) {
    return _sendError(clientRes, 404, "Model not found: " + requestedModel);
  }
  const directProviders = [primaryProvider];
  const seenDirectProviders = new Set([primaryProvider.name]);
  let lastDirectError = null;
  setRouteTrace(reqBody, requestedModel, directProviders, directProviders, [], currentTokens);

  for (let i = 0; i < directProviders.length; i += 1) {
    const provider = directProviders[i];
    if (i > 0 && scoring.isOnCooldown(provider.name)) {
      state.log(`REROUTE-SKIP: ${provider.name} cooled during direct fallback → trying next provider`);
      continue;
    }
    markRouteSelected(reqBody, provider);

    try {
      state.log(`Route: ${requestedModel} → ${provider.name} (${provider.model}) via=${provider.name.split("-")[0]}`);
      if (isStreaming) {
        if (canUseNativeStreaming(provider)) {
          await routeNativeStreamToProvider(provider, reqBody, clientRes);
        } else if (canUseOpenAIStreaming(provider)) {
          await routeStreamToProvider(provider, reqBody, clientRes);
        } else {
          const resp = await routeToProvider(provider, reqBody);
          sendAsSSE(clientRes, resp.body, provider, reqBody);
        }
      } else {
        const resp = await routeToProvider(provider, reqBody);
        let usage = null;
        try { usage = JSON.parse(resp.body).usage; } catch {}
        clientRes.writeHead(resp.status, {
          "Content-Type": "application/json",
          ...buildUsageHeaders(provider, reqBody, usage),
        });
        clientRes.end(resp.body);
      }
      return;
    } catch (err) {
      if (err.hiddenContinuation && !err.headersSent) {
        if (await retryWithHiddenContinue(reqBody, clientRes, options, provider, err)) return;
      }
      if (err.memoryRecall) {
        const retries = reqBody._memoryRecallRetries || 0;
        if (retries < 1) {
          reqBody._memoryRecallRetries = retries + 1;
          recordMemoryRecallRetry(reqBody);
          try {
            const recallInjection = await memory.recallForMarker(mpSession, reqBody, err.memoryRecall);
            if (recallInjection) {
              reqBody._memoryInjection = [reqBody._memoryInjection, recallInjection].filter(Boolean).join("\n");
              recordMemoryInjection(reqBody, recallInjection);
              state.log(`REROUTE-MEMORY: direct retry for query="${err.memoryRecall.query.substring(0, 80)}"`);
              return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
            }
          } catch (recallErr) {
            state.log(`REROUTE-MEMORY: direct recall failed ${String(recallErr?.message || recallErr).substring(0, 100)}`);
          }
        }
      }
      if (err.headersSent) { clientRes.end(); return; }
      const status = routeErrorStatus(err);
      const detail = routeErrorText(err);
      if (isContextOverflowErrorText(detail)) {
        markRouteFailure(reqBody, provider, status, typeof detail === "string" ? detail.substring(0, 200) : String(detail).substring(0, 200));
        if (!err.failureRecorded) scoring.recordFailure(provider.name, detail);
        const compacted = await maybeApplyEmergencyContextCompaction(
          reqBody,
          requestedModel,
          requestedMaxTokens,
          mpSession,
          { ...options, bypassProxyOptimizations, isSummarizationRequest },
        );
        if (compacted) {
          return await handleChatCompletion(reqBody, clientRes, { ...options, internal: true });
        }
        writeContextCompactionGuidance(clientRes, reqBody, {
          reason: "direct_provider_context_overflow",
          inputTokens: estimateRequestInputTokens(reqBody),
          requestedTokens: estimateRequestInputTokens(reqBody) + requestedMaxTokens,
          maxContext: scoring.getEffectiveContext(provider),
        }, options);
        return;
      }

      markRouteFailure(reqBody, provider, status, detail);
      if (!err.failureRecorded) scoring.recordFailure(provider.name, detail);
      const isRateLimit = status === 429 || /rate.limit|too many requests/i.test(String(detail));
      if (isRateLimit && !scoring.isOnCooldown(provider.name)) scoring.setCooldown(provider.name);
      lastDirectError = { provider, status, detail };

      if (isRateLimit && isDirectClaudeLargeProvider(provider) && (reqBody._directModelFallbackRetries || 0) < 1) {
        coolDirectClaudeLargePeers(provider);
        const fallbacks = getDirectModelFallbackProviders(requestedModel, provider, reqBody)
          .filter((candidate) => !seenDirectProviders.has(candidate.name));
        if (fallbacks.length > 0) {
          reqBody._directModelFallbackRetries = (reqBody._directModelFallbackRetries || 0) + 1;
          for (const fallback of fallbacks) {
            seenDirectProviders.add(fallback.name);
            directProviders.push(fallback);
          }
          const previousFailedSources = reqBody._routeTrace?.failed_sources || [];
          const previousFailures = reqBody._routeTrace?.failures || [];
          setRouteTrace(reqBody, requestedModel, [primaryProvider, ...fallbacks], directProviders, [], currentTokens);
          reqBody._routeTrace.failed_sources = previousFailedSources;
          reqBody._routeTrace.failures = previousFailures;
          state.log(
            `REROUTE-DIRECT: ${provider.name} rate limited → trying equivalent provider(s) ` +
            fallbacks.map((fallback) => fallback.name).join(", "),
          );
          continue;
        }
      }

      if (i + 1 < directProviders.length) continue;
      break;
    }
  }

  const provider = lastDirectError?.provider || primaryProvider;
  const status = lastDirectError?.status || 502;
  const detail = lastDirectError?.detail || "unknown";
  _sendError(clientRes, status, "Provider error", {
    provider: provider.name,
    detail: typeof detail === "string" ? detail.substring(0, 500) : undefined,
  });
}

function sendAsSSE(res, responseBody, provider, reqBody) {
  let usage = null;
  try { usage = JSON.parse(responseBody).usage; } catch {}
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...buildUsageHeaders(provider, reqBody, usage),
  });

  try {
    const data = JSON.parse(responseBody);
    const choice = data.choices?.[0];
    if (!choice) { res.write(`data: ${responseBody}\n\n`); res.write("data: [DONE]\n\n"); res.end(); return; }

    const content = messageContentText(choice.message?.content);
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

module.exports = {
  init,
  makeRequest,
  streamRequest,
  getProvidersForGroup,
  getProvidersForAuto,
  applyRoutingDiversityScores,
  gateLargeModelProviders,
  buildUsageHeaders,
  cachedInputTokensFromUsage,
  stripExternalProxyFields,
  stripCachedProxyArtifacts,
  dedupeConsecutiveIdempotentToolCalls,
  formatRoutingProfileForLog,
  formatRoutingAssessmentForLog,
  formatProviderCandidateForLog,
  findProviderByModel,
  isStructuredJsonResponseBody,
  routeToProvider,
  routeStreamToProvider,
  extractSseTextForDiagnostics,
  handleChatCompletion,
  sendAsSSE,
};
