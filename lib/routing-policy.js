"use strict";

const EFFORT_LEVELS = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
};

const LEVEL_TO_EFFORT = ["none", "minimal", "low", "medium", "high", "xhigh"];

const DIFFICULTY_LABELS = {
  1: "trivial",
  2: "simple",
  3: "standard",
  4: "complex",
  5: "deep",
};

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeEffort(value, fallback = "medium") {
  const text = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EFFORT_LEVELS, text)) return text;
  return fallback;
}

function effortLevel(value, fallback = "medium") {
  return EFFORT_LEVELS[normalizeEffort(value, fallback)];
}

function effortForLevel(level) {
  return LEVEL_TO_EFFORT[Math.max(0, Math.min(5, Number(level) || 0))] || "medium";
}

function getPolicyTargets(env = process.env) {
  const thinkingTarget = normalizeEffort(env.LLM_THINKING_TARGET, "medium");
  return {
    costTarget: clampInt(env.LLM_COST_TARGET, 1, 5, 3),
    thinkingTarget,
    thinkingTargetLevel: effortLevel(thinkingTarget),
    speedTarget: clampInt(env.LLM_SPEED_TARGET, 1, 5, 4),
    routingPolicy: String(env.LLM_ROUTING_POLICY || "balanced").trim().toLowerCase() || "balanced",
  };
}

function providerText(provider = {}) {
  return [
    provider.name,
    provider.model,
    provider.upstream_model,
    provider.windsurf_model_uid,
    provider.family,
  ].filter(Boolean).join(" ").toLowerCase();
}

