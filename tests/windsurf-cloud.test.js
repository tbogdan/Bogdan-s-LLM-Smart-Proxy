"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const cloud = require("../lib/windsurf-cloud");

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("production transport constants point at Codeium Connect endpoint", () => {
  assert.equal(cloud.CODEIUM_API_ORIGIN, "https://server.codeium.com");
  assert.equal(cloud.GET_CHAT_MESSAGE_PATH, "/exa.api_server_pb.ApiServerService/GetChatMessage");
  assert.equal(cloud.WINDSURF_DEFAULT_URL, "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage");
});

test("resolveModel maps fallback Windsurf model ids and aliases", () => {
  assert.equal(cloud.resolveModel("windsurf/swe-1.6-fast").modelUid, "swe-1-6-fast");
  assert.equal(cloud.resolveModel("swe-1.6").modelUid, "swe-1-6");
  assert.equal(cloud.resolveModel("swe-1.5-fast").modelUid, "swe-1-5");
  assert.equal(cloud.resolveModel("adaptive").modelUid, "adaptive");
  assert.equal(cloud.resolveModel("swe-1-6-fast").id, "swe-1.6-fast");
});

test("buildWindsurfProviders emits namespaced windsurf provider contracts", () => {
  const providers = cloud.buildWindsurfProviders();
  const fast = providers.find((provider) => provider.model === "windsurf/swe-1.6-fast");

  assert.equal(providers.length >= 4, true);
  assert.equal(fast.family, "windsurf");
  assert.equal(fast.protocol, "windsurf");
  assert.equal(fast.key_env, "WINDSURF_API_KEY");
  assert.equal(fast.windsurf_model_uid, "swe-1-6-fast");
  assert.equal(fast.context, 200000);
  assert.equal(fast.caps.includes("tools"), true);
});

test("protobuf helpers encode fields, envelopes, and parse fields", () => {
  const message = Buffer.concat([cloud.encodeString(3, "hello"), cloud.encodeVarintField(7, 5)]);
  const envelope = cloud.connectEnvelope(message);
  const parsed = cloud.takeConnectEnvelopes(envelope);
  const fields = cloud.parseFields(parsed.envelopes[0].body);

  assert.equal(Buffer.from(cloud.encodeVarint(300)).toString("hex"), "ac02");
  assert.equal(envelope[0], 0);
  assert.equal(envelope.readUInt32BE(1), message.length);
  assert.equal(parsed.remaining.length, 0);
  assert.equal(parsed.envelopes[0].flags, 0);
  assert.equal(fields[0].fieldNum, 3);
  assert.equal(fields[0].value.toString("utf8"), "hello");
  assert.equal(fields[1].fieldNum, 7);
  assert.equal(fields[1].value, 5n);
});

test("buildMetadata embeds API key and buildGetChatMessageRequest embeds prompts and model uid", () => {
  const metadata = cloud.buildMetadata("api-key", "1.2.3", "request-id");
  const metadataFields = cloud.parseFields(metadata);

  assert.equal(metadataFields.find((field) => field.fieldNum === 3).value.toString("utf8"), "api-key");
  assert.equal(metadataFields.find((field) => field.fieldNum === 10).value.toString("utf8"), "request-id");

  const body = cloud.buildGetChatMessageRequest(
    {
      model: "windsurf/swe-1.5-fast",
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    },
    "api-key",
    "1.2.3",
    "request-id",
  );
  const fields = cloud.parseFields(body);
  const modelUid = fields.find((field) => field.fieldNum === 21).value.toString("utf8");
  const promptFields = fields.filter((field) => field.fieldNum === 3).flatMap((field) => cloud.parseFields(field.value));

  assert.equal(modelUid, "swe-1-5");
  assert.equal(promptFields.filter((field) => field.fieldNum === 3).map((field) => field.value.toString("utf8")).join("\n"), "System\nHello");
});

test("toWindsurfRequest preserves OpenAI request fields and selects upstream model", () => {
  const provider = { upstream_model: "swe-1.6-fast", windsurf_model_uid: "swe-1-6-fast" };
  const input = {
    model: "windsurf/swe-1.6-fast",
    messages: [{ role: "user", content: "Hello" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    temperature: 0.25,
    stream: true,
  };

  const output = cloud.toWindsurfRequest(provider, input);

  assert.equal(output.model, "swe-1.6-fast");
  assert.equal(output.windsurf_model_uid, "swe-1-6-fast");
  assert.equal(output.temperature, 0.25);
  assert.equal(output.stream, true);
  assert.deepEqual(output.messages, input.messages);
  assert.deepEqual(output.tools, input.tools);
});

test("toWindsurfRequest falls back to provider model and then input model", () => {
  assert.equal(
    cloud.toWindsurfRequest({ model: "provider-model" }, { model: "input-model", messages: [{ role: "user", content: "Hello" }] }).model,
    "provider-model",
  );
  assert.equal(cloud.toWindsurfRequest({}, { model: "input-model", messages: [{ role: "user", content: "Hello" }] }).model, "input-model");
});

test("buildHeaders includes Connect proto headers without bearer auth", () => {
  const headers = cloud.buildHeaders({ key: "host-token" });

  assert.equal(headers["content-type"], "application/connect+proto");
  assert.equal(headers["connect-protocol-version"], "1");
  assert.equal(headers.accept, "application/connect+proto");
  assert.equal(headers.Authorization, undefined);
});

test("postWindsurf keeps local HTTP JSON seam and returns raw non-2xx response details", async () => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(body, JSON.stringify({ model: "swe-1.6-fast", messages: [] }));
      response.writeHead(503, { "content-type": "application/json", "x-request-id": "req-ws-123" });
      response.end('{"error":"temporarily_unavailable"}');
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await cloud.postWindsurf(
      { key: "host-token", url: `http://127.0.0.1:${port}/v1/chat/completions` },
      { model: "swe-1.6-fast", messages: [] },
    );

    assert.equal(output.status, 503);
    assert.equal(output.headers["content-type"], "application/json");
    assert.equal(output.headers["x-request-id"], "req-ws-123");
    assert.equal(output.body, '{"error":"temporarily_unavailable"}');
  } finally {
    await closeServer(server);
  }
});

