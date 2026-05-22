"use strict";

function repeatedMessages(message, count) {
  return Array.from({ length: count }, () => ({ ...message }));
}

const DEFAULT_CASES = [
  {
    id: "exact-reply",
    title: "Exact low-cost reply",
    category: "smoke",
    complexity: 1,
    route_goal: "free or cheapest fast exact-answer model",
    route_shape: "direct",
    proxy_model: "auto-coding",
    max_tokens: 24,
    messages: [
      { role: "system", content: "Return only the requested exact text." },
      { role: "user", content: "Reply exactly: proxy-benchmark-ok" },
    ],
    expect: {
      type: "exact",
      value: "proxy-benchmark-ok",
    },
  },
  {
    id: "session-summary",
    title: "Session task summary",
    category: "summary",
    complexity: 2,
    route_goal: "cheap list-summary model, preferably SWE when healthy",
    route_shape: "write_heavy",
    proxy_model: "auto-text",
    max_tokens: 180,
    messages: [
      { role: "system", content: "Return five concise bullets. Each bullet must start with a subsystem name." },
      { role: "user", content: "Make a list of remaining handoff notes and summarize status: API validation finished, deployment checklist prepared, cache cleanup pending, local health passed, remote health passed, documentation update pending. Do not call tools or write function-call syntax." },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "contains", value: "API" },
        { type: "contains", value: "deployment" },
        { type: "contains", value: "health" },
      ],
    },
  },
  {
    id: "async-resource-leak",
    title: "Async timeout resource leak",
    category: "coding",
    complexity: 3,
    route_goal: "small fast coding model such as Haiku, GPT mini, or SWE 1.6",
    route_shape: "write_heavy",
    proxy_model: "coding-sm",
    max_tokens: 260,
    messages: [
      { role: "system", content: "Return only the corrected JavaScript function and one short note." },
      { role: "user", content: "Fix the leak and cancellation bug:\nasync function fetchWithTimeout(url, ms) {\n  const controller = new AbortController();\n  const timeout = setTimeout(() => controller.abort(), ms);\n  const res = await fetch(url, { signal: controller.signal });\n  return res.json();\n}" },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "contains", value: "clearTimeout" },
        { type: "regex", value: "finally\\s*\\{" },
        { type: "contains", value: "AbortController" },
      ],
    },
  },
  {
    id: "code-trace-invariant",
    title: "Code reasoning invariant trace",
    category: "code-reasoning",
    complexity: 3,
    route_goal: "midrange coding-reasoning model, inspired by CRUX-style code understanding",
    route_shape: "read_heavy",
    proxy_model: "auto-coding",
    max_tokens: 260,
    messages: [
      { role: "system", content: "Return minified JSON only with keys output, invariant, bug, fix." },
      { role: "user", content: "Analyze this scheduler without running it:\nfunction schedule(jobs) {\n  const seen = new Set();\n  const out = [];\n  for (const job of jobs) {\n    if (seen.has(job.id)) continue;\n    seen.add(job.id);\n    if (job.dep && !seen.has(job.dep)) out.push(`wait:${job.id}`);\n    out.push(job.id);\n  }\n  return out;\n}\nInput: [{id:'build'},{id:'test',dep:'build'},{id:'deploy',dep:'package'},{id:'test'}]\nWhat is the exact output, what invariant is violated, and what minimal fix avoids scheduling deploy before package?" },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "regex", value: "build.*test.*wait:deploy.*deploy" },
        { type: "regex", value: "dependency|dep|topological|precondition" },
        { type: "regex", value: "skip|throw|defer|queue|missing" },
      ],
    },
  },
  {
    id: "completion-review",
    title: "Completed feature review",
    category: "review",
    complexity: 3,
    route_goal: "review-optimized coding model, including Codex auto-review when available",
    route_shape: "review",
    proxy_model: "auto-coding",
    max_tokens: 260,
    messages: [
      { role: "system", content: "Use only the excerpt. Return exactly three risk bullets. Do not call tools or ask to inspect files." },
      { role: "user", content: "Review this completed feature before merge. Implemented: stricter JSON config parsing, fallback defaults, validation errors, and unit tests. Diff excerpt:\n+ const parsed = parseConfig(raw);\n+ if (!parsed.serviceUrl) throw new ConfigError('missing serviceUrl');\n+ return { retries: 2, timeoutMs: 3000, ...parsed };\nPotential concern: production config files may rely on old permissive parsing. Mention risk, direct user impact, and validation." },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "contains", value: "risk" },
        { type: "regex", value: "impact|compatib|production|config" },
        { type: "regex", value: "test|verify|validation|comparable" },
      ],
    },
  },
  {
    id: "secure-token-patch",
    title: "Secure token verification patch",
    category: "secure-coding",
    complexity: 4,
    route_goal: "strong coding model for security-sensitive patch design",
    route_shape: "security",
    proxy_model: "auto-coding",
    max_tokens: 340,
    messages: [
      { role: "system", content: "Return a concise patch sketch and three regression tests. Do not use markdown tables." },
      { role: "user", content: "Fix this Node.js webhook verifier. Current code accepts replayed tokens and leaks timing info:\nfunction verify(sig, body, secret) {\n  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');\n  return sig === expected;\n}\nRequired: header format t=<unix>,v1=<hex>; reject timestamps older than 5 minutes; compare with constant-time semantics; handle malformed hex safely; list tests that would fail before the patch." },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "regex", value: "timingSafeEqual|constant.?time" },
        { type: "regex", value: "timestamp|replay|5\\s*minutes|300" },
        { type: "regex", value: "malformed|hex|length" },
        { type: "regex", value: "test|regression" },
      ],
    },
  },
  {
    id: "tool-schema-bridge",
    title: "Tool schema bridge design",
    category: "coding",
    complexity: 4,
    route_goal: "strong coding/tool model for proxy compatibility design",
    route_shape: "read_heavy",
    proxy_model: "auto-coding",
    max_tokens: 320,
    messages: [
      { role: "system", content: "Return four bullets with validation rules. Be precise and concise." },
      { role: "user", content: "Design a translator for Claude Code tool calls where the upstream sometimes emits Bash with {cmd:'ls'} or empty input, but the client requires {command:string}. Include how invalid tool calls should affect rerouting and cooldown." },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "contains", value: "command" },
        { type: "contains", value: "cmd" },
        { type: "regex", value: "rerout|cooldown|reject|422" },
      ],
    },
  },
  {
    id: "terminal-agent-plan",
    title: "Terminal agent recovery plan",
    category: "agent-planning",
    complexity: 4,
    route_goal: "reasoning model for terminal-agent workflow recovery and verification",
    route_shape: "read_heavy",
    proxy_model: "auto-thinking",
    max_tokens: 320,
    messages: [
      { role: "system", content: "Return five ordered steps. Each step must include evidence, action, and stop condition." },
      { role: "user", content: "A terminal coding agent is midway through a repository migration. Signals: tests were green before a Docker rebuild, one generated file is dirty, a benchmark process was interrupted, and the next run must not hide regressions. Design a recovery workflow that mirrors terminal-agent benchmarks: inspect state, isolate unrelated changes, resume safely, verify, and report." },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "regex", value: "git status|dirty|changed" },
        { type: "regex", value: "benchmark|process|interrupted" },
        { type: "regex", value: "test|verify|regression" },
        { type: "regex", value: "stop condition|stop" },
      ],
    },
  },
  {
    id: "production-incident",
    title: "Production proxy incident decision",
    category: "architecture",
    complexity: 5,
    route_goal: "highest-capability model when reasoning, architecture, and risk dominate",
    route_shape: "security",
    proxy_model: "auto-max",
    max_tokens: 340,
    messages: [
      { role: "system", content: "Return minified JSON only." },
      { role: "user", content: "A local LLM proxy routes Claude Code traffic to Windsurf, Claude, Codex, and Copilot. Incident facts: Windsurf sometimes returns text-only while 75 tools are available, some Claude calls are rate-limited, direct Opus is accurate but expensive, SWE is free but weak for agentic coding, and benchmark direct calls must bypass prompt injection and compaction. Choose a decision between provider-ban, schema-translation, adaptive-routing, or always-opus. Return JSON with decision, first_fix, fallback, benchmark_signal, and risk." },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "json", path: "decision", value: "adaptive-routing" },
        { type: "regex", value: "first_fix" },
        { type: "regex", value: "benchmark_signal" },
        { type: "regex", value: "risk" },
      ],
    },
  },
];