function classifyProvider(provider = {}) {
  const text = providerText(provider);
  const explicitCost = clampInt(provider.cost_group, 1, 5, 0);
  const explicitQuality = clampInt(provider.quality_group, 1, 5, 0);
  const explicitSpeed = clampInt(provider.speed_group, 1, 5, 0);
  let costGroup = explicitCost || 3;
  let qualityGroup = explicitQuality || 3;
  let speedGroup = explicitSpeed || 3;
  let effort = normalizeEffort(provider.thinking_effort, "");

  if (!explicitCost) {
    if (/gpt[- _.]?5[- _.]?[45].*pro/.test(text)) costGroup = 5;
    else if (/gpt[- _.]?5[- _.]?5/.test(text)) costGroup = 4;
    else if (/claude.*opus.*4[- _.]?[5-9]|opus[- _.]?4[- _.]?[5-9]/.test(text)) costGroup = 4;
    else if (/gpt[- _.]?5[- _.]?4.*mini/.test(text)) costGroup = 2;
    else if (/gpt[- _.]?5[- _.]?4(?!.*mini)/.test(text)) costGroup = 3;
    else if (/claude.*sonnet.*4[- _.]?[5-9]|sonnet[- _.]?4[- _.]?[5-9]/.test(text)) costGroup = 3;
    else if (/claude.*haiku.*4[- _.]?5|haiku[- _.]?4[- _.]?5/.test(text)) costGroup = 2;
    else if (/gemini.*flash|flash[- _.]?lite/.test(text)) costGroup = 1;
    else if (/gemini.*pro/.test(text)) costGroup = 3;
    else if (/minimax.*m2[- _.]?5/.test(text)) costGroup = 1;
    else if (/glm[- _.]?5|zai.*glm/.test(text)) costGroup = 2;
    else if (/grok.*code.*fast/.test(text)) costGroup = 2;
    else if (/swe[- _.]?1(?:[- _.]?[0-9])?/.test(text)) costGroup = 1;
    else if (/nano|lite|small/.test(text)) costGroup = 1;
    else if (/haiku|mini|fast|grok/.test(text)) costGroup = 2;
    else if (/gpt[- _.]?5[- _.]?3|gpt[- _.]?5[- _.]?2|codex|adaptive|auto[-_]?review/.test(text)) costGroup = 3;
    else if (/opus|pro/.test(text)) costGroup = 4;
  }

  if (!explicitQuality) {
    if (/gpt[- _.]?5[- _.]?[45].*pro/.test(text)) qualityGroup = 5;
    else if (/gpt[- _.]?5[- _.]?5/.test(text)) qualityGroup = 5;
    else if (/gpt[- _.]?5[- _.]?4.*mini/.test(text)) qualityGroup = 3;
    else if (/gpt[- _.]?5[- _.]?4(?!.*mini)/.test(text)) qualityGroup = 5;
    else if (/claude.*opus|opus[- _.]?4/.test(text)) qualityGroup = 5;
    else if (/gemini.*pro/.test(text)) qualityGroup = 5;
    else if (/claude.*sonnet|sonnet[- _.]?4/.test(text)) qualityGroup = 4;
    else if (/gpt[- _.]?5[- _.]?[23].*codex|auto[-_]?review|code[-_]?review/.test(text)) qualityGroup = 4;
    else if (/gemini.*flash|glm[- _.]?5|zai.*glm|minimax.*m2[- _.]?5/.test(text)) qualityGroup = 4;
    else if (/swe[- _.]?1[- _.]?[56]/.test(text)) qualityGroup = 4;
    else if (/claude.*haiku|haiku[- _.]?4|gpt[- _.]?5[- _.]?2/.test(text)) qualityGroup = 3;
    else if (/grok.*code.*fast|swe[- _.]?1(?![- _.]?[56])/.test(text)) qualityGroup = 3;
    else if (/nano|lite|small/.test(text)) qualityGroup = 2;
  }

  if (!explicitSpeed) {
    if (/gpt[- _.]?5[- _.]?[45].*pro/.test(text)) speedGroup = 1;
    else if (/claude.*haiku|haiku[- _.]?4|gemini.*flash|flash[- _.]?lite|grok.*code.*fast|swe[- _.]?1[- _.]?[56].*fast/.test(text)) speedGroup = 5;
    else if (/gpt[- _.]?5[- _.]?5|gpt[- _.]?5[- _.]?4.*mini|claude.*sonnet|sonnet[- _.]?4|glm[- _.]?5|zai.*glm|minimax.*m2[- _.]?5|swe[- _.]?1[- _.]?[56]|priority/.test(text)) speedGroup = 4;
    else if (/gpt[- _.]?5[- _.]?4(?!.*mini)|gemini.*pro|claude.*opus|opus[- _.]?4/.test(text)) speedGroup = 3;
    else if (/nano|lite|small|mini|fast/.test(text)) speedGroup = 5;
    else if (/pro|xhigh|1m|max/.test(text)) speedGroup = 2;
  }

  if (!effort) {
    const suffix = text.match(/\b(none|minimal|low|medium|high|xhigh)\b/);
    if (suffix) effort = suffix[1];
    else if (/gpt[- _.]?5[- _.]?[45].*pro/.test(text)) effort = "xhigh";
    else if (/claude.*opus|opus[- _.]?4/.test(text)) effort = "xhigh";
    else if (/gemini.*pro/.test(text)) effort = "high";
    else if (/gpt[- _.]?5[- _.]?[23].*codex|auto[-_]?review|code[-_]?review/.test(text)) effort = "high";
    else if (/gpt[- _.]?5[- _.]?4.*mini/.test(text)) effort = "low";
    else if (/gpt[- _.]?5[- _.]?[45]|claude.*sonnet|sonnet[- _.]?4|gemini.*flash|glm[- _.]?5|zai.*glm|minimax.*m2[- _.]?5|swe[- _.]?1[- _.]?[56]|adaptive/.test(text)) effort = "medium";
    else if (/gpt[- _.]?5[- _.]?2/.test(text)) effort = "medium";
    else if (/haiku|mini|fast|grok/.test(text)) effort = "low";
    else effort = provider.tc || provider.caps?.includes("thinking") ? "medium" : "none";
  }

  return {
    cost_group: costGroup,
    quality_group: qualityGroup,
    speed_group: speedGroup,
    thinking_effort: effort,
    thinking_level: effortLevel(effort),
  };
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
  }
  return "";
}

