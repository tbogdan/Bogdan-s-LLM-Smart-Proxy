"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createPerformanceMetrics, sampleSize } = require("../lib/performance-metrics");

function response() {
  const res = new EventEmitter();
  res.writableFinished = false;
  res.write = () => true;
  res.end = () => { res.writableFinished = true; res.emit("finish"); res.emit("close"); };
  return res;
}

test("client completion is exactly once and counts end(data) bytes", () => {
  let now = 10n;
  const metrics = createPerformanceMetrics({ sampleSize: 4, now: () => (now += 5_000_000n) });
  const req = new EventEmitter();
  const res = response();
  metrics.observeClient(req, res);
  req.emit("data", Buffer.from("abc"));
  res.write("xy");
  res.end("z");
  res.emit("error", new Error("late"));
  const s = metrics.snapshot();
  assert.deepEqual(s.client, { inflight: 0, completions: 1, errors: 0, aborted: 0, inboundBytes: 3, outboundBytes: 3 });
  assert.equal(s.latencyMs.p50, 5);
});

test("premature close is aborted while explicit terminal cause remains an error", () => {
  const metrics = createPerformanceMetrics();
  const a = new EventEmitter(), ar = response();
  metrics.observeClient(a, ar); ar.emit("close"); ar.emit("error", new Error("late"));
  const b = new EventEmitter(), br = response();
  const observation = metrics.observeClient(b, br); observation.fail("upstream_error"); br.emit("close");
  assert.deepEqual(metrics.snapshot().client, { inflight: 0, completions: 0, errors: 1, aborted: 1, inboundBytes: 0, outboundBytes: 0 });
});

test("reset preserves live inflight and ring is bounded with percentiles", () => {
  let time = 0n;
  const metrics = createPerformanceMetrics({ sampleSize: 3, now: () => time });
  const live = metrics.beginClient();
  metrics.reset();
  assert.equal(metrics.snapshot().client.inflight, 1);
  live.complete();
  for (const ms of [1, 2, 3, 4]) { const op = metrics.beginClient(); time += BigInt(ms * 1e6); op.complete(); }
  const s = metrics.snapshot();
  assert.equal(s.config.sampleSize, 3);
  assert.deepEqual(s.latencyMs, { p50: 3, p95: 4, p99: 4 });
});

test("upstream attempts, retry, fallback, errors and cancels are separate aggregates", () => {
  const metrics = createPerformanceMetrics();
  metrics.recordUpstreamDispatch({ category: "provider" }).complete();
  metrics.recordUpstreamDispatch({ category: "helper", retry: true }).error();
  metrics.recordUpstreamDispatch({ category: "secret/task?q=leak" }).cancel();
  metrics.recordFallback();
  assert.deepEqual(metrics.snapshot().upstream, { dispatches: 3, errors: 1, cancels: 1, retries: 1, fallbacks: 1, byCategory: { provider: 1, helper: 1, ancillary: 0, other: 1 } });
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /secret|task|leak/);
});

test("sample configuration rejects invalid and unsupported huge capacities", () => {
  for (const value of [undefined, "no", "Infinity", "-1", "0", "999999999999999999999"]) assert.equal(sampleSize(value), 1024);
  assert.equal(sampleSize("7"), 7);
});

test("metrics endpoint is versioned and stats keeps its session schema", async t => {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-metrics-"));
  const child = spawn(process.execPath, ["llm-proxy.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dataDir, LLM_PROXY_PORT: String(port), MEMORY_ENABLED: "false", DEV_MODE: "false", LLM_PROXY_PROBE_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stdout.on("data", chunk => logs += chunk); child.stderr.on("data", chunk => logs += chunk);
  t.after(() => { child.kill("SIGTERM"); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, logs);
  const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  assert.deepEqual(Object.keys(stats).sort(), ["by_model", "by_provider", "by_source", "sessions", "total_cached_input_tokens", "total_input_tokens", "total_output_tokens", "total_requests", "total_sessions", "total_tokens", "uptime_minutes"].sort());
  const snapshot = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.config.sampleSize, 1024);
  assert.equal(snapshot.client.inflight, 0);
  assert.equal(snapshot.client.completions, 1);
  assert.deepEqual(Object.keys(snapshot.transport).sort(), ["active", "free", "inflight", "nativeActive", "pending", "retainedBytes"].sort());
  const second = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
  assert.deepEqual(second.client, snapshot.client);
});