const OPUS_CASES = [
  {
    id: "opus-edit-recovery",
    title: "Stale edit recovery after patch failures",
    category: "edit-recovery",
    complexity: 5,
    route_goal: "strong intermediate recovery model under balanced cost and speed targets",
    route_shape: "read_heavy",
    proxy_model: "auto-coding",
    avoid_proxy_model: "opus|claude-opus",
    max_tokens: 260,
    messages: [
      {
        role: "system",
        content: [
          "You are evaluating a precise code-edit recovery failure.",
          "Return exactly four bullets: root cause, immediate fix, prevention, benchmark signal.",
          "Each bullet must mention the concrete evidence it used.",
        ].join("\n"),
      },
      ...repeatedMessages({
        role: "assistant",
        content: "Read run_cmd.py (lines 353-382). Observed return object around command, dry_run, config, experiment_file, experiment_type, duration, lifecycle. The stale excerpt was repeated by the client history after unsuccessful patch attempts. This duplicate history is intentionally present so the baseline transcript pays for unoptimized context while the optimized arm can deduplicate identical context before sending the request upstream.",
      }, 8),
      {
        role: "assistant",
        content: "Edit run_cmd.py\nEdit failed: expected text was not found. Shimming and retrying after a stale read. The patch inserted status/logging before return but the file likely changed between reads.",
      },
      {
        role: "user",
        content: "Diagnose why the edit failed and give a precise next-edit algorithm so the patch does not corrupt adjacent return-object fields.",
      },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "contains", value: "stale" },
        { type: "contains", value: "read" },
        { type: "regex", value: "precise|context|algorithm|verify|re-read" },
      ],
    },
  },
  {
    id: "opus-proxy-incident",
    title: "Proxy incident architecture decision",
    category: "architecture",
    complexity: 5,
    route_goal: "intermediate architecture model for balanced routing and cost-efficiency decision",
    route_shape: "read_heavy",
    proxy_model: "auto-max",
    avoid_proxy_model: "opus|claude-opus",
    max_tokens: 320,
    messages: [
      {
        role: "system",
        content: "Return minified JSON only with keys decision, architecture, optimization, direct_vs_proxy, risk.",
      },
      {
        role: "user",
        content: "A local LLM proxy handles Claude Code traffic, tool-call translation, streaming normalization, provider cooldowns, duplicate-history cleanup, and direct-vs-optimized benchmark comparison. Design the safest architecture decision for an incident where stale edit recovery, provider health noise, and cost-efficiency all matter at once.",
      },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "regex", value: "adaptive|frontier|long.?context|architecture" },
        { type: "regex", value: "optimization" },
        { type: "regex", value: "optimization" },
        { type: "regex", value: "risk" },
      ],
    },
  },
  {
    id: "opus-auto-escalation",
    title: "Concurrency-safe routing algorithm",
    category: "architecture",
    complexity: 5,
    route_goal: "auto smart-routing should select a frontier long-context model for a hard architecture task",
    route_shape: "read_heavy",
    proxy_model: "auto",
    expect_proxy_model: "opus|claude-opus",
    max_tokens: 260,
    stream: true,
    messages: [
      {
        role: "system",
        content: [
          "Return minified JSON only.",
          "Use keys invariants, algorithm, failure_modes, verification_plan, rollback.",
          "Each value must be concrete and implementation-oriented.",
        ].join("\n"),
      },
      ...repeatedMessages({
        role: "assistant",
        content: "Prior attempt context: Claude Code saw repeated read/edit cycles, provider health conflicts, tool-call translation risks, and duplicated benchmark evidence. The same diagnostic note appears many times to simulate unoptimized direct transcript cost; optimized proxy should deduplicate it before sending the final request upstream.",
      }, 10),
      {
        role: "assistant",
        content: "Edit failed after repeated stale reads. Raw logs show tool schema risk, rate-limit noise, model-class mismatch risk, and benchmark direct-vs-proxy ambiguity.",
      },
      {
        role: "user",
        content: "Deep research hard bug with one million token context pressure: design a concurrency-safe router for a local LLM proxy. It must handle Claude Code tool calls, Windsurf compatibility quirks, provider cooldowns, stale edit recovery, streaming/non-streaming normalization, deduplicated long-context history, and cost-aware fallback without creating oscillation or hiding correctness regressions. Give implementable invariants and a verification plan.",
      },
    ],
    expect: {
      type: "all",
      checks: [
        { type: "regex", value: "invariants" },
        { type: "regex", value: "cooldown|fallback|oscillation" },
        { type: "regex", value: "dedup|duplicat|long.?context|stream" },
        { type: "regex", value: "verification|regression|rollback" },
      ],
    },
  },
];

