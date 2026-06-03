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

  end(chunk) {
    if (chunk) this.write(chunk);
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

test("routeStreamToProvider accepts text-only reports when tool_choice auto is optional", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "Root cause: ",
        "tool_choice auto is optional, ",
        "so this diagnostic report is valid.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), {
        ...requestBody(),
        tool_choice: { type: "auto" },
        messages: [
          { role: "user", content: "Read the logs." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"logs.txt\"}" } }],
          },
          { role: "tool", tool_call_id: "call_read", content: "NO-TOOLS-STREAM-BUFFERED sample" },
          { role: "user", content: "Explain the root cause from these logs." },
        ],
      }, clientRes);

      assert.equal(clientRes.status, 200);
      assert.equal(clientRes.ended, true);
      assert.match(clientRes.chunks.join(""), /diagnostic report is valid/);
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

test("routeStreamToProvider strips split sentinel effort markers from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_INTERNAL_ROUTING eff",
        "ort=low speed=3 reason=followup\n",
        "Local test-vm yes; run bash scripts/startup.sh",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("effort=low"), false);
      assert.equal(output.includes("reason=followup"), false);
      assert.equal(output.includes("Local test-vm yes"), true);
    });
  });
});

test("routeStreamToProvider holds incomplete reason slugs across chunks", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_INTERNAL_ROUTING effort=high speed=4 reason=review",
        "-and-broader-verify",
        "-response\n",
        "Am verificat si restul.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("review-and-broader-verify"), false);
      assert.equal(output.includes("-response"), false);
      assert.equal(output.includes("Am verificat si restul."), true);
    });
  });
});

test("routeStreamToProvider strips orphan slug tails after private markers", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_INTERNAL_ROUTING effort=high speed=4 reason=inventory\n",
        "_needed\n",
        "-current-diff\n",
        "\"-current-diff]\n",
        "Reading changed paths around inventory flow.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("_needed"), false);
      assert.equal(output.includes("-current-diff"), false);
      assert.equal(output.includes("Reading changed paths"), true);
    });
  });
});

test("routeStreamToProvider strips split legacy bare effort markers from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "eff",
        "ort=low speed=4 reason=playwright_smoke\n",
        "Playwright smoke passed.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("effort=low"), false);
      assert.equal(output.includes("reason=playwright_smoke"), false);
      assert.equal(output.includes("Playwright smoke passed."), true);
    });
  });
});

test("routeStreamToProvider strips split sentinel speed-only private markers from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_INTERNAL_ROUTING spe",
        "ed=4 reason=commit_changes\n",
        "Production is restarted and verified.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("speed=4"), false);
      assert.equal(output.includes("reason=commit_changes"), false);
      assert.equal(output.includes("Production is restarted"), true);
    });
  });
});

test("routeStreamToProvider strips split legacy bare speed-only markers from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "spe",
        "ed=4 reason=commit_changes\n",
        "Committed changes.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("speed=4"), false);
      assert.equal(output.includes("reason=commit_changes"), false);
      assert.equal(output.includes("Committed changes."), true);
    });
  });
});

test("routeStreamToProvider reports inert continuation text before IDE-visible success", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of ["Con", "tinu", "ing."]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        messages: [{ role: "user", content: "Continue implementing the change." }],
      };

      await assert.rejects(
        routing.routeStreamToProvider(streamProvider(url), req, clientRes),
        (err) => err.statusCode === 422 && err.headersSent === false && err.hiddenContinuation === true,
      );
      assert.equal(clientRes.status, null);
      assert.equal(clientRes.ended, false);
    });
  });
});

test("routeStreamToProvider treats file-check Go prelude as hidden continuation", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "Local screenshot 131KB, prod 179KB. Still different size. ",
        "Check global CSS and tailwind config for environment-specific flags.\n\n",
        "apps/web/tailwind.config.ts\napps/web/src/app/globals.css\napps/web/src/app/layout.tsx\nGo.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        messages: [{ role: "user", content: "continue implementing the visual comparison fix" }],
      };

      await assert.rejects(
        routing.routeStreamToProvider(streamProvider(url), req, clientRes),
        (err) => err.statusCode === 422 && err.headersSent === false && err.hiddenContinuation === true,
      );
      assert.equal(clientRes.status, null);
      assert.equal(clientRes.ended, false);
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

