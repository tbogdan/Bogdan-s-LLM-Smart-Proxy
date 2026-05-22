"use strict";

const http = require("http");
const https = require("https");
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
const mempalace = require("../llm-mempalace");

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
  const sid = mempalace.getSession(reqBody.messages)?.id;
  const ss = sid ? state.sessionStats[sid] : null;

  return {
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
  const toolChoice = reqBody.tool_choice;
  if (toolChoice === "required" || toolChoice === "any") return true;
  if (toolChoice && typeof toolChoice === "object") return true;
  const functionCall = reqBody.function_call;
  if (functionCall && functionCall !== "auto" && functionCall !== "none") return true;
  return false;
}

function isDirectNoToolRequest(reqBody = {}) {
  const hasToolHistory = (reqBody.messages || []).some((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls?.length > 0));
  if (hasToolHistory) return false;
  if (hasRequiredToolContract(reqBody)) return false;
  const profile = routingPolicy.effectiveRequestProfile(reqBody);
  return profile.taskKind === "direct_answer";
}

function budgetBodyForRequest(reqBody = {}) {
  if (!isDirectNoToolRequest(reqBody)) return reqBody;
  return { ...reqBody, tools: undefined, functions: undefined };
}

function estimateRequestInputTokens(reqBody = {}) {
  const budgetBody = budgetBodyForRequest(reqBody);
  return compaction.estimateTokens(budgetBody.messages) + compaction.estimateRequestSchemaTokens(budgetBody);
}

const EXTERNAL_PROXY_FIELD_RE = /^_(?:llmProxy|assessment|memoryInjection|sessionLastProvider|inputTokens|estimatedTokens|compactRetries|midCompactRetries|postCompactRetries|skipAISummary)/;

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
  try { refs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
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

function getProvidersForGroup(groupName, estimatedTokens, reqBody) {
  const cap = state.GROUPS[groupName];
  const directNoToolTask = isDirectNoToolRequest(reqBody);
  const routeCap = cap === "text-sm" || cap === "assessment" ? cap : (directNoToolTask ? "text" : cap);
  const scoreCap = routeCap === "coding-sm" || routeCap === "text-sm"
    ? routeCap.replace("-sm", "")
    : routeCap === "assessment" ? "text" : routeCap;
  const { caps: detectedCaps, isAgent, needsUpgrade } = transforms.detectUseCase(reqBody?.messages, reqBody);

  // All alive providers with enough context
  const all = state.PROVIDERS.filter((p) => p.key && p.alive !== false)
    .filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isRecentUnresolvedChronicStalling(p.name) && !scoring.isQuotaDisabled(p.name) && !scoring.isBannedFromGroup(p.name, groupName))
    .filter((p) => !(reqBody?._assessmentSkipProviders || []).includes(p.name));

  // Does request carry reasoning_content or need thinking?
  const hasReasoning = (reqBody?.messages || []).some((m) => m.reasoning_content);
  const needsThinking = routeCap === "thinking" || detectedCaps.has("thinking");
  const needsTools = routeCap === "tools" || routeCap === "coding-sm" || detectedCaps.has("tools") || isAgent;
  const hasToolHistory = (reqBody?.messages || []).some((m) => m.role === "assistant" && m.tool_calls?.length > 0);
  const requestCarriesTools = !directNoToolTask && (
    (reqBody?.tools?.length || 0) > 0 ||
    (reqBody?.functions?.length || 0) > 0 ||
    hasToolHistory ||
    (reqBody?.messages || []).some((m) => m.role === "tool")
  );
  let viable = requestCarriesTools ? all.filter((p) => (p.caps || []).includes("tools")) : all;
  if (routeCap === "assessment" || routeCap === "text-sm" || groupName === "auto-text") {
    viable = viable.filter((p) => !isHeavyTextProvider(p));
  }
  if (routeCap === "assessment") {
    const small = viable.filter((p) => isSmallAssessmentProvider(p));
    if (small.length > 0) viable = small;
  }
  const withContext = estimatedTokens > 0 ? viable.filter((p) => providerCanFitRoutedRequest(p, estimatedTokens, reqBody)) : viable;

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
  const hasToolHistory = (messages || []).some((m) => m.role === "assistant" && m.tool_calls?.length > 0);
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
  const withContext = estimatedTokens > 0 ? viable.filter((p) => providerCanFitRoutedRequest(p, estimatedTokens, reqBody)) : viable;

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
  const source = reqBody._llmProxyDifficulty ? "assessment" : "heuristic";
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
  const source = reqBody._llmProxyDifficulty ? "assessment" : "heuristic";
  const effort = profile.effort || profile.thinkingEffort || "unknown";
  const stepShape = profile.stepShape || {};
  return [
    `ASSESS: ${provider.name}`,
    `level=${profile.level}`,
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
  const multiplier = routingPolicy.costMultiplierForProvider(provider);
  const cost = multiplier === null ? String(profile.cost_group) : `${profile.cost_group},x=${multiplier}`;
  return `${provider.name}(${provider.model},ctx=${ctx},score=${finalScore.toFixed(2)},base=${baseScore.toFixed(2)},cost=${cost},quality=${profile.quality_group},think=${profile.thinking_effort},speed=${profile.speed_group})`;
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
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part?.type === "text")
        .map((part) => part.text || "")
        .join("\n");
    }
  }
  return "";
}

