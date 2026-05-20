#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_CASES,
  OPUS_CASES,
  ALL_CASES,
  estimateCostUsd,
  extractContent,
  gradeOutput,
  renderReport,
  summarizeRuns,
  usageFromResponse,
} = require("../lib/benchmark");

function loadEnvFile(filePath = ".env") {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) return;
  const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function intArg(args, key, fallback, min, max) {
  const n = Number.parseInt(args[key], 10);
  if (!Number.isFinite(n)) return fallback;
  const bounded = Math.max(min, Math.min(max, n));
  return bounded;
}

function floatArg(args, key, fallback, min, max) {
  const n = Number.parseFloat(args[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function defaultBaseUrl() {
  if (process.env.LLM_PROXY_BASE_URL) return process.env.LLM_PROXY_BASE_URL;
  if (process.env.LLM_PROXY_PORT) return `http://localhost:${process.env.LLM_PROXY_PORT}`;
  return "http://localhost:18900";
}

function casesForSuite(suite) {
  if (suite === "opus") return OPUS_CASES;
  if (suite === "all") return ALL_CASES;
  return DEFAULT_CASES;
}

function configFromArgs(args) {
  const maxMinutes = Number.parseFloat(args["max-minutes"]);
  const maxRuntimeMs = Number.isFinite(maxMinutes)
    ? Math.max(10_000, Math.min(900_000, Math.round(maxMinutes * 60_000)))
    : intArg(args, "max-runtime-ms", 240000, 10000, 900000);
  const budgetUsd = Object.prototype.hasOwnProperty.call(args, "budget-usd")
    ? floatArg(args, "budget-usd", 0, 0, 25)
    : 0;
  const suite = String(args.suite || process.env.BENCH_SUITE || "ladder").trim().toLowerCase();
  const suiteCases = casesForSuite(suite);
  const directDefault = suite === "opus" || suite === "all" ? "windsurf/claude-opus-4-6-1m" : "windsurf/claude-opus-4.6";

  return {
    run: Boolean(args.run),
    json: Boolean(args.json),
    suite,
    baseUrl: String(args["base-url"] || defaultBaseUrl()).replace(/\/+$/, ""),
    directModel: String(args["direct-model"] || process.env.BENCH_DIRECT_MODEL || directDefault),
    proxyModel: String(args["proxy-model"] || process.env.BENCH_PROXY_MODEL || "auto-coding"),
    maxCases: intArg(args, "max-cases", suiteCases.length, 1, suiteCases.length),
    repeat: intArg(args, "repeat", 1, 1, 3),
    maxTokens: intArg(args, "max-tokens", 360, 64, 1000),
    budgetUsd,
    maxRuntimeMs,
    timeoutMs: intArg(args, "timeout-ms", 45000, 1000, 180000),
    output: args.output ? String(args.output) : "",
  };
}

function selectedCases(config) {
  return casesForSuite(config.suite).slice(0, config.maxCases);
}

function renderPlan(config, cases) {
  const requestCount = cases.length * config.repeat * 2;
  const proxyModels = [...new Set(cases.map((testCase) => testCase.proxy_model || config.proxyModel))];
  return [
    "Proxy benchmark dry run",
    "=======================",
    `Suite:         ${config.suite}`,
    `Base URL:      ${config.baseUrl}`,
    `Direct model:  ${config.directModel}`,
    `Proxy flow:    ${proxyModels.join(", ")}`,
    `Cases:         ${cases.length}`,
    `Repeat:        ${config.repeat}`,
    `Requests:      ${requestCount}`,
    `Runtime guard: ${Math.round(config.maxRuntimeMs / 1000)}s`,
    `Cost guard:    ${config.budgetUsd > 0 ? `$${config.budgetUsd.toFixed(4)}` : "disabled"}`,
    "",
    "Cases",
    "-----",
    ...cases.map((testCase) => {
      const proxyModel = testCase.proxy_model || config.proxyModel;
      const shape = testCase.route_shape || "unknown";
      return `c${testCase.complexity} ${testCase.id} shape=${shape} - ${testCase.title} via ${proxyModel} (${testCase.route_goal})`;
    }),
    "",
    "Run with:",
    `npm run benchmark -- --run${config.suite !== "ladder" ? ` --suite=${config.suite}` : ""} --max-cases=${cases.length}`,
  ].join("\n") + "\n";
}

async function postChatCompletion(config, model, testCase, arm = "proxy") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const body = {
    model,
    messages: testCase.messages,
    temperature: 0,
    max_tokens: Math.min(testCase.max_tokens || config.maxTokens, config.maxTokens),
    stream: testCase.stream === true,
  };
  if (testCase.tools) body.tools = testCase.tools;
  if (arm === "direct") {
    body._llmProxyBypassOptimizations = true;
  }

  try {
    const started = Date.now();
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = {}; }
    const content = extractContent(json, text);
    const usage = usageFromResponse(json, response.headers, content);
    const actualModel = response.headers.get("x-llm-model") || json.model || model;
    const provider = response.headers.get("x-llm-provider") || "unknown";
    const cost = estimateCostUsd(actualModel, usage);
    let grade = response.ok
      ? gradeOutput(testCase, content)
      : { passed: false, score: 0, detail: `http:${response.status}` };
    if (response.ok && arm === "proxy" && testCase.expect_proxy_model) {
      const routeOk = new RegExp(testCase.expect_proxy_model, "i").test(`${actualModel} ${provider}`);
      if (!routeOk) {
        grade = {
          passed: false,
          score: 0,
          detail: `route:${actualModel}`,
        };
      }
    }
    if (response.ok && arm === "proxy" && testCase.avoid_proxy_model) {
      const routeBlocked = new RegExp(testCase.avoid_proxy_model, "i").test(`${actualModel} ${provider}`);
      if (routeBlocked) {
        grade = {
          passed: false,
          score: 0,
          detail: `avoid-route:${actualModel}`,
        };
      }
    }

    return {
      status: response.status,
      latency_ms: latencyMs,
      content,
      usage,
      provider,
      requested_model: model,
      actual_model: actualModel,
      cost_group: Number(response.headers.get("x-llm-cost-group") || cost.cost_group || 0),
      thinking_effort: response.headers.get("x-llm-thinking-effort") || "",
      speed_group: Number(response.headers.get("x-llm-speed-group") || 0),
      estimated_cost_usd: cost.usd,
      pricing_source: cost.source,
      ok: response.ok && grade.passed,
      grade,
      error: response.ok ? "" : text.slice(0, 500),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runBenchmark(config) {
  const cases = selectedCases(config);
  const proxyModels = [...new Set(cases.map((testCase) => testCase.proxy_model || config.proxyModel))];
  const runs = [];
  const startedAt = Date.now();
  let spent = 0;
  let stoppedByBudget = false;
  let stoppedByRuntime = false;

  for (let repeat = 0; repeat < config.repeat; repeat++) {
    for (const testCase of cases) {
      if (config.maxRuntimeMs > 0 && Date.now() - startedAt >= config.maxRuntimeMs) {
        stoppedByRuntime = true;
        break;
      }
      if (config.budgetUsd > 0 && spent >= config.budgetUsd) {
        stoppedByBudget = true;
        break;
      }
      const arms = repeat % 2 === 0
        ? [["direct", config.directModel], ["proxy", testCase.proxy_model || config.proxyModel]]
        : [["proxy", testCase.proxy_model || config.proxyModel], ["direct", config.directModel]];

      for (const [arm, model] of arms) {
        let result;
        try {
          result = await postChatCompletion(config, model, testCase, arm);
        } catch (err) {
          result = {
            status: 0,
            latency_ms: config.timeoutMs,
            content: "",
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            provider: "transport-error",
            requested_model: model,
            actual_model: model,
            cost_group: 0,
            thinking_effort: "",
            speed_group: 0,
            estimated_cost_usd: 0,
            pricing_source: "none",
            ok: false,
            grade: { passed: false, score: 0, detail: "transport" },
            error: String(err.message || err),
          };
        }

        if (Number.isFinite(result.estimated_cost_usd)) spent += Number(result.estimated_cost_usd) || 0;
        runs.push({
          ...result,
          arm,
          case_id: testCase.id,
          case_title: testCase.title,
          category: testCase.category,
          complexity: testCase.complexity,
          repeat: repeat + 1,
        });
      }
    }
    if (stoppedByBudget || stoppedByRuntime) break;
  }

  return {
    ...summarizeRuns(runs),
    config: {
      baseUrl: config.baseUrl,
      suite: config.suite,
      directModel: config.directModel,
      proxyModel: config.proxyModel,
      proxyModels,
      maxCases: config.maxCases,
      repeat: config.repeat,
      budgetUsd: config.budgetUsd,
      maxRuntimeMs: config.maxRuntimeMs,
      elapsedMs: Date.now() - startedAt,
      stoppedByBudget,
      stoppedByRuntime,
    },
  };
}

function writeOutput(filePath, data) {
  const fullPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
  return fullPath;
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const config = configFromArgs(args);
  const cases = selectedCases(config);

  if (!config.run) {
    const plan = renderPlan(config, cases);
    if (config.json) {
      process.stdout.write(JSON.stringify({ dry_run: true, config, cases }, null, 2) + "\n");
    } else {
      process.stdout.write(plan);
    }
    return;
  }

  const summary = await runBenchmark(config);
  if (config.output) {
    summary.output = writeOutput(config.output, summary);
  }

  if (config.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    const proxyLabel = summary.config.proxyModels?.length > 1
      ? `smart route ladder (${summary.config.proxyModels.join(", ")})`
      : (summary.config.proxyModels?.[0] || config.proxyModel);
    process.stdout.write(renderReport(summary, {
      directModel: config.directModel,
      proxyModel: proxyLabel,
      suite: summary.config.suite,
      budgetUsd: config.budgetUsd,
      maxRuntimeMs: config.maxRuntimeMs,
    }));
    if (summary.output) process.stdout.write(`Saved JSON: ${summary.output}\n`);
    if (summary.config.stoppedByBudget) process.stdout.write("Stopped because the estimated budget guard was reached.\n");
    if (summary.config.stoppedByRuntime) process.stdout.write("Stopped because the runtime guard was reached.\n");
  }
}

main().catch((err) => {
  process.stderr.write(`benchmark failed: ${err.stack || err.message || err}\n`);
  process.exitCode = 1;
});
