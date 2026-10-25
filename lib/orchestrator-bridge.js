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
  const level = Number(profile.taskLevel || 3);
  const intent = String(profile.taskKind || profile.task_type || "").toLowerCase();
  const complexKind = /debug|bug_fix|review|edit_recovery|architecture|refactor|auth|security/.test(intent)
    ? "difficult_debug_review" : /planning|plan/.test(intent) ? "planning" : "complex_implementation";
  const kind = profile.kind || (level <= 2 ? "mechanical" : level === 3 ? "standard_implementation" : level === 4 ? complexKind : "frontier");
  // Registry lookup uses the first ID match. Merge visibility here, then retain
  // exact route effort bindings so a different endpoint cannot borrow a dial.
  const entries = inventory?.models || [];
  const models = new Map();
  for (const entry of entries) {
    if (!["exposed", "verified"].includes(entry.availability)) continue;
    const previous = models.get(entry.id);
    models.set(entry.id, {...entry, efforts: [...new Set([...(previous?.efforts || []), ...(entry.efforts || [])])]});
  }
  const classification = core.classify({
    kind,
    task_type: profile.task_type || "FEATURE",
    complexity: profile.complexity || "MODERATE",
    ...(profile.risk ? { risk: profile.risk } : {}),
    ...(role ? { role } : {}),
  });
  const ranked = core
    .rankModels({ pair: classification.pair, inventory: inventory ? {...inventory, models: [...models.values()]} : undefined })
    .filter((row) => !row.excluded_reason)
    .map(row => ({...row, route_ids: entries.filter(entry => entry.id === row.api_id && ["exposed","verified"].includes(entry.availability) &&
      (row.thinking_control === "budget_tokens" || (entry.efforts || []).includes(row.effort))).map(entry => entry.route_id).filter(Boolean)}));
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
