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
test("native benchmark preserves tool history and qualifies repeated automatic tool round trips", async () => {
  const r=await bench.run({config:{providers:[p]},toolRounds:3,requestTimeoutMs:45000,route:async(_provider,body,options)=>{
    const prompt=body.messages.find(m=>m.role==='user')?.content||'',last=body.messages.at(-1);
    let content='fixture-ok',calls;
    if(last.role==='tool'){
      // Return wrong contents if the benchmark changed the original prompt or
      // dropped its system message instead of continuing the same conversation.
      content=body.messages[0].role==='system'&&prompt==='Read fixture.txt using read. Then reply with its exact contents and nothing else.'?'fixture-value-47':'invalid history';
    }else if(prompt.includes('Read fixture.txt')){
      if(body.tool_choice!=='auto')throw Object.assign(Error('only auto supported'),{status:400});
      calls=[{id:'c1',type:'function',function:{name:'read',arguments:'{"path":"fixture.txt"}'}}];content=null;
    }else if(prompt.includes('sum'))content='{"sum":42,"even":true}';
    else if(prompt.includes('const a='))content='[4,16]';
    else if(prompt.includes('ready and pending'))content='{"ready":["api","health"],"pending":["cache","docs"]}';
    else if(prompt.includes('stream-ok'))content='stream-ok';
    else if(prompt.includes('cache-ok'))content='cache-ok';
    else if(prompt.includes('parallel-ok'))content='parallel-ok';
    const usage={prompt_tokens:10,completion_tokens:3,total_tokens:13},message={role:'assistant',content,...(calls?{tool_calls:calls}:{})};
    if(options.handlers){const delta=calls?{tool_calls:calls.map(t=>({...t,index:0}))}:{content};options.handlers.onChunk('data: '+JSON.stringify({choices:[{delta,finish_reason:calls?'tool_calls':'stop'}],usage})+'\n\ndata: [DONE]\n\n');return;}
    return{status:200,body:JSON.stringify({choices:[{message,finish_reason:calls?'tool_calls':'stop'}],usage})};
  }});
  assert.equal(r.requests,25);assert.equal(r.models[0].evidence.toolChecks,9);assert.equal(r.models[0].evidence.toolPassed,9);assert.equal(r.models[0].eligible,true);
});
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
