"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ide = require("../lib/ide-capabilities");

test("detectRuntimeProfile identifies Claude VSCode from attribution headers", () => {
  const profile = ide.detectRuntimeProfile({
    model: "auto-coding",
    _claudeCodeProfile: {
      deviceId: "device-1",
      accountUuid: "account-1",
      sessionId: "session-1",
    },
  }, {
    headers: {
      "x-anthropic-billing-header": "cc_version=2.1.165.5d5; cc_entrypoint=claude-vscode; cch=00000;",
      "x-stainless-package-version": "0.94.0",
      "x-claude-code-session-id": "session-header",
    },
    debugText: "Fast mode unavailable: Fast mode has been disabled by your organization",
  });

  assert.equal(profile.client.id, "claude_code");
  assert.equal(profile.surface, "claude-vscode");
  assert.equal(profile.entrypoint, "claude-vscode");
  assert.equal(profile.version, "2.1.165");
  assert.equal(profile.build, "5d5");
  assert.equal(profile.authMode, "first_party_oauth");
  assert.equal(profile.policy.orgFastModeDisabled, true);
  assert.equal(profile.toolDialect.billingHeader.contentHash, "00000");
  assert.equal(profile.toolDialect.billingHeader.firstSystemBlock, true);
  assert.equal(profile.subagentDialect.protocol, "claude_task_artifacts");
  assert.equal(profile.metadata.deviceId, "device-1");
  assert.equal(profile.metadata.accountUuid, "account-1");
  assert.equal(profile.metadata.sessionId, "session-header");
});

test("detectRuntimeProfile keeps Claude Code CLI separate from Claude VSCode", () => {
  const profile = ide.detectRuntimeProfile({}, {
    headers: {
      "x-anthropic-billing-header": "cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;",
    },
  });

  assert.equal(profile.client.id, "claude_code");
  assert.equal(profile.surface, "claude-code-cli");
  assert.equal(profile.entrypoint, "sdk-cli");
  assert.equal(profile.version, "2.1.150");
  assert.equal(profile.build, "e37");
  assert.equal(profile.toolDialect.toolCallFormat, "anthropic_tool_blocks");
});

test("detectRuntimeProfile identifies Codex, Windsurf, Devin, and Copilot surfaces", () => {
  const codex = ide.detectRuntimeProfile(
    { _llmProxyClient: "codex", previous_response_id: "resp_1", client_metadata: { originator: "Codex Desktop" } },
    { headers: { "user-agent": "Codex Desktop/0.136.0-alpha.2", "openai-beta": "responses_websockets=2026-02-06" } },
  );
  assert.equal(codex.surface, "codex");
  assert.equal(codex.wireApi, "responses");
  assert.equal(codex.transport, "responses_websocket");
  assert.equal(codex.toolDialect.previousResponseToolContext, true);
  assert.equal(codex.subagentDialect.protocol, "codex_thread_agents");

  const windsurf = ide.detectRuntimeProfile({}, { headers: { "user-agent": "Windsurf/1.12 Cascade" } });
  assert.equal(windsurf.surface, "windsurf");
  assert.equal(windsurf.nativeTransport.protocol, "connect_proto_http2");
  assert.equal(windsurf.compat.flattenNativeToolHistory, true);

  const devin = ide.detectRuntimeProfile({}, { headers: { "user-agent": "Devin Desktop/2.0 Cognition" } });
  assert.equal(devin.surface, "devin-desktop");
  assert.equal(devin.compat.preserveDevinSurfaceIdentity, true);
  assert.equal(devin.acp.metaCapabilities.includes("cognition.ai/subagentSupport"), true);

  const copilot = ide.detectRuntimeProfile({}, {
    headers: {
      "user-agent": "GitHubCopilotChat/0.49.0",
      "editor-version": "vscode/1.121.0",
      "copilot-integration-id": "vscode-chat",
    },
  });
  assert.equal(copilot.surface, "github-copilot");
  assert.equal(copilot.authMode, "copilot_runtime_token");
  assert.equal(copilot.integrationId, "vscode-chat");
  assert.equal(copilot.toolDialect.sanitizeToolNames, true);
  assert.equal(copilot.toolDialect.toolNameMaxLength, 64);
});

