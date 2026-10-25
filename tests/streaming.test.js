"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const routing = require("../lib/routing");
const state = require("../lib/state");
const scoring = require("../lib/scoring");
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

test("native entry point uses OpenAI validation after task runtime swaps provider", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    }, async (url) => {
      const selected = streamProvider(url);
      const clientRes = new FakeClientResponse();
      const runtime = {
        beforeDispatch: async () => selected,
        recordFailure: async () => {},
        retryable: () => false,
      };
      await require("../lib/task-context").run({ runtime }, async () => {
        await assert.rejects(
          routing.routeNativeStreamToProvider(
            { name: "Unavailable-Claude", protocol: "anthropic" }, requestBody(), clientRes,
          ),
          (err) => err.statusCode === 502 && err.headersSent === false &&
            !String(err.body).includes("Unsupported native streaming"),
        );
      });
      assert.equal(clientRes.status, null);
      assert.equal(clientRes.ended, false);
    });
  });
});

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

test("routeStreamToProvider treats preflush stream aborts as transient transport errors", async () => {
  await withNoScoreWrites(async () => {
    const originalLog = state.log;
    const logs = [];
    state.log = (message) => logs.push(String(message));
    try {
      await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "thinking" } }] })}\n\n`);
        setImmediate(() => res.destroy(new Error("aborted")));
      }, async (url) => {
        const clientRes = new FakeClientResponse();

        await assert.rejects(
          routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes),
          (err) => err.headersSent === false,
        );

        assert.equal(clientRes.status, null);
        assert.equal(state.scores["Stream-Test"]?.last_error || null, null);
        assert.doesNotMatch(logs.join("\n"), /POSSIBLE-STALL: Stream-Test/);
        assert.match(logs.join("\n"), /STREAM-ABORT: Stream-Test .*transient transport abort/);
      });
    } finally {
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
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
        "Bogdan LLM ",
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
      assert.equal(output.includes("Bogdan LLM "), true);
      assert.equal(output.includes("Smart Proxy."), true);
    });
  });
});

test("routeStreamToProvider strips split private task status marker from streamed content", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_TASK_STATUS state=work",
        "ing reason=tests_pending\n",
        "Continuing with verification.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("LLM_PROXY_TASK_STATUS"), false);
      assert.equal(output.includes("tests_pending"), false);
      assert.equal(output.includes("Continuing with verification."), true);
    });
  });
});

test("routeStreamToProvider suppresses orphan task status reason tails after stripping the marker", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "LLM_PROXY_TASK_STATUS state=complete\n",
        "reason=all-steps-done\n",
        "Migration written and status handling confirmed.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("LLM_PROXY_TASK_STATUS"), false);
      assert.equal(output.includes("reason=all-steps-done"), false);
      assert.equal(output.includes("Migration written and status handling confirmed."), true);
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

test("routeStreamToProvider strips malformed internal routing token fragments", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "Checking console logs before the next step.\n\n",
        "LLM_PROXY_INTERNAL_ROUTINGwright\n",
        "Continuing with the account page.",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("Checking console logs"), true);
      assert.equal(output.includes("Continuing with the account page."), true);
      assert.equal(output.includes("LLM_PROXY_INTERNAL_ROUTING"), false);
      assert.equal(output.includes("ROUTINGwright"), false);
    });
  });
});

test("routeStreamToProvider turns inert tool-loop continuation into hidden continue", async () => {
  await withNoScoreWrites(async () => {
    const originalLog = state.log;
    const logs = [];
    state.log = (message) => logs.push(String(message));
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

      try {
        await assert.rejects(
          () => routing.routeStreamToProvider(streamProvider(url), req, clientRes),
          (err) => {
            assert.equal(err.hiddenContinuation, true);
            assert.equal(err.continuationText, "Continuing.");
            assert.match(err.error?.message || "", /hidden continuation: inert_continuation/);
            return true;
          },
        );
      } finally {
        state.log = originalLog;
      }
      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, null);
      assert.equal(clientRes.ended, false);
      assert.equal(output, "");
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-STREAM: Stream-Test .*output=inert_continuation/);
    });
  });
});

test("routeStreamToProvider signals hidden continue for file-check Go prelude before flushing", async () => {
  await withNoScoreWrites(async () => {
    const originalLog = state.log;
    const logs = [];
    state.log = (message) => logs.push(String(message));
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

      let err = null;
      try {
        await routing.routeStreamToProvider(streamProvider(url), req, clientRes);
      } catch (error) {
        err = error;
      } finally {
        state.log = originalLog;
      }
      assert.equal(err?.statusCode, 409);
      assert.equal(err?.hiddenContinuation, true);
      assert.equal(clientRes.status, null);
      assert.match(err?.continuationText || "", /Local screenshot/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-STREAM: Stream-Test .*output=action_prelude.*action=hidden_continue/);
    });
  });
});

test("routeStreamToProvider keeps buffering long active-work text streams until finish and hidden-continues them", async () => {
  await withNoScoreWrites(async () => {
    const originalLog = state.log;
    const logs = [];
    state.log = (message) => logs.push(String(message));
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of [
        "Okay, problems clear. ",
        "Wallet 404, broken admin scanner, bad UI, ",
        "and scanner needs manual input. ",
        "Fixing regressions first. ",
        "First, I'll restore the wallet functionality ",
        "by re-adding the necessary routes ",
        "and controller logic. ",
        "Then I'll rerun the flow and verify the UI. ",
      ]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        messages: [
          { role: "user", content: "Continue fixing the wallet and membership scanner flow end to end." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_prev", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" } }],
          },
          { role: "tool", tool_call_id: "call_prev", content: "Tests failed on wallet route." },
          { role: "user", content: "continua pana termini tot si nu te opri" },
        ],
      };

      let err = null;
      try {
        await routing.routeStreamToProvider(streamProvider(url), req, clientRes);
      } catch (error) {
        err = error;
      } finally {
        state.log = originalLog;
      }

      assert.equal(err?.statusCode, 409);
      assert.equal(err?.hiddenContinuation, true);
      assert.equal(clientRes.status, null);
      assert.equal(clientRes.chunks.join(""), "");
      assert.match(err?.continuationText || "", /Wallet 404/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-STREAM: Stream-Test .*output=premature_progress.*action=hidden_continue/);
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
        "LLM_PROXY_TASK_DIFFICULTY level=1 effort=none speed=5 reason=identity_replyBogdan ",
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
      assert.equal(output.includes("Bogdan "), true);
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
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "LLM_PROXY_MEMORY v=1 op=user_correction target=f_123 type=preference confidence=high\nBogdan " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Proxy." }, finish_reason: "stop" }] })}\n\n`);
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();

      await routing.routeStreamToProvider(streamProvider(url), requestBody(), clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(output.includes("LLM_PROXY_MEMORY"), false);
      assert.equal(output.includes("Bogdan "), true);
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

test("routeStreamToProvider strips mid-line historical tool replay when useful text remains", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "I will run it with Playwright.Historical tool invocation (already executed): exec_command {\"cmd\":\"pwd\"}",
          },
          finish_reason: "stop",
        }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /I will run it with P/);
      assert.match(output, /laywright/);
      assert.doesNotMatch(output, /Historical tool invocation/);
      assert.doesNotMatch(output, /already executed/);
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

test("routeStreamToProvider converts streamed bare tool-call text before flushing", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "exec_command {\"cmd\":\"pwd\"}",
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
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"exec_command"/);
      assert.doesNotMatch(output, /exec_command \{/);
    });
  });
});

test("routeStreamToProvider converts truncated command tool-call text before flushing", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "_command {\"cmd\":\"pwd\"}",
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
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"exec_command"/);
      assert.doesNotMatch(output, /_command \{/);
    });
  });
});

test("routeStreamToProvider canonicalizes structured _command tool calls", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_cmd",
              type: "function",
              function: { name: "_command", arguments: "{\"cmd\":\"pwd\"}" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"exec_command"/);
      assert.doesNotMatch(output, /"name":"_command"/);
    });
  });
});

test("routeStreamToProvider buffers repairable command alias streamed tool calls until canonical output", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_cmd_alias",
              type: "function",
              function: { name: "exec_command", arguments: "{\"command\":\"pwd\"}" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (url) => {
      const clientRes = new FakeClientResponse();
      const req = {
        ...requestBody(),
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /\\"cmd\\":\\"pwd\\"/);
      assert.doesNotMatch(output, /\\"command\\":\\"pwd\\"/);
    });
  });
});

test("routeStreamToProvider repairs streamed update_plan aliases before validation", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_plan",
              type: "function",
              function: {
                name: "update_plan",
                arguments: JSON.stringify({
                  steps: [
                    { text: "Inspect logs", state: "done" },
                    { text: "Patch update_plan normalization", state: "active" },
                  ],
                  note: "Keep Codex provider instead of rerouting.",
                }),
              },
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
        tools: [{
          type: "function",
          function: {
            name: "update_plan",
            parameters: {
              type: "object",
              required: ["plan"],
              properties: {
                explanation: { type: "string" },
                plan: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["step", "status"],
                    properties: {
                      step: { type: "string" },
                      status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                    },
                  },
                },
              },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"update_plan"/);
      assert.match(output, /\\"plan\\"/);
      assert.match(output, /\\"step\\":\\"Inspect logs\\"/);
      assert.match(output, /\\"status\\":\\"completed\\"/);
      assert.match(output, /\\"status\\":\\"in_progress\\"/);
      assert.doesNotMatch(output, /\\"steps\\"/);
    });
  });
});

test("routeStreamToProvider repairs empty streamed update_plan calls to a safe progress plan", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_plan_empty",
              type: "function",
              function: { name: "update_plan", arguments: "{}" },
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
        tools: [{
          type: "function",
          function: {
            name: "update_plan",
            parameters: {
              type: "object",
              required: ["plan"],
              properties: {
                plan: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["step", "status"],
                    properties: {
                      step: { type: "string" },
                      status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                    },
                  },
                },
              },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"update_plan"/);
      assert.match(output, /\\"plan\\"/);
      assert.match(output, /\\"step\\":\\"Continue active task\\"/);
      assert.match(output, /\\"status\\":\\"in_progress\\"/);
    });
  });
});

test("routeStreamToProvider repairs empty streamed TodoWrite calls from tracked tasks", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_todo_empty",
              type: "function",
              function: { name: "TodoWrite", arguments: "{}" },
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
        messages: [
          { role: "user", content: "Continue fixing wallet route and scanner dialog." },
          { role: "user", content: "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Here are the existing contents of your todo list:\n[1. [completed] Fix wallet route\n2. [in_progress] Verify scanner dialog\n3. [pending] Run end to end verification]" },
        ],
        tools: [{
          type: "function",
          function: {
            name: "TodoWrite",
            parameters: {
              type: "object",
              required: ["todos"],
              properties: {
                todos: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["content", "status", "activeForm"],
                    properties: {
                      content: { type: "string" },
                      status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                      activeForm: { type: "string" },
                    },
                  },
                },
              },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"TodoWrite"/);
      assert.match(output, /\\"todos\\"/);
      assert.match(output, /\\"content\\":\\"Fix wallet route\\"/);
      assert.match(output, /\\"status\\":\\"completed\\"/);
      assert.match(output, /\\"activeForm\\":\\"Fix wallet route\\"/);
      assert.match(output, /\\"content\\":\\"Verify scanner dialog\\"/);
      assert.match(output, /\\"status\\":\\"in_progress\\"/);
      assert.match(output, /\\"activeForm\\":\\"Verify scanner dialog\\"/);
      assert.match(output, /\\"content\\":\\"Run end to end verification\\"/);
      assert.match(output, /\\"status\\":\\"pending\\"/);
      assert.match(output, /\\"activeForm\\":\\"Run end to end verification\\"/);
    });
  });
});

test("routeStreamToProvider repairs malformed streamed TodoWrite calls with generic schema", async () => {
  await withNoScoreWrites(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_todo_malformed",
              type: "function",
              function: {
                name: "TodoWrite",
                arguments: "[{\"content\":\"Fix wallet route\",\"status\":\"completed\",}]",
              },
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
        messages: [{ role: "user", content: "Continue fixing the wallet route and keep todos updated." }],
        tools: [{
          type: "function",
          function: {
            name: "TodoWrite",
            parameters: { type: "object" },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.equal(clientRes.ended, true);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"TodoWrite"/);
      assert.match(output, /\\"todos\\"/);
      assert.match(output, /\\"content\\":\\"Fix wallet route\\"/);
      assert.match(output, /\\"status\\":\\"completed\\"/);
      assert.match(output, /\\"activeForm\\":\\"Fix wallet route\\"/);
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
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.hiddenContinuation, true);
          assert.equal(err.invalidToolRetry, true);
          assert.match(err.body || "", /hidden continuation: invalid streamed tool arguments/);
          assert.match(err.continuationMessage || "", /missing required field "command"/);
          assert.match(err.continuationMessage || "", /Bash\(command required\)/);
          return true;
        },
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

test("routeStreamToProvider repairs StructuredOutput streamed tool calls before flushing", async () => {
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
              function: { name: "StructuredOutput", arguments: "{\"summary\":\"Done\"}" },
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
        tools: [{
          type: "function",
          function: {
            name: "StructuredOutput",
            parameters: {
              type: "object",
              required: ["summary", "claims"],
              properties: {
                summary: { type: "string" },
                claims: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["text"],
                    properties: {
                      text: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        }],
      };

      await routing.routeStreamToProvider(streamProvider(url), req, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.equal(clientRes.ended, true);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"StructuredOutput"/);
      assert.match(output, /\\"summary\\":\\"Done\\"/);
      assert.match(output, /\\"claims\\":\[\]/);
    });
  });
});

test("handleChatCompletion retries OpenAI SSE bare continue during active tool work", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalCompat = state.providerCompat["OpenAI-SSE-Hidden-Continue"]
      ? { ...state.providerCompat["OpenAI-SSE-Hidden-Continue"] }
      : null;
    const requests = [];

    await withServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (requests.length === 1) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "continue" }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_next",
                type: "function",
                function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    }, async (url) => {
      state.GROUPS = { "auto-coding": "coding" };
      state.PROVIDERS = [{
        name: "OpenAI-SSE-Hidden-Continue",
        model: "openai/sse-hidden-continue",
        url,
        key: "test",
        protocol: "openai",
        caps: ["text", "coding", "tools", "thinking"],
        context: 131072,
        tier: 1,
        stream_only: true,
      }];
      scoring.getCompat("OpenAI-SSE-Hidden-Continue").stream_only = true;
      try {
        const clientRes = new FakeClientResponse();
        await routing.handleChatCompletion({
          model: "auto-coding",
          stream: true,
          _llmProxyDifficulty: {
            level: 4,
            taskLevel: 3,
            contextLevel: 4,
            taskKind: "agentic_coding",
            costTarget: 3,
            thinkingLevel: 4,
            thinkingEffort: "high",
            speedTarget: 3,
            reason: "agentic_coding",
            stepShape: { shape: "write_heavy", gate: "run_behavior" },
          },
          messages: [
            { role: "user", content: "Continue implementing the routing fix." },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_prev", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" } }],
            },
            { role: "tool", tool_call_id: "call_prev", content: "failing test output" },
          ],
          tools: [{
            type: "function",
            function: {
              name: "exec_command",
              parameters: {
                type: "object",
                required: ["cmd"],
                properties: { cmd: { type: "string" } },
                additionalProperties: false,
              },
            },
          }],
        }, clientRes, { internal: true });

        const output = clientRes.chunks.join("");
        assert.equal(clientRes.status, 200);
        assert.equal(requests.length, 2);
        assert.match(requests[1].messages.filter((message) => message.role === "user").at(-1).content, /^continue the active task\./);
        assert.match(output, /"tool_calls"/);
        assert.doesNotMatch(output, /"content":"continue"/);
      } finally {
        state.PROVIDERS = originalProviders;
        state.GROUPS = originalGroups;
        if (originalCompat) state.providerCompat["OpenAI-SSE-Hidden-Continue"] = originalCompat;
        else delete state.providerCompat["OpenAI-SSE-Hidden-Continue"];
      }
    });
  });
});