function normalizeTaskText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function detectTaskKind(messages = [], reqBody = {}) {
  const allText = normalizeTaskText(messages.map((message) => textContent(message.content)).join("\n"));
  const lastText = normalizeTaskText(textContent(messages[messages.length - 1]?.content));
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const hasTools = toolCount > 0;
  const hasToolHistory = messages.some((message) => message.role === "tool" || message.tool_calls?.length > 0);
  const completionSignal = /\b(finalizat|terminat|completed|done|finished|implemented|fixed|schimbari|modificari|changes|actualizat|adaugat|reparat|implementat|rulat|tests?\s+passed)\b/.test(allText);
  const reviewSignal = /\b(verific|verifica|verify|review|audit|validat|validate|check|inspect|confirm|regression|regresie|auto[-_ ]?review|code[-_ ]?review)\b/.test(lastText);
  const listSummarySignal = /\b(lista|listeaza|list|tasks?|taskuri|todo|sumar|sumariz|summari[sz]e|summary|status|progres|progress|raport|recap)\b/.test(lastText);
  const editSignal = /\b(implementeaz|implement|modific|modify|fix|repar|editeaz|edit|scrie|write|creeaz|create|adauga|add|sterge|delete|remove|ruleaz|run|execut|deploy|commit|build|testeaz|test|refactor|debug)\b/.test(lastText);
  const codingSignal = /\b(code|cod|api|endpoint|component|docker|typescript|javascript|python|repo|codebase|files?|tool|claude code|cursor|windsurf)\b/.test(allText);

  if (reviewSignal && completionSignal) return "completion_review";
  if (listSummarySignal && !editSignal) return "list_summary";
  if (reviewSignal) return "verification";
  if (hasTools || hasToolHistory || editSignal || codingSignal) return "agentic_coding";
  return "general";
}

function assessRequestDifficulty(messages = [], reqBody = {}) {
  const last = messages[messages.length - 1];
  const allText = messages.map((message) => textContent(message.content)).join("\n").toLowerCase();
  const lastText = textContent(last?.content).toLowerCase();
  const inputEstimate = Number(reqBody._inputTokens || 0);
  const estimated = inputEstimate > 0 ? inputEstimate : Number(reqBody._estimatedTokens || 0);
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const hasTools = toolCount > 0;
  const hasToolHistory = messages.some((message) => message.role === "tool" || message.tool_calls?.length > 0);
  let taskLevel = 2;
  let contextLevel = 1;

  if (/^\s*(reply exactly|raspunde exact|say exactly|hello|hi|ok|ping)\b/i.test(lastText) && estimated < 1000 && !hasTools) taskLevel = 1;
  if (/\b(explain|summariz|translate|rewrite|format|simple|quick)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 2);
  if (/\b(code|implement|fix|debug|test|api|endpoint|component|docker|typescript|javascript|python|refactor)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 3);
  if (hasTools || hasToolHistory || /\b(agent|codebase|repo|files?|tool|claude code|cursor|windsurf)\b/i.test(allText)) taskLevel = Math.max(taskLevel, 3);
  if ((hasTools || hasToolHistory) && (toolCount >= 50 || estimated > 30000)) contextLevel = Math.max(contextLevel, 4);
  if (/\b(multi[- ]?file|multiple files?|cross[- ]?file|architecture|migration|security|concurrency|streaming|proxy|auth|authentication|performance|race|root cause|regression)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 4);
  if (/\b(deep research|prove|formal|cryptograph|distributed|compiler|database migration|production incident|hard bug)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 5);
  if (estimated > 150000) contextLevel = Math.max(contextLevel, 5);
  else if (estimated > 60000) contextLevel = Math.max(contextLevel, 4);
  else if (estimated > 12000) contextLevel = Math.max(contextLevel, 3);

  const level = Math.max(taskLevel, contextLevel);

  let thinkingLevel = taskLevel <= 1 ? 0 : taskLevel === 2 ? 2 : taskLevel === 3 ? 3 : taskLevel === 4 ? 4 : 5;
  let speedTarget = taskLevel <= 2 ? 5 : taskLevel === 3 ? 4 : taskLevel === 4 ? 3 : 2;
  let costTarget = taskLevel <= 2 ? 2 : taskLevel === 3 ? 3 : taskLevel === 4 ? 4 : 5;
  if (contextLevel >= 5) {
    thinkingLevel = Math.max(thinkingLevel, 4);
    speedTarget = Math.min(speedTarget, 3);
    costTarget = Math.max(costTarget, 4);
  }

  return {
    level,
    label: DIFFICULTY_LABELS[level],
    taskKind: detectTaskKind(messages, reqBody),
    taskLevel,
    contextLevel,
    thinkingEffort: effortForLevel(thinkingLevel),
    thinkingLevel,
    speedTarget,
    costTarget,
  };
}

