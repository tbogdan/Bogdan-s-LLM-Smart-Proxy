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
  const profile = routingPolicy.assessRequestDifficulty(reqBody.messages || [], reqBody);
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

function getProvidersForGroup(groupName, estimatedTokens, reqBody) {
  const cap = state.GROUPS[groupName];
  const directNoToolTask = isDirectNoToolRequest(reqBody);
  const routeCap = directNoToolTask ? "text" : cap;
  const scoreCap = routeCap === "coding-sm" ? "coding" : routeCap;
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
  const viable = requestCarriesTools ? all.filter((p) => (p.caps || []).includes("tools")) : all;
  const withContext = estimatedTokens > 0 ? viable.filter((p) => providerCanFitRoutedRequest(p, estimatedTokens, reqBody)) : viable;

  // Score each provider: base score + smartness + group match + detected caps + agent boost + compat
  const scored = withContext.map((p) => {
    let bonus = 0;
    const compat = scoring.getCompat(p.name);

    // Benchmark-backed model scoring for this group's category
    bonus += transforms.smartnessBonus(p, scoreCap, reqBody);
    bonus += scoring.providerPolicyBonus(p, reqBody);

    // Group capability match: strong bonus for matching, but don't exclude non-matching
    if (routeCap === "coding-sm") {
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

  return scored.sort((a, b) => b.score - a.score).map((s) => withRoutingScore(s.provider, s.score));
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

  return scored.sort((a, b) => b.score - a.score).map((s) => withRoutingScore(s.provider, s.score));
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
  ].join(" ");
}

function routingAssessmentReason(profile = {}) {
  if (profile.reason) return String(profile.reason);
  if (profile.taskKind === "direct_answer") return "exact_reply";
  return String(profile.taskKind || profile.label || "general")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "general";
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
  ].join(" ");
}

function formatProviderCandidateForLog(provider) {
  const ctx = scoring.getEffectiveContext(provider);
  const finalScore = Number.isFinite(provider._lastRoutingScore) ? provider._lastRoutingScore : scoring.providerScore(provider);
  const baseScore = scoring.providerScore(provider);
  const profile = routingPolicy.classifyProvider(provider);
  return `${provider.name}(${provider.model},ctx=${ctx},score=${finalScore.toFixed(2)},base=${baseScore.toFixed(2)},cost=${profile.cost_group},quality=${profile.quality_group},think=${profile.thinking_effort},speed=${profile.speed_group})`;
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

  const markerResult = routingPolicy.stripDifficultyMarkerFromResponseBody(resp.body);
  if (markerResult.marker) {
    resp.body = markerResult.body;
    const markerProfile = routingPolicy.profileFromAssessmentMarker(reqBody, markerResult.marker);
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

function createStreamDifficultyMarkerFilter(providerName) {
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
      const split = routingPolicy.splitAttachedUppercaseFromMarkerText(markerMatch[0]);
      const visible = split.attachedText + pending.slice(markerMatch[0].length);
      pending = "";
      if (!logged) {
        state.log(`ASSESS-STREAM: ${providerName} stripped private difficulty marker`);
        logged = true;
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
    const filterDifficultyMarker = createStreamDifficultyMarkerFilter(provider.name);
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
  const filterDifficultyMarker = createStreamDifficultyMarkerFilter(provider.name);

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
  const currentTokens = estimateRequestInputTokens(reqBody);
  const currentTotalNeeded = currentTokens + requestedMaxTokens;
  reqBody._inputTokens = currentTokens;
  reqBody._estimatedTokens = currentTotalNeeded;

  // Detect summarization requests — IDE asking to compact/summarize context
  // These bypass context limits entirely (the whole point is to summarize large context)
  const lastMsg = reqBody.messages?.[reqBody.messages.length - 1];
  const lastContent = messageContentText(lastMsg?.content).trim();
  const isSummarizationRequest = lastContent.length < 200 && /\b(summariz|what did we|what have we|recap|context|compaction|condense|shorten|compress|so far|up to now|overview of .*(session|conversation|work|progress))\b/i.test(lastContent);

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

  // MemPalace: recall memories and inject into context
  const mpSession = mempalace.getSession(reqBody.messages);

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

  // No pre-routing compaction — only compact reactively:
  // 1. Post-routing in transformRequest (per-provider effective context)
  // 2. On context_length_exceeded error from provider (retry with compaction)

  if (isGroup) {
    // auto group: detect use case, try all providers with smart ordering
    let providers = requestedModel === "auto"
      ? getProvidersForAuto(reqBody.messages, currentTotalNeeded, reqBody)
      : getProvidersForGroup(requestedModel, currentTotalNeeded, reqBody);

    // No pre-routing compaction — let IDE handle context management.
    // Post-routing compaction in transformRequest() handles per-provider fitting as safety net.

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
