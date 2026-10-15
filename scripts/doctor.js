#!/usr/bin/env node
"use strict";
async function doctor({
  baseUrl = "http://127.0.0.1:" + (process.env.LLM_PROXY_PORT || "18900"),
  fetchFn = fetch,
  probe = false,
  model,
} = {}) {
  const get = async (url) => {
    const r = await fetchFn(baseUrl + url, {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " at " + url);
    return r.json();
  };
  const health = await get("/health"),
    models = await get("/v1/models"),
    orchestration = await get("/v1/orchestration");
  const report = {
    runtime: health.status,
    configuredRoutes: health.providers?.active || 0,
    listedModels: models.data?.length || 0,
    authentication: "not proven by configuration",
    inference: "unverified",
    orchestration,
    endpoint: baseUrl,
  };
  if (probe) {
    if (!model) throw new Error("--probe requires explicit --model");
    const r = await fetchFn(baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LLM-Proxy-Task-ID": "doctor-" + Date.now(),
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply OK." }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    report.inference = r.ok ? "verified" : "failed";
    report.probeStatus = r.status;
  }
  return report;
}
if (require.main === module) {
  const i = process.argv.indexOf("--model");
  doctor({
    probe: process.argv.includes("--probe"),
    model: i >= 0 ? process.argv[i + 1] : undefined,
  })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      if (!r.configuredRoutes || r.inference === "failed") process.exitCode = 2;
    })
    .catch((e) => {
      console.error(
        JSON.stringify({ runtime: "unavailable", error: e.message }),
      );
      process.exitCode = 1;
    });
}
module.exports = { doctor };
