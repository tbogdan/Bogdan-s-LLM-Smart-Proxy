"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const cloud = require("../lib/windsurf-cloud");

test("toWindsurfRequest preserves OpenAI request fields and selects upstream model", () => {
  const provider = { upstream_model: "swe-1.6-fast" };
  const input = {
    model: "windsurf/swe-1.6-fast",
    messages: [{ role: "user", content: "Hello" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    temperature: 0.25,
    stream: true,
  };

  const output = cloud.toWindsurfRequest(provider, input);

  assert.equal(output.model, "swe-1.6-fast");
  assert.equal(output.temperature, 0.25);
  assert.equal(output.stream, true);
  assert.deepEqual(output.messages, input.messages);
  assert.deepEqual(output.tools, input.tools);
});

test("buildHeaders includes bearer token and JSON content type", () => {
  const headers = cloud.buildHeaders({ key: "host-token" });

  assert.equal(headers.Authorization, "Bearer host-token");
  assert.equal(headers["content-type"], "application/json");
});

test("postWindsurf returns raw response details for non-2xx responses", async () => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, "Bearer host-token");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(body, JSON.stringify({ model: "swe-1.6-fast", messages: [] }));
      response.writeHead(503, { "content-type": "application/json", "x-request-id": "req-ws-123" });
      response.end('{"error":"temporarily_unavailable"}');
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await cloud.postWindsurf(
      { key: "host-token", url: `http://127.0.0.1:${port}/v1/chat/completions` },
      { model: "swe-1.6-fast", messages: [] },
    );

    assert.equal(output.status, 503);
    assert.equal(output.headers["content-type"], "application/json");
    assert.equal(output.headers["x-request-id"], "req-ws-123");
    assert.equal(output.body, '{"error":"temporarily_unavailable"}');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("callWindsurfCloud wraps JSON text response into OpenAI completion", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "ws_123", output: "Hello from Windsurf", usage: { input_tokens: 5, output_tokens: 4 } }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await cloud.callWindsurfCloud(
      { key: "host-token", upstream_model: "swe-1.6-fast", url: `http://127.0.0.1:${port}/v1/chat/completions` },
      { model: "windsurf/swe-1.6-fast", messages: [{ role: "user", content: "Hello" }] },
    );

    assert.equal(output.id, "chatcmpl-ws_123");
    assert.equal(output.object, "chat.completion");
    assert.equal(output.model, "windsurf/swe-1.6-fast");
    assert.deepEqual(output.choices[0].message, { role: "assistant", content: "Hello from Windsurf" });
    assert.deepEqual(output.usage, { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("toOpenAIResponse preserves OpenAI-like choices and normalizes usage tokens", () => {
  const output = cloud.toOpenAIResponse("windsurf/swe-1.6", {
    id: "chatcmpl-existing",
    model: "upstream-model",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    usage: { input_tokens: 7, output_tokens: 2 },
  });

  assert.equal(output.id, "chatcmpl-existing");
  assert.equal(output.model, "windsurf/swe-1.6");
  assert.deepEqual(output.choices, [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }]);
  assert.deepEqual(output.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
});
