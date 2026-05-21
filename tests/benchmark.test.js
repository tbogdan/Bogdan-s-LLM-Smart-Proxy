"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const benchmark = require("../lib/benchmark");
const routingPolicy = require("../lib/routing-policy");

test("gradeOutput supports exact, regex, contains, and json graders", () => {
  assert.deepEqual(benchmark.gradeOutput({ expect: { type: "exact", value: "OK" } }, " OK "), {
    passed: true,
    score: 1,
    detail: "exact",
  });
  assert.equal(benchmark.gradeOutput({ expect: { type: "regex", value: "\\bready\\b" } }, "system ready").passed, true);
  assert.equal(benchmark.gradeOutput({ expect: { type: "contains", value: "answer" } }, "The answer is 42.").passed, true);
  assert.equal(benchmark.gradeOutput({ expect: { type: "json", path: "answer", value: 144 } }, "{\"answer\":144}").passed, true);
  assert.equal(benchmark.gradeOutput({
    expect: {
      type: "all",
      checks: [
        { type: "contains", value: "SQL injection" },
        { type: "regex", value: "parameteri[sz]ed" },
      ],
    },
  }, "Fix SQL injection with parameterized queries.").passed, true);
  assert.equal(benchmark.gradeOutput({
    expect: {
      type: "json_schema",
      schema: {
        type: "object",
        required: ["decision", "rollback"],
        properties: {
          decision: { type: "string", enum: ["approve", "reject"] },
          rollback: { type: "boolean" },
        },
      },
    },
  }, "{\"decision\":\"approve\",\"rollback\":true}").passed, true);
  assert.equal(benchmark.gradeOutput({
    expect: {
      type: "json_schema",
      schema: {
        type: "object",
        required: ["decision", "rollback"],
        properties: { rollback: { type: "boolean" } },
      },
    },
  }, "{\"decision\":\"approve\",\"rollback\":\"yes\"}").passed, false);
});

test("estimateCostUsd uses model family pricing and free SWE pricing", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 100 };

  assert.equal(benchmark.estimateCostUsd("windsurf/swe-1.6-fast", usage).usd, 0);
  assert.equal(benchmark.estimateCostUsd("claude/claude-sonnet-4-5", usage).cost_group, 3);
  assert.equal(benchmark.estimateCostUsd("codex/gpt-5.4-mini", usage).cost_group, 2);
});

test("estimateCostUsd discounts cached input tokens", () => {
  const estimate = benchmark.estimateCostUsd(
    "custom/cache-test",
    {
      prompt_tokens: 1000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 400 },
    },
    {
      priceTable: [{ pattern: /cache-test/, input: 1, output: 10, cost_group: 1, source: "test" }],
      cachedInputPriceRatio: 0.1,
    },
  );

  assert.equal(estimate.usd, 0.00064);
  assert.equal(estimate.fresh_input_tokens, 600);
  assert.equal(estimate.cached_input_tokens, 400);
});

test("usageFromResponse never reports total below prompt plus completion", () => {
  const usage = benchmark.usageFromResponse(
    { usage: { prompt_tokens: 83, completion_tokens: 549, total_tokens: 83 } },
    {},
    "",
  );

  assert.equal(usage.total_tokens, 632);
});

test("usageFromResponse preserves cached input token telemetry from usage and headers", () => {
  const fromUsage = benchmark.usageFromResponse({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 42 },
    },
  });
  const fromHeaders = benchmark.usageFromResponse({}, { "x-llm-prompt-tokens": "50", "x-llm-completion-tokens": "5", "x-llm-cached-input-tokens": "12" }, "hello");

  assert.equal(fromUsage.cached_input_tokens, 42);
  assert.equal(fromHeaders.cached_input_tokens, 12);
});

