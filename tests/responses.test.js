"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const responses = require("../lib/responses");
const routing = require("../lib/routing");
const transforms = require("../lib/transforms");
const state = require("../lib/state");
const providerAdapters = require("../lib/provider-adapters");

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.body = "";
    this.writableEnded = false;
    this.destroyed = false;
    this.endCalls = 0;
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
  }

  write(chunk) {
    if (this.writableEnded) throw new Error("write after end");
    this.body += chunk.toString();
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.endCalls += 1;
    this.emit("close");
  }
}

function parseSseEvents(body = "") {
  return String(body)
    .split(/\n\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice(6).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function withEnv(name, value, fn) {
  const old = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (old == null) delete process.env[name];
    else process.env[name] = old;
  }
}

test("translateInput maps Responses API messages, tools, and model aliases to chat completions", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    instructions: "You are careful.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect this repo." }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      { type: "function_call_output", call_id: "call_1", output: "README contents" },
    ],
    tools: [
      { type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" }, strict: true },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
    max_output_tokens: 1234,
  });

  assert.equal(chat.model, "auto-coding");
  assert.equal(chat.stream, true);
  assert.equal(chat.max_tokens, 1234);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "You are careful." },
    { role: "user", content: "Inspect this repo." },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
    },
    { role: "tool", tool_call_id: "call_1", name: "read_file", content: "README contents" },
  ]);
  assert.deepEqual(chat.tools, [
    { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" }, strict: true } },
  ]);
  assert.equal(chat.tool_choice, "required");
  assert.equal(chat.parallel_tool_calls, false);

  for (const model of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]) {
    assert.equal(responses.translateInput({ model, input: "hello" }).model, "auto-coding");
  }
});

test("translateInput maps Responses function tool_choice objects to Chat Completions shape", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    input: [{ role: "user", content: "Read package.json." }],
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "Read" },
  });

  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "Read" } });
});

test("translateInput forwards Codex deferred and namespace tools as callable chat functions", () => {
  const chat = responses.translateInput({
    model: "gpt-5.5",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use subagents when possible." }],
    tools: [
      {
        type: "tool_search",
        description: "Search deferred tool metadata.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
        },
      },
      {
        type: "namespace",
        name: "multi_agent_v1",
        tools: [
          { type: "function", name: "spawn_agent", description: "Spawn an agent.", parameters: { type: "object" } },
          { type: "function", name: "wait_agent", description: "Wait for agents.", parameters: { type: "object" } },
          { type: "function", name: "close_agent", description: "Close an agent.", parameters: { type: "object" } },
        ],
      },
      {
        type: "namespace",
        name: "mcp__node_repl",
        tools: [
          { type: "function", name: "js", description: "Run JavaScript.", parameters: { type: "object" } },
        ],
      },
      {
        type: "namespace",
        name: "mcp__deerflow",
        tools: [
          { type: "function", name: "research", description: "Run Deerflow research.", parameters: { type: "object" } },
        ],
      },
      {
        type: "namespace",
        name: "mcp__mempalace",
        tools: [
          { type: "function", name: "search", description: "Search memory.", parameters: { type: "object" } },
        ],
      },
      {
        type: "namespace",
        name: "codex_app",
        tools: [
          { type: "function", name: "load_workspace_dependencies", description: "Load bundled runtime paths.", parameters: { type: "object" } },
        ],
      },
      { type: "web_search", external_web_access: true },
    ],
  }, { client: "codex" });

  assert.deepEqual(chat.tools.map((tool) => tool.function.name).slice(0, 9), [
    "tool_search",
    "spawn_agent",
    "wait_agent",
    "close_agent",
    "js",
    "research",
    "search",
    "load_workspace_dependencies",
    "web_search",
  ]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.deferredTools, ["tool_search"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.subagents.slice(0, 4), [
    "multi_agent_v1",
    "spawn_agent",
    "wait_agent",
    "close_agent",
  ]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.mcp, ["mcp__node_repl", "mcp__deerflow", "mcp__mempalace"]);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.web_search.kind, "hosted");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.research.namespace, "mcp__deerflow");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.search.namespace, "mcp__mempalace");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.load_workspace_dependencies.namespace, "codex_app");
  assert.equal(chat.tools.some((tool) => tool.function.name === "send_message_to_thread"), false);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.send_message_to_thread, undefined);
});

test("translateInput preserves custom and hosted Responses tools with registry metadata", async () => {
  await withEnv("LLM_PROXY_CODEX_VIRTUAL_SUBAGENTS", "false", async () => {
    const chat = responses.translateInput({
    model: "gpt-5.5",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Patch and search if needed." }],
    tools: [
      { type: "custom", name: "apply_patch", description: "Apply a patch." },
      { type: "web_search", external_web_access: true },
    ],
    tool_choice: { type: "custom", name: "apply_patch" },
  }, { client: "codex" });

  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ["apply_patch", "web_search", "spawn_agent", "wait_agent", "close_agent", "send_input", "resume_agent", "create_thread", "read_thread", "send_message_to_thread", "list_threads", "set_thread_pinned", "set_thread_archived", "set_thread_title"]);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "apply_patch" } });
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.apply_patch.kind, "custom");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.web_search.kind, "hosted");
  assert.equal(chat.tools[0].function.parameters.required[0], "input");
  });
});

test("translateInput qualifies duplicate namespace child tools instead of dropping them", async () => {
  await withEnv("LLM_PROXY_CODEX_VIRTUAL_SUBAGENTS", "false", async () => {
    const chat = responses.translateInput({
    model: "gpt-5.5",
    input: [{ role: "user", content: "Use the right read tool." }],
    tools: [
      {
        type: "namespace",
        name: "mcp__one",
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      },
      {
        type: "namespace",
        name: "mcp__two",
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      },
    ],
  }, { client: "codex" });

  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ["read", "mcp__two.read", "spawn_agent", "wait_agent", "close_agent", "send_input", "resume_agent", "create_thread", "read_thread", "send_message_to_thread", "list_threads", "set_thread_pinned", "set_thread_archived", "set_thread_title"]);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName["mcp__two.read"].childName, "read");
  });
});

test("translateInput maps Responses custom tool call input/output items to chat tool history", () => {
  const chat = responses.translateInput({
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "applied" },
    ],
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch." }],
  }, { client: "codex" });

  assert.deepEqual(chat.messages, [
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_patch",
        type: "function",
        function: {
          name: "apply_patch",
          arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
        },
      }],
    },
    { role: "tool", tool_call_id: "call_patch", name: "apply_patch", content: "applied" },
  ]);
});

test("translateInput drops tool_choice selectors that do not survive translation", () => {
  const chat = responses.translateInput({
    model: "gpt-5.5",
    input: [{ role: "user", content: "Use the missing tool." }],
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "missing_tool" },
  }, { client: "codex" });

  assert.equal(chat.tool_choice, undefined);
});

test("translateInput forwards detected IDE client metadata for prompt capability scoping", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    input: [{ role: "user", content: "Read package.json." }],
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
  }, { client: "codex" });

  assert.equal(chat._llmProxyClient, "codex");
});

