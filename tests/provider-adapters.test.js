"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const adapters = require("../lib/provider-adapters");

test("routeNativeStream sends Anthropic Messages shape and converts Anthropic SSE to OpenAI SSE", async () => {
  const previousEnv = {
    CLAUDE_CODE_VERSION: process.env.CLAUDE_CODE_VERSION,
    CLAUDE_CODE_DEVICE_ID: process.env.CLAUDE_CODE_DEVICE_ID,
    CLAUDE_CODE_ACCOUNT_UUID: process.env.CLAUDE_CODE_ACCOUNT_UUID,
    CLAUDE_CODE_MAX_TOKENS: process.env.CLAUDE_CODE_MAX_TOKENS,
    CLAUDE_CODE_OUTPUT_EFFORT: process.env.CLAUDE_CODE_OUTPUT_EFFORT,
  };
  process.env.CLAUDE_CODE_VERSION = "2.1.150";
  process.env.CLAUDE_CODE_DEVICE_ID = "device-test";
  process.env.CLAUDE_CODE_ACCOUNT_UUID = "account-test";
  process.env.CLAUDE_CODE_MAX_TOKENS = "32000";
  process.env.CLAUDE_CODE_OUTPUT_EFFORT = "high";

  let capturedBody = {};
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      capturedBody = JSON.parse(raw);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'data: {"type":"message_start","message":{"id":"msg_stream","role":"assistant","usage":{"input_tokens":2}}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        'data: {"type":"message_stop"}',
        "",
      ].join("\n\n"));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const chunks = [];
    await adapters.routeNativeStream(
      {
        name: "Claude-Opus48",
        family: "claude",
        protocol: "anthropic",
        key: "sk-ant-api03-test",
        key_env: "ANTHROPIC_API_KEY",
        model: "claude/claude-opus-4-8",
        upstream_model: "claude-opus-4-8",
        url: `http://127.0.0.1:${port}/v1/messages`,
      },
      {
        model: "claude/claude-opus-4-8",
        stream: true,
        messages: [
          { role: "system", content: "Use repo rules." },
          { role: "user", content: "Say hello." },
        ],
        _claudeCodeSessionId: "session-test",
      },
      { onChunk: (chunk) => chunks.push(String(chunk)) }
    );

    assert.equal(capturedBody.model, "claude-opus-4-8");
    assert.equal(capturedBody.max_tokens, 32000);
    assert.deepEqual(JSON.parse(capturedBody.metadata.user_id), {
      device_id: "device-test",
      account_uuid: "account-test",
      session_id: "session-test",
    });
    assert.equal(capturedBody.stream, true);
    assert.deepEqual(capturedBody.output_config, { effort: "high" });
    const output = chunks.join("");
    assert.match(output, /chat\.completion\.chunk/);
    assert.match(output, /hello/);
    assert.match(output, /data: \[DONE\]/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
