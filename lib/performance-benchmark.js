"use strict";

const PERFORMANCE_SUITES = new Set(["latency", "throughput", "large-body", "streaming"]);
const DEFAULTS = Object.freeze({ repeat: 50, warmup: 5, concurrency: 8, timeoutMs: 10000 });

function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, percentile)) * sorted.length));
  return sorted[rank - 1];
}

function percentiles(values) {
  return {
    p50: nearestRank(values, 0.50),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
  };
}

function summarizePerformance(samples, { wallDurationMs, maxInflight }) {
  const measured = samples.filter((sample) => !sample.warmup);
  const counts = { attempted: measured.length, completed: 0, error: 0, timeout: 0, aborted: 0, warmup: samples.length - measured.length };
  for (const sample of measured) {
    if (Object.prototype.hasOwnProperty.call(counts, sample.category)) counts[sample.category]++;
    else counts.error++;
  }
  const successful = measured.filter((sample) => sample.category === "completed").map((sample) => sample.durationMs);
  const failed = measured.filter((sample) => sample.category !== "completed").map((sample) => sample.durationMs);
  const durationSeconds = Math.max(0, Number(wallDurationMs)) / 1000;
  return {
    counts,
    latency_ms: percentiles(successful),
    failed_duration_ms: percentiles(failed),
    throughput_requests_per_second: durationSeconds > 0 ? measured.length / durationSeconds : null,
    successful_requests_per_second: durationSeconds > 0 ? counts.completed / durationSeconds : null,
    wall_duration_ms: Math.max(0, Number(wallDurationMs)) || 0,
    max_inflight: Math.max(0, Number(maxInflight)) || 0,
    bytes: {
      sent: measured.reduce((sum, sample) => sum + (Number(sample.bytesSent) || 0), 0),
      received: measured.reduce((sum, sample) => sum + (Number(sample.bytesReceived) || 0), 0),
    },
  };
}

async function runBounded(count, concurrency, worker) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const width = Math.max(1, Math.min(total || 1, Math.floor(Number(concurrency) || 1)));
  const results = new Array(total);
  let next = 0;
  async function lane() {
    while (next < total) {
      const index = next++;
      results[index] = await worker(index);
    }
  }
  await Promise.all(Array.from({ length: width }, lane));
  return results;
}

function validateTerminalSse(text) {
  const events = String(text || "").split(/\r?\n\r?\n/).filter(Boolean);
  const terminalIndexes = [];
  for (let index = 0; index < events.length; index++) {
    if (events[index].split(/\r?\n/).some((line) => line.trim() === "data: [DONE]")) terminalIndexes.push(index);
  }
  const ok = terminalIndexes.length === 1 && terminalIndexes[0] === events.length - 1;
  return { ok, terminalEvents: terminalIndexes.length, eventCount: events.length };
}

function redactFailure(error) {
  const name = String(error?.name || "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "Error";
  return { name, message: "[redacted]" };
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min) return fallback;
  return Math.min(max, number);
}

function performanceConfig(args = {}, env = process.env) {
  const suite = String(args.suite || env.BENCH_SUITE || "").trim().toLowerCase();
  if (!PERFORMANCE_SUITES.has(suite)) return null;
  return {
    repeat: boundedInteger(args.repeat ?? env.BENCH_REPEAT, DEFAULTS.repeat, 1, 1000),
    warmup: boundedInteger(args.warmup ?? env.BENCH_WARMUP, DEFAULTS.warmup, 0, 100),
    concurrency: boundedInteger(args.concurrency ?? env.BENCH_CONCURRENCY, DEFAULTS.concurrency, 1, 64),
    timeoutMs: boundedInteger(args["timeout-ms"] ?? env.BENCH_TIMEOUT_MS, DEFAULTS.timeoutMs, 1, 120000),
  };
}

function payloadForSuite(suite) {
  return {
    model: "codex/performance-fixture",
    messages: [{ role: "user", content: suite === "large-body" ? "" : "fixture-request" }],
    temperature: 0,
    max_tokens: 32,
    stream: suite === "streaming",
  };
}

function requestBodyForSuite(suite) {
  const payload = payloadForSuite(suite);
  if (suite !== "large-body") return Buffer.from(JSON.stringify(payload));
  const emptyBodyBytes = Buffer.byteLength(JSON.stringify(payload));
  const targetBytes = 1024 * 1024;
  if (emptyBodyBytes > targetBytes) throw new Error("Large-body envelope exceeds one MiB");
  payload.messages[0].content = "x".repeat(targetBytes - emptyBodyBytes);
  const body = Buffer.from(JSON.stringify(payload));
  if (body.byteLength !== targetBytes) throw new Error("Large-body fixture serialization mismatch");
  return body;
}

async function requestOnce({ baseUrl, suite, timeoutMs, warmup = false, signal }) {
  const body = requestBodyForSuite(suite);
  const timeoutController = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  const timer = setTimeout(() => timeoutController.abort(new Error("benchmark timeout")), timeoutMs);
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-llm-proxy-client-id": "performance-fixture" },
      body,
      signal: requestSignal,
    });
    const received = Buffer.from(await response.arrayBuffer());
    const sse = suite === "streaming" ? validateTerminalSse(received.toString("utf8")) : null;
    const category = response.ok && (!sse || sse.ok) ? "completed" : "error";
    return {
      warmup,
      category,
      status: response.status,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      bytesSent: body.byteLength,
      bytesReceived: received.byteLength,
      ...(sse ? { sse } : {}),
      ...(category === "error" ? { failure: { name: "HttpError", message: "[redacted]" } } : {}),
    };
  } catch (error) {
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    const category = timeoutController.signal.aborted ? "timeout" : (signal?.aborted ? "aborted" : "error");
    return { warmup, category, durationMs: elapsed, bytesSent: body.byteLength, bytesReceived: 0, failure: redactFailure(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function runPerformanceSuite({ baseUrl, suite, repeat, warmup, concurrency, timeoutMs, serverMemory = null, signal }) {
  if (!PERFORMANCE_SUITES.has(suite)) throw new Error(`Unknown performance suite: ${suite}`);
  const driverStart = process.memoryUsage().rss;
  let driverPeak = driverStart;
  let inflight = 0;
  let maxInflight = 0;
  const warmups = await runBounded(warmup, concurrency, async () => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try { return await requestOnce({ baseUrl, suite, timeoutMs, warmup: true, signal }); }
    finally { inflight--; driverPeak = Math.max(driverPeak, process.memoryUsage().rss); }
  });
  const started = process.hrtime.bigint();
  const measured = await runBounded(repeat, concurrency, async () => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try { return await requestOnce({ baseUrl, suite, timeoutMs, signal }); }
    finally { inflight--; driverPeak = Math.max(driverPeak, process.memoryUsage().rss); }
  });
  const wallDurationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    schema_version: 1,
    suite,
    node_version: process.version,
    config: { repeat, warmup, concurrency, timeout_ms: timeoutMs },
    request_counts: { warmup, measured: repeat, total: warmup + repeat },
    ...summarizePerformance([...warmups, ...measured], { wallDurationMs, maxInflight }),
    memory: {
      benchmark_driver: { rss_start_bytes: driverStart, rss_observed_max_bytes: driverPeak },
      proxy_server: serverMemory || null,
    },
    samples: [...warmups, ...measured],
  };
}

module.exports = {
  DEFAULTS,
  PERFORMANCE_SUITES,
  nearestRank,
  performanceConfig,
  redactFailure,
  requestBodyForSuite,
  requestOnce,
  runBounded,
  runPerformanceSuite,
  summarizePerformance,
  validateTerminalSse,
};