test("callWindsurfCloud wraps local JSON text response into OpenAI completion", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "ws_123", output: "Hello from Windsurf", usage: { input_tokens: 5, output_tokens: 4 } }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await cloud.callWindsurfCloud(
      { key: "host-token", upstream_model: "swe-1.6-fast", url: `http://127.0.0.1:${port}/v1/chat/completions` },
      { model: "windsurf/swe-1.6-fast", messages: [{ role: "user", content: "Hello" }] },
    );

    assert.equal(output.id, "chatcmpl-ws_123");
    assert.equal(output.object, "chat.completion");
    assert.equal(output.model, "windsurf/swe-1.6-fast");
    assert.deepEqual(output.choices[0].message, { role: "assistant", content: "Hello from Windsurf" });
    assert.deepEqual(output.usage, { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
  } finally {
    await closeServer(server);
  }
});

test("callWindsurfCloud non-2xx error carries status and body", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":"rate_limited"}');
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      () =>
        cloud.callWindsurfCloud(
          { key: "host-token", upstream_model: "swe-1.6-fast", url: `http://127.0.0.1:${port}/v1/chat/completions` },
          { model: "windsurf/swe-1.6-fast", messages: [{ role: "user", content: "Hello" }] },
        ),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.body, '{"error":"rate_limited"}');
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test("callWindsurfCloud wraps local non-JSON response body as assistant text", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("plain text response");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await cloud.callWindsurfCloud(
      { key: "host-token", upstream_model: "swe-1.6-fast", url: `http://127.0.0.1:${port}/v1/chat/completions` },
      { model: "windsurf/swe-1.6-fast", messages: [{ role: "user", content: "Hello" }] },
    );

    assert.equal(output.choices[0].message.content, "plain text response");
  } finally {
    await closeServer(server);
  }
});

test("postWindsurf local HTTP seam rejects on timeout", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"output":"late"}');
      }, 50);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      () =>
        cloud.postWindsurf(
          { key: "host-token", url: `http://127.0.0.1:${port}/v1/chat/completions`, timeout_ms: 5 },
          { model: "swe-1.6-fast", messages: [] },
        ),
      /timeout/i,
    );
  } finally {
    await closeServer(server);
  }
});

test("toOpenAIResponse preserves OpenAI-like choices and normalizes usage tokens", () => {
  const output = cloud.toOpenAIResponse("windsurf/swe-1.6", {
    id: "chatcmpl-existing",
    model: "upstream-model",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    usage: { input_tokens: 7, output_tokens: 2 },
  });

  assert.equal(output.id, "chatcmpl-existing");
  assert.equal(output.model, "windsurf/swe-1.6");
  assert.deepEqual(output.choices, [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }]);
  assert.deepEqual(output.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
});

test("toOpenAIResponse wraps message and content response shapes", () => {
  const messageOutput = cloud.toOpenAIResponse("windsurf/swe-1.6", {
    id: "ws_msg",
    message: { role: "assistant", content: "Message content" },
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  const contentOutput = cloud.toOpenAIResponse("windsurf/swe-1.6", {
    id: "ws_content",
    content: "Content text",
    usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
  });

  assert.deepEqual(messageOutput.choices[0].message, { role: "assistant", content: "Message content" });
  assert.deepEqual(messageOutput.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  assert.deepEqual(contentOutput.choices[0].message, { role: "assistant", content: "Content text" });
  assert.deepEqual(contentOutput.usage, { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 });
});

test("toOpenAIResponse parses Connect envelopes by concatenating field 3 text and skipping trailers", () => {
  const body = Buffer.concat([
    cloud.connectEnvelope(cloud.encodeString(3, "Hello ")),
    cloud.connectEnvelope(cloud.encodeString(3, "there")),
    Buffer.concat([Buffer.from([2, 0, 0, 0, 0])]),
  ]);
  const output = cloud.toOpenAIResponse("windsurf/swe-1.6", body);

  assert.equal(output.choices[0].message.content, "Hello there");
});

test("toOpenAIResponse treats trailer bit flags as error metadata", () => {
  const body = Buffer.concat([
    cloud.connectEnvelope(cloud.encodeString(3, "partial text")),
    cloud.connectEnvelope(Buffer.from('{"error":"permission_denied"}'), 3),
  ]);

  assert.throws(() => cloud.toOpenAIResponse("windsurf/swe-1.6", body), /permission_denied/);
});
