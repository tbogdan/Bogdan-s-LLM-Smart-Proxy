#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { performanceConfig, runPerformanceSuite } = require("../lib/performance-benchmark");

const execFileAsync = promisify(execFile);
const { gateConfig, evaluateGates, gateExitCode } = require("../lib/performance-gates");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function createSyntheticUpstream() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    const response = {
      id: "fixture",
      object: "chat.completion",
      model: "performance-fixture",
      choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
}

async function waitForProxy(baseUrl, child, logText) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`proxy fixture exited early (${child.exitCode}): ${logText()}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`proxy fixture did not become ready: ${logText()}`);
}

async function processMemory(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 1000 });
    const kib = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(kib) ? { rss_sample_bytes: kib * 1024, source: "ps-rss" } : null;
  } catch {
    return null;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function runLocalFixture(options) {
  const config = fixtureConfig(options, {});
  const root = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-proxy-performance-"));
  const upstream = createSyntheticUpstream();
  const upstreamPort = await listen(upstream);
  const proxyPort = await unusedPort();
  const providers = {
    version: 1,
    providers: [{
      name: "Codex-Performance-Fixture",
      family: "codex",
      protocol: "openai",
      model: "codex/performance-fixture",
      upstream_model: "performance-fixture",
      url: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
      no_auth: true,
      alive: true,
      tier: 1,
      context: 2097152,
      caps: ["text", "coding", "tools"],
    }],
  };
  fs.writeFileSync(path.join(dataDir, "providers.json"), JSON.stringify(providers));
  let logs = "";
  const child = spawn(process.execPath, ["llm-proxy.js"], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      LLM_PROXY_PORT: String(proxyPort),
      LLM_PROXY_PROBE_ENABLED: "false",
      LLM_PROXY_TASK_ROUTING: "off",
      LLM_PROXY_AI_ASSESSMENT: "off",
      MEMORY_ENABLED: "false",
      DEV_MODE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => { logs = (logs + chunk.toString("utf8")).slice(-16000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stopChild(child);
    await closeServer(upstream);
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    await waitForProxy(baseUrl, child, () => logs);
    const snapshot = async () => {
      try { const response = await fetch(`${baseUrl}/metrics`, {signal:AbortSignal.timeout(1000)}); return response.ok ? await response.json() : null; } catch { return null; }
    };
    const before = await snapshot();
    const serverMemory = await processMemory(child.pid);
    const report = await runPerformanceSuite({ ...config, suite: options.suite, baseUrl, serverMemory });
    report.metrics = { before, after: await snapshot() };
    report.fixture = {
      mode: "local-synthetic-upstream",
      proxy_entrypoint: "llm-proxy.js",
      temporary_data: true,
      upstream: "local-fixed-response",
    };
    return { report, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const separator = item.indexOf("=");
    if (separator !== -1) args[item.slice(2, separator)] = item.slice(separator + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) args[item.slice(2)] = argv[++index];
    else args[item.slice(2)] = true;
  }
  return args;
}

function fixtureConfig(args = {}, env = process.env) {
  return performanceConfig({
    suite: "latency",
    repeat: args.repeat,
    warmup: args.warmup,
    concurrency: args.concurrency,
    "timeout-ms": args.timeoutMs ?? args["timeout-ms"],
  }, env);
}

function sameFixtureConfig(baseline, config) {
  return baseline?.repeat === config.repeat && baseline?.warmup === config.warmup && baseline?.concurrency === config.concurrency && baseline?.timeout_ms === config.timeoutMs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = fixtureConfig(args);
  const suites = ["latency", "throughput", "large-body", "streaming"];
  const reports = [];
  const baseline = args.baseline ? JSON.parse(fs.readFileSync(path.resolve(String(args.baseline)), "utf8")) : null;
  const limits = gateConfig();
  if (baseline && !sameFixtureConfig(baseline.config, config)) throw new Error("Baseline configuration mismatch");
  for (const suite of suites) {
    const fixture = await runLocalFixture({ ...config, suite });
    try {
      const report = fixture.report;
      const prior = baseline?.suites.find(entry => entry.suite === suite);
      const thresholds = {...limits};
      if (baseline) {
        if (!prior || prior.counts.completed !== prior.counts.attempted) throw new Error("Baseline suite missing or unsuccessful");
        thresholds.maxP95Ms = prior.latency_ms.p95 * 1.25 + 2;
        thresholds.maxP99Ms = prior.latency_ms.p99 * 1.25 + 2;
        thresholds.minSuccessfulRps = prior.throughput_requests_per_second * .8;
        report.comparison = {baseline:{p95Ms:prior.latency_ms.p95,p99Ms:prior.latency_ms.p99,successfulRps:prior.throughput_requests_per_second},ratios:{p95:report.latency_ms.p95/prior.latency_ms.p95,p99:report.latency_ms.p99/prior.latency_ms.p99,successfulRps:report.successful_requests_per_second/prior.throughput_requests_per_second}};
      }
      report.gates = evaluateGates(report, thresholds);
      process.exitCode = Math.max(process.exitCode || 0, gateExitCode(report.gates, limits.enforce));
      reports.push(report);
    }
    finally { await fixture.cleanup(); }
  }
  const artifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    node_version: process.version,
    fixture: "real-proxy-child-local-synthetic-upstream",
    config: { ...config, timeout_ms: config.timeoutMs },
    suites: reports,
  };
  delete artifact.config.timeoutMs;
  const output = path.resolve(String(args.output || ".superpowers/sdd/2026-10-25-performance-hardening/performance-latest.json"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, node_version: process.version, suites: reports.map((report) => ({ suite: report.suite, counts: report.counts, gates: report.gates, comparison: report.comparison, throughput_requests_per_second: report.throughput_requests_per_second })) }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`performance fixture failed: ${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { fixtureConfig, sameFixtureConfig, main, runLocalFixture };