test("translateInput preserves Responses runtime capability contract for routing adapters", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    previous_response_id: "resp_1",
    prompt_cache_key: "cache_1",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use a subagent to inspect logs." }],
    tools: [
      { type: "function", name: "multi_agent_v1.spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      { type: "function", name: "create_goal", parameters: { type: "object" } },
      { type: "function", name: "list_mcp_resources", parameters: { type: "object" } },
      { type: "function", name: "mcp__node_repl", parameters: { type: "object" } },
      { type: "mcp", server_label: "mempalace" },
    ],
  }, {
    client: "codex",
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
      "openai-beta": "responses_websockets=2026-02-06",
    },
  });

  assert.equal(chat._llmProxyClient, "codex");
  assert.equal(chat._llmProxyCapabilityContract.client.id, "codex");
  assert.equal(chat._llmProxyCapabilityContract.runtime.surface, "codex");
  assert.equal(chat._llmProxyCapabilityContract.runtime.toolDialect.previousResponseToolContext, true);
  assert.equal(chat._llmProxyCapabilityContract.runtime.toolDialect.promptCacheKey, true);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.subagents, ["multi_agent_v1.spawn_agent"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.plans, ["update_plan"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.goals, ["create_goal"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.mcpResources, ["list_mcp_resources"]);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.mcp, ["mcp__node_repl"]);
  assert.equal(chat.tools.some((tool) => tool.function.name === "multi_agent_v1.spawn_agent"), true);
  assert.equal(chat.tools.some((tool) => tool.function.name === "spawn_agent"), false);
});

test("translateInput keeps tool_search alongside proxy-hosted Codex virtual subagent placeholders", async () => {
  const chat = responses.translateInput({
    model: "gpt-5.4-mini",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use subagents if helpful." }],
    tools: [
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      { type: "function", name: "functions.exec_command", parameters: { type: "object" } },
      { type: "tool_search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    ],
  }, {
    client: "codex",
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
    },
  });

  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.includes("tool_search"), true);
  assert.equal(names.includes("spawn_agent"), true);
  assert.equal(names.includes("wait_agent"), true);
  assert.equal(names.includes("close_agent"), true);
  assert.equal(names.includes("send_message_to_thread"), true);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.kind, "virtual_codex_subagent");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, true);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.shadowOnly, undefined);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.deferredTools, ["tool_search"]);
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), true);

  const transformed = await transforms.transformRequest({
    name: "Codex-Test",
    model: "test-model",
    protocol: "openai",
    max_context: 128000,
  }, chat);
  const system = transformed.messages[0].content;
  assert.match(system, /Deferred tool discovery: available via tool_search/i);
  assert.match(system, /Subagents: available via .*spawn_agent/i);
  assert.doesNotMatch(system, /Subagents: deferred via tool_search/i);
});

test("translateInput auto-detects Codex metadata and proxy-hosts bare spawn_agent", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4-mini",
    metadata: { originator: "Codex Desktop" },
    input: "Try a sidecar subagent.",
    tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object" } },
      { type: "tool_search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    ],
    tool_choice: { type: "function", name: "spawn_agent" },
  });

  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.includes("spawn_agent"), true);
  assert.equal(names.includes("tool_search"), true);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "spawn_agent" } });
  assert.equal(chat._llmProxyClient, "codex");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.kind, "virtual_codex_subagent");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, true);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.shadowOnly, undefined);
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), true);
});

test("translateInput proxy-hosts bare Codex spawn_agent when deferred discovery is absent", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4-mini",
    metadata: { originator: "Codex Desktop" },
    input: "Try a sidecar subagent.",
    tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "update_plan", parameters: { type: "object" } },
    ],
    tool_choice: { type: "function", name: "spawn_agent" },
  });

  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.includes("spawn_agent"), true);
  assert.equal(chat.tool_choice.function.name, "spawn_agent");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.kind, "virtual_codex_subagent");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, true);
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), true);
});

test("translateInput injects Codex virtual subagents when native targets are absent", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4-mini",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use subagents if helpful." }],
    tools: [
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      { type: "function", name: "functions.exec_command", parameters: { type: "object" } },
    ],
  }, {
    client: "codex",
    headers: { "user-agent": "Codex Desktop/0.136.0-alpha.2" },
  });

  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.includes("spawn_agent"), true);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, true);
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), true);
});

test("translateInput prefers native Codex multi_agent_v1 subagents when present", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4-mini",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use subagents if helpful." }],
    tools: [
      { type: "function", name: "multi_agent_v1.spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "multi_agent_v1.wait_agent", parameters: { type: "object" } },
      { type: "function", name: "update_plan", parameters: { type: "object" } },
    ],
  }, {
    client: "codex",
    headers: { "user-agent": "Codex Desktop/0.136.0-alpha.2" },
  });

  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.includes("spawn_agent"), false);
  assert.equal(names.includes("multi_agent_v1.spawn_agent"), true);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, false);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.shadowOnly, true);
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), false);
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("multi_agent_v1.spawn_agent"), true);
});

test("translateInput forces proxyHosted=false for virtual subagents when FORCE_NATIVE_SUBAGENTS=true", async () => {
  await withEnv("LLM_PROXY_CODEX_FORCE_NATIVE_SUBAGENTS", "true", async () => {
    const chat = responses.translateInput({
      model: "gpt-5.4-mini",
      client_metadata: { originator: "Codex Desktop" },
      input: [{ role: "user", content: "Use subagents if helpful." }],
      tools: [
        { type: "function", name: "update_plan", parameters: { type: "object" } },
        { type: "function", name: "functions.exec_command", parameters: { type: "object" } },
      ],
    }, {
      client: "codex",
      headers: { "user-agent": "Codex Desktop/0.136.0-alpha.2" },
    });

    const names = chat.tools.map((tool) => tool.function.name);
    assert.equal(names.includes("spawn_agent"), true);
    assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.kind, "virtual_codex_subagent");
    assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, false);
    assert.equal(chat._llmProxyResponsesToolRegistry.byName.spawn_agent.nativeTarget, "multi_agent_v1.spawn_agent");
  });
});

test("translateInput keeps non-subagent capabilities conditional while Codex virtual subagents stay on", async () => {
  await withEnv("LLM_PROXY_CODEX_VIRTUAL_SUBAGENTS", "false", async () => {
    const chat = responses.translateInput({
    model: "gpt-5.4-mini",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Check whether subagents work in this session." }],
    tools: [
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      { type: "function", name: "functions.exec_command", parameters: { type: "object" } },
      { type: "function", name: "list_mcp_resources", parameters: { type: "object" } },
      { type: "function", name: "list_mcp_resource_templates", parameters: { type: "object" } },
      { type: "function", name: "read_mcp_resource", parameters: { type: "object" } },
    ],
  }, {
    client: "codex",
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
      "openai-beta": "responses_websockets=2026-02-06",
    },
  });

  assert.equal(chat._llmProxyCapabilityContract.client.id, "codex");
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), true);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.goals, []);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.mcp, []);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.mcpResources, ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  assert.equal(chat._llmProxyCapabilityContract.missing.subagents, undefined);
  assert.equal(chat._llmProxyCapabilityContract.missing.goals, undefined);

  const transformed = await transforms.transformRequest({
    name: "Codex-Test",
    model: "test-model",
    protocol: "openai",
    max_context: 128000,
  }, chat);
  const system = transformed.messages[0].content;
  assert.match(system, /Subagents: available via .*spawn_agent/i);
  assert.match(system, /MCP resources\/templates: listing access is available/i);
  assert.match(system, /Empty resources\/templates output is normal/i);
  assert.doesNotMatch(system, /MCP tools: available/i);
  assert.match(system, /Do not infer Codex subagent\/thread tools from app-context docs/i);
  assert.doesNotMatch(system, /Expected executable tools/i);
  });
});