test("summarizeRuns aggregates direct and proxy metrics", () => {
  const runs = [
    { arm: "direct", ok: true, latency_ms: 1000, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_input_tokens: 10 }, estimated_cost_usd: 0.01, provider: "DirectA", actual_model: "model-a", complexity: 1 },
    { arm: "direct", ok: false, latency_ms: 1400, usage: { prompt_tokens: 110, completion_tokens: 25, total_tokens: 135 }, estimated_cost_usd: 0.02, provider: "DirectA", actual_model: "model-a", complexity: 3 },
    { arm: "proxy", ok: true, latency_ms: 800, usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 }, estimated_cost_usd: 0.004, provider: "ProxyA", actual_model: "model-b", complexity: 1 },
    { arm: "proxy", ok: true, latency_ms: 900, usage: { prompt_tokens: 95, completion_tokens: 30, total_tokens: 125, cached_input_tokens: 20 }, estimated_cost_usd: 0.005, provider: "ProxyB", actual_model: "model-c", complexity: 3 },
  ];

  const summary = benchmark.summarizeRuns(runs);

  assert.equal(summary.direct.correctness_pct, 50);
  assert.equal(summary.proxy.correctness_pct, 100);
  assert.equal(summary.proxy.avg_latency_ms, 850);
  assert.equal(summary.direct.avg_cached_input_tokens, 5);
  assert.equal(summary.proxy.avg_cached_input_tokens, 10);
  assert.deepEqual(summary.proxy.providers, { ProxyA: 1, ProxyB: 1 });
});

test("renderReport includes ASCII charts and provider/model detail", () => {
  const summary = benchmark.summarizeRuns([
    { arm: "direct", case_id: "exact", ok: true, latency_ms: 1000, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, estimated_cost_usd: 0, provider: "Windsurf-SWE16Fast", actual_model: "windsurf/swe-1.6-fast", complexity: 1 },
    { arm: "proxy", case_id: "exact", ok: true, latency_ms: 700, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, estimated_cost_usd: 0.001, provider: "Codex-GPT54Mini", actual_model: "codex/gpt-5.4-mini", complexity: 1 },
  ]);
  const report = benchmark.renderReport(summary, {
    directModel: "windsurf/swe-1.6-fast",
    proxyModel: "auto-coding",
    budgetUsd: 0.05,
  });

  assert.match(report, /A\/B benchmark/);
  assert.match(report, /ASCII charts/);
  assert.match(report, /Windsurf-SWE16Fast/);
  assert.match(report, /Codex-GPT54Mini/);
  assert.match(report, /Proxy savings/);
  assert.match(report, /Cost per correct/);
  assert.match(report, /Proxy model diversity/);
  assert.match(report, /cached/);
});

test("default benchmark cases form a cheap-to-expensive routing ladder", () => {
  assert.equal(benchmark.DEFAULT_CASES.length, 9);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.complexity === 1), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.complexity === 5), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.expect.type === "all"), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => /security|review|incident|architecture/i.test(`${testCase.id} ${testCase.title}`)), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.category === "code-reasoning"), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.category === "agent-planning"), true);
  assert.equal(benchmark.DEFAULT_CASES.every((testCase) => testCase.route_goal), true);
  assert.equal(benchmark.DEFAULT_CASES.every((testCase) => testCase.route_shape), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.route_shape === "read_heavy"), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.route_shape === "write_heavy"), true);
  assert.equal(benchmark.DEFAULT_CASES.some((testCase) => testCase.route_shape === "security"), true);
  assert.deepEqual([...new Set(benchmark.DEFAULT_CASES.map((testCase) => testCase.proxy_model))].sort(), [
    "auto-coding",
    "auto-max",
    "auto-text",
    "auto-thinking",
    "coding-sm",
  ]);
});

test("default benchmark route shapes match routing policy classification", () => {
  for (const testCase of benchmark.DEFAULT_CASES) {
    const assessment = routingPolicy.assessRequestDifficulty(testCase.messages, {
      model: testCase.proxy_model,
      max_tokens: testCase.max_tokens,
    });
    assert.equal(
      assessment.stepShape.shape,
      testCase.route_shape,
      `${testCase.id}: expected ${testCase.route_shape}, got ${assessment.stepShape.shape} (${assessment.taskKind})`,
    );
  }
});

