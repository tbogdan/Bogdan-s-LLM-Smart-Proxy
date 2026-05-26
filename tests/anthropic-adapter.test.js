"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const anthropic = require("../lib/anthropic-adapter");

test("converts OpenAI chat request to Anthropic Messages request", () => {
  const provider = { upstream_model: "claude-sonnet-4-5" };
  const input = {
    model: "claude/claude-sonnet-4-5",
    messages: [
      { role: "system", content: [{ type: "text", text: "System A" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read file", parameters: { type: "object" } } }],
    max_tokens: 1234,
    temperature: 0.2,
    stream: true,
  };

  const output = anthropic.toAnthropicRequest(provider, input);

  assert.equal(output.model, "claude-sonnet-4-5");
  assert.equal(output.system, "System A");
  assert.equal(output.max_tokens, 1234);
  assert.equal(output.temperature, 0.2);
  assert.equal(output.stream, true);
  assert.deepEqual(output.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(output.tools[0].name, "read_file");
});

test("converts OpenAI image_url content to Anthropic image blocks", () => {
  const provider = { upstream_model: "claude-sonnet-4-5" };
  const output = anthropic.toAnthropicRequest(provider, {
    model: "claude/claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Review this screenshot." },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } },
        ],
      },
    ],
  });

  assert.deepEqual(output.messages[0], {
    role: "user",
    content: [
      { type: "text", text: "Review this screenshot." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "/9j/4AAQSkZJRg==",
        },
      },
    ],
  });
});

test("defaults max_tokens when OpenAI request omits it", () => {
  const output = anthropic.toAnthropicRequest(
    { upstream_model: "claude-sonnet-4-5" },
    {
      model: "claude/claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hello" }],
    }
  );

  assert.equal(anthropic.DEFAULT_MAX_TOKENS, 4096);
  assert.equal(output.max_tokens, 4096);
});

test("converts Anthropic response to OpenAI chat completion", () => {
  const output = anthropic.toOpenAIResponse("claude/claude-sonnet-4-5", {
    id: "msg_123",
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [{ type: "text", text: "Hello there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  assert.equal(output.id, "chatcmpl-msg_123");
  assert.equal(output.model, "claude/claude-sonnet-4-5");
  assert.equal(output.choices[0].message.content, "Hello there");
  assert.equal(output.choices[0].finish_reason, "stop");
  assert.deepEqual(output.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test("converts Anthropic prompt cache usage details", () => {
  const output = anthropic.toOpenAIResponse("claude/claude-sonnet-4-5", {
    id: "msg_cache",
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 5,
    },
  });

  assert.equal(output.usage.prompt_tokens, 22);
  assert.equal(output.usage.completion_tokens, 3);
  assert.equal(output.usage.total_tokens, 25);
  assert.equal(output.usage.prompt_tokens_details.cached_tokens, 5);
  assert.equal(output.usage.prompt_tokens_details.cache_creation_tokens, 7);
  assert.equal(output.usage.input_tokens_details.cache_read_tokens, 5);
});

test("converts assistant tool calls to Anthropic tool_use content", () => {
  const output = anthropic.toAnthropicRequest(
    { upstream_model: "claude-sonnet-4-5" },
    {
      model: "claude/claude-sonnet-4-5",
      messages: [
        { role: "user", content: "Read files" },
        {
          role: "assistant",
          content: "I will read them.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "list_files" },
            },
          ],
        },
      ],
    }
  );

  assert.deepEqual(output.messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "I will read them." },
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
      { type: "tool_use", id: "call_2", name: "list_files", input: {} },
    ],
  });
});

test("groups consecutive OpenAI tool results into one Anthropic user message", () => {
  const output = anthropic.toAnthropicRequest(
    { upstream_model: "claude-sonnet-4-5" },
    {
      model: "claude/claude-sonnet-4-5",
      messages: [
        { role: "user", content: "Read files" },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "README" }] },
        { role: "tool", tool_call_id: "call_2", content: "package" },
        { role: "user", content: "Summarize" },
      ],
    }
  );

  assert.deepEqual(output.messages, [
    { role: "user", content: "Read files" },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "README" },
        { type: "tool_result", tool_use_id: "call_2", content: "package" },
      ],
    },
    { role: "user", content: "Summarize" },
  ]);
});

