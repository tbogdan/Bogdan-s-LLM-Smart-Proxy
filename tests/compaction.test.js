"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const compaction = require("../lib/compaction");
const state = require("../lib/state");

test("recordCompactionDrops and applyCompactionDrops replay dropped old messages per session", () => {
  const sessionId = "test-session-drop-cache";
  delete state.compactionDropCache[sessionId];

  const original = [
    { role: "system", content: "System stays" },
    { role: "user", content: "Please remember this old implementation detail about module alpha and beta." },
    { role: "assistant", content: "Old analysis that compaction decided to drop because it is superseded." },
    { role: "user", content: "Recent request should stay because it survived compaction." },
  ];
  const compacted = [
    original[0],
    { role: "assistant", content: "[CONTEXT COMPACTED]" },
    original[3],
  ];

  compaction.recordCompactionDrops(sessionId, original, compacted);
  const replayed = compaction.applyCompactionDrops(sessionId, [...original]);

  assert.deepEqual(replayed, [original[0], original[3]]);
});

test("detectGarbledText ignores compaction artifacts but catches repeated sentence loops", () => {
  const compacted = "[CONTEXT COMPACTED - 20 messages removed]\nTool output lines] Search: 40 results]";
  const loop = Array.from({ length: 8 }, () => "We need to continue with the implementation carefully.").join(" ");

  assert.equal(compaction.detectGarbledText(compacted), false);
  assert.equal(compaction.detectGarbledText(loop), true);
});

test("detectGarbledText accepts coherent markdown strategy reports with code paths", () => {
  const report = [
    "Full scan complete. Here's the strategy, ordered by impact/effort ratio:",
    "",
    "---",
    "",
    "## Improvement Strategy - chaos_engineering",
    "",
    "**Stack:** Python CLI `chaosctl` + Ansible + Docker Compose + pytest.",
    "",
    "### 1. Stabilize tests first",
    "- Clear problem: `tests/e2e/test_proxy.py`, `tests/api/test_cli_v2.py`, and `src/chaosctl/runtime.py` have contract drift.",
    "- Impact: reduces unnecessary reroutes and model cost.",
    "- Recommendation: fix fixtures and preserve compatibility with `--dry-run`.",
    "",
    "### 2. Improve proxy/runtime",
    "- Add validation to `lib/routing.js` and `lib/transforms.js`.",
    "- Log `cost_group`, `speed_group`, `thinking_effort`, and `providerPolicyBonus`.",
    "- Keep Windsurf available for strong models when tool calls are valid.",
    "",
    "### 3. Observability",
    "- Add raw request/response sampling without secrets.",
    "- Check `docker-compose.yml`, `.env.example`, and `README.md`.",
    "- Risk: token exposure if logs do not mask Authorization.",
    "",
    "### 4. Prioritization",
    "- P0: tests blocking deploy.",
    "- P1: Windsurf/Claude/Codex adapters.",
    "- P2: final score in logs.",
    "",
    "Conclusion: the recommended strategy is to fix transforms first, then cost routing, then discovery.",
  ].join("\n");

  assert.equal(compaction.detectGarbledText(report), false);
});

test("detectGarbledText accepts coherent terminal recovery workflow reports", () => {
  const report = [
    "## Recovery Workflow: Terminal-Agent Benchmark Mirror",
    "",
    "Five ordered steps. Each carries evidence, action, and stop condition.",
    "",
    "1. Evidence: `git status --short` shows the dirty generated file and whether unrelated changes are present.",
    "   Action: record the exact changed paths and separate generated output from hand edits.",
    "   Stop condition: no unknown file remains unexplained.",
    "2. Evidence: the benchmark process was interrupted before the final report.",
    "   Action: check for an active benchmark process and preserve partial JSON output for comparison.",
    "   Stop condition: either the process is gone or it is intentionally resumed.",
    "3. Evidence: tests were green before Docker rebuild.",
    "   Action: rerun the focused tests before touching implementation again.",
    "   Stop condition: failures are reproduced or the baseline is confirmed.",
    "4. Evidence: migration edits may overlap generated files.",
    "   Action: make the smallest patch after a fresh read and avoid stale line ranges.",
    "   Stop condition: patch applies cleanly and changed files match the intended set.",
    "5. Evidence: benchmark and regression signals both matter.",
    "   Action: run verification, report exact commands, and call out remaining risk.",
    "   Stop condition: the summary has evidence, action, and verification result.",
  ].join("\n");

  assert.equal(compaction.detectGarbledText(report), false);
});