test("handleChatCompletion holds first-turn OpenAI SSE action prelude and retries with hidden continue", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalCompat = state.providerCompat["OpenAI-SSE-First-Turn-Prelude"]
      ? { ...state.providerCompat["OpenAI-SSE-First-Turn-Prelude"] }
      : null;
    const requests = [];

    await withServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (requests.length === 1) {
          for (const text of ["I'll inspect ", "lib/routing.js and ", "run the routing tests now."]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_read",
                type: "function",
                function: { name: "Read", arguments: "{\"file_path\":\"lib/routing.js\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    }, async (url) => {
      state.GROUPS = { "auto-coding": "coding" };
      state.PROVIDERS = [{
        name: "OpenAI-SSE-First-Turn-Prelude",
        model: "openai/sse-first-turn-prelude",
        url,
        key: "test",
        protocol: "openai",
        caps: ["text", "coding", "tools", "thinking"],
        context: 131072,
        tier: 1,
        stream_only: true,
      }];
      scoring.getCompat("OpenAI-SSE-First-Turn-Prelude").stream_only = true;
      try {
        const clientRes = new FakeClientResponse();
        await routing.handleChatCompletion({
          model: "auto-coding",
          stream: true,
          _llmProxyDifficulty: {
            level: 4,
            taskLevel: 4,
            contextLevel: 2,
            taskKind: "agentic_coding",
            costTarget: 3,
            thinkingLevel: 4,
            thinkingEffort: "high",
            speedTarget: 3,
            reason: "agentic_coding",
            stepShape: { shape: "write_heavy", gate: "run_behavior" },
          },
          messages: [{ role: "user", content: "Fix the routing loop issue and run the tests." }],
          tools: [{
            type: "function",
            function: {
              name: "Read",
              parameters: {
                type: "object",
                required: ["file_path"],
                properties: { file_path: { type: "string" } },
                additionalProperties: false,
              },
            },
          }],
        }, clientRes, { internal: true });

        const output = clientRes.chunks.join("");
        assert.equal(clientRes.status, 200);
        assert.equal(requests.length, 2);
        assert.match(requests[1].messages.filter((message) => message.role === "user").at(-1).content, /first incomplete step/);
        assert.match(output, /"tool_calls"/);
        assert.doesNotMatch(output, /inspect lib\/routing\.js/);
      } finally {
        state.PROVIDERS = originalProviders;
        state.GROUPS = originalGroups;
        if (originalCompat) state.providerCompat["OpenAI-SSE-First-Turn-Prelude"] = originalCompat;
        else delete state.providerCompat["OpenAI-SSE-First-Turn-Prelude"];
      }
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

test("handleChatCompletion buffers native repairable command alias tool calls until canonical output", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    routing.init({ sendError: () => {}, trackSessionTokens });
    state.PROVIDERS = [{
      name: "Native-Command-Alias",
      model: "native-command-alias-model",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (_provider, _body, handlers) => {
      handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_cmd_alias",
              type: "function",
              function: { name: "exec_command", arguments: "{\"command\":\"pwd\"}" },
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
        model: "native-command-alias-model",
        stream: true,
        messages: [{ role: "user", content: "Run pwd." }],
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /\\"cmd\\":\\"pwd\\"/);
      assert.doesNotMatch(output, /\\"command\\":\\"pwd\\"/);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion treats native preflush aborts as transient transport errors", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.log = (message) => logs.push(String(message));
    state.PROVIDERS = [{
      name: "Native-Abort-Test",
      model: "native-abort-model",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async () => {
      throw new Error("aborted");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "native-abort-model",
        stream: true,
        messages: [{ role: "user", content: "Continue work." }],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      }, clientRes);

      const score = state.scores["Native-Abort-Test"];
      assert.equal(clientRes.status, 502);
      assert.equal(score?.failures || 0, 0);
      assert.equal(score?.cooldown_until || 0, 0);
      assert.match(logs.join("\n"), /NATIVE-STREAM-ABORT: Native-Abort-Test .*transient transport abort/);
      assert.doesNotMatch(logs.join("\n"), /POSSIBLE-STALL: Native-Abort-Test/);
    } finally {
      state.log = originalLog;
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

test("handleChatCompletion strips native historical tool replay text before flushing useful content", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.PROVIDERS = [{
      name: "Native-History-Strip-Test",
      model: "native-history-strip-model",
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
            content: "Found the cause and continuing the fix. Historical tool invocation (already executed): exec_command {\"cmd\":\"pwd\"}",
          },
          finish_reason: "stop",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "native-history-strip-model",
        stream: true,
        messages: [{ role: "user", content: "Continue fixing the bug." }],
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /Found the cause and/);
      assert.match(output, /continuing the fix/);
      assert.doesNotMatch(output, /Historical tool invocation/);
      assert.doesNotMatch(output, /already executed/);
      assert.doesNotMatch(logs.join("\n"), /TOOL-TEXT-NATIVE-INVALID: Native-History-Strip-Test tool_history_replay/);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion strips orphaned native tool argument fragments before flushing useful content", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.PROVIDERS = [{
      name: "Native-Orphan-Args-Strip-Test",
      model: "native-orphan-args-strip-model",
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
            content: [
              "Found the flaky assertion and verified the fix.",
              "\"/Users/Bogdan.Torcescu/Projects/llm-proxy/tests/responses.test.js\",\"limit\":80,\"offset\":294}",
            ].join("\n"),
          },
          finish_reason: "stop",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };
    try {
      const clientRes = new FakeClientResponse();
      await routing.handleChatCompletion({
        model: "native-orphan-args-strip-model",
        stream: true,
        messages: [{ role: "user", content: "Continue fixing the bug." }],
        tools: [{
          type: "function",
          function: {
            name: "Read",
            parameters: {
              type: "object",
              required: ["file_path"],
              properties: {
                file_path: { type: "string" },
                offset: { type: "integer" },
                limit: { type: "integer" },
              },
              additionalProperties: false,
            },
          },
        }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.match(output, /Found the flaky asse/);
      assert.match(output, /he fix\./);
      assert.doesNotMatch(output, /responses\.test\.js","limit":80,"offset":294/);
      assert.doesNotMatch(output, /offset":294/);
      assert.match(logs.join("\n"), /PROXY-RESP-NATIVE-STRIP: Native-Orphan-Args-Strip-Test/);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native pure historical tool replay during active tool work", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    const calls = [];
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.PROVIDERS = [{
      name: "Native-History-Replay-Test",
      model: "native-history-replay-model",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (_provider, body, handlers) => {
      const userMessages = body.messages?.filter((m) => m.role === "user") || [];
      calls.push({ userCount: userMessages.length, lastUser: userMessages.at(-1)?.content });
      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({
          choices: [{
            delta: {
              content: "Historical tool invocation (already executed): exec_command {\"cmd\":\"pwd\"}",
            },
            finish_reason: "stop",
          }],
        })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_next",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
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
        model: "native-history-replay-model",
        stream: true,
        messages: [
          { role: "user", content: "Continue fixing the bug." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_prev", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"node e2e_membership_test.js\"}" } }],
          },
          { role: "tool", tool_call_id: "call_prev", content: "[4/N] Subscriptions tab loaded. No active membership card displayed." },
        ],
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { userCount: 1, lastUser: "Continue fixing the bug." },
        { userCount: 3, lastUser: "continue. Do not replay historical tool invocations or tool results. Use the next appropriate tool call or provide a substantive final answer from current evidence." },
      ]);
      assert.equal(clientRes.status, 200);
      assert.match(output, /tool_calls/);
      assert.match(output, /"name":"exec_command"/);
      assert.doesNotMatch(output, /Historical tool invocation/);
      assert.doesNotMatch(output, /already executed/);
      assert.match(logs.join("\n"), /PROXY-RESP-NATIVE-STRIP: Native-History-Replay-Test/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Native-History-Replay-Test .*output=tool_history_replay.*action=hidden_continue/);
    } finally {
      state.PROVIDERS = originalProviders;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
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

test("handleChatCompletion fails over native bare continue without hidden continue", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    const originalLog = state.log;
    const logs = [];
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    const calls = [];
    state.log = (message) => logs.push(String(message));
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
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "continue" }, finish_reason: null }] })}\n\n`);
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
        _llmProxyDifficulty: {
          level: 4,
          taskLevel: 4,
          contextLevel: 4,
          taskKind: "debugging",
          costTarget: 4,
          thinkingLevel: 4,
          thinkingEffort: "high",
          speedTarget: 3,
          reason: "debugging",
          stepShape: { shape: "read_heavy", gate: "plan_split" },
          _assessmentProvider: {
            origin: "post_route_fallback",
            maxTokens: 0,
            stream: true,
            responseProvider: "Claude-Sonnet45",
          },
        },
        messages: [{ role: "user", content: "continue" }],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes, { internal: true });

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { provider: "Native-Stall-Continuation", userCount: 1, lastUser: "continue" },
        { provider: "Native-Action-Fallback", userCount: 1, lastUser: "continue" },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("continue"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.match(logs.join("\n"), /REAL-STALL-NATIVE: Native-Stall-Continuation .*output=inert_continuation.*action=failover_stall/);
      assert.doesNotMatch(logs.join("\n"), /HIDDEN-CONTINUE/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native bare continue once as hidden user continue for active tool work", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    const calls = [];
    state.log = (message) => logs.push(String(message));
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
        name: "Native-Hidden-Continue",
        model: "windsurf/native-hidden-continue",
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
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "continue" }, finish_reason: null }] })}\n\n`);
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
              function: { name: "Read", arguments: "{\"file_path\":\"lib/routing.js\"}" },
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
        _llmProxyDifficulty: {
          level: 4,
          taskLevel: 3,
          contextLevel: 4,
          taskKind: "agentic_coding",
          costTarget: 4,
          thinkingLevel: 4,
          thinkingEffort: "high",
          speedTarget: 3,
          reason: "agentic_coding",
          stepShape: { shape: "write_heavy", gate: "run_behavior" },
        },
        messages: [
          { role: "user", content: "Continue implementing the routing fix." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"lib/routing.js\"}" } }],
          },
          { role: "tool", tool_call_id: "call_read", content: "Read lib/routing.js." },
        ],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes, { internal: true });

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { provider: "Native-Hidden-Continue", userCount: 1, lastUser: "Continue implementing the routing fix." },
        {
          provider: "Native-Hidden-Continue",
          userCount: 2,
          lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
        },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Native-Hidden-Continue .*output=inert_continuation.*action=hidden_continue/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Native-Hidden-Continue retry=1/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion failovers repeated native continue after hidden nudge", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    const calls = [];
    state.log = (message) => logs.push(String(message));
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
        name: "Native-Repeated-Continue",
        model: "windsurf/native-repeated-continue",
        protocol: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 131072,
        tier: 1,
      },
      {
        name: "Native-Repeated-Continue-Fallback",
        model: "windsurf/native-repeated-continue-fallback",
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
      if (provider.name === "Native-Repeated-Continue") {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "continue" }, finish_reason: null }] })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_fallback",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"lib/routing.js\"}" },
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
        _llmProxyDifficulty: {
          level: 4,
          taskLevel: 3,
          contextLevel: 4,
          taskKind: "agentic_coding",
          costTarget: 3,
          thinkingLevel: 4,
          thinkingEffort: "high",
          speedTarget: 3,
          reason: "agentic_coding",
          stepShape: { shape: "write_heavy", gate: "run_behavior" },
        },
        messages: [
          { role: "user", content: "Continue implementing the routing fix." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"lib/routing.js\"}" } }],
          },
          { role: "tool", tool_call_id: "call_read", content: "Read lib/routing.js." },
        ],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      }, clientRes, { internal: true });

      const output = clientRes.chunks.join("");
      assert.equal(clientRes.status, 200);
      assert.equal(calls[0].provider, "Native-Repeated-Continue");
      assert.equal(calls[1].provider, "Native-Repeated-Continue");
      assert.match(calls[1].lastUser, /^continue the active task\./);
      assert.equal(calls.at(-1).provider, "Native-Repeated-Continue-Fallback");
      assert.match(output, /"tool_calls"/);
      assert.doesNotMatch(output, /"content":"continue"/);
      assert.match(logs.join("\n"), /REAL-STALL-NATIVE: Native-Repeated-Continue .*output=inert_continuation.*action=failover_stall/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native file-check Go prelude as hidden continue", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    const calls = [];
    state.log = (message) => logs.push(String(message));
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
        {
          provider: "Native-Prelude-Continuation",
          userCount: 2,
          lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
        },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("Local screenshot"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Native-Prelude-Continuation .*output=action_prelude.*action=hidden_continue/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Native-Prelude-Continuation retry=1/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native action prelude during active tool work", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalLog = state.log;
    const logs = [];
    const calls = [];
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Active-Prelude",
      model: "windsurf/native-active-prelude",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((m) => m.role === "user") || [];
      calls.push({ provider: provider.name, userCount: userMessages.length, lastUser: userMessages.at(-1)?.content });
      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: [
          "[4/N] Subscriptions tab loaded. No active membership card displayed.",
          "This means either membership API returns no active membership or frontend rendering is wrong.",
          "Next step: check Account page for membership card display, then inspect the membership API response.",
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
              id: "call_account",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"curl -s http://localhost:5173/account\"}" },
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
        _llmProxyDifficulty: {
          level: 4,
          taskLevel: 4,
          contextLevel: 4,
          taskKind: "agentic_coding",
          costTarget: 4,
          thinkingLevel: 4,
          thinkingEffort: "high",
          speedTarget: 3,
          reason: "agentic_coding",
          stepShape: { shape: "write_heavy", gate: "run_behavior" },
        },
        messages: [
          { role: "user", content: "Continue debugging the missing membership card and fix it." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_subscriptions", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"node e2e_membership_test.js\"}" } }],
          },
          { role: "tool", tool_call_id: "call_subscriptions", content: "[4/N] Subscriptions tab loaded. No active membership card displayed." },
        ],
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      }, clientRes, { internal: true });

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { provider: "Native-Active-Prelude", userCount: 1, lastUser: "Continue debugging the missing membership card and fix it." },
        {
          provider: "Native-Active-Prelude",
          userCount: 2,
          lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
        },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("Subscriptions tab loaded"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Native-Active-Prelude .*output=action_prelude.*action=hidden_continue/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Native-Active-Prelude retry=1/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion keeps native active loop alive after repeated progress text", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalMaxRetries = process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES;
    const originalLog = state.log;
    const logs = [];
    const calls = [];
    process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES = "3";
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Repeated-Progress",
      model: "windsurf/native-repeated-progress",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
    }];
    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((m) => m.role === "user") || [];
      calls.push({ provider: provider.name, userCount: userMessages.length, lastUser: userMessages.at(-1)?.content });
      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: [
          "[5/N] Checking My Account page for membership state.",
          "Next step: inspect the membership API response and rerun Playwright.",
        ].join("\n") }, finish_reason: null }] })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      if (calls.length === 2) {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: "Still need to inspect the account API and verify the scanner flow before this is complete." }, finish_reason: null }] })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_account_api",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"curl -s http://localhost:5173/api/user/memberships\"}" },
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
        _llmProxyDifficulty: {
          level: 5,
          taskLevel: 4,
          contextLevel: 5,
          taskKind: "agentic_coding",
          costTarget: 3,
          thinkingLevel: 4,
          thinkingEffort: "high",
          speedTarget: 4,
          reason: "agentic_coding",
          stepShape: { shape: "write_heavy", gate: "run_behavior" },
        },
        messages: [
          { role: "user", content: "Continue debugging the missing membership card and fix it." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_subscriptions", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"node e2e_membership_test.js\"}" } }],
          },
          { role: "tool", tool_call_id: "call_subscriptions", content: "[4/N] Subscriptions tab loaded. No active membership card displayed." },
        ],
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      }, clientRes, { internal: true });

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { provider: "Native-Repeated-Progress", userCount: 1, lastUser: "Continue debugging the missing membership card and fix it." },
        {
          provider: "Native-Repeated-Progress",
          userCount: 2,
          lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
        },
        {
          provider: "Native-Repeated-Progress",
          userCount: 2,
          lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
        },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("Checking My Account page"), false);
      assert.equal(output.includes("Still need to inspect"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      const joined = logs.join("\n");
      assert.equal((joined.match(/HIDDEN-CONTINUE-NATIVE: Native-Repeated-Progress .*action=hidden_continue/g) || []).length, 2);
      assert.match(joined, /HIDDEN-CONTINUE-NATIVE: Native-Repeated-Progress .*output=action_prelude.*action=hidden_continue/);
      assert.match(joined, /HIDDEN-CONTINUE-RETRY: Native-Repeated-Progress retry=2/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      if (originalMaxRetries === undefined) delete process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES;
      else process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES = originalMaxRetries;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native invalid tool calls with schema-aware hidden continue before flushing", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    const originalLog = state.log;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    const calls = [];
    const logs = [];
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Prelude-InvalidTool",
      model: "windsurf/native-prelude-invalid-tool",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
      cost_group: 2,
      quality_group: 4,
      speed_group: 5,
      thinking_effort: "high",
    }];
    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((message) => message.role === "user") || [];
      calls.push({ provider: provider.name, lastUser: userMessages.at(-1)?.content || "" });
      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({
          choices: [{
            delta: {
              content: "I will save the script and run it with Playwright.",
            },
            finish_reason: null,
          }],
        })}\n\n`);
        handlers.onChunk(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_bad",
                type: "function",
                function: { name: "exec_command", arguments: "{}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        })}\n\n`);
        handlers.onChunk("data: [DONE]\n\n");
        return;
      }
      assert.match(userMessages.at(-1)?.content || "", /previous streamed tool call was invalid/i);
      handlers.onChunk(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_good",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
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
        model: "windsurf/native-prelude-invalid-tool",
        stream: true,
        messages: [{ role: "user", content: "Continue the implementation and run the regression script." }],
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            parameters: {
              type: "object",
              required: ["cmd"],
              properties: { cmd: { type: "string" } },
              additionalProperties: false,
            },
          },
        }],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls.map((call) => call.provider), ["Native-Prelude-InvalidTool", "Native-Prelude-InvalidTool"]);
      assert.equal(clientRes.status, 200);
      assert.match(output, /"name":"exec_command"/);
      assert.match(output, /\\"cmd\\":\\"pwd\\"/);
      assert.doesNotMatch(output, /I will save the script/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE-TOOL-ARGS: Native-Prelude-InvalidTool tool "exec_command" missing required field "cmd"/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Native-Prelude-InvalidTool retry=1 appended hidden user message/);
      assert.doesNotMatch(logs.join("\n"), /COMPAT: Native-Prelude-InvalidTool invalid streamed tool arguments/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native short text-only progress during active tool work", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    const originalLog = state.log;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    const calls = [];
    const logs = [];
    state.log = (message) => logs.push(String(message));
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
      assert.deepEqual(calls, [
        { provider: "Native-Short-Progress", userCount: 1, lastUser: "Run reports/startup-experiment.yml live, not dry-run; it should take at least the test duration." },
        {
          provider: "Native-Short-Progress",
          userCount: 2,
          lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
        },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("dry-run only rendered"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Native-Short-Progress .*output=premature_progress.*action=hidden_continue/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Native-Short-Progress retry=1/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
      else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native premature progress after TodoWrite result", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    const originalLog = state.log;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    const calls = [];
    const logs = [];
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Todo-Progress",
      model: "windsurf/native-todo-progress",
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
            delta: { content: "Todo list updated; next I need to verify the scanner dialog." },
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
              id: "call_verify",
              type: "function",
              function: { name: "Bash", arguments: "{\"command\":\"npm test -- --runInBand scanner\"}" },
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
          { role: "user", content: "Continue fixing the scanner dialog and verify it." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_todo", type: "function", function: { name: "TodoWrite", arguments: "{\"todos\":[]}" } }],
          },
          { role: "tool", tool_call_id: "call_todo", content: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress." },
        ],
        tools: [
          { type: "function", function: { name: "TodoWrite", parameters: { type: "object" } } },
          { type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } },
        ],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.deepEqual(calls, [
        { provider: "Native-Todo-Progress", userCount: 1, lastUser: "Continue fixing the scanner dialog and verify it." },
        {
          provider: "Native-Todo-Progress",
          userCount: 2,
          lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
        },
      ]);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("Todo list updated"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Native-Todo-Progress .*output=premature_progress.*action=hidden_continue/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Native-Todo-Progress retry=1/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
      if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
      else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
      routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
    }
  });
});

