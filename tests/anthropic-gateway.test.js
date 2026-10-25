"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const gateway = require("../lib/anthropic-gateway");
const state = require("../lib/state");

class FakeResponse {
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

class StrictFakeResponse extends FakeResponse {
  writeHead(status, headers) {
    if (this.headers) {
      const err = new Error("Cannot write headers after they are sent to the client");
      err.code = "ERR_HTTP_HEADERS_SENT";
      throw err;
    }
    super.writeHead(status, headers);
  }
}

test("translateRequest maps Anthropic Messages requests to OpenAI chat requests", () => {
  const translated = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    system: "Use the repository rules.",
    max_tokens: 1234,
    messages: [
      { role: "user", content: "Edit the file." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect it." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.js" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "const a = 1;" },
          { type: "text", text: "Now patch it." },
        ],
      },
    ],
    tools: [{ name: "Read", description: "Read file", input_schema: { type: "object" } }],
  });

  assert.equal(translated.model, "auto-coding");
  assert.equal(translated.max_tokens, 1234);
  assert.deepEqual(translated.messages[0], { role: "system", content: "Use the repository rules." });
  assert.equal(translated.messages[2].role, "assistant");
  assert.equal(translated.messages[2].tool_calls[0].function.name, "Read");
  assert.equal(translated.messages[3].role, "tool");
  assert.equal(translated.messages[3].tool_call_id, "toolu_1");
  assert.equal(translated.messages[4].content, "Now patch it.");
  assert.equal(translated.tools[0].function.name, "Read");
});

test("translateRequest preserves Anthropic image blocks as OpenAI image_url parts", () => {
  const translated = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these screenshots." },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(translated.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "Compare these screenshots." },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  ]);
});

test("handleMessagesHTTP preserves Claude Code metadata and session for upstream routing", async () => {
  let capturedChatReq;
  gateway.init({
    handleChatCompletion: async (chatReq, res) => {
      capturedChatReq = chatReq;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        model: chatReq.model,
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP(
    { headers: { "x-claude-code-session-id": "session-from-header" } },
    res,
    JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 64,
      metadata: {
        user_id: JSON.stringify({
          device_id: "device-from-body",
          account_uuid: "account-from-body",
          session_id: "session-from-body",
        }),
      },
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "Say ok." }],
    })
  );

  assert.equal(res.status, 200);
  assert.equal(capturedChatReq._claudeCodeSessionId, "session-from-header");
  assert.deepEqual(capturedChatReq._claudeCodeMetadata, {
    user_id: JSON.stringify({
      device_id: "device-from-body",
      account_uuid: "account-from-body",
      session_id: "session-from-body",
    }),
  });
  assert.deepEqual(capturedChatReq._claudeCodeProfile, {
    deviceId: "device-from-body",
    accountUuid: "account-from-body",
    sessionId: "session-from-header",
  });
  assert.deepEqual(capturedChatReq._claudeCodeRequestShape, {
    thinking: { type: "adaptive" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "high" },
  });
});

