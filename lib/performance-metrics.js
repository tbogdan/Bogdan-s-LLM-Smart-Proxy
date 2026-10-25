"use strict";

const DEFAULT_SAMPLE_SIZE = 1024;
const MAX_SAMPLE_SIZE = 65_536;
const CATEGORIES = new Set(["provider", "helper", "ancillary"]);

function sampleSize(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_SAMPLE_SIZE ? parsed : DEFAULT_SAMPLE_SIZE;
}

function bytes(value, encoding) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value), encoding);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function createPerformanceMetrics(options = {}) {
  const capacity = sampleSize(options.sampleSize ?? options.env?.LLM_PROXY_METRICS_SAMPLE_SIZE ?? process.env.LLM_PROXY_METRICS_SAMPLE_SIZE);
  const now = options.now || process.hrtime.bigint;
  const startedAt = Date.now();
  let transportStats = options.transportStats || (() => ({}));
  let durations = new Array(capacity), durationCount = 0, durationCursor = 0;
  let client = freshClient();
  let upstream = freshUpstream();

  function freshClient() { return { inflight: 0, completions: 0, errors: 0, aborted: 0, inboundBytes: 0, outboundBytes: 0 }; }
  function freshUpstream() { return { dispatches: 0, errors: 0, cancels: 0, retries: 0, fallbacks: 0, byCategory: { provider: 0, helper: 0, ancillary: 0, other: 0 } }; }
  function addDuration(start) {
    durations[durationCursor] = Number(now() - start) / 1e6;
    durationCursor = (durationCursor + 1) % capacity;
    durationCount = Math.min(durationCount + 1, capacity);
  }
  function beginClient() {
    const start = now();
    let settled = false;
    client.inflight++;
    const settle = outcome => {
      if (settled) return;
      settled = true;
      client.inflight = Math.max(0, client.inflight - 1);
      if (outcome === "complete") client.completions++;
      else if (outcome === "aborted") client.aborted++;
      else client.errors++;
      addDuration(start);
    };
    return { complete: () => settle("complete"), abort: () => settle("aborted"), fail: () => settle("error") };
  }
  function observeClient(req, res) {
    const operation = beginClient();
    req.on("data", chunk => { client.inboundBytes += bytes(chunk); });
    const originalWrite = res.write;
    const originalEnd = res.end;
    res.write = function (chunk, encoding, ...rest) {
      client.outboundBytes += bytes(chunk, typeof encoding === "string" ? encoding : undefined);
      return originalWrite.call(this, chunk, encoding, ...rest);
    };
    res.end = function (chunk, encoding, ...rest) {
      client.outboundBytes += bytes(chunk, typeof encoding === "string" ? encoding : undefined);
      return originalEnd.call(this, chunk, encoding, ...rest);
    };
    res.once("finish", operation.complete);
    res.once("close", () => res.writableFinished ? operation.complete() : operation.abort());
    res.once("error", operation.fail);
    return operation;
  }
  function recordUpstreamDispatch({ category = "provider", retry = false } = {}) {
    const key = CATEGORIES.has(category) ? category : "other";
    upstream.dispatches++; upstream.byCategory[key]++;
    if (retry) upstream.retries++;
    let settled = false;
    const settle = outcome => {
      if (settled) return;
      settled = true;
      if (outcome === "error") upstream.errors++;
      if (outcome === "cancel") upstream.cancels++;
    };
    return { complete: () => settle("complete"), error: () => settle("error"), cancel: () => settle("cancel") };
  }
  function snapshot() {
    const values = durations.slice(0, durationCount).sort((a, b) => a - b);
    const memory = process.memoryUsage();
    const transport = transportStats() || {};
    return {
      version: 1,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      config: { sampleSize: capacity },
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers },
      client: { ...client },
      upstream: { ...upstream, byCategory: { ...upstream.byCategory } },
      latencyMs: { p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) },
      transport: {
        active: transport.active || 0, pending: transport.pending || 0, free: transport.free || 0,
        inflight: transport.inflight || 0, retainedBytes: transport.retainedBytes || 0, nativeActive: transport.nativeActive || 0,
      },
    };
  }
  function reset() {
    const inflight = client.inflight;
    client = freshClient(); client.inflight = inflight;
    upstream = freshUpstream(); durations = new Array(capacity); durationCount = 0; durationCursor = 0;
  }
  return { beginClient, observeClient, recordUpstreamDispatch, recordFallback: () => { upstream.fallbacks++; }, snapshot, reset, setTransportStats: fn => { transportStats = fn; } };
}

const metrics = createPerformanceMetrics();
module.exports = { ...metrics, createPerformanceMetrics, sampleSize, DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE };
