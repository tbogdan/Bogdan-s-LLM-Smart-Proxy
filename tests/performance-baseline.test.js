"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const performance = require("../lib/performance-benchmark");
const fixture = require("../scripts/performance-fixture");

test("nearestRank uses the documented nearest-rank convention", () => {
  assert.equal(performance.nearestRank([50, 10, 40, 20, 30], 0.5), 30);
  assert.equal(performance.nearestRank([1, 2, 3, 4], 0.95), 4);
  assert.equal(performance.nearestRank([], 0.99), null);
});

test("summarize separates successful latency from failed duration and excludes warmups", () => {
  const summary = performance.summarizePerformance([
    { warmup: true, category: "completed", durationMs: 999, bytesSent: 1, bytesReceived: 1 },
    { category: "completed", durationMs: 10, bytesSent: 10, bytesReceived: 20 },
    { category: "completed", durationMs: 30, bytesSent: 10, bytesReceived: 30 },
    { category: "error", durationMs: 100, bytesSent: 10, bytesReceived: 40 },
    { category: "timeout", durationMs: 200, bytesSent: 10, bytesReceived: 0 },
    { category: "aborted", durationMs: 300, bytesSent: 10, bytesReceived: 0 },
  ], { wallDurationMs: 1000, maxInflight: 3 });

  assert.deepEqual(summary.counts, {
    attempted: 5,
    completed: 2,
    error: 1,
    timeout: 1,
    aborted: 1,
    warmup: 1,
  });
  assert.deepEqual(summary.latency_ms, { p50: 10, p95: 30, p99: 30 });
  assert.deepEqual(summary.failed_duration_ms, { p50: 200, p95: 300, p99: 300 });
  assert.equal(summary.throughput_requests_per_second, 5);
  assert.equal(summary.max_inflight, 3);
  assert.deepEqual(summary.bytes, { sent: 50, received: 90 });
});

test("runBounded never exceeds configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const results = await performance.runBounded(17, 4, async (index) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, index % 2));
    active--;
    return index;
  });
  assert.equal(peak, 4);
  assert.deepEqual(results, Array.from({ length: 17 }, (_, index) => index));
});

test("SSE validation requires exactly one terminal DONE event", () => {
  assert.equal(performance.validateTerminalSse("data: {\"choices\":[]}\n\ndata: [DONE]\n\n").ok, true);
  assert.equal(performance.validateTerminalSse("data: {\"choices\":[]}\n\n").ok, false);
  assert.equal(performance.validateTerminalSse("data: [DONE]\n\ndata: [DONE]\n\n").ok, false);
});

test("failure records redact URLs, query strings, credentials, payloads and task identifiers", () => {
  const failure = performance.redactFailure(new Error("Bearer secret-token at https://host.test/path?q=private"), {
    url: "https://host.test/path?q=private",
    payload: { secret: "value" },
    taskId: "task-private",
  });
  const encoded = JSON.stringify(failure);
  assert.doesNotMatch(encoded, /secret-token|host\.test|private|payload|taskId|value/);
  assert.match(encoded, /redacted/i);
});

test("performance defaults apply only to explicit performance suites", () => {
  const env = {
    BENCH_REPEAT: "bad",
    BENCH_WARMUP: "-1",
    BENCH_CONCURRENCY: "Infinity",
    BENCH_TIMEOUT_MS: "0",
  };
  assert.deepEqual(performance.performanceConfig({ suite: "latency" }, env), {
    repeat: 50,
    warmup: 5,
    concurrency: 8,
    timeoutMs: 10000,
  });
  assert.equal(performance.performanceConfig({ suite: "ladder" }, env), null);
});

test("direct fixture configuration shares bounded performance limits", () => {
  assert.deepEqual(fixture.fixtureConfig({
    repeat: "9999999",
    warmup: "9999999",
    concurrency: "9999999",
    "timeout-ms": "9999999",
  }, {}), {
    repeat: 1000,
    warmup: 100,
    concurrency: 64,
    timeoutMs: 120000,
  });
});

test("large-body serializes to exactly one MiB", () => {
  assert.equal(performance.requestBodyForSuite("large-body").byteLength, 1024 * 1024);
  assert.doesNotThrow(() => JSON.parse(performance.requestBodyForSuite("large-body").toString("utf8")));
});

test("request path distinguishes external abort from its timeout", async (t) => {
  const server = http.createServer((_req, _res) => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const external = new AbortController();
  setTimeout(() => external.abort(), 10);
  const aborted = await performance.requestOnce({ baseUrl, suite: "latency", timeoutMs: 1000, signal: external.signal });
  assert.equal(aborted.category, "aborted");

  const timedOut = await performance.requestOnce({ baseUrl, suite: "latency", timeoutMs: 10 });
  assert.equal(timedOut.category, "timeout");
});

test("performance suite report counts external aborts separately from timeouts", async (t) => {
  const server = http.createServer((_req, _res) => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const external = new AbortController();
  setTimeout(() => external.abort(), 10);
  const aborted = await performance.runPerformanceSuite({
    baseUrl, suite: "latency", repeat: 2, warmup: 0, concurrency: 2, timeoutMs: 1000, signal: external.signal,
  });
  assert.equal(aborted.counts.aborted, 2);
  assert.equal(aborted.counts.timeout, 0);

  const timedOut = await performance.runPerformanceSuite({
    baseUrl, suite: "latency", repeat: 1, warmup: 0, concurrency: 1, timeoutMs: 10,
  });
  assert.equal(timedOut.counts.aborted, 0);
  assert.equal(timedOut.counts.timeout, 1);
});

test("local fixture benchmarks the real proxy child and a terminal SSE response", async (t) => {
  const result = await fixture.runLocalFixture({
    suite: "streaming",
    repeat: 2,
    warmup: 1,
    concurrency: 2,
    timeoutMs: 5000,
  });
  t.after(() => result.cleanup());

  assert.equal(result.report.fixture.mode, "local-synthetic-upstream");
  assert.equal(result.report.fixture.proxy_entrypoint, "llm-proxy.js");
  assert.equal(result.report.counts.completed, 2);
  assert.equal(result.report.counts.error, 0);
  assert.equal(result.report.request_counts.total, 3);
  assert.equal(result.report.samples.every((sample) => sample.sse?.ok), true);
  assert.ok(result.report.memory.proxy_server?.rss_sample_bytes > 0);
  assert.ok(result.report.memory.benchmark_driver?.rss_observed_max_bytes > 0);
  assert.doesNotMatch(JSON.stringify(result.report), /authorization|api[_-]?key|fixture-secret/i);
});

test("benchmark CLI requires explicit fixture or live opt-in for performance suites", () => {
  const cli = require("../scripts/benchmark");
  assert.equal(cli.performanceExecutionMode({ suite: "latency", fixture: true }), "fixture");
  assert.equal(cli.performanceExecutionMode({ suite: "throughput", "live-provider": true }), "live");
  assert.throws(() => cli.performanceExecutionMode({ suite: "large-body" }), /--fixture.*--live-provider/);
  assert.equal(cli.performanceExecutionMode({ suite: "ladder" }), null);
});
