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

test("drops artificial whitespace assistant separators before native Claude requests", () => {
  const provider = { family: "claude", protocol: "anthropic", upstream_model: "claude-opus-4-8" };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-opus-4-8",
      messages: [
        { role: "system", content: "Use repo rules." },
        { role: "user", content: "Read README." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_read",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_read", content: "README contents." },
        { role: "assistant", content: " " },
        { role: "user", content: "continue" },
      ],
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
      },
    }
  );

  assert.deepEqual(output.messages.map((message) => message.role), ["user", "assistant", "user", "user"]);
  const textBlocks = [];
  for (const message of output.messages) {
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    for (const part of parts) {
      if (part?.type === "text") textBlocks.push(part.text);
    }
  }
  assert.equal(textBlocks.some((text) => String(text || "").trim() === ""), false);
});

test("toAnthropicRequest deduplicates tool_use IDs that appear in multiple assistant messages", () => {
  const provider = { upstream_model: "claude-sonnet-4-5" };
  // Same tool_use id "DZrfWFgJ4" appears in two separate assistant turns — the bug that caused
  // "messages.205: tool_use ids were..." errors from the Anthropic API.
  const output = anthropic.toAnthropicRequest(provider, {
    model: "claude/claude-sonnet-4-5",
    messages: [
      { role: "user", content: "First tool use" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "DZrfWFgJ4", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "DZrfWFgJ4", content: "first result" },
      { role: "user", content: "Second tool use" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "DZrfWFgJ4", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "DZrfWFgJ4", content: "second result" },
    ],
  });

  // Locate the two assistant messages and the two tool-result messages
  const assistantMsgs = output.messages.filter((m) => m.role === "assistant");
  const toolResultMsgs = output.messages.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result");

  assert.equal(assistantMsgs.length, 2);
  assert.equal(toolResultMsgs.length, 2);

  const firstToolUseId = assistantMsgs[0].content[0].id;
  const secondToolUseId = assistantMsgs[1].content[0].id;

  // The two tool_use IDs must be different
  assert.notEqual(firstToolUseId, secondToolUseId);

  // Each tool_result must reference the tool_use ID from the same turn
  const firstToolResultId = toolResultMsgs[0].content[0].tool_use_id;
  const secondToolResultId = toolResultMsgs[1].content[0].tool_use_id;

  assert.equal(firstToolResultId, firstToolUseId);
  assert.equal(secondToolResultId, secondToolUseId);

  // The second tool_use ID should have a collision suffix (first 7 chars match, last 2 differ)
  assert.equal(firstToolUseId.slice(0, 7), secondToolUseId.slice(0, 7));
  assert.notEqual(firstToolUseId.slice(7), secondToolUseId.slice(7));
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

test("builds Claude Code first-party headers for managed OAuth token", () => {
  const headers = anthropic.buildHeaders(
    { key: "oauth-token", key_env: "CLAUDE_CODE_OAUTH_TOKEN" },
    {
      sessionId: "session-test",
      clientRequestId: "request-test",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_BILLING_BUILD: "bbb",
        CLAUDE_CODE_STAINLESS_PACKAGE_VERSION: "0.94.0",
        CLAUDE_CODE_BETAS: "claude-code-20250219,effort-2025-11-24",
        LLM_PROXY_CLAUDE_CODE_OS: "MacOS",
        LLM_PROXY_CLAUDE_CODE_ARCH: "arm64",
      },
    }
  );

  assert.equal(headers.Authorization, "Bearer oauth-token");
  // Interactive CLI identifies as "(external, cli)", not the SDK/headless "sdk-cli".
  assert.equal(headers["user-agent"], "claude-cli/2.1.150 (external, cli)");
  assert.equal(headers["x-app"], "cli");
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.match(headers["anthropic-beta"], /claude-code-20250219/);
  assert.match(headers["anthropic-beta"], /effort-2025-11-24/);
  assert.match(headers["x-anthropic-billing-header"], /cc_version=2\.1\.150\.[a-f0-9]{3}; cc_entrypoint=cli; cch=[a-f0-9]{5};/);
  // analytics/session/fingerprint headers must not be forwarded upstream
  assert.equal(headers["x-claude-code-session-id"], undefined);
  assert.equal(headers["x-client-request-id"], undefined);
  // @anthropic-ai/sdk x-stainless-* fingerprint headers must be present (the
  // genuine bundled SDK always sends them).
  assert.equal(headers["x-stainless-lang"], "js");
  assert.equal(headers["x-stainless-package-version"], "0.94.0");
  assert.equal(headers["x-stainless-arch"], "arm64");
  assert.equal(headers["x-stainless-os"], "MacOS");
  assert.equal(headers["x-stainless-runtime"], "node");
  assert.equal(headers["x-stainless-runtime-version"], process.version.replace(/^v/, ""));
  assert.equal(headers["x-stainless-retry-count"], "0");
  // timeout header is only set by the SDK when a timeout is configured; proxy omits it.
  assert.equal(headers["x-stainless-timeout"], undefined);
});

test("computes Claude Code billing header from the first user message", () => {
  const headers = anthropic.buildHeaders(
    { key: "oauth-token", key_env: "CLAUDE_CODE_OAUTH_TOKEN" },
    {
      billingMessageText: "hey",
      env: { CLAUDE_CODE_VERSION: "2.1.37" },
    },
  );

  assert.equal(headers["x-anthropic-billing-header"], "cc_version=2.1.37.0d9; cc_entrypoint=cli; cch=fa690;");
});

test("builds Claude Code first-party headers for Claude providers using managed API key", () => {
  const headers = anthropic.buildHeaders(
    { family: "claude", protocol: "anthropic", key: "sk-ant-api03-test", key_env: "ANTHROPIC_API_KEY" },
    {
      sessionId: "session-test",
      clientRequestId: "request-test",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_BILLING_BUILD: "bbb",
        CLAUDE_CODE_STAINLESS_PACKAGE_VERSION: "0.94.0",
        CLAUDE_CODE_BETAS: "claude-code-20250219,effort-2025-11-24",
      },
    }
  );

  assert.equal(headers["x-api-key"], "sk-ant-api03-test");
  assert.equal(headers["user-agent"], "claude-cli/2.1.150 (external, cli)");
  assert.equal(headers["x-app"], "cli");
  assert.match(headers["anthropic-beta"], /claude-code-20250219/);
});

