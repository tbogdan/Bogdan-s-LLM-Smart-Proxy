const test = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http");
const gateway = require("../lib/opencode-transport"),
  context = require("../lib/task-context");
const base = {
  family: "opencode",
  model: "opencode/fixture",
  upstream_model: "fixture",
  key: "fixture-key",
};
const input = {
  messages: [
    { role: "system", content: "System" },
    { role: "user", content: "Hello" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"id":1}' },
          extra_content: { google: { thought_signature: "signature" } },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"value":2}' },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: { id: { type: "number" } } },
      },
    },
  ],
  max_tokens: 64,
  _llmProxyTaskId: "must-not-leak",
};
test("Responses conversion preserves tool identity/history, media and token limits", () => {
  const r = gateway.toRequest({ ...base, protocol: "responses" }, input, false);
  assert.equal(r.max_output_tokens, 64);
  assert.equal(r.store, false);
  assert.deepEqual(r.input.at(-1), {
    type: "function_call_output",
    call_id: "call_1",
    output: '{"value":2}',
  });
  assert.equal(r.input.find((m) => m.type === "function_call").name, "lookup");
  assert.equal(r.tools[0].name, "lookup");
  assert.ok(!JSON.stringify(r).includes("_llmProxy"));
  const media = gateway.toRequest(
    { ...base, protocol: "responses" },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AA==" },
            },
          ],
        },
      ],
    },
    false,
  );
  assert.equal(media.input[0].content[0].type, "input_image");
});
test("Gemini conversion round-trips tool names and thought signatures", () => {
  const r = gateway.toRequest({ ...base, protocol: "gemini" }, input, false);
  assert.equal(r.systemInstruction.parts[0].text, "System");
  assert.equal(r.contents.at(-1).parts[0].functionResponse.name, "lookup");
  assert.equal(r.contents[1].parts[0].thoughtSignature, "signature");
  assert.equal(r.tools[0].functionDeclarations[0].name, "lookup");
});
test("Gemini advertised audio/video modalities preserve binary data and file references", () => {
  const r = gateway.toRequest(
    { ...base, protocol: "gemini" },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { format: "mp3", data: "AA==" },
            },
            {
              type: "video_url",
              video_url: { url: "https://media.example/video.mp4" },
            },
          ],
        },
      ],
    },
    false,
  );
  assert.deepEqual(r.contents[0].parts[0], {
    inlineData: { mimeType: "audio/mpeg", data: "AA==" },
  });
  assert.equal(
    r.contents[0].parts[1].fileData.fileUri,
    "https://media.example/video.mp4",
  );
});
test("gateway Anthropic request has no Claude Code scaffolding and preserves tool selection", () => {
  const r = gateway.toRequest(
    { ...base, protocol: "anthropic" },
    {
      ...input,
      tool_choice: { type: "function", function: { name: "lookup" } },
    },
    false,
  );
  assert.equal(r.system, "System");
  assert.deepEqual(r.tool_choice, { type: "tool", name: "lookup" });
  assert.ok(!JSON.stringify(r).includes("billing-header"));
});
test("Responses and Gemini usage retain cached input and reasoning totals", () => {
  const r = gateway.fromResponse(
    { ...base, protocol: "responses" },
    {
      id: "resp_1",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "OK" }] },
        {
          type: "function_call",
          call_id: "call_2",
          name: "lookup",
          arguments: "{}",
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 12,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens_details: { reasoning_tokens: 10 },
      },
    },
  );
  assert.equal(r.choices[0].message.content, "OK");
  assert.equal(r.choices[0].message.tool_calls[0].id, "call_2");
  assert.equal(r.usage.prompt_tokens_details.cached_tokens, 80);
  assert.equal(r.usage.total_tokens, 112);
  const g = gateway.fromResponse(
    { ...base, protocol: "gemini" },
    {
      candidates: [
        {
          content: {
            parts: [
              { text: "OK" },
              {
                functionCall: { name: "lookup", args: { id: 1 } },
                thoughtSignature: "sig",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 10,
        cachedContentTokenCount: 80,
        totalTokenCount: 112,
      },
    },
  );
  assert.equal(g.usage.completion_tokens, 12);
  assert.equal(
    g.choices[0].message.tool_calls[0].extra_content.google.thought_signature,
    "sig",
  );
});
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  return "http://127.0.0.1:" + s.address().port;
}
const scoped = (fn) => context.run({ identity: { key: "fixture-task" } }, fn);
test("real HTTP stream handles split UTF-8/SSE and preserves incremental Responses tool args", async (t) => {
  const seen = [];
  const url = await server(t, (req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "response.output_text.delta", delta: "Bun\u0103" },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "lookup",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"id":1}',
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: {
            input_tokens: 100,
            output_tokens: 8,
            input_tokens_details: { cached_tokens: 70 },
          },
        },
      },
    ];
    const wire = Buffer.from(
      events.map((e) => "data: " + JSON.stringify(e) + "\r\n\r\n").join(""),
    );
    let i = 0;
    function write() {
      if (i === wire.length) {
        res.end();
        return;
      }
      res.write(wire.subarray(i, i + 1));
      i++;
      setImmediate(write);
    }
    write();
  });
  const chunks = [];
  await scoped(() =>
    gateway.route(
      { ...base, protocol: "responses", url },
      { messages: [{ role: "user", content: "test" }] },
      { handlers: { onChunk: (c) => chunks.push(String(c)) } },
    ),
  );
  const s = chunks.join("");
  assert.match(s, /Bun\u0103/);
  assert.match(s, /call_1/);
  assert.match(s, /lookup/);
  assert.match(s, /cached_tokens.*70/);
  assert.match(s, /\[DONE\]/);
  assert.equal(seen[0].authorization, "Bearer fixture-key");
  assert.match(seen[0]["user-agent"], /bogdan-llm-smart-proxy/);
});
test("HTTP quota errors preserve status and retry-after for shared account fallback", async (t) => {
  const url = await server(t, (_req, res) => {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "31",
    });
    res.end('{"error":{"type":"rate_limit_error"}}');
  });
  const r = await scoped(() =>
    gateway.route({ ...base, protocol: "openai", url }, { messages: [] }),
  );
  assert.equal(r.status, 429);
  assert.equal(r.headers["retry-after"], "31");
  await assert.rejects(
    scoped(() =>
      gateway.route(
        { ...base, protocol: "openai", url },
        { messages: [] },
        { handlers: { onChunk() {} } },
      ),
    ),
    (e) => e.status === 429 && e.headers["retry-after"] === "31",
  );
});
test("Responses stream failure and premature EOF cannot masquerade as success", async (t) => {
  for (const event of [
    {
      type: "response.failed",
      response: { error: { message: "provider down" } },
    },
    { type: "response.output_text.delta", delta: "partial" },
  ]) {
    const url = await server(t, (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: " + JSON.stringify(event) + "\n\n");
    });
    await assert.rejects(
      scoped(() =>
        gateway.route(
          { ...base, protocol: "responses", url },
          { messages: [] },
          { handlers: { onChunk() {} } },
        ),
      ),
      /provider|incomplete|ended/i,
    );
  }
});
test("caller cancellation closes a live upstream stream", async (t) => {
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
  });
  const abort = new AbortController();
  const p = scoped(() =>
    gateway.route(
      { ...base, protocol: "responses", url },
      { messages: [] },
      { signal: abort.signal, handlers: { onChunk() {} } },
    ),
  );
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(p, /abort/i);
});

test("Anthropic developer instructions become system instructions", () => {
  const r = gateway.toRequest(
    { ...base, protocol: "anthropic" },
    {
      messages: [
        { role: "system", content: "Base" },
        { role: "developer", content: "Policy" },
        { role: "user", content: "Hello" },
      ],
    },
    false,
  );
  assert.ok(JSON.stringify(r.system).includes("Policy"));
  assert.ok(r.messages.every((m) => ["user", "assistant"].includes(m.role)));
});

test("missing upstream usage remains unknown rather than zero consumption", () => {
  for (const protocol of ["responses", "anthropic", "gemini"]) {
    const r = gateway.fromResponse(
      { ...base, protocol },
      protocol === "responses"
        ? { output: [] }
        : protocol === "anthropic"
          ? { content: [] }
          : { candidates: [{ content: { parts: [] } }] },
    );
    assert.equal(r.usage, undefined, protocol);
  }
});