const CASES_BY_ID = new Map([...DEFAULT_CASES, ...OPUS_CASES].map((testCase) => [testCase.id, testCase]));
const ALL_CASE_IDS = [
  "exact-reply",
  "session-summary",
  "async-resource-leak",
  "completion-review",
  "terminal-agent-plan",
  "opus-edit-recovery",
  "opus-proxy-incident",
  "opus-auto-escalation",
];
const ALL_CASES = ALL_CASE_IDS.map((id) => CASES_BY_ID.get(id)).filter(Boolean);

const DEFAULT_PRICE_TABLE = [
  { pattern: /windsurf\/swe|(^|[-_/])swe[-_.]/i, input: 0, output: 0, cost_group: 1, source: "swe_free" },
  { pattern: /gpt[-_.]?5[-_.]?5/i, input: 5, output: 30, cost_group: 4, source: "openai_pricing" },
  { pattern: /gpt[-_.]?5[-_.]?4.*mini/i, input: 0.75, output: 4.5, cost_group: 2, source: "openai_pricing" },
  { pattern: /gpt[-_.]?5[-_.]?4/i, input: 2.5, output: 15, cost_group: 3, source: "openai_pricing" },
  { pattern: /gpt[-_.]?5[-_.]?2|gpt[-_.]?5[-_.]?3.*codex|codex.*auto[-_.]?review/i, input: 1.75, output: 14, cost_group: 3, source: "openai_family_estimate" },
  { pattern: /claude.*opus|opus[-_.]?4/i, input: 15, output: 75, cost_group: 5, source: "anthropic_pricing" },
  { pattern: /claude.*sonnet|sonnet[-_.]?4/i, input: 3, output: 15, longInput: 6, longOutput: 22.5, longThreshold: 200000, cost_group: 3, source: "anthropic_pricing" },
  { pattern: /claude.*haiku|haiku[-_.]?4/i, input: 1, output: 5, cost_group: 2, source: "anthropic_pricing" },
  { pattern: /gemini.*flash|flash[-_.]?lite/i, input: 0.15, output: 0.6, cost_group: 1, source: "family_estimate" },
  { pattern: /gemini.*pro/i, input: 2.5, output: 15, cost_group: 3, source: "family_estimate" },
  { pattern: /mini|small|nano|lite/i, input: 0.25, output: 2, cost_group: 1, source: "family_estimate" },
];

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((current, part) => {
    if (current == null) return undefined;
    if (Array.isArray(current)) return current[Number(part)];
    return current[part];
  }, obj);
}

