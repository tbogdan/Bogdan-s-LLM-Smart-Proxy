"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const routing = require("../lib/routing");
const state = require("../lib/state");

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
  state.scores = {};
  fs.writeFileSync = () => {};
  routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      fs.writeFileSync = originalWriteFileSync;
      state.scores = originalScores;
    });
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