test("handleMessagesHTTP passes direct Claude Messages requests through verbatim", async () => {
  const oldProviders = state.PROVIDERS;
  let capturedBody;
  let routerCalled = false;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      capturedBody = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_passthrough",
        type: "message",
        role: "assistant",
        model: capturedBody.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  state.PROVIDERS = [{
    name: "Claude-Opus48",
    family: "claude",
    protocol: "anthropic",
    model: "claude/claude-opus-4-8",
    upstream_model: "claude-opus-4-8",
    url: `http://127.0.0.1:${port}/v1/messages`,
    key: "sk-ant-api03-test",
    key_env: "ANTHROPIC_API_KEY",
    alive: true,
  }];
  gateway.init({
    handleChatCompletion: async () => {
      routerCalled = true;
      throw new Error("router should not be called");
    },
  });

  const requestBody = {
    model: "claude-opus-4-8",
    max_tokens: 32000,
    system: [
      { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "Reply OK." }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ],
    metadata: {
      user_id: JSON.stringify({ device_id: "device", account_uuid: "account", session_id: "session" }),
    },
  };

  try {
    const res = new FakeResponse();
    await gateway.handleMessagesHTTP(
      { headers: { "x-claude-code-session-id": "session" } },
      res,
      JSON.stringify(requestBody),
    );

    assert.equal(routerCalled, false);
    assert.equal(res.status, 200);
    assert.deepEqual(capturedBody, requestBody);
    assert.equal(JSON.parse(res.chunks.join("")).content[0].text, "OK");
  } finally {
    state.PROVIDERS = oldProviders;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("handleMessagesHTTP strips unsupported adaptive thinking before direct Claude passthrough", async () => {
  const oldProviders = state.PROVIDERS;
  let capturedBody;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      capturedBody = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_passthrough_sonnet",
        type: "message",
        role: "assistant",
        model: capturedBody.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  state.PROVIDERS = [{
    name: "Claude-Sonnet45",
    family: "claude",
    protocol: "anthropic",
    model: "claude/claude-sonnet-4-5-20250929",
    upstream_model: "claude-sonnet-4-5-20250929",
    url: `http://127.0.0.1:${port}/v1/messages`,
    key: "sk-ant-api03-test",
    key_env: "ANTHROPIC_API_KEY",
    alive: true,
    supports_adaptive_thinking: false,
    supports_extended_thinking: true,
  }];
  gateway.init({
    handleChatCompletion: async () => {
      throw new Error("router should not be called");
    },
  });

  try {
    const res = new FakeResponse();
    await gateway.handleMessagesHTTP(
      { headers: { "x-claude-code-session-id": "session-from-header" } },
      res,
      JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "Reply OK." }],
      }),
    );

    assert.equal(res.status, 200);
    assert.equal(capturedBody.thinking, undefined);
    assert.equal(capturedBody.context_management, undefined);
    assert.equal(capturedBody.output_config, undefined);
  } finally {
    state.PROVIDERS = oldProviders;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("handleMessagesHTTP retries generic direct Claude Messages with SDK scaffold before router fallback", async () => {
  const oldProviders = state.PROVIDERS;
  const oldClaudeCodeVersion = process.env.CLAUDE_CODE_VERSION;
  const capturedBodies = [];
  let routerCalled = false;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw);
      capturedBodies.push(body);
      const firstSystemText = Array.isArray(body.system) ? body.system[0]?.text : body.system;
      if (!/Claude Agent SDK/.test(String(firstSystemText || ""))) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_scaffold",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  state.PROVIDERS = [{
    name: "Claude-Opus48",
    family: "claude",
    protocol: "anthropic",
    model: "claude/claude-opus-4-8",
    upstream_model: "claude-opus-4-8",
    url: `http://127.0.0.1:${port}/v1/messages`,
    key: "sk-ant-api03-test",
    key_env: "ANTHROPIC_API_KEY",
    alive: true,
  }];
  process.env.CLAUDE_CODE_VERSION = "2.1.150";
  gateway.init({
    handleChatCompletion: async () => {
      routerCalled = true;
      throw new Error("router should not be called");
    },
  });

  try {
    const res = new FakeResponse();
    await gateway.handleMessagesHTTP(
      { headers: { "x-claude-code-session-id": "session" } },
      res,
      JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 4,
        messages: [{ role: "user", content: "Reply OK." }],
      }),
    );

    assert.equal(routerCalled, false);
    assert.equal(res.status, 200);
    assert.equal(capturedBodies.length, 2);
    assert.equal(capturedBodies[0].system, undefined);
    assert.match(capturedBodies[1].system[0].text, /Claude Agent SDK/);
    assert.equal(JSON.parse(res.chunks.join("")).content[0].text, "OK");
  } finally {
    state.PROVIDERS = oldProviders;
    if (oldClaudeCodeVersion === undefined) delete process.env.CLAUDE_CODE_VERSION;
    else process.env.CLAUDE_CODE_VERSION = oldClaudeCodeVersion;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("toAnthropicResponse maps OpenAI chat response to Anthropic message", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Done.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Edit", arguments: "{\"file_path\":\"a.js\"}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, "auto-coding");

  assert.equal(response.type, "message");
  assert.equal(response.role, "assistant");
  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[1].type, "tool_use");
  assert.equal(response.content[1].name, "Edit");
  assert.deepEqual(response.content[1].input, { file_path: "a.js" });
});

