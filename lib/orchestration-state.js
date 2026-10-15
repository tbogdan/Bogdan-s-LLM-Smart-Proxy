"use strict";

const policy = require("../config/proxy-orchestration.json");

function createFlow({
  taskType = "FEATURE",
  revision,
  independentReview = false,
} = {}) {
  if (!revision) throw new Error("Source revision required");
  const phases = [...(policy.flows[taskType] || policy.flows.FEATURE)];
  if (independentReview) phases.push("independent_review");
  return { taskType, revision, phases, phase: 0, evidence: [], iterations: 0 };
}

function advanceFlow(flow, evidence) {
  if (flow.phase >= flow.phases.length) return flow;
  if (flow.iterations >= policy.maxIterationsPerRole)
    throw new Error("Flow iteration limit reached");
  const attempt = { ...flow, iterations: flow.iterations + 1 };
  const current = flow.phases[flow.phase];
  const trusted =
    evidence?.source === "trusted_executor" &&
    evidence.revision === flow.revision &&
    evidence.artifactVerified === true;
  const independent =
    current !== "independent_review" ||
    (evidence?.verifierId && evidence.verifierId !== evidence.implementerId);
  if (
    !trusted ||
    !independent ||
    evidence.phase !== current ||
    evidence.verdict !== "passed"
  )
    return { ...attempt, blocked: "Current phase requires verified evidence" };
  return {
    ...attempt,
    phase: flow.phase + 1,
    blocked: null,
    evidence: [...flow.evidence, evidence],
  };
}

function invalidateFlow(flow, revision) {
  return createFlow({
    taskType: flow.taskType,
    revision,
    independentReview: flow.phases.includes("independent_review"),
  });
}

function reserveAgent(record, { role, files = [], permissions = "RO" }) {
  const agents = record.agents || {};
  const previous = agents[role];
  if (!previous && Object.keys(agents).length >= policy.maxAgents)
    throw Object.assign(new Error("Task agent budget exhausted"), {
      code: "TASK_AGENT_BUDGET",
    });
  if ((previous?.iterations || 0) >= policy.maxIterationsPerRole)
    throw Object.assign(new Error("Role iteration budget exhausted"), {
      code: "TASK_AGENT_ITERATIONS",
    });
  if (permissions === "RW") {
    const overlaps = (left, right) =>
      left === right ||
      left.startsWith(right + "/") ||
      right.startsWith(left + "/");
    for (const [other, entry] of Object.entries(agents)) {
      if (
        other !== role &&
        entry.permissions === "RW" &&
        entry.files.some((a) => files.some((b) => overlaps(a, b)))
      )
        throw new Error("Overlapping writer assignment");
    }
  }
  const agent = {
    role,
    permissions,
    files,
    iterations: (previous?.iterations || 0) + 1,
  };
  return { ...record, agents: { ...agents, [role]: agent } };
}

module.exports = { createFlow, advanceFlow, invalidateFlow, reserveAgent };