function stripCodeFence(text) {
  const value = String(text || "").trim();
  const fence = value.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : value;
}

function parseJsonCandidate(text) {
  const clean = stripCodeFence(text);
  try {
    return JSON.parse(clean);
  } catch {}
  const object = clean.match(/\{[\s\S]*\}/);
  if (object) {
    try { return JSON.parse(object[0]); } catch {}
  }
  const array = clean.match(/\[[\s\S]*\]/);
  if (array) {
    try { return JSON.parse(array[0]); } catch {}
  }
  return undefined;
}

function validateJsonSchema(value, schema = {}) {
  if (!schema || typeof schema !== "object") return { passed: true, detail: "schema:none" };
  if (schema.type) {
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (type !== schema.type) return { passed: false, detail: `schema:type:${schema.type}` };
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return { passed: false, detail: "schema:enum" };
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!value || typeof value !== "object" || !(key in value)) {
        return { passed: false, detail: `schema:required:${key}` };
      }
    }
  }
  if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue;
      const child = validateJsonSchema(value[key], childSchema);
      if (!child.passed) return { passed: false, detail: `${key}.${child.detail}` };
    }
  }
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const child = validateJsonSchema(value[i], schema.items);
      if (!child.passed) return { passed: false, detail: `${i}.${child.detail}` };
    }
  }
  return { passed: true, detail: "schema" };
}

function gradeOutput(testCase, content) {
  const expect = testCase.expect || {};
  const output = stripCodeFence(content);
  if (!expect.type) return { passed: true, score: 1, detail: "ungraded" };

  if (expect.type === "exact") {
    const passed = output.trim() === String(expect.value);
    return { passed, score: passed ? 1 : 0, detail: "exact" };
  }

  if (expect.type === "contains") {
    const passed = output.toLowerCase().includes(String(expect.value).toLowerCase());
    return { passed, score: passed ? 1 : 0, detail: "contains" };
  }

  if (expect.type === "regex") {
    const passed = new RegExp(expect.value, "i").test(output);
    return { passed, score: passed ? 1 : 0, detail: "regex" };
  }

  if (expect.type === "json") {
    const parsed = parseJsonCandidate(output);
    const actual = getPath(parsed, expect.path);
    const passed = actual === expect.value;
    return { passed, score: passed ? 1 : 0, detail: `json:${expect.path}` };
  }

  if (expect.type === "json_schema") {
    const parsed = parseJsonCandidate(output);
    const result = validateJsonSchema(parsed, expect.schema);
    return { passed: result.passed, score: result.passed ? 1 : 0, detail: result.detail };
  }

  if (expect.type === "all") {
    const checks = Array.isArray(expect.checks) ? expect.checks : [];
    if (checks.length === 0) return { passed: false, score: 0, detail: "all:empty" };
    const results = checks.map((check) => gradeOutput({ expect: check }, content));
    const passed = results.every((result) => result.passed);
    return {
      passed,
      score: round(results.reduce((sum, result) => sum + result.score, 0) / checks.length, 3),
      detail: `all:${results.filter((result) => result.passed).length}/${checks.length}`,
    };
  }

  return { passed: false, score: 0, detail: `unknown:${expect.type}` };
}

function matchPricing(model, priceTable = DEFAULT_PRICE_TABLE, usage = {}) {
  const modelText = String(model || "");
  const match = priceTable.find((entry) => entry.pattern.test(modelText));
  if (!match) return { input: null, output: null, cost_group: null, source: "unknown" };
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  if (match.longThreshold && inputTokens > match.longThreshold) {
    return {
      input: match.longInput ?? match.input,
      output: match.longOutput ?? match.output,
      cost_group: Math.max(match.cost_group || 3, 4),
      source: `${match.source}_long_context`,
    };
  }
  return match;
}

