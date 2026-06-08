"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const adapters = require("../lib/provider-adapters");

test("prepareOpenAICompatibleRequest sanitizes Copilot tool names for wire format and restores them in responses", () => {
  const provider = {
    name: "Copilot-claudesonnet46",
    family: "copilot",
    protocol: "openai",
    model: "copilot/claude-sonnet-4.6",
    upstream_model: "claude-sonnet-4.6",
  };
  const request = {
    model: "auto-coding",
    tool_choice: "auto",
    _llmProxyCapabilityContract: {
      client: { id: "copilot" },
      runtime: {
        surface: "github-copilot",
        toolDialect: {
          sanitizeToolNames: true,
          restoreToolNames: true,
          stripToolControlsWithoutDefinitions: true,
        },
      },
      capabilities: { toolNames: ["functions.exec_command", "sites:deploy"] },
    },
    tools: [
      { type: "function", function: { name: "functions.exec_command", parameters: { type: "object" } } },
      { type: "function", function: { name: "sites:deploy", parameters: { type: "object" } } },
      { type: "function", function: { name: "a".repeat(65), parameters: { type: "object" } } },
    ],
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Use a tool." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "functions.exec_command", arguments: "{\"cmd\":\"echo ok\"}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "functions.exec_command",
        content: "ok",
      },
      { role: "user", content: "Continue." },
    ],
  };

  const prepared = adapters.prepareOpenAICompatibleRequest(provider, request, false);
  assert.deepEqual(
    prepared.tools.map((tool) => tool.function.name),
    [
      "functions_exec_command",
      "sites_deploy",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_c743a45e",
    ],
  );
  assert.equal(
    prepared.messages.find((message) => message.role === "assistant" && message.tool_calls)?.tool_calls[0].function.name,
    "functions_exec_command",
  );
  assert.equal(
    prepared.messages.find((message) => message.role === "tool").name,
    "functions_exec_command",
  );
  assert.equal(prepared._llmProxyCapabilityContract, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(prepared, "__llmProxyCapabilityContract")?.value?.runtime?.surface, "github-copilot");

  const restored = adapters.restoreOpenAICompatibleResponse(provider, JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "functions_exec_command", arguments: "{\"cmd\":\"pwd\"}" },
          },
          {
            id: "call_3",
            type: "function",
            function: { name: "sites_deploy", arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    }],
  }), prepared);

  const parsed = JSON.parse(restored);
  assert.equal(parsed.choices[0].message.tool_calls[0].function.name, "functions.exec_command");
  assert.equal(parsed.choices[0].message.tool_calls[1].function.name, "sites:deploy");
});

test("routeAnthropic hydrates Claude bridge fields from the forwarded capability contract", async () => {
  const previousEnv = {
    CLAUDE_CODE_VERSION: process.env.CLAUDE_CODE_VERSION,
    CLAUDE_CODE_DEVICE_ID: process.env.CLAUDE_CODE_DEVICE_ID,
    CLAUDE_CODE_ACCOUNT_UUID: process.env.CLAUDE_CODE_ACCOUNT_UUID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
  };
  process.env.CLAUDE_CODE_VERSION = "2.1.165";
  delete process.env.CLAUDE_CODE_DEVICE_ID;
  delete process.env.CLAUDE_CODE_ACCOUNT_UUID;
  delete process.env.CLAUDE_CODE_SESSION_ID;

  let capturedBody = {};
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      capturedBody = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_1",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await adapters.routeNonStreaming(
      {
        name: "Claude-Sonnet46",
        family: "claude",
        protocol: "anthropic",
        model: "claude/claude-sonnet-4-6",
        upstream_model: "claude-sonnet-4-6",
        key: "sk-ant-api03-test",
        key_env: "ANTHROPIC_API_KEY",
        url: `http://127.0.0.1:${port}/v1/messages`,
      },
      {
        model: "claude/claude-sonnet-4-6",
        messages: [{ role: "user", content: "Say ok." }],
        _llmProxyCapabilityContract: {
          client: { id: "claude_code" },
          runtime: {
            surface: "claude-vscode",
            metadata: {
              deviceId: "device-contract",
              accountUuid: "account-contract",
              sessionId: "session-contract",
            },
          },
        },
      },
      () => {
        throw new Error("should not use OpenAI route for anthropic provider");
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(capturedBody.metadata.user_id), {
      device_id: "device-contract",
      account_uuid: "account-contract",
      session_id: "session-contract",
    });
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
