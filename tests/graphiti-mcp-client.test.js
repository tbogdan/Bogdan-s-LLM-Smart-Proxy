"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { GraphitiMcpClient, normalizeToolContent } = require("../lib/memory/graphiti-mcp-client");

test("GraphitiMcpClient skips network calls when disabled", async () => {
  let called = false;
  const client = new GraphitiMcpClient(
    { GRAPHITI_MCP_ENABLED: "false" },
    { fetchImpl: async () => { called = true; } },
  );

  assert.deepEqual(await client.addEpisode({ name: "x", body: "y" }), { skipped: true });
  assert.deepEqual(await client.search({ project: "p", query: "q" }), []);
  assert.equal(called, false);
});

test("GraphitiMcpClient initializes MCP session before adding an episode through add_memory", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (key.toLowerCase() === "mcp-session-id" ? "session-1" : "application/json") },
      json: async () => ({ jsonrpc: "2.0", id: body.id, result: { content: [{ text: "ok" }] } }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ text: "ok" }] } }),
    };
  };
  const client = new GraphitiMcpClient({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_URL: "http://graphiti-mcp:8000/mcp/",
    GRAPHITI_MCP_GROUP_ID: "llm-proxy",
  }, { fetchImpl });

  await client.addEpisode({
    id: "event-1",
    project: "llm-proxy",
    name: "memory event",
    body: "User prefers project-scoped recall.",
    sourceDescription: "llm-proxy memory event",
  });

  assert.equal(calls[0].body.method, "initialize");
  assert.equal(calls.at(-1).body.method, "tools/call");
  assert.equal(calls.at(-1).body.params.name, "add_memory");
  assert.equal(calls.at(-1).body.params.arguments.group_id, "llm-proxy");
  assert.equal(calls.at(-1).body.params.arguments.source, "text");
  assert.equal(calls.at(-1).body.params.arguments.uuid, undefined);
  assert.match(calls.at(-1).body.params.arguments.episode_body, /project-scoped recall/);
  assert.match(calls.at(-1).body.params.arguments.episode_body, /source_id=event-1/);
  assert.equal(calls.at(-1).headers["mcp-session-id"], "session-1");
});

test("GraphitiMcpClient falls back to add_episode for older Graphiti servers", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const isAddMemory = body.method === "tools/call" && body.params.name === "add_memory";
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (key.toLowerCase() === "mcp-session-id" ? "session-1" : "application/json") },
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: isAddMemory
          ? { content: [{ text: "Unknown tool: add_memory" }], isError: true }
          : { content: [{ text: "ok" }], isError: false },
      }),
    };
  };
  const client = new GraphitiMcpClient({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_URL: "http://graphiti-mcp:8000/mcp/",
  }, { fetchImpl });

  await client.addEpisode({ id: "event-1", body: "hello" });

  assert.equal(calls.at(-1).params.name, "add_episode");
});

test("GraphitiMcpClient throws when a Graphiti tool returns an error", async () => {
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (key.toLowerCase() === "mcp-session-id" ? "session-1" : "application/json") },
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "tools/call"
          ? { content: [{ text: "episode failed" }], isError: true }
          : {},
      }),
    };
  };
  const client = new GraphitiMcpClient({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_URL: "http://graphiti-mcp:8000/mcp/",
    GRAPHITI_MCP_ADD_TOOL: "custom_add",
  }, { fetchImpl });

  await assert.rejects(
    () => client.addEpisode({ id: "event-1", body: "hello" }),
    /custom_add: episode failed/,
  );
});

test("GraphitiMcpClient parses JSON-RPC events from text/event-stream responses", async () => {
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (key.toLowerCase() === "content-type" ? "text/event-stream" : "session-1") },
      json: async () => { throw new Error("not json"); },
      text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ text: "SSE fact" }] } })}\n\n`,
    };
  };
  const client = new GraphitiMcpClient({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_URL: "http://graphiti-mcp:8000/mcp/",
  }, { fetchImpl });

  const result = await client.callTool("search_facts", { query: "memory" });

  assert.deepEqual(normalizeToolContent(result), ["SSE fact"]);
});

test("GraphitiMcpClient returns empty search results on timeout", async () => {
  const fetchImpl = async (_url, options) => {
    await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  const client = new GraphitiMcpClient({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_URL: "http://graphiti-mcp:8000/mcp/",
    GRAPHITI_MCP_SEARCH_TIMEOUT_MS: "1",
  }, { fetchImpl });

  assert.deepEqual(await client.search({ project: "p", query: "q" }), []);
});

test("GraphitiMcpClient filters failed search tools while keeping successful fallback results", async () => {
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const toolName = body.params?.name;
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (key.toLowerCase() === "mcp-session-id" ? "session-1" : "application/json") },
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: toolName === "search_facts"
          ? { content: [{ text: "Unknown tool: search_facts" }], isError: true }
          : { content: [{ text: "node result" }], isError: false },
      }),
    };
  };
  const client = new GraphitiMcpClient({
    GRAPHITI_MCP_ENABLED: "true",
    GRAPHITI_MCP_URL: "http://graphiti-mcp:8000/mcp/",
  }, { fetchImpl });

  assert.deepEqual(await client.search({ project: "p", query: "q" }), ["node result"]);
});