test("detectIdeClient recognizes Codex from Responses client metadata", () => {
  const client = ide.detectIdeClient({
    model: "auto-coding",
    client_metadata: { originator: "Codex Desktop" },
  });

  assert.equal(client.id, "codex");
});

test("buildClientCapabilitySection includes runtime profile specifics", () => {
  const section = ide.buildClientCapabilitySection({
    model: "auto-coding",
    tools: [{ type: "function", function: { name: "Task" } }],
  }, {
    headers: {
      "x-anthropic-billing-header": "cc_version=2.1.165.5d5; cc_entrypoint=claude-vscode; cch=00000;",
    },
    debugText: "Fast mode unavailable: Fast mode has been disabled by your organization",
  });

  const text = section.lines.join("\n");
  assert.match(text, /Runtime surface: claude-vscode/);
  assert.match(text, /entrypoint=claude-vscode/);
  assert.match(text, /version=2\.1\.165/);
  assert.match(text, /Tool dialect: anthropic_tool_blocks/);
  assert.match(text, /Subagent dialect: claude_task_artifacts/);
  assert.match(text, /Org policy: fast mode disabled/);
  assert.equal(section.runtime.surface, "claude-vscode");
});

test("buildClientCapabilitySection separates runtime subagent support from executable tool schema", () => {
  const section = ide.buildClientCapabilitySection({
    _llmProxyClient: "codex",
    tools: [{ type: "function", function: { name: "update_plan" } }],
  }, {
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
      "openai-beta": "responses_websockets=2026-02-06",
    },
  });

  const text = section.lines.join("\n");
  assert.equal(section.runtime.surface, "codex");
  assert.equal(section.reported.subagents, false);
  assert.deepEqual(section.capabilities.subagents, []);
  assert.equal(section.missing.subagents, undefined);
  assert.match(text, /Subagents: no dedicated subagent tool detected/i);
  assert.match(text, /Do not infer Codex subagent\/thread tools from app-context docs/i);
});

test("detectToolCapabilities treats Codex thread tools and Responses hosted tools as capabilities", () => {
  const caps = ide.detectToolCapabilities({
    tools: [
      { type: "function", function: { name: "create_thread" } },
      { type: "function", function: { name: "send_message_to_thread" } },
      { type: "function", function: { name: "list_mcp_resources" } },
      { type: "function", function: { name: "read_mcp_resource" } },
      { type: "function", function: { name: "tool_search" } },
      { type: "mcp", server_label: "mempalace" },
      { type: "function", function: { name: "mcp__node_repl" } },
      { type: "web_search_preview" },
    ],
  });

  assert.deepEqual(caps.subagents, ["create_thread", "send_message_to_thread"]);
  assert.deepEqual(caps.mcpResources, ["list_mcp_resources", "read_mcp_resource"]);
  assert.deepEqual(caps.mcp, ["mcp__node_repl"]);
  assert.deepEqual(caps.hostedTools, ["web_search_preview"]);
  assert.deepEqual(caps.deferredTools, ["tool_search"]);
});