function normalizeRoutingText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }
  return "";
}

const PROXY_CACHE_ARTIFACT_LINE_RE =
  /^\s*(?:proxy suppressed invalid tool call "[^"]+": .+|tool call error:\s+the model attempted to call "[^"]+".+|llm_proxy_task_difficulty\b.*)\s*$/i;

function stripProxyArtifactLines(text = "") {
  const lines = String(text || "").split(/\n/);
  const kept = lines.filter((line) => !PROXY_CACHE_ARTIFACT_LINE_RE.test(line));
  if (kept.length === lines.length) return { changed: false, text: String(text || "") };
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

function looksLikeSubstantiveReport(content = "") {
  const text = String(content || "").trim();
  if (text.length < 140) return false;
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

function asksIdentityQuestion(reqBody = {}) {
  const userText = normalizeRoutingText(lastUserText(reqBody));
  return /\b(who are you|what is your name|your name|identity|cum te cheama|cum te numesti|cine esti|numele tau|ce nume ai)\b/.test(userText);
}

function asksExactReply(reqBody = {}) {
  const text = lastUserText(reqBody);
  return /^\s*(reply exactly|say exactly)\b/i.test(text) || /^\s*(hello|hi|ok|ping)[\s.!?]*$/i.test(text);
}

function isProxyIdentityAnswer(content = "") {
  return /\bProject\s+llm\s+smart\s+proxy\b/.test(normalizeRoutingText(content));
}

function allowsTextOnlyAnswer(reqBody = {}, content = "", marker = null) {
  if (hasRequiredToolContract(reqBody)) return false;
  if (marker && marker.level <= 2) return true;
  const profile = routingPolicy.effectiveRequestProfile(reqBody);
  if (profile.taskKind === "direct_answer" || profile.stepShape?.shape === "direct") return true;
  if (asksExactReply(reqBody)) return true;
  if (asksIdentityQuestion(reqBody) && isProxyIdentityAnswer(content)) return true;
  if (looksLikeSubstantiveReport(content)) return true;
  const userText = normalizeRoutingText(lastUserText(reqBody));
  const asksForReport = /(analiz|analyse|analyze|strategi|strategy|plan|descri|describe|explic|explain|review|audit|recomand|recommend|summary|summar|sintez|diagnos|root cause|cauz)/.test(userText);
  const asksForEdit = /(implementeaz|implement|modific|modify|fix|repar|editeaz|edit|scrie|write|creeaz|create|adauga|add|sterge|delete|remove|ruleaz|run|execut|deploy|commit|build|testeaz|test)/.test(userText);
  const substantive = content.length >= 500 && /(^|\n)\s*(#{1,4}\s|[-*]\s|\d+\.\s|\*\*)/m.test(content);
  return asksForReport && !asksForEdit && substantive;
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

function shouldUseAiTaskAssessment(reqBody = {}, requestedModel = "", isGroup = false, heuristic = {}) {
  const mode = String(process.env.LLM_PROXY_AI_ASSESSMENT || "auto").trim().toLowerCase();
  if (mode === "0" || mode === "false" || mode === "off" || mode === "disabled") return false;
  if (!isGroup) return false;
  if (reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary || reqBody._llmProxyDifficulty) return false;
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) return false;

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
  return requestedAutoCoding && largeOrToolCached && (riskyHeuristic || noisyRoutingDiagnostic);
}

function buildAiTaskAssessmentRequest(reqBody = {}, heuristic = {}) {
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const allowedReasons = Object.keys(routingPolicy.TASK_KIND_TARGETS).join(", ");
  const system = [
    "You are an LLM proxy routing classifier.",
    "You are invisible to the user. Return minified JSON only, with no prose and no markdown.",
    "Schema: {\"level\":1-5,\"taskLevel\":1-5,\"contextLevel\":1-5,\"effort\":\"none|minimal|low|medium|high|xhigh\",\"speed\":1-5,\"reason\":\"one_allowed_reason\"}.",
    "taskLevel is only the current user task complexity. contextLevel is transcript/tool/cache pressure. level is max(taskLevel, contextLevel).",
    "Never raise taskLevel just because input_tokens, estimated_tokens, tools, cached IDE content, or old logs are large.",
    "The reason value must be one item from allowed_reasons; never output the literal words slug or one_allowed_reason.",
    "Classify the current user request, not stale assistant/tool output, cached IDE transcript, or prior proxy diagnostics.",
    "Treat tokens like ROUTING-PROFILE, ASSESS, reason=security_review, task=security_review, shape=security, and provider names as diagnostic evidence unless the user explicitly asks for a real security review.",
  ].join("\n");
  const user = [
    `requested_model=${reqBody.model || "auto"}`,
    `input_tokens=${Number(reqBody._inputTokens || 0)}`,
    `estimated_tokens=${Number(reqBody._estimatedTokens || 0)}`,
    `tools=${toolCount}`,
    `allowed_reasons=${allowedReasons}`,
    "",
    "Current user message:",
    truncatedForAssessment(lastUserText(reqBody), 2200),
  ].join("\n");

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

function selectAiTaskAssessmentProviders(assessmentReq = {}) {
  const model = assessmentReq.model || "auto-assess";
  const estimated = estimateRequestInputTokens(assessmentReq) + Number(assessmentReq.max_tokens || 80);
  if (model === "auto") return getProvidersForAuto(assessmentReq.messages, estimated, assessmentReq).slice(0, 3);
  if (model in state.GROUPS) {
    const candidates = getProvidersForGroup(model, estimated, assessmentReq);
    return reorderAssessmentProviders(model, candidates).slice(0, 3);
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

async function applyAiTaskAssessmentIfNeeded(reqBody = {}, requestedModel = "", isGroup = false) {
  const heuristic = routingPolicy.assessRequestDifficulty(reqBody.messages || [], reqBody);
  if (!shouldUseAiTaskAssessment(reqBody, requestedModel, isGroup, heuristic)) return null;
  const profile = await requestAiTaskAssessment(reqBody, heuristic);
  if (!profile) return null;
  reqBody._llmProxyDifficulty = profile;
  logAssessmentProfile(profile);
  return profile;
}

function cachePostRouteAssessment(reqBody = {}, provider = {}, markerProfile = null, stream = false, origin = "post_route") {
  if (!markerProfile || reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return null;
  let session;
  try { session = mempalace.getSession(reqBody.messages); } catch { session = null; }
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
  };
  state.log(`AI-ASSESS-CACHE: stored ${origin === "post_route_fallback" ? "fallback " : ""}post-route assessment from ${provider.name || "unknown"} for session ${session.id}`);
  return cachedProfile;
}

function applyCachedPostRouteAssessmentIfAvailable(reqBody = {}, requestedModel = "", isGroup = false) {
  if (!isGroup || reqBody._llmProxyDifficulty || reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary) return null;
  let session;
  try { session = mempalace.getSession(reqBody.messages); } catch { session = null; }
  const entry = session?.id ? state.sessionAssessmentCache[session.id] : null;
  if (!entry?.profile) return null;

  const ageMs = Date.now() - Number(entry.timestamp || 0);
  const currentUserText = lastUserText(reqBody);
  if (ageMs > 600_000 || (entry.lastUserText && entry.lastUserText !== currentUserText)) {
    delete state.sessionAssessmentCache[session.id];
    state.log(`AI-ASSESS-CACHE-DROP: stale post-route assessment for session ${session.id}`);
    return null;
  }

  delete state.sessionAssessmentCache[session.id];
  reqBody._llmProxyDifficulty = entry.profile;
  state.log(`AI-ASSESS-CACHE-HIT: session ${session.id} provider=${entry.provider || "unknown"} age_ms=${ageMs}`);
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
    const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
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
      inputTokens: reqBody._inputTokens,
      estimatedTokens: reqBody._estimatedTokens,
      providerContext: scoring.getEffectiveContext(provider),
      hasTools: toolCount > 0,
    });
    try { mempalace.saveError(mempalace.getSession(reqBody.messages), errPreview); } catch {}
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

  const invalidTool = validateGeneratedToolCalls(resp.body, reqBody);
  if (invalidTool) {
    state.log(`TOOL-INVALID: ${provider.name} ${invalidTool} — reroute`);
    scoring.recordToolInvalid(provider.name, invalidTool);
    scoring.recordFailure(provider.name, invalidTool);
    scoring.setCooldown(provider.name, 300_000, "invalid tool arguments");
    throw { status: 422, body: invalidTool, latency, logged: true, failureRecorded: true };
  }

  let postRouteMarkerProfile = null;
  const markerResult = routingPolicy.stripDifficultyMarkerFromResponseBody(resp.body);
  if (markerResult.marker) {
    resp.body = markerResult.body;
    const markerProfile = routingPolicy.profileFromAssessmentMarker(reqBody, markerResult.marker);
    postRouteMarkerProfile = markerProfile;
    state.log(
      `ASSESS: ${provider.name} level=${markerProfile.level} effort=${markerProfile.thinkingEffort} speed=${markerProfile.speedTarget} ` +
      `reason=${markerProfile.reason || "none"} task=${markerProfile.taskKind || "general"} cost=${markerProfile.costTarget} thinking=${markerProfile.thinkingLevel}`,
    );
    try {
      const parsed = JSON.parse(resp.body);
      const choice = parsed.choices?.[0] || null;
      const textContent = messageContentText(choice?.message?.content);
      const hasToolCalls = (choice?.message?.tool_calls?.length || 0) > 0;
      if (!hasToolCalls && textContent.trim().length === 0) {
        scoring.recordStalling(provider.name);
        state.log(`MARKER-ONLY: ${provider.name} returned assessment without assistant content — reroute`);
        throw { status: 422, body: resp.body, latency, stalling: true, logged: true };
      }
    } catch (e) {
      if (e.status) throw e;
    }
    if (options.allowAssessmentReroute && routingPolicy.shouldRerouteForMarker(provider, markerProfile, reqBody)) {
      reqBody._llmProxyDifficulty = markerProfile;
      reqBody._assessmentReroutes = (reqBody._assessmentReroutes || 0) + 1;
      reqBody._assessmentSkipProviders = [...(reqBody._assessmentSkipProviders || []), provider.name];
      throw { status: 409, body: "routing assessment requested stronger/different provider", latency, rerouteAssessment: markerProfile, logged: true };
    }
  }

  // Stalling detection — model says "Let me check" and stops without acting
  if (reqBody?.tools?.length > 0 || reqBody?.functions?.length > 0) {
    let choice = null;
    let textContent = "";
    let hasToolCalls = false;
    let textOnlyAllowed = false;
    try {
      const parsed = JSON.parse(resp.body);
      choice = parsed.choices?.[0] || null;
      textContent = messageContentText(choice?.message?.content);
      hasToolCalls = (choice?.message?.tool_calls?.length || 0) > 0;
      textOnlyAllowed = allowsTextOnlyAnswer(reqBody, textContent, markerResult.marker);
    } catch {}

    if (choice && asksIdentityQuestion(reqBody) && !hasToolCalls && textContent.trim().length > 0 && !isProxyIdentityAnswer(textContent)) {
      scoring.recordStalling(provider.name);
      state.log(`IDENTITY-MISMATCH: ${provider.name} responded with non-proxy identity while tools were available — reroute`);
      throw { status: 422, body: resp.body, latency, stalling: true };
    }

    if (!textOnlyAllowed) {
      const stallingDetected = transforms.detectStalling(resp.body);
      if (stallingDetected) {
        scoring.recordStalling(provider.name);
        throw { status: 422, body: resp.body, latency, stalling: true };
      }
    }

    if (choice && textOnlyAllowed && !hasToolCalls && textContent.length > 20 && reqBody.tools?.length > 0) {
      state.log(`TEXT-ONLY-OK: ${provider.name} accepted text response (${textContent.length} chars) with ${reqBody.tools.length} tools available`);
    }

    // Text-only response when tools are available means the provider is a poor fit
    // for agent requests; fail over before the IDE treats it as progress.
    if (choice && !textOnlyAllowed && !hasToolCalls && textContent.length > 20) {
      scoring.recordStalling(provider.name);
      state.log(`NO-TOOLS: ${provider.name} responded with text-only (${textContent.length} chars) when ${reqBody.tools?.length || 0} tools available — stalling+retry`);
      throw { status: 422, body: resp.body, latency, stalling: true };
    }
  }

  // Detect garbled output in non-streaming response
  try {
    const parsed = JSON.parse(resp.body);
    const message = parsed.choices?.[0]?.message || {};
    const content = messageContentText(message.content) + (message.reasoning || "") + (message.reasoning_content || "");
    if (content.length > 30 && compaction.detectGarbledText(content)) {
      state.log(`GARBLE-DETECTED: ${provider.name} content="${content.substring(0, 100)}..."`);
      scoring.recordFailure(provider.name, "garbled output");
      scoring.setCooldown(provider.name, 3600_000, "garbled output");
      throw { status: 502, body: resp.body, latency, garbled: true, failureRecorded: true };
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
    const sid = mempalace.getSession(reqBody.messages).id;
    const inTok = usage?.prompt_tokens || estimateRequestInputTokens(body);
    const outTok = usage?.completion_tokens || 0;
    _trackSessionTokens(sid, inTok, outTok, provider.name);
    recordCachedInputTokens(sid, provider.name, cachedTokens);
  }

  // Session affinity — remember which provider worked
  try { mempalace.setLastProvider(mempalace.getSession(reqBody.messages), provider.name); } catch {}
  // Track in sessionStats for reliable cross-request lookups
  try { const sid = mempalace.getSession(reqBody.messages).id; if (state.sessionStats[sid]) state.sessionStats[sid].lastProvider = provider.name; } catch {}

  // MemPalace: save after successful response
  try {
    const s = mempalace.getSession(reqBody.messages);
    reqBody._servedProvider = provider.name;
    mempalace.triggerSaves(s, reqBody, resp.body);
  } catch { /* graceful degradation */ }

  // Thinking detection
  if (provider.tc && transforms.detectThinking(resp.body)) {
    scoring.recordThinkingOk(provider.name);
  }

  return resp;
}

function createStreamDifficultyMarkerFilter(providerName, onMarker) {
  let pending = "";
  let decided = false;
  let logged = false;
  const markerRe = /^\s*LLM_PROXY_TASK_DIFFICULTY\s+level=[1-5]\s+effort=(?:none|minimal|low|medium|high|xhigh)\s+speed=[1-5](?:\s+reason=[a-z0-9_.:-]+)?(?:\r?\n|[\s:;,\-.]+)?/i;

  function maybeMarkerPrefix(text) {
    const trimmed = String(text || "").trimStart();
    if (!trimmed) return true;
    if ("LLM_PROXY_TASK_DIFFICULTY".startsWith(trimmed.toUpperCase())) return true;
    return /^LLM_PROXY_TASK_DIFFICULTY\b/i.test(trimmed) && !/[\r\n]/.test(trimmed) && trimmed.length < 260;
  }

  function filterContent(content) {
    if (decided) return content;
    pending += content;
    const markerMatch = pending.match(markerRe);
    if (markerMatch) {
      decided = true;
      const marker = routingPolicy.parseDifficultyMarker(markerMatch[0]);
      const split = routingPolicy.splitAttachedUppercaseFromMarkerText(markerMatch[0]);
      const visible = split.attachedText + pending.slice(markerMatch[0].length);
      pending = "";
      if (!logged) {
        state.log(`ASSESS-STREAM: ${providerName} stripped private difficulty marker`);
        logged = true;
      }
      if (marker && typeof onMarker === "function") {
        try { onMarker(marker); } catch {}
      }
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

  return function filterSseChunk(chunkText) {
    const out = [];
    for (const line of String(chunkText).split("\n")) {
      if (!line.startsWith("data: ")) {
        out.push(line);
        continue;
      }
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") {
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
    const filterDifficultyMarker = createStreamDifficultyMarkerFilter(provider.name, (marker) => { streamAssessmentMarker = marker; });
    const streamToolCalls = createStreamToolCallAccumulator(reqBody);

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
          if (dataChunks >= 3 && !streamToolCalls.hasPendingToolCalls()) {
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

        scoring.recordSuccess(provider.name, latency);
        scoring.recordPolicyUse(provider);

        if (dataChunks <= 2) {
          const scLen = streamedContent.replace(/\\[nrt"]/g, "").length;
          state.log(`LOW-CHUNKS: ${provider.name} ${dataChunks} chunks ${latency}ms — streamedContent=${scLen}chars tools=${hasToolCallsInStream} headersSent=${headersSent}`);
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
          scoring.recordStalling(provider.name);
        } else if (thinkingOnly && dataChunks < 20 && latency < 15000) {
          // Fast response with only thinking/reasoning, no real content = garbled thinking
          state.log(`THINKING-ONLY: ${provider.name} ${dataChunks} chunks ${latency}ms — only reasoning, no content. Likely garbled.`);
          scoring.recordStalling(provider.name);
          scoring.setCooldown(provider.name, 300_000, "thinking-only stream");
        } else if (!hasToolCallsInStream && hasRealContent && reqBody?.tools?.length > 0 && dataChunks >= 1 && !allowsTextOnlyAnswer(reqBody, streamedContent, null)) {
          state.log(`NO-TOOLS-STREAM: ${provider.name} text-only (${dataChunks} chunks) with ${reqBody.tools.length} tools available`);
        } else if (dataChunks > 10 && hasRealContent) {
          if (streamedContent.length > 200 && compaction.detectGarbledText(streamedContent)) {
            state.log(`GARBLE-STREAM: ${provider.name} ${dataChunks} chunks — garbled content detected post-stream`);
            scoring.recordStalling(provider.name);
            scoring.setCooldown(provider.name, 900_000, "garbled stream output");
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
          const sid = mempalace.getSession(reqBody.messages).id;
          const inTok = streamUsage?.prompt_tokens || estimateRequestInputTokens(transformedBody);
          const outTok = streamUsage?.completion_tokens || 0;
          _trackSessionTokens(sid, inTok, outTok, provider.name);
          recordCachedInputTokens(sid, provider.name, cachedTokens);
        } catch {}

        try { mempalace.setLastProvider(mempalace.getSession(reqBody.messages), provider.name); } catch {}
        try { const sid2 = mempalace.getSession(reqBody.messages).id; if (state.sessionStats[sid2]) state.sessionStats[sid2].lastProvider = provider.name; } catch {}
        try {
          const session = mempalace.getSession(reqBody.messages);
          reqBody._servedProvider = provider.name;
          const saveBody = hasToolCallsInStream
            ? streamToolCalls.asResponseBody()
            : syntheticAssistantResponse(streamedVisibleContent || streamedContent);
          mempalace.triggerSaves(session, reqBody, saveBody);
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
          inputTokens: reqBody._inputTokens,
          estimatedTokens: reqBody._estimatedTokens,
          providerContext: scoring.getEffectiveContext(provider),
          hasTools: ((reqBody.tools?.length || 0) + (reqBody.functions?.length || 0)) > 0,
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
  const start = Date.now();
  let headersSent = false;
  let chunks = 0;
  let streamedContent = "";
  let streamAssessmentMarker = null;
  const filterDifficultyMarker = createStreamDifficultyMarkerFilter(provider.name, (marker) => { streamAssessmentMarker = marker; });

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
      ...buildUsageHeaders(provider, transformedBody, null),
    });
    headersSent = true;
  }

  try {
    await providerAdapters.routeNativeStream(provider, transformedBody, {
      onChunk(chunk) {
        const filteredChunk = filterDifficultyMarker(String(chunk || ""));
        if (!filteredChunk) return;
        writeHeaders();
        chunks += 1;
        streamedContent += extractSseTextForDiagnostics(filteredChunk);
        clientRes.write(filteredChunk);
      },
    });
  } catch (error) {
    const latency = Date.now() - start;
    scoring.recordFailure(provider.name, error.body || error.message || "native stream error");
    if (headersSent) {
      state.log(`NATIVE-STREAM-ERR: ${provider.name} ${latency}ms headersSent=true chunks=${chunks} err=${String(error.message || error).substring(0, 100)}`);
      try { clientRes.write("data: [DONE]\n\n"); } catch {}
      clientRes.end();
      throw { headersSent: true };
    }
    state.log(`NATIVE-STREAM-ERR: ${provider.name} ${latency}ms status=${error.status || 502} chunks=${chunks} err=${String(error.message || error).substring(0, 100)}`);
    throw {
      status: error.status || 502,
      body: Buffer.isBuffer(error.body) ? error.body.toString("utf8") : (error.body || error.message || "native stream error"),
      latency,
      logged: true,
    };
  }

  const latency = Date.now() - start;
  scoring.recordSuccess(provider.name, latency);
  scoring.recordPolicyUse(provider);
  try {
    const sid = mempalace.getSession(reqBody.messages).id;
    const inTok = estimateRequestInputTokens(transformedBody);
    const outTok = streamedContent.trim() ? estimateTextTokens(streamedContent) : 0;
    _trackSessionTokens(sid, inTok, outTok, provider.name);
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
  try { mempalace.setLastProvider(mempalace.getSession(reqBody.messages), provider.name); } catch {}
  try { const sid2 = mempalace.getSession(reqBody.messages).id; if (state.sessionStats[sid2]) state.sessionStats[sid2].lastProvider = provider.name; } catch {}
  try {
    const session = mempalace.getSession(reqBody.messages);
    reqBody._servedProvider = provider.name;
    mempalace.triggerSaves(session, reqBody, syntheticAssistantResponse(streamedContent));
  } catch {}
  if (streamedContent.length > 200 && compaction.detectGarbledText(streamedContent)) {
    state.log(`GARBLE-NATIVE-STREAM: ${provider.name} chunks=${chunks} — garbled content detected post-stream`);
    scoring.recordStalling(provider.name);
    scoring.setCooldown(provider.name, 900_000, "garbled native stream output");
  }
  const estimatedOut = streamedContent.trim() ? estimateTextTokens(streamedContent) : 0;
  state.log(`NATIVE-STREAM-OK: ${provider.name} ${latency}ms chunks=${chunks} usage[out_est=${estimatedOut}]`);
  if (!headersSent) {
    writeHeaders();
    clientRes.write("data: [DONE]\n\n");
  }
  clientRes.end();
}

async function handleChatCompletion(reqBody, clientRes, options = {}) {
  if (!options.internal) {
    reqBody = stripExternalProxyFields(reqBody || {});
  }

  const requestedModel = reqBody.model || "auto";
  const isStreaming = reqBody.stream === true;
  const isGroup = requestedModel in state.GROUPS || requestedModel === "auto";
  const bypassProxyOptimizations = !!reqBody._llmProxyBypassOptimizations;

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
    const banSid = mempalace.getSession(reqBody.messages)?.id;
    const banSs = banSid ? state.sessionStats[banSid] : null;
    const banProvider = banSs?.lastProvider;

    // Always strip "ban ai XX" from all messages (clears IDE cache residue)
    reqBody.messages = reqBody.messages.map(m => {
      if (typeof m.content === "string" && BAN_RE.test(m.content)) {
        const cleaned = m.content.replace(BAN_RE, "").trim();
        return cleaned ? { ...m, content: cleaned } : null;
      }
      if (Array.isArray(m.content)) {
        const parts = m.content.map(p => p.type === "text" && BAN_RE.test(p.text) ? { ...p, text: p.text.replace(BAN_RE, "").trim() } : p).filter(p => p.type !== "text" || p.text);
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
          .map((p) => p?.type === "text" && BAN_RE.test(p.text || "") ? { ...p, text: (p.text || "").replace(BAN_RE, "").trim() } : p)
          .filter((p) => p?.type !== "text" || p.text);
      }
    }
  }

  if (!bypassProxyOptimizations) stripCachedProxyArtifacts(reqBody);
  if (!bypassProxyOptimizations) dedupeConsecutiveIdempotentToolCalls(reqBody);

  const estTokens = estimateRequestInputTokens(reqBody);
  const requestedMaxTokens = reqBody.max_tokens || 4096;
  const totalNeeded = estTokens + requestedMaxTokens;
  reqBody._inputTokens = estTokens;
  reqBody._estimatedTokens = totalNeeded; // pass to scoring for context-aware ranking

  // Session compact cache: if IDE sends context we already compacted,
  // replace old portion with compact version, keep only truly new messages
  const sid = mempalace.getSession(reqBody.messages)?.id;
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
    } else if (cacheAge >= 600_000) {
      delete state.sessionCompactCache[sid];
    }
  }
  if (!bypassProxyOptimizations && sid && reqBody.messages?.length > 20) {
    reqBody.messages = compaction.applyCachedTruncations(reqBody.messages);
    reqBody.messages = compaction.applyCompactionDrops(sid, reqBody.messages);
  }

  // Re-estimate after potential cache hit
  let currentTokens = estimateRequestInputTokens(reqBody);
  let currentTotalNeeded = currentTokens + requestedMaxTokens;
  reqBody._inputTokens = currentTokens;
  reqBody._estimatedTokens = currentTotalNeeded;

  if (!bypassProxyOptimizations) {
    applyCachedPostRouteAssessmentIfAvailable(reqBody, requestedModel, isGroup);
    await applyAiTaskAssessmentIfNeeded(reqBody, requestedModel, isGroup);
  }

  // Detect summarization requests — IDE asking to compact/summarize context
  // These bypass context limits entirely (the whole point is to summarize large context)
  const lastMsg = reqBody.messages?.[reqBody.messages.length - 1];
  const lastContent = messageContentText(lastMsg?.content).trim();
  const isSummarizationRequest = lastContent.length < 200 && /\b(summariz|what did we|what have we|recap|context|compaction|condense|shorten|compress|so far|up to now|overview of .*(session|conversation|work|progress))\b/i.test(lastContent);

  // MemPalace: recall memories and inject into context
  const mpSession = mempalace.getSession(reqBody.messages);

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
      state.log(`IDE-COMPACT: input ${currentTokens}tok > 90% of best ${requestedModel} ctx ${bestCtx} — returning context_length_exceeded`);
      const body = JSON.stringify({
        error: {
          message: `This model's maximum context length is ${bestCtx} tokens. However, you requested ${currentTokens + requestedMaxTokens} tokens (${currentTokens} in the messages, ${requestedMaxTokens} in the completion). Please reduce the length of the messages or completion.`,
          type: "invalid_request_error",
          param: "messages",
          code: "context_length_exceeded",
        },
      });
      clientRes.writeHead(400, { "Content-Type": "application/json" });
      clientRes.end(body);
      return;
    }
  }

  // Create/update session metadata before routing; successful providers record usage.
  _trackSessionTokens(mpSession.id, 0, 0);
  // Get last provider from session stats (more reliable than mempalace session objects)
  const ss = state.sessionStats[mpSession.id];
  reqBody._sessionLastProvider = ss?.lastProvider || mempalace.getLastProvider(mpSession);
  let memoryInjection = "";
  if (!bypassProxyOptimizations) {
    try {
      memoryInjection = await mempalace.recallMemories(mpSession, reqBody);
    } catch { /* graceful degradation */ }
  }
  if (memoryInjection) reqBody._memoryInjection = memoryInjection;

  // Save project context on first request of session
  if (mpSession.requestCount === 1) {
    const sysMsg = reqBody.messages?.find((m) => m.role === "system");
    if (sysMsg) mempalace.saveProjectContext(mpSession, messageContentText(sysMsg.content));
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
          mempalace.saveStalling(stallingProvider, banGroup, "repeated stalling");
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
    let providers = requestedModel === "auto"
      ? getProvidersForAuto(reqBody.messages, currentTotalNeeded, reqBody)
      : getProvidersForGroup(requestedModel, currentTotalNeeded, reqBody);

    if (providers.length === 0) {
      // Check if providers exist but context is too small even after compaction
      const allProviders = requestedModel === "auto"
        ? getProvidersForAuto(reqBody.messages, 0, reqBody)
        : getProvidersForGroup(requestedModel, 0, reqBody);
      if (allProviders.length > 0) {
        const maxContext = Math.max(...allProviders.map((p) => scoring.getEffectiveContext(p)));
        const currentTokens = estimateRequestInputTokens(reqBody);
        const currentTotal = currentTokens + requestedMaxTokens;
        // Return OpenAI-compatible context_length_exceeded error
        // This triggers context compaction in OpenAI-compatible IDE clients.
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
      return _sendError(clientRes, 503, "No providers available for group: " + requestedModel);
    }

    // Log routing decision with scoring rationale
    if (providers.length > 0) {
      state.log(formatRoutingProfileForLog(requestedModel, reqBody, currentTokens));
      const top3 = providers.slice(0, 3).map(formatProviderCandidateForLog);
      state.log(`ROUTING: ${requestedModel} candidates=[${top3.join(", ")}] total=${providers.length} input=${currentTokens}tok`);
    }

    const errors = [];
    for (const provider of providers) {
      try {
        const pCtx = scoring.getEffectiveContext(provider);
        state.log(formatRoutingAssessmentForLog(provider, reqBody));
        state.log(`Route: ${requestedModel} → ${provider.name} (${provider.model}) via=${provider.name.split("-")[0]} ctx=${pCtx} stream_only=${!!scoring.getCompat(provider.name).stream_only}`);

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
            new Promise((_, rej) => setTimeout(() => rej({ timeout: true }), 60_000)),
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
        if (err.rerouteAssessment) {
          state.log(`REROUTE-ASSESS: ${provider.name} requested level=${err.rerouteAssessment.level} effort=${err.rerouteAssessment.effort} speed=${err.rerouteAssessment.speed} → recomputing candidates`);
          return await handleChatCompletion(reqBody, clientRes, { internal: true });
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
          }
        }
        if (err.headersSent) { clientRes.end(); return; }
        const status = err.status || err.statusCode || 500;
        const msg = err.body || err.error?.message || String(err);
        // Don't override longer cooldowns already set by routeToProvider/detectIncompatibility
        if (status === 429 && !scoring.isOnCooldown(provider.name)) scoring.setCooldown(provider.name);
        if (!err.failureRecorded) scoring.recordFailure(provider.name, msg);
        const errFull = typeof msg === "string" ? msg.substring(0, 300) : String(msg).substring(0, 300);
        if (!err.logged) state.log(`FAIL: ${provider.name} status=${status} ${err.timeout ? "TIMEOUT" : ""} ${errFull}`);
        errors.push({ provider: provider.name, status, error: typeof msg === "string" ? msg.substring(0, 200) : String(msg) });

        // Categorize error for routing decisions
        const CTX_ERR_RE = /context.length|context window|input exceeds|too.large|maximum.*token|too large for model/i;
        const isCtxErr = CTX_ERR_RE.test(errFull);
        const isRateLimit = status === 429 || /rate.limit|too many requests/i.test(errFull);
        const isQuota = /usage limit|quota|reached the limit|MONTHLY|out of.*messages/i.test(errFull);
        const isSocketDrop = /socket hang up/i.test(errFull) && /codex/i.test(provider.name);
        const isTimeout = status === 504 || status === 502 || /timeout|idle/i.test(errFull);

        if (isCtxErr) {
          state.log(`REROUTE: ${provider.name} context too large (${scoring.getEffectiveContext(provider)} ctx) → trying next provider with larger context`);
        } else if (isRateLimit) {
          state.log(`REROUTE: ${provider.name} rate limited → trying next provider`);
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
          const ctxErrCount = errors.filter((e) => CTX_ERR_RE.test(e.error)).length;
          const midRetries = reqBody._midCompactRetries || 0;
          if (ctxErrCount >= 2 && midRetries < 2 && reqBody.messages?.length > 4) {
            reqBody._midCompactRetries = midRetries + 1;
            const failedCtx = scoring.getEffectiveContext(provider);
            const target = Math.floor(failedCtx * 0.8);
            state.log(`MID-COMPACT: 2+ context errors → compacting to 80% of ${provider.name} ctx (${failedCtx} → target ${target}tok)`);
            let refs = [];
            try { refs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
            const originalMessages = reqBody.messages;
            const compacted = await compaction.compactMessagesAsync(originalMessages, target, requestedMaxTokens, refs, mpSession.id);
            if (compacted) {
              compaction.recordCompactionDrops(mpSession.id, originalMessages, compacted.messages);
              reqBody.messages = compacted.messages;
              const newEst = estimateRequestInputTokens(reqBody);
              state.log(`MID-COMPACT #${reqBody._midCompactRetries}: ${estTokens}tok → ${newEst}tok → retrying all providers`);
              return await handleChatCompletion(reqBody, clientRes, { internal: true });
            }
          }
        }
        continue;
      }
    }

    // Step 4: ALL providers failed — progressive compaction at current effective context
    const CTX_ERR_RE2 = /context.length|too.long|token.*exceed|max.size.*token|too.large|timeout|idle|502|504/i;
    const contextOrTimeoutErrors = errors.filter((e) => CTX_ERR_RE2.test(e.error) || e.status === 502 || e.status === 504);
    const isContextProblem = contextOrTimeoutErrors.length > errors.length / 3;

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
        try { refs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
        const originalMessages = reqBody.messages;
        const compacted = await compaction.compactMessagesAsync(originalMessages, target, requestedMaxTokens, refs, mpSession.id);
        if (compacted) {
          compaction.recordCompactionDrops(mpSession.id, originalMessages, compacted.messages);
          reqBody.messages = compacted.messages;
          const newEst = estimateRequestInputTokens(reqBody);
          state.log(`POST-COMPACT #${postRetries + 1}: ${estTokens}tok → ${newEst}tok → retrying all providers`);
          return await handleChatCompletion(reqBody, clientRes, { internal: true });
        } else {
          state.log(`POST-COMPACT #${postRetries + 1}: compaction failed (messages too short to compact further)`);
        }
      }
    }

    // Step 5: Everything failed — return context_length_exceeded to trigger IDE compaction
    if (isContextProblem) {
      const maxContext = Math.max(...state.PROVIDERS.filter((p) => p.key && p.alive !== false).map((p) => scoring.getEffectiveContext(p)), 0);
      const currentEst = estimateRequestInputTokens(reqBody);
      state.log(`CONTEXT-EXCEEDED: all compaction attempts exhausted. ${currentEst}tok + ${requestedMaxTokens}max_tokens > ${maxContext} max_ctx — returning context_length_exceeded to IDE`);
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
    return _sendError(clientRes, 503, "All providers in group failed", { group: requestedModel, attempts: errors });
  }

  // Direct provider/model routing
  const provider = findProviderByModel(requestedModel);
  if (!provider) {
    return _sendError(clientRes, 404, "Model not found: " + requestedModel);
  }

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
  } catch (err) {
    if (err.headersSent) { clientRes.end(); return; }
    const status = err.status || err.statusCode || 502;
    scoring.recordFailure(provider.name, err.body || err.error?.message || "unknown");
    if (status === 429) scoring.setCooldown(provider.name);
    _sendError(clientRes, status, "Provider error", { provider: provider.name, detail: typeof err.body === "string" ? err.body.substring(0, 500) : undefined });
  }
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
  buildUsageHeaders,
  cachedInputTokensFromUsage,
  stripExternalProxyFields,
  stripCachedProxyArtifacts,
  dedupeConsecutiveIdempotentToolCalls,
  formatRoutingProfileForLog,
  formatRoutingAssessmentForLog,
  formatProviderCandidateForLog,
  findProviderByModel,
  routeToProvider,
  routeStreamToProvider,
  extractSseTextForDiagnostics,
  handleChatCompletion,
  sendAsSSE,
};