test("keeps platform API key headers free of Claude Code OAuth fingerprint", () => {
  const headers = anthropic.buildHeaders(
    { key: "sk-ant-api03-test", key_env: "ANTHROPIC_API_KEY" },
    { env: { CLAUDE_CODE_VERSION: "2.1.150" } }
  );

  assert.equal(headers["x-api-key"], "sk-ant-api03-test");
  assert.equal(headers["user-agent"], undefined);
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers["x-app"], undefined);
});

test("builds Anthropic headers from Platform API key", () => {
  const headers = anthropic.buildHeaders({ key: "sk-ant-api03-test", key_env: "ANTHROPIC_API_KEY" });
  assert.equal(headers["x-api-key"], "sk-ant-api03-test");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
});

test("does not synthesize a stale Claude Code version when profile metadata is missing", () => {
  const headers = anthropic.buildHeaders(
    { family: "claude", protocol: "anthropic", key: "sk-ant-api03-test", key_env: "ANTHROPIC_API_KEY" },
    { sessionId: "session-test", clientRequestId: "request-test", env: {} }
  );

  assert.equal(headers["x-api-key"], "sk-ant-api03-test");
  assert.equal(headers["user-agent"], undefined);
  assert.equal(headers["x-anthropic-billing-header"], undefined);
});