function effectiveRequestProfile(reqBody = {}, env = process.env) {
  const targets = getPolicyTargets(env);
  const assessed = reqBody._llmProxyDifficulty || assessRequestDifficulty(reqBody.messages || [], reqBody);
  const level = clampInt(assessed.level, 1, 5, 3);
  const taskLevel = clampInt(assessed.taskLevel, 1, 5, level);
  const contextLevel = clampInt(assessed.contextLevel, 1, 5, level);
  const taskCost = clampInt(assessed.costTarget, 1, 5, level <= 2 ? 2 : level);
  const taskSpeed = clampInt(assessed.speedTarget, 1, 5, level <= 2 ? 5 : 3);
  const taskThinking = assessed.thinkingLevel != null
    ? clampInt(assessed.thinkingLevel, 0, 5, level)
    : effortLevel(assessed.effort || assessed.thinkingEffort, effortForLevel(Math.min(5, level)));

  return {
    ...assessed,
    level,
    taskLevel,
    contextLevel,
    qualityTarget: contextLevel >= 5 ? Math.max(4, taskLevel) : Math.max(2, Math.min(5, taskLevel)),
    costTarget: level <= 2 ? Math.min(targets.costTarget, taskCost) : Math.max(targets.costTarget, taskCost),
    speedTarget: level <= 2 ? Math.max(targets.speedTarget, taskSpeed) : Math.min(targets.speedTarget, taskSpeed),
    thinkingLevel: level <= 2 ? Math.min(targets.thinkingTargetLevel, taskThinking) : Math.max(targets.thinkingTargetLevel, taskThinking),
  };
}

function providerPolicyBonus(provider, reqBody = {}, options = {}) {
  const env = options.env || process.env;
  const usage = options.usage || {};
  const profile = classifyProvider(provider);
  const request = effectiveRequestProfile(reqBody, env);
  const taskLevel = Number(request.taskLevel || request.level || 3);
  const taskKind = request.taskKind || "general";
  const text = providerText(provider);
  const isSwe = /\bswe[- _.]?1(?:[- _.]?[0-9])?\b/.test(text);
  const isAutoReview = /(?:auto[-_ ]?review|code[-_ ]?review|codex[-_/]?auto[-_]?review)/.test(text);
  let bonus = 0;

  bonus -= Math.abs(profile.cost_group - request.costTarget) * 0.12;
  bonus -= Math.abs(profile.quality_group - request.qualityTarget) * 0.08;
  bonus -= Math.abs(profile.thinking_level - request.thinkingLevel) * 0.10;
  bonus -= Math.abs(profile.speed_group - request.speedTarget) * 0.07;

  if (taskLevel <= 2) {
    if (profile.cost_group <= request.costTarget) bonus += 0.20;
    if (profile.speed_group >= 4) bonus += 0.16;
    if (profile.cost_group >= 5) bonus -= 0.45;
    if (profile.quality_group >= 5) bonus -= 0.12;
    if (profile.thinking_level >= 4) bonus -= 0.16;
  } else if (taskLevel >= 4) {
    if (profile.quality_group >= request.qualityTarget) bonus += 0.20;
    if (profile.thinking_level >= request.thinkingLevel) bonus += 0.28;
    if (profile.cost_group >= request.costTarget) bonus += 0.18;
    if (profile.quality_group < request.qualityTarget - 1) bonus -= 0.35;
    if (profile.thinking_level < request.thinkingLevel - 1) bonus -= 0.55;
    if (profile.cost_group < request.costTarget - 1) bonus -= 0.35;
  }

  const avgCost = Number(usage.ewma_cost_group || 0);
  const envTarget = getPolicyTargets(env).costTarget;
  if (avgCost > 0) {
    if (avgCost > envTarget + 0.25) bonus += (envTarget - profile.cost_group) * 0.05;
    if (avgCost < envTarget - 0.25 && request.level >= 4) bonus += (profile.cost_group - envTarget) * 0.04;
  }

  if (isSwe) {
    if (taskKind === "list_summary") bonus += 0.60;
    else if (taskKind === "agentic_coding") bonus -= 0.45;
    else if (taskKind === "completion_review" || taskKind === "verification") bonus -= 0.35;
    else bonus -= 0.18;
  }

  if (isAutoReview) {
    if (taskKind === "completion_review") bonus += 0.75;
    else if (taskKind === "verification") bonus += 0.35;
    else if (taskKind === "agentic_coding") bonus -= 0.25;
    else bonus -= 0.12;
  }

  return bonus;
}

