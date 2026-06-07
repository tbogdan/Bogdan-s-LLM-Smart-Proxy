"use strict";

const mediaContent = require("./media-content");

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

const ROUTING_POLICIES = new Set(["economy", "balanced", "speed", "quality"]);

const ROUTING_POLICY_ALIASES = {
  cheap: "economy",
  cost: "economy",
  economy: "economy",
  efficient: "economy",
  lowcost: "economy",
  "low-cost": "economy",
  savings: "economy",
  balanced: "balanced",
  default: "balanced",
  fast: "speed",
  latency: "speed",
  speed: "speed",
  throughput: "speed",
  capability: "quality",
  frontier: "quality",
  premium: "quality",
  quality: "quality",
};

const TASK_KIND_TARGETS = {
  direct_answer: { taskLevel: 1, contextLevel: 1, thinkingLevel: 0, speedTarget: 5, costTarget: 2 },
  list_summary: { taskLevel: 2, contextLevel: 1, thinkingLevel: 1, speedTarget: 5, costTarget: 1 },
  translation_rewrite: { taskLevel: 2, contextLevel: 1, thinkingLevel: 1, speedTarget: 5, costTarget: 2 },
  explanation: { taskLevel: 2, contextLevel: 1, thinkingLevel: 2, speedTarget: 4, costTarget: 2 },
  documentation: { taskLevel: 2, contextLevel: 1, thinkingLevel: 2, speedTarget: 4, costTarget: 2 },
  vision_analysis: { taskLevel: 2, contextLevel: 2, thinkingLevel: 2, speedTarget: 4, costTarget: 2 },
  image_generation: { taskLevel: 2, contextLevel: 1, thinkingLevel: 1, speedTarget: 4, costTarget: 2 },
  video_generation: { taskLevel: 3, contextLevel: 2, thinkingLevel: 2, speedTarget: 3, costTarget: 3 },
  data_analysis: { taskLevel: 3, contextLevel: 2, thinkingLevel: 3, speedTarget: 4, costTarget: 3 },
  verification: { taskLevel: 3, contextLevel: 1, thinkingLevel: 3, speedTarget: 4, costTarget: 3 },
  completion_review: { taskLevel: 3, contextLevel: 1, thinkingLevel: 3, speedTarget: 4, costTarget: 3 },
  code_review: { taskLevel: 4, contextLevel: 2, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  test_generation: { taskLevel: 3, contextLevel: 2, thinkingLevel: 3, speedTarget: 4, costTarget: 3 },
  debugging: { taskLevel: 4, contextLevel: 2, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  security_review: { taskLevel: 4, contextLevel: 2, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  refactor: { taskLevel: 4, contextLevel: 2, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  deployment_ops: { taskLevel: 4, contextLevel: 2, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  research: { taskLevel: 4, contextLevel: 2, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  benchmarking: { taskLevel: 4, contextLevel: 3, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  planning: { taskLevel: 4, contextLevel: 2, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  agentic_coding: { taskLevel: 3, contextLevel: 2, thinkingLevel: 3, speedTarget: 4, costTarget: 3 },
  edit_recovery: { taskLevel: 4, contextLevel: 3, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  architecture_recovery: { taskLevel: 4, contextLevel: 3, thinkingLevel: 4, speedTarget: 3, costTarget: 4 },
  general: { taskLevel: 2, contextLevel: 1, thinkingLevel: 2, speedTarget: 4, costTarget: 2 },
};

const TOOL_HEAVY_TASKS = new Set([
  "agentic_coding",
  "debugging",
  "refactor",
  "test_generation",
  "security_review",
  "deployment_ops",
  "benchmarking",
  "edit_recovery",
  "architecture_recovery",
]);

const FRONTIER_TASKS = new Set([
  "edit_recovery",
  "architecture_recovery",
  "security_review",
  "debugging",
  "refactor",
  "benchmarking",
]);

const TEXT_EFFICIENT_TASKS = new Set([
  "direct_answer",
  "list_summary",
  "translation_rewrite",
  "explanation",
  "documentation",
  "vision_analysis",
  "image_generation",
  "video_generation",
  "general",
]);

const PASSIVE_NO_TOOL_TASKS = new Set([
  "direct_answer",
  "list_summary",
  "translation_rewrite",
  "explanation",
  "documentation",
  "general",
]);

const STEP_SHAPE_PROFILES = {
  direct: {
    shape: "direct",
    valueCenter: "response",
    posture: "type_cheap",
    gate: "none",
    summary: "Direct answer: keep the prompt and output lean.",
  },
  read_heavy: {
    shape: "read_heavy",
    valueCenter: "understanding",
    posture: "think_expensive",
    gate: "plan_split",
    summary: "Think expensive: spend reasoning on understanding, dependencies, risks, and split points before output volume.",
  },
  write_heavy: {
    shape: "write_heavy",
    valueCenter: "typing",
    posture: "type_cheap",
    gate: "run_behavior",
    summary: "Type cheap: keep implementation narrow, avoid extra exploration, and verify behavior after the change.",
  },
  review: {
    shape: "review",
    valueCenter: "verification",
    posture: "validate_adversarially",
    gate: "read_diff",
    summary: "Validate adversarially: read the diff, compare summary against changes, and attack regressions before polish.",
  },
  validation: {
    shape: "validation",
    valueCenter: "verification",
    posture: "validate_adversarially",
    gate: "deterministic_validator",
    summary: "Validate deterministically: rely on tests, typechecks, schemas, logs, and reproducible behavior, not self-grading.",
  },
  security: {
    shape: "security",
    valueCenter: "risk",
    posture: "human_gate",
    gate: "human_signoff",
    summary: "Security gate: treat auth, permissions, secrets, and injection paths as human sign-off work.",
  },
  destructive: {
    shape: "destructive",
    valueCenter: "risk",
    posture: "human_gate",
    gate: "dry_run_first",
    summary: "Destructive gate: require dry-run, rollback, blast-radius notes, and human sign-off before real changes.",
  },
  benchmark: {
    shape: "benchmark",
    valueCenter: "comparison",
    posture: "measure_first",
    gate: "benchmark_compare",
    summary: "Measure first: keep arms comparable and report correctness, latency, tokens, cost, and model mix.",
  },
};

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeCostMultiplier(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function costMultiplierForProvider(provider = {}) {
  return normalizeCostMultiplier(
    provider.cost_multiplier ??
      provider.costMultiplier ??
      provider.billing?.multiplier ??
      provider.billing_multiplier,
  );
}

function costGroupFromCostMultiplier(multiplier) {
  const value = normalizeCostMultiplier(multiplier);
  if (value === null) return 0;
  if (value <= 0) return 1;
  if (value < 1) return 2;
  if (value <= 1) return 3;
  if (value <= 4) return 4;
  return 5;
}

function costMultiplierBudgetForTarget(costTarget) {
  const target = clampInt(costTarget, 1, 5, 3);
  if (target <= 1) return 0.33;
  if (target === 2) return 0.75;
  if (target === 3) return 1;
  if (target === 4) return 3;
  return 15;
}

function costMultiplierSourceKey(provider = {}) {
  return String(
    provider.cost_multiplier_source ||
      provider.billing_source ||
      provider.family ||
      provider.protocol ||
      "",
  ).trim().toLowerCase();
}

function sourceLocalCostMultiplierBonus(provider, peers = [], reqBody = {}, options = {}) {
  const ownMultiplier = costMultiplierForProvider(provider);
  if (ownMultiplier === null) return 0;

  const sourceKey = costMultiplierSourceKey(provider);
  if (!sourceKey) return 0;

  const sameSourceMultipliers = (peers || [])
    .filter((candidate) => costMultiplierSourceKey(candidate) === sourceKey)
    .map(costMultiplierForProvider)
    .filter((value) => value !== null);
  if (sameSourceMultipliers.length < 2) return 0;

  const min = Math.min(...sameSourceMultipliers);
  const max = Math.max(...sameSourceMultipliers);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;

  const env = options.env || process.env;
  const request = effectiveRequestProfile(reqBody, env);
  const taskLevel = Number(request.taskLevel || request.level || 3);
  const stepShape = request.stepShape || {};
  const contextOnlyPressure = isContextOnlyPressureProfile(request, reqBody);
  const requestText = latestUserText(reqBody.messages || []);
  const explicitHighRisk =
    (request.contextLevel >= 5 && !contextOnlyPressure) ||
    /\b(?:deep research|production incident|hard bug|threat\s+model|privilege\s+bypass|security\s+(?:review|audit)|destructive|human\s+sign[- ]?off|before\s+release)\b/.test(requestText);
  const routingPolicy = getPolicyTargets(env).routingPolicy;
  const efficiencyPolicy = routingPolicy === "balanced" || routingPolicy === "economy" || routingPolicy === "speed";
  const prefersCheap =
    taskLevel <= 2 ||
    stepShape.posture === "type_cheap" ||
    stepShape.shape === "validation" ||
    (!explicitHighRisk && efficiencyPolicy);

  const position = (ownMultiplier - min) / (max - min);
  if (prefersCheap) return 0.08 - position * 0.24;
  if (!explicitHighRisk) return 0.04 - position * 0.12;
  return 0.02 - position * 0.05;
}

function applySourceLocalCostMultiplierScores(scored = [], reqBody = {}, options = {}) {
  const peers = scored.map((entry) => entry.provider).filter(Boolean);
  return scored.map((entry) => ({
    ...entry,
    score: entry.score + sourceLocalCostMultiplierBonus(entry.provider, peers, reqBody, options),
  }));
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

function normalizeRoutingPolicy(value) {
  const key = String(value || "balanced").trim().toLowerCase().replace(/[\s_]+/g, "-") || "balanced";
  const compactKey = key.replace(/-/g, "");
  return ROUTING_POLICY_ALIASES[key] || ROUTING_POLICY_ALIASES[compactKey] || (ROUTING_POLICIES.has(key) ? key : "balanced");
}

function isContextOnlyPressureProfile(profile = {}, reqBody = {}) {
  const taskLevel = clampInt(profile.taskLevel, 1, 5, Number(profile.level || 3));
  const contextLevel = clampInt(profile.contextLevel, 1, 5, Number(profile.level || 3));
  if (contextLevel <= taskLevel || contextLevel < 4 || taskLevel > 3) return false;

  const taskKind = profile.taskKind || "general";
  const stepShape = profile.stepShape || {};
  if (isTextEfficientContextOnlyPressureProfile(profile, reqBody)) return true;
  if (taskKind !== "agentic_coding" || stepShape.shape !== "write_heavy") return false;
  if (stepShape.gate === "human_signoff" || stepShape.gate === "dry_run_first") return false;

  const requestText = latestUserText(reqBody.messages || []);
  return !/\b(one[- ]?million|1m|million[- ]token|million[- ]context|large[- ]context|long[- ]context|deep research|production incident|hard bug|architecture|security|destructive|migration|root cause|concurrency|race|cryptograph|threat\s+model)\b/i.test(requestText);
}

function isTextEfficientContextOnlyPressureProfile(profile = {}, reqBody = {}) {
  const taskLevel = clampInt(profile.taskLevel, 1, 5, Number(profile.level || 3));
  const contextLevel = clampInt(profile.contextLevel, 1, 5, Number(profile.level || 3));
  if (contextLevel <= taskLevel || contextLevel < 4 || taskLevel > 2) return false;

  const taskKind = profile.taskKind || "general";
  const stepShape = profile.stepShape || {};
  if (!TEXT_EFFICIENT_TASKS.has(taskKind)) return false;
  if (stepShape.shape && stepShape.shape !== "write_heavy" && stepShape.shape !== "direct") return false;
  if (stepShape.gate === "human_signoff" || stepShape.gate === "dry_run_first") return false;

  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const hasToolHistory = (reqBody.messages || []).some((message) => message.role === "tool" || message.tool_calls?.length > 0);
  if (toolCount > 0 || hasToolHistory) return false;

  const requestText = latestUserText(reqBody.messages || []);
  return !/\b(one[- ]?million|1m|million[- ]token|million[- ]context|large[- ]context|long[- ]context|deep research|production incident|hard bug|architecture|security|destructive|migration|root cause|concurrency|race|cryptograph|threat\s+model)\b/i.test(requestText);
}

function getPolicyTargets(env = process.env) {
  const thinkingTarget = normalizeEffort(env.LLM_THINKING_TARGET, "medium");
  return {
    costTarget: clampInt(env.LLM_COST_TARGET, 1, 5, 3),
    thinkingTarget,
    thinkingTargetLevel: effortLevel(thinkingTarget),
    speedTarget: clampInt(env.LLM_SPEED_TARGET, 1, 5, 4),
    routingPolicy: normalizeRoutingPolicy(env.LLM_ROUTING_POLICY),
  };
}

function providerText(provider = {}) {
  return [
    provider.name,
    provider.model,
    provider.upstream_model,
    provider.windsurf_model_uid,
    provider.description,
    provider.family,
  ].filter(Boolean).join(" ").toLowerCase();
}

function modelVersionPowerBonus(provider = {}) {
  const text = providerText(provider);
  const opusMatch = text.match(/opus(?:[- _.]?4)?[- _.]?(6|7|8)\b/);
  if (opusMatch) {
    const version = Number(opusMatch[1]);
    if (version === 8) return 0.18;
    if (version === 7) return 0.10;
    if (version === 6) return 0.04;
  }

  const gptMatch = text.match(/\bgpt[- _.]?5[- _.]?(3|4|5)\b/);
  if (gptMatch) {
    const version = Number(gptMatch[1]);
    if (version === 5) return 0.18;
    if (version === 4) return 0.10;
    if (version === 3) return 0.04;
  }

  return 0;
}

function providerCaps(provider = {}) {
  return Array.isArray(provider.caps) ? provider.caps : [];
}

function isHiddenProvider(provider = {}) {
  return String(provider.visibility || "").toLowerCase() === "hide";
}

function isInternalPrivateProvider(provider = {}) {
  const text = providerText(provider);
  return provider.family === "windsurf" && /(?:^|\s|\/)private[-_ ]?\d+\b/.test(text);
}

function isCodexAutoReviewProvider(provider = {}) {
  return /(?:auto[-_ ]?review|code[-_ ]?review|codex[-_/]?auto[-_]?review)/.test(providerText(provider));
}

function providerHasToolCodingContract(provider = {}) {
  const caps = providerCaps(provider);
  return (
    (caps.includes("coding") && caps.includes("tools")) ||
    provider.supports_parallel_tool_calls === true ||
    Boolean(provider.apply_patch_tool_type || provider.shell_type)
  );
}

function isGeminiFlashProvider(provider = {}) {
  return /gemini.*flash|flash[- _.]?lite/.test(providerText(provider));
}

function isGeminiProProvider(provider = {}) {
  return /gemini.*pro/.test(providerText(provider));
}

function isSmallFastProvider(provider = {}) {
  return /haiku|mini|nano|lite|small|flash|grok.*fast|minimax|glm|swe[- _.]?1/.test(providerText(provider));
}

function isPriorityFastProvider(provider = {}) {
  return /priority|fast[-_ ]?lane|speed/.test(providerText(provider)) || Number(provider.priority || 0) > 0;
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
    else if (/gpt[- _.]?4[- _.]?1|copilot/.test(text)) costGroup = 3;
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
    else if (/gpt[- _.]?4[- _.]?1|copilot/.test(text)) qualityGroup = 4;
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
    else if (/gpt[- _.]?4[- _.]?1|copilot/.test(text)) speedGroup = 4;
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
    else if (/gpt[- _.]?4[- _.]?1|copilot/.test(text)) effort = "medium";
    else if (/gpt[- _.]?5[- _.]?[45]|claude.*sonnet|sonnet[- _.]?4|gemini.*flash|glm[- _.]?5|zai.*glm|minimax.*m2[- _.]?5|swe[- _.]?1[- _.]?[56]|adaptive/.test(text)) effort = "medium";
    else if (/gpt[- _.]?5[- _.]?2/.test(text)) effort = "medium";
    else if (/haiku|mini|fast|grok/.test(text)) effort = "low";
    else effort = provider.tc || provider.caps?.includes("thinking") ? "medium" : "none";
  }

  if (/claude.*haiku|haiku[- _.]?4/.test(text)) {
    costGroup = Math.min(costGroup, 2);
    qualityGroup = Math.min(qualityGroup, 3);
    if (effortLevel(effort) > 2) effort = "low";
  }

  return {
    cost_group: costGroup,
    quality_group: qualityGroup,
    speed_group: speedGroup,
    thinking_effort: effort,
    thinking_level: effortLevel(effort),
  };
}

function isHighThinkingProfile(profile = {}) {
  return Number(profile.thinking_level || 0) >= 4 ||
    profile.thinking_effort === "high" ||
    profile.thinking_effort === "xhigh";
}

function providerMaxRoutingLevel(provider = {}) {
  const text = providerText(provider);
  const profile = classifyProvider(provider);
  const caps = providerCaps(provider);
  const highThinking = isHighThinkingProfile(profile);

  const isOpus48 = /claude.*opus.*4[- _.]?8|opus[- _.]?4[- _.]?8/.test(text);
  const isOpus47 = /claude.*opus.*4[- _.]?7|opus[- _.]?4[- _.]?7/.test(text);
  const isOpus46 = /claude.*opus.*4[- _.]?6|opus[- _.]?4[- _.]?6/.test(text);
  const isOpus4Family = /claude.*opus.*4|opus[- _.]?4/.test(text);
  const isGpt55 = /\bgpt[- _.]?5[- _.]?5\b/.test(text);
  const isGpt54 = /\bgpt[- _.]?5[- _.]?4\b/.test(text) && !/\bgpt[- _.]?5[- _.]?4[- _.]?mini\b|mini/.test(text);
  const isGpt5Family = /\bgpt[- _.]?5(?:[- _.]|\b)/.test(text);
  const isGpt4oFamily = /\bgpt[- _.]?4[- _.]?o(?:[- _.]?(?:mini|preview)|[- _.]|\b)/.test(text);

  const isGpt3Legacy = /\bgpt[- _.]?3(?:[- _.]?5|\.5)?(?:[- _.]?turbo)?\b|\bturbo[- _.]?0613\b/.test(text);
  if (isGpt3Legacy) return 2;

  if (isGpt4oFamily) return 2;

  const isGpt4Legacy =
    /\bgpt[- _.]?4(?:[- _.]?(?:1|o)|[- _.]?\d{4}|$|\b)/.test(text) ||
    /\bgpt[- _.]?41(?:[- _.]|$)/.test(text);
  if (isGpt4Legacy) return 3;

  if (highThinking && (isOpus48 || isOpus47 || isGpt55 || isOpus46 || isGpt54)) return 5;
  if (isOpus48 || isOpus47 || isOpus46) return 4;

  if (/claude.*haiku|haiku[- _.]?4|gemini.*flash|flash[- _.]?lite|swe[- _.]?1|grok.*fast|classifier|nano|lite|small/.test(text)) {
    return 3;
  }

  const isGpt5Mini = /\bgpt[- _.]?5(?:[- _.]?[0-9]+)?[- _.]?mini\b/.test(text);
  if (isGpt5Mini) return 4;

  if (isGpt55 || isGpt54) return 4;

  if (isGpt5Family) return 4;

  if (isOpus4Family) return highThinking ? 4 : 3;
  if (/gemini.*pro/.test(text)) return 4;
  if (/sonnet[- _.]?4|claude.*sonnet.*4/.test(text)) return 4;
  if (/glm[- _.]?5|zai.*glm|minimax.*m2[- _.]?5|kimi[- _.]?k2|grok.*code/.test(text)) return 4;
  if (/codex|auto[-_]?review|code[-_]?review/.test(text)) return 4;

  if (profile.quality_group >= 5) return 4;
  if (profile.quality_group >= 4 && profile.thinking_level >= 3 && profile.cost_group >= 3 && !isSmallFastProvider(provider)) return 4;
  if (profile.quality_group >= 3) return 3;
  return 2;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return mediaContent.textFromContent(content);
  return "";
}

function normalizeTaskText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function stepShapeProfile(shape, overrides = {}) {
  return {
    ...(STEP_SHAPE_PROFILES[shape] || STEP_SHAPE_PROFILES.write_heavy),
    ...overrides,
  };
}

function isOperationalDeploymentSignal(text = "") {
  return (
    /\b(?:docker|compose|container|ssh|health\s+check|redeploy|restart|homebridge|kubernetes|helm)\b/.test(text) ||
    (
      /\bdeploy(?:ment)?\b/.test(text) &&
      /\b(?:prod|production|release|rollback|environment|server|service|pipeline|ci|container|docker|ssh|health|restart|redeploy|kubernetes|helm|port|host)\b/.test(text)
    )
  );
}

function isNarrowCorrectedFunctionBugfix(lastText = "", allText = "") {
  const asksForCorrection =
    /\bfix\b/.test(lastText) &&
    (
      /\breturn only the corrected\b/.test(allText) ||
      /\bcorrected\s+(?:javascript|typescript|python|go|rust)?\s*function\b/.test(allText) ||
      /\bfunction\s+[a-z_$][\w$]*\s*\(/i.test(allText)
    );
  const broadDiagnosticSignal =
    /\b(?:root\s+cause|diagnose|investigate|intermittent|race|production|architecture|security|auth|permission|migration|multi[- ]?file|repo|codebase|stack\s+trace|traceback|analy[sz]e|without\s+running|exact\s+output|invariant)\b/.test(lastText);

  return asksForCorrection && !broadDiagnosticSignal;
}

function requiresDestructiveHumanSignoff(text = "") {
  return (
    (/\b(?:execute|apply|deploy|perform|proceed|do\s+it|go\s+ahead)\b/.test(text) ||
      /\brun\s+(?:the\s+)?(?:prod|production|irreversible|database\s+migration)\b/.test(text)) &&
    /\b(?:prod|production|real\s+(?:data|database|users?)|customer\s+(?:data|rows?|records?)|irreversible|drop\s+table|truncate|mass\s+update|bulk\s+delete|delete\s+customer|revoke\s+(?:tokens?|credentials?|keys?)|rotate\s+(?:secrets?|keys?)|disable\s+auth)\b/.test(text)
  ) ||
    /\b(?:irreversibly\s+deletes?|drop\s+table|truncate\s+production|bulk\s+delete\s+production|delete\s+customer\s+(?:data|rows?|records?))\b/.test(text);
}

function detectStepShape(messages = [], reqBody = {}, taskKindOverride = "") {
  const allText = normalizeTaskText(messages.map((message) => textContent(message.content)).join("\n"));
  const lastText = latestUserText(messages);
  const taskKind = taskKindOverride || detectTaskKind(messages, reqBody);
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const hasTools = toolCount > 0;
  const hasToolHistory = messages.some((message) => message.role === "tool" || message.tool_calls?.length > 0);

  if (isTrivialDirectAnswerRequest(lastText) || taskKind === "direct_answer") {
    return stepShapeProfile("direct");
  }

  const destructiveSignal =
    /\b(?:destructive|delete|deletes?|drop\s+table|truncate|mass\s+update|bulk\s+update|database\s+migration|db\s+migration|rollback|dry[- ]?run|prod(?:uction)?[- ]?like|production[- ]?impacting|irreversible|remove\s+old\s+rows)\b/.test(lastText) ||
    /\bmigration\b.{0,80}\b(?:delete|drop|truncate|rollback|dry[- ]?run|prod(?:uction)?|irreversible)\b/.test(lastText) ||
    (taskKind === "deployment_ops" && /\b(?:prod|production|deploy|rollback|restart|delete|remove|migration)\b/.test(lastText));
  if (destructiveSignal) {
    if (requiresDestructiveHumanSignoff(lastText)) {
      return stepShapeProfile("destructive", {
        gate: "human_signoff",
        summary: "Destructive gate: require explicit human sign-off before irreversible or production-impacting execution.",
      });
    }
    return stepShapeProfile("destructive");
  }

  const genericSecurityImplementationSignal = isGenericSecurityImplementationText(lastText, allText);
  const routingLogDiagnosticSignal = isRoutingLogDiagnosticText(lastText);
  const securityGateMetaDiagnosticSignal = isSecurityGateMetaDiagnosticText(lastText);
  const securitySignal =
    !routingLogDiagnosticSignal &&
    !securityGateMetaDiagnosticSignal &&
    (
      taskKind === "security_review" ||
      isExplicitSecurityReviewText(lastText) ||
      (!genericSecurityImplementationSignal && /\b(?:security|vulnerab|auth|authentication|authorization|permission|privilege|bypass|secret|credential|api\s+key|bearer\s+token|access\s+token|refresh\s+token|sql\s+injection|xss|csrf|threat\s+model|exploit)\b/.test(lastText))
    );
  if (securitySignal) {
    return stepShapeProfile("security");
  }

  const diffReviewSignal =
    /\b(?:review|audit|inspect|verify|check)\b/.test(lastText) &&
    /\b(?:diff|pr|pull\s+request|merge|line[- ]?by[- ]?line|summary\s+(?:vs|versus|against)|regression|before\s+merge|llm[- ]?generated)\b/.test(lastText);
  if (taskKind === "completion_review" || taskKind === "code_review" || diffReviewSignal) {
    return stepShapeProfile("review");
  }

  if (taskKind === "benchmarking") {
    return stepShapeProfile("benchmark");
  }

  const validationSignal =
    taskKind === "verification" ||
    /\b(?:validate|verify|run\s+(?:the\s+)?behavior|health\s+check|typecheck|lint|schema\s+validation|regression\s+check|deterministic\s+validator|no\s+self[- ]?grading)\b/.test(lastText);
  if (validationSignal && taskKind !== "planning" && !/\b(?:implement|write|generate|create|add|patch|fix)\b/.test(lastText)) {
    return stepShapeProfile("validation");
  }

  const planExecutionSignal = taskKind === "agentic_coding" && detectsPlanExecution(lastText);
  if (planExecutionSignal) {
    return stepShapeProfile("write_heavy");
  }

  if (isNarrowCorrectedFunctionBugfix(lastText, allText)) {
    return stepShapeProfile("write_heavy");
  }

  if (taskKind === "list_summary" || taskKind === "explanation") {
    return stepShapeProfile("write_heavy", {
      gate: "none",
      summary: "Type cheap: summarize or explain from available context without broad exploration.",
    });
  }

  if (
    taskKind === "planning" ||
    taskKind === "research" ||
    taskKind === "debugging" ||
    taskKind === "data_analysis" ||
    taskKind === "edit_recovery" ||
    taskKind === "architecture_recovery" ||
    /\b(?:understand|plan|split|decompose|architecture|design|diagnose|root\s+cause|investigate|research|analy[sz]e|compare|trade[- ]?offs?|dependency|dependencies|schema\s+design|api\s+design|acceptance\s+criteria|risk|risks)\b/.test(lastText)
  ) {
    return stepShapeProfile("read_heavy");
  }

  if (
    taskKind === "documentation" ||
    taskKind === "translation_rewrite" ||
    taskKind === "test_generation" ||
    taskKind === "agentic_coding" ||
    /\b(?:execute|implement|generate|write|document|reformat|format|expand|scaffold|boilerplate|client\s+methods?|apply|patch|fix|add|create|rename|already[- ]?approved|approved\s+contract)\b/.test(lastText)
  ) {
    return stepShapeProfile("write_heavy");
  }

  if (hasTools || hasToolHistory) {
    return stepShapeProfile("write_heavy");
  }

  if (taskKind === "general") {
    return stepShapeProfile("write_heavy", {
      gate: "none",
      summary: "Type cheap: answer from available context without broad exploration.",
    });
  }

  return stepShapeProfile("write_heavy");
}

function detectsPlanExecution(text = "") {
  return (
    /\b(?:follow|execute|apply|carry out|start applying|continue with|resume|implement)\b.{0,80}\b(?:approved|existing|current|implementation|migration|routing)?\s*plan\b/.test(text) ||
    /\bplan\b.{0,80}\b(?:follow|execute|apply|carry out|start applying|resume|implement)\b/.test(text)
  );
}

function latestUserText(messages = []) {
  const lastUser = [...(messages || [])].reverse().find((message) => message?.role === "user");
  return normalizeTaskText(textContent(lastUser?.content || messages[messages.length - 1]?.content));
}

function hasFlattenedToolHistory(messages = []) {
  return (messages || []).some((message) => (
    /Historical tool invocation \(already executed\):|Historical tool result \(already observed\) for|Earlier native tool history omitted for compatibility:/i
      .test(textContent(message?.content || ""))
  ));
}

function hasToolHistory(messages = []) {
  return (messages || []).some((message) => message?.role === "tool" || message?.tool_calls?.length > 0);
}

function hasToolHistoryEvidence(messages = []) {
  return hasToolHistory(messages) || hasFlattenedToolHistory(messages);
}

function hasToolDefinitions(body = {}) {
  return (body.tools?.length || 0) > 0 || (body.functions?.length || 0) > 0;
}

function hasRequiredToolContract(body = {}) {
  if (!hasToolDefinitions(body)) return false;
  const toolChoice = body.tool_choice;
  if (toolChoice === "required" || toolChoice === "any") return true;
  if (toolChoice && typeof toolChoice === "object") {
    const type = String(toolChoice.type || "").trim().toLowerCase();
    return type !== "auto" && type !== "none";
  }
  const functionCall = body.function_call;
  if (functionCall && functionCall !== "auto" && functionCall !== "none") return true;
  return false;
}

function hasExplicitToolUseRequest(text = "") {
  return /\b(?:use|folose(?:s|\u0219)te|ruleaz(?:a|\u0103)|inspect|read|open|cat|run|execut(?:a|\u0103)|verific(?:a|\u0103))\b.{0,80}\b(?:tool|tools?|repo|repository|codebase|files?|fisiere|fi\u0219iere|logs?|loguri|terminal|shell|bash)\b/i.test(text);
}

function isPassiveNoToolRequest(reqBody = {}, assessed = null) {
  const profile = assessed || assessRequestDifficulty(reqBody.messages || [], reqBody);
  if (!PASSIVE_NO_TOOL_TASKS.has(profile?.taskKind || "")) return false;
  if (hasToolHistoryEvidence(reqBody.messages || []) || hasRequiredToolContract(reqBody)) return false;
  if (hasExplicitToolUseRequest(latestUserText(reqBody.messages || []))) return false;
  if (profile?.stepShape?.gate && profile.stepShape.gate !== "none") return false;
  return true;
}

function isContinuationOnly(text = "") {
  return (
    /\b(?:continue|continua|resume|next|go on|keep going|do it|proceed)\b/.test(text) &&
    !/\b(?:implement|fix|debug|write|create|add|edit|patch|run|deploy|test|review|analy[sz]e|investigate|root\s+cause)\b/.test(text)
  );
}

function isActiveToolContinuationText(text = "") {
  const normalized = normalizeTaskText(text);
  if (!normalized) return false;
  return (
    /^continue the active task\b/.test(normalized) &&
    /\b(?:next appropriate tool|call .*tool|tool call|do not stop|more work remains|task is complete and verified)\b/.test(normalized)
  ) || (
    /^\s*(?:continue|continua|resume|proceed|next|go on|keep going)\b/.test(normalized) &&
    /\b(?:tool|tools|tool result|active task|next incomplete|work remains|until complete|pana termini)\b/.test(normalized)
  );
}

function isActiveToolContinuationRequest(reqBody = {}) {
  const text = latestUserText(reqBody.messages || []);
  if (!isActiveToolContinuationText(text) && !isContinuationOnly(text)) return false;
  return hasToolDefinitions(reqBody) || hasToolHistoryEvidence(reqBody.messages || []);
}

function isExplicitArchitectureRecoveryText(text = "") {
  const architectureTerm =
    /\b(?:architecture recovery|production proxy incident|proxy incident|routing class|provider health|compatibility|long[- ]?context pressure|benchmark fairness|cost efficiency)\b/.test(text);
  const hardContextTerm =
    /\b(?:deep research|hard bug|production incident|one[- ]?million|1m|million[- ]token|million[- ]context|long[- ]?context)\b/.test(text);
  return architectureTerm && hardContextTerm;
}

function isExplicitSecurityReviewText(text = "") {
  return /\b(?:security\s+(?:review|audit)|threat\s+model|vulnerab|privilege|bypass|sql\s+injection|xss|csrf|exploit|secret\s+leakage|replay(?:ed)?|timing\s+(?:info|attack|leak)|constant[- ]?time|timingsafeequal|malformed\s+hex|webhook\s+verifier|signature\s+verifier|hmac|human\s+sign[- ]?off|no\s+exceptions?)\b/.test(text);
}

function isSecurityGateMetaDiagnosticText(text = "") {
  const hasGateTerm =
    /\b(?:security[_ -]?review|security[_ -]?audit|human[_ -]?sign[- ]?off|human[_ -]?review|human[_ -]?approval|approval|approve)\b/.test(text);
  if (!hasGateTerm) return false;
  const metaComplaint =
    /\b(?:de ce|why|gresit|wrong|aiurea|nu\s+(?:e|este|are\s+sens|ar\s+trebui)|not\s+(?:a|needed|necessary|right)|doar|only|should|ar\s+trebui|trebuie|cere|requires?|required|gate|gating|routing|route|routare|proxy|hight?\s+risk|high\s+risk)\b/.test(text);
  if (!metaComplaint) return false;
  const explicitSecurityWork =
    /\b(?:review|audit|threat\s+model|inspect|verify|analy[sz]e)\b.{0,80}\b(?:auth|permission|privilege|vulnerab|sql\s+injection|xss|csrf|secret|credential|exploit|bypass)\b/.test(text);
  return !explicitSecurityWork;
}

function isGenericSecurityImplementationText(lastText = "", allText = "") {
  const securityNoun =
    /\b(?:auth|authentication|authorization|permission|secret|credential|api\s+key|bearer\s+token|access\s+token|refresh\s+token|token)\b/.test(lastText);
  const implementationContext =
    /\b(?:implement|fix|debug|test|discovery|routing|provider|headers?|config|script|endpoint|docker|models?|match|logs?|proxy|copilot|key|auth)\b/.test(lastText) ||
    /\b(?:provider|proxy|copilot|routing|discovery|headers?|config)\b/.test(allText);
  return securityNoun && implementationContext && !isExplicitSecurityReviewText(lastText);
}

function isRoutingLogDiagnosticText(text = "") {
  const hasRoutingLogLine =
    /\b(?:routing-profile|routing:|route:|reroute:|assess:|native-stream|dev-native-stream-req|tool-sync|anthropic messages api)\b/.test(text) ||
    /\b(?:task|shape|gate|cost|thinking|speed|input|estimated|tools)=[a-z0-9_.\/-]+/.test(text);
  const asksAboutRouting =
    /\b(?:route|routing|routeaza|ruteaza|provider|providers?|model|models?|opus|sonnet|claude[- ]?sonnet|claudesonnet|windsurf|fallback|candidate|candidates?|score|timeout|502|issue|same issue|logs?|loguri|taskuri|aiurea|debug|fix)\b/.test(text);
  return hasRoutingLogLine && asksAboutRouting;
}

function isCompactSummarySelfCall(messages = [], reqBody = {}) {
  const systemText = normalizeTaskText(
    messages
      .filter((message) => message.role === "system")
      .map((message) => textContent(message.content))
      .join("\n"),
  );
  const noTools = ((reqBody.tools?.length || 0) + (reqBody.functions?.length || 0)) === 0;
  return noTools &&
    String(reqBody.model || "") === "auto-text" &&
    /summarize this compacted conversation excerpt/.test(systemText) &&
    /return only the summary/.test(systemText) &&
    /do not call tools/.test(systemText);
}

function detectTaskKind(messages = [], reqBody = {}) {
  if (reqBody?._llmProxyInternalSummary || isCompactSummarySelfCall(messages, reqBody)) return "list_summary";
  if (reqBody?._llmProxyInternalAssessment) return "verification";
  const allText = normalizeTaskText(messages.map((message) => textContent(message.content)).join("\n"));
  const lastText = latestUserText(messages);
  const recentUserText = normalizeTaskText(
    messages
      .filter((message) => message.role === "user")
      .slice(-2)
      .map((message) => textContent(message.content))
      .join("\n"),
  );
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const hasTools = toolCount > 0;
  const hasToolHistory = hasToolHistoryEvidence(messages);
  const activeToolContinuationSignal = (hasTools || hasToolHistory) &&
    (isActiveToolContinuationText(lastText) || isContinuationOnly(lastText));
  const editRecoverySignal = /\b(edit failed|patch failed|apply_patch failed|failed to apply|old_string not found|string to replace not found|expected text (?:was )?not found|no changes made|stale read|shimm?y?ing|shimmying|cannot apply edit|could not apply edit)\b/.test(allText);
  const architectureRecoverySignal =
    isExplicitArchitectureRecoveryText(lastText) ||
    (isContinuationOnly(lastText) && isExplicitArchitectureRecoveryText(recentUserText));
  const completionSignal =
    /\b(finalizat|terminat|completed|done|finished|implemented|fixed|actualizat|adaugat|reparat|implementat|rulat|tests?\s+passed)\b/.test(lastText) ||
    /(?:^|\n)\s*(?:changes|schimbari|modificari)\s*:/i.test(lastText);
  const reviewSignal = /\b(verific|verifica|verify|review|audit|validat|validate|check|inspect|confirm|regression|regresie|auto[-_ ]?review|code[-_ ]?review)\b/.test(lastText);
  const listSummarySignal = /\b(lista|listeaza|list|tasks?|taskuri|todo|sumar|sumariz|summari[sz]e|summary|status|progres|progress|raport|recap)\b/.test(lastText);
  const translationRewriteSignal = /\b(translate|translation|rewrite|rephrase|tone|grammar|format|copyedit|proofread|paraphrase)\b/.test(lastText);
  const explanationSignal = /\b(explain|explanation|teach|how does|how do|what is|why|what for|describe|compare|difference between|walk me through|de ce|pt ce|pentru ce|la ce|ce este|ce inseamna|ce \u00eenseamn\u0103|cum functioneaza|cum func\u021bioneaz\u0103|care e motivul)\b/.test(lastText);
  const documentationSignal = /\b(readme|docs?|documentation|instructions?|setup guide|runbook|changelog|release notes)\b/.test(lastText);
  const visionSignal = /\b(screenshot|image|photo|diagram|ui|visual|vision|ocr)\b/.test(lastText) && /\b(analy[sz]e|describe|read|inspect|review|what do you see)\b/.test(lastText);
  const imageGenerationSignal = /\b(generate|create|make|draw|render)\b/.test(lastText) && /\b(image|picture|photo|illustration|logo|icon|mockup)\b/.test(lastText);
  const videoGenerationSignal = /\b(generate|create|make|render|edit)\b/.test(lastText) && /\b(video|animation|clip|movie)\b/.test(lastText);
  const benchmarkSignal =
    /\b(?:ab test|a\/b|performance comparison|direct\s+vs\s+proxy|opus\s+vs\s+proxy|ascii art graph)\b/.test(lastText) ||
    (
      /\b(?:benchmark|benchmarks|benchmarking|banchmark)\b/.test(lastText) &&
      /\b(?:run|build|compare|comparison|measure|score|correctness|latency|tokens?|cost|suite|arms?|direct\s+(?:arm|model|vs)|proxy\s+(?:arm|model|routing)|opus)\b/.test(lastText)
    );
  const incidentDecisionSignal = /\b(?:incident facts|production proxy incident|choose a decision|decision between|fallback|risk)\b/.test(lastText);
  const researchSignal = /\b(deep research|research|investigate|look up|cauta|search|find latest|survey|compare options)\b/.test(lastText);
  const securityGateMetaDiagnosticSignal = isSecurityGateMetaDiagnosticText(lastText);
  const securitySignal =
    !securityGateMetaDiagnosticSignal &&
    (
      isExplicitSecurityReviewText(lastText) ||
      /\b(security|vulnerab|sql injection|prompt injection|xss|csrf|auth|permission|secret|credential|token|exploit|threat model|bypass)\b/.test(lastText)
    );
  const genericSecurityImplementationSignal = isGenericSecurityImplementationText(lastText, allText);
  const routingLogDiagnosticSignal = isRoutingLogDiagnosticText(lastText);
  const debuggingSignal = /\b(debug|root cause|stack trace|traceback|exception|error|fail|failing|logs?|crash|regression|timeout|500|422|429)\b/.test(lastText);
  const refactorSignal = /\b(refactor|modulari[sz]e|split module|architecture cleanup|technical debt)\b/.test(lastText);
  const testSignal = /\b(?:add|write|create|generate)\s+(?:focused\s+|new\s+|regression\s+|unit\s+|e2e\s+|integration\s+)?tests?\b|\b(test cases?|coverage)\b/.test(lastText);
  const deploymentSignal = isOperationalDeploymentSignal(lastText);
  const diffReviewEvidence = /\b(diff|pull request|pr\b|line[- ]?by[- ]?line|changed files?|patch|merge|pre[- ]?merge)\b/.test(lastText);
  const readOnlyAuditSignal = /\b(read[- ]?only audit|audit|inspect|review)\b/.test(lastText) && /\b(read[- ]?only|do not edit|no edits?|do not modify)\b/.test(lastText);
  const codeReviewSignal =
    /\b(code review|review code|review this diff|review changes|find bugs|bug risks|merge review|pre[- ]?merge)\b/.test(lastText) ||
    (/\breview\b/.test(lastText) && diffReviewEvidence && !/\blogs?\b/.test(lastText));
  const dataAnalysisSignal = /\b(analy[sz]e|metrics?|stats?|logs?|raw logs?|dashboard|csv|json|report|trend)\b/.test(lastText) && /\b(cost|latency|tokens?|routing|scores?|usage|benchmark|providers?)\b/.test(allText);
  const selfReviewSignal = /\b(self[-_ ]?review|review pass|review this plan|review the plan|plan review|pre[-_ ]?implementation review|post[-_ ]?implementation review|completed work review|review completed work)\b/.test(lastText);
  const planExecutionSignal = detectsPlanExecution(lastText);
  const planningSignal = /\b(plan|strategy|proposal|propuneri|roadmap|design before|before implement|after i confirm|wait for confirmation)\b/.test(lastText);
  const recoveryWorkflowSignal = /\b(?:design|plan)\b.{0,100}\brecovery\s+workflow\b|\brecovery\s+workflow\b.{0,100}\b(?:inspect|isolate|resume|verify|report)\b/.test(lastText);
  const editSignal = /\b(implementeaz|implement|modific|modify|fix|repar|editeaz|edit|scrie|write|creeaz|create|adauga|add|sterge|delete|remove|ruleaz|run|execut|deploy|commit|build|testeaz|test|refactor|debug)\b/.test(lastText);
  const negatedToolSyntaxSignal = /\bdo not call tools\b/.test(lastText) && /\bwrite function-call syntax\b/.test(lastText);
  const effectiveEditSignal = editSignal && !negatedToolSyntaxSignal;
  const codingSignal = /\b(code|cod|api|endpoint|component|docker|typescript|javascript|python|repo|codebase|files?|tool|claude code|windsurf)\b/.test(allText);

  if (isTrivialDirectAnswerRequest(lastText)) return "direct_answer";
  if (editRecoverySignal && (hasTools || hasToolHistory || codingSignal)) return "edit_recovery";
  if (architectureRecoverySignal && !(effectiveEditSignal || deploymentSignal || testSignal)) return "architecture_recovery";
  if (activeToolContinuationSignal) return "agentic_coding";
  if (selfReviewSignal && /\b(plan|proposal|implemented|completed|changes|tests|done|finished|review)\b/.test(allText)) return "completion_review";
  if (reviewSignal && completionSignal) return "completion_review";
  if (planExecutionSignal && (hasTools || hasToolHistory || effectiveEditSignal || codingSignal)) return "agentic_coding";
  if ((planningSignal || recoveryWorkflowSignal) && !hasTools && !hasToolHistory) return "planning";
  if (benchmarkSignal && !incidentDecisionSignal) return "benchmarking";
  if (routingLogDiagnosticSignal) return "debugging";
  if (securitySignal && !genericSecurityImplementationSignal && (reviewSignal || effectiveEditSignal || codingSignal || isExplicitSecurityReviewText(lastText))) return "security_review";
  if (codeReviewSignal) return "code_review";
  if (isNarrowCorrectedFunctionBugfix(lastText, allText)) return "agentic_coding";
  if (debuggingSignal && /\b(debug|root cause|stack trace|traceback|exception|error|fail|failing|crash|timeout|500|422|429)\b/.test(lastText)) return "debugging";
  if (dataAnalysisSignal) return "data_analysis";
  if (readOnlyAuditSignal) return "verification";
  if (testSignal && (effectiveEditSignal || codingSignal)) return "test_generation";
  if (debuggingSignal && (hasTools || hasToolHistory || codingSignal || /proxy|provider|api|docker|container/i.test(allText))) return "debugging";
  if (listSummarySignal && !effectiveEditSignal) return "list_summary";
  if (documentationSignal && (effectiveEditSignal || codingSignal)) return "documentation";
  if (deploymentSignal && effectiveEditSignal && codingSignal && /\b(?:implement|fix|update|edit|patch|code|tests?)\b/.test(lastText)) return "agentic_coding";
  if (deploymentSignal && (effectiveEditSignal || hasTools || hasToolHistory || /deploy|docker|ssh|container|health check/i.test(lastText))) return "deployment_ops";
  if (refactorSignal) return "refactor";
  if (researchSignal) return "research";
  if (videoGenerationSignal) return "video_generation";
  if (imageGenerationSignal) return "image_generation";
  if (visionSignal) return "vision_analysis";
  if (translationRewriteSignal && !effectiveEditSignal) return "translation_rewrite";
  if (explanationSignal && !effectiveEditSignal) return "explanation";
  if (planningSignal && !effectiveEditSignal) return "planning";
  if (reviewSignal) return "verification";
  if (hasTools || hasToolHistory || effectiveEditSignal || codingSignal) return "agentic_coding";
  if (documentationSignal) return "documentation";
  return "general";
}

function isTrivialDirectAnswerRequest(lastText = "") {
  const text = normalizeTaskText(lastText);
  const asksIdentity = asksIdentityProbeText(text);
  const explicitExactReply = /^\s*(reply exactly|raspunde exact|say exactly)\b/i.test(lastText);
  const shortLiteralReply = /^\s*(hello|hi|ok|ping)[\s.!?]*$/i.test(lastText);
  const exactReply = explicitExactReply || shortLiteralReply;
  const hasWorkVerb = /\b(implement|modific|modify|fix|repar|edit|scrie|write|create|adauga|add|delete|remove|run|execut|deploy|commit|build|test|inspect|scan|analy[sz]e|audit|review|debug|refactor)\b/.test(text);
  return (asksIdentity || exactReply) && !hasWorkVerb;
}

function looksLikeIdentityDomainWork(text = "") {
  return /\bidentity\b/.test(text) &&
    /\b(?:provider|route|routing|mismatch|api|oauth|auth|login|token|headers?|tool|request|response|proxy|model|logs?|debug|fix|repair|implement|verify|test|code|repo)\b/.test(text);
}

function asksIdentityProbeText(text = "") {
  const normalized = normalizeTaskText(text);
  if (!normalized) return false;
  if (/\b(who are you|what is your name|your name|cum te cheama|cum te numesti|cine esti|numele tau|ce nume ai)\b/.test(normalized)) return true;
  if (!/\bidentity\b/.test(normalized)) return false;
  if (looksLikeIdentityDomainWork(normalized)) return false;
  if (/^identity[?.!]*$/.test(normalized)) return true;
  return /\b(?:what(?: is|'s)?|who|tell me|say|your|you|assistant|model|ce|cine|care|cum|spune|zi)\b.{0,50}\bidentity\b|\bidentity\b.{0,50}\b(?:your|you|assistant|model|ta|tau)\b/.test(normalized);
}

function isAutoMemoryRouteRequest(reqBody = {}) {
  return String(reqBody?.model || "").trim().toLowerCase() === "auto-memory";
}

function internalMemoryRouteProfile() {
  const taskKind = "list_summary";
  const level = 2;
  const stepShape = stepShapeProfile("write_heavy", {
    gate: "none",
    summary: "Internal memory extraction: keep routing cheap, structured, and text-only.",
  });
  return {
    level,
    label: DIFFICULTY_LABELS[level],
    taskKind,
    reason: "memory_ingestion",
    taskLevel: 2,
    contextLevel: 1,
    qualityTarget: 3,
    thinkingEffort: "minimal",
    thinkingLevel: 1,
    speedTarget: 5,
    costTarget: 1,
    stepShape,
    source: "memory_route",
  };
}

function assessRequestDifficulty(messages = [], reqBody = {}) {
  if (isAutoMemoryRouteRequest(reqBody)) return internalMemoryRouteProfile();
  if (reqBody?._llmProxyInternalSummary || isCompactSummarySelfCall(messages, reqBody)) {
    const taskKind = "list_summary";
    const stepShape = stepShapeProfile("write_heavy", {
      gate: "none",
      summary: "Internal summary: keep the model cheap, concise, and text-only.",
    });
    return {
      level: 2,
      label: DIFFICULTY_LABELS[2],
      taskKind,
      taskLevel: 2,
      contextLevel: 1,
      thinkingEffort: "low",
      thinkingLevel: 2,
      speedTarget: 5,
      costTarget: 1,
      stepShape,
    };
  }
  const allText = normalizeTaskText(messages.map((message) => textContent(message.content)).join("\n"));
  const lastText = latestUserText(messages);
  const inputEstimate = Number(reqBody._inputTokens || 0);
  const estimated = inputEstimate > 0 ? inputEstimate : Number(reqBody._estimatedTokens || 0);
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const hasTools = toolCount > 0;
  const hasToolHistory = hasToolHistoryEvidence(messages);
  const taskKind = detectTaskKind(messages, reqBody);
  const stepShape = detectStepShape(messages, reqBody, taskKind);
  const taskTarget = TASK_KIND_TARGETS[taskKind] || TASK_KIND_TARGETS.general;
  const planExecutionSignal = taskKind === "agentic_coding" && detectsPlanExecution(lastText);
  let taskLevel = taskTarget.taskLevel;
  let contextLevel = taskTarget.contextLevel;

  if (isTrivialDirectAnswerRequest(lastText)) {
    return {
      level: 1,
      label: DIFFICULTY_LABELS[1],
      taskKind,
      taskLevel: 1,
      contextLevel: 1,
      thinkingEffort: "none",
      thinkingLevel: 0,
      speedTarget: 5,
      costTarget: 2,
      stepShape,
    };
  }

  if (/\b(explain|summariz|translate|rewrite|format|simple|quick)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 2);
  if (/\b(code|implement|fix|debug|test|api|endpoint|component|docker|typescript|javascript|python|refactor)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 3);
  const passiveToolContext = TEXT_EFFICIENT_TASKS.has(taskKind) && !hasToolHistory && !/\b(?:use|folose(?:s|\u0219)te|ruleaz(?:a|\u0103)|inspect|read|open|cat)\b.{0,80}\b(?:tool|tools?|repo|codebase|files?|fisiere|fi\u0219iere)\b/i.test(lastText);
  if (!passiveToolContext && (hasTools || hasToolHistory || /\b(agent|codebase|repo|files?|tool|claude code|windsurf)\b/i.test(allText))) taskLevel = Math.max(taskLevel, 3);
  if ((hasTools || hasToolHistory) && (toolCount >= 50 || estimated > 30000)) contextLevel = Math.max(contextLevel, 4);
  if (taskKind === "edit_recovery" || taskKind === "architecture_recovery") taskLevel = Math.max(taskLevel, 4);
  if (/\b(multi[- ]?file|multiple files?|cross[- ]?file|architecture|migration|security|concurrency|streaming|proxy|auth|authentication|performance|race|root cause|regression)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 4);
  if (/\b(deep research|prove|formal|cryptograph|distributed|compiler|database migration|production incident|hard bug)\b/i.test(lastText)) taskLevel = Math.max(taskLevel, 5);
  if (/\b(one[- ]?million|1m|million[- ]token|large[- ]context|long[- ]context)\b/i.test(lastText)) contextLevel = Math.max(contextLevel, 5);
  if (estimated > 150000) contextLevel = Math.max(contextLevel, 5);
  else if (estimated > 60000) contextLevel = Math.max(contextLevel, 4);
  else if (estimated > 12000) contextLevel = Math.max(contextLevel, 3);
  if (
    planExecutionSignal &&
    !/\b(architecture|security|root cause|production|hard bug|concurrency|auth|authentication|incident|race|cryptograph)\b/i.test(lastText)
  ) {
    taskLevel = Math.min(taskLevel, 3);
  }
  if (stepShape.shape === "read_heavy") {
    taskLevel = Math.max(taskLevel, 4);
  } else if (stepShape.shape === "benchmark") {
    taskLevel = Math.max(taskLevel, 4);
    contextLevel = Math.max(contextLevel, 2);
  } else if (stepShape.shape === "security" || stepShape.shape === "destructive") {
    taskLevel = Math.max(taskLevel, 4);
    contextLevel = Math.max(contextLevel, 2);
  } else if (stepShape.shape === "write_heavy" && taskKind === "agentic_coding" && !/\b(architecture|security|root cause|production|hard bug|concurrency|incident|race|cryptograph|migration)\b/i.test(lastText)) {
    taskLevel = Math.min(Math.max(taskLevel, 3), 3);
  }

  const level = Math.max(taskLevel, contextLevel);

  let thinkingLevel = Math.max(
    taskTarget.thinkingLevel,
    taskLevel <= 1 ? 0 : taskLevel === 2 ? 2 : taskLevel === 3 ? 3 : taskLevel === 4 ? 4 : 5,
  );
  let speedTarget = Math.min(
    taskTarget.speedTarget,
    taskLevel <= 2 ? 5 : taskLevel === 3 ? 4 : taskLevel === 4 ? 3 : 2,
  );
  let costTarget = Math.max(
    taskTarget.costTarget,
    taskLevel <= 2 ? 2 : taskLevel === 3 ? 3 : taskLevel === 4 ? 4 : 5,
  );
  if (TEXT_EFFICIENT_TASKS.has(taskKind) && taskLevel <= 2) {
    thinkingLevel = Math.min(thinkingLevel, taskTarget.thinkingLevel);
    speedTarget = Math.max(speedTarget, taskTarget.speedTarget);
    costTarget = taskTarget.costTarget;
  }
  const contextOnlyWriteHeavy =
    contextLevel >= 5 &&
    stepShape.shape === "write_heavy" &&
    taskKind === "agentic_coding" &&
    !/\b(one[- ]?million|1m|million[- ]token|large[- ]context|long[- ]context|deep research|production incident|hard bug|architecture|security|destructive|migration|root cause)\b/i.test(lastText);
  const contextOnlyTextEfficient = isTextEfficientContextOnlyPressureProfile({
    taskKind,
    taskLevel,
    contextLevel,
    stepShape,
  }, reqBody);
  if (contextLevel >= 5 && !contextOnlyWriteHeavy && !contextOnlyTextEfficient) {
    thinkingLevel = Math.max(thinkingLevel, 4);
    speedTarget = Math.min(speedTarget, 3);
    costTarget = Math.max(costTarget, 4);
    if (taskKind === "edit_recovery" || taskKind === "architecture_recovery") {
      thinkingLevel = Math.max(thinkingLevel, 5);
      speedTarget = Math.min(speedTarget, 2);
      costTarget = Math.max(costTarget, 5);
    }
  } else if (contextOnlyWriteHeavy) {
    thinkingLevel = Math.min(Math.max(thinkingLevel, 3), 3);
    speedTarget = Math.max(speedTarget, 4);
    costTarget = Math.min(costTarget, 3);
  } else if (contextOnlyTextEfficient) {
    thinkingLevel = Math.min(thinkingLevel, taskTarget.thinkingLevel, 2);
    speedTarget = Math.max(speedTarget, taskTarget.speedTarget, 5);
    costTarget = Math.min(costTarget, taskTarget.costTarget, 2);
  }
  if (stepShape.posture === "think_expensive") {
    thinkingLevel = Math.max(thinkingLevel, 4);
    speedTarget = Math.min(speedTarget, 3);
    costTarget = Math.max(costTarget, 4);
  } else if (stepShape.posture === "type_cheap" && stepShape.shape === "write_heavy" && taskLevel <= 3 && contextLevel <= 4) {
    thinkingLevel = Math.min(thinkingLevel, 3);
    speedTarget = Math.max(speedTarget, 4);
    costTarget = Math.min(costTarget, 3);
  } else if (stepShape.shape === "review") {
    thinkingLevel = Math.max(thinkingLevel, 3);
    speedTarget = Math.max(Math.min(speedTarget, 4), 3);
  } else if (stepShape.shape === "validation") {
    thinkingLevel = Math.min(Math.max(thinkingLevel, 2), 3);
    speedTarget = Math.max(speedTarget, 4);
    costTarget = Math.min(costTarget, 3);
  } else if (stepShape.shape === "security" || stepShape.shape === "destructive") {
    thinkingLevel = Math.max(thinkingLevel, 4);
    speedTarget = Math.min(speedTarget, 3);
    costTarget = Math.max(costTarget, 4);
  }

  return {
    level,
    label: DIFFICULTY_LABELS[level],
    taskKind,
    taskLevel,
    contextLevel,
    thinkingEffort: effortForLevel(thinkingLevel),
    thinkingLevel,
    speedTarget,
    costTarget,
    stepShape,
  };
}

function effectiveRequestProfile(reqBody = {}, env = process.env) {
  if (isAutoMemoryRouteRequest(reqBody)) return internalMemoryRouteProfile();
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

  const balancedPolicy = targets.routingPolicy === "balanced";
  const economyPolicy = targets.routingPolicy === "economy";
  const speedPolicy = targets.routingPolicy === "speed";
  const qualityPolicy = targets.routingPolicy === "quality";
  const efficiencyPolicy = balancedPolicy || economyPolicy || speedPolicy;
  const requestText = latestUserText(reqBody.messages || []);
  const contextDrivenFrontier =
    contextLevel >= 5 &&
    (
      assessed.taskKind === "edit_recovery" ||
      assessed.taskKind === "architecture_recovery" ||
      assessed.stepShape?.posture === "think_expensive" ||
      /\b(one[- ]?million|1m|million[- ]token|million[- ]context|deep research|production incident|hard bug|threat\s+model)\b/i.test(requestText)
    );
  const frontierProfile = contextDrivenFrontier || taskLevel >= 5;
  const contextOnlyPressure = isContextOnlyPressureProfile(assessed, reqBody);
  const textEfficientContextOnlyPressure = isTextEfficientContextOnlyPressureProfile(assessed, reqBody);
  let costTarget;
  let speedTarget;
  let thinkingLevel;

  if (level <= 2) {
    costTarget = Math.min(targets.costTarget, taskCost);
    speedTarget = Math.max(targets.speedTarget, taskSpeed);
    thinkingLevel = Math.min(targets.thinkingTargetLevel, taskThinking);
  } else if (efficiencyPolicy && !frontierProfile) {
    costTarget = Math.min(targets.costTarget, taskCost);
    speedTarget = Math.max(targets.speedTarget, taskSpeed);
    thinkingLevel = Math.max(
      targets.thinkingTargetLevel,
      Math.min(taskThinking, targets.thinkingTargetLevel + 1),
    );
  } else {
    costTarget = Math.max(targets.costTarget, taskCost);
    speedTarget = Math.min(targets.speedTarget, taskSpeed);
    thinkingLevel = Math.max(targets.thinkingTargetLevel, taskThinking);
  }

  if (economyPolicy && !frontierProfile) {
    costTarget = Math.max(1, Math.min(costTarget, targets.costTarget - 1, taskCost - 1));
    speedTarget = Math.min(5, Math.max(speedTarget, targets.speedTarget + 1, taskSpeed));
    thinkingLevel = Math.max(0, Math.min(thinkingLevel, targets.thinkingTargetLevel, taskThinking) - (level >= 3 ? 1 : 0));
  } else if (speedPolicy && !frontierProfile) {
    speedTarget = Math.min(5, Math.max(speedTarget, targets.speedTarget + 1, taskSpeed + 1));
    costTarget = Math.min(costTarget, targets.costTarget, taskCost);
    thinkingLevel = Math.min(thinkingLevel, Math.max(0, targets.thinkingTargetLevel, Math.min(taskThinking, targets.thinkingTargetLevel + 1)));
  } else if (qualityPolicy && level >= 3) {
    costTarget = Math.min(5, Math.max(costTarget, targets.costTarget + 1, taskCost + 1));
    speedTarget = Math.max(1, Math.min(speedTarget, targets.speedTarget - 1, taskSpeed));
    thinkingLevel = Math.min(5, Math.max(thinkingLevel, targets.thinkingTargetLevel + 1, taskThinking + 1));
  }

  const gatedShape = assessed.stepShape?.shape === "security" || assessed.stepShape?.shape === "destructive" || assessed.taskKind === "security_review";
  if (gatedShape) {
    costTarget = Math.max(costTarget, 4);
    thinkingLevel = Math.max(thinkingLevel, 4);
    speedTarget = Math.min(speedTarget, 3);
  } else if (textEfficientContextOnlyPressure) {
    const target = TASK_KIND_TARGETS[assessed.taskKind] || TASK_KIND_TARGETS.general;
    costTarget = Math.min(costTarget, taskCost, target.costTarget || 2, 2);
    thinkingLevel = Math.min(thinkingLevel, taskThinking, target.thinkingLevel ?? 2, 2);
    speedTarget = Math.max(speedTarget, taskSpeed, target.speedTarget || 5, 5);
  } else if (contextOnlyPressure) {
    costTarget = Math.min(costTarget, 3);
    thinkingLevel = Math.min(thinkingLevel, 3);
    speedTarget = Math.max(speedTarget, 4);
  }

  const thinkingEffort = effortForLevel(thinkingLevel);
  return {
    ...assessed,
    level,
    taskLevel,
    contextLevel,
    qualityTarget: (contextOnlyPressure || textEfficientContextOnlyPressure)
      ? Math.max(3, taskLevel)
      : contextLevel >= 5 ? Math.max(4, taskLevel) : Math.max(2, Math.min(5, taskLevel)),
    costTarget,
    speedTarget,
    effort: thinkingEffort,
    thinkingEffort,
    thinkingLevel,
  };
}

function providerPolicyBonus(provider, reqBody = {}, options = {}) {
  const env = options.env || process.env;
  const usage = options.usage || {};
  const targets = getPolicyTargets(env);
  const profile = classifyProvider(provider);
  const request = effectiveRequestProfile(reqBody, env);
  const taskLevel = Number(request.taskLevel || request.level || 3);
  const taskKind = request.taskKind || "general";
  const text = providerText(provider);
  const providerContext = Number(
    (typeof options.getEffectiveContext === "function" ? options.getEffectiveContext(provider) : 0) ||
    provider.compat?.real_context ||
    provider.context ||
    provider.context_length ||
    provider.max_context_window ||
    provider.max_tokens ||
    0,
  );
  const toolCount = (reqBody.tools?.length || 0) + (reqBody.functions?.length || 0);
  const hasTools = toolCount > 0;
  const hasToolHistory = (reqBody.messages || []).some((message) => message.role === "tool" || message.tool_calls?.length > 0);
  const isSwe = /\bswe[- _.]?1(?:[- _.]?[0-9])?\b/.test(text);
  const isAutoReview = isCodexAutoReviewProvider(provider);
  const isHidden = isHiddenProvider(provider);
  const isPrivate = isInternalPrivateProvider(provider);
  const hasToolCodingContract = providerHasToolCodingContract(provider);
  const isGeminiFlash = isGeminiFlashProvider(provider);
  const isGeminiPro = isGeminiProProvider(provider);
  const isSmallFast = isSmallFastProvider(provider);
  const isPriorityFast = isPriorityFastProvider(provider);
  const isOpusClass = /opus/.test(text);
  const isOpus48 = /claude.*opus.*4[- _.]?8|opus[- _.]?4[- _.]?8/.test(text);
  const providerMaxLevel = providerMaxRoutingLevel(provider);
  const isToolBearingCodingTask = hasTools || hasToolHistory || TOOL_HEAVY_TASKS.has(taskKind);
  const requestText = latestUserText(reqBody.messages || []);
  const activeToolContinuation = isActiveToolContinuationRequest(reqBody);
  const observedTokens = Number(reqBody._inputTokens || reqBody._estimatedTokens || 0);
  const explicitMillionContext = /\b(one[- ]?million|1m|million[- ]token|1m[- ]?context|million[- ]?context)\b/.test(requestText);
  const hugeToolRecovery = observedTokens >= 180000 && (hasTools || hasToolHistory) && (taskKind === "edit_recovery" || taskKind === "architecture_recovery");
  const frontierContextNeeded = request.contextLevel >= 5 && (explicitMillionContext || hugeToolRecovery || observedTokens >= 500000);
  const contextOnlyPressure = isContextOnlyPressureProfile(request, reqBody);
  const adequateObservedContext = providerContext > 0 && observedTokens > 0 && providerContext >= observedTokens * 1.1;
  const longContextTextTask =
    !hasTools &&
    !hasToolHistory &&
    (taskKind === "list_summary" || taskKind === "general" || taskKind === "verification" || taskKind === "data_analysis" || taskKind === "research" || taskKind === "explanation" || taskKind === "documentation");
  const explicitHighRisk =
    frontierContextNeeded ||
    /\b(?:deep research|production incident|hard bug|threat\s+model|privilege\s+bypass|security\s+(?:review|audit)|destructive|human\s+sign[- ]?off|before\s+release)\b/.test(requestText);
  const outputBudget = Number(reqBody.max_tokens || reqBody.max_completion_tokens || 0);
  const smallOrMediumOutputBudget = outputBudget > 0 && outputBudget <= 512;
  const deterministicSecurityPatchSignal =
    /\b(?:webhook|token|signature|hmac|auth|constant[- ]?time|timing(?:safe)?|malformed\s+hex|replay)\b/.test(requestText);
  const deterministicSecurityVerificationSignal =
    /\b(?:tests?|regression|constant[- ]?time|timing(?:safe)?|malformed\s+hex|timestamp|replay)\b/.test(requestText);
  const deterministicSecurityPatch =
    smallOrMediumOutputBudget &&
    /\b(?:fix|patch|implement|update)\b/.test(requestText) &&
    deterministicSecurityPatchSignal &&
    deterministicSecurityVerificationSignal &&
    !/\b(?:threat\s+model|exploit|exploitability|architecture|ambiguous|privilege\s+bypass|production\s+incident|before\s+release|security\s+(?:review|audit))\b/.test(requestText);
  const thinkingLatencyGuard =
    smallOrMediumOutputBudget &&
    !explicitHighRisk &&
    !deterministicSecurityPatch &&
    taskLevel <= 4 &&
    (observedTokens <= 0 || observedTokens <= 60000) &&
    /\b(?:fix|patch|implement|update|continue|continua|test|tests?|regression)\b/.test(requestText);
  const balancedPolicy = targets.routingPolicy === "balanced";
  const economyPolicy = targets.routingPolicy === "economy";
  const speedPolicy = targets.routingPolicy === "speed";
  const qualityPolicy = targets.routingPolicy === "quality";
  const efficiencyPolicy = balancedPolicy || economyPolicy || speedPolicy;
  const stepShape = request.stepShape || {};
  let bonus = 0;

  bonus -= Math.abs(profile.cost_group - request.costTarget) * 0.12;
  bonus -= Math.abs(profile.quality_group - request.qualityTarget) * 0.08;
  bonus -= Math.abs(profile.thinking_level - request.thinkingLevel) * 0.10;
  bonus -= Math.abs(profile.speed_group - request.speedTarget) * 0.07;

  const textOnlyContextSpecialistTask = longContextTextTask &&
    !explicitHighRisk &&
    (taskKind === "list_summary" || taskKind === "explanation" || taskKind === "documentation" || taskKind === "general");
  const generationFloorApplies = request.level >= 4 && !textOnlyContextSpecialistTask && (
    isToolBearingCodingTask ||
    taskLevel >= 4 ||
    request.thinkingLevel >= 4 ||
    FRONTIER_TASKS.has(taskKind) ||
    stepShape.shape === "security" ||
    stepShape.shape === "destructive"
  );

  if (generationFloorApplies) {
    if (providerMaxLevel < 4) bonus -= 1.35 + (4 - providerMaxLevel) * 0.25;
    else bonus += Math.min(0.18, (providerMaxLevel - 3) * 0.09);
  }
  const standardFloorApplies = request.level >= 3 && !textOnlyContextSpecialistTask && (
    isToolBearingCodingTask ||
    taskLevel >= 3 ||
    request.thinkingLevel >= 3
  );
  if (!generationFloorApplies && standardFloorApplies && providerMaxLevel < 3) {
    bonus -= 0.85 + (3 - providerMaxLevel) * 0.20;
  }
  if (request.level >= 5 && providerMaxLevel >= 5) bonus += 0.12;
  if (isOpus48 && providerMaxLevel >= 5 && (request.level >= 5 || explicitHighRisk || frontierContextNeeded)) {
    bonus += 0.18;
  }
  const versionPowerBonus = modelVersionPowerBonus(provider);
  if (versionPowerBonus > 0) {
    let versionWeight = 0.25;
    if (request.level >= 5 || request.qualityTarget >= 5 || explicitHighRisk || frontierContextNeeded) versionWeight = 1;
    else if (taskLevel >= 4 || request.qualityTarget >= 4) versionWeight = 0.7;
    else if (taskLevel >= 3) versionWeight = 0.5;
    bonus += versionPowerBonus * versionWeight;
    if (taskLevel <= 2 && profile.cost_group > request.costTarget) bonus -= versionPowerBonus * 0.8;
  }

  if (stepShape.posture === "type_cheap" && stepShape.shape === "write_heavy") {
    if (profile.cost_group <= request.costTarget && profile.speed_group >= request.speedTarget) bonus += 0.18;
    if (profile.cost_group >= 5) bonus -= 0.55;
    if (profile.thinking_level >= 5 && taskLevel <= 3) bonus -= 0.18;
    if (contextOnlyPressure && profile.thinking_level > request.thinkingLevel) {
      bonus -= (profile.thinking_level - request.thinkingLevel) * 0.22;
      if (profile.thinking_level >= 4) bonus -= 0.08;
    }
    if (contextOnlyPressure) {
      const headroom = providerContext > 0 && observedTokens > 0 ? providerContext / observedTokens : 0;
      if (headroom >= 2.0) bonus += 0.22;
      else if (headroom >= 1.5) bonus += 0.14;
      else if (headroom > 0 && headroom < 1.25) bonus -= 0.20;
      if (profile.thinking_level <= request.thinkingLevel && profile.speed_group >= request.speedTarget && profile.cost_group <= request.costTarget) {
        bonus += 0.24;
      }
      if (profile.thinking_level >= 4 && taskLevel <= 3) bonus -= 0.18;
    }
  } else if (stepShape.posture === "think_expensive") {
    if (profile.quality_group >= 5) bonus += 0.18;
    if (profile.thinking_level >= 4) bonus += 0.16;
    if (profile.cost_group <= 2 && profile.quality_group < 5) bonus -= 0.22;
  } else if (stepShape.shape === "security" || stepShape.shape === "destructive") {
    if (profile.quality_group >= 5) bonus += 0.18;
    if (profile.thinking_level >= 4) bonus += 0.14;
    if (profile.quality_group <= 3 || profile.thinking_level <= 2) bonus -= 0.30;
    if (deterministicSecurityPatch) {
      if (profile.thinking_level >= 4) bonus -= 0.55;
      if (profile.thinking_level <= 3 && profile.quality_group >= 4 && profile.cost_group <= request.costTarget) bonus += 0.22;
    }
  } else if (stepShape.shape === "review") {
    if (isAutoReview) bonus += 0.25;
    if (profile.cost_group <= 3 && profile.quality_group >= 4) bonus += 0.10;
    if (profile.cost_group >= 5) bonus -= 0.16;
  } else if (stepShape.shape === "validation") {
    if (profile.speed_group >= 4 && profile.cost_group <= 3) bonus += 0.14;
    if (profile.cost_group >= 5) bonus -= 0.24;
  }

  if (taskLevel <= 2) {
    if (profile.cost_group <= request.costTarget) bonus += 0.20;
    if (profile.speed_group >= 4) bonus += 0.16;
    if (profile.cost_group >= 5) bonus -= 0.45;
    if (profile.quality_group >= 5) bonus -= 0.12;
    if (profile.thinking_level >= 4) bonus -= 0.16;
  } else if (taskLevel >= 4) {
    if (profile.quality_group >= request.qualityTarget) bonus += 0.20;
    if (profile.thinking_level >= request.thinkingLevel) bonus += 0.20;
    if (profile.cost_group <= request.costTarget) bonus += 0.12;
    if (profile.quality_group < request.qualityTarget - 1) bonus -= 0.35;
    if (profile.thinking_level < request.thinkingLevel - 1) bonus -= 0.55;
    if (profile.cost_group < request.costTarget - 1) bonus -= 0.20;
    if (profile.cost_group > request.costTarget) bonus -= (profile.cost_group - request.costTarget) * 0.22;
  }

  const avgCost = Number(usage.ewma_cost_group || 0);
  const envTarget = targets.costTarget;
  if (avgCost > 0) {
    if (avgCost > envTarget + 0.25) bonus += (envTarget - profile.cost_group) * 0.05;
    if (avgCost < envTarget - 0.25 && request.level >= 4) bonus += (profile.cost_group - envTarget) * 0.04;
  }

  if (isSwe) {
    if (taskKind === "direct_answer" && !hasTools && !hasToolHistory) bonus += 0.90;
    else if (taskKind === "list_summary") bonus += 0.75;
    else if (TOOL_HEAVY_TASKS.has(taskKind)) bonus -= 0.65;
    else if (taskKind === "completion_review" || taskKind === "code_review" || taskKind === "verification") bonus -= 0.35;
    else bonus -= 0.18;
    if (isToolBearingCodingTask && taskKind !== "list_summary" && taskKind !== "direct_answer") bonus -= 0.25;
  }

  if (isAutoReview) {
    if (activeToolContinuation) bonus -= 1.65;
    else if (taskKind === "completion_review" || taskKind === "code_review") bonus += 1.20;
    else if (taskKind === "verification") bonus -= 0.85;
    else if (TOOL_HEAVY_TASKS.has(taskKind)) bonus -= 1.35;
    else bonus -= 1.10;
  } else if (isHidden) {
    bonus -= 0.90;
  }

  if (isPrivate) {
    if (isToolBearingCodingTask && !hasToolCodingContract) bonus -= 2.10;
    else if (isToolBearingCodingTask) bonus -= 0.35;
    else if (taskKind === "list_summary" || taskKind === "direct_answer") bonus -= 0.10;
    else bonus -= 0.35;
  }

  if (isGeminiFlash) {
    if (!hasTools && !hasToolHistory && request.contextLevel >= 4 && (taskKind === "list_summary" || taskKind === "general" || taskKind === "verification" || taskKind === "data_analysis" || taskKind === "research")) bonus += 0.45;
    if (!hasTools && !hasToolHistory && request.contextLevel >= 5 && taskKind === "list_summary") bonus += 0.55;
    if (isToolBearingCodingTask || taskKind === "completion_review") bonus -= 0.75;
    if (taskKind === "edit_recovery" || taskKind === "architecture_recovery") bonus -= 0.40;
  }

  if (isGeminiPro) {
    if (!hasTools && !hasToolHistory && request.contextLevel >= 4) bonus += 0.25;
    if (taskKind === "edit_recovery") bonus -= 0.15;
  }

  if (isSmallFast) {
    if (taskLevel <= 2 && request.contextLevel <= 2) bonus += 0.25;
    if (taskLevel >= 4) bonus -= 0.30;
    if (FRONTIER_TASKS.has(taskKind)) bonus -= 0.35;
  }

  if (taskKind === "planning") {
    if (profile.quality_group >= 5) bonus += 0.30;
    if (profile.thinking_level >= 4) bonus += 0.28;
    if (providerCaps(provider).includes("max")) bonus += 0.18;
    if (profile.cost_group <= 2) bonus -= 0.28;
    if (isOpusClass && profile.cost_group <= request.costTarget + 1) bonus += 0.18;
    if (isSmallFast && profile.quality_group < 5) bonus -= 0.24;
  }

  if (isPriorityFast) {
    if (request.speedTarget >= 5 || taskLevel <= 3) bonus += 0.18;
    if (taskLevel >= 5 && request.speedTarget <= 3) bonus -= 0.12;
  }

  if (efficiencyPolicy && taskLevel >= 3 && !frontierContextNeeded) {
    const opusCostPenalty = economyPolicy ? 1.05 : speedPolicy ? 0.70 : 0.85;
    const opusTaskPenalty = economyPolicy ? 0.45 : speedPolicy ? 0.25 : 0.35;
    if (isOpusClass && request.costTarget <= 3) bonus -= opusCostPenalty;
    if (isOpusClass && taskLevel <= 4) bonus -= opusTaskPenalty;
    if (!isOpusClass && profile.cost_group === 3 && profile.quality_group >= 4) bonus += balancedPolicy ? 0.28 : 0.18;
    if (profile.thinking_level > request.thinkingLevel + 1) bonus -= economyPolicy ? 0.26 : 0.18;
    if (profile.speed_group >= request.speedTarget && profile.cost_group <= request.costTarget) bonus += speedPolicy ? 0.20 : 0.12;
  }

  if (economyPolicy) {
    if (profile.cost_group <= request.costTarget) bonus += 0.22;
    if (profile.cost_group > request.costTarget) bonus -= (profile.cost_group - request.costTarget) * 0.24;
    if (!explicitHighRisk && profile.cost_group >= 4) bonus -= 0.22;
    if (profile.cost_group <= 2 && profile.quality_group >= 3) bonus += 0.12;
  } else if (speedPolicy) {
    if (profile.speed_group >= request.speedTarget) bonus += 0.22;
    if (profile.speed_group < request.speedTarget) bonus -= (request.speedTarget - profile.speed_group) * 0.18;
    if (isPriorityFast) bonus += 0.08;
    if (profile.thinking_level > request.thinkingLevel + 1) bonus -= 0.14;
  } else if (qualityPolicy) {
    if (profile.quality_group >= request.qualityTarget) bonus += 0.20;
    if (profile.thinking_level >= request.thinkingLevel) bonus += 0.16;
    if (profile.cost_group >= request.costTarget - 1 && profile.quality_group >= 4) bonus += 0.10;
    if (profile.quality_group < request.qualityTarget) bonus -= (request.qualityTarget - profile.quality_group) * 0.18;
    if (isSmallFast && profile.quality_group < request.qualityTarget) bonus -= 0.18;
  }

  if (taskKind === "edit_recovery") {
    if (frontierContextNeeded && /opus|gpt[- _.]?5[- _.]?5/.test(text)) bonus += 0.45;
    if (!frontierContextNeeded && isOpusClass) bonus -= 0.72;
    if (!frontierContextNeeded && profile.cost_group === 3) bonus += 0.24;
    if (profile.quality_group >= 5) bonus += frontierContextNeeded ? 0.35 : 0.18;
    if (profile.thinking_level >= 4) bonus += frontierContextNeeded ? 0.32 : 0.12;
    if (!frontierContextNeeded && profile.thinking_level >= 5) bonus -= 0.10;
    if (profile.thinking_level < 3) bonus -= 0.45;
    if (profile.cost_group <= 1) bonus -= 0.35;
    if (/gemini.*flash|flash[- _.]?lite|swe[- _.]?1/.test(text)) bonus -= 0.35;
  }

  if (taskKind === "architecture_recovery") {
    if (frontierContextNeeded && /opus/.test(text)) bonus += 0.42;
    if (!frontierContextNeeded && isOpusClass) bonus -= 0.72;
    if (!frontierContextNeeded && profile.cost_group === 3) bonus += 0.24;
    if (profile.quality_group >= 5) bonus += frontierContextNeeded ? 0.30 : 0.18;
    if (profile.thinking_level >= 4) bonus += frontierContextNeeded ? 0.28 : 0.12;
    if (!frontierContextNeeded && profile.thinking_level >= 5) bonus -= 0.10;
    if (profile.thinking_level < 3) bonus -= 0.42;
    if (profile.cost_group <= 1) bonus -= 0.32;
    if (/gemini.*flash|flash[- _.]?lite|swe[- _.]?1/.test(text)) bonus -= 0.42;
  }

  if (taskKind === "security_review" || taskKind === "debugging" || taskKind === "refactor" || taskKind === "benchmarking") {
    if ((explicitHighRisk || taskLevel >= 5) && /opus|gpt[- _.]?5[- _.]?5/.test(text)) bonus += 0.12;
    else if (isOpusClass && request.costTarget <= 4) bonus -= 0.28;
    if (!explicitHighRisk && /gpt[- _.]?5[- _.]?5/.test(text) && request.costTarget <= 4) bonus -= 0.16;
    if (profile.cost_group <= request.costTarget && profile.quality_group >= 4) bonus += 0.12;
    if (profile.quality_group >= request.qualityTarget) bonus += 0.12;
    if (profile.thinking_level >= request.thinkingLevel) bonus += 0.10;
  }

  if (taskKind === "translation_rewrite" || taskKind === "explanation" || taskKind === "documentation") {
    if (profile.cost_group <= request.costTarget && profile.speed_group >= request.speedTarget) bonus += 0.12;
    if (profile.cost_group >= 4 && taskLevel <= 2) bonus -= 0.15;
  }

  if (thinkingLatencyGuard) {
    if (profile.thinking_level >= 4) bonus -= 0.48;
    if (profile.thinking_level <= 3 && profile.quality_group >= 4 && profile.cost_group <= request.costTarget) bonus += 0.20;
  }

  if (request.contextLevel >= 5) {
    if (providerContext >= 800000) {
      bonus += (taskKind === "edit_recovery" || taskKind === "architecture_recovery")
        ? (frontierContextNeeded ? 0.55 : 0.18)
        : (frontierContextNeeded ? 0.55 : (longContextTextTask ? 0.55 : (stepShape.shape === "write_heavy" ? 0.10 : 0.25)));
      if (explicitMillionContext && isOpusClass) bonus += 0.28;
    }
    else if (providerContext > 0 && providerContext < 500000 && !adequateObservedContext) {
      bonus -= explicitMillionContext ? 0.45 : (stepShape.shape === "write_heavy" ? 0.08 : 0.25);
    }
  } else if (providerContext >= 800000 && taskKind !== "edit_recovery" && taskKind !== "architecture_recovery") {
    bonus -= request.contextLevel <= 3 ? 0.35 : 0.18;
    if (isOpusClass && !hasTools && !hasToolHistory) bonus -= 0.35;
  }

  return bonus;
}

const DIFFICULTY_MARKER_TEXT_RE =
  /^\s*\[?\s*LLM_PROXY_TASK_DIFFICULTY\b\s+(?:level=)?([1-5])(?:\/5)?(?:\s+effort=(none|minimal|low|medium|high|xhigh))?(?:\s+speed=([1-5]))?(?:\s+reason=([a-z0-9_.:-]+))?\s*\]?/i;
const INTERNAL_ROUTING_DIFFICULTY_MARKER_TEXT_RE =
  /^\s*\[?\s*LLM_PROXY_INTERNAL_ROUTING\b\s+(?:(?:level=)?([1-5])(?:\/5)?\s+)?(?:effort=(none|minimal|low|medium|high|xhigh)\s+)?speed=([1-5])\s+reason=([a-z0-9_.:-]+)\s*\]?/i;
const TASK_STATUS_MARKER_TEXT_RE =
  /^\s*\[?\s*LLM_PROXY_TASK_STATUS\b\s+state=(working|complete|blocked)(?:\s+reason=([a-z0-9_.:-]+))?\s*\]?/i;
const BARE_DIFFICULTY_MARKER_TEXT_RE =
  /^\s*\[?\s*(?:(?:level=)?([1-5])(?:\/5)?\s+)?effort=(none|minimal|low|medium|high|xhigh)\s+speed=([1-5])\s+reason=([a-z0-9_.:-]+)(?:\s*\])?/i;
const SPEED_ONLY_DIFFICULTY_MARKER_TEXT_RE =
  /^\s*\[?\s*(?:(?:level=)?([1-5])(?:\/5)?\s+)?speed=([1-5])\s+reason=([a-z0-9_.:-]+)(?:\s*\])?/i;
const BARE_DIFFICULTY_METADATA_LINE_RE =
  /^\s*\[?\s*(?:(?:level=)?[1-5](?:\/5)?\s+)?effort=(none|minimal|low|medium|high|xhigh)\s+speed=[1-5]\s+reason=[a-z0-9_.:-]+\s*\]?\s*$/i;
const SPEED_ONLY_DIFFICULTY_METADATA_LINE_RE =
  /^\s*\[?\s*(?:(?:level=)?[1-5](?:\/5)?\s+)?speed=[1-5]\s+reason=[a-z0-9_.:-]+\s*\]?\s*$/i;
const TRAILING_BARE_DIFFICULTY_METADATA_RE =
  /\s+\[?\s*(?:(?:level=)?[1-5](?:\/5)?\s+)?effort=(none|minimal|low|medium|high|xhigh)\s+speed=[1-5]\s+reason=[a-z0-9_.:-]+\s*\]?\s*$/i;
const TRAILING_SPEED_ONLY_DIFFICULTY_METADATA_RE =
  /\s+\[?\s*(?:(?:level=)?[1-5](?:\/5)?\s+)?speed=[1-5]\s+reason=[a-z0-9_.:-]+\s*\]?\s*$/i;
const ORPHAN_DIFFICULTY_MARKER_TAIL_LINE_RE =
  /^\s*\[?\s*\/5\s+reason=[a-z0-9_.:-]+\s*\]?\s*$/i;
const TRAILING_ORPHAN_DIFFICULTY_MARKER_TAIL_RE =
  /\s+\[?\s*\/5\s+reason=[a-z0-9_.:-]+\s*\]?\s*$/i;
const ORPHAN_REASON_CONTINUATION_LINE_RE =
  /^\s*["']?[-_][a-z0-9][a-z0-9_.:-]*\]?\s*["']?\s*$/i;
const MALFORMED_DIFFICULTY_MARKER_LINE_RE =
  /^\s*\[?\s*LLM_PROXY_(?:INTERNAL_ROUTING|TASK_DIFFICULTY)\b[^\r\n]*(?:\r?\n|$)/i;
const MALFORMED_TASK_STATUS_MARKER_LINE_RE =
  /^\s*\[?\s*LLM_PROXY_TASK_STATUS\b[^\r\n]*(?:\r?\n|$)/i;
const DIFFICULTY_MARKER_JSON_KEYS = new Set([
  "level",
  "taskLevel",
  "contextLevel",
  "effort",
  "thinkingEffort",
  "thinkingLevel",
  "speed",
  "speedTarget",
  "costTarget",
  "reason",
  "taskKind",
]);

function includeLegacyBareMarkers(options = {}) {
  return options.includeLegacyBare !== false;
}

function maybeLegacyBareDifficultyMarkerFragment(text = "") {
  const trimmed = String(text || "").trimStart().replace(/^\[\s*/, "");
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  const startingTokens = [
    "effort=",
    "speed=",
    "level=",
    "1/5",
    "2/5",
    "3/5",
    "4/5",
    "5/5",
  ];
  if (startingTokens.some((token) => token.startsWith(lower) || lower.startsWith(token))) return true;
  return /^(?:(?:(?:level=)?[1-5](?:\/5)?\s+)?effort=(?:none|minimal|low|medium|high|xhigh)?(?:\s+speed=?[1-5]?)?(?:\s+reason=?[a-z0-9_.:-]*)?|(?:(?:level=)?[1-5](?:\/5)?\s+)?speed=?[1-5]?(?:\s+reason=?[a-z0-9_.:-]*)?)$/i.test(trimmed);
}

function isOrphanReasonContinuationLine(text = "") {
  return ORPHAN_REASON_CONTINUATION_LINE_RE.test(String(text || ""));
}

function stripLeadingReasonContinuationLines(text = "") {
  let remaining = String(text || "");
  let changed = false;
  while (true) {
    const blankMatch = remaining.match(/^[ \t]*(?:\r?\n)+/);
    if (blankMatch) {
      remaining = remaining.slice(blankMatch[0].length);
      changed = true;
      continue;
    }
    const newlineMatch = remaining.match(/^([^\r\n]*)(\r?\n|$)/);
    if (!newlineMatch) break;
    const line = newlineMatch[1] || "";
    const newline = newlineMatch[2] || "";
    if (!isOrphanReasonContinuationLine(line)) break;
    remaining = remaining.slice(line.length + newline.length);
    changed = true;
    if (!newline) break;
  }
  return { content: remaining, changed };
}

function difficultySpeedForLevel(level) {
  if (level <= 2) return 5;
  if (level === 3) return 4;
  return 3;
}

function matchDifficultyMarkerText(text = "", options = {}) {
  const raw = String(text || "");
  const includeLegacyBare = includeLegacyBareMarkers(options);
  return raw.match(INTERNAL_ROUTING_DIFFICULTY_MARKER_TEXT_RE) ||
    raw.match(DIFFICULTY_MARKER_TEXT_RE) ||
    (includeLegacyBare ? (raw.match(BARE_DIFFICULTY_MARKER_TEXT_RE) ||
      raw.match(SPEED_ONLY_DIFFICULTY_MARKER_TEXT_RE)) : null);
}

function matchTaskStatusMarkerText(text = "") {
  return String(text || "").match(TASK_STATUS_MARKER_TEXT_RE);
}

function maybeTaskStatusMarkerFragment(text = "") {
  const trimmed = String(text || "").trimStart().replace(/^\[\s*/, "");
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  const prefix = "llm_proxy_task_status";
  if (prefix.startsWith(lower) || lower.startsWith(prefix)) return true;
  return /^llm_proxy_task_status(?:\s+state=(?:working|complete|blocked)?(?:\s+reason=?[a-z0-9_.:-]*)?)?$/i.test(trimmed);
}

function parseTaskStatusMarker(text = "") {
  const match = matchTaskStatusMarkerText(text);
  if (!match) return null;
  return {
    state: String(match[1] || "").toLowerCase(),
    reason: normalizeMarkerReason(match[2] || ""),
  };
}

function parseDifficultyMarker(text, options = {}) {
  const raw = String(text || "");
  const includeLegacyBare = includeLegacyBareMarkers(options);
  const internalMatch = raw.match(INTERNAL_ROUTING_DIFFICULTY_MARKER_TEXT_RE);
  const fullMatch = internalMatch ? null : raw.match(DIFFICULTY_MARKER_TEXT_RE);
  const bareMatch = internalMatch || fullMatch || !includeLegacyBare ? null : raw.match(BARE_DIFFICULTY_MARKER_TEXT_RE);
  const speedOnlyMatch = internalMatch || fullMatch || bareMatch || !includeLegacyBare ? null : raw.match(SPEED_ONLY_DIFFICULTY_MARKER_TEXT_RE);
  if (!internalMatch && !fullMatch && !bareMatch && !speedOnlyMatch) return null;
  const effort = normalizeEffort((internalMatch ? internalMatch[2] : (fullMatch ? fullMatch[2] : (bareMatch ? bareMatch[2] : ""))) || "");
  const inferredLevel = effortLevel(effort || "medium", "medium") || 3;
  const level = Number(internalMatch ? (internalMatch[1] || inferredLevel) : (fullMatch ? fullMatch[1] : (bareMatch ? (bareMatch[1] || inferredLevel) : (speedOnlyMatch[1] || 3))));
  const normalizedEffort = normalizeEffort(effort || effortForLevel(level));
  const speed = clampInt(internalMatch ? internalMatch[3] : (fullMatch ? fullMatch[3] : (bareMatch ? bareMatch[3] : speedOnlyMatch[2])), 1, 5, difficultySpeedForLevel(level));
  const reason = normalizeMarkerReason((internalMatch ? internalMatch[4] : (fullMatch ? fullMatch[4] : (bareMatch ? bareMatch[4] : speedOnlyMatch[3]))) || "");
  return {
    level,
    label: DIFFICULTY_LABELS[level],
    effort: normalizedEffort,
    thinkingEffort: normalizedEffort,
    thinkingLevel: effortLevel(normalizedEffort),
    speed,
    speedTarget: speed,
    costTarget: level <= 2 ? 2 : level,
    implicitCostTarget: true,
    reason,
  };
}

function parseDifficultyMarkerJson(text = "") {
  const raw = String(text || "").trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (!keys.length || !keys.every((key) => DIFFICULTY_MARKER_JSON_KEYS.has(key))) return null;

  const hasMarkerSignal =
    parsed.level != null ||
    parsed.effort != null ||
    parsed.thinkingEffort != null ||
    parsed.speed != null ||
    parsed.speedTarget != null ||
    parsed.reason != null ||
    parsed.taskLevel != null ||
    parsed.contextLevel != null;
  if (!hasMarkerSignal) return null;

  const levelFallback = Math.max(
    1,
    Math.min(
      5,
      Number(parsed.taskLevel || parsed.contextLevel || parsed.costTarget || 3) || 3,
    ),
  );
  const level = clampInt(parsed.level, 1, 5, levelFallback);
  const effort = normalizeEffort(parsed.effort || parsed.thinkingEffort || effortForLevel(level));
  const speed = clampInt(parsed.speed ?? parsed.speedTarget, 1, 5, difficultySpeedForLevel(level));
  const reason = normalizeMarkerReason(parsed.reason || "");
  return {
    level,
    label: DIFFICULTY_LABELS[level],
    effort,
    thinkingEffort: effort,
    thinkingLevel: clampInt(parsed.thinkingLevel, 0, 5, effortLevel(effort)),
    speed,
    speedTarget: speed,
    costTarget: clampInt(parsed.costTarget, 1, 5, level <= 2 ? 2 : level),
    implicitCostTarget: parsed.costTarget == null,
    reason,
    taskLevel: clampInt(parsed.taskLevel, 1, 5, level),
    contextLevel: clampInt(parsed.contextLevel, 1, 5, level),
    taskKind: typeof parsed.taskKind === "string" ? parsed.taskKind : undefined,
  };
}

const NON_SPECIFIC_MARKER_REASONS = new Set([
  "none",
  "unknown",
  "na",
  "n_a",
  "null",
  "undefined",
  "general",
]);

function normalizeMarkerReason(reason) {
  const match = String(reason || "").match(/^([a-z0-9_.:-]*?)([A-Z][^\s]*)$/);
  const value = (match ? match[1] : String(reason || "")).trim();
  const canonical = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return !value || NON_SPECIFIC_MARKER_REASONS.has(canonical) ? "" : value;
}

function markerHasSpecificTaskSignal(marker = {}) {
  if (marker.taskKind && marker.taskKind !== "general") return true;
  const reason = normalizeMarkerReason(marker.reason || "");
  if (!reason) return false;
  const inferred = taskKindFromReason(reason, "__unknown__");
  return inferred !== "__unknown__" && inferred !== "general";
}

function taskKindFromReason(reason = "", fallback = "general") {
  const raw = normalizeTaskText(String(reason || ""));
  const canonicalSlug = raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (TASK_KIND_TARGETS[canonicalSlug]) return canonicalSlug;

  const text = raw.replace(/[_:.-]+/g, " ");
  if (!text) return fallback || "general";
  if (/\b(exact|name|reply|direct|greeting|ping)\b/.test(text) || asksIdentityProbeText(text)) return "direct_answer";
  if (/\b(list|summary|summarize|recap|status|handoff|todo)\b/.test(text)) return "list_summary";
  if (/\b(completion|completed|final|approval|auto review|code review|post implementation)\b/.test(text)) return "completion_review";
  if (/\b(security|vulnerability|sql injection|xss|threat model|secret)\b/.test(text)) return "security_review";
  if (/\b(debug|debugging|root cause|stack trace|error|failure|logs|timeout)\b/.test(text)) return "debugging";
  if (/\b(refactor|modularize|cleanup|technical debt)\b/.test(text)) return "refactor";
  if (/\b(test|coverage|regression test|unit test|e2e)\b/.test(text)) return "test_generation";
  if (/\b(deploy|docker|ssh|container|health check)\b/.test(text)) return "deployment_ops";
  if (/\b(benchmark|latency|tokens|cost|a b test|performance comparison)\b/.test(text)) return "benchmarking";
  if (/\b(research|investigate|survey|compare options)\b/.test(text)) return "research";
  if (/\b(documentation|readme|docs|runbook|instructions)\b/.test(text)) return "documentation";
  if (/\b(translate|rewrite|tone|grammar|copyedit)\b/.test(text)) return "translation_rewrite";
  if (/\b(explain|explanation|classif(?:y|ication)?|teaching|how does|compare)\b/.test(text)) return "explanation";
  if (/\b(image|screenshot|vision|diagram|ocr)\b/.test(text)) return "vision_analysis";
  if (/\b(video|animation|clip)\b/.test(text)) return "video_generation";
  if (/\b(verify|verification|audit|regression|validate|check)\b/.test(text)) return "verification";
  if (/\b(edit recovery|patch failed|edit failed|stale|shim|apply patch|tool repair)\b/.test(text)) return "edit_recovery";
  if (
    /\b(architecture recovery|production incident|proxy incident|benchmark fairness|long context recovery|deep context recovery)\b/.test(text) ||
    (/\barchitecture\b/.test(text) && /\b(recovery|incident|risk|decision)\b/.test(text))
  ) return "architecture_recovery";
  if (/\b(recovery|workflow|terminal agent|agent plan|resume safely)\b/.test(text)) return "agentic_coding";
  if (/\b(repo|proxy|routing|compatibility|refactor|multi file|coding|agentic|implementation|debug|test)\b/.test(text)) return "agentic_coding";
  return fallback || "general";
}

function isHighRiskMarkerTaskKind(taskKind) {
  return taskKind === "security_review" ||
    taskKind === "completion_review" ||
    taskKind === "architecture_recovery" ||
    taskKind === "deployment_ops";
}

function taskKindSupportedByDeterministicAssessment(markerTaskKind, base = {}) {
  if (!markerTaskKind || markerTaskKind === base.taskKind) return true;
  if (!isHighRiskMarkerTaskKind(markerTaskKind)) return true;
  if (markerTaskKind === "security_review") {
    return base.taskKind === "security_review" ||
      base.stepShape?.shape === "security" ||
      base.stepShape?.gate === "human_signoff";
  }
  if (markerTaskKind === "completion_review") {
    return base.taskKind === "completion_review" || base.taskKind === "code_review";
  }
  if (markerTaskKind === "architecture_recovery") {
    return base.taskKind === "architecture_recovery" || base.taskKind === "edit_recovery";
  }
  if (markerTaskKind === "deployment_ops") {
    return base.taskKind === "deployment_ops" || base.stepShape?.shape === "destructive";
  }
  return true;
}

function constrainMarkerTaskKind(markerTaskKind, base = {}) {
  return taskKindSupportedByDeterministicAssessment(markerTaskKind, base)
    ? markerTaskKind
    : base.taskKind || "general";
}

function constrainTrustedAssessmentTaskKind(assessedTaskKind, base = {}) {
  if (
    (assessedTaskKind === "security_review" ||
      assessedTaskKind === "completion_review" ||
      assessedTaskKind === "architecture_recovery") &&
    !taskKindSupportedByDeterministicAssessment(assessedTaskKind, base)
  ) {
    return base.taskKind || "general";
  }
  return assessedTaskKind || base.taskKind || "general";
}

function stepShapeFromTrustedTaskKind(taskKind, baseStepShape = {}) {
  if (taskKind === "security_review") return stepShapeProfile("security");
  if (taskKind === "direct_answer") return stepShapeProfile("direct");
  if (taskKind === "completion_review" || taskKind === "code_review") return stepShapeProfile("review");
  if (taskKind === "verification") return stepShapeProfile("validation");
  if (taskKind === "benchmarking") return stepShapeProfile("benchmark");
  if (taskKind === "deployment_ops") {
    if (baseStepShape.shape === "destructive") return baseStepShape;
    return stepShapeProfile("write_heavy");
  }
  if (
    taskKind === "planning" ||
    taskKind === "research" ||
    taskKind === "debugging" ||
    taskKind === "data_analysis" ||
    taskKind === "edit_recovery" ||
    taskKind === "architecture_recovery"
  ) {
    return stepShapeProfile("read_heavy");
  }
  if (
    taskKind === "documentation" ||
    taskKind === "translation_rewrite" ||
    taskKind === "test_generation" ||
    taskKind === "agentic_coding" ||
    taskKind === "list_summary" ||
    taskKind === "explanation" ||
    taskKind === "general"
  ) {
    const overrides = taskKind === "list_summary" || taskKind === "explanation" || taskKind === "general"
      ? { gate: "none" }
      : {};
    return stepShapeProfile("write_heavy", overrides);
  }
  if (baseStepShape.shape && baseStepShape.shape !== "security" && baseStepShape.shape !== "destructive") {
    return baseStepShape;
  }
  return stepShapeProfile("write_heavy");
}

function profileFromTrustedTaskAssessment(reqBody = {}, assessment = {}) {
  const base = assessRequestDifficulty(reqBody.messages || [], reqBody);
  const normalizedAssessment = {
    ...assessment,
    reason: normalizeMarkerReason(assessment.reason || ""),
  };
  const baseLevel = Number(base.level || 3);
  const baseTaskLevel = Number(base.taskLevel || baseLevel);
  const baseContextLevel = Number(base.contextLevel || baseLevel);
  const baseThinkingLevel = Number(base.thinkingLevel ?? baseLevel);
  const baseSpeedTarget = Number(base.speedTarget || 4);
  const baseCostTarget = Number(base.costTarget || Math.max(1, Math.min(5, baseLevel)));
  const assessmentHasSpecificSignal = markerHasSpecificTaskSignal(normalizedAssessment);
  const reasonTaskKind = assessmentHasSpecificSignal ? taskKindFromReason(normalizedAssessment.reason, "") : "";
  const assessmentTaskKind = assessmentHasSpecificSignal ? normalizedAssessment.taskKind : "";
  const assessedTaskKind = reasonTaskKind || assessmentTaskKind || base.taskKind || taskKindFromReason(assessmentTaskKind, base.taskKind || "general");
  const taskKind = constrainTrustedAssessmentTaskKind(assessedTaskKind, base);
  const assessmentTaskRejected = assessedTaskKind !== taskKind;
  let markerLevel = clampInt(normalizedAssessment.level, 1, 5, Number(base.taskLevel || base.level || 3));
  const simpleTask = taskKind === "direct_answer" || taskKind === "list_summary";
  const stepShape = stepShapeFromTrustedTaskKind(taskKind, base.stepShape || {});
  const contextOnlyPressure = isContextOnlyPressureProfile({
    ...base,
    taskKind,
    stepShape,
  }, reqBody);
  const textEfficientContextOnlyPressure = isTextEfficientContextOnlyPressureProfile({
    ...base,
    taskKind,
    stepShape,
  }, reqBody);
  const taskFallback = simpleTask
    ? Math.min(markerLevel, 2)
    : contextOnlyPressure
      ? Number(base.taskLevel || base.level || markerLevel)
      : markerLevel;
  let taskLevel = clampInt(normalizedAssessment.taskLevel, 1, 5, taskFallback);
  const contextFallback = simpleTask && markerLevel <= 2
    ? Math.min(Number(base.contextLevel || markerLevel), markerLevel)
    : Number(base.contextLevel || markerLevel);
  let contextLevel = clampInt(normalizedAssessment.contextLevel, 1, 5, contextFallback);
  let effectiveLevel = simpleTask && markerLevel <= 2
    ? markerLevel
    : Math.max(markerLevel, contextLevel);
  let thinkingLevel = normalizedAssessment.thinkingLevel != null
    ? clampInt(normalizedAssessment.thinkingLevel, 0, 5, markerLevel)
    : effortLevel(normalizedAssessment.effort || normalizedAssessment.thinkingEffort, effortForLevel(Math.min(5, markerLevel)));
  let speedTarget = clampInt(normalizedAssessment.speedTarget || normalizedAssessment.speed, 1, 5, markerLevel <= 2 ? 5 : 4);
  let costTarget = clampInt(normalizedAssessment.costTarget, 1, 5, markerLevel <= 2 ? 2 : markerLevel);

  if (textEfficientContextOnlyPressure) {
    const target = TASK_KIND_TARGETS[taskKind] || TASK_KIND_TARGETS.general;
    thinkingLevel = Math.min(thinkingLevel, target.thinkingLevel ?? 2, 2);
    speedTarget = Math.max(speedTarget, target.speedTarget || 5, 5);
    costTarget = Math.min(costTarget, target.costTarget || 2, 2);
  } else if (contextOnlyPressure) {
    thinkingLevel = Math.min(thinkingLevel, 3);
    speedTarget = Math.max(speedTarget, 4);
    costTarget = Math.min(costTarget, 3);
  }
  if (!assessmentHasSpecificSignal) {
    markerLevel = Math.min(markerLevel, baseLevel);
    taskLevel = Math.min(taskLevel, baseTaskLevel);
    contextLevel = Math.min(contextLevel, baseContextLevel);
    thinkingLevel = Math.min(thinkingLevel, baseThinkingLevel);
    speedTarget = Math.max(speedTarget, baseSpeedTarget);
    costTarget = Math.min(costTarget, baseCostTarget);
    effectiveLevel = simpleTask && markerLevel <= 2
      ? markerLevel
      : Math.max(markerLevel, taskLevel, contextLevel);
  }
  if (assessmentTaskRejected) {
    thinkingLevel = Math.min(thinkingLevel, Number(base.thinkingLevel ?? thinkingLevel));
    speedTarget = Math.max(speedTarget, Number(base.speedTarget || speedTarget));
    costTarget = Math.min(costTarget, Number(base.costTarget || costTarget));
  }
  return {
    ...base,
    ...normalizedAssessment,
    level: effectiveLevel,
    label: DIFFICULTY_LABELS[effectiveLevel],
    taskKind,
    taskLevel,
    contextLevel,
    thinkingEffort: (contextOnlyPressure || textEfficientContextOnlyPressure || assessmentTaskRejected) ? effortForLevel(thinkingLevel) : normalizedAssessment.effort || normalizedAssessment.thinkingEffort || effortForLevel(thinkingLevel),
    thinkingLevel,
    speedTarget,
    costTarget,
    stepShape,
    source: "assessment",
  };
}

function profileFromAssessmentMarker(reqBody = {}, marker = {}) {
  const base = assessRequestDifficulty(reqBody.messages || [], reqBody);
  const baseLevel = Number(base.level || 3);
  const baseTaskLevel = Number(base.taskLevel || baseLevel);
  const baseContextLevel = Number(base.contextLevel || baseLevel);
  const baseThinkingLevel = Number(base.thinkingLevel ?? baseLevel);
  const baseSpeedTarget = Number(base.speedTarget || 4);
  const baseCostTarget = Number(base.costTarget || Math.max(1, Math.min(5, baseLevel)));
  const markerHasSpecificSignal = markerHasSpecificTaskSignal(marker);
  let level = clampInt(marker.level, 1, 5, base.level || 3);
  const markerTaskKind = marker.taskKind || taskKindFromReason(marker.reason, base.taskKind || "general");
  const taskKind = constrainMarkerTaskKind(markerTaskKind, base);
  const markerTaskRejected = markerTaskKind !== taskKind;
  const simpleTask = taskKind === "direct_answer" || taskKind === "list_summary";
  const stepShape = stepShapeFromTrustedTaskKind(taskKind, base.stepShape || {});
  const contextOnlyPressure = isContextOnlyPressureProfile({
    ...base,
    taskKind,
    stepShape,
  }, reqBody);
  const textEfficientContextOnlyPressure = isTextEfficientContextOnlyPressureProfile({
    ...base,
    taskKind,
    stepShape,
  }, reqBody);
  const taskFallback = simpleTask
    ? Math.min(Number(base.taskLevel || level), level)
    : contextOnlyPressure
      ? Number(base.taskLevel || level)
      : Math.max(Number(base.taskLevel || level), level);
  const contextFallback = simpleTask && level <= 2
    ? Math.min(Number(base.contextLevel || level), level)
    : Number(base.contextLevel || level);
  let taskLevel = clampInt(marker.taskLevel, 1, 5, taskFallback);
  let contextLevel = clampInt(marker.contextLevel, 1, 5, contextFallback);
  let thinkingLevel = marker.thinkingLevel != null
    ? clampInt(marker.thinkingLevel, 0, 5, level)
    : effortLevel(marker.effort || marker.thinkingEffort, effortForLevel(Math.min(5, level)));
  let speedTarget = clampInt(marker.speedTarget || marker.speed, 1, 5, level <= 2 ? 5 : 3);
  let effectiveLevel = simpleTask && level <= 2 ? level : Math.max(level, taskLevel, contextLevel);
  const target = TASK_KIND_TARGETS[taskKind] || TASK_KIND_TARGETS.general;
  const markerHasCostTarget = marker.costTarget != null && marker.implicitCostTarget !== true;
  const markerCostFallback = TEXT_EFFICIENT_TASKS.has(taskKind)
    ? Number(target.costTarget || 2)
    : (level <= 2 ? 2 : level);
  let markerCostTarget = clampInt(markerHasCostTarget ? marker.costTarget : undefined, 1, 5, markerCostFallback);
  let costTarget = simpleTask && level <= 2
    ? markerCostTarget
    : Math.max(markerCostTarget, effectiveLevel >= 4 ? Math.min(5, effectiveLevel) : markerCostTarget);
  if (!markerHasCostTarget && TEXT_EFFICIENT_TASKS.has(taskKind)) {
    costTarget = markerCostTarget;
  }
  if (textEfficientContextOnlyPressure) {
    const target = TASK_KIND_TARGETS[taskKind] || TASK_KIND_TARGETS.general;
    thinkingLevel = Math.min(thinkingLevel, target.thinkingLevel ?? 2, 2);
    speedTarget = Math.max(speedTarget, target.speedTarget || 5, 5);
    costTarget = Math.min(costTarget, target.costTarget || 2, 2);
  } else if (contextOnlyPressure) {
    thinkingLevel = Math.min(thinkingLevel, 3);
    speedTarget = Math.max(speedTarget, 4);
    costTarget = Math.min(costTarget, 3);
  }
  if (!markerHasSpecificSignal) {
    level = Math.min(level, baseLevel);
    taskLevel = Math.min(taskLevel, baseTaskLevel);
    contextLevel = Math.min(contextLevel, baseContextLevel);
    thinkingLevel = Math.min(thinkingLevel, baseThinkingLevel);
    speedTarget = Math.max(speedTarget, baseSpeedTarget);
    markerCostTarget = Math.min(markerCostTarget, baseCostTarget);
    costTarget = Math.min(costTarget, baseCostTarget);
    effectiveLevel = simpleTask && level <= 2 ? level : Math.max(level, taskLevel, contextLevel);
  }

  if (markerTaskRejected) {
    level = Math.min(level, Number(base.level || level));
    taskLevel = Number(base.taskLevel || taskLevel);
    contextLevel = Number(base.contextLevel || contextLevel);
    thinkingLevel = Math.min(thinkingLevel, Number(base.thinkingLevel ?? thinkingLevel));
    speedTarget = Math.max(speedTarget, Number(base.speedTarget || speedTarget));
    effectiveLevel = simpleTask && level <= 2 ? level : Math.max(level, taskLevel, contextLevel);
    markerCostTarget = Math.min(markerCostTarget, Number(base.costTarget || markerCostTarget));
    costTarget = Math.min(costTarget, markerCostTarget, Number(base.costTarget || costTarget));
  }

  return {
    ...base,
    ...marker,
    level: effectiveLevel,
    label: DIFFICULTY_LABELS[effectiveLevel],
    taskKind,
    taskLevel,
    contextLevel,
    thinkingEffort: (contextOnlyPressure || textEfficientContextOnlyPressure) ? effortForLevel(thinkingLevel) : marker.effort || marker.thinkingEffort || effortForLevel(thinkingLevel),
    thinkingLevel,
    speedTarget,
    costTarget,
    stepShape,
    source: "assessment",
  };
}

function splitAttachedUppercaseFromMarkerText(markerText = "") {
  const text = String(markerText || "");
  const trailing = text.match(/[\s:;,\-.]+$/)?.[0] || "";
  const core = trailing ? text.slice(0, -trailing.length) : text;
  const attached = core.match(/(\sreason=[a-z0-9_.:-]*?)([A-Z][^\s]*)$/);
  if (!attached) return { markerText: text, attachedText: "" };
  return {
    markerText: core.slice(0, -attached[2].length),
    attachedText: attached[2] + trailing,
  };
}

function stripStandaloneDifficultyArtifactLines(content, options = {}) {
  const raw = String(content || "");
  const parts = raw.split(/(\r?\n)/);
  let changed = false;
  let marker = null;
  let output = "";
  let afterDifficultyMarker = false;

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] || "";
    const newline = parts[i + 1] || "";
    if (!line && !newline) continue;

    const markerMatch = matchDifficultyMarkerText(line, options);
    if (markerMatch) {
      const markerText = markerMatch[0] || "";
      if (!marker) marker = parseDifficultyMarker(markerText, options);
      const split = splitAttachedUppercaseFromMarkerText(markerText);
      const visible = (split.attachedText + line.slice(markerText.length)).replace(/^[\s:;,\-.]+/, "").trimStart();
      if (visible) output += visible + newline;
      changed = true;
      afterDifficultyMarker = true;
      continue;
    }

    const jsonMarker = parseDifficultyMarkerJson(line);
    if (jsonMarker) {
      if (!marker) marker = jsonMarker;
      changed = true;
      afterDifficultyMarker = true;
      continue;
    }

    if (
      MALFORMED_DIFFICULTY_MARKER_LINE_RE.test(`${line}${newline}`) ||
      (includeLegacyBareMarkers(options) && BARE_DIFFICULTY_METADATA_LINE_RE.test(line)) ||
      (includeLegacyBareMarkers(options) && SPEED_ONLY_DIFFICULTY_METADATA_LINE_RE.test(line)) ||
      ORPHAN_DIFFICULTY_MARKER_TAIL_LINE_RE.test(line)
    ) {
      changed = true;
      afterDifficultyMarker = true;
      continue;
    }

    if (afterDifficultyMarker && (!line.trim() || isOrphanReasonContinuationLine(line))) {
      changed = true;
      continue;
    }

    if (line.trim()) afterDifficultyMarker = false;
    output += line + newline;
  }

  if (!changed) return { marker: null, content, changed: false };
  return { marker, content: output.trimEnd().replace(/^(?:[ \t]*\r?\n)+/, ""), changed: true };
}

function stripTrailingBareDifficultyArtifact(content, options = {}) {
  const raw = String(content || "");
  const match = (options.includeLegacyBare === true ? (raw.match(TRAILING_BARE_DIFFICULTY_METADATA_RE) ||
    raw.match(TRAILING_SPEED_ONLY_DIFFICULTY_METADATA_RE)) : null) ||
    raw.match(TRAILING_ORPHAN_DIFFICULTY_MARKER_TAIL_RE);
  if (!match) return { marker: null, content, changed: false };
  return {
    marker: null,
    content: raw.slice(0, match.index).trimEnd(),
    changed: true,
  };
}

function stripDifficultyMarkerFromText(content, options = {}) {
  const raw = String(content || "");
  const markerMatch = matchDifficultyMarkerText(raw, options);
  if (!markerMatch) {
    const jsonMarker = parseDifficultyMarkerJson(raw);
    if (jsonMarker) {
      return {
        marker: jsonMarker,
        content: "",
        changed: true,
      };
    }
    const malformedMarkerLine = raw.match(MALFORMED_DIFFICULTY_MARKER_LINE_RE);
    if (malformedMarkerLine) {
      return {
        marker: null,
        content: raw.slice(malformedMarkerLine[0].length).trimStart(),
        changed: true,
      };
    }
    const standalone = stripStandaloneDifficultyArtifactLines(raw, options);
    const trailing = stripTrailingBareDifficultyArtifact(standalone.content, options);
    if (standalone.changed || trailing.changed) {
      return { marker: standalone.marker || trailing.marker || null, content: trailing.content, changed: true };
    }
    return standalone;
  }
  const marker = parseDifficultyMarker(markerMatch[0], options);
  const markerText = markerMatch ? markerMatch[0] : "";
  const split = splitAttachedUppercaseFromMarkerText(markerText);
  const continuation = stripLeadingReasonContinuationLines(split.attachedText + raw.slice(markerText.length));
  const stripped = continuation.content.replace(/^[\s:;,\-.]+/, "").trimStart();
  const extra = stripStandaloneDifficultyArtifactLines(stripped, options);
  const trailing = stripTrailingBareDifficultyArtifact(extra.content, options);
  return { marker, content: trailing.content, changed: true };
}

function stripStandaloneTaskStatusArtifactLines(content) {
  const raw = String(content || "");
  const parts = raw.split(/(\r?\n)/);
  let changed = false;
  let marker = null;
  let output = "";

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] || "";
    const newline = parts[i + 1] || "";
    if (!line && !newline) continue;

    const markerMatch = matchTaskStatusMarkerText(line);
    if (markerMatch) {
      const markerText = markerMatch[0] || "";
      if (!marker) marker = parseTaskStatusMarker(markerText);
      const visible = line.slice(markerText.length).replace(/^[\s:;,\-.]+/, "").trimStart();
      if (visible) output += visible + newline;
      changed = true;
      continue;
    }

    if (MALFORMED_TASK_STATUS_MARKER_LINE_RE.test(`${line}${newline}`)) {
      changed = true;
      continue;
    }

    output += line + newline;
  }

  if (!changed) return { marker: null, content, changed: false };
  return { marker, content: output.trimEnd().replace(/^(?:[ \t]*\r?\n)+/, ""), changed: true };
}

function stripTaskStatusMarkerFromText(content) {
  const raw = String(content || "");
  const markerMatch = matchTaskStatusMarkerText(raw);
  if (!markerMatch) {
    const malformedMarkerLine = raw.match(MALFORMED_TASK_STATUS_MARKER_LINE_RE);
    if (malformedMarkerLine) {
      return {
        marker: null,
        content: raw.slice(malformedMarkerLine[0].length).trimStart(),
        changed: true,
      };
    }
    return stripStandaloneTaskStatusArtifactLines(raw);
  }
  const markerText = markerMatch[0] || "";
  const marker = parseTaskStatusMarker(markerText);
  const stripped = raw.slice(markerText.length).replace(/^[\s:;,\-.]+/, "").trimStart();
  const extra = stripStandaloneTaskStatusArtifactLines(stripped);
  return { marker: marker || extra.marker || null, content: extra.content, changed: true };
}

function stripTaskStatusMarkerFromResponseBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, marker: null, changed: false };
  }
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") {
    const stripped = stripTaskStatusMarkerFromText(content);
    if (!stripped.marker && !stripped.changed) return { body, marker: null, changed: false };
    choice.message.content = stripped.content;
    return { body: JSON.stringify(parsed), marker: stripped.marker, changed: true };
  }
  if (Array.isArray(content)) {
    const textPart = content.find((part) => part?.type === "text" && typeof part.text === "string");
    if (!textPart) return { body, marker: null, changed: false };
    const stripped = stripTaskStatusMarkerFromText(textPart.text);
    if (!stripped.marker && !stripped.changed) return { body, marker: null, changed: false };
    textPart.text = stripped.content;
    return { body: JSON.stringify(parsed), marker: stripped.marker, changed: true };
  }
  return { body, marker: null, changed: false };
}

function stripDifficultyMarkerFromResponseBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, marker: null, changed: false };
  }
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") {
    const stripped = stripDifficultyMarkerFromText(content);
    if (!stripped.marker && !stripped.changed) return { body, marker: null, changed: false };
    choice.message.content = stripped.content;
    return { body: JSON.stringify(parsed), marker: stripped.marker, changed: true };
  }
  if (Array.isArray(content)) {
    const textPart = content.find((part) => part?.type === "text" && typeof part.text === "string");
    if (!textPart) return { body, marker: null, changed: false };
    const stripped = stripDifficultyMarkerFromText(textPart.text);
    if (!stripped.marker && !stripped.changed) return { body, marker: null, changed: false };
    textPart.text = stripped.content;
    return { body: JSON.stringify(parsed), marker: stripped.marker, changed: true };
  }
  return { body, marker: null, changed: false };
}

function isBareDifficultyMetadataOnly(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  return BARE_DIFFICULTY_METADATA_LINE_RE.test(raw) ||
    SPEED_ONLY_DIFFICULTY_METADATA_LINE_RE.test(raw);
}

function shouldRerouteForMarker(provider, marker, reqBody = {}) {
  if (!marker || (reqBody._assessmentReroutes || 0) >= 2) return false;
  if ((reqBody.messages || []).length > 0) {
    const deterministic = assessRequestDifficulty(reqBody.messages || [], reqBody);
    const markerTaskKind = marker.taskKind || taskKindFromReason(marker.reason, deterministic.taskKind || "general");
    if (constrainMarkerTaskKind(markerTaskKind, deterministic) !== markerTaskKind) return false;
    const deterministicHighRisk = deterministic.level >= 4 ||
      deterministic.taskLevel >= 4 ||
      deterministic.contextLevel >= 4 ||
      deterministic.stepShape?.gate === "human_signoff" ||
      deterministic.stepShape?.gate === "dry_run_first";
    const markerLevel = Number(marker.level || marker.costTarget || 3);
    if (!deterministicHighRisk && markerLevel > Number(deterministic.level || 3) + 1) return false;
  }
  const profile = classifyProvider(provider);
  const costGap = Number(marker.costTarget || marker.level || 3) - profile.cost_group;
  const thinkingGap = Number(marker.thinkingLevel || effortLevel(marker.effort || marker.thinkingEffort, "medium")) - profile.thinking_level;
  if (marker.level >= 5 && (costGap >= 2 || thinkingGap >= 2)) return true;
  if (marker.level >= 4 && costGap >= 2 && thinkingGap >= 1) return true;
  if (thinkingGap >= 2) return true;
  if (costGap >= 3) return true;
  if (marker.level <= 2 && profile.cost_group >= 5) return true;
  if (marker.level <= 2 && profile.cost_group > Number(marker.costTarget || 2) + 1) return true;
  if (marker.level <= 2 && profile.thinking_level > Number(marker.thinkingLevel || 0) + 2) return true;
  return false;
}

module.exports = {
  EFFORT_LEVELS,
  ROUTING_POLICIES,
  TASK_KIND_TARGETS,
  STEP_SHAPE_PROFILES,
  getPolicyTargets,
  classifyProvider,
  providerMaxRoutingLevel,
  detectTaskKind,
  detectStepShape,
  assessRequestDifficulty,
  effectiveRequestProfile,
  providerPolicyBonus,
  costGroupFromCostMultiplier,
  costMultiplierForProvider,
  costMultiplierSourceKey,
  sourceLocalCostMultiplierBonus,
  applySourceLocalCostMultiplierScores,
  matchDifficultyMarkerText,
  matchTaskStatusMarkerText,
  maybeLegacyBareDifficultyMarkerFragment,
  maybeTaskStatusMarkerFragment,
  isOrphanReasonContinuationLine,
  parseDifficultyMarker,
  parseTaskStatusMarker,
  taskKindFromReason,
  profileFromTrustedTaskAssessment,
  profileFromAssessmentMarker,
  splitAttachedUppercaseFromMarkerText,
  stripDifficultyMarkerFromText,
  stripDifficultyMarkerFromResponseBody,
  stripTaskStatusMarkerFromText,
  stripTaskStatusMarkerFromResponseBody,
  isBareDifficultyMetadataOnly,
  shouldRerouteForMarker,
  isPassiveNoToolRequest,
  isHiddenProvider,
  isInternalPrivateProvider,
  isCodexAutoReviewProvider,
  providerHasToolCodingContract,
};