test("translateInput forwards Codex deferred tool discovery alongside proxy-hosted subagents", async () => {
  await withEnv("LLM_PROXY_CODEX_VIRTUAL_SUBAGENTS", "false", async () => {
    const chat = responses.translateInput({
    model: "gpt-5.5",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use subagents for this if possible." }],
    tools: [
      { type: "function", name: "tool_search", parameters: { type: "object" } },
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      { type: "function", name: "functions.exec_command", parameters: { type: "object" } },
    ],
  }, {
    client: "codex",
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
    },
  });

  assert.equal(chat.model, "auto-coding");
  assert.equal(chat._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), true);
  assert.deepEqual(chat._llmProxyCapabilityContract.capabilities.deferredTools, ["tool_search"]);

  const transformed = await transforms.transformRequest({
    name: "Codex-Test",
    model: "test-model",
    protocol: "openai",
    max_context: 128000,
  }, chat);
  const system = transformed.messages[0].content;
  assert.match(system, /Deferred tool discovery: available via tool_search/i);
  assert.match(system, /Subagents: available via .*spawn_agent/i);
  assert.doesNotMatch(system, /Subagents: deferred via tool_search/i);
  assert.match(system, /Use subagents whenever possible for independent research/i);
});
});

test("translateInput maps OpenAI SDK chat-style Responses input and JSON schema format", () => {
  const schema = {
    type: "object",
    properties: { facts: { type: "array", items: { type: "string" } } },
    required: ["facts"],
    additionalProperties: false,
  };

  const chat = responses.translateInput({
    model: "auto-sm",
    input: [
      { role: "system", content: "Extract structured facts." },
      {
        role: "user",
        content: [
          { type: "text", text: "Project uses Graphiti as optional sidecar." },
          { type: "input_text", text: "Canonical memory remains Neo4j." },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "GraphitiFacts",
        schema,
        strict: true,
      },
    },
    max_output_tokens: 321,
  });

  assert.equal(chat.model, "auto-sm");
  assert.equal(chat.max_tokens, 321);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "Extract structured facts." },
    { role: "user", content: "Project uses Graphiti as optional sidecar.\nCanonical memory remains Neo4j." },
  ]);
  assert.deepEqual(chat.response_format, {
    type: "json_schema",
    json_schema: {
      name: "GraphitiFacts",
      schema,
      strict: true,
    },
  });
});

test("translateInput preserves Responses input_image parts as OpenAI image_url parts", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What changed visually?" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      },
    ],
  });

  assert.deepEqual(chat.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "What changed visually?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  ]);
});

test("MockResponse converts chat completion SSE text stream into Responses API events", () => {
  const events = [];
  let done = false;
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => { done = true; },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n');
  res.end();

  assert.equal(done, true);
  assert.equal(events[0].type, "response.created");
  assert.equal(events.some((event) => event.type === "response.output_item.added" && event.item.type === "message"), true);
  assert.deepEqual(
    events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta),
    ["Hel", "lo"],
  );
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text, "Hello");
  assert.deepEqual(completed.response.usage, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });
});

test("MockResponse strips split private assessment metadata from Responses API deltas", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"Updated docs.\\n\\n"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"LLM_PROXY_INTERNAL_ROUTING effort=low speed=4"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":" reason=monitoring"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  assert.equal(deltas.includes("Updated docs."), true);
  assert.equal(deltas.includes("effort=low"), false);
  assert.equal(deltas.includes("speed=4"), false);
  assert.equal(deltas.includes("reason=monitoring"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text.includes("effort=low"), false);
});

test("MockResponse strips split speed-only private assessment metadata from Responses API deltas", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"LLM_PROXY_INTERNAL_ROUTING spe"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"ed=4 reason=commit_changes\\n\\nCommitted changes."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  assert.equal(deltas.includes("Committed changes."), true);
  assert.equal(deltas.includes("speed=4"), false);
  assert.equal(deltas.includes("reason=commit_changes"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text.includes("commit_changes"), false);
});

test("MockResponse strips task notification artifact blocks from Responses API deltas", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"Before\\n<task-notification>\\n{\\"agent_path\\":\\"/root/sg_list_agents_v3\\",\\"status\\":{\\"completed\\":null}}\\n</task-notification>\\nAfter"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  assert.equal(deltas.includes("Before"), true);
  assert.equal(deltas.includes("After"), true);
  assert.equal(deltas.includes("task-notification"), false);
  assert.equal(deltas.includes("agent_path"), false);
  const completed = events.find((event) => event.type === "response.completed");
  const text = completed.response.output[0].content[0].text;
  assert.equal(text.includes("task-notification"), false);
  assert.equal(text.includes("agent_path"), false);
});

test("handleResponsesHTTP strips artifact text from stored history replay", async () => {
  const captured = [];
  responses.init({
    handleChatCompletion: async (req, res) => {
      captured.push(JSON.parse(JSON.stringify(req)));
      res.writeHead(200, { "Content-Type": "application/json" });
      if (captured.length === 1) {
        res.end(JSON.stringify({
          id: "chatcmpl_artifact_tool",
          object: "chat.completion",
          created: 1779437101,
          model: req.model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
	      tool_calls: [{
	        id: "call_artifact",
	        type: "function",
	        function: { name: "Read", arguments: "{\"file_path\":\"/tmp/example\"}" },
	      }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "chatcmpl_artifact_done",
        object: "chat.completion",
        created: 1779437102,
        model: req.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Clean summary." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      }));
    },
  });

  const makeRes = () => ({
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  });

  const first = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex/1.0" } },
    first,
    JSON.stringify({
      model: "gpt-5.4",
	      input: [{ role: "user", content: "Use a tool." }],
	      tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      tool_choice: "required",
    }),
  );
  const firstBody = JSON.parse(first.body);
  const callId = firstBody.output.find((item) => item.type === "function_call").call_id;

  const second = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex/1.0" } },
    second,
    JSON.stringify({
      model: "gpt-5.4",
      previous_response_id: firstBody.id,
      input: [{
        type: "function_call_output",
        call_id: callId,
        output: "Before\n<task-notification>\n{\"agent_path\":\"/root/sg_list_agents_v3\",\"status\":{\"completed\":null}}\n</task-notification>\nAfter",
      }],
    }),
  );

  assert.equal(second.statusCode, 200);
  const stored = responses.responseContextForPreviousResponse({ previous_response_id: firstBody.id });
  const serialized = JSON.stringify(stored.messages);
  assert.equal(serialized.includes("task-notification"), false);
  assert.equal(serialized.includes("agent_path"), false);
  assert.equal(serialized.includes("/root/sg_list_agents_v3"), false);
  assert.equal(serialized.includes("Before"), false);
  assert.equal(serialized.includes("After"), false);
});

test("MockResponse strips split legacy bare assessment metadata from Responses API deltas", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"eff"},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"ort=low speed=4 reason=playwright_smoke\\n\\nSmoke passed."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  assert.equal(deltas.includes("Smoke passed."), true);
  assert.equal(deltas.includes("effort=low"), false);
  assert.equal(deltas.includes("reason=playwright_smoke"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].content[0].text.includes("playwright_smoke"), false);
});

test("MockResponse converts streaming tool call deltas into Responses function_call events", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  const added = events.find((event) => event.type === "response.output_item.added" && event.item.type === "function_call");
  assert.equal(added.item.call_id, "call_1");
  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  assert.equal(argsDone.name, "read_file");
  assert.equal(argsDone.arguments, "{\"path\":\"README.md\"}");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].type, "function_call");
  assert.equal(completed.response.output[0].arguments, "{\"path\":\"README.md\"}");
});

