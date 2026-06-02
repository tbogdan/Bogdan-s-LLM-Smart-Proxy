"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const http2 = require("node:http2");

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

function clientModelConfig({ label, uid, disabled = false, supportsImages = false, recommended = false, maxTokens = 0, costTier = 0 }) {
  const fields = [cloud.encodeString(1, label), cloud.encodeString(22, uid)];
  if (disabled) fields.push(cloud.encodeVarintField(4, 1));
  if (supportsImages) fields.push(cloud.encodeVarintField(5, 1));
  if (recommended) fields.push(cloud.encodeVarintField(11, 1));
  if (maxTokens) fields.push(cloud.encodeVarintField(18, maxTokens));
  if (costTier) fields.push(cloud.encodeVarintField(24, costTier));
  return Buffer.concat(fields);
}

function cascadeModelConfigData(configs) {
  return Buffer.concat(configs.map((config) => cloud.encodeMessage(1, config)));
}

test("resolveModel maps fallback Windsurf model ids and aliases", () => {
  assert.equal(cloud.resolveModel("windsurf/swe-1.6-fast").modelUid, "swe-1-6-fast");
  assert.equal(cloud.resolveModel("swe-1.6").modelUid, "swe-1-6");
  assert.equal(cloud.resolveModel("swe-1.5-fast").modelUid, "swe-1-5");
  assert.equal(cloud.resolveModel("adaptive").modelUid, "adaptive");
  assert.equal(cloud.resolveModel("swe-1-6-fast").id, "swe-1.6-fast");
  assert.equal(cloud.resolveModel("windsurf/claude-opus-4.7").modelUid, "claude-opus-4-7");
  assert.equal(cloud.resolveModel("windsurf/gpt-5.5").modelUid, "gpt-5-5");
  assert.equal(cloud.resolveModel("windsurf/custom-model.x").id, "custom-model.x");
  assert.equal(cloud.resolveModel("windsurf/custom-model.x").modelUid, "custom-model-x");
});

test("buildWindsurfProviders emits namespaced windsurf provider contracts", () => {
  const providers = cloud.buildWindsurfProviders();
  const fast = providers.find((provider) => provider.model === "windsurf/swe-1.6-fast");

  assert.equal(providers.length >= 17, true);
  assert.equal(fast.family, "windsurf");
  assert.equal(fast.protocol, "windsurf");
  assert.equal(fast.key_env, "WINDSURF_API_KEY");
  assert.equal(fast.windsurf_model_uid, "swe-1-6-fast");
  assert.equal(fast.context, 200000);
  assert.equal(fast.caps.includes("tools"), true);

  const opus = providers.find((provider) => provider.model === "windsurf/claude-opus-4.7");
  assert.equal(opus.windsurf_model_uid, "claude-opus-4-7");
  assert.equal(opus.caps.includes("max"), true);
});

test("parseWindsurfModelConfigs extracts app Cascade configs from UserStatus envelopes", () => {
  const body = cloud.connectEnvelope(
    cloud.encodeMessage(
      1,
      cloud.encodeMessage(
        33,
        cascadeModelConfigData([
          clientModelConfig({ label: "GPT-5.5", uid: "gpt-5-5", supportsImages: true, recommended: true, maxTokens: 1000000 }),
          clientModelConfig({ label: "Old hidden model", uid: "old-hidden-model", disabled: true }),
        ]),
      ),
    ),
  );

  const models = cloud.parseWindsurfModelConfigs(body);

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "windsurf/gpt-5.5");
  assert.equal(models[0].upstream, "gpt-5.5");
  assert.equal(models[0].windsurf_model_uid, "gpt-5-5");
  assert.equal(models[0].context, 1000000);
  assert.equal(models[0].caps.includes("images"), true);
});

test("parseWindsurfModelConfigs normalizes unknown app model configs", () => {
  const body = cloud.connectEnvelope(
    cascadeModelConfigData([
      clientModelConfig({ label: "Omega Code 1", uid: "omega-code-1", supportsImages: true, maxTokens: 262144 }),
    ]),
  );

  const models = cloud.parseWindsurfModelConfigs(body);

  assert.deepEqual(models.map((model) => model.id), ["windsurf/omega-code-1"]);
  assert.equal(models[0].name, "Windsurf-OmegaCode1");
  assert.equal(models[0].upstream, "omega-code-1");
  assert.equal(models[0].windsurf_model_uid, "omega-code-1");
  assert.equal(models[0].context, 262144);
});