test("toAnthropicResponse preserves OpenAI text content parts", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Bogdan " },
            { type: "text", text: "LLM Smart Proxy." },
          ],
        },
        finish_reason: "stop",
      },
    ],
  }, "auto-coding");

  assert.deepEqual(response.content, [
    { type: "text", text: "Bogdan \nLLM Smart Proxy." },
  ]);
});

test("toAnthropicResponse strips private assessment metadata from text", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Done.\n\n[LLM_PROXY_INTERNAL_ROUTING level=4 effort=medium speed=4 reason=coding]",
        },
        finish_reason: "stop",
      },
    ],
  }, "auto-coding");

  assert.deepEqual(response.content, [
    { type: "text", text: "Done." },
  ]);
});

test("toAnthropicResponse strips private memory metadata from text", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Done.\n\n[LLM_PROXY_MEMORY v=1 op=save_fact target=markers type=decision confidence=high]",
        },
        finish_reason: "stop",
      },
    ],
  }, "auto-coding");

  assert.deepEqual(response.content, [
    { type: "text", text: "Done." },
  ]);
});

test("toAnthropicResponse strips cached historical tool artifacts from text", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            "Am actualizat scriptul.",
            "Historical tool invocation (already executed): Edit {\"file_path\":\"/tmp/new-test-wizard.sh\"}",
          ].join("\n"),
        },
        finish_reason: "stop",
      },
    ],
  }, "auto-coding");

  assert.deepEqual(response.content, [
    { type: "text", text: "Am actualizat scriptul." },
  ]);
});

test("toAnthropicResponse strips task notification and subagent usage artifacts from text", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            "Am aplicat patch-ul.",
            "<task-notification>",
            "<task-id>bx7lw3ald</task-id>",
            "<summary>Background command \"Recommit with clean message\" completed (exit code 0)</summary>",
            "</task-notification>",
            "agentId: ae226560a04546298 (use SendMessage with to: 'ae226560a04546298' to continue this agent)",
            "<usage>total_tokens: 64389",
            "tool_uses: 22",
            "duration_ms: 44850</usage>",
          ].join("\n"),
        },
        finish_reason: "stop",
      },
    ],
  }, "auto-coding");

  assert.deepEqual(response.content, [
    { type: "text", text: "Am aplicat patch-ul." },
  ]);
});

test("toAnthropicResponse strips tool_use_error artifacts from text", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            "I repaired the tool call.",
            "<tool_use_error>InputValidationError: TodoWrite failed because `todos` is required.</tool_use_error>",
          ].join("\n"),
        },
        finish_reason: "stop",
      },
    ],
  }, "auto-coding");

  assert.deepEqual(response.content, [
    { type: "text", text: "I repaired the tool call." },
  ]);
});

test("streaming Anthropic bridge strips fragmented historical tool artifacts", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Am actualizat scriptul.\n" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Historical tool invocation" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: " (already executed): Edit {\"file_path\":\"/tmp/new-test-wizard.sh\"}" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "ce ai schimbat?" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /Am actualizat scriptul/);
  assert.doesNotMatch(body, /Historical tool invocation|already executed|new-test-wizard/);
});

test("streaming Anthropic bridge strips fragmented task notification artifacts", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Am aplicat patch-ul.\n" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "<task-notification>\n<summary>Background command \\\"Wait for app to come back up\\\" completed (exit code 0)</summary>\n</task-notification>" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "\nagentId: ae226560a04546298 (use SendMessage with to: 'ae226560a04546298' to continue this agent)\n<usage>total_tokens: 64389\ntool_uses: 22\nduration_ms: 44850</usage>" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "ce ai schimbat?" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /Am aplicat patch-ul/);
  assert.doesNotMatch(body, /task-notification|Background command|agentId:|SendMessage|<usage>|total_tokens/i);
});

test("streaming Anthropic bridge strips private memory metadata", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done.\n\n" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "LLM_PROXY_MEMORY v=1 op=save_fact target=markers type=decision confidence=high" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /Done/);
  assert.doesNotMatch(body, /LLM_PROXY_MEMORY|target=markers/);
});