test("MockResponse finalizes streaming tool calls when upstream finishes with stop", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
    { client: "codex" },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_search","type":"function","function":{"name":"tool_search","arguments":"{\\"query\\":\\"spawn_agent\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();

  const added = events.find((event) => event.type === "response.output_item.added");
  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  const itemDone = events.find((event) => event.type === "response.output_item.done" && event.item.type === "function_call");
  assert.equal(added.item.name, "tool_search");
  assert.equal(argsDone.call_id, "call_search");
  assert.equal(argsDone.arguments, "{\"query\":\"spawn_agent\"}");
  assert.equal(itemDone.item.status, "completed");
  assert.equal(events.filter((event) => event.type === "response.function_call_arguments.done").length, 1);
});

test("MockResponse passes streamed Codex virtual subagent calls through by default", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
    {
      client: "codex",
      toolRegistry: {
        byName: {
          spawn_agent: { kind: "virtual_codex_subagent", discoveryQuery: "spawn_agent", proxyHosted: false },
          tool_search: { kind: "deferred" },
        },
      },
    },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_spawn","type":"function","function":{"name":"spawn_agent","arguments":"\\"message\\":\\"Inspect logs\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  const added = events.find((event) => event.type === "response.output_item.added");
  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(added.item.name, "spawn_agent");
  assert.equal(argsDone.call_id, "call_spawn");
  assert.equal(argsDone.name, "spawn_agent");
  assert.equal(argsDone.arguments, "\"message\":\"Inspect logs\"}");
  assert.equal(completed.response.output[0].name, "spawn_agent");
});

test("MockResponse routes proxy-hosted Codex virtual subagent calls through tool_search", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
    {
      client: "codex",
      toolRegistry: {
        byName: {
          spawn_agent: { kind: "virtual_codex_subagent", discoveryQuery: "spawn_agent", proxyHosted: true },
          tool_search: { kind: "deferred" },
        },
      },
    },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_spawn","type":"function","function":{"name":"spawn_agent","arguments":"\\"message\\":\\"Inspect logs\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  const added = events.find((event) => event.type === "response.output_item.added");
  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(added.item.name, "tool_search");
  assert.equal(argsDone.call_id, "call_spawn");
  assert.equal(argsDone.name, "tool_search");
  assert.equal(argsDone.arguments, '{"query":"spawn_agent","limit":8}');
  assert.equal(completed.response.output[0].name, "tool_search");
});

test("MockResponse finalizes streaming tool calls when upstream only sends DONE", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
    { client: "codex" },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_search","type":"function","function":{"name":"tool_search","arguments":"{\\"query\\":\\"create_thread\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write("data: [DONE]\n\n");
  res.end();

  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(argsDone.call_id, "call_search");
  assert.equal(argsDone.name, "tool_search");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["function_call"]);
  assert.equal(completed.response.output[0].status, "completed");
});

test("MockResponse converts custom tool calls into Responses custom_tool_call items", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
    {
      toolRegistry: {
        byName: { apply_patch: { kind: "custom", name: "apply_patch" } },
      },
    },
  );

  res.writeHead(200);
  res.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_patch",
          type: "function",
          function: { name: "apply_patch", arguments: "{\"input\":\"*** Begin Patch\\n*** End Patch\"}" },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  const added = events.find((event) => event.type === "response.output_item.added");
  const inputDone = events.find((event) => event.type === "response.custom_tool_call_input.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(added.item.type, "custom_tool_call");
  assert.equal(inputDone.input, "*** Begin Patch\n*** End Patch");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["custom_tool_call"]);
  assert.equal(completed.response.output[0].input, "*** Begin Patch\n*** End Patch");
});

test("MockResponse keeps distinct output indexes for mixed text and tool call streams", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"I will inspect that."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\""}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"package.json\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  const messageAdded = events.find((event) => event.type === "response.output_item.added" && event.item.type === "message");
  const toolAdded = events.find((event) => event.type === "response.output_item.added" && event.item.type === "function_call");
  const textDone = events.find((event) => event.type === "response.output_text.done");
  const argsDone = events.find((event) => event.type === "response.function_call_arguments.done");
  assert.equal(messageAdded.output_index, 0);
  assert.equal(toolAdded.output_index, 1);
  assert.equal(textDone.output_index, 0);
  assert.equal(argsDone.output_index, 1);

  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(completed.response.output[0].content[0].text, "I will inspect that.");
  assert.equal(completed.response.output[1].arguments, "{\"file_path\":\"package.json\"}");
});

test("MockResponse suppresses mixed visible text for Codex when streaming tool calls", () => {
  const events = [];
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => {},
    { client: "codex" },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"Need plan skill before implementation."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\""}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"echo test\\"}"}}]},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.end();

  assert.equal(events.some((event) => event.type === "response.output_text.delta"), false);
  assert.equal(events.some((event) => event.type === "response.output_text.done"), false);
  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["function_call"]);
  assert.equal(completed.response.output[0].arguments, "{\"cmd\":\"echo test\"}");
});

test("MockResponse end is idempotent after routed streams close internally", () => {
  const events = [];
  let doneCalls = 0;
  const res = new responses.MockResponse(
    (event) => events.push(event),
    (status, body) => events.push({ type: "error", status, body }),
    () => { doneCalls += 1; },
  );

  res.writeHead(200);
  res.write('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end();
  res.end();

  assert.equal(doneCalls, 1);
  assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
});

test("mergeHistory trims long Responses conversations even when a system message is pinned first", () => {
  const conversationHistory = [{ role: "system", content: "System rules." }];
  for (let i = 0; i < 420; i += 1) {
    conversationHistory.push({ role: "user", content: `message ${i}` });
  }

  const merged = responses.mergeHistory(
    {
      messages: [{ role: "user", content: "latest turn" }],
    },
    conversationHistory,
  );

  assert.equal(merged.length, 400);
  assert.equal(merged[0].role, "system");
  assert.equal(merged[1].content, "message 22");
  assert.equal(merged.at(-1).content, "latest turn");
});

test("rememberResponseHistory trims oversized previous_response snapshots", () => {
  const messages = [{ role: "system", content: "System rules." }];
  for (let i = 0; i < 450; i += 1) {
    messages.push({ role: "tool", content: `tool output ${i}: ${"x".repeat(2000)}` });
  }

  responses.rememberResponseHistory("resp_trim_test", messages, {
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
    tool_choice: "required",
  });

  const stored = responses.responseContextForPreviousResponse({ previous_response_id: "resp_trim_test" });
  assert.ok(stored);
  assert.equal(stored.messages[0].role, "system");
  assert.ok(stored.messages.length <= 400);
  const totalChars = stored.messages.reduce((sum, message) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    return sum + content.length;
  }, 0);
  assert.ok(totalChars <= 260000);
  assert.equal(stored.tool_choice, "required");
});

