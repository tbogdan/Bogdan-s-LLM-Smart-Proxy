"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const routing = require("../lib/routing");
const state = require("../lib/state");
const providerAdapters = require("../lib/provider-adapters");

class FakeClientResponse {
  constructor() {
    this.status = null;
    this.headers = null;
    this.chunks = [];
    this.ended = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  }

  end() {
    this.ended = true;
  }
}

function withNoScoreWrites(fn) {
  const originalScores = state.scores;
  const originalWriteFileSync = fs.writeFileSync;
  const originalSessionStats = { ...state.sessionStats };
  state.scores = {};
  for (const key of Object.keys(state.sessionStats)) delete state.sessionStats[key];
  fs.writeFileSync = () => {};
  routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      fs.writeFileSync = originalWriteFileSync;
      state.scores = originalScores;
      for (const key of Object.keys(state.sessionStats)) delete state.sessionStats[key];
      Object.assign(state.sessionStats, originalSessionStats);
    });
}

function trackSessionTokens(sessionId, inputTokens, outputTokens, providerName) {
  if (!state.sessionStats[sessionId]) {
    state.sessionStats[sessionId] = { totalInputTokens: 0, totalOutputTokens: 0, requests: 0, startTime: Date.now(), lastRequest: 0, providers: {} };
  }
  const session = state.sessionStats[sessionId];
  session.totalInputTokens += inputTokens;
  session.totalOutputTokens += outputTokens || 0;
  if (inputTokens > 0) session.requests += 1;
  if (providerName) {
    if (!session.providers[providerName]) session.providers[providerName] = { input: 0, output: 0, requests: 0 };
    session.providers[providerName].input += inputTokens;
    session.providers[providerName].output += outputTokens || 0;
    if (inputTokens > 0) session.providers[providerName].requests += 1;
  }
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1/chat/completions`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function streamProvider(url) {
  return {
    name: "Stream-Test",
    model: "stream-model",
    url,
    key: "test",
    protocol: "openai",
    caps: ["tools", "coding"],
    context: 131072,
    tier: 1,
  };
}

function requestBody() {
  return {
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "edit", parameters: { type: "object" } } }],
  };
}

test("routeStreamToProvider rejects empty streams before sending client headers", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await assert.rejects(
        routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes),
        (err) => err.statusCode === 502 && err.headersSent === false,
      );
      assert.equal(clientRes.status, null);
      assert.equal(clientRes.ended, false);
    });
  });
});

test("routeStreamToProvider filters telemetry SSE chunks after stream commit", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of ["hello ", "from ", "stream"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ inference_id: "abc", completion_tokens_per_sec: 10, producer: "telemetry" })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      assert.equal(clientRes.status, 200);
      assert.equal(clientRes.ended, true);
      assert.equal(clientRes.chunks.join("").includes("completion_tokens_per_sec"), false);
    });
  });
});

test("routeStreamToProvider strips private difficulty marker from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_TASK_DIFFICULTY level=1 effort=none speed=5 reason=identity\n",
        "Project LLM ",
        "Smart Proxy.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("LLM_PROXY_TASK_DIFFICULTY"), false);
      assert.equal(output.includes("Project LLM "), true);
      assert.equal(output.includes("Smart Proxy."), true);
    });
  });
});

test("routeStreamToProvider strips compact slash-level marker split across chunks", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_TASK_DIFFICULTY level=4",
        "/5 reason=major_architecture_pivot\n",
        "I will inspect the routing architecture.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("LLM_PROXY_TASK_DIFFICULTY"), false);
      assert.equal(output.includes("/5 reason=major_architecture_pivot"), false);
      assert.equal(output.includes("I will inspect the routing architecture."), true);
    });
  });
});

test("routeStreamToProvider preserves attached uppercase content after stream marker", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_TASK_DIFFICULTY level=1 effort=none speed=5 reason=identity_replyProject ",
        "LLM ",
        "Smart Proxy.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("LLM_PROXY_TASK_DIFFICULTY"), false);
      assert.equal(output.includes("Project "), true);
    });
  });
});

test("routeStreamToProvider logs and tracks cached input tokens from streaming usage", async () => {
  await withNoScoreWrites(async () => {
    const originalLog = state.log;
    const logs = [];
    state.log = (message) => logs.push(message);
    routing.init({ sendError: () => {}, trackSessionTokens });
    try {
      await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "cached " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: "usage" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 8,
            total_tokens: 128,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        })}\n\n`);
        res.end();
      }, async (url) => {
        const clientRes = new FakeClientResponse();
        const req = requestBody();

        await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

        const sid = require("../lib/memory").getSession(req.messages).id;
        assert.equal(logs.some((line) => /cached=80/.test(line)), true);
        assert.equal(state.sessionStats[sid].cachedInputTokens, 80);
      });
    } finally {
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("routeStreamToProvider strips hidden memory markers from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "LLM_PROXY_MEMORY v=1 op=user_correction target=f_123 type=preference confidence=high\nProject " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Proxy." }, finish_reason: "stop" }] })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("LLM_PROXY_MEMORY"), false);
      assert.equal(output.includes("Project "), true);
      assert.equal(output.includes("Proxy."), true);
    });
  });
});

