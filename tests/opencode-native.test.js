const test = require("node:test"),
  assert = require("node:assert/strict");
const context = require("../lib/task-context");
const {
  nativeSession,
  buildHeaders,
  parseWorkspaceConfig,
  nativeRequestCompatible,
} = require("../lib/opencode");
const gateway = require("../lib/opencode-transport");
const read = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};
const fixture = {
  providers: {
    opencode: {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "https://opencode.ai/inference/openai/v1" },
      models: {
        "big-pickle": {
          cost: [{ input: 0, output: 0 }],
          capabilities: { tools: true },
          limit: { context: 200000, output: 32000 },
        },
      },
    },
  },
};
test("native session ID encodes creation time and stays stable per task", () => {
  const a = nativeSession("task-one", 1792080000000);
  assert.match(a, /^ses_[a-f0-9]{12}[a-zA-Z0-9]{14}$/);
  assert.equal(a, nativeSession("task-one", 1792080000000));
  assert.notEqual(a, nativeSession("task-two", 1792080000000));
});
test("opt-in native Big Pickle uses observed endpoint and public auth without account leakage", () => {
  const p = parseWorkspaceConfig(fixture, { nativeCompat: true }).routes[0];
  assert.equal(p.alive, true);
  assert.equal(p.url, "https://opencode.ai/inference/v1/chat/completions");
  assert.equal(p.billing_class, "free_limited");
  assert.equal(p.access_policy, "native_tool_profile");
  assert.equal(p.account_ref, "opencode-public-free");
  context.run(
    {
      identity: { key: "task-one" },
      runtime: { inspectTask: () => ({ createdAt: 1792080000000 }) },
    },
    () => {
      const h = buildHeaders(
        { ...p, key: "private-console-key" },
        { env: { OPENCODE_ORG_ID: "private-org" } },
      );
      assert.equal(h.Authorization, "Bearer public");
      assert.equal(h["User-Agent"], "opencode/latest/2.0.26/desktop");
      assert.equal(h["x-opencode-session"], h["x-session-affinity"]);
      assert.equal(h["x-opencode-session-id"], h["x-opencode-session"]);
      assert.ok(!JSON.stringify(h).includes("private-"));
    },
  );
  assert.equal(nativeRequestCompatible(p, { tools: [read] }), true);
  assert.equal(nativeRequestCompatible(p, { tools: [] }), false);
  const body = {
    messages: [
      { role: "system", content: "Caller policy" },
      { role: "user", content: "Reply OK" },
    ],
    tools: [read],
  };
  const wire = gateway.toRequest(p, body, true);
  assert.deepEqual(wire.messages, body.messages);
  assert.deepEqual(wire.tools, body.tools);
});
test("native free nonstream collects upstream SSE including tool args and measured usage", async () => {
  const p = {
    ...parseWorkspaceConfig(fixture, { nativeCompat: true }).routes[0],
    key: "private-console-key",
  };
  let outbound;
  const fake = async (_url, options) => {
    outbound = JSON.parse(options.body);
    return new Response(
      "data: " +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    type: "function",
                    function: { name: "read", arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"file.txt"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            total_tokens: 25,
            prompt_tokens_details: { cached_tokens: 10 },
          },
        }) +
        "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  await context.run(
    {
      identity: { key: "task-one" },
      runtime: { inspectTask: () => ({ createdAt: 1792080000000 }) },
    },
    async () => {
      const r = await gateway.route(
        p,
        { messages: [{ role: "user", content: "Read file" }], tools: [read] },
        { fetchFn: fake },
      );
      const b = JSON.parse(r.body);
      assert.equal(outbound.stream, true);
      assert.equal(b.usage.prompt_tokens, 20);
      assert.equal(b.usage.prompt_tokens_details.cached_tokens, 10);
      assert.equal(
        b.choices[0].message.tool_calls[0].function.arguments,
        '{"path":"file.txt"}',
      );
    },
  );
});

test("native headers use persisted creation time from real task runtime", async (t) => {
  const fs = require("fs"),
    os = require("os"),
    path = require("path"),
    { createTaskRuntime } = require("../lib/task-runtime");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = {
    ...parseWorkspaceConfig(fixture, { nativeCompat: true }).routes[0],
    key: "private-console-key",
  };
  const runtime = createTaskRuntime({ dataDir: dir, getProviders: () => [p] });
  t.after(() => runtime.close());
  let first;
  for (let i = 0; i < 2; i++)
    await runtime.handle(
      {
        model: p.model,
        messages: [{ role: "user", content: "Reply OK" }],
        tools: [read],
      },
      { setHeader() {} },
      {
        headers: {
          "x-llm-proxy-task-id": "native-real-runtime",
          "x-llm-proxy-client-id": "test",
        },
      },
      async (body) => {
        const selected = await runtime.beforeDispatch(p, body);
        const session = buildHeaders(selected)["x-opencode-session"];
        if (first) assert.equal(session, first);
        first = session;
      },
    );
});