test("detectGarbledText accepts valid architecture JSON reports", () => {
  const report = JSON.stringify({
    decision: "adaptive-routing",
    architecture: {
      layers: [
        { name: "ingress_normalizer", role: "normalize streaming chunks and tool call JSON" },
        { name: "provider_health_router", role: "score cooldown, fallback, and benchmark evidence" },
      ],
    },
    optimization: {
      direct_vs_proxy: "deduplicate long-context history and preserve route evidence",
      cost: "prefer cheaper models only when correctness risk is comparable",
    },
    risk: {
      provider_noise: "rate limits can hide routing regressions without explicit logs",
      stale_edit_recovery: "fresh reads are required before patching adjacent fields",
    },
  });

  assert.equal(compaction.detectGarbledText(report), false);
});

test("detectGarbledText accepts coherent patch sketches with fenced code", () => {
  const patch = [
    "Patch sketch:",
    "",
    "```js",
    "const crypto = require('crypto');",
    "",
    "function verify(signatureHeader, body, secret, now = Math.floor(Date.now() / 1000)) {",
    "  const parts = Object.fromEntries(signatureHeader.split(',').map((part) => part.split('=')));",
    "  const timestamp = Number(parts.t);",
    "  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300) return false;",
    "  if (!/^[0-9a-f]{64}$/i.test(parts.v1 || '')) return false;",
    "  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();",
    "  const supplied = Buffer.from(parts.v1, 'hex');",
    "  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);",
    "}",
    "```",
    "",
    "Regression tests:",
    "- rejects timestamps older than five minutes",
    "- rejects malformed hex before Buffer comparison",
    "- compares equal-length signatures with timingSafeEqual",
    "- accepts fixture v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa when the HMAC matches",
    "- rejects fixture v1=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb when the body changes",
  ].join("\n");

  assert.equal(compaction.detectGarbledText(patch), false);
});

test("detectGarbledText accepts coherent markdown test-first patch reports", () => {
  const report = [
    "**Tests that fail BEFORE the patch**",
    "",
    "1. Replay test - a valid signature replayed 10 minutes later is accepted because the timestamp is ignored.",
    "2. Malformed hex test - odd-length `v1` input reaches comparison without validation.",
    "3. Timing test - direct string equality leaks how much of the HMAC matched.",
    "",
    "## Patch sketch",
    "",
    "- Parse the header into `t` and `v1` fields and reject missing values.",
    "- Reject timestamps older than 300 seconds before comparing signatures.",
    "- Decode expected and supplied signatures to buffers and check equal length.",
    "- Use `crypto.timingSafeEqual` only after validation so malformed input is safe.",
    "",
    "## Regression coverage",
    "",
    "- Valid signature within the timestamp window succeeds.",
    "- Replayed signature outside the window fails.",
    "- Malformed signature hex fails without throwing.",
  ].join("\n");

  assert.equal(compaction.detectGarbledText(report), false);
});

test("detectGarbledText accepts coherent recovery workflow reports", () => {
  const report = [
    "## Recovery Workflow: Terminal-Agent Migration Resume",
    "",
    "---",
    "",
    "### Step 1 - Inspect State",
    "",
    "**Evidence:** The repository has a dirty generated file, a benchmark process was interrupted, and the previous run must not hide regressions.",
    "**Action:** Run `git status --short`, inspect the benchmark output file, and list any active Docker containers before changing code.",
    "**Stop condition:** Stop if there are unrelated user edits that overlap with the files needed for the migration.",
    "",
    "### Step 2 - Isolate Unrelated Changes",
    "",
    "**Evidence:** The dirty generated file is not part of the benchmark harness.",
    "**Action:** Leave unrelated changes in place and scope the next edit only to the failing benchmark/routing modules.",
    "**Stop condition:** Stop if the migration requires reverting user-owned work.",
    "",
    "### Step 3 - Resume Safely",
    "",
    "**Evidence:** The benchmark was interrupted after the direct Opus run timed out.",
    "**Action:** Re-run the smallest benchmark slice that reproduces the timeout and compare route logs before changing routing policy.",
    "**Stop condition:** Stop if the timeout is upstream transport rather than routing policy.",
    "",
    "### Step 4 - Verify Regression Safety",
    "",
    "**Evidence:** Unit tests cover routing profile, cost group, and completion review classification.",
    "**Action:** Run focused tests first, then the full suite, then a bounded benchmark run.",
    "**Stop condition:** Stop if any test fails or if the benchmark no longer reaches the final Opus case.",
    "",
    "### Step 5 - Report",
    "",
    "**Evidence:** The final report includes provider mix, latency, tokens, cost estimate, and correctness.",
    "**Action:** Summarize what changed, what remains risky, and which raw logs explain the route choices.",
    "**Stop condition:** Stop if benchmark correctness or route diversity regresses.",
  ].join("\n");

  assert.equal(compaction.detectGarbledText(report), false);
});

