"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dialects = require("../lib/tool-dialects");

test("canonicalToolName normalizes native aliases across clients", () => {
  assert.equal(dialects.canonicalToolName("multi_agent_v1.spawn_agent"), "spawn_agent");
  assert.equal(dialects.canonicalToolName("codex_app.create_thread"), "create_thread");
  assert.equal(dialects.canonicalToolName("TodoWrite"), "TodoWrite");
  assert.equal(dialects.canonicalToolName("list_mcp_resources"), "list_mcp_resources");
});

test("toolAliasesForClient exposes MCP, goals, and modes aliases", () => {
  assert.deepEqual(dialects.toolAliasesForClient("codex", "mcp"), [
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
  ]);
  assert.deepEqual(dialects.toolAliasesForClient("codex", "goals"), [
    "create_goal",
    "get_goal",
    "update_goal",
  ]);
  assert.deepEqual(dialects.toolAliasesForClient("windsurf", "modes"), [
    "request_user_input",
    "set_mode",
  ]);
});

test("family detectors classify MCP, goal, mode, thread, and subagent names", () => {
  assert.equal(dialects.isSubagentToolName("multi_agent_v1.resume_agent"), true);
  assert.equal(dialects.isThreadToolName("codex_app.send_message_to_thread"), true);
  assert.equal(dialects.isGoalToolName("create_goal"), true);
  assert.equal(dialects.isModeToolName("set_mode"), true);
  assert.equal(dialects.isMcpToolName("mcp__node_repl"), true);
  assert.equal(dialects.isMcpToolName("read_mcp_resource"), true);
  assert.equal(dialects.isMcpToolName("functions.exec_command"), false);
});

test("nativeToolTarget maps canonical names to client-native names", () => {
  assert.equal(dialects.nativeToolTarget("codex", "spawn_agent"), "multi_agent_v1.spawn_agent");
  assert.equal(dialects.nativeToolTarget("codex", "create_thread"), "codex_app.create_thread");
  assert.equal(dialects.nativeToolTarget("claude_code", "spawn_agent"), null);
  assert.equal(dialects.nativeToolTarget("claude_code", "Task"), "Task");
  assert.equal(dialects.nativeToolTarget("windsurf", "TodoWrite"), "TodoWrite");
  assert.equal(dialects.nativeToolTarget("copilot", "spawn_agent"), null);
});

test("capabilityQueriesForClient returns discovery queries for supported families", () => {
  assert.deepEqual(dialects.capabilityQueriesForClient("codex", "subagents"), ["spawn_agent", "multi_agent_v1"]);
  assert.deepEqual(dialects.capabilityQueriesForClient("codex", "goals"), ["create_goal", "get_goal"]);
  assert.deepEqual(dialects.capabilityQueriesForClient("codex", "mcp"), [
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
  ]);
  assert.deepEqual(dialects.capabilityQueriesForClient("claude_code", "modes"), []);
});