test("opus benchmark cases compare direct Opus with optimized mixed proxy routing", () => {
  assert.equal(benchmark.OPUS_CASES.length >= 3, true);
  assert.equal(benchmark.OPUS_CASES.every((testCase) => ["auto", "auto-max", "auto-coding"].includes(testCase.proxy_model)), true);
  assert.equal(benchmark.OPUS_CASES.some((testCase) => /edit failed|stale read|one million/i.test(JSON.stringify(testCase.messages))), true);
  assert.equal(benchmark.OPUS_CASES.at(-1).proxy_model, "auto");
  assert.match(benchmark.OPUS_CASES.at(-1).route_goal, /frontier long-context/i);
  assert.equal(benchmark.OPUS_CASES.filter((testCase) => /opus|claude-opus/i.test(testCase.expect_proxy_model || "")).length, 1);
  assert.equal(benchmark.OPUS_CASES.filter((testCase) => /opus|claude-opus/i.test(testCase.avoid_proxy_model || "")).length >= 2, true);
  assert.equal(benchmark.OPUS_CASES.every((testCase) => testCase.expect.type === "all"), true);
});

test("opus benchmark prompts do not instruct the model to choose Opus", () => {
  const sentPromptText = benchmark.OPUS_CASES
    .flatMap((testCase) => testCase.messages)
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");

  assert.doesNotMatch(sentPromptText, /route (?:to|through).*opus/i);
  assert.doesNotMatch(sentPromptText, /do not downgrade/i);
  assert.doesNotMatch(sentPromptText, /why_opus/i);
  assert.doesNotMatch(sentPromptText, /cheaper model is not enough/i);
  assert.doesNotMatch(sentPromptText, /proxy should route/i);
});

test("benchmark dry run recommends a runtime-bounded run without a default cost cap", () => {
  const script = path.join(__dirname, "..", "scripts", "benchmark.js");
  const output = execFileSync(process.execPath, [script, "--max-cases=6"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });

  assert.match(output, /Runtime guard:/);
  assert.match(output, /Cost guard:\s+disabled/);
  assert.match(output, /Requests:\s+12/);
  assert.match(output, /via coding-sm/);
  assert.match(output, /shape=write_heavy/);
  assert.match(output, /secure-token-patch/);
  assert.match(output, /npm run benchmark -- --run --max-cases=6/);
  assert.doesNotMatch(output, /--budget-usd/);
});

test("extractContent reads OpenAI SSE streamed content", () => {
  const stream = [
    'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"delta":{"content":"Opus "},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"delta":{"content":"streamed"},"finish_reason":null}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  assert.equal(benchmark.extractContent({}, stream), "Opus streamed");
});

test("opus benchmark dry run defaults direct and proxy arms to Opus-capable comparison", () => {
  const script = path.join(__dirname, "..", "scripts", "benchmark.js");
  const output = execFileSync(process.execPath, [script, "--suite=opus"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });

  assert.match(output, /Suite:\s+opus/);
  assert.match(output, /Direct model:\s+windsurf\/claude-opus-4-6-1m/);
  assert.match(output, /Proxy flow:\s+auto-coding, auto-max, auto/);
  assert.match(output, /frontier long-context/);
  assert.match(output, /npm run benchmark -- --run --suite=opus/);
});

test("all benchmark dry run merges ladder and Opus suites", () => {
  assert.equal(benchmark.ALL_CASES.length, 8);
  assert.equal(benchmark.ALL_CASES.at(-1).id, "opus-auto-escalation");
  assert.equal(benchmark.ALL_CASES.at(-1).max_tokens <= 280, true);
  assert.equal(benchmark.ALL_CASES.every((testCase) => testCase.route_shape), true);

  const script = path.join(__dirname, "..", "scripts", "benchmark.js");
  const output = execFileSync(process.execPath, [script, "--suite=all"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });

  assert.match(output, /Suite:\s+all/);
  assert.match(output, /exact-reply/);
  assert.match(output, /terminal-agent-plan/);
  assert.match(output, /opus-auto-escalation/);
  assert.match(output, /Cases:\s+8/);
  assert.match(output, /Proxy flow:\s+auto-coding, auto-text, coding-sm, auto-thinking, auto-max, auto/);
  assert.match(output, /npm run benchmark -- --run --suite=all/);
});