test("handleResponsesHTTP ignores duplicate internal stream closes", async () => {
  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end();
      res.end();
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    { headers: { accept: "text/event-stream" } },
    res,
    JSON.stringify({ model: "gpt-5.4", stream: true, input: "hi" }),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.endCalls, 1);
  assert.equal((res.body.match(/response.completed/g) || []).length, 1);
});

test("handleResponsesHTTP sends translated Responses requests as internal proxy traffic", async () => {
  let capturedReq;
  let capturedOptions;
  responses.init({
    handleChatCompletion: async (req, res, options) => {
      capturedReq = req;
      capturedOptions = options;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_1",
        model: "auto-coding",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    {
      headers: {
        accept: "application/json",
        "user-agent": "Codex Desktop/0.136.0-alpha.2",
        "openai-beta": "responses_websockets=2026-02-06",
      },
    },
    res,
    JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      previous_response_id: "resp_1",
      input: "continue",
      tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
    }),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(capturedOptions.internal, true);
  assert.equal(capturedReq._llmProxyClient, "codex");
  assert.equal(capturedReq._llmProxyCapabilityContract.runtime.surface, "codex");
  assert.equal(capturedReq._llmProxyCapabilityContract.runtime.toolDialect.previousResponseToolContext, true);
  assert.equal(capturedReq._llmProxyCapabilityContract.capabilities.subagents.includes("spawn_agent"), true);
  assert.equal(capturedReq.tools.some((tool) => tool.function.name === "spawn_agent"), true);
});

test("handleResponsesHTTP proxy-hosts injected Codex virtual subagent calls by default", async () => {
  const capturedReqs = [];
  responses.init({
    handleChatCompletion: async (req, res) => {
      capturedReqs.push(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req._llmProxyClient === "codex_virtual_subagent") {
        res.end(JSON.stringify({
          id: "chatcmpl_virtual_worker",
          model: req.model,
          choices: [{ index: 0, message: { role: "assistant", content: "Virtual worker inspected logs." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }));
        return;
      }
      if (req.messages.some((message) => message.role === "tool" && message.name === "spawn_agent")) {
        res.end(JSON.stringify({
          id: "chatcmpl_virtual_done",
          model: req.model,
          choices: [{ index: 0, message: { role: "assistant", content: "Finished after proxy-hosted subagent." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "chatcmpl_virtual_agent",
        model: req.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_spawn_virtual",
              type: "function",
              function: {
                name: "spawn_agent",
                arguments: "{\"message\":\"Inspect logs\",\"agent_type\":\"explorer\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    {
      headers: {
        accept: "application/json",
        "user-agent": "Codex Desktop/0.136.0-alpha.2",
      },
    },
    res,
    JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "Use a subagent for independent log inspection.",
      tools: [
        { type: "function", name: "exec_command", parameters: { type: "object" } },
        { type: "tool_search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      ],
    }),
  );

  const body = JSON.parse(res.body);
  const firstReq = capturedReqs[0];
  const toolNames = firstReq.tools.map((tool) => tool.function.name);
  assert.equal(toolNames.includes("spawn_agent"), true);
  assert.equal(toolNames.includes("tool_search"), true);
  assert.equal(firstReq._llmProxyResponsesToolRegistry.byName.spawn_agent.kind, "virtual_codex_subagent");
  assert.equal(firstReq._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, true);
  assert.equal(capturedReqs.some((req) => req._llmProxyClient === "codex_virtual_subagent"), true);
  assert.equal(body.output[0].type, "message");
  assert.match(body.output[0].content[0].text, /Finished after proxy-hosted subagent/);
});

test("proxy-hosted subagent forwards no tools and reports honestly when the worker only emits tool calls", async () => {
  let subagentReq = null;
  let spawnToolResult = "";
  responses.init({
    handleChatCompletion: async (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req._llmProxyClient === "codex_virtual_subagent") {
        subagentReq = req;
        // Worker tries to call a host tool; nothing executes it, so content is empty.
        res.end(JSON.stringify({
          id: "chatcmpl_worker_toolonly",
          model: req.model,
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
            { id: "c_exec", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } },
          ] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }));
        return;
      }
      const toolMsg = req.messages.find((m) => m.role === "tool" && m.name === "spawn_agent");
      if (toolMsg) {
        spawnToolResult = typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content);
        res.end(JSON.stringify({
          id: "chatcmpl_after",
          model: req.model,
          choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "chatcmpl_main",
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
          { id: "call_spawn", type: "function", function: { name: "spawn_agent", arguments: "{\"message\":\"Read /etc/hosts\"}" } },
        ] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex Desktop/0.136.0-alpha.2" } },
    res,
    JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "Spawn a subagent to read a host file.",
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    }),
  );

  // The subagent sub-completion must NOT receive forwarded tools (it has no executor).
  assert.ok(subagentReq, "subagent completion ran");
  assert.equal(subagentReq.tools, undefined);
  // The spawn_agent tool result must explain the no-host-access limit, not be empty.
  assert.match(spawnToolResult, /without host tool access|could not execute|exec_command/);
  assert.doesNotMatch(spawnToolResult, /No textual result returned/);
});

test("handleResponsesHTTP proxy-hosts bare Codex subagent placeholders before client execution", async () => {
  const capturedReqs = [];
  responses.init({
    handleChatCompletion: async (req, res) => {
      capturedReqs.push(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req._llmProxyClient === "codex_virtual_subagent") {
        res.end(JSON.stringify({
          id: "chatcmpl_bare_worker",
          model: req.model,
          choices: [{ index: 0, message: { role: "assistant", content: "Bare placeholder handled internally." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }));
        return;
      }
      if (req.messages.some((message) => message.role === "tool" && message.name === "spawn_agent")) {
        res.end(JSON.stringify({
          id: "chatcmpl_bare_done",
          model: req.model,
          choices: [{ index: 0, message: { role: "assistant", content: "Finished without exposing unsupported spawn_agent to Codex." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "chatcmpl_bare_agent",
        model: req.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_spawn_bare",
              type: "function",
              function: {
                name: "spawn_agent",
                arguments: "{\"message\":\"Inspect logs\",\"agent_type\":\"explorer\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    {
      headers: {
        accept: "application/json",
        "user-agent": "Codex Desktop/0.136.0-alpha.2",
      },
    },
    res,
    JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "Use a subagent for independent log inspection.",
      tools: [
        { type: "function", name: "spawn_agent", parameters: { type: "object" } },
        { type: "tool_search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      ],
    }),
  );

  const body = JSON.parse(res.body);
  const firstReq = capturedReqs[0];
  const toolNames = firstReq.tools.map((tool) => tool.function.name);
  assert.equal(toolNames.includes("spawn_agent"), true);
  assert.equal(toolNames.includes("tool_search"), true);
  assert.equal(firstReq._llmProxyResponsesToolRegistry.byName.spawn_agent.kind, "virtual_codex_subagent");
  assert.equal(firstReq._llmProxyResponsesToolRegistry.byName.spawn_agent.proxyHosted, true);
  assert.equal(capturedReqs.some((req) => req._llmProxyClient === "codex_virtual_subagent"), true);
  assert.equal(body.output[0].type, "message");
  assert.match(body.output[0].content[0].text, /Finished without exposing unsupported spawn_agent to Codex/);
});

test("handleResponsesHTTP preserves namespace-declared Codex subagent calls", async () => {
  let capturedReq;
  responses.init({
    handleChatCompletion: async (req, res) => {
      capturedReq = req;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_real_agent",
        model: req.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_spawn_real",
              type: "function",
              function: {
                name: "spawn_agent",
                arguments: "{\"message\":\"Inspect logs\",\"agent_type\":\"explorer\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    {
      headers: {
        accept: "application/json",
        "user-agent": "Codex Desktop/0.136.0-alpha.2",
      },
    },
    res,
    JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "Use a subagent for independent log inspection.",
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [
            { type: "function", name: "spawn_agent", parameters: { type: "object" } },
          ],
        },
      ],
    }),
  );

  const body = JSON.parse(res.body);
  assert.equal(capturedReq._llmProxyResponsesToolRegistry.byName.spawn_agent.kind, "namespace_function");
  assert.equal(capturedReq._llmProxyResponsesToolRegistry.byName.spawn_agent.namespace, "multi_agent_v1");
  assert.equal(body.output[0].type, "function_call");
  // Codex routes by a separate (namespace, name) pair (ResponseItem::FunctionCall
  // has a `namespace` field; names must match ^[a-zA-Z0-9_-]+$). The name stays
  // bare and the reserved namespace is re-attached, else the runtime rejects it
  // as "unsupported call".
  assert.equal(body.output[0].name, "spawn_agent");
  assert.equal(body.output[0].namespace, "multi_agent_v1");
  assert.equal(body.output[0].call_id, "call_spawn_real");
  assert.equal(body.output[0].arguments, "{\"message\":\"Inspect logs\",\"agent_type\":\"explorer\"}");
});

test("handleResponsesHTTP re-attaches the namespace for Codex MCP/app tool calls", async () => {
  // Regression: a real Codex session declares js/mempalace_*/read_thread_terminal
  // under mcp__node_repl / mcp__mempalace / codex_app namespaces. The proxy must
  // forward bare child names to the provider but return them with the originating
  // `namespace` field so Codex's (namespace, name) router matches the handler
  // instead of failing with "unsupported call".
  let capturedReq;
  responses.init({
    handleChatCompletion: async (req, res) => {
      capturedReq = req;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_ns",
        model: req.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "js", arguments: "{\"code\":\"1+1\"}" } },
              { id: "c2", type: "function", function: { name: "mempalace_search", arguments: "{\"query\":\"x\"}" } },
              { id: "c3", type: "function", function: { name: "read_thread_terminal", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex Desktop/0.136.0-alpha.2" } },
    res,
    JSON.stringify({
      model: "gpt-5.5",
      stream: false,
      input: "Run js, search memory, read the terminal.",
      tools: [
        { type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", parameters: { type: "object" } }] },
        { type: "namespace", name: "mcp__mempalace", tools: [{ type: "function", name: "mempalace_search", parameters: { type: "object" } }] },
        { type: "namespace", name: "codex_app", tools: [{ type: "function", name: "read_thread_terminal", parameters: { type: "object" } }] },
      ],
    }),
  );

  // Provider received bare child names (upstream function-name regex rejects dots).
  const forwardedNames = (capturedReq.tools || []).map((t) => t.function?.name);
  assert.ok(forwardedNames.includes("js"));
  assert.ok(forwardedNames.includes("mempalace_search"));
  assert.ok(forwardedNames.includes("read_thread_terminal"));

  // Client receives bare names plus the originating namespace field.
  const body = JSON.parse(res.body);
  const calls = body.output.filter((o) => o.type === "function_call");
  const byCall = Object.fromEntries(calls.map((c) => [c.call_id, c]));
  assert.equal(byCall.c1.name, "js");
  assert.equal(byCall.c1.namespace, "mcp__node_repl");
  assert.equal(byCall.c2.name, "mempalace_search");
  assert.equal(byCall.c2.namespace, "mcp__mempalace");
  assert.equal(byCall.c3.name, "read_thread_terminal");
  assert.equal(byCall.c3.namespace, "codex_app");
});

test("translateInput forwards a replayed namespaced tool call to the provider by its bare name", () => {
  // Codex replays the call as a bare name + separate namespace field; the provider
  // only knows the flat name, so the namespace is dropped on the way in.
  const chat = responses.translateInput({
    model: "gpt-5.5",
    input: [
      { role: "user", content: "again" },
      { type: "function_call", call_id: "c9", name: "js", namespace: "mcp__node_repl", arguments: "{\"code\":\"2\"}" },
      { type: "function_call_output", call_id: "c9", output: "2" },
    ],
    tools: [
      { type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js", parameters: { type: "object" } }] },
    ],
  }, { client: "codex" });

  const assistant = chat.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.equal(assistant.tool_calls[0].function.name, "js");
  const toolResult = chat.messages.find((m) => m.role === "tool" && m.tool_call_id === "c9");
  assert.equal(toolResult.name, "js");
});

test("handleResponsesHTTP strips Claude-style subagent workflow artifacts from visible response text", async () => {
  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_artifacts",
        model: "auto-coding",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: [
              "<task-notification>",
              "<task-id>wrx4h43pf</task-id>",
              "<tool-use-id>call_uCKSuRhIOXkWkhEh6cH4WlMm</tool-use-id>",
              "<summary>Dynamic workflow completed</summary>",
              "<result>{\"summary\":\"internal artifact\"}</result>",
              "</task-notification>",
              "Show less",
              "Update Todos",
              "Revert capabilityRequestBase that broke 3 tests",
              "Historical tool invocation (already executed): Bash {\"command\":\"pwd\"}",
              "Run full test suite and verify",
              "agentId: aac16101ca904c21e (use SendMessage with to: 'aac16101ca904c21e' to continue this agent)",
              "<usage>total_tokens: 0",
              "tool_uses: 0",
              "duration_ms: 182138</usage>",
            ].join("\n"),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    },
  });

  const res = new FakeSseResponse();
  await responses.handleResponsesHTTP(
    {
      headers: {
        accept: "application/json",
        "user-agent": "Claude-Code/2.1.165",
      },
    },
    res,
    JSON.stringify({
      model: "auto-coding",
      stream: false,
      input: "Continue the task.",
    }),
  );

  const body = JSON.parse(res.body);
  const text = body.output[0].content[0].text;
  assert.match(text, /Revert capabilityRequestBase that broke 3 tests/);
  assert.match(text, /Run full test suite and verify/);
  assert.doesNotMatch(text, /task-notification|tool-use-id|Show less|Update Todos/i);
  assert.doesNotMatch(text, /Historical tool invocation|agentId:|SendMessage|<usage>|total_tokens/i);
});

test("translateInput injects proxy-hosted Codex placeholders when flat native aliases are present but other virtual tools are absent", () => {
  const chat = responses.translateInput({
    model: "gpt-5.4",
    client_metadata: { originator: "Codex Desktop" },
    input: [{ role: "user", content: "Use thread or subagent helpers if needed." }],
    tools: [
      { type: "function", name: "multi_agent_v1.spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "update_plan", parameters: { type: "object" } },
    ],
  }, {
    client: "codex",
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
    },
  });

  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.includes("multi_agent_v1.spawn_agent"), true);
  assert.equal(names.includes("spawn_agent"), false);
  assert.equal(names.includes("wait_agent"), true);
  assert.equal(names.includes("create_thread"), true);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.wait_agent.kind, "virtual_codex_subagent");
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.wait_agent.proxyHosted, true);
  assert.equal(chat._llmProxyResponsesToolRegistry.byName.create_thread.proxyHosted, true);
});

test("handleResponsesHTTP keeps Codex loop alive by returning function_call after hidden continuation", async () => {
  const originalProviders = state.PROVIDERS;
  const originalGroups = state.GROUPS;
  const originalRouteNativeStream = providerAdapters.routeNativeStream;
  const originalLog = state.log;
  const originalWriteFileSync = fs.writeFileSync;
  const originalScores = state.scores;
  const originalAiAssessment = process.env.LLM_PROXY_AI_ASSESSMENT;
  const originalMaxRetries = process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES;
  const calls = [];
  const logs = [];

  try {
    state.PROVIDERS = [{
      name: "Responses-Native-Loop",
      model: "windsurf/responses-native-loop",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
    }];
    state.GROUPS = { "auto-coding": "coding" };
    state.scores = {};
    state.log = (message) => logs.push(String(message));
    fs.writeFileSync = () => {};
    process.env.LLM_PROXY_AI_ASSESSMENT = "off";
    process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES = "3";
    routing.init({
      sendError: (res, status, message, extra = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, ...extra } }));
      },
      trackSessionTokens: () => {},
    });
    responses.init({ handleChatCompletion: routing.handleChatCompletion });

    providerAdapters.routeNativeStream = async (provider, body, handlers) => {
      const userMessages = body.messages?.filter((message) => message.role === "user") || [];
      calls.push({
        provider: provider.name,
        userCount: userMessages.length,
        lastUser: userMessages.at(-1)?.content,
      });

      if (calls.length === 1) {
        handlers.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: [
          "[5/N] Checking the identity provider route for membership state.",
          "Next step: inspect the membership API response and rerun Playwright.",
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
              id: "call_account_api",
              type: "function",
              function: {
                name: "exec_command",
                arguments: "{\"cmd\":\"curl -s http://localhost:5173/api/user/memberships\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      handlers.onChunk("data: [DONE]\n\n");
    };

    const res = new FakeSseResponse();
    await responses.handleResponsesHTTP(
      { headers: { accept: "text/event-stream" } },
      res,
      JSON.stringify({
        model: "auto-coding",
        stream: true,
        input: [
          { role: "user", content: "Continue fixing the identity provider route and verify it." },
          { type: "function_call", call_id: "call_prev", name: "exec_command", arguments: "{\"cmd\":\"node e2e_membership_test.js\"}" },
          { type: "function_call_output", call_id: "call_prev", output: "[4/N] Subscriptions tab loaded. No active membership card displayed." },
        ],
        tools: [{
          type: "function",
          name: "exec_command",
          parameters: {
            type: "object",
            required: ["cmd"],
            properties: { cmd: { type: "string" } },
            additionalProperties: false,
          },
        }],
      }),
    );

    const events = parseSseEvents(res.body);
    const completed = events.find((event) => event.type === "response.completed");
    const output = completed?.response?.output || [];

    assert.equal(res.statusCode, 200);
    assert.equal(res.endCalls, 1);
    assert.equal(res.body.includes("Checking the identity provider route"), false);
    assert.deepEqual(calls, [
      {
        provider: "Responses-Native-Loop",
        userCount: 1,
        lastUser: "Continue fixing the identity provider route and verify it.",
      },
      {
        provider: "Responses-Native-Loop",
        userCount: 2,
        lastUser: "continue the active task. Use available plan/goal/todo tools to identify the first incomplete step. If more work remains, call the next appropriate tool now. Do not stop after narrating progress, tool results, or next steps; only provide a final answer when the task is complete and verified.",
      },
    ]);
    assert.deepEqual(output.map((item) => item.type), ["function_call"]);
    assert.equal(output[0].name, "exec_command");
    assert.equal(output[0].arguments, "{\"cmd\":\"curl -s http://localhost:5173/api/user/memberships\"}");
    assert.match(logs.join("\n"), /HIDDEN-CONTINUE-NATIVE: Responses-Native-Loop .*output=action_prelude.*action=hidden_continue/);
    assert.match(logs.join("\n"), /HIDDEN-CONTINUE-RETRY: Responses-Native-Loop retry=1/);
  } finally {
    state.PROVIDERS = originalProviders;
    state.GROUPS = originalGroups;
    state.scores = originalScores;
    state.log = originalLog;
    providerAdapters.routeNativeStream = originalRouteNativeStream;
    fs.writeFileSync = originalWriteFileSync;
    if (originalAiAssessment === undefined) delete process.env.LLM_PROXY_AI_ASSESSMENT;
    else process.env.LLM_PROXY_AI_ASSESSMENT = originalAiAssessment;
    if (originalMaxRetries === undefined) delete process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES;
    else process.env.LLM_PROXY_HIDDEN_CONTINUE_MAX_RETRIES = originalMaxRetries;
    routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
  }
});

test("handleResponsesHTTP returns JSON Responses output for non-streaming OpenAI SDK callers", async () => {
  const schema = {
    type: "object",
    properties: { facts: { type: "array", items: { type: "string" } } },
    required: ["facts"],
    additionalProperties: false,
  };
  let capturedReq = null;
  responses.init({
    handleChatCompletion: async (req, res) => {
      capturedReq = req;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 1779437100,
        model: req.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "{\"facts\":[\"Graphiti uses proxy\"]}" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [
        { role: "system", content: "Extract facts." },
        { role: "user", content: [{ type: "text", text: "Use local proxy." }] },
      ],
      text: { format: { type: "json_schema", name: "GraphitiFacts", schema, strict: true } },
    }),
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /application\/json/);
  assert.equal(capturedReq.stream, false);
  assert.deepEqual(capturedReq.messages, [
    { role: "system", content: "Extract facts." },
    { role: "user", content: "Use local proxy." },
  ]);
  assert.deepEqual(capturedReq.response_format, {
    type: "json_schema",
    json_schema: { name: "GraphitiFacts", schema, strict: true },
  });

  const body = JSON.parse(res.body);
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.output[0].type, "message");
  assert.equal(body.output[0].content[0].type, "output_text");
  assert.equal(body.output[0].content[0].text, "{\"facts\":[\"Graphiti uses proxy\"]}");
  assert.deepEqual(body.usage, { input_tokens: 7, output_tokens: 5, total_tokens: 12 });
});

test("handleResponsesHTTP suppresses mixed assistant text when Codex JSON response contains tool calls", async () => {
  const captured = [];
  responses.init({
    handleChatCompletion: async (req, res) => {
      captured.push(JSON.parse(JSON.stringify(req)));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_codex_tool",
        object: "chat.completion",
        created: 1779437101,
        model: req.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Use the known login creds, then run the Playwright flow.",
            tool_calls: [{
              id: "call_exec",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"echo test\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    },
  });

  const makeRes = () => ({
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  });

  const first = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex/1.0" } },
    first,
    JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: "Continue debugging login and run the next tool step." }],
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      tool_choice: "auto",
    }),
  );

  const firstBody = JSON.parse(first.body);
  const functionCall = firstBody.output.find((item) => item.type === "function_call");
  assert.equal(first.statusCode, 200);
  assert.equal(firstBody.output_text, "");
  assert.deepEqual(firstBody.output.map((item) => item.type), ["function_call"]);
  assert.equal(functionCall.name, "exec_command");
  assert.equal(functionCall.arguments, "{\"cmd\":\"echo test\"}");

  const second = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json", "user-agent": "Codex/1.0" } },
    second,
    JSON.stringify({
      model: "gpt-5.4",
      previous_response_id: firstBody.id,
      input: [{ type: "function_call_output", call_id: functionCall.call_id, output: "ok" }],
    }),
  );

  assert.equal(second.statusCode, 200);
  const replay = captured[1].messages;
  const assistantReplay = replay.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_exec");
  const toolReplay = replay.find((message) => message.role === "tool" && message.tool_call_id === "call_exec");
  assert.equal(assistantReplay.content, null);
  assert.equal(assistantReplay.tool_calls[0].function.name, "exec_command");
  assert.equal(toolReplay.name, "exec_command");
});

test("handleResponsesHTTP replays previous_response_id history for tool outputs", async () => {
  const captured = [];
  responses.init({
    handleChatCompletion: async (req, res) => {
      captured.push(JSON.parse(JSON.stringify(req)));
      res.writeHead(200, { "Content-Type": "application/json" });
      if (captured.length === 1) {
        res.end(JSON.stringify({
          id: "chatcmpl_tool",
          object: "chat.completion",
          created: 1779437101,
          model: req.model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_read",
                type: "function",
                function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "chatcmpl_done",
        object: "chat.completion",
        created: 1779437102,
        model: req.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Read result accepted." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      }));
    },
  });

  const makeRes = () => ({
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  });

  const first = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    first,
    JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: "Read package.json." }],
      tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      tool_choice: "required",
    }),
  );
  const firstBody = JSON.parse(first.body);
  const callId = firstBody.output.find((item) => item.type === "function_call").call_id;

  const second = makeRes();
  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    second,
    JSON.stringify({
      model: "gpt-5.4",
      previous_response_id: firstBody.id,
      input: [{ type: "function_call_output", call_id: callId, output: "{\"name\":\"llm-proxy\"}" }],
    }),
  );

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(captured[0].tool_choice, "required");
  assert.deepEqual(captured[1].tools, [
    { type: "function", function: { name: "Read", parameters: { type: "object" } } },
  ]);
  assert.equal(captured[1].tool_choice, "required");
  const replay = captured[1].messages;
  const assistantIndex = replay.findIndex((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_read");
  const toolIndex = replay.findIndex((message) => message.role === "tool" && message.tool_call_id === "call_read");
  assert.equal(assistantIndex >= 0, true);
  assert.equal(toolIndex > assistantIndex, true);
  assert.equal(replay[toolIndex].name, "Read");
});

test("handleResponsesHTTP repairs structured JSON output to match requested schema", async () => {
  const schema = {
    type: "object",
    properties: {
      extracted_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            entity_type_id: { type: "integer" },
          },
          required: ["name", "entity_type_id"],
          additionalProperties: false,
        },
      },
    },
    required: ["extracted_entities"],
    additionalProperties: false,
  };

  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_schema",
        object: "chat.completion",
        created: 1779437200,
        model: "auto-sm",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "LLM_PROXY_TASK_DIFFICULTY level=2 effort=low speed=5 reason=entity_extraction\n\n[{\"entity_name\":\"Graphiti\",\"entity_type_id\":0,\"extra\":\"drop\"}]",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [{ role: "user", content: "Extract entities." }],
      text: { format: { type: "json_schema", name: "ExtractedEntities", schema, strict: true } },
    }),
  );

  const body = JSON.parse(res.body);
  assert.equal(body.output[0].content[0].text, "{\"extracted_entities\":[{\"name\":\"Graphiti\",\"entity_type_id\":0}]}");
});

test("handleResponsesHTTP extracts structured entities from bullet text when JSON is missing", async () => {
  const schema = {
    type: "object",
    properties: {
      extracted_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            entity_type_id: { type: "integer" },
          },
          required: ["name", "entity_type_id"],
          additionalProperties: false,
        },
      },
    },
    required: ["extracted_entities"],
    additionalProperties: false,
  };

  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Entities:\n- Graphiti MCP (entity_type_id=0)\n- local hash embeddings (entity_type_id=0)",
            },
            finish_reason: "stop",
          },
        ],
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [{ role: "user", content: "Extract entities." }],
      text: { format: { type: "json_schema", name: "ExtractedEntities", schema, strict: true } },
    }),
  );

  const body = JSON.parse(res.body);
  assert.equal(body.output[0].content[0].text, "{\"extracted_entities\":[{\"name\":\"Graphiti MCP\",\"entity_type_id\":0},{\"name\":\"local hash embeddings\",\"entity_type_id\":0}]}");
});

