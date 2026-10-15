const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createTaskRuntime } = require("../lib/task-runtime");
const routes = [
  {
    name: "A",
    family: "openai",
    model: "openai/gpt-test",
    key: "fixture",
    caps: ["text", "tools"],
    context: 10000,
    account_ref: "one",
  },
  {
    name: "B",
    family: "copilot",
    model: "copilot/gpt-test",
    upstream_model: "gpt-test",
    key: "fixture",
    caps: ["text", "tools"],
    context: 10000,
    account_ref: "two",
  },
  {
    name: "C",
    family: "other",
    model: "other/different",
    key: "fixture",
    caps: ["text", "tools"],
    context: 10000,
  },
];
const res = () => ({ setHeader() {} });
const options = {
  headers: { "x-llm-proxy-task-id": "t", "x-llm-proxy-client-id": "client" },
};
test("runtime pins real dispatch across calls and moves same canonical model to healthy account", async () => {
  const rt = createTaskRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "runtime-")),
    getProviders: () => routes,
  });
  const request = { messages: [{ role: "user", content: "hello" }] };
  let chosen;
  await rt.handle(request, res(), options, async (body) => {
    chosen = await rt.beforeDispatch(routes[0], body);
    assert.equal(chosen.name, "A");
  });
  await rt.handle(request, res(), options, async (body) => {
    chosen = await rt.beforeDispatch(routes[2], body);
    assert.equal(chosen.name, "A");
    await rt.recordFailure(chosen, {
      status: 429,
      body: JSON.stringify({ error: { code: "insufficient_quota" } }),
    });
    chosen = await rt.beforeDispatch(routes[2], body);
    assert.equal(chosen.name, "B");
  });
  rt.close();
});
test("parallel requests never leak async task identity and errors after stream start are not replayed", async () => {
  const rt = createTaskRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "runtime-isolation-")),
    getProviders: () => routes,
  });
  const seen = await Promise.all(
    ["one", "two"].map((task) =>
      rt.handle(
        { messages: [] },
        res(),
        { headers: { "x-llm-proxy-task-id": task } },
        async (body) => {
          await new Promise((r) => setImmediate(r));
          const p = await rt.beforeDispatch(routes[0], body);
          return rt.current().identity.key;
        },
      ),
    ),
  );
  assert.notEqual(seen[0], seen[1]);
  rt.close();
});

test("mixed original retrieval never escapes as an unknown client tool and client calls survive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-retrieval-"));
  const rt = createTaskRuntime({ dataDir: dir, getProviders: () => routes });
  await rt.handle({ messages: [] }, res(), options, async () => {
    const body = {
      messages: [
        {
          role: "tool",
          tool_call_id: "old",
          content: "INFO repeat\n".repeat(400),
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    await rt.beforeDispatch(routes[0], body);
    const ref = body.messages[0].content.match(/Original ([a-f0-9]{64})/)[1];
    const call = (id, name, args) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const response = {
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                call("r", "proxy_retrieve_original", { ref }),
                call("c", "read_file", {}),
              ],
            },
          },
        ],
      }),
    };
    const result = await rt.resolveResponse(response, body, () => {
      throw new Error("Client tools must not be executed by proxy");
    });
    const visible = JSON.parse(result.body).choices[0].message;
    assert.deepEqual(
      visible.tool_calls.map((t) => t.id),
      ["c"],
    );
    const next = {
      messages: [
        ...body.messages,
        visible,
        { role: "tool", tool_call_id: "c", content: "client result" },
      ],
      tools: body.tools,
    };
    await rt.beforeDispatch(routes[0], next);
    assert.ok(
      next.messages.some((m) => m.role === "tool" && m.tool_call_id === "r"),
    );
    assert.ok(
      next.messages.some((m) => m.role === "tool" && m.tool_call_id === "c"),
    );
  });
  rt.close();
});