test("parseWindsurfModelConfigs exposes app context and routing traits", () => {
  const body = cloud.connectEnvelope(
    cascadeModelConfigData([
      clientModelConfig({ label: "Claude Opus 4.6 1M", uid: "claude-opus-4-6-1m", supportsImages: true, maxTokens: 1000000, costTier: 4 }),
      clientModelConfig({ label: "GPT-5.2 High Priority", uid: "MODEL_GPT_5_2_HIGH_PRIORITY", supportsImages: true, maxTokens: 384000, costTier: 2 }),
      clientModelConfig({ label: "Gemini 3 Flash Minimal", uid: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL", supportsImages: true, maxTokens: 1048576, costTier: 1 }),
    ]),
  );

  const models = cloud.parseWindsurfModelConfigs(body);
  const opus = models.find((model) => model.windsurf_model_uid === "claude-opus-4-6-1m");
  const gpt = models.find((model) => model.windsurf_model_uid === "MODEL_GPT_5_2_HIGH_PRIORITY");
  const gemini = models.find((model) => model.windsurf_model_uid === "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL");
  const providers = cloud.buildWindsurfProviders(models);
  const gptProvider = providers.find((provider) => provider.windsurf_model_uid === "MODEL_GPT_5_2_HIGH_PRIORITY");

  assert.equal(opus.context, 1000000);
  assert.equal(opus.thinking_effort, "xhigh");
  assert.equal(opus.cost_multiplier, 4);
  assert.equal(opus.cost_group, 4);
  assert.equal(gpt.thinking_effort, "high");
  assert.equal(gpt.cost_multiplier, 2);
  assert.equal(gpt.speed_group, 5);
  assert.equal(gemini.thinking_effort, "minimal");
  assert.equal(gemini.cost_multiplier, 1);
  assert.equal(gemini.context, 1048576);
  assert.equal(gptProvider.cost_multiplier, 2);
  assert.equal(gptProvider.thinking_effort, "high");
  assert.equal(gptProvider.speed_group, 5);
});

test("parseWindsurfModelConfigs skips inaccessible Windsurf internal fast model", () => {
  const body = cloud.connectEnvelope(
    cascadeModelConfigData([
      clientModelConfig({ label: "Windsurf Fast", uid: "MODEL_CHAT_11121", maxTokens: 200000 }),
      clientModelConfig({ label: "Omega Code 1", uid: "omega-code-1", maxTokens: 262144 }),
    ]),
  );

  const models = cloud.parseWindsurfModelConfigs(body);

  assert.deepEqual(models.map((model) => model.windsurf_model_uid), ["omega-code-1"]);
});

test("parseWindsurfModelConfigs rejects implausible nested model uid false positives", () => {
  const body = cloud.connectEnvelope(
    Buffer.concat([
      cloud.encodeString(1, "Enterprise"),
      cloud.encodeString(22, "Recommended GPT-5.5 Low Thinking Claude Sonnet"),
    ]),
  );

  assert.deepEqual(cloud.parseWindsurfModelConfigs(body), []);
});

test("fetchWindsurfModelConfigs calls app config endpoints with raw proto and deduplicates model uids", async () => {
  const calls = [];
  const userStatusBody = cloud.connectEnvelope(
    cloud.encodeMessage(
      1,
      cloud.encodeMessage(
        33,
        cascadeModelConfigData([
          clientModelConfig({ label: "GPT-5.5", uid: "gpt-5-5", recommended: true }),
        ]),
      ),
    ),
  );
  const cascadeBody = cloud.connectEnvelope(
    cascadeModelConfigData([
      clientModelConfig({ label: "GPT-5.5 duplicate", uid: "gpt-5-5" }),
      clientModelConfig({ label: "Omega Code 1", uid: "omega-code-1", supportsImages: true }),
    ]),
  );

  const models = await cloud.fetchWindsurfModelConfigs(
    { key: "ws-key" },
    {
      postModelConfigFn: async (provider, payload) => {
        calls.push({ path: provider.path, payload });
        if (provider.path === cloud.GET_USER_STATUS_PATH) return { status: 200, body: userStatusBody };
        if (provider.path === cloud.GET_CASCADE_MODEL_CONFIGS_PATH) return { status: 200, body: cascadeBody };
        return { status: 503, body: Buffer.alloc(0) };
      },
    },
  );

  const metadata = cloud.parseFields(cloud.parseFields(calls[0].payload).find((field) => field.fieldNum === 1).value);

  assert.deepEqual(calls.map((call) => call.path), cloud.WINDSURF_MODEL_CONFIG_PATHS);
  assert.equal(metadata.find((field) => field.fieldNum === 3).value.toString("utf8"), "ws-key");
  assert.deepEqual(models.map((model) => model.windsurf_model_uid), ["gpt-5-5", "omega-code-1"]);
});

test("buildWindsurfProviders accepts configured model strings and objects", () => {
  const providers = cloud.buildWindsurfProviders([
    "windsurf/custom-model.x",
    { id: "windsurf/explicit", upstream: "explicit-upstream", windsurf_model_uid: "explicit_uid", context: 500000, tier: 1 },
  ]);

  assert.deepEqual(providers.map((provider) => provider.model), ["windsurf/custom-model.x", "windsurf/explicit"]);
  assert.equal(providers[0].windsurf_model_uid, "custom-model-x");
  assert.equal(providers[1].upstream_model, "explicit-upstream");
  assert.equal(providers[1].windsurf_model_uid, "explicit_uid");
  assert.equal(providers[1].context, 500000);
});

test("parseConfiguredModels reads comma and JSON Windsurf model overrides", () => {
  assert.deepEqual(
    cloud.parseConfiguredModels({ WINDSURF_MODELS: "windsurf/foo, bar=baz_uid" }).map((model) => [model.id, model.windsurf_model_uid]),
    [["windsurf/foo", undefined], ["windsurf/bar", "baz_uid"]],
  );
  assert.deepEqual(
    cloud.parseConfiguredModels({ WINDSURF_MODELS_JSON: '[{"id":"windsurf/json","windsurf_model_uid":"json_uid"}]' }),
    [{ id: "windsurf/json", windsurf_model_uid: "json_uid" }],
  );
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

test("buildMetadata embeds API key and buildGetChatMessageRequest embeds prompts, tools, and model uid", () => {
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
      tools: [
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Run shell",
            parameters: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
          },
        },
      ],
      parallel_tool_calls: false,
    },
    "api-key",
    "1.2.3",
    "request-id",
  );
  const fields = cloud.parseFields(body);
  const topLevelPrompt = fields.find((field) => field.fieldNum === 2).value.toString("utf8");
  const modelUid = fields.find((field) => field.fieldNum === 21).value.toString("utf8");
  const promptFields = fields.filter((field) => field.fieldNum === 3).flatMap((field) => cloud.parseFields(field.value));
  const toolFields = fields.filter((field) => field.fieldNum === 10).flatMap((field) => cloud.parseFields(field.value));

  assert.equal(topLevelPrompt, "Hello");
  assert.equal(modelUid, "swe-1-5");
  assert.equal(promptFields.filter((field) => field.fieldNum === 3).map((field) => field.value.toString("utf8")).join("\n"), "System\nHello");
  assert.equal(toolFields.find((field) => field.fieldNum === 1).value.toString("utf8"), "Bash");
  assert.match(toolFields.find((field) => field.fieldNum === 3).value.toString("utf8"), /"command"/);
  assert.equal(toolFields.find((field) => field.fieldNum === 12).value, 1n);
  assert.equal(fields.find((field) => field.fieldNum === 11).value, 1n);
});