test("routeStreamToProvider strips trailing private assessment metadata", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "I've cleared the TypeScript errors.\n\n",
        "LLM_PROXY_INTERNAL_ROUTING effort=medium speed=4 reason=typescript-fixes",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("I've cleared the TypeScript errors."), true);
      assert.equal(output.includes("effort=medium"), false);
      assert.equal(output.includes("typescript-fixes"), false);
    });
  });
});

test("routeStreamToProvider strips split trailing private assessment metadata", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "Updated docs/chaos-features.md.\n\n",
        "LLM_PROXY_INTERNAL_ROUTING effort=low speed=4",
        " reason=monitoring",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("Updated docs/chaos-features.md."), true);
      assert.equal(output.includes("effort=low"), false);
      assert.equal(output.includes("speed=4"), false);
      assert.equal(output.includes("reason=monitoring"), false);
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

test("routeStreamToProvider strips malformed historical tool invocation lines from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Am actualizat catalogul.\\n" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Historical tool invocation (already executed\\\": Edit {\\\"file_path\\\":\\\"/tmp/catalog.py\\\"}" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), {
        model: "auto-text",
        stream: true,
        messages: [{ role: "user", content: "Ce ai schimbat?" }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("Am actualizat catalogul."), true);
      assert.equal(output.includes("Historical tool invocation"), false);
      assert.equal(output.includes("already executed"), false);
    });
  });
});

test("routeStreamToProvider strips trailing hidden memory markers after visible content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "I saved the routing fix.\n\n",
        "[LLM_PROXY_MEMORY v=1 op=save_fact target=routing_markers type=decision confidence=high]",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("I saved the routing fix."), true);
      assert.equal(output.includes("LLM_PROXY_MEMORY"), false);
      assert.equal(output.includes("routing_markers"), false);
    });
  });
});

test("routeStreamToProvider strips split trailing hidden memory markers after visible content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "I saved the routing fix.\n\n",
        "[LLM_PROXY_MEMORY v=1 op=save_fact",
        " target=routing_markers type=decision confidence=high]",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("I saved the routing fix."), true);
      assert.equal(output.includes("LLM_PROXY_MEMORY"), false);
      assert.equal(output.includes("routing_markers"), false);
    });
  });
});

