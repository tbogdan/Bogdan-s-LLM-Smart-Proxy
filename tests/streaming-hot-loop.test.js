"use strict";

// Regression test for the streaming hot loop that wedged the event loop at
// 98% CPU (no /health response) on long tool-heavy streams: per-chunk hold
// and stall analysis re-ran the difficulty assessment and full-content tool
// schema scans on every chunk. The stream below must complete quickly.

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");

function syntheticReqBody(toolCount) {
  const tools = [];
  for (let i = 0; i < toolCount; i += 1) {
    tools.push({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `test tool ${i}`,
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: { type: "string" },
          },
        },
      },
    });
  }
  const messages = [{ role: "user", content: "summarize the workspace" }];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: "assistant", content: `progress note ${i} ${"x".repeat(200)}` });
    messages.push({ role: "user", content: `tool result ${i} ${"y".repeat(200)}` });
  }
  return { model: "gemini/gemini-3.8-flash", messages, tools, stream: true };
}

test("tool-heavy long stream completes without wedging the event loop", { timeout: 60000 }, async () => {
  const routing = require("../lib/routing");
  const providers = require("../lib/providers");
  const config = { providers: [{ name: "Gemini-Test", url: "https://generativelanguage.example.com/v1beta/openai/chat/completions", key_env: "TEST_KEY", model: "gemini/gemini-3.8-flash", family: "gemini", protocol: "openai", upstream_model: "gemini-3.8-flash", alive: true }] };
  const { providers: all } = providers.hydrateProvidersFile(config);
  const provider = all[0];

  const N = 2000;
  const originalRequest = https.request;
  https.request = (...args) => {
    const cb = args.find((a) => typeof a === "function");
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        let i = 0;
        const timer = setInterval(() => {
          for (let k = 0; k < 100 && i < N; k += 1, i += 1) {
            res.emit("data", Buffer.from(`data: {"choices":[{"delta":{"content":"word${i} "},"index":0}]}\n\n`));
          }
          if (i >= N) {
            clearInterval(timer);
            res.emit("data", Buffer.from(`data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n`));
            res.emit("data", Buffer.from("data: [DONE]\n\n"));
            res.emit("end");
          }
        }, 0);
      });
    };
    req.destroy = () => {};
    req.setTimeout = () => {};
    req.on = req.addListener.bind(req);
    return req;
  };
  try {
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const fakeRes = {
        writeHead() {},
        write() {},
        end() { resolve(); },
      };
      routing.routeStreamToProvider(provider, syntheticReqBody(752), fakeRes).then(resolve, reject);
      setTimeout(() => reject(new Error("stream did not complete in time (event loop wedged?)")), 45000).unref?.();
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30000, `stream took ${elapsed}ms, expected well under 30s`);
  } finally {
    https.request = originalRequest;
  }
});