function cachedInputTokensFromUsage(usage = {}) {
  return Number(
    usage.cached_input_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cache_read_tokens
      ?? usage.input_tokens_details?.cache_read_tokens
      ?? usage.cache_read_input_tokens
      ?? 0
  ) || 0;
}

function estimateCostUsd(model, usage = {}, options = {}) {
  const pricing = matchPricing(model, options.priceTable || DEFAULT_PRICE_TABLE, usage);
  if (pricing.input == null || pricing.output == null) {
    return { usd: null, cost_group: null, source: pricing.source };
  }
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const cachedInputTokens = Math.max(0, Math.min(inputTokens, cachedInputTokensFromUsage(usage)));
  const freshInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedInputPriceRatio = Number.isFinite(Number(options.cachedInputPriceRatio))
    ? Number(options.cachedInputPriceRatio)
    : Number.isFinite(Number(pricing.cachedInputPriceRatio))
      ? Number(pricing.cachedInputPriceRatio)
      : 0.1;
  const usd =
    (freshInputTokens / 1_000_000) * pricing.input +
    (cachedInputTokens / 1_000_000) * pricing.input * cachedInputPriceRatio +
    (outputTokens / 1_000_000) * pricing.output;
  return {
    usd: round(usd, 6),
    cost_group: pricing.cost_group,
    source: pricing.source,
    fresh_input_tokens: freshInputTokens,
    cached_input_tokens: cachedInputTokens,
  };
}

function estimateTokensFromText(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function usageFromResponse(json = {}, headers = {}, content = "") {
  const h = typeof headers.get === "function"
    ? (name) => headers.get(name)
    : (name) => headers[String(name).toLowerCase()] || headers[name];
  const responseUsage = json.usage || {};
  const prompt = Number(responseUsage.prompt_tokens || responseUsage.input_tokens || h("x-llm-prompt-tokens") || 0);
  const completion = Number(responseUsage.completion_tokens || responseUsage.output_tokens || h("x-llm-completion-tokens") || 0) || estimateTokensFromText(content);
  const cachedInput = Number(cachedInputTokensFromUsage(responseUsage) || h("x-llm-cached-input-tokens") || 0);
  const reportedTotal = Number(responseUsage.total_tokens || h("x-llm-tokens-used") || 0) || 0;
  const total = Math.max(reportedTotal, prompt + completion);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_input_tokens: cachedInput,
  };
}

function extractContentFromSse(text = "") {
  const parts = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.+)$/);
    if (!match) continue;
    const payload = match[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      const choice = event.choices?.[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === "string") parts.push(delta.content);
      if (typeof choice.message?.content === "string") parts.push(choice.message.content);
      if (typeof choice.text === "string") parts.push(choice.text);
    } catch {}
  }
  return parts.join("");
}

function extractContent(json = {}, rawText = "") {
  const choice = json.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (Array.isArray(choice?.message?.content)) {
    return choice.message.content.map((part) => part.text || part.content || "").join("");
  }
  if (typeof choice?.text === "string") return choice.text;
  if (typeof json.output_text === "string") return json.output_text;
  const streamed = extractContentFromSse(rawText);
  if (streamed) return streamed;
  return "";
}

function asciiBar(value, max, width = 24) {
  const parsedMax = Number(max);
  const safeMax = parsedMax > 0 ? parsedMax : 1;
  const safeValue = Math.max(Number(value) || 0, 0);
  const filled = Math.max(0, Math.min(width, Math.round((safeValue / safeMax) * width)));
  return `${"#".repeat(filled)}${".".repeat(width - filled)}`;
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return round((numerator / denominator) * 100, 1);
}

function percentile(values, p) {
  const sorted = values
    .map((value) => Number(value))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

function sourceLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("/")) return text.split("/")[0] || text;
  if (text.includes("-")) return text.split("-")[0] || text;
  return text;
}

function candidateSource(candidate = {}) {
  if (typeof candidate === "string") return sourceLabel(candidate);
  return sourceLabel(
    candidate.source ||
    candidate.provider_family ||
    candidate.family ||
    candidate.provider ||
    candidate.name ||
    candidate.model ||
    "",
  );
}

function ensureFairnessBucket(fairness, source) {
  const key = sourceLabel(source) || "unknown";
  if (!fairness[key]) {
    fairness[key] = { eligible: 0, top3: 0, selected: 0, failed: 0, gated: 0 };
  }
  return fairness[key];
}

function warningCountForRun(run = {}) {
  if (run.warning) return 1;
  if (Array.isArray(run.warnings) && run.warnings.length > 0) return 1;
  return 0;
}