test("streaming Anthropic bridge strips private assessment metadata", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done.\n\n" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "LLM_PROXY_INTERNAL_ROUTING effort=medium speed=4 reason=typescript-fixes" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /Done/);
  assert.doesNotMatch(body, /effort=medium|typescript-fixes|LLM_PROXY_TASK_DIFFICULTY/);
});

test("streaming Anthropic bridge strips split private assessment metadata", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const content of [
        "LLM_PROXY_INTERNAL_ROUTING effort=low speed=4",
        " reason=monitoring\n\nUpdated docs.",
      ]) {
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content }, finish_reason: null }],
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say updated" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /Updated docs\./);
  assert.doesNotMatch(body, /effort=low|speed=4|reason=monitoring/);
});

test("streaming Anthropic bridge strips split speed-only private assessment metadata", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const content of [
        "LLM_PROXY_INTERNAL_ROUTING spe",
        "ed=4 reason=commit_changes\n\nCommitted changes.",
      ]) {
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content }, finish_reason: null }],
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say committed" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /Committed changes\./);
  assert.doesNotMatch(body, /speed=4|reason=commit_changes/);
});

test("streaming Anthropic bridge strips split legacy bare assessment metadata", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const content of [
        "eff",
        "ort=low speed=4 reason=playwright_smoke\n\nSmoke passed.",
      ]) {
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content }, finish_reason: null }],
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say smoke passed" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /Smoke passed\./);
  assert.doesNotMatch(body, /effort=low|reason=playwright_smoke/);
});

test("toAnthropicResponse returns clear help for generated tool_use missing required input", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }, "auto-coding", [
    { name: "Bash", input_schema: { type: "object", required: ["command"] } },
  ]);

  assert.equal(response.stop_reason, "end_turn");
  assert.equal(response.content.some((part) => part.type === "tool_use"), false);
  const text = response.content.map((part) => part.text || "").join("\n");
  assert.match(text, /Tool call error/i);
  assert.match(text, /Bash/);
  assert.match(text, /missing required field "command"/);
  assert.match(text, /retry/i);
  assert.match(text, /required fields: command/i);
});

test("toAnthropicResponse repairs TodoWrite from Claude Code todo nudge context", () => {
  const requestMessages = [{
    role: "user",
    content: "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Here are the existing contents of your todo list:\n[1. [completed] Fix wallet route\n2. [in_progress] Verify scanner dialog\n3. [pending] Run end to end verification]",
  }];

  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_todo",
              type: "function",
              function: { name: "TodoWrite", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }, "auto-coding", [
    {
      name: "TodoWrite",
      input_schema: {
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
                status: { type: "string" },
                activeForm: { type: "string" },
              },
            },
          },
        },
      },
    },
  ], requestMessages);

  assert.equal(response.stop_reason, "tool_use");
  const toolUse = response.content.find((part) => part.type === "tool_use");
  assert.ok(toolUse);
  assert.equal(toolUse.name, "TodoWrite");
  assert.deepEqual(toolUse.input.todos, [
    { content: "Fix wallet route", status: "completed", activeForm: "Fix wallet route" },
    { content: "Verify scanner dialog", status: "in_progress", activeForm: "Verify scanner dialog" },
    { content: "Run end to end verification", status: "pending", activeForm: "Run end to end verification" },
  ]);
  assert.equal(response.content.some((part) => /Tool call error/i.test(part.text || "")), false);
});

test("toAnthropicResponse repairs Playwright selector alias into required target", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_browser",
              type: "function",
              function: {
                name: "mcp__playwright__browser_click",
                arguments: JSON.stringify({ selector: "button:has-text(\"Sign in\")" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }, "auto-coding", [
    {
      name: "mcp__playwright__browser_click",
      input_schema: {
        type: "object",
        required: ["target"],
        properties: {
          target: { type: "string" },
        },
      },
    },
  ]);

  assert.equal(response.stop_reason, "tool_use");
  const toolUse = response.content.find((part) => part.type === "tool_use");
  assert.ok(toolUse);
  assert.equal(toolUse.name, "mcp__playwright__browser_click");
  assert.deepEqual(toolUse.input, {
    selector: "button:has-text(\"Sign in\")",
    target: "button:has-text(\"Sign in\")",
  });
  assert.equal(response.content.some((part) => /Tool call error/i.test(part.text || "")), false);
});