test("toolDefinitionFromOpenAI strips descriptions for Windsurf-reserved Claude Code tool names", () => {
  const readTool = cloud.toolDefinitionFromOpenAI({
    type: "function",
    function: {
      name: "Read",
      description: "Read local files",
      parameters: { type: "object", required: ["file_path"], properties: { file_path: { type: "string" } } },
    },
  });
  const bashTool = cloud.toolDefinitionFromOpenAI({
    type: "function",
    function: {
      name: "Bash",
      description: "Run shell commands",
      parameters: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
    },
  });
  const readFields = cloud.parseFields(readTool);
  const bashFields = cloud.parseFields(bashTool);

  assert.equal(readFields.find((field) => field.fieldNum === 1).value.toString("utf8"), "Read");
  assert.equal(readFields.some((field) => field.fieldNum === 2), false);
  assert.equal(bashFields.find((field) => field.fieldNum === 2).value.toString("utf8"), "Run shell commands");
});

test("buildChatPrompt encodes assistant tool calls as native Windsurf tool_call fields", () => {
  const body = cloud.buildChatPrompt({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" },
      },
    ],
  });
  const fields = cloud.parseFields(body);
  const toolCall = cloud.parseFields(fields.find((field) => field.fieldNum === 6).value);

  assert.equal(fields.find((field) => field.fieldNum === 2).value, 2n);
  assert.equal(toolCall.find((field) => field.fieldNum === 1).value.toString("utf8"), "call_1");
  assert.equal(toolCall.find((field) => field.fieldNum === 2).value.toString("utf8"), "Read");
  assert.equal(toolCall.find((field) => field.fieldNum === 3).value.toString("utf8"), "{\"file_path\":\"README.md\"}");
});