function aggregateProviderFairness(runs = []) {
  const fairness = {};
  for (const run of runs) {
    const trace = run.route_trace || {};
    const candidates = Array.isArray(trace.candidates) ? trace.candidates : [];
    const eligibleSources = Array.isArray(trace.eligible_sources) ? trace.eligible_sources : [];
    if (eligibleSources.length > 0) {
      for (const source of eligibleSources) ensureFairnessBucket(fairness, source).eligible++;
      candidates.forEach((candidate, idx) => {
        if (idx < 3) ensureFairnessBucket(fairness, candidateSource(candidate)).top3++;
      });
    } else {
      candidates.forEach((candidate, idx) => {
        const bucket = ensureFairnessBucket(fairness, candidateSource(candidate));
        bucket.eligible++;
        if (idx < 3) bucket.top3++;
      });
    }

    const selectedSource = sourceLabel(
      trace.selected_source ||
      trace.selected_family ||
      candidateSource(trace.selected || {}) ||
      run.provider ||
      run.actual_model ||
      "",
    );
    if (selectedSource) ensureFairnessBucket(fairness, selectedSource).selected++;

    const failedSources = Array.isArray(trace.failed_sources) ? trace.failed_sources : [];
    for (const source of failedSources) ensureFairnessBucket(fairness, source).failed++;

    const gatedSources = Array.isArray(trace.gated_sources) ? trace.gated_sources : [];
    for (const source of gatedSources) ensureFairnessBucket(fairness, source).gated++;
  }
  return fairness;
}

function aggregateMemoryStats(runs = []) {
  return {
    injected_tokens: runs.reduce((sum, run) => sum + (Number(run.memory?.injected_tokens) || 0), 0),
    recall_retries: runs.reduce((sum, run) => sum + (Number(run.memory?.recall_retries) || 0), 0),
  };
}

function aggregateCompactionStats(runs = []) {
  return {
    archive_refs: runs.reduce((sum, run) => sum + (Number(run.compaction?.archive_refs) || 0), 0),
    ai_summary_uses: runs.reduce((sum, run) => sum + (run.compaction?.ai_summary_used ? 1 : 0), 0),
  };
}

function summarizeArm(runs) {
  const count = runs.length;
  const correct = runs.filter((run) => run.ok).length;
  const complexityTotal = runs.reduce((sum, run) => sum + (run.complexity || 1), 0);
  const complexityCorrect = runs.reduce((sum, run) => sum + (run.ok ? (run.complexity || 1) : 0), 0);
  const totalCost = runs.reduce((sum, run) => sum + (Number(run.estimated_cost_usd) || 0), 0);
  const latencies = runs.map((run) => Number(run.latency_ms)).filter(Number.isFinite);
  const providers = {};
  const models = {};
  for (const run of runs) {
    providers[run.provider || "unknown"] = (providers[run.provider || "unknown"] || 0) + 1;
    models[run.actual_model || run.requested_model || "unknown"] = (models[run.actual_model || run.requested_model || "unknown"] || 0) + 1;
  }

  return {
    runs: count,
    correct,
    unique_provider_count: Object.keys(providers).length,
    unique_model_count: Object.keys(models).length,
    correctness_pct: pct(correct, count),
    weighted_correctness_pct: pct(complexityCorrect, complexityTotal),
    avg_latency_ms: count ? Math.round(runs.reduce((sum, run) => sum + run.latency_ms, 0) / count) : 0,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    avg_prompt_tokens: count ? Math.round(runs.reduce((sum, run) => sum + (run.usage?.prompt_tokens || 0), 0) / count) : 0,
    avg_cached_input_tokens: count ? Math.round(runs.reduce((sum, run) => sum + (run.usage?.cached_input_tokens || cachedInputTokensFromUsage(run.usage || {}) || 0), 0) / count) : 0,
    avg_completion_tokens: count ? Math.round(runs.reduce((sum, run) => sum + (run.usage?.completion_tokens || 0), 0) / count) : 0,
    avg_total_tokens: count ? Math.round(runs.reduce((sum, run) => sum + (run.usage?.total_tokens || 0), 0) / count) : 0,
    estimated_cost_usd: round(totalCost, 6),
    avg_estimated_cost_usd: count ? round(totalCost / count, 6) : 0,
    cost_per_correct_usd: correct ? round(totalCost / correct, 6) : null,
    avg_cost_group: count ? round(runs.reduce((sum, run) => sum + (Number(run.cost_group) || 0), 0) / count, 2) : 0,
    warning_count: runs.reduce((sum, run) => sum + warningCountForRun(run), 0),
    memory: aggregateMemoryStats(runs),
    compaction: aggregateCompactionStats(runs),
    provider_fairness: aggregateProviderFairness(runs),
    providers,
    models,
  };
}

