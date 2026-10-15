#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createContextStore } = require("../lib/context-store");
const { createContextOptimizer } = require("../lib/context-optimizer");
function offlineReport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-efficiency-"));
  const store = createContextStore({ dataDir: dir });
  try {
    const original =
      "INFO worker ready\n".repeat(1000) +
      "FATAL AUTH_MIDDLEWARE token expired\n";
    const messages = [
      {
        role: "tool",
        name: "logs",
        tool_call_id: "fixture",
        content: original,
      },
    ];
    const result = createContextOptimizer({ store }).prepare({
      taskKey: "fixture",
      messages,
      retrievalAvailable: true,
    });
    const optimized = result.messages[0].content;
    const arm = (text) => ({
      bytes: Buffer.byteLength(text),
      estimatedInputTokens: Math.ceil(text.length / 4),
      tokenEvidence: "character heuristic, not provider tokenizer",
      requiredFactRetained: text.includes(
        "FATAL AUTH_MIDDLEWARE token expired",
      ),
    });
    const fixtures = [
      {
        id: "small-code",
        text: "function add(a,b) { return a+b; }",
        fact: "return a+b",
      },
      {
        id: "exact-diff",
        text:
          "diff --git a/a.js b/a.js\n@@ -1 +1 @@\n" +
          "-old\n+new\n".repeat(300),
        fact: "-old\n+new",
      },
      {
        id: "structured-json",
        text: JSON.stringify(
          {
            rows: Array.from({ length: 100 }, (_, i) => ({
              id: i,
              result: "ready",
            })),
            required: "AUTH_FAILURE",
          },
          null,
          4,
        ),
        fact: "AUTH_FAILURE",
      },
      {
        id: "signed-output",
        text: "signature: exact-opaque-bytes\n" + "signed-data\n".repeat(300),
        fact: "signature: exact-opaque-bytes",
      },
      {
        id: "long-tool-loop",
        text: original,
        fact: "FATAL AUTH_MIDDLEWARE token expired",
      },
    ].map((f) => {
      const result = createContextOptimizer({ store }).prepare({
        taskKey: "fixture-" + f.id,
        messages: [{ role: "tool", tool_call_id: "fixture", content: f.text }],
        retrievalAvailable: true,
      });
      const output = result.messages[0].content;
      return {
        id: f.id,
        beforeBytes: Buffer.byteLength(f.text),
        afterBytes: Buffer.byteLength(output),
        requiredFactRetained: output.includes(f.fact),
        originalRecoverable: result.refs.length
          ? store
              .get({ taskKey: "fixture-" + f.id, ref: result.refs[0].ref })
              .toString() === f.text
          : output === f.text,
      };
    });
    return {
      observedAt: new Date().toISOString(),
      fixtures,
      fixture: "repetitive synthetic log with diagnostic outlier",
      qualityEvidence:
        "offline content invariants; model completion quality unverified",
      costSavedUsd: null,
      arms: {
        passthrough: arm(original),
        legacyPreviewSimulation: {
          ...arm(original.slice(0, 100)),
          note: "Simulation of the former short-preview policy, not a full source baseline run",
        },
        stableCache: {
          ...arm(original),
          note: "Same payload; real cache benefit requires upstream usage",
        },
        optimized: {
          ...arm(optimized),
          originalRecoverable:
            store
              .get({ taskKey: "fixture", ref: result.refs[0].ref })
              .toString() === original,
        },
      },
      limitations: [
        "No live model calls.",
        "A reversible original is not proof of model answer quality.",
        "Dollar and subscription-credit savings remain unverified.",
      ],
    };
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function liveReport({
  baseUrl,
  model,
  maxRequests = 2,
  maxOutputTokens = 128,
}) {
  if (!model || !baseUrl)
    throw new Error("Live mode requires explicit --model and --base-url");
  if (maxRequests !== 2 || maxOutputTokens > 128 || maxOutputTokens < 1)
    throw new Error(
      "Live comparison is exactly 2 requests with at most 128 output tokens each",
    );
  const text =
    "INFO worker ready\n".repeat(200) + "FATAL AUTH_MIDDLEWARE token expired\n";
  const runs = [];
  for (const optimize of ["off", "on"]) {
    const start = Date.now();
    const r = await fetch(baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LLM-Proxy-Task-ID": "efficiency-" + optimize + "-" + Date.now(),
        "X-LLM-Proxy-Optimize": optimize,
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        tools: [
          {
            type: "function",
            function: {
              name: "read_logs",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        messages: [
          {
            role: "user",
            content: "Which component failed and why? Answer briefly.",
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "read_fixture",
                type: "function",
                function: { name: "read_logs", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "read_fixture", content: text },
        ],
      }),
    });
    const body = await r.json();
    const answer = body.choices?.[0]?.message?.content || "";
    runs.push({
      optimize,
      status: r.status,
      latencyMs: Date.now() - start,
      model: body.model || model,
      usage: body.usage || null,
      taskUsage: body.llm_proxy_usage || null,
      requiredAnswerRetained:
        /AUTH_MIDDLEWARE/i.test(answer) && /expir/i.test(answer),
    });
  }
  return {
    observedAt: new Date().toISOString(),
    mode: "bounded-live",
    runs,
    costSavedUsd: null,
    limitations: [
      "Two synthetic requests are not a representative quality benchmark.",
      "Account billing and internal retrieval usage must be reviewed separately.",
    ],
  };
}
async function main() {
  const args = process.argv.slice(2),
    arg = (k, d) => {
      const i = args.indexOf(k);
      return i < 0 ? d : args[i + 1];
    };
  const report = args.includes("--live")
    ? await liveReport({
        baseUrl: arg("--base-url"),
        model: arg("--model"),
        maxOutputTokens: Number(arg("--max-output-tokens", 128)),
      })
    : offlineReport();
  const output = arg("--output");
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { offlineReport, liveReport };