test("streaming Anthropic bridge returns clear help for generated tool_use missing required input", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "run pwd" }],
    tools: [{ name: "Bash", input_schema: { type: "object", required: ["command"] } }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal(body.includes('"type":"tool_use"'), false);
  assert.match(body, /Tool call error/i);
  assert.match(body, /Bash/);
  assert.match(body, /missing required field \\"command\\"/);
  assert.match(body, /retry/i);
  assert.match(body, /Required fields: command/i);
});

test("streaming Anthropic bridge repairs TodoWrite from Claude Code todo nudge context", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_todo",
                  type: "function",
                  function: { name: "TodoWrite", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{
      role: "user",
      content: "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Here are the existing contents of your todo list:\n[1. [completed] Fix wallet route\n2. [in_progress] Verify scanner dialog\n3. [pending] Run end to end verification]",
    }],
    tools: [{
      name: "TodoWrite",
      input_schema: {
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
                status: { type: "string" },
                activeForm: { type: "string" },
              },
            },
          },
        },
      },
    }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /"type":"tool_use"/);
  assert.match(body, /"name":"TodoWrite"/);
  assert.match(body, /\\"content\\":\\"Fix wallet route\\"/);
  assert.match(body, /\\"status\\":\\"completed\\"/);
  assert.equal(/Tool call error/i.test(body), false);
});

test("streaming Anthropic bridge explains invalid tool diagnostics in IDE-visible text", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "run pwd" }],
    tools: [{ name: "Bash", input_schema: { type: "object", required: ["command"] } }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal(body.includes('"type":"tool_use"'), false);
  assert.match(body, /Tool call error/i);
  assert.match(body, /missing required field \\"command\\"/);
});

test("streaming Anthropic bridge repairs Playwright selector alias into required target", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_browser",
                  type: "function",
                  function: {
                    name: "mcp__playwright__browser_click",
                    arguments: "{\"selector\":\"button:has-text(\\\"Sign in\\\")\"}",
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "click sign in" }],
    tools: [{
      name: "mcp__playwright__browser_click",
      input_schema: {
        type: "object",
        required: ["target"],
        properties: {
          target: { type: "string" },
        },
      },
    }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /"type":"tool_use"/);
  assert.match(body, /"name":"mcp__playwright__browser_click"/);
  assert.match(body, /"partial_json":"\{\\\"selector\\\":\\\"button:has-text\(\\\\\\\"Sign in\\\\\\\"\)\\\",\\\"target\\\":\\\"button:has-text\(\\\\\\\"Sign in\\\\\\\"\)\\\"\}"/);
  assert.equal(/Tool call error/i.test(body), false);
});