test("handleChatCompletion retries native premature progress after automatic TodoWrite nudge", async () => {
  await withNoScoreWrites(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalRouteNativeStream = providerAdapters.routeNativeStream;
    const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
    const originalLog = state.log;
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    const calls = [];
    const logs = [];
    state.log = (message) => logs.push(String(message));
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens,
    });
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [{
      name: "Native-Todo-Nudge",
      model: "windsurf/native-todo-nudge",
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
            delta: { content: "I'll update the todo list before continuing the wallet verification." },
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
              id: "call_todo",
              type: "function",
              function: { name: "TodoWrite", arguments: "{\"todos\":[{\"content\":\"Test scanner dialog\",\"status\":\"in_progress\"}]}" },
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
        _llmProxyDifficulty: {
          level: 4,
          taskLevel: 4,
          contextLevel: 4,
          taskKind: "agentic_coding",
          costTarget: 3,
          thinkingLevel: 4,
          thinkingEffort: "high",
          speedTarget: 4,
          reason: "edit_recovery",
          stepShape: { shape: "write_heavy", gate: "run_behavior" },
        },
        messages: [
          { role: "user", content: "Continue fixing the wallet controller injection and verify the scanner dialog." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_edit", type: "function", function: { name: "Edit", arguments: "{\"file_path\":\"src/dependencies.php\"}" } }],
          },
          { role: "tool", tool_call_id: "call_edit", content: "The file src/dependencies.php has been updated successfully." },
          { role: "assistant", content: "" },
          { role: "user", content: "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Here are the existing contents of your todo list:\n[1. [completed] Verify only one QR card remains in subscriptions tab\n2. [in_progress] Fix wallet controller null service injection\n3. [pending] Test wallet button opens correct /api/user route\n4. [pending] Test scanner dialog]" },
        ],
        tools: [
          { type: "function", function: { name: "TodoWrite", parameters: { type: "object" } } },
          { type: "function", function: { name: "Edit", parameters: { type: "object", required: ["file_path"] } } },
        ],
      }, clientRes);

      const output = clientRes.chunks.join("");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].provider, "Native-Todo-Nudge");
      assert.equal(calls[0].userCount, 2);
      assert.equal(calls[0].lastUser, "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Here are the existing contents of your todo list:\n[1. [completed] Verify only one QR card remains in subscriptions tab\n2. [in_progress] Fix wallet controller null service injection\n3. [pending] Test wallet button opens correct /api/user route\n4. [pending] Test scanner dialog]");
      assert.equal(calls[1].provider, "Native-Todo-Nudge");
      assert.equal(calls[1].lastUser, "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.");
      assert.ok(calls[1].userCount >= 2);
      assert.equal(clientRes.status, 200);
      assert.equal(output.includes("I'll update the todo list"), false);
      assert.equal(output.includes("\"tool_calls\""), true);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Native-Todo-Nudge .*output=premature_progress.*action=hidden_continue/);
      assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Native-Todo-Nudge retry=1/);
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      providerAdapters.routeNativeStream = originalRouteNativeStream;
      state.log = originalLog;
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
            { type: "text", text: "Bogdan " },
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
  assert.equal(output.includes("Bogdan "), true);
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