test("converts buffered Anthropic text stream to OpenAI SSE", () => {
  const output = anthropic.toOpenAIStream(
    "claude/claude-sonnet-4-5",
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","role":"assistant"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("")
  );
  const chunks = output
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.slice("data: ".length));

  assert.equal(chunks.length, 4);
  assert.deepEqual(JSON.parse(chunks[0]).choices[0].delta, { role: "assistant" });
  assert.deepEqual(JSON.parse(chunks[1]).choices[0].delta, { content: "Hello" });
  assert.equal(JSON.parse(chunks[2]).choices[0].finish_reason, "stop");
  assert.equal(chunks[3], "[DONE]");
});

test("converts buffered Anthropic stream usage to OpenAI final chunk usage", () => {
  const output = anthropic.toOpenAIStream(
    "claude/claude-sonnet-4-5",
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_usage","role":"assistant","usage":{"input_tokens":10,"cache_creation_input_tokens":2,"cache_read_input_tokens":5}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("")
  );
  const chunks = output
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.slice("data: ".length));
  const final = JSON.parse(chunks[2]);

  assert.deepEqual(final.usage, {
    prompt_tokens: 17,
    completion_tokens: 3,
    total_tokens: 20,
    prompt_tokens_details: {
      cached_tokens: 5,
      cache_creation_tokens: 2,
      cache_read_tokens: 5,
    },
    input_tokens_details: {
      cached_tokens: 5,
      cache_creation_tokens: 2,
      cache_read_tokens: 5,
    },
  });
});

test("converts buffered Anthropic tool stream deltas to OpenAI SSE", () => {
  const output = anthropic.toOpenAIStream(
    "claude/claude-sonnet-4-5",
    [
      'data: {"type":"message_start","message":{"id":"msg_456","role":"assistant"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"README.md\\"}"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("")
  );
  const chunks = output
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.slice("data: ".length));

  assert.deepEqual(JSON.parse(chunks[1]).choices[0].delta, {
    tool_calls: [
      {
        index: 0,
        id: "toolu_1",
        type: "function",
        function: { name: "read_file", arguments: "" },
      },
    ],
  });
  assert.deepEqual(JSON.parse(chunks[2]).choices[0].delta, {
    tool_calls: [{ index: 0, function: { arguments: '{"path"' } }],
  });
  assert.deepEqual(JSON.parse(chunks[3]).choices[0].delta, {
    tool_calls: [{ index: 0, function: { arguments: ':"README.md"}' } }],
  });
  assert.equal(chunks[4], "[DONE]");
});

test("builds Anthropic headers from OAuth token", () => {
  const headers = anthropic.buildHeaders({ key: "oauth-token", key_env: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.equal(headers.Authorization, "Bearer oauth-token");
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
});

test("builds Anthropic headers from Platform API key", () => {
  const headers = anthropic.buildHeaders({ key: "sk-ant-api03-test", key_env: "ANTHROPIC_API_KEY" });
  assert.equal(headers["x-api-key"], "sk-ant-api03-test");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
});

test("postAnthropic returns raw HTTP response details", async () => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, "Bearer oauth-token");
      assert.equal(request.headers["anthropic-version"], "2023-06-01");
      assert.equal(body, JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1 }));
      response.writeHead(429, { "content-type": "application/json", "x-request-id": "req_123" });
      response.end('{"error":"rate_limited"}');
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await anthropic.postAnthropic(
      { key: "oauth-token", key_env: "CLAUDE_CODE_OAUTH_TOKEN", url: `http://127.0.0.1:${port}/v1/messages` },
      { model: "claude-sonnet-4-5", max_tokens: 1 }
    );

    assert.equal(output.status, 429);
    assert.equal(output.headers["content-type"], "application/json");
    assert.equal(output.headers["x-request-id"], "req_123");
    assert.equal(output.body, '{"error":"rate_limited"}');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