test("detectToolCapabilities sees child functions inside Codex namespace tools", () => {
  const caps = ide.detectToolCapabilities({
    tools: [
      {
        type: "namespace",
        name: "multi_agent_v1",
        tools: [
          { type: "function", name: "spawn_agent" },
          { type: "function", name: "wait_agent" },
          { type: "function", name: "close_agent" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__node_repl",
        tools: [
          { type: "function", name: "js" },
        ],
      },
      { type: "tool_search" },
    ],
  });

  assert.deepEqual(caps.subagents, ["multi_agent_v1", "spawn_agent", "wait_agent", "close_agent"]);
  assert.deepEqual(caps.mcp, ["mcp__node_repl"]);
  assert.deepEqual(caps.deferredTools, ["tool_search"]);
});

test("buildClientCapabilitySection treats Codex tool_search as deferred subagent discovery", () => {
  const section = ide.buildClientCapabilitySection({
    _llmProxyClient: "codex",
    model: "auto-coding",
    tools: [
      { type: "function", function: { name: "tool_search" } },
      { type: "function", function: { name: "update_plan" } },
    ],
  }, {
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
    },
  });

  const text = section.lines.join("\n");
  assert.deepEqual(section.capabilities.subagents, []);
  assert.deepEqual(section.capabilities.deferredTools, ["tool_search"]);
  assert.match(text, /Deferred tool discovery: available via tool_search/i);
  assert.match(text, /Subagents: deferred via tool_search/i);
  assert.match(text, /first call tool_search with an exact query: spawn_agent, multi_agent_v1/i);
  assert.doesNotMatch(text, /Subagents: no dedicated subagent tool is currently exposed/i);
  assert.doesNotMatch(text, /Do not claim to dispatch agents; use available search\/read\/command tools/i);
});

test("capabilityMismatchSummaries classifies deferred Codex subagents instead of hard missing", () => {
  const contract = ide.buildForwardedCapabilityContract({
    _llmProxyClient: "codex",
    clientCapabilities: { subagents: true, goals: true },
    tools: [
      { type: "function", function: { name: "tool_search" } },
      { type: "function", function: { name: "update_plan" } },
    ],
  }, {
    headers: {
      "user-agent": "Codex Desktop/0.136.0-alpha.2",
    },
  });

  const summaries = ide.capabilityMismatchSummaries(contract);
  const subagents = summaries.find((summary) => summary.capability === "subagents");
  const goals = summaries.find((summary) => summary.capability === "goals");
  assert.equal(subagents.reason, "deferred");
  assert.deepEqual(subagents.deferredTools, ["tool_search"]);
  assert.equal(subagents.expected.includes("spawn_agent"), true);
  assert.equal(goals.reason, "deferred");
  assert.deepEqual(goals.deferredTools, ["tool_search"]);
});

test("capabilityMismatchSummaries classifies no-tool capability reports separately", () => {
  const contract = ide.buildForwardedCapabilityContract({
    _llmProxyClient: "claude_code",
    clientCapabilities: { subagents: true, plans: true },
    tools: [],
  }, {
    headers: {
      "x-anthropic-billing-header": "cc_version=2.1.165.5d5; cc_entrypoint=claude-vscode; cch=00000;",
    },
  });

  const summaries = ide.capabilityMismatchSummaries(contract);
  assert.equal(summaries.find((summary) => summary.capability === "subagents").reason, "no_tools");
  assert.equal(summaries.find((summary) => summary.capability === "plans").reason, "no_tools");
});

test("capabilityMismatchSummaries treats runtime-only tool-less turns as scoped request context", () => {
  const contract = ide.buildForwardedCapabilityContract({
    _llmProxyClient: "claude_code",
    tools: [],
  }, {
    headers: {
      "x-anthropic-billing-header": "cc_version=2.1.165.5d5; cc_entrypoint=claude-vscode; cch=00000;",
    },
  });

  const summaries = ide.capabilityMismatchSummaries(contract);
  assert.equal(summaries.find((summary) => summary.capability === "subagents").reason, "toolless_turn");
  assert.equal(summaries.find((summary) => summary.capability === "plans").reason, "toolless_turn");
});

test("capability catalogs advertise cross IDE and provider transform support compactly", () => {
  const clients = ide.clientRuntimeProfilesCatalog();
  assert.deepEqual(Object.keys(clients), [
    "claude-code-cli",
    "claude-vscode",
    "devin-desktop",
    "windsurf",
    "codex",
    "github-copilot",
  ]);
  assert.equal(clients.codex.capabilities.subagents, false);
  assert.match(clients.codex.conditional_capabilities.subagents, /requires current request schema/i);
  assert.equal(clients.codex.expected_tools.subagents.includes("spawn_agent"), true);
  assert.equal(clients.codex.expected_tools.subagents.includes("create_thread"), true);
  assert.equal(clients["github-copilot"].tool_transform.sanitize_names, true);
  assert.equal(clients["devin-desktop"].capabilities.acp, true);

  const provider = ide.providerTransformCapabilityMetadata({
    family: "copilot",
    protocol: "openai",
    supports_parallel_tool_calls: true,
    supports_code_execution: true,
    supports_context_compaction: true,
  });
  assert.equal(provider.tool_calls.strict_names, true);
  assert.equal(provider.tool_calls.parallel, true);
  assert.equal(provider.context.compaction, true);
});

test("buildForwardedCapabilityContract preserves runtime and tool capability shapes across clients", () => {
  const codex = ide.buildForwardedCapabilityContract({
    _llmProxyClient: "codex",
    previous_response_id: "resp_1",
    prompt_cache_key: "cache_1",
    tools: [
      { type: "function", function: { name: "spawn_agent" } },
      { type: "function", function: { name: "update_plan" } },
      { type: "function", function: { name: "create_goal" } },
    ],
  }, {
    headers: { "user-agent": "Codex Desktop/0.136.0-alpha.2", "openai-beta": "responses_websockets=2026-02-06" },
  });
  assert.equal(codex.client.id, "codex");
  assert.equal(codex.runtime.surface, "codex");
  assert.equal(codex.runtime.toolDialect.previousResponseToolContext, true);
  assert.equal(codex.runtime.toolDialect.promptCacheKey, true);
  assert.deepEqual(codex.capabilities.subagents, ["spawn_agent"]);
  assert.deepEqual(codex.capabilities.plans, ["update_plan"]);
  assert.deepEqual(codex.capabilities.goals, ["create_goal"]);

  const claudeCli = ide.buildForwardedCapabilityContract({
    tools: [{ type: "function", function: { name: "Task" } }],
  }, {
    headers: {
      "x-anthropic-billing-header": "cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;",
      "x-claude-code-session-id": "session-cli",
    },
  });
  assert.equal(claudeCli.runtime.surface, "claude-code-cli");
  assert.equal(claudeCli.runtime.toolDialect.billingHeader.entrypoint, "sdk-cli");
  assert.equal(claudeCli.runtime.metadata.sessionId, "session-cli");

  const claudeVsCode = ide.buildForwardedCapabilityContract({}, {
    headers: {
      "x-anthropic-billing-header": "cc_version=2.1.165.5d5; cc_entrypoint=claude-vscode; cch=00000;",
    },
  });
  assert.equal(claudeVsCode.runtime.surface, "claude-vscode");

  const windsurfRuntime = ide.detectRuntimeProfile({}, { headers: { "user-agent": "Windsurf/1.12 Cascade" } });
  assert.equal(windsurfRuntime.nativeTransport.userAgent, "Windsurf/1.12 Cascade");

  const windsurf = ide.buildForwardedCapabilityContract({}, { headers: { "user-agent": "Windsurf/1.12 Cascade" } });
  assert.equal(windsurf.runtime.surface, "windsurf");
  assert.equal(windsurf.runtime.subagentDialect.supportsSubagentNotifications, true);
  assert.equal(windsurf.runtime.compat.flattenNativeToolHistory, true);

  const devin = ide.buildForwardedCapabilityContract({}, { headers: { "user-agent": "Devin Desktop/2.0 Cognition" } });
  assert.equal(devin.runtime.surface, "devin-desktop");
  assert.equal(devin.runtime.compat.preserveDevinSurfaceIdentity, true);

  const copilot = ide.buildForwardedCapabilityContract({
    tools: [{ type: "function", function: { name: "functions.exec_command" } }],
  }, {
    headers: {
      "user-agent": "GitHubCopilotChat/0.49.0",
      "editor-version": "vscode/1.121.0",
      "copilot-integration-id": "vscode-chat",
    },
  });
  assert.equal(copilot.runtime.surface, "github-copilot");
  assert.equal(copilot.runtime.toolDialect.sanitizeToolNames, true);
  assert.equal(copilot.runtime.integrationId, "vscode-chat");
});