for (const native of [false, true]) {
  test(`upstream rejection stays private through ${native ? "native" : "legacy"} routing`, async () => {
    await withNoScoreWrites(async () => {
      const originalLog = state.log;
      const logs = [];
      state.log = message => logs.push(String(message));
      try {
        await withServer((_req, res) => {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { message: "input exceeds context window PRIVATE_UPSTREAM_123" } }));
        }, async url => {
          const response = new FakeClientResponse();
          let caught;
          try {
            await (native ? routing.routeNativeStreamToProvider : routing.routeStreamToProvider)(streamProvider(url), requestBody(), response);
          } catch (error) { caught = error; }
          assert.ok(caught);
          const transport = require("../lib/http-transport");
          const inner = caught.error || caught;
          assert.match(transport.safeErrorText(inner), /context_length_exceeded/);
          assert.match(inner.body, /PRIVATE_UPSTREAM_123/);
          assert.doesNotMatch(JSON.stringify(caught), /PRIVATE_UPSTREAM_123/);
          assert.doesNotMatch(logs.join("\n"), /PRIVATE_UPSTREAM_123/);
          assert.doesNotMatch(JSON.stringify(state.scores), /PRIVATE_UPSTREAM_123/);
          assert.doesNotMatch(response.chunks.join(""), /PRIVATE_UPSTREAM_123/);
          inner.release?.();
        });
      } finally { state.log = originalLog; }
    });
  });
}
