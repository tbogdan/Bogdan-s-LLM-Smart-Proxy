const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  selectProxyRoles,
  buildAgentBrief,
  validateReviewEvidence,
} = require("../lib/orchestrator-bridge");
test("simple tasks avoid an agent fleet; critical review and exact constraints survive", () => {
  const small = selectProxyRoles({
    profile: { complexity: "SIMPLE" },
    capabilities: {},
    budget: { maxAgents: 3 },
  });
  assert.equal(small.roles.length, 1);
  const critical = selectProxyRoles({
    profile: { complexity: "CRITICAL", risk: "critical" },
    capabilities: {},
    budget: { maxAgents: 3 },
  });
  assert.ok(
    critical.roles.some(
      (r) => r.id === "code-reviewer" && r.permissions === "RO",
    ),
  );
  const brief = buildAgentBrief({
    task: "fix",
    constraints: ["EXACT hard constraint"],
    acceptance: ["tests"],
    assignment: { files: ["a.js"] },
    evidenceRefs: ["ref"],
  });
  assert.ok(brief.instructions.includes("EXACT hard constraint"));
  assert.equal(
    validateReviewEvidence({
      finding: { id: "x" },
      revision: "new",
      evidence: { revision: "old", verified: true },
    }).verdict,
    "uncertain",
  );
});

const {
  createFlow,
  advanceFlow,
  invalidateFlow,
  reserveAgent,
} = require("../lib/orchestration-state");
test("flow gates reject stale evidence and self review; revision edits invalidate gates", () => {
  for (const taskType of ["FEATURE", "BUG_FIX", "REVIEW"]) {
    let f = createFlow({ taskType, revision: "one", independentReview: true });
    assert.equal(advanceFlow(f, { revision: "old" }).phase, 0);
    for (const phase of f.phases) {
      const evidence = {
        source: "trusted_executor",
        revision: "one",
        artifactVerified: true,
        phase,
        verdict: "passed",
        implementerId: "writer",
        verifierId: "writer",
      };
      if (phase === "independent_review") {
        assert.equal(advanceFlow(f, evidence).phase, f.phase);
        evidence.verifierId = "reviewer";
      }
      f = advanceFlow(f, evidence);
    }
    assert.equal(f.phase, f.phases.length);
    assert.equal(invalidateFlow(f, "two").phase, 0);
  }
});
test("agent assignments reject overlapping writers and bounded unchanged review loops", () => {
  let r = reserveAgent(
    {},
    { role: "general", permissions: "RW", files: ["src"] },
  );
  assert.throws(
    () =>
      reserveAgent(r, {
        role: "worker",
        permissions: "RW",
        files: ["src/a.js"],
      }),
    /Overlapping/,
  );
  for (let i = 0; i < 6; i++)
    r = reserveAgent(r, { role: "reviewer", permissions: "RO" });
  assert.throws(() => reserveAgent(r, { role: "reviewer" }), /iteration/);
});