test("toWindsurfRequest preserves OpenAI request fields and selects upstream model", () => {
  const provider = { upstream_model: "swe-1.6-fast", windsurf_model_uid: "swe-1-6-fast" };
  const input = {
    model: "windsurf/swe-1.6-fast",
    messages: [{ role: "user", content: "Hello" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    parallel_tool_calls: false,
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
  assert.equal(output.parallel_tool_calls, false);
});

test("toWindsurfRequest folds system prompts into user text for Windsurf compatibility", () => {
  const output = cloud.toWindsurfRequest(
    { upstream_model: "swe-1.6-fast", windsurf_model_uid: "swe-1-6-fast" },
    {
      model: "windsurf/swe-1.6-fast",
      messages: [
        { role: "system", content: "System rules" },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    },
  );

  assert.deepEqual(output.messages.map((message) => message.role), ["user"]);
  assert.match(output.messages[0].content, /System rules/);
  assert.match(output.messages[0].content, /Hello/);
});

test("toWindsurfRequest falls back to provider model and then input model", () => {
  assert.equal(
    cloud.toWindsurfRequest({ model: "provider-model" }, { model: "input-model", messages: [{ role: "user", content: "Hello" }] }).model,
    "provider-model",
  );
  assert.equal(cloud.toWindsurfRequest({}, { model: "input-model", messages: [{ role: "user", content: "Hello" }] }).model, "input-model");
});

test("buildHeaders mirrors Windsurf Connect stream headers without bearer auth", () => {
  const headers = cloud.buildHeaders({ key: "host-token", timeout_ms: 90000 });

  assert.equal(headers["content-type"], "application/connect+proto");
  assert.equal(headers["connect-protocol-version"], "1");
  assert.equal(headers.accept, undefined);
  assert.equal(headers["user-agent"], "connect-es/1.5.0");
  assert.equal(headers["connect-timeout-ms"], "90000");
  assert.equal(headers.Authorization, undefined);
});

test("buildHeaders keeps compatibility opt-ins explicit", () => {
  const headers = cloud.buildHeaders({
    include_accept_header: true,
    include_timeout_header: false,
    windsurf_user_agent: "custom-windsurf-ua",
    timeout_ms: 90000,
  });

  assert.equal(headers.accept, "application/connect+proto");
  assert.equal(headers["connect-timeout-ms"], undefined);
  assert.equal(headers["user-agent"], "custom-windsurf-ua");
});

test("resolveWindsurfOrigin supports app API and chat origin overrides", () => {
  const env = {
    WINDSURF_API_ORIGIN: "https://server.enterprise.windsurf.com",
    WINDSURF_CHAT_ORIGIN: "https://chat.example.com",
  };

  assert.equal(cloud.resolveWindsurfOrigin({}, { env, kind: "chat" }), "https://chat.example.com");
  assert.equal(cloud.resolveWindsurfOrigin({}, { env, kind: "config" }), "https://server.enterprise.windsurf.com");
  assert.equal(cloud.resolveWindsurfOrigin({ origin: "https://provider.example" }, { env, kind: "chat" }), "https://provider.example");
});

test("resolveWindsurfOrigin switches default endpoints with WINDSURF_ENTERPRISE", () => {
  assert.equal(
    cloud.resolveWindsurfOrigin({}, { env: { WINDSURF_ENTERPRISE: "false" }, kind: "chat" }),
    "https://server.codeium.com",
  );
  assert.equal(
    cloud.resolveWindsurfOrigin({}, { env: { WINDSURF_ENTERPRISE: "true" }, kind: "chat" }),
    "https://server.enterprise.windsurf.com",
  );
  assert.equal(
    cloud.resolveWindsurfOrigin({}, { env: { WINDSURF_ENTERPRISE: "true" }, kind: "config" }),
    "https://server.enterprise.windsurf.com",
  );
  assert.equal(
    cloud.resolveWindsurfOrigin(
      {},
      { env: { WINDSURF_ENTERPRISE: "true", WINDSURF_CHAT_ORIGIN: "https://chat.override.example" }, kind: "chat" },
    ),
    "https://chat.override.example",
  );
  assert.equal(
    cloud.resolveWindsurfOrigin({}, { env: { windsurf_enterprise: "true" }, kind: "chat" }),
    "https://server.enterprise.windsurf.com",
  );
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

test("toOpenAIResponse normalizes message content parts", () => {
  const output = cloud.toOpenAIResponse("windsurf/swe-1.6", {
    id: "ws_parts",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Windsurf " },
        { type: "text", text: "content parts" },
      ],
    },
  });

  assert.deepEqual(output.choices[0].message, { role: "assistant", content: "Windsurf \ncontent parts" });
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

test("toOpenAIResponse parses Windsurf Connect tool call deltas", () => {
  const toolCall = cloud.buildChatToolCall({
    id: "call_1",
    function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" },
  });
  const body = Buffer.concat([
    cloud.connectEnvelope(Buffer.concat([
      cloud.encodeString(3, "Running command"),
      cloud.encodeMessage(6, toolCall),
    ])),
    Buffer.from([2, 0, 0, 0, 0]),
  ]);
  const output = cloud.toOpenAIResponse("windsurf/swe-1.6", body);

  assert.equal(output.choices[0].finish_reason, "tool_calls");
  assert.equal(output.choices[0].message.content, "Running command");
  assert.deepEqual(output.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } },
  ]);
});

test("toOpenAIResponse merges Windsurf tool call argument fragments", () => {
  const body = Buffer.concat([
    cloud.connectEnvelope(cloud.encodeMessage(6, Buffer.concat([
      cloud.encodeString(1, "call_1"),
      cloud.encodeString(2, "Bash"),
    ]))),
    cloud.connectEnvelope(cloud.encodeMessage(6, cloud.encodeString(3, "{\"command\":\""))),
    cloud.connectEnvelope(cloud.encodeMessage(6, cloud.encodeString(3, "pwd"))),
    cloud.connectEnvelope(cloud.encodeMessage(6, cloud.encodeString(3, "\"}"))),
    Buffer.from([2, 0, 0, 0, 0]),
  ]);
  const output = cloud.toOpenAIResponse("windsurf/swe-1.6", body);

  assert.equal(output.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(output.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } },
  ]);
});

test("toOpenAIResponse treats trailer bit flags as error metadata", () => {
  const body = Buffer.concat([
    cloud.connectEnvelope(cloud.encodeString(3, "partial text")),
    cloud.connectEnvelope(Buffer.from('{"error":"permission_denied"}'), 3),
  ]);

  assert.throws(() => cloud.toOpenAIResponse("windsurf/swe-1.6", body), /permission_denied/);
});

test("createOpenAIStreamFrameParser emits Connect frames incrementally", () => {
  const parser = cloud.createOpenAIStreamFrameParser("windsurf/claude-opus-4-6-1m");
  const first = cloud.connectEnvelope(cloud.encodeString(3, "Hello "));
  const second = cloud.connectEnvelope(cloud.encodeString(3, "streaming"));

  assert.deepEqual(parser.push(first.subarray(0, 4)), []);
  const chunks = [
    ...parser.push(first.subarray(4)),
    ...parser.push(second),
    ...parser.end(),
  ];

  assert.equal(chunks.some((chunk) => chunk.includes('"role":"assistant"')), true);
  assert.equal(chunks.some((chunk) => chunk.includes("Hello ")), true);
  assert.equal(chunks.some((chunk) => chunk.includes("streaming")), true);
  assert.equal(chunks.some((chunk) => chunk.includes('"finish_reason":"stop"')), true);
});

test("streamWindsurfCloud streams HTTP/2 Connect response chunks before completion", async () => {
  const server = http2.createServer();
  const seen = [];
  const completionDelayMs = 120;
  server.on("stream", (stream, headers) => {
    seen.push(headers);
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.write(cloud.connectEnvelope(cloud.encodeString(3, "early ")));
    setTimeout(() => {
      stream.end(Buffer.concat([
        cloud.connectEnvelope(cloud.encodeString(3, "done")),
        cloud.connectEnvelope(Buffer.alloc(0), 2),
      ]));
    }, completionDelayMs);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const chunks = [];
    const firstChunkAt = [];
    const started = Date.now();
    await cloud.streamWindsurfCloud(
      {
        key: "host-token",
        origin: `http://127.0.0.1:${port}`,
        path: cloud.GET_CHAT_MESSAGE_PATH,
        upstream_model: "claude-opus-4-6-1m",
        windsurf_model_uid: "claude-opus-4-6-1m",
      },
      { model: "windsurf/claude-opus-4-6-1m", messages: [{ role: "user", content: "Hello" }], stream: true },
      {
        onChunk(chunk) {
          if (chunks.length === 0) firstChunkAt.push(Date.now() - started);
          chunks.push(chunk);
        },
      },
    );

    assert.equal(seen[0][":path"], cloud.GET_CHAT_MESSAGE_PATH);
    assert.equal(seen[0]["content-type"], "application/connect+proto");
    assert.equal(chunks.join("").includes("early "), true);
    assert.equal(chunks.join("").includes("done"), true);
    assert.equal(firstChunkAt[0] < completionDelayMs, true);
  } finally {
    await closeServer(server);
  }
});

test("streamWindsurfCloud uses a stream idle timeout and resets it after chunks", async () => {
  const server = http2.createServer();
  const seen = [];
  server.on("stream", (stream, headers) => {
    seen.push(headers);
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    setTimeout(() => {
      stream.write(cloud.connectEnvelope(cloud.encodeString(3, "first ")));
    }, 20);
    setTimeout(() => {
      stream.write(cloud.connectEnvelope(cloud.encodeString(3, "second ")));
    }, 60);
    setTimeout(() => {
      stream.end(Buffer.concat([
        cloud.connectEnvelope(cloud.encodeString(3, "done")),
        cloud.connectEnvelope(Buffer.alloc(0), 2),
      ]));
    }, 90);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const chunks = [];
    await cloud.streamWindsurfCloud(
      {
        key: "host-token",
        origin: `http://127.0.0.1:${port}`,
        path: cloud.GET_CHAT_MESSAGE_PATH,
        upstream_model: "claude-sonnet-4-6-thinking",
        windsurf_model_uid: "claude-sonnet-4-6-thinking",
        stream_timeout_ms: 50,
      },
      { model: "windsurf/claude-sonnet-4-6-thinking", messages: [{ role: "user", content: "Hello" }], stream: true },
      {
        onChunk(chunk) {
          chunks.push(chunk);
        },
      },
    );

    assert.equal(seen[0]["connect-timeout-ms"], "50");
    assert.match(chunks.join(""), /first /);
    assert.match(chunks.join(""), /second /);
    assert.match(chunks.join(""), /done/);
  } finally {
    await closeServer(server);
  }
});