test("extractToolFacts tracks file activity and emits short previews for large reads", () => {
  const sessionId = "test-session-file-activity";
  delete state.fileActivity?.[sessionId];

  const content = [
    "Reading src/app.js",
    ...Array.from({ length: 80 }, (_, i) => `${i + 1}\tconst value${i} = ${i};`),
  ].join("\n");

  const result = compaction.extractToolFacts({ role: "tool", name: "Read", content }, sessionId);

  assert.match(result.content, /^\[READ .* src\/app\.js/);
  assert.match(result.content, /showing 100ch of \d+ch/);
  assert.equal(result.content.includes("value79"), false);
  assert.equal(state.fileActivity[sessionId]["src/app.js"].reads, 1);
});

test("extractToolFacts preserves markdown instruction file outputs", () => {
  const content = [
    "Reading AGENTS.md",
    "# Project Instructions",
    "Keep every rule in this file visible during compaction.",
    "x ".repeat(500),
  ].join("\n");

  const result = compaction.extractToolFacts({ role: "tool", name: "Read", content }, "test-session-md");

  assert.equal(result.content, content);
});

test("compactMessages summarizes dropped context by topic", () => {
  const messages = [
    { role: "system", content: "System stays." },
    { role: "user", content: "Implement routing and compaction improvements." },
  ];

  for (let i = 0; i < 10; i += 1) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `call_${i}`,
        type: "function",
        function: { name: "Read", arguments: JSON.stringify({ file_path: `src/topic${i % 2}.js` }) },
      }],
    });
    messages.push({
      role: "tool",
      name: "Read",
      tool_call_id: `call_${i}`,
      content: [
        `Reading src/topic${i % 2}.js`,
        ...Array.from({ length: 60 }, (_, line) => `${line + 1}\tfunction topic${i}_${line}() { return ${line}; }`),
      ].join("\n"),
    });
    messages.push({ role: "assistant", content: `Decision ${i}: keep topic ${i % 2} grouped because the route depends on it.` });
    messages.push({ role: "user", content: `Continue topic ${i}.` });
  }

  const compacted = compaction.compactMessages(messages, 1800, 200, [], "test-session-topic");
  assert.ok(compacted);
  const summary = compacted.messages.find((msg) => typeof msg.content === "string" && msg.content.includes("[CONTEXT COMPACTED"));

  assert.ok(summary);
  assert.match(summary.content, /Topics compacted:/);
  assert.match(summary.content, /topic[01]\.js/);
});

test("buildCompactSummary reads decisions from content parts", () => {
  const summary = compaction.buildCompactSummary([
    {
      role: "assistant",
      content: [
        { type: "text", text: "We chose the adapter approach because streaming compatibility matters." },
      ],
    },
  ], [], []);

  assert.match(summary, /We chose the adapter approach/);
});

test("compactMessagesAsync awaits self-call AI summary and embeds it in current compaction", async () => {
  const messages = [
    { role: "system", content: "System stays." },
    { role: "user", content: "Implement routing and compaction improvements." },
  ];

  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: "assistant", content: `Decision ${i}: route topic ${i % 2} because latency and tool correctness matter.` });
    messages.push({
      role: "tool",
      name: "Read",
      tool_call_id: `call_${i}`,
      content: [
        `Reading src/summary${i % 2}.js`,
        ...Array.from({ length: 60 }, (_, line) => `${line + 1}\tfunction summary${i}_${line}() { return ${line}; }`),
      ].join("\n"),
    });
    messages.push({ role: "user", content: `Continue summary topic ${i}.` });
  }

  let calls = 0;
  const previousRequester = compaction.configureAISummary({
    requester: async ({ condensed, sessionId }) => {
      calls += 1;
      assert.equal(sessionId, "test-session-ai-summary");
      assert.match(condensed, /Decision|summary/);
      return "AI kept the routing decisions, changed files, and tool evidence.";
    },
  });

  try {
    const compacted = await compaction.compactMessagesAsync(messages, 1500, 200, [], "test-session-ai-summary");
    assert.ok(compacted);
    assert.equal(calls, 1);

    const summary = compacted.messages.find((msg) => typeof msg.content === "string" && msg.content.includes("[CONTEXT COMPACTED"));
    assert.ok(summary);
    assert.match(summary.content, /AI Summary:/);
    assert.match(summary.content, /AI kept the routing decisions/);
    assert.equal(compacted.aiSummaryUsed, true);
  } finally {
    compaction.configureAISummary(previousRequester);
  }
});