test("internal role identity remains distinct from memory helper", async () => {
  const rt = createTaskRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "roles-")),
    getProviders: () => routes,
  });
  await rt.handle({ messages: [] }, res(), options, async () => {
    await rt.beforeDispatch(routes[0], {
      messages: [],
      _llmProxyRole: "code-reviewer",
    });
    assert.equal(rt.current().allocation.role, "code-reviewer");
  });
  rt.close();
});

test("failed internal retrieval is replayed with matching error tool result", async () => {
  const rt = createTaskRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "bad-retrieval-")),
    getProviders: () => routes,
  });
  await rt.handle({ messages: [] }, res(), options, async () => {
    const body = {
      messages: [],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    await rt.beforeDispatch(routes[0], body);
    const calls = [
      {
        id: "bad",
        type: "function",
        function: {
          name: "proxy_retrieve_original",
          arguments: '{"ref":"missing"}',
        },
      },
      {
        id: "client",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ];
    const result = await rt.resolveResponse(
      {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { role: "assistant", tool_calls: calls } }],
        }),
      },
      body,
      () => {},
    );
    const next = {
      ...body,
      messages: [
        JSON.parse(result.body).choices[0].message,
        { role: "tool", tool_call_id: "client", content: "ok" },
      ],
    };
    await rt.beforeDispatch(routes[0], next);
    assert.ok(
      next.messages.some(
        (m) => m.tool_call_id === "bad" && m.content.includes("error"),
      ),
    );
  });
  rt.close();
});
test("dispatch preserves candidate eligibility during initial selection and fallback", async () => {
  const rt = createTaskRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "eligible-")),
    getProviders: () => routes,
  });
  rt.setEligibility((p) => p.name !== "B");
  await rt.handle({ messages: [] }, res(), options, async (body) => {
    rt.orderCandidates([routes[0]], body);
    await rt.beforeDispatch(routes[0], body);
    await rt.recordFailure(routes[0], { status: 503, body: "down" });
    assert.equal((await rt.beforeDispatch(routes[0], body)).name, "C");
  });
  rt.close();
});

test("retrieval round trips retain total per-dispatch usage without replacing final provider usage", async () => {
  const rt = createTaskRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "usage-")),
    getProviders: () => routes,
  });
  await rt.handle({ messages: [] }, res(), options, async (body) => {
    await rt.beforeDispatch(routes[0], body);
    const response = (u) => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: u, completion_tokens: 2, total_tokens: u + 2 },
      }),
    });
    await rt.recordDispatch(routes[0], response(10));
    const final = await rt.recordDispatch(routes[0], response(20));
    const b = JSON.parse(final.body);
    assert.equal(b.usage.prompt_tokens, 20);
    assert.equal(b.llm_proxy_usage.inputTokens, 30);
    assert.equal(b.llm_proxy_usage.outputTokens, 4);
    assert.equal(b.llm_proxy_usage.observedDispatches, 2);
  });
  rt.close();
});

test("critical bug task retains revision-bound review gate and rejects stale executor evidence", async () => {
  const rt = createTaskRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "gate-")),
    getProviders: () => routes,
  });
  await rt.handle(
    {
      metadata: {
        llm_proxy: {
          task_type: "BUG_FIX",
          risk: "critical",
          source_revision: "tree-one",
        },
      },
      messages: [{ role: "user", content: "Fix security bug" }],
    },
    res(),
    options,
    async (body) => {
      await rt.beforeDispatch(routes[0], body);
      const state = rt.inspectTask();
      assert.equal(state.orchestration.flow.taskType, "BUG_FIX");
      assert.ok(state.orchestration.flow.phases.includes("independent_review"));
      await rt.recordGateEvidence({
        source: "trusted_executor",
        revision: "old-tree",
        phase: "reproduce",
        artifactVerified: true,
        verdict: "passed",
      });
      assert.equal(rt.inspectTask().orchestration.flow.phase, 0);
      assert.equal(body.metadata?.llm_proxy, undefined);
    },
  );
  rt.close();
});
