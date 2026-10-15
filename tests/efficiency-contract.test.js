const test = require("node:test"),
  assert = require("node:assert/strict");
const { offlineReport } = require("../scripts/benchmark-efficiency");
test("offline savings retain a diagnostic outlier and never claim measured dollars or LLM quality", () => {
  const r = offlineReport();
  assert.equal(
    r.qualityEvidence,
    "offline content invariants; model completion quality unverified",
  );
  assert.equal(r.costSavedUsd, null);
  assert.ok(
    r.arms.optimized.estimatedInputTokens <
      r.arms.passthrough.estimatedInputTokens,
  );
  assert.equal(r.arms.optimized.requiredFactRetained, true);
  assert.equal(r.arms.optimized.originalRecoverable, true);
  assert.equal(r.arms.legacyPreviewSimulation.requiredFactRetained, false);
});

test("offline matrix covers small code, exact edits, structured data and signed output", () => {
  const r = offlineReport();
  assert.deepEqual(
    r.fixtures.map((f) => f.id),
    [
      "small-code",
      "exact-diff",
      "structured-json",
      "signed-output",
      "long-tool-loop",
    ],
  );
  assert.ok(
    r.fixtures.every((f) => f.requiredFactRetained && f.originalRecoverable),
  );
  assert.ok(
    r.fixtures
      .filter((f) =>
        ["small-code", "exact-diff", "signed-output"].includes(f.id),
      )
      .every((f) => f.beforeBytes === f.afterBytes),
  );
});
