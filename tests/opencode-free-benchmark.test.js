const test = require("node:test"),
  assert = require("node:assert/strict");
const bench = require("../scripts/benchmark-opencode-free");
const p = {
  family: "opencode",
  model: "opencode/free",
  upstream_model: "free",
  protocol: "openai",
  billing_class: "free_limited",
  billing_basis: "api",
  price_observation: {
    providerId: "opencode",
    upstreamModel: "free",
    inputPerMTok: 0,
    outputPerMTok: 0,
    currency: "USD",
    source: "https://opencode.ai/console/api/v2/config",
    observedAt: new Date().toISOString(),
  },
};
test("benchmark stops entire provider batch on quota without paid requests or identity retries", async () => {
  let calls = 0;
  const r = await bench.run({
    config: { providers: [p, { ...p, model: "opencode/other" }] },
    route: async () => {
      calls++;
      throw Object.assign(Error("quota"), {
        status: 429,
        headers: { "retry-after": "60" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.requests, 1);
  assert.equal(r.stopped, "provider_limit_429");
  assert.equal(r.budget.paidRequests, 0);
  assert.equal(r.models[0].eligible, false);
});
test("SSE benchmark preserves incremental tool arguments and rejects missing terminal marker", () => {
  const frames = [
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "1",
                  function: { name: "read", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      }) +
      "\n\n",
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"fixture.txt"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }) +
      "\n\n",
  ];
  assert.throws(() => bench.collectSse(frames), /terminal/);
  const b = bench.collectSse([...frames, "data: [DONE]\n\n"]);
  assert.equal(
    b.choices[0].message.tool_calls[0].function.arguments,
    '{"path":"fixture.txt"}',
  );
  assert.equal(b.usage.completion_tokens, 4);
});
test("summary separates measured transport, fixture correctness, latency and real cache usage", () => {
  const s = bench.summarize([
    {
      category: "coding",
      transportOk: true,
      passed: false,
      latencyMs: 500,
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
    },
    {
      category: "tools",
      stream: true,
      transportOk: true,
      passed: true,
      latencyMs: 2000,
      inputTokens: 120,
      outputTokens: 20,
      cachedInputTokens: 40,
    },
  ]);
  assert.equal(s.samples, 2);
  assert.equal(s.transportSuccesses, 2);
  assert.equal(s.checksPassed, 1);
  assert.equal(s.cachedInputTokens, 40);
  assert.equal(s.categories.coding.passed, 0);
  assert.equal(s.toolPassed, 1);
});
test("fixture validators detect wrong answers instead of grading HTTP200 as success", () => {
  const list = bench.cases();
  const exact = list.find((c) => c.id === "exact-0");
  assert.equal(
    exact.check({ choices: [{ message: { content: "wrong" } }] }),
    false,
  );
  const coding = list.find((c) => c.id === "coding-0");
  assert.equal(
    coding.check({ choices: [{ message: { content: "[4,16]" } }] }),
    true,
  );
  assert.equal(
    coding.check({ choices: [{ message: { content: "[2,4]" } }] }),
    false,
  );
  assert.ok(list.some((c) => c.tool && c.stream));
});

test("missing token usage remains unknown rather than zero consumption", () => {
  const s = bench.summarize([
    { category: "exact", transportOk: true, passed: true, latencyMs: 1 },
  ]);
  assert.equal(s.inputTokens, null);
  assert.equal(s.outputTokens, null);
  assert.equal(s.cachedInputTokens, null);
  assert.equal(s.unknownUsageSamples, 1);
});