test("handleResponsesHTTP falls back to a minimal schema object when structured text is unparseable", async () => {
  const schema = {
    type: "object",
    properties: {
      summarized_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            summary: { type: "string" },
          },
          required: ["name", "summary"],
          additionalProperties: false,
        },
      },
    },
    required: ["summarized_entities"],
    additionalProperties: false,
  };

  responses.init({
    handleChatCompletion: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Graphiti MCP is an optional semantic sidecar.",
            },
            finish_reason: "stop",
          },
        ],
      }));
    },
  });

  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk.toString();
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };

  await responses.handleResponsesHTTP(
    { headers: { accept: "application/json" } },
    res,
    JSON.stringify({
      model: "auto-sm",
      input: [{ role: "user", content: "Summarize entities." }],
      text: { format: { type: "json_schema", name: "SummarizedEntities", schema, strict: true } },
    }),
  );

  const body = JSON.parse(res.body);
  assert.equal(body.output[0].content[0].text, "{\"summarized_entities\":[]}");
});

test("handleResponsesWS sends session.created immediately on connect", () => {
  const sent = [];
  const handlers = {};
  const fakeWs = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
    on(event, handler) { handlers[event] = handler; },
  };
  const fakeReq = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };

  responses.handleResponsesWS(fakeWs, fakeReq);

  assert.equal(sent.length, 1, "exactly one message sent on open");
  const msg = sent[0];
  assert.equal(msg.type, "session.created");
  assert.ok(msg.event_id, "event_id present");
  assert.ok(msg.session?.id, "session.id present");
  assert.equal(msg.session?.object, "realtime.session");
});

test("handleResponsesWS session.updated includes session id", async () => {
  const sent = [];
  const handlers = {};
  const fakeWs = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
    on(event, handler) { handlers[event] = handler; },
  };
  const fakeReq = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };

  responses.handleResponsesWS(fakeWs, fakeReq);
  const sessionId = sent[0].session.id;

  await handlers.message(Buffer.from(JSON.stringify({ type: "session.update", session: { model: "gpt-4o" } })));

  const updated = sent.find((m) => m.type === "session.updated");
  assert.ok(updated, "session.updated sent");
  assert.equal(updated.session.id, sessionId, "session.id preserved in session.updated");
  assert.equal(updated.session.model, "gpt-4o");
});