test("routeStreamToProvider rejects invalid streamed tool calls before sending client headers", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      };

      await assert.rejects(
        routing.routeStreamToProvider(streamProvider(url), req, clientRes),
        (err) => err.statusCode === 422 && /missing required field "command"/.test(err.error?.message || err.message || ""),
      );
      assert.equal(clientRes.status, null);
      assert.equal(clientRes.ended, false);
    });
  });
});

test("routeStreamToProvider validates fragmented streamed tool calls before flushing", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "{\"comm" } }] }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "and\":\"pwd\"}" } }] }, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      assert.equal(clientRes.status, 200);
      assert.equal(clientRes.ended, true);
      assert.match(clientRes.chunks.join(""), /tool_calls/);
    });
  });
});

test("handleChatCompletion estimates output tokens for native streaming providers", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    routing.init({ sendError: () => {}, trackSessionTokens });
    state.PROVIDERS = [{
      name: "Native-Stream-Test",
      model: "native-stream-model",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (_provider, _body, handlers) => {
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "native stream output ".repeat(8) } }] })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      const req = {
        model: "native-stream-model",
        stream: true,
        messages: [{ role: "user", content: "Produce native stream output." }],
      };

      await routing.handleChatCompletion(req, clientRes);

      const sid = require("../lib/memory").getSession(req.messages).id;
      assert.equal(clientRes.status, 200);
      assert.ok(state.sessionStats[sid].totalOutputTokens > 0);
      assert.ok(state.sessionStats[sid].providers["Native-Stream-Test"].output > 0);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("sendAsSSE streams OpenAI content parts as text", () => {
  const clientRes = new FakeClientResponse();
  const body = JSON.stringify({
    id: "chatcmpl-test",
    model: "parts-model",
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Project " },
            { type: "text", text: "Proxy." },
          ],
        },
        finish_reason: "stop",
      },
    ],
  });

  routing.sendAsSSE(clientRes, body, streamProvider("http://127.0.0.1/v1/chat/completions"), requestBody());

  const output = clientRes.chunks.join("");
  assert.equal(clientRes.status, 200);
  assert.equal(output.includes("chat.completion.chunk"), true);
  assert.equal(output.includes("\"content\":[{\"type\":\"text\""), false);
  assert.equal(output.includes("Project "), true);
  assert.equal(output.includes("Proxy."), true);
});

test("extractSseTextForDiagnostics reads text without repeating SSE metadata", () => {
  const sse = [
    'data: {"id":"chatcmpl-windsurf","object":"chat.completion.chunk","created":1,"model":"windsurf/opus","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-windsurf","object":"chat.completion.chunk","created":1,"model":"windsurf/opus","choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-windsurf","object":"chat.completion.chunk","created":1,"model":"windsurf/opus","choices":[{"delta":{"content":"world"},"finish_reason":null}]}',
    "",
  ].join("\n");

  assert.equal(routing.extractSseTextForDiagnostics(sse), "Hello world");
});