function summarizeRuns(runs = []) {
  return {
    generated_at: new Date().toISOString(),
    runs,
    direct: summarizeArm(runs.filter((run) => run.arm === "direct")),
    proxy: summarizeArm(runs.filter((run) => run.arm === "proxy")),
  };
}

function formatUsd(value) {
  if (value == null) return "unknown";
  return `$${Number(value).toFixed(6)}`;
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return "unknown";
  const rounded = round(value, 1);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function formatMap(map = {}) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key} x${count}`)
    .join(", ") || "none";
}

function formatFairness(map = {}) {
  return Object.entries(map)
    .sort((a, b) => {
      const selectedDiff = (b[1]?.selected || 0) - (a[1]?.selected || 0);
      const topDiff = (b[1]?.top3 || 0) - (a[1]?.top3 || 0);
      return selectedDiff || topDiff || a[0].localeCompare(b[0]);
    })
    .map(([source, stats]) => {
      return `${source} eligible=${stats.eligible || 0} top3=${stats.top3 || 0} selected=${stats.selected || 0} failed=${stats.failed || 0} gated=${stats.gated || 0}`;
    })
    .join("; ") || "none";
}

function renderReport(summary, options = {}) {
  const direct = summary.direct;
  const proxy = summary.proxy;
  const maxLatency = Math.max(direct.avg_latency_ms, proxy.avg_latency_ms, 1);
  const maxTokens = Math.max(direct.avg_total_tokens, proxy.avg_total_tokens, 1);
  const maxCost = Math.max(direct.avg_estimated_cost_usd, proxy.avg_estimated_cost_usd, 0.000001);
  const costSavingsPct = direct.estimated_cost_usd > 0
    ? ((direct.estimated_cost_usd - proxy.estimated_cost_usd) / direct.estimated_cost_usd) * 100
    : null;
  const costPerCorrectSavingsPct = direct.cost_per_correct_usd > 0 && proxy.cost_per_correct_usd != null
    ? ((direct.cost_per_correct_usd - proxy.cost_per_correct_usd) / direct.cost_per_correct_usd) * 100
    : null;
  const latencyChangePct = direct.avg_latency_ms > 0
    ? ((proxy.avg_latency_ms - direct.avg_latency_ms) / direct.avg_latency_ms) * 100
    : null;
  const lines = [];

  lines.push("A/B benchmark");
  lines.push("=============");
  if (options.suite) lines.push(`Suite:       ${options.suite}`);
  lines.push(`Direct model: ${options.directModel || "unknown"}`);
  lines.push(`Proxy model:  ${options.proxyModel || "unknown"}`);
  lines.push(`Cost guard:   ${Number(options.budgetUsd || 0) > 0 ? formatUsd(options.budgetUsd) : "disabled"}`);
  if (options.maxRuntimeMs) lines.push(`Runtime guard: ${Math.round(Number(options.maxRuntimeMs) / 1000)}s`);
  lines.push("Cost basis:   estimated from normalized prompt/output tokens and model-family price classes; cached input discounted when reported");
  lines.push("");
  lines.push("Summary");
  lines.push("-------");
  lines.push("arm      runs  correct  weighted  latency_ms  prompt  cached  output  total  avg_cost    cost_group");
  lines.push(`direct   ${String(direct.runs).padEnd(5)} ${String(direct.correctness_pct + "%").padEnd(8)} ${String(direct.weighted_correctness_pct + "%").padEnd(9)} ${String(direct.avg_latency_ms).padEnd(11)} ${String(direct.avg_prompt_tokens).padEnd(7)} ${String(direct.avg_cached_input_tokens).padEnd(7)} ${String(direct.avg_completion_tokens).padEnd(7)} ${String(direct.avg_total_tokens).padEnd(6)} ${String(formatUsd(direct.avg_estimated_cost_usd)).padEnd(11)} ${direct.avg_cost_group}`);
  lines.push(`proxy    ${String(proxy.runs).padEnd(5)} ${String(proxy.correctness_pct + "%").padEnd(8)} ${String(proxy.weighted_correctness_pct + "%").padEnd(9)} ${String(proxy.avg_latency_ms).padEnd(11)} ${String(proxy.avg_prompt_tokens).padEnd(7)} ${String(proxy.avg_cached_input_tokens).padEnd(7)} ${String(proxy.avg_completion_tokens).padEnd(7)} ${String(proxy.avg_total_tokens).padEnd(6)} ${String(formatUsd(proxy.avg_estimated_cost_usd)).padEnd(11)} ${proxy.avg_cost_group}`);
  lines.push(`Latency p50/p95 direct: ${direct.latency_p50_ms}/${direct.latency_p95_ms} ms`);
  lines.push(`Latency p50/p95 proxy:  ${proxy.latency_p50_ms}/${proxy.latency_p95_ms} ms`);
  lines.push(`Warnings direct/proxy:  ${direct.warning_count}/${proxy.warning_count}`);
  lines.push("");
  lines.push("Cost comparison");
  lines.push("---------------");
  lines.push(`Direct estimated total: ${formatUsd(direct.estimated_cost_usd)}`);
  lines.push(`Proxy estimated total:  ${formatUsd(proxy.estimated_cost_usd)}`);
  lines.push(`Proxy savings:          ${formatPercent(costSavingsPct)} (${formatUsd(direct.estimated_cost_usd)} → ${formatUsd(proxy.estimated_cost_usd)})`);
  lines.push(`Cost per correct direct: ${formatUsd(direct.cost_per_correct_usd)}`);
  lines.push(`Cost per correct proxy:  ${formatUsd(proxy.cost_per_correct_usd)}`);
  lines.push(`Correctness-adjusted savings: ${formatPercent(costPerCorrectSavingsPct)}`);
  lines.push(`Proxy latency delta:    ${formatPercent(latencyChangePct)} versus direct average`);
  lines.push(`Proxy model diversity:  ${proxy.unique_model_count} models across ${proxy.unique_provider_count} providers`);
  lines.push("");
  lines.push("Provider mix");
  lines.push("------------");
  lines.push(`direct: ${formatMap(direct.providers)}`);
  lines.push(`proxy:  ${formatMap(proxy.providers)}`);
  lines.push("");
  lines.push("Provider fairness");
  lines.push("-----------------");
  lines.push(`direct: ${formatFairness(direct.provider_fairness)}`);
  lines.push(`proxy:  ${formatFairness(proxy.provider_fairness)}`);
  lines.push("");
  lines.push("Memory and compaction");
  lines.push("---------------------");
  lines.push(`direct: memory_tokens=${direct.memory.injected_tokens} recall_retries=${direct.memory.recall_retries} archive_refs=${direct.compaction.archive_refs} ai_summaries=${direct.compaction.ai_summary_uses}`);
  lines.push(`proxy:  memory_tokens=${proxy.memory.injected_tokens} recall_retries=${proxy.memory.recall_retries} archive_refs=${proxy.compaction.archive_refs} ai_summaries=${proxy.compaction.ai_summary_uses}`);
  lines.push("");
  lines.push("Model mix");
  lines.push("---------");
  lines.push(`direct: ${formatMap(direct.models)}`);
  lines.push(`proxy:  ${formatMap(proxy.models)}`);
  lines.push("");
  lines.push("ASCII charts");
  lines.push("------------");
  lines.push(`Latency      direct |${asciiBar(direct.avg_latency_ms, maxLatency)}| ${direct.avg_latency_ms} ms`);
  lines.push(`Latency      proxy  |${asciiBar(proxy.avg_latency_ms, maxLatency)}| ${proxy.avg_latency_ms} ms`);
  lines.push(`Correctness  direct |${asciiBar(direct.weighted_correctness_pct, 100)}| ${direct.weighted_correctness_pct}%`);
  lines.push(`Correctness  proxy  |${asciiBar(proxy.weighted_correctness_pct, 100)}| ${proxy.weighted_correctness_pct}%`);
  lines.push(`Tokens       direct |${asciiBar(direct.avg_total_tokens, maxTokens)}| ${direct.avg_total_tokens}`);
  lines.push(`Tokens       proxy  |${asciiBar(proxy.avg_total_tokens, maxTokens)}| ${proxy.avg_total_tokens}`);
  lines.push(`Avg cost     direct |${asciiBar(direct.avg_estimated_cost_usd, maxCost)}| ${formatUsd(direct.avg_estimated_cost_usd)}`);
  lines.push(`Avg cost     proxy  |${asciiBar(proxy.avg_estimated_cost_usd, maxCost)}| ${formatUsd(proxy.avg_estimated_cost_usd)}`);
  lines.push("");
  lines.push("Cases");
  lines.push("-----");
  for (const run of summary.runs) {
    const status = run.ok ? "ok" : "fail";
    lines.push(`${run.arm.padEnd(6)} ${String(run.case_id || "").padEnd(20)} c${run.complexity || 1} ${status.padEnd(4)} ${String(run.latency_ms).padStart(5)}ms ${String(run.usage?.total_tokens || 0).padStart(5)}tok ${formatUsd(run.estimated_cost_usd)} ${run.provider || "unknown"} ${run.actual_model || ""}`);
  }

  return `${lines.join("\n")}\n`;
}

module.exports = {
  DEFAULT_CASES,
  OPUS_CASES,
  ALL_CASES,
  DEFAULT_PRICE_TABLE,
  asciiBar,
  estimateCostUsd,
  extractContent,
  extractContentFromSse,
  gradeOutput,
  parseJsonCandidate,
  renderReport,
  summarizeRuns,
  usageFromResponse,
};