function parseDifficultyMarker(text) {
  const match = String(text || "").match(/^\s*LLM_PROXY_TASK_DIFFICULTY\s+level=([1-5])\s+effort=(none|minimal|low|medium|high|xhigh)\s+speed=([1-5])(?:\s+reason=([a-z0-9_.:-]+))?/i);
  if (!match) return null;
  const level = Number(match[1]);
  const effort = normalizeEffort(match[2]);
  const speed = Number(match[3]);
  return {
    level,
    label: DIFFICULTY_LABELS[level],
    effort,
    thinkingEffort: effort,
    thinkingLevel: effortLevel(effort),
    speed,
    speedTarget: speed,
    costTarget: level <= 2 ? 2 : level,
    reason: match[4] || "",
  };
}

function stripDifficultyMarkerFromResponseBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, marker: null };
  }
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") return { body, marker: null };
  const marker = parseDifficultyMarker(content);
  if (!marker) return { body, marker: null };
  const markerMatch = content.match(/^\s*LLM_PROXY_TASK_DIFFICULTY\s+level=[1-5]\s+effort=(?:none|minimal|low|medium|high|xhigh)\s+speed=[1-5](?:\s+reason=[a-z0-9_.:-]+)?/i);
  const newlineIndex = content.indexOf("\n");
  const stripped = (newlineIndex >= 0
    ? content.slice(newlineIndex + 1)
    : content.slice(markerMatch ? markerMatch[0].length : 0).replace(/^[\s:;,\-.]+/, "")
  ).trimStart();
  choice.message.content = stripped;
  return { body: JSON.stringify(parsed), marker };
}

function shouldRerouteForMarker(provider, marker, reqBody = {}) {
  if (!marker || (reqBody._assessmentReroutes || 0) >= 2) return false;
  const profile = classifyProvider(provider);
  const costGap = Number(marker.costTarget || marker.level || 3) - profile.cost_group;
  const thinkingGap = Number(marker.thinkingLevel || effortLevel(marker.effort || marker.thinkingEffort, "medium")) - profile.thinking_level;
  if (marker.level >= 5 && (costGap >= 2 || thinkingGap >= 2)) return true;
  if (marker.level >= 4 && costGap >= 2 && thinkingGap >= 1) return true;
  if (thinkingGap >= 2) return true;
  if (costGap >= 3) return true;
  if (marker.level <= 2 && profile.cost_group >= 5) return true;
  return false;
}

module.exports = {
  EFFORT_LEVELS,
  getPolicyTargets,
  classifyProvider,
  detectTaskKind,
  assessRequestDifficulty,
  effectiveRequestProfile,
  providerPolicyBonus,
  parseDifficultyMarker,
  stripDifficultyMarkerFromResponseBody,
  shouldRerouteForMarker,
};
