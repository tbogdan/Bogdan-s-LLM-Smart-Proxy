"use strict";
let corePromise;
function loadOrchestrator() {
  return (corePromise ||= import("../vendor/llm-orchestrator/lib/router.mjs"));
}
async function rankTaskCandidates({
  profile = {},
  inventory,
  role,
  taskAllocation,
} = {}) {
  const core = await loadOrchestrator();
  const classification = core.classify({
    task_type: profile.task_type || "FEATURE",
    complexity: profile.complexity || "MODERATE",
    ...(profile.risk ? { risk: profile.risk } : {}),
    ...(role ? { role } : {}),
  });
  const ranked = core
    .rankModels({ pair: classification.pair, inventory })
    .filter((row) => !row.excluded_reason);
  const allowed = taskAllocation?.models;
  return {
    ranked: allowed
      ? ranked.filter((r) =>
          allowed.some((id) => id === r.api_id || id.endsWith("/" + r.api_id)),
        )
      : ranked,
    classification,
    exclusions: [],
    inventoryRevision: inventory?.revision || null,
  };
}
async function buildProxyFlow({
  taskType = "FEATURE",
  complexity = "MODERATE",
} = {}) {
  const core = await loadOrchestrator();
  return core.estimateFlow(taskType, complexity);
}

function selectProxyRoles({
  profile = {},
  capabilities = {},
  budget = {},
} = {}) {
  const registry = require("../vendor/llm-orchestrator/registries/agent-roles.json");
  const known = new Set(registry.roles.map((r) => r.id));
  const primary = /INVESTIGATION|RESEARCH/.test(profile.task_type || "")
    ? "explore"
    : "general";
  const roles = [
    {
      id: known.has(primary) ? primary : "general",
      permissions: "RW",
      objective: "Complete assigned task and record evidence",
    },
  ];
  const review =
    profile.risk === "critical" ||
    profile.complexity === "CRITICAL" ||
    profile.independent_review === true;
  if (review)
    roles.push({
      id: "code-reviewer",
      permissions: "RO",
      objective: "Independently verify the result at its risk floor",
    });
  if (budget.maxAgents !== undefined && roles.length > budget.maxAgents)
    throw Object.assign(new Error("Required review exceeds agent budget"), {
      code: "REVIEW_BUDGET_REQUIRED",
    });
  return {
    roles,
    reviewFloor: review ? "required" : "task-dependent",
    omitted: registry.roles
      .filter((r) => !roles.some((x) => x.id === r.id))
      .map((r) => r.id),
    estimatedOverhead: "unknown until measured",
    capabilities,
  };
}
function buildAgentBrief({
  task,
  constraints = [],
  acceptance = [],
  assignment = {},
  evidenceRefs = [],
} = {}) {
  return {
    instructions: [
      String(task || ""),
      ...constraints.map(String),
      "Acceptance:",
      ...acceptance.map(String),
    ].join("\n"),
    context: { assignment, evidenceRefs },
    limits: {
      maxIterations: assignment.maxIterations || 6,
      maxOutputTokens: assignment.maxOutputTokens || 4096,
      permissions: assignment.permissions || "RO",
    },
  };
}
function validateReviewEvidence({ finding, revision, evidence } = {}) {
  if (
    !evidence ||
    evidence.revision !== revision ||
    evidence.source !== "trusted_executor" ||
    !evidence.artifactVerified ||
    evidence.verifierId === finding?.finderId
  )
    return {
      verdict: "uncertain",
      confidence: "low",
      reason: "Independent current-revision executor evidence required",
    };
  return {
    verdict:
      evidence.verdict === "confirmed"
        ? "confirmed"
        : evidence.verdict === "refuted"
          ? "refuted"
          : "uncertain",
    confidence: evidence.confidence || "medium",
    reason: evidence.reason || "Recorded independent verification",
  };
}
module.exports = {
  loadOrchestrator,
  rankTaskCandidates,
  buildProxyFlow,
  selectProxyRoles,
  buildAgentBrief,
  validateReviewEvidence,
};