test("routeStreamToProvider converts streamed imitated tool-call text before flushing", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "Tool call: Read {\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}",
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        tools: [{
          type: "function",
          function: {
            name: "Read",
            parameters: {
              type: "object",
              required: ["file_path"],
              properties: {
                file_path: { type: "string" },
                offset: { type: "number" },
                limit: { type: "number" },
              },
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"Read"/);
      assert.doesNotMatch(output, /Tool call:/);
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

test("handleChatCompletion converts native imitated tool-call text before IDE-visible success", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.PROVIDERS = [{
      name: "Native-Tool-Text-Test",
      model: "native-tool-text-model",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (_provider, _body, handlers) => {
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "Tool call: Read {\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}",
          },
          finish_reason: null,
        }],
      })}\n\n`);
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "native-tool-text-model",
        stream: true,
        messages: [{ role: "user", content: "Read README." }],
        tools: [{
          type: "function",
          function: {
            name: "Read",
            parameters: {
              type: "object",
              required: ["file_path"],
              properties: {
                file_path: { type: "string" },
                offset: { type: "number" },
                limit: { type: "number" },
              },
            },
          },
        }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"Read"/);
      assert.doesNotMatch(output, /Tool call:/);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion rejects empty native streams before IDE-visible success", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.PROVIDERS = [{
      name: "Native-Empty-Test",
      model: "native-empty-model",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (_provider, _body, handlers) => {
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "native-empty-model",
        stream: true,
        messages: [{ role: "user", content: "continue" }],
      }, clientRes);

      assert.equal(clientRes.status, 502);
      assert.equal(clientRes.ended, true);
      assert.doesNotMatch(clientRes.chunks.join(""), /chat\.completion\.chunk/);
      assert.match(clientRes.chunks.join(""), /empty native stream|Provider error/);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion accepts native text-only reports when tool_choice auto is optional", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Text-Report",
      model: "windsurf/native-text-report",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (_provider, _body, handlers) => {
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "Root cause: tool_choice auto is optional, so this diagnostic report is a valid final answer." }, finish_reason: null }] })}\n\n`);
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "auto-coding",
        stream: true,
        tool_choice: { type: "auto" },
        messages: [
          { role: "user", content: "Read the logs." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"logs.txt\"}" } }],
          },
          { role: "tool", tool_call_id: "call_read", content: "NO-TOOLS-NATIVE-BUFFERED sample" },
          { role: "user", content: "Explain the root cause from these logs." },
        ],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /Root cause: tool_choice auto is optional/);
      assert.doesNotMatch(output, /Provider error|text-only response with tools available/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
      else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion still rejects native text-only output when tool_choice is required", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Required-Tool",
      model: "windsurf/native-required-tool",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (_provider, _body, handlers) => {
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "I will answer in text instead of calling the required tool." }, finish_reason: null }] })}\n\n`);
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "auto-coding",
        stream: true,
        tool_choice: "required",
        messages: [{ role: "user", content: "Use the Read tool." }],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 503);
      assert.doesNotMatch(output, /I will answer in text/);
      assert.match(output, /All providers in group failed|Provider error/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
      else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion adds hidden continue user message after native inert continuation", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    const calls = [];
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [
      {
        name: "Native-Stall-Continuation",
        model: "windsurf/native-stall",
        protocol: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 131072,
        tier: 1,
      },
      {
        name: "Native-Action-Fallback",
        model: "windsurf/native-action",
        protocol: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 131072,
        tier: 1,
      },
    ];
    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((m) => m.role === "user") || [];
      calls.push({ provider: provider.name, userCount: userMessages.length, lastUser: userMessages.at(-1)?.content });
      if (provider.name === "Native-Stall-Continuation" && calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "Continuing." }, finish_reason: null }] })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "auto-coding",
        stream: true,
        messages: [{ role: "user", content: "continue" }],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { provider: "Native-Stall-Continuation", userCount: 1, lastUser: "continue" },
        { provider: "Native-Stall-Continuation", userCount: 2, lastUser: "continue" },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("Continuing."), false);
      assert.equal(output.includes("\"tool_calls\""), true);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion adds hidden continue after native file-check Go prelude", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const calls = [];
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [
      {
        name: "Native-Prelude-Continuation",
        model: "windsurf/native-prelude",
        protocol: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 131072,
        tier: 1,
      },
    ];
    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((m) => m.role === "user") || [];
      calls.push({ provider: provider.name, userCount: userMessages.length, lastUser: userMessages.at(-1)?.content });
      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: [
          "Local screenshot 131KB, prod 179KB. Still different size.",
          "",
          "Check global CSS and tailwind config for environment-specific flags. Then check layout for any dynamic blocks.",
          "",
          "apps/web/tailwind.config.ts",
          "apps/web/src/app/globals.css",
          "apps/web/src/app/layout.tsx",
          "Go.",
        ].join("\n") }, finish_reason: null }] })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"apps/web/src/app/globals.css\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "auto-coding",
        stream: true,
        messages: [{ role: "user", content: "continue implementing the visual comparison fix" }],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { provider: "Native-Prelude-Continuation", userCount: 1, lastUser: "continue implementing the visual comparison fix" },
        { provider: "Native-Prelude-Continuation", userCount: 2, lastUser: "continue" },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("Local screenshot"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion continues native active tool work after short text-only progress", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    const calls = [];
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Short-Progress",
      model: "windsurf/native-short-progress",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
      cost_group: 2,
      quality_group: 3,
      speed_group: 5,
      thinking_effort: "low",
    }];
    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((m) => m.role === "user") || [];
      calls.push({ provider: provider.name, userCount: userMessages.length, lastUser: userMessages.at(-1)?.content });
      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({
          choices: [{
            delta: { content: "Found the vars writer; dry-run only rendered, so live run still needs execution." },
            finish_reason: null,
          }],
        })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_live",
              type: "function",
              function: { name: "Bash", arguments: "{\"command\":\"python3 -m chaosctl.cli run reports/startup-experiment.yml\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "auto-coding",
        stream: true,
        messages: [
          { role: "user", content: "Run reports/startup-experiment.yml live, not dry-run; it should take at least the test duration." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_read", type: "function", function: { name: "Bash", arguments: "{\"command\":\"cat reports/startup-experiment.yml\"}" } }],
          },
          { role: "tool", tool_call_id: "call_read", content: "experiment:\\n  type: vz-start-stop\\n  pause_seconds: 300" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_vars", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls reports/*.vars.yml\"}" } }],
          },
          { role: "tool", tool_call_id: "call_vars", content: "(eval):1: no matches found: reports/*.vars.yml" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_grep", type: "function", function: { name: "Bash", arguments: "{\"command\":\"grep -n _write_vars chaosctl/run_cmd.py\"}" } }],
          },
          { role: "tool", tool_call_id: "call_grep", content: "169:def _write_vars(...):\\n174:path = report_dir / f\"{name}-{ts}-vars.yml\"" },
        ],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(calls.length, 2);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("dry-run only rendered"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.equal(output.includes("chaosctl.cli run reports/startup-experiment.yml"), true);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
      else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion cools native Windsurf invalid_argument streams", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.PROVIDERS = [{
      name: "Windsurf-Native-InvalidArgument",
      model: "native-invalid-model",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async () => {
      const error = new Error("an internal error occurred");
      error.status = 502;
      error.body = '{"error":{"code":"invalid_argument","message":"an internal error occurred"}}';
      throw error;
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "native-invalid-model",
        stream: true,
        messages: [{ role: "user", content: "continue" }],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes);

      const score = state.scores["Windsurf-Native-InvalidArgument"];
      assert.equal(clientRes.status, 502);
      assert.equal(score.failures, 1);
      assert.equal(score.cooldown_reason, "windsurf invalid_argument");
      assert.equal(score.cooldown_until > Date.now() + 50 * 60_000, true);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion cools same Windsurf model-class peers after zero-chunk stream timeout", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.PROVIDERS = [
      {
        name: "Windsurf-SonnetThinking-Timeout",
        model: "windsurf/claude-sonnet-4-6-thinking",
        upstream_model: "claude-sonnet-4-6-thinking",
        protocol: "windsurf",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 200000,
        tier: 1,
      },
      {
        name: "Windsurf-Sonnet-Timeout-Peer",
        model: "windsurf/claude-sonnet-4.6",
        upstream_model: "claude-sonnet-4.6",
        protocol: "windsurf",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 200000,
        tier: 1,
      },
      {
        name: "Windsurf-GPT54Mini-Timeout-Other",
        model: "windsurf/gpt-5-4-mini-high",
        upstream_model: "gpt-5-4-mini-high",
        protocol: "windsurf",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 200000,
        tier: 1,
      },
    ];
    providerAdapters.routeNativeStream = async () => {
      const error = new Error("Windsurf Connect stream timeout after 120000ms");
      error.status = 502;
      throw error;
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "windsurf/claude-sonnet-4-6-thinking",
        stream: true,
        messages: [{ role: "user", content: "continue" }],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes);

      const failed = state.scores["Windsurf-SonnetThinking-Timeout"];
      const peer = state.scores["Windsurf-Sonnet-Timeout-Peer"];
      const other = state.scores["Windsurf-GPT54Mini-Timeout-Other"];

      assert.equal(clientRes.status, 502);
      assert.match(failed.cooldown_reason, /zero-chunk native stream timeout/);
      assert.match(peer.cooldown_reason, /peer zero-chunk native stream timeout/);
      assert.equal(peer.cooldown_until > Date.now() + 5 * 60_000, true);
      assert.equal(other?.cooldown_reason, undefined);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion flattens compacted tool history before Windsurf native request", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Windsurf-ClaudeSonnet46Thinking",
      model: "windsurf/claude-sonnet-4-6-thinking",
      protocol: "windsurf",
      family: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 200000,
      tier: 1,
      cost_group: 3,
      quality_group: 4,
      speed_group: 4,
      thinking_effort: "high",
    }];
    const nativeCalls = [];
    let nativeBody = null;
    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      nativeCalls.push(provider.name);
      nativeBody = body;
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_next",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };

    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "auto-coding",
        stream: true,
        _llmProxyCompactedContext: true,
        _llmProxyDifficulty: {
          level: 4,
          taskLevel: 4,
          contextLevel: 4,
          costTarget: 3,
          thinkingLevel: 4,
          stepShape: { gate: "run_behavior" },
        },
        messages: [
          { role: "user", content: "Read the file." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
          },
          { role: "tool", tool_call_id: "call_read", content: "README contents" },
          { role: "user", content: "continue" },
        ],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes, { internal: true });

      const serialized = JSON.stringify(nativeBody.messages);
      assert.deepEqual(nativeCalls, ["Windsurf-ClaudeSonnet46Thinking"]);
      assert.equal(nativeBody.messages.some((msg) => msg.role === "tool"), false);
      assert.equal(nativeBody.messages.some((msg) => msg.tool_calls?.length > 0), false);
      assert.doesNotMatch(serialized, /Tool call:/);
      assert.match(serialized, /Historical tool invocation \(already executed\): Read/);
      assert.match(serialized, /Historical tool result \(already observed\) for Read/);
      assert.match(clientRes.chunks.join(""), /tool_calls/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
      else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
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