test("builds Claude Code request metadata and shape for first-party Claude providers", () => {
  const provider = { family: "claude", protocol: "anthropic", upstream_model: "claude-opus-4-8" };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-opus-4-8",
      messages: [
        { role: "system", content: "Use repo rules." },
        { role: "user", content: "Say ok." },
      ],
      max_tokens: 64,
      stream: false,
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
        CLAUDE_CODE_MAX_TOKENS: "32000",
        CLAUDE_CODE_OUTPUT_EFFORT: "high",
      },
    }
  );

  assert.equal(output.model, "claude-opus-4-8");
  assert.equal(output.max_tokens, 32000);
  // metadata.user_id must not be forwarded upstream when derived from Claude Code shape
  assert.deepEqual(output.metadata, {});
  assert.deepEqual(output.thinking, { type: "adaptive" });
  assert.deepEqual(output.context_management, { edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
  assert.deepEqual(output.output_config, { effort: "high" });
  assert.deepEqual(output.system, [
    {
      type: "text",
      text: "x-anthropic-billing-header: cc_version=2.1.150.c38; cc_entrypoint=cli; cch=c1bd7;",
    },
    {
      type: "text",
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: "Use repo rules.", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(output.messages[0], {
    role: "user",
    content: [{ type: "text", text: "Say ok.", cache_control: { type: "ephemeral" } }],
  });
});

test("splits multiline Claude Code billing system text into header and cached system body", () => {
  const provider = { family: "claude", protocol: "anthropic", upstream_model: "claude-sonnet-4-5" };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-sonnet-4-5",
      messages: [
        {
          role: "system",
          content: "x-anthropic-billing-header: cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;\nUse repo rules.",
        },
        { role: "user", content: "Say ok." },
      ],
      max_tokens: 64,
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
      },
    },
  );

  const billingBlock = output.system.find((part) => /^x-anthropic-billing-header:/i.test(part.text || ""));
  assert.equal(billingBlock.text, "x-anthropic-billing-header: cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;");
  assert.equal(billingBlock.cache_control, undefined);
  assert.match(output.system.map((part) => part.text).join("\n"), /Use repo rules\./);
  assert.equal(output.system.at(-1).cache_control?.type, "ephemeral");
});

test("prepends Claude Code SDK system before proxy system for native Claude providers", () => {
  const provider = { family: "claude", protocol: "anthropic", upstream_model: "claude-opus-4-8" };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-opus-4-8",
      messages: [
        { role: "system", content: "LLM proxy routing note: preserve the user request." },
        { role: "user", content: "Say ok." },
      ],
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
      },
    }
  );

  assert.match(output.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.150\.[a-f0-9]{3}; cc_entrypoint=cli; cch=[a-f0-9]{5};$/);
  assert.equal(output.system[0].cache_control, undefined);
  assert.equal(output.system[1].text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.equal(output.system[2].text, "LLM proxy routing note: preserve the user request.");
});

test("caps Claude Code cache_control blocks at Anthropic request limit", () => {
  const provider = { family: "claude", protocol: "anthropic", upstream_model: "claude-opus-4-8" };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-opus-4-8",
      messages: [
        { role: "system", content: "Use repo rules." },
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Message 2" },
        { role: "user", content: "Message 3" },
        { role: "assistant", content: "Message 4" },
        { role: "user", content: "Message 5" },
        { role: "assistant", content: "Message 6" },
      ],
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
      },
    }
  );

  const blocks = [];
  for (const part of output.system || []) blocks.push(part);
  for (const message of output.messages || []) {
    if (Array.isArray(message.content)) blocks.push(...message.content);
  }

  assert.equal(blocks.filter((part) => part?.cache_control?.type === "ephemeral").length, 4);
});

test("drops incompatible temperature for Claude Code thinking requests", () => {
  const provider = { family: "claude", protocol: "anthropic", upstream_model: "claude-opus-4-8" };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "Say ok." }],
      temperature: 0,
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
      },
    }
  );

  assert.deepEqual(output.thinking, { type: "adaptive" });
  assert.equal(output.temperature, undefined);
});

test("does not add Claude Code thinking shape for Haiku providers", () => {
  const provider = { family: "claude", protocol: "anthropic", upstream_model: "claude-haiku-4-5-20251001" };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "Title this session." }],
      temperature: 0,
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
      },
    }
  );

  assert.equal(output.thinking, undefined);
  assert.equal(output.context_management, undefined);
  assert.equal(output.output_config, undefined);
  assert.equal(output.temperature, 0);
});

