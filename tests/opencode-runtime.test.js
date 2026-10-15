const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { parseWorkspaceConfig, buildHeaders } = require("../lib/opencode");
const { canonicalModel } = require("../lib/task-routing");
const { createTaskRuntime } = require("../lib/task-runtime");
const model = {
  name: "Fixture",
  limit: { context: 100000, output: 1000 },
  capabilities: { tools: true, input: ["text"] },
  cost: [{ input: 0.3, output: 1.2 }],
};
function config() {
  return {
    providers: Object.fromEntries(
      ["opencode", "opencode-go"].map((id) => [
        id,
        {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: {
            baseURL:
              "https://opencode.ai/inference/" +
              (id === "opencode-go" ? "go/" : "") +
              "openai/v1",
          },
          models: { "shared-fixture": model },
        },
      ]),
    ),
  };
}
test("same hosted model is canonical across Console and Go rather than consuming another LLM slot", () => {
  const r = parseWorkspaceConfig(config()).routes;
  assert.equal(canonicalModel(r[0]), canonicalModel(r[1]));
});
test("quota fallback preserves upstream model, stable task session and survivor pin", async (t) => {
  const routes = parseWorkspaceConfig(config()).routes.map((p) => ({
    ...p,
    key: "fixture",
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createTaskRuntime({
    dataDir: dir,
    getProviders: () => routes,
  });
  t.after(() => runtime.close());
  const options = {
      headers: {
        "x-llm-proxy-task-id": "same-task",
        "x-llm-proxy-client-id": "fixture",
      },
    },
    request = { messages: [{ role: "user", content: "Write a test" }] };
  let session;
  await runtime.handle(request, { setHeader() {} }, options, async (body) => {
    let selected = await runtime.beforeDispatch(routes[1], body);
    assert.equal(selected.family, "opencode-go");
    session = buildHeaders(selected)["x-opencode-session"];
    await runtime.recordFailure(selected, {
      status: 429,
      headers: { "retry-after": "31" },
      body: '{"error":{"code":"quota_exceeded"}}',
    });
    selected = await runtime.beforeDispatch(routes[1], body);
    assert.equal(selected.family, "opencode");
    assert.equal(selected.upstream_model, "shared-fixture");
    assert.equal(buildHeaders(selected)["x-opencode-session"], session);
    runtime.recordSuccess(selected);
  });
  await runtime.handle(request, { setHeader() {} }, options, async (body) => {
    const selected = await runtime.beforeDispatch(routes[1], body);
    assert.equal(selected.family, "opencode");
    assert.equal(buildHeaders(selected)["x-opencode-session"], session);
  });
});
test("provisioning preserves unrelated routes and replacing a provider snapshot is idempotent", async () => {
  const { provision } = require("../scripts/provision-opencode");
  const base = {
    providers: [{ family: "groq", model: "groq/keep", alive: true }],
  };
  const fake = async (_url, options) => {
    assert.equal(options.method, "GET");
    return { ok: true, status: 200, json: async () => config() };
  };
  const a = await provision({
    env: { OPENCODE_API_KEY: "one", OPENCODE_GO_API_KEY: "two" },
    config: base,
    fetchFn: fake,
  });
  const b = await provision({
    env: { OPENCODE_API_KEY: "one", OPENCODE_GO_API_KEY: "two" },
    config: a.config,
    fetchFn: fake,
  });
  assert.equal(b.config.providers.length, 3);
  assert.deepEqual(b.config.providers[0], base.providers[0]);
  assert.ok(!JSON.stringify(b.config).includes("Bearer"));
});

test("Console insufficient funds falls back to the same Go model and keeps the survivor pinned", async (t) => {
  const routes = parseWorkspaceConfig(config()).routes.map((p) => ({ ...p, key: "fixture" }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-credit-fallback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createTaskRuntime({ dataDir: dir, getProviders: () => routes });
  t.after(() => runtime.close());
  const options = { headers: {
    "x-llm-proxy-task-id": "console-credit-fallback",
    "x-llm-proxy-client-id": "fixture",
  } };
  const request = { model: routes[0].model, messages: [{ role: "user", content: "Reply OK" }] };
  await runtime.handle(request, { setHeader() {} }, options, async (body) => {
    const consoleRoute = await runtime.beforeDispatch(routes[0], body);
    const session = buildHeaders(consoleRoute)["x-opencode-session"];
    const error = { status: 402, body: JSON.stringify({ error: {
      type: "server_error", message: "Upstream request failed: Insufficient account funds",
    } }) };
    assert.equal(runtime.retryable(error), true);
    await runtime.recordFailure(consoleRoute, error);
    const fallback = await runtime.beforeDispatch(routes[0], body);
    assert.equal(fallback.family, "opencode-go");
    assert.equal(fallback.upstream_model, consoleRoute.upstream_model);
    assert.equal(buildHeaders(fallback)["x-opencode-session"], session);
    runtime.recordSuccess(fallback);
    assert.equal(runtime.inspectTask().models.length, 1);
  });
  await runtime.handle(request, { setHeader() {} }, options, async (body) => {
    assert.equal((await runtime.beforeDispatch(routes[0], body)).family, "opencode-go");
  });
});

test("explicit free request cannot consume a paid fallback after quota exhaustion", async (t) => {
  const routes = parseWorkspaceConfig(config()).routes.map((p, i) => ({
    ...p,
    key: "fixture",
    billing_class: i ? "paid" : "free_limited",
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-free-fallback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createTaskRuntime({
    dataDir: dir,
    getProviders: () => routes,
  });
  t.after(() => runtime.close());
  await runtime.handle(
    {
      model: routes[0].model,
      messages: [{ role: "user", content: "Reply briefly" }],
    },
    { setHeader() {} },
    {
      headers: {
        "x-llm-proxy-task-id": "free-only",
        "x-llm-proxy-client-id": "fixture",
      },
    },
    async (body) => {
      const selected = await runtime.beforeDispatch(routes[0], body);
      assert.equal(selected.name, routes[0].name);
      await runtime.recordFailure(selected, {
        status: 429,
        headers: { "retry-after": "30" },
        body: "quota exhausted",
      });
      await assert.rejects(
        runtime.beforeDispatch(routes[0], body),
        (e) => e.code === "NO_ELIGIBLE_ROUTE",
      );
    },
  );
});

test("free aliases override a prior paid pin and keep retries and helper roles free-only", async (t) => {
  const routes = parseWorkspaceConfig(config()).routes.map((p, i) => ({
    ...p,
    key: "fixture",
    billing_class: i ? "paid" : "free_limited",
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-free-alias-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createTaskRuntime({
    dataDir: dir,
    getProviders: () => routes,
  });
  t.after(() => runtime.close());
  const options = {
    headers: {
      "x-llm-proxy-task-id": "alias-pin",
      "x-llm-proxy-client-id": "fixture",
    },
  };
  await runtime.handle(
    { model: routes[1].model, messages: [{ role: "user", content: "Reply" }] },
    { setHeader() {} },
    options,
    (body) => runtime.beforeDispatch(routes[1], body),
  );
  await runtime.handle(
    { model: "shared-fixture", messages: [{ role: "user", content: "Reply" }] },
    { setHeader() {} },
    options,
    async (body) => {
      const selected = await runtime.beforeDispatch(routes[0], body);
      assert.equal(selected.name, routes[0].name);
      await runtime.recordFailure(selected, {
        status: 429,
        body: "quota exhausted",
        headers: { "retry-after": "30" },
      });
      await assert.rejects(
        runtime.beforeDispatch(routes[1], body),
        (e) => e.code === "NO_ELIGIBLE_ROUTE",
      );
      await assert.rejects(
        runtime.beforeDispatch(routes[1], {
          ...body,
          model: "auto-assess",
          _llmProxyRole: "assessment",
        }),
        (e) => e.code === "NO_ELIGIBLE_ROUTE",
      );
    },
  );
});

test("omitted model keeps automatic routing fallback after a free candidate fails", async (t) => {
  const routes = parseWorkspaceConfig(config()).routes.map((p, i) => ({
    ...p,
    key: "fixture",
    billing_class: i ? "paid" : "free_limited",
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-auto-free-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createTaskRuntime({
    dataDir: dir,
    getProviders: () => routes,
  });
  t.after(() => runtime.close());
  await runtime.handle(
    { messages: [{ role: "user", content: "Reply" }] },
    { setHeader() {} },
    {
      headers: {
        "x-llm-proxy-task-id": "auto-default",
        "x-llm-proxy-client-id": "fixture",
      },
    },
    async (body) => {
      const selected = await runtime.beforeDispatch(routes[0], body);
      await runtime.recordFailure(selected, {
        status: 429,
        body: "quota exhausted",
        headers: { "retry-after": "30" },
      });
      assert.equal(
        (await runtime.beforeDispatch(routes[0], body)).name,
        routes[1].name,
      );
    },
  );
});
