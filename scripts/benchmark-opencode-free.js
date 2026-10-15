#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const context = require("../lib/task-context"),
  gateway = require("../lib/opencode-transport"),
  performance = require("../lib/free-model-performance");
const READ = {
  type: "function",
  function: {
    name: "read",
    description: "Read a sandbox fixture file. Only fixture.txt exists.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};
const clean = (s) =>
  String(s || "")
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "")
    .trim();
const json = (s) => {
  try {
    return JSON.parse(clean(s));
  } catch {
    return null;
  }
};
function cases({ toolRounds = 1 } = {}) {
  const out = [];
  for (let round = 0; round < 3; round++)
    out.push(
      {
        id: "exact-" + round,
        category: "exact",
        prompt: "Reply exactly: fixture-ok",
        check: (b) => clean(b.choices?.[0]?.message?.content) === "fixture-ok",
      },
      {
        id: "json-" + round,
        category: "exact",
        prompt:
          'Return only JSON: {"sum":42,"even":true}. Compute 19 + 23 to confirm sum.',
        check: (b) => {
          const j = json(b.choices?.[0]?.message?.content);
          return j?.sum === 42 && j.even === true;
        },
      },
      {
        id: "coding-" + round,
        category: "coding",
        prompt:
          "Return only a JSON array with the exact output. const a=[1,2,3,4]; const b=a.filter(x=>x%2===0).map(x=>x*x); What is b?",
        check: (b) =>
          JSON.stringify(json(b.choices?.[0]?.message?.content)) === "[4,16]",
      },
    );
  for (let i = 0; i < 2; i++)
    out.push({
      id: "summary-" + i,
      category: "summary",
      prompt:
        "Return JSON only with arrays ready and pending. API ready; health ready; cache pending; docs pending. Use lowercase names.",
      check: (b) => {
        const j = json(b.choices?.[0]?.message?.content);
        return (
          JSON.stringify(j?.ready?.sort()) === '["api","health"]' &&
          JSON.stringify(j?.pending?.sort()) === '["cache","docs"]'
        );
      },
    });
  for (let i = 0; i < toolRounds * 2; i++)
    out.push({
      id: "tool-" + i,
      category: "tools",
      stream: i % 2 === 1,
      prompt: "Read fixture.txt using read. Then reply with its exact contents and nothing else.",
      tool: true,
      check: (b) => {
        const calls = b.choices?.[0]?.message?.tool_calls;
        return (
          calls?.length === 1 &&
          calls[0].function.name === "read" &&
          json(calls[0].function.arguments)?.path === "fixture.txt"
        );
      },
    });
  out.push({
    id: "sse-text",
    category: "streaming",
    stream: true,
    prompt: "Reply exactly: stream-ok",
    check: (b) => clean(b.choices?.[0]?.message?.content) === "stream-ok",
  });
  const prefix =
    "Stable cache fixture. " +
    "The reference marker is cache-ok. Keep this reference unchanged. ".repeat(
      140,
    );
  for (let i = 0; i < 2; i++)
    out.push({
      id: "cache-" + i,
      session: "cache-pair",
      category: "cache",
      system: prefix,
      prompt: "Reply exactly: cache-ok",
      check: (b) => clean(b.choices?.[0]?.message?.content) === "cache-ok",
    });
  return out;
}
function collectSse(chunks) {
  const message = { role: "assistant", content: "" },
    calls = new Map();
  let usage,
    done = false,
    finish;
  for (const block of chunks.join("").split(/\r?\n\r?\n/)) {
    const raw = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!raw) continue;
    if (raw === "[DONE]") {
      done = true;
      continue;
    }
    const e = JSON.parse(raw);
    if (e.usage) usage = e.usage;
    const c = e.choices?.[0],
      d = c?.delta || {};
    if (d.content) message.content += d.content;
    if (c?.finish_reason) finish = c.finish_reason;
    for (const t of d.tool_calls || []) {
      const x = calls.get(t.index ?? 0) || {
        id: t.id,
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (t.id) x.id = t.id;
      x.function.name += t.function?.name || "";
      x.function.arguments += t.function?.arguments || "";
      calls.set(t.index ?? 0, x);
    }
  }
  if (!done) throw Error("Missing terminal SSE marker");
  if (calls.size) message.tool_calls = [...calls.values()];
  return { choices: [{ message, finish_reason: finish }], usage };
}
function summarize(samples, now = Date.now()) {
  const successful = samples.filter((s) => s.transportOk),
    latencies = successful.map((s) => s.latencyMs).sort((a, b) => a - b),
    e = {
      version: 1,
      source: "native-free-fixtures-v1",
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      scope:
        "Synthetic fixture correctness and transport reliability; not a general intelligence benchmark",
      samples: samples.length,
      transportSuccesses: successful.length,
      checksPassed: samples.filter((s) => s.passed).length,
      toolChecks: samples.filter((s) => s.category === "tools").length,
      toolPassed: samples.filter((s) => s.category === "tools" && s.passed)
        .length,
      streamChecks: samples.filter((s) => s.stream).length,
      streamPassed: samples.filter((s) => s.stream && s.passed).length,
      p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)] || 0,
      p95LatencyMs:
        latencies[
          Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
        ] || 0,
      categories: {},
      cachedInputTokens: successful.reduce(
        (n, s) => n + (s.cachedInputTokens || 0),
        0,
      ),
      inputTokens: successful.reduce((n, s) => n + (s.inputTokens || 0), 0),
      outputTokens: successful.reduce((n, s) => n + (s.outputTokens || 0), 0),
    };
  const measured = successful.filter(
    (s) => Number.isFinite(s.inputTokens) && Number.isFinite(s.outputTokens),
  );
  e.usageObserved = measured.length;
  e.unknownUsageSamples = successful.length - measured.length;
  e.observedInputTokens = measured.reduce((n, s) => n + s.inputTokens, 0);
  e.observedOutputTokens = measured.reduce((n, s) => n + s.outputTokens, 0);
  e.inputTokens = e.unknownUsageSamples ? null : e.observedInputTokens;
  e.outputTokens = e.unknownUsageSamples ? null : e.observedOutputTokens;
  e.cacheObservedSamples = successful.filter((s) =>
    Number.isFinite(s.cachedInputTokens),
  ).length;
  e.observedCachedInputTokens = successful.reduce(
    (n, s) => n + (s.cachedInputTokens || 0),
    0,
  );
  e.cachedInputTokens =
    e.cacheObservedSamples === successful.length
      ? e.observedCachedInputTokens
      : null;
  for (const s of samples) {
    const c = e.categories[s.category] || { samples: 0, passed: 0 };
    c.samples++;
    if (s.passed) c.passed++;
    e.categories[s.category] = c;
  }
  return e;
}
function atomic(file, data) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
async function run({
  config,
  output,
  maxRequests = 220,
  maxRuntimeMs = 900000,
  toolRounds = 1,
  requestTimeoutMs = 45000,
  models,
  route = gateway.route,
  now = Date.now,
  onProgress = () => {},
}) {
  if (!Number.isInteger(toolRounds) || toolRounds < 1 || toolRounds > 5) throw Error("toolRounds must be between 1 and 5");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) throw Error("requestTimeoutMs must be between 1000 and 120000");
  const started = now(),
    report = {
      version: 1,
      startedAt: new Date(started).toISOString(),
      budget: { maxRequests, maxRuntimeMs, requestTimeoutMs, toolRounds, paidRequests: 0 },
      models: [],
      stopped: null,
    },
    controller = new AbortController();
  let count = 0;
  const candidates = (config.providers || []).filter(
    (p) =>
      p.family === "opencode" &&
      p.billing_class === "free_limited" &&
      p.billing_basis === "api",
  );
  if (models) {
    if (!Array.isArray(models) || models.some(id => !candidates.some(p => p.model === id))) throw Error("Requested model is not a configured free OpenCode candidate");
  }
  for (const source of candidates) {
    if (models && !models.includes(source.model)) continue;
    if (report.stopped) break;
    let p;
    try {
      p = performance.nativeCandidate(source, { now: now() });
    } catch (e) {
      report.models.push({ model: source.model, skipped: e.message });
      continue;
    }
    const samples = [],
      sessions = new Map();
    let transportFailures = 0;
    const call = async (c) => {
      if (
        report.stopped ||
        count >= maxRequests ||
        now() - started >= maxRuntimeMs
      ) {
        report.stopped = report.stopped || "request_or_time_budget";
        return null;
      }
      count++;
      const session = c.session || c.id;
      if (!sessions.has(session))
        sessions.set(session, {
          key: crypto
            .createHash("sha256")
            .update(p.model + ":" + session + ":" + started)
            .digest("hex"),
          createdAt: now(),
        });
      const identity = sessions.get(session),
        begin = now();
      const row = {
        case: c.id,
        category: c.category,
        stream: !!c.stream,
        transportOk: false,
        passed: false,
      };
      await context.run(
        {
          identity: { key: identity.key },
          runtime: { inspectTask: () => ({ createdAt: identity.createdAt }) },
        },
        async () => {
          try {
            const messages = c.messages || [
              {
                role: "system",
                content:
                  c.system ||
                  "Follow the user instruction exactly. Do not call tools unless requested.",
              },
              { role: "user", content: c.prompt },
            ];
            const body = {
              model: p.model,
              messages,
              tools: [READ],
              max_completion_tokens: 4096,
              ...(c.tool
                ? {
                    tool_choice: "auto",
                  }
                : {}),
            };
            const chunks = [];
            const response = await route(p, body, {
              timeoutMs: Math.max(
                1,
                Math.min(requestTimeoutMs, maxRuntimeMs - (now() - started)),
              ),
              signal: controller.signal,
              ...(c.stream
                ? { handlers: { onChunk: (x) => chunks.push(x) } }
                : {}),
            });
            if (response?.status >= 400)
              throw Object.assign(Error("HTTP " + response.status), {
                status: response.status,
                headers: response.headers,
              });
            const b = c.stream ? collectSse(chunks) : JSON.parse(response.body);
            row.transportOk = true;
            row.passed = !!c.check(b);
            row.inputTokens = b.usage?.prompt_tokens ?? null;
            row.outputTokens = b.usage?.completion_tokens ?? null;
            row.cachedInputTokens =
              b.usage?.prompt_tokens_details?.cached_tokens ?? null;
            row.finishReason = b.choices?.[0]?.finish_reason;
            if (c.tool && row.passed && !c.stream) {
              row.toolMessage = b.choices[0].message;
              row.toolHistory = messages;
            }
          } catch (e) {
            row.status = Number(e.status) || null;
            row.error =
              e.name === "TimeoutError"
                ? "timeout"
                : String(e.message).slice(0, 180);
            if ([402, 429].includes(row.status)) {
              report.stopped = "provider_limit_" + row.status;
              report.retryAfter = e.headers?.["retry-after"] || null;
              controller.abort();
            }
            transportFailures++;
          }
        },
      );
      row.latencyMs = now() - begin;
      samples.push(row);
      return row;
    };
    for (const c of cases({ toolRounds })) {
      if (report.stopped || transportFailures >= 2) break;
      const row = await call(c);
      if (!row) break;
      if (c.tool && row.passed && !c.stream) {
        const toolMessage = row.toolMessage;
        const history = row.toolHistory;
        delete row.toolMessage;
        delete row.toolHistory;
        await call({
          id: c.id + "-result",
          category: "tools",
          session: c.session || c.id,
          messages: [
            ...history,
            toolMessage,
            {
              role: "tool",
              tool_call_id: toolMessage.tool_calls[0].id,
              content: "fixture-value-47",
            },
          ],
          check: (b) =>
            clean(b.choices?.[0]?.message?.content) === "fixture-value-47",
        });
      }
    }
    // Two independent fixture tasks exercise bounded parallel request handling.
    if (!report.stopped && transportFailures === 0)
      await Promise.all(
        [0, 1].map((i) =>
          call({
            id: "parallel-" + i,
            category: "exact",
            prompt: "Reply exactly: parallel-ok",
            check: (b) =>
              clean(b.choices?.[0]?.message?.content) === "parallel-ok",
          }),
        ),
      );
    const evidence = { ...summarize(samples, now()), plannedSamples: 19 + (toolRounds - 1) * 3 },
      row = {
        model: p.model,
        protocol: p.protocol,
        billingClass: p.billing_class,
        eligible: performance.eligible(evidence, { now: now() }),
        evidence,
        samples,
      };
    report.models.push(row);
    if (output) atomic(output, report);
    onProgress({
      model: p.model,
      samples: samples.length,
      passed: evidence.checksPassed,
      eligible: row.eligible,
    });
  }
  report.requests = count;
  report.completedAt = new Date(now()).toISOString();
  if (output) atomic(output, report);
  return report;
}
async function main() {
  const a = process.argv.slice(2),
    arg = (k, f) => {
      const i = a.indexOf(k);
      return i < 0 ? f : a[i + 1];
    },
    file = path.resolve(arg("--providers", "data/providers.json")),
    output = path.resolve(arg("--output", "data/opencode-free-benchmark.json")),
    config = JSON.parse(fs.readFileSync(file));
  if (!a.includes("--run")) {
    console.log(
      JSON.stringify({
        dryRun: true,
        freeCandidates: config.providers
          .filter(
            (p) =>
              p.family === "opencode" &&
              p.billing_class === "free_limited" &&
              p.billing_basis === "api",
          )
          .map((p) => p.model),
        maxRequests: 220,
        paidRequests: 0,
      }),
    );
    return;
  }
  const report = await run({
    config,
    output,
    models: arg("--models", "").split(",").filter(Boolean).length ? arg("--models", "").split(",").filter(Boolean) : undefined,
    toolRounds: Number(arg("--tool-rounds", "1")),
    requestTimeoutMs: Number(arg("--timeout-ms", "45000")),
    onProgress: (r) => console.log(JSON.stringify(r)),
  });
  if (a.includes("--promote")) {
    const latest = JSON.parse(fs.readFileSync(file));
    for (const row of report.models) {
      const index = latest.providers.findIndex((p) => p.model === row.model);
      if (index < 0 || !row.evidence) continue;
      const source = latest.providers[index];
      latest.providers[index] = performance.applyEvidence(source, row.evidence);
    }
    latest.version = Math.max(Date.now(), Number(latest.version) || 0) + 1;
    atomic(file, latest);
  }
  console.log(
    JSON.stringify({
      requests: report.requests,
      qualified: report.models.filter((m) => m.eligible).map((m) => m.model),
      stopped: report.stopped,
      output,
    }),
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { cases, collectSse, summarize, run };