test("streaming Anthropic bridge ignores duplicate routed writeHead calls", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done" }, finish_reason: null }],
      })}\n\n`);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new StrictFakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal(res.ended, true);
  assert.match(body, /message_start/);
  assert.match(body, /text_delta/);
  assert.match(body, /message_stop/);
});

test("streaming Anthropic bridge preserves output usage from OpenAI final chunks", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /"usage":\{"output_tokens":4\}/);
});

test("streaming Anthropic bridge waits for post-stop OpenAI usage chunk", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /"usage":\{"output_tokens":4\}/);
});

test("streaming Anthropic bridge keeps multiple unindexed tool calls separate", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "inspect repo" }],
    tools: [
      { name: "Read", input_schema: { type: "object", required: ["file_path"] } },
      { name: "Bash", input_schema: { type: "object", required: ["command"] } },
    ],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal((body.match(/"type":"tool_use"/g) || []).length, 2);
  assert.match(body, /"name":"Read"/);
  assert.match(body, /"name":"Bash"/);
  assert.equal(/invalid tool call/i.test(body), false);
});

test("streaming Anthropic bridge maps message-level OpenAI tool calls to Anthropic tool_use", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_edit",
                type: "function",
                function: {
                  name: "Edit",
                  arguments: "{\"file_path\":\"/tmp/run_cmd.py\",\"old_string\":\"old\",\"new_string\":\"new\"}",
                },
              }],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "patch file" }],
    tools: [{ name: "Edit", input_schema: { type: "object", required: ["file_path", "old_string", "new_string"] } }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /"type":"tool_use"/);
  assert.match(body, /"name":"Edit"/);
  assert.equal(body.includes('\\"file_path\\":\\"/tmp/run_cmd.py\\"'), true);
  assert.equal(/Tool call error/i.test(body), false);
});


test("revoked direct credentials are quarantined across models while fallback and rotation work", async (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-auth-"));
  const runtime = require("../lib/task-runtime").createTaskRuntime({ dataDir: dir });
  const oldProviders = state.PROVIDERS, oldLog = state.log;
  const logs = [], attempts = [];
  state.log = (line) => logs.push(line);
  let fallback = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    attempts.push(req.headers["x-api-key"]);
    const bad = req.headers["x-api-key"] === "sk-ant-api03-revoked";
    res.writeHead(bad ? 401 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(bad ? { error: { type: "authentication_error", message: "PRIVATE_BODY revoked" } } : { content: [{ type: "text", text: "direct" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const route = { name: "auth-a", family: "claude", protocol: "anthropic", model: "claude/model-a", upstream_model: "model-a", key: "sk-ant-api03-revoked", account_ref: "shared", alive: true, url: `http://127.0.0.1:${server.address().port}/v1/messages` };
  state.PROVIDERS = [route, { ...route, name: "auth-b", model: "claude/model-b", upstream_model: "model-b" }];
  gateway.init({ taskRuntime: runtime, handleChatCompletion: async (_body, res) => {
    fallback++;
    res.writeHead(200, {});
    res.end(JSON.stringify({ choices: [{ message: { content: "fallback" }, finish_reason: "stop" }] }));
  } });
  t.after(async () => { state.PROVIDERS = oldProviders; state.log = oldLog; gateway.init({}); runtime.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(model) {
    const res = new FakeResponse();
    await gateway.handleMessagesHTTP({ headers: {} }, res, JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hello" }] }));
    assert.equal(res.status, 200);
    return JSON.parse(res.chunks.join("")).content[0].text;
  }
  assert.equal(await request("model-a"), "fallback");
  assert.equal(await request("model-a"), "fallback");
  assert.equal(await request("model-b"), "fallback");
  assert.equal(attempts.length, 1);
  assert.equal(fallback, 3);
  assert.equal(runtime.isProviderAvailable(route), false);
  state.PROVIDERS.push({ ...route, name: "auth-healthy", key: "sk-ant-api03-healthy" });
  assert.equal(await request("model-a"), "direct");
  route.key = "sk-ant-api03-rotated";
  assert.equal(await request("model-a"), "direct");
  assert.deepEqual(attempts, ["sk-ant-api03-revoked", "sk-ant-api03-healthy", "sk-ant-api03-rotated"]);
  assert.equal(logs.some(line => line.includes("PRIVATE_BODY")), false);
});


test("cooled native Claude never passes direct requests to an Anthropic-compatible third party", async (t) => {
  const scoring = require("../lib/scoring");
  const oldProviders = state.PROVIDERS;
  let thirdPartyCalls = 0, fallbackCalls = 0;
  const server = http.createServer((req, res) => {
    req.resume(); thirdPartyCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "third-party" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const native = { name: "native-cooled-selector-test", family: "claude", protocol: "anthropic", model: "claude/claude-sonnet-5-5", upstream_model: "claude-sonnet-5-5", key: "sk-ant-api03-fixture", alive: true, url: `http://127.0.0.1:${server.address().port}/v1/messages` };
  state.PROVIDERS = [native, { ...native, name: "opencode-compatible-selector-test", family: "opencode", model: "opencode/claude-sonnet-5-5" }];
  scoring.setCooldown(native.name, 60000, "test");
  gateway.init({ handleChatCompletion: async (_body, res) => {
    fallbackCalls++;
    res.writeHead(200, {});
    res.end(JSON.stringify({ choices: [{ message: { content: "fallback" }, finish_reason: "stop" }] }));
  } });
  t.after(async () => { state.PROVIDERS = oldProviders; gateway.init({}); await new Promise(resolve => server.close(resolve)); });
  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({ headers: {} }, res, JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hello" }] }));
  assert.equal(thirdPartyCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(JSON.parse(res.chunks.join("")).content[0].text, "fallback");
});