test("does not add Claude Code adaptive thinking when provider metadata rejects it", () => {
  const provider = {
    family: "claude",
    protocol: "anthropic",
    upstream_model: "claude-sonnet-4-5-20250929",
    supports_adaptive_thinking: false,
    supports_extended_thinking: true,
  };
  const output = anthropic.toAnthropicRequest(
    provider,
    {
      model: "claude/claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "Say ok." }],
      temperature: 0,
    },
    {
      sessionId: "session-from-header",
      env: {
        CLAUDE_CODE_VERSION: "2.1.150",
        CLAUDE_CODE_DEVICE_ID: "device-from-env",
        CLAUDE_CODE_ACCOUNT_UUID: "account-from-env",
      },
    }
  );

  assert.equal(output.thinking, undefined);
  assert.equal(output.context_management, undefined);
  assert.equal(output.output_config, undefined);
  assert.equal(output.temperature, 0);
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

test("postAnthropic appends beta query for Claude Code managed OAuth token", async () => {
  let capturedUrl = "";
  let capturedHeaders = {};
  const server = http.createServer((request, response) => {
    capturedUrl = request.url;
    capturedHeaders = request.headers;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await anthropic.postAnthropic(
      { key: "oauth-token", key_env: "CLAUDE_CODE_OAUTH_TOKEN", url: `http://127.0.0.1:${port}/v1/messages` },
      { model: "claude-sonnet-4-6", max_tokens: 1 },
      {
        env: {
          CLAUDE_CODE_VERSION: "2.1.150",
          CLAUDE_CODE_STAINLESS_PACKAGE_VERSION: "0.94.0",
          CLAUDE_CODE_BETAS: "claude-code-20250219,effort-2025-11-24",
        },
      }
    );

    assert.equal(output.status, 200);
    assert.equal(capturedUrl, "/v1/messages?beta=true");
    assert.equal(capturedHeaders["user-agent"], "claude-cli/2.1.150 (external, cli)");
    assert.equal(capturedHeaders["x-app"], "cli");
    assert.match(capturedHeaders["anthropic-beta"], /claude-code-20250219/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("postAnthropic extracts only the billing header line from multiline system text", async () => {
  let capturedHeaders = {};
  const server = http.createServer((request, response) => {
    capturedHeaders = request.headers;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await anthropic.postAnthropic(
      {
        family: "claude",
        protocol: "anthropic",
        key: "oauth-token",
        key_env: "CLAUDE_CODE_OAUTH_TOKEN",
        url: `http://127.0.0.1:${port}/v1/messages`,
      },
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1,
        system: "x-anthropic-billing-header: cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;\nUse repo rules.",
        messages: [{ role: "user", content: "Say ok." }],
      },
      { env: { CLAUDE_CODE_VERSION: "2.1.150" } },
    );

    assert.equal(output.status, 200);
    assert.equal(capturedHeaders["x-anthropic-billing-header"], "cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("toAnthropicRequest drops trailing artifact-only assistant prefill", () => {
  const request = anthropic.toAnthropicRequest({ upstream_model: "claude-opus-4-8" }, {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: "Check deploy." },
      { role: "assistant", content: "<task-notification>\n\"agent_path\":\"/root/sg_list_agents_v3\",\"status\":\"completed\":null}}\n</task-notification>" },
    ],
  });

  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
});

test("toAnthropicRequest preserves assistant messages with real content", () => {
  const request = anthropic.toAnthropicRequest({ upstream_model: "claude-opus-4-8" }, {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: "Check deploy." },
      { role: "assistant", content: "Deploy looks good. <task-notification>\n\"status\":\"complete\"}\n</task-notification>" },
    ],
  });

  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[1].role, "assistant");
  assert.equal(request.messages[1].content, "Deploy looks good.");
});

test("toAnthropicRequest preserves assistant messages with tool calls", () => {
  const request = anthropic.toAnthropicRequest({ upstream_model: "claude-opus-4-8" }, {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: "Run tests." },
      {
        role: "assistant",
        content: "<task-notification>\n\"status\":\"running\"}\n</task-notification>",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: "\"command\":\"npm test\"}" } }],
      },
    ],
  });

  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[1].role, "assistant");
  assert.equal(request.messages[1].content.length, 1);
});
