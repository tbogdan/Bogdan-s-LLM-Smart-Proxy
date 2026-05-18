# Project LLM Smart Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the cloned proxy into Project LLM Smart Proxy: one local Docker OpenAI-compatible proxy with scoped discovery and routing for Windsurf, Claude, and Codex provider families.

**Architecture:** Keep the existing Node.js proxy, scoring, compaction, and OpenAI-compatible client surface. Replace the broad provider catalog with three provider families, add protocol adapters for Claude Anthropic Messages and Windsurf cloud transport, keep Codex through the existing local OpenAI-compatible proxy, and preserve discovery as a scoped provider-refresh worker.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:test`, Docker Compose, existing zero-dependency runtime style, optional host CLIs for `claude setup-token` and `npx @openai/codex login`.

---

## File Structure

- Modify: `package.json` for scripts, name, and test command.
- Create: `tests/provider-config.test.js`, `tests/anthropic-adapter.test.js`, `tests/discovery.test.js`, `tests/branding-docs.test.js`.
- Create: `lib/provider-config.js` for supported family metadata, fallback models, groups, provider generation, and capability inference.
- Create: `lib/anthropic-adapter.js` for OpenAI-to-Anthropic request/response conversion and request transport.
- Create: `lib/windsurf-auth.js` for host browser login helpers and Windsurf one-time-token registration.
- Create: `lib/windsurf-cloud.js` for Windsurf HTTP/2 cloud chat transport and OpenAI-compatible response wrapping.
- Create: `lib/provider-adapters.js` for runtime protocol dispatch used by routing.
- Modify: `lib/providers.js` to hydrate `family`, `protocol`, and provider metadata from seed/discovery.
- Modify: `lib/routing.js` to call `provider-adapters` for non-OpenAI protocols while preserving failover/scoring.
- Modify: `lib/transforms.js` to rename injected system identity and preserve cleanup behavior.
- Replace: `seed-providers.json` with fallback providers for only Windsurf, Claude, and Codex.
- Rewrite: `llm-discovery.js` as scoped discovery with exported pure helpers and guarded daemon startup.
- Modify: `Dockerfile`, `Dockerfile.codex`, `docker-compose.yml`, `.env.example`, `setup.sh`.
- Rewrite: `README.md`, `INSTRUCTIONS.md`.
- Delete: `Dockerfile.kiro`, `kiro-auth.js` after Docker/setup no longer reference them.

## Task 1: Test Harness And Supported Provider Contract

**Files:**
- Modify: `package.json`
- Create: `tests/provider-config.test.js`
- Create: `lib/provider-config.js`

- [ ] **Step 1: Write the failing provider contract test**

Create `tests/provider-config.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../lib/provider-config");

test("supported families are exactly windsurf, claude, and codex", () => {
  assert.deepEqual(config.SUPPORTED_FAMILIES, ["windsurf", "claude", "codex"]);
});

test("fallback providers are namespaced and belong to supported families", () => {
  const seed = config.buildSeedConfig();
  assert.equal(seed.providers.length > 0, true);
  const families = new Set(seed.providers.map((p) => p.family));
  assert.deepEqual([...families].sort(), ["claude", "codex", "windsurf"]);

  for (const provider of seed.providers) {
    assert.equal(config.SUPPORTED_FAMILIES.includes(provider.family), true);
    assert.match(provider.model, /^(windsurf|claude|codex)\//);
    assert.equal(typeof provider.protocol, "string");
    assert.equal(provider.caps.includes("text"), true);
  }
});

test("smart groups keep existing routing names except removed image and video groups", () => {
  assert.deepEqual(config.GROUPS, {
    "auto-tools": "tools",
    "auto-coding": "coding",
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking",
  });
});

test("capabilities are inferred for supported model families", () => {
  assert.deepEqual(config.inferCapabilities("claude/claude-sonnet-4-5").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("codex/gpt-5.5").sort(), ["coding", "max", "text", "thinking", "tools"].sort());
  assert.deepEqual(config.inferCapabilities("windsurf/swe-1.6-fast").sort(), ["coding", "text", "thinking", "tools"].sort());
});
```

- [ ] **Step 2: Add the test command**

Modify `package.json` scripts to include:

```json
{
  "scripts": {
    "start": "node llm-proxy.js",
    "discovery": "node llm-discovery.js",
    "test": "node --test tests/*.test.js"
  }
}
```

Also set:

```json
{
  "name": "Project-llm-smart-proxy",
  "description": "Local Docker LLM smart proxy for Windsurf, Claude, and Codex provider families"
}
```

- [ ] **Step 3: Run the provider contract test and verify it fails**

Run:

```bash
rtk npm test -- tests/provider-config.test.js
```

Expected: FAIL with `Cannot find module '../lib/provider-config'`.

- [ ] **Step 4: Implement the provider config module**

Create `lib/provider-config.js`:

```js
"use strict";

const SUPPORTED_FAMILIES = ["windsurf", "claude", "codex"];

const GROUPS = {
  "auto-tools": "tools",
  "auto-coding": "coding",
  "auto-text": "text",
  "auto-max": "max",
  "auto-thinking": "thinking",
};

const FALLBACK_MODELS = {
  windsurf: [
    { id: "windsurf/swe-1.6-fast", upstream: "swe-1.6-fast", name: "Windsurf-SWE16Fast", context: 200000, tier: 1 },
    { id: "windsurf/swe-1.6", upstream: "swe-1.6", name: "Windsurf-SWE16", context: 200000, tier: 1 },
    { id: "windsurf/swe-1.5-fast", upstream: "swe-1.5-fast", name: "Windsurf-SWE15Fast", context: 200000, tier: 2 },
  ],
  claude: [
    { id: "claude/claude-opus-4-5", upstream: "claude-opus-4-5", name: "Claude-Opus45", context: 200000, tier: 1 },
    { id: "claude/claude-sonnet-4-5", upstream: "claude-sonnet-4-5", name: "Claude-Sonnet45", context: 200000, tier: 1 },
    { id: "claude/claude-sonnet-4", upstream: "claude-sonnet-4", name: "Claude-Sonnet4", context: 200000, tier: 1 },
    { id: "claude/claude-haiku-4-5", upstream: "claude-haiku-4-5", name: "Claude-Haiku45", context: 200000, tier: 2 },
  ],
  codex: [
    { id: "codex/gpt-5.5", upstream: "gpt-5.5", name: "Codex-GPT55", context: 1000000, tier: 1 },
    { id: "codex/gpt-5.4", upstream: "gpt-5.4", name: "Codex-GPT54", context: 200000, tier: 1 },
    { id: "codex/gpt-5.4-mini", upstream: "gpt-5.4-mini", name: "Codex-GPT54Mini", context: 200000, tier: 1 },
    { id: "codex/gpt-5.3-codex", upstream: "gpt-5.3-codex", name: "Codex-GPT53Codex", context: 200000, tier: 1 },
    { id: "codex/gpt-5.2", upstream: "gpt-5.2", name: "Codex-GPT52", context: 200000, tier: 1 },
  ],
};

function inferCapabilities(modelId) {
  const id = String(modelId || "").toLowerCase();
  const caps = new Set(["text"]);
  if (/claude|gpt|codex|swe/.test(id)) caps.add("coding");
  if (/claude|gpt|codex|swe/.test(id)) caps.add("tools");
  if (/claude|gpt-5|codex|swe/.test(id)) caps.add("thinking");
  if (/opus|sonnet|gpt-5\.5|gpt-5\.4|codex/.test(id)) caps.add("max");
  return [...caps];
}

function providerForModel(family, model) {
  const protocol = family === "claude" ? "anthropic" : family === "windsurf" ? "windsurf" : "openai";
  const keyEnv = family === "claude" ? "CLAUDE_CODE_OAUTH_TOKEN" : family === "windsurf" ? "WINDSURF_API_KEY" : "CODEX_API_KEY";
  const url = family === "codex" ? "http://codex-proxy:10531/v1/chat/completions" : family;
  return {
    name: model.name,
    family,
    protocol,
    url,
    key_env: keyEnv,
    model: model.id,
    upstream_model: model.upstream,
    context: model.context,
    tier: model.tier,
    tc: inferCapabilities(model.id).includes("thinking"),
    caps: inferCapabilities(model.id),
    headers: {},
    seed: true,
  };
}

function buildSeedConfig() {
  const providers = [];
  for (const family of SUPPORTED_FAMILIES) {
    for (const model of FALLBACK_MODELS[family]) {
      providers.push(providerForModel(family, model));
    }
  }
  return { providers, groups: GROUPS };
}

module.exports = {
  SUPPORTED_FAMILIES,
  GROUPS,
  FALLBACK_MODELS,
  inferCapabilities,
  providerForModel,
  buildSeedConfig,
};
```

- [ ] **Step 5: Run the provider contract test and verify it passes**

Run:

```bash
rtk npm test -- tests/provider-config.test.js
```

Expected: PASS for all provider-config tests.

- [ ] **Step 6: Commit**

```bash
rtk git add package.json lib/provider-config.js tests/provider-config.test.js
rtk git commit -m "test: define supported provider families"
```

## Task 2: Anthropic Adapter

**Files:**
- Create: `tests/anthropic-adapter.test.js`
- Create: `lib/anthropic-adapter.js`

- [ ] **Step 1: Write failing conversion tests**

Create `tests/anthropic-adapter.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const anthropic = require("../lib/anthropic-adapter");

test("converts OpenAI chat request to Anthropic Messages request", () => {
  const provider = { upstream_model: "claude-sonnet-4-5" };
  const input = {
    model: "claude/claude-sonnet-4-5",
    messages: [
      { role: "system", content: "System A" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read file", parameters: { type: "object" } } }],
    max_tokens: 1234,
    temperature: 0.2,
    stream: true,
  };

  const output = anthropic.toAnthropicRequest(provider, input);

  assert.equal(output.model, "claude-sonnet-4-5");
  assert.equal(output.system, "System A");
  assert.equal(output.max_tokens, 1234);
  assert.equal(output.temperature, 0.2);
  assert.equal(output.stream, true);
  assert.deepEqual(output.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(output.tools[0].name, "read_file");
});

test("converts Anthropic response to OpenAI chat completion", () => {
  const output = anthropic.toOpenAIResponse("claude/claude-sonnet-4-5", {
    id: "msg_123",
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [{ type: "text", text: "Hello there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  assert.equal(output.id, "chatcmpl-msg_123");
  assert.equal(output.model, "claude/claude-sonnet-4-5");
  assert.equal(output.choices[0].message.content, "Hello there");
  assert.equal(output.choices[0].finish_reason, "stop");
  assert.deepEqual(output.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test("builds Anthropic headers from OAuth token", () => {
  const headers = anthropic.buildHeaders({ key: "oauth-token" });
  assert.equal(headers.Authorization, "Bearer oauth-token");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
});
```

- [ ] **Step 2: Run the adapter tests and verify they fail**

Run:

```bash
rtk npm test -- tests/anthropic-adapter.test.js
```

Expected: FAIL with `Cannot find module '../lib/anthropic-adapter'`.

- [ ] **Step 3: Implement the Anthropic adapter**

Create `lib/anthropic-adapter.js` with these exports:

```js
"use strict";

const https = require("https");
const { URL } = require("url");

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function textFromOpenAIContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n");
  }
  return String(content);
}

function toAnthropicTools(tools) {
  return (tools || [])
    .filter((tool) => tool && tool.type === "function" && tool.function)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || "",
      input_schema: tool.function.parameters || { type: "object", properties: {} },
    }));
}

function toAnthropicRequest(provider, reqBody) {
  const messages = [];
  const systems = [];
  for (const msg of reqBody.messages || []) {
    if (msg.role === "system") {
      const text = textFromOpenAIContent(msg.content);
      if (text) systems.push(text);
      continue;
    }
    if (msg.role === "tool") {
      messages.push({ role: "user", content: `Tool result ${msg.tool_call_id || ""}:\n${textFromOpenAIContent(msg.content)}`.trim() });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const text = textFromOpenAIContent(msg.content);
      const calls = JSON.stringify(msg.tool_calls);
      messages.push({ role: "assistant", content: [text, `Tool calls: ${calls}`].filter(Boolean).join("\n") });
      continue;
    }
    messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: textFromOpenAIContent(msg.content) });
  }

  const body = {
    model: provider.upstream_model || String(provider.model || "").replace(/^claude\//, ""),
    max_tokens: reqBody.max_tokens || 4096,
    messages,
  };
  if (systems.length > 0) body.system = systems.join("\n\n");
  if (reqBody.temperature !== undefined) body.temperature = reqBody.temperature;
  if (reqBody.stream !== undefined) body.stream = !!reqBody.stream;
  const tools = toAnthropicTools(reqBody.tools);
  if (tools.length > 0) body.tools = tools;
  return body;
}

function finishReason(stopReason) {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  return "stop";
}

function contentText(content) {
  return (content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("");
}

function toOpenAIResponse(model, data) {
  const prompt = data.usage?.input_tokens || 0;
  const completion = data.usage?.output_tokens || 0;
  return {
    id: `chatcmpl-${data.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: contentText(data.content) },
      finish_reason: finishReason(data.stop_reason),
    }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

function buildHeaders(provider) {
  const headers = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (provider.key) headers.Authorization = `Bearer ${provider.key}`;
  return headers;
}

function postAnthropic(provider, reqBody, transformedBody) {
  return new Promise((resolve, reject) => {
    const target = provider.url && /^https?:\/\//.test(provider.url) ? provider.url : DEFAULT_MESSAGES_URL;
    const parsed = new URL(target);
    const bodyStr = JSON.stringify(transformedBody || toAnthropicRequest(provider, reqBody));
    const req = https.request(parsed, { method: "POST", headers: buildHeaders(provider), timeout: 300000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(bodyStr);
    req.end();
  });
}

module.exports = {
  ANTHROPIC_VERSION,
  toAnthropicRequest,
  toOpenAIResponse,
  buildHeaders,
  postAnthropic,
};
```

- [ ] **Step 4: Run adapter tests and verify they pass**

Run:

```bash
rtk npm test -- tests/anthropic-adapter.test.js
```

Expected: PASS for all Anthropic adapter tests.

- [ ] **Step 5: Commit**

```bash
rtk git add lib/anthropic-adapter.js tests/anthropic-adapter.test.js
rtk git commit -m "feat: add anthropic protocol adapter"
```

## Task 3: Windsurf Host Auth And Cloud Adapter

**Files:**
- Create: `tests/windsurf.test.js`
- Create: `lib/windsurf-auth.js`
- Create: `lib/windsurf-cloud.js`
- Create: `windsurf-auth.js`

- [ ] **Step 1: Write failing Windsurf pure helper tests**

Create `tests/windsurf.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../lib/windsurf-auth");
const cloud = require("../lib/windsurf-cloud");

test("normalizes Windsurf one-time auth tokens", () => {
  assert.equal(auth.normalizeOneTimeAuthToken("abc123"), "ott$abc123");
  assert.equal(auth.normalizeOneTimeAuthToken("/ott$abc123"), "ott$abc123");
  assert.equal(auth.normalizeOneTimeAuthToken("https://x/#access_token=ott%24abc123"), "ott$abc123");
});

test("builds Windsurf provider models with namespaced ids", () => {
  const models = cloud.buildWindsurfProviders([
    { id: "swe-1.6-fast", name: "SWE 1.6 Fast", modelUid: "swe-1-6-fast", contextWindow: 200000, maxTokens: 64000 },
  ]);
  assert.equal(models[0].family, "windsurf");
  assert.equal(models[0].protocol, "windsurf");
  assert.equal(models[0].model, "windsurf/swe-1.6-fast");
  assert.equal(models[0].upstream_model, "swe-1.6-fast");
});
```

- [ ] **Step 2: Run Windsurf tests and verify they fail**

Run:

```bash
rtk npm test -- tests/windsurf.test.js
```

Expected: FAIL with missing Windsurf modules.

- [ ] **Step 3: Implement `lib/windsurf-auth.js`**

Implement a CommonJS port of the host-browser auth helper:

```js
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");

const WINDSURF_LOGIN_URL = "https://windsurf.com/windsurf/signin";
const WINDSURF_REGISTER_URL = "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser";
const WINDSURF_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u";

function normalizeOneTimeAuthToken(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("Windsurf one-time auth token is required");
  const embedded = trimmed.match(/\/?ott\$[^\s"'<>]+/);
  if (embedded) return embedded[0].replace(/^\//, "");
  try {
    const url = new URL(trimmed);
    const candidates = [url.hash ? new URLSearchParams(url.hash.slice(1)) : null, url.searchParams].filter(Boolean);
    for (const params of candidates) {
      for (const key of ["authToken", "auth_token", "access_token", "token", "code"]) {
        const value = params.get(key);
        if (value && value.trim()) return normalizeOneTimeAuthToken(value);
      }
    }
  } catch {}
  if (trimmed.startsWith("ott$")) return trimmed;
  if (trimmed.startsWith("/ott$")) return trimmed.slice(1);
  return `ott$${trimmed}`;
}

function encodeVarint(value) {
  const bytes = [];
  let current = BigInt(value);
  while (current > 127n) {
    bytes.push(Number(current & 0x7fn) | 0x80);
    current >>= 7n;
  }
  bytes.push(Number(current));
  return bytes;
}

function encodeString(fieldNum, value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.from([...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(bytes.length), ...bytes]);
}

function buildLoginUrl(redirectUri, loginHint) {
  const url = new URL(WINDSURF_LOGIN_URL);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("client_id", WINDSURF_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", crypto.randomUUID());
  url.searchParams.set("prompt", "login");
  url.searchParams.set("redirect_parameters_type", "fragment");
  url.searchParams.set("workflow", "");
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return url.toString();
}

function registerWindsurfOneTimeToken(tokenInput) {
  const token = normalizeOneTimeAuthToken(tokenInput);
  return new Promise((resolve, reject) => {
    const body = encodeString(1, token);
    const req = https.request(WINDSURF_REGISTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "user-agent": "Project-llm-smart-proxy",
        "content-length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`Windsurf registration failed with HTTP ${res.statusCode}`));
        const text = Buffer.concat(chunks).toString("utf8");
        const match = text.match(/[A-Za-z0-9_-]{20,}/);
        if (!match) return reject(new Error("Windsurf registration response did not include an API key"));
        resolve({ apiKey: match[0] });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function startLoopbackAuth() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/callback-token") {
        const token = normalizeOneTimeAuthToken(url.searchParams.get("access_token") || url.searchParams.get("authToken") || "");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("OK");
        server.close();
        resolve(token);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body><p>Windsurf authentication complete. You can close this tab.</p><script>const p=new URLSearchParams(location.hash.slice(1));fetch('/callback-token?'+p.toString()).catch(()=>{});</script></body></html>");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      console.log(buildLoginUrl(redirectUri));
    });
  });
}

module.exports = {
  normalizeOneTimeAuthToken,
  encodeString,
  buildLoginUrl,
  registerWindsurfOneTimeToken,
  startLoopbackAuth,
};
```

- [ ] **Step 4: Implement `lib/windsurf-cloud.js`**

Create a CommonJS transport with the same public surface used by tests and routing:

```js
"use strict";

const crypto = require("crypto");
const http2 = require("http2");
const providerConfig = require("./provider-config");

const CODEIUM_API_ORIGIN = "https://server.codeium.com";
const GET_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

const FALLBACK_MODELS = [
  { id: "swe-1.6-fast", name: "SWE 1.6 Fast", modelUid: "swe-1-6-fast", contextWindow: 200000, maxTokens: 64000 },
  { id: "swe-1.6", name: "SWE 1.6", modelUid: "swe-1-6", contextWindow: 200000, maxTokens: 64000 },
  { id: "swe-1.5-fast", name: "SWE 1.5 Fast", modelUid: "swe-1-5", contextWindow: 200000, maxTokens: 64000 },
];

function resolveModel(modelId) {
  const id = String(modelId || "").replace(/^windsurf\//, "");
  return FALLBACK_MODELS.find((model) => model.id === id || model.modelUid === id) || FALLBACK_MODELS[0];
}

function buildWindsurfProviders(models = FALLBACK_MODELS) {
  return models.map((model) => ({
    name: `Windsurf-${model.id.replace(/[^a-zA-Z0-9]/g, "")}`,
    family: "windsurf",
    protocol: "windsurf",
    url: "windsurf",
    key_env: "WINDSURF_API_KEY",
    model: `windsurf/${model.id}`,
    upstream_model: model.id,
    windsurf_model_uid: model.modelUid,
    context: model.contextWindow,
    tier: model.id.includes("fast") ? 1 : 2,
    tc: true,
    caps: providerConfig.inferCapabilities(`windsurf/${model.id}`),
    headers: {},
  }));
}

function textContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n");
  return String(content);
}

function openAIResponse(model, content) {
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

async function collectChat(provider, reqBody) {
  const apiKey = provider.key || process.env.WINDSURF_API_KEY;
  if (!apiKey) throw new Error("WINDSURF_API_KEY is required");
  const prompt = (reqBody.messages || []).map((msg) => `${msg.role.toUpperCase()}: ${textContent(msg.content)}`).join("\n\n");
  const model = resolveModel(provider.upstream_model || provider.model);
  return await callWindsurfCloud(apiKey, model, prompt);
}

function callWindsurfCloud(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(CODEIUM_API_ORIGIN);
    client.on("error", reject);
    client.on("connect", () => {
      const req = client.request({
        ":method": "POST",
        ":path": GET_CHAT_MESSAGE_PATH,
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        accept: "application/connect+proto",
        "x-api-key": apiKey,
      });
      const body = Buffer.from(JSON.stringify({ model: model.modelUid, prompt }), "utf8");
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        client.close();
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw || "");
      });
      req.on("error", (err) => { client.close(); reject(err); });
      req.end(body);
    });
  });
}

async function route(provider, reqBody) {
  const content = await collectChat(provider, reqBody);
  return { status: 200, headers: {}, body: JSON.stringify(openAIResponse(provider.model, content)) };
}

module.exports = {
  FALLBACK_MODELS,
  resolveModel,
  buildWindsurfProviders,
  openAIResponse,
  collectChat,
  route,
};
```

In the same edit, implement `callWindsurfCloud` with a CommonJS port of the Connect/protobuf transport inspected from `windsurf-oauth-opencode@0.1.8`: include `encodeVarint`, `encodeString`, `encodeMessage`, `encodeVarintField`, `connectEnvelope`, `readVarint`, `parseFields`, `takeConnectEnvelopes`, `buildMetadata`, `buildChatPrompt`, and `buildGetChatMessageRequest`. The final `callWindsurfCloud` sends `application/connect+proto`, parses Connect envelopes, concatenates field `3` response text, closes the HTTP/2 client in `finally`, and keeps the public exports in this task unchanged.

- [ ] **Step 5: Add host auth CLI wrapper**

Create `windsurf-auth.js`:

```js
#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { startLoopbackAuth, registerWindsurfOneTimeToken } = require("./lib/windsurf-auth");

const envFile = process.argv.includes("--env-file") ? process.argv[process.argv.indexOf("--env-file") + 1] : ".env";

function upsertEnv(key, value) {
  const file = path.resolve(envFile);
  const line = `${key}=${value}`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(file, text);
}

(async () => {
  console.log("Open the printed Windsurf URL in your browser.");
  const token = await startLoopbackAuth();
  const auth = await registerWindsurfOneTimeToken(token);
  upsertEnv("WINDSURF_API_KEY", auth.apiKey);
  console.log(`Saved WINDSURF_API_KEY to ${envFile}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 6: Run Windsurf tests and verify they pass**

Run:

```bash
rtk npm test -- tests/windsurf.test.js
```

Expected: PASS for Windsurf helper tests.

- [ ] **Step 7: Commit**

```bash
rtk git add lib/windsurf-auth.js lib/windsurf-cloud.js windsurf-auth.js tests/windsurf.test.js
rtk git commit -m "feat: add windsurf host auth and adapter"
```

## Task 4: Scoped Discovery

**Files:**
- Create: `tests/discovery.test.js`
- Modify: `llm-discovery.js`
- Replace: `seed-providers.json`

- [ ] **Step 1: Write failing discovery tests**

Create `tests/discovery.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const discovery = require("../llm-discovery");

test("discovery endpoints are scoped to enabled supported providers", () => {
  const env = {
    ENABLE_WINDSURF: "true",
    WINDSURF_API_KEY: "ws",
    ENABLE_CLAUDE: "true",
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
    ENABLE_CODEX: "true",
    CODEX_API_KEY: "proxy",
  };
  const endpoints = discovery.getEndpoints(env);
  assert.deepEqual(endpoints.map((ep) => ep.name).sort(), ["Claude", "Codex", "Windsurf"]);
});

test("initial provider config contains only supported families", () => {
  const seed = discovery.loadSeed();
  const families = new Set(seed.providers.map((provider) => provider.family));
  assert.deepEqual([...families].sort(), ["claude", "codex", "windsurf"]);
});
```

- [ ] **Step 2: Run discovery tests and verify they fail**

Run:

```bash
rtk npm test -- tests/discovery.test.js
```

Expected: FAIL because `llm-discovery.js` does not export helpers and still defines unrelated endpoints.

- [ ] **Step 3: Rewrite `seed-providers.json`**

Replace the current large catalog with generated fallback config:

```json
{
  "providers": [
    {
      "name": "Windsurf-SWE16Fast",
      "family": "windsurf",
      "protocol": "windsurf",
      "url": "windsurf",
      "key_env": "WINDSURF_API_KEY",
      "model": "windsurf/swe-1.6-fast",
      "upstream_model": "swe-1.6-fast",
      "context": 200000,
      "tier": 1,
      "tc": true,
      "caps": ["tools", "coding", "text", "thinking"],
      "headers": {}
    },
    {
      "name": "Claude-Sonnet45",
      "family": "claude",
      "protocol": "anthropic",
      "url": "https://api.anthropic.com/v1/messages",
      "key_env": "CLAUDE_CODE_OAUTH_TOKEN",
      "model": "claude/claude-sonnet-4-5",
      "upstream_model": "claude-sonnet-4-5",
      "context": 200000,
      "tier": 1,
      "tc": true,
      "caps": ["tools", "coding", "text", "max", "thinking"],
      "headers": {}
    },
    {
      "name": "Codex-GPT55",
      "family": "codex",
      "protocol": "openai",
      "url": "http://codex-proxy:10531/v1/chat/completions",
      "key_env": "CODEX_API_KEY",
      "model": "codex/gpt-5.5",
      "upstream_model": "gpt-5.5",
      "context": 1000000,
      "tier": 1,
      "tc": true,
      "caps": ["tools", "coding", "text", "max", "thinking"],
      "headers": {}
    }
  ],
  "groups": {
    "auto-tools": "tools",
    "auto-coding": "coding",
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking"
  }
}
```

The final `seed-providers.json` must contain every entry produced by `providerForModel` for all models in `FALLBACK_MODELS`: three Windsurf entries, four Claude entries, and five Codex entries. Preserve the same field names shown above for each entry, with each model's own `name`, `model`, `upstream_model`, `context`, `tier`, `tc`, and `caps` values from `lib/provider-config.js`.

- [ ] **Step 4: Rewrite discovery endpoint selection**

Modify `llm-discovery.js` to:

```js
const providerConfig = require("./lib/provider-config");
const windsurfCloud = require("./lib/windsurf-cloud");

function getEndpoints(env = process.env) {
  const endpoints = [];
  if (env.ENABLE_WINDSURF === "true" && env.WINDSURF_API_KEY) {
    endpoints.push({ name: "Windsurf", family: "windsurf", protocol: "windsurf", key_env: "WINDSURF_API_KEY" });
  }
  if (env.ENABLE_CLAUDE === "true" && (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
    endpoints.push({
      name: "Claude",
      family: "claude",
      protocol: "anthropic",
      modelsUrl: "https://api.anthropic.com/v1/models",
      chatUrl: "https://api.anthropic.com/v1/messages",
      headers: {
        Authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      key_env: env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY",
    });
  }
  if (env.ENABLE_CODEX === "true" && env.CODEX_API_KEY) {
    endpoints.push({
      name: "Codex",
      family: "codex",
      protocol: "openai",
      modelsUrl: "http://codex-proxy:10531/v1/models",
      chatUrl: "http://codex-proxy:10531/v1/chat/completions",
      headers: { Authorization: `Bearer ${env.CODEX_API_KEY}` },
      key_env: "CODEX_API_KEY",
    });
  }
  return endpoints;
}

if (require.main === module) {
  main();
}

module.exports = {
  getEndpoints,
  loadSeed,
  writeProvidersFile,
  generateInitialProvidersFile,
  runDiscoveryScan,
};
```

Remove all unrelated endpoint branches from `getEndpoints`. Keep `fetchJSON`, `postJSON`, `writeProvidersFile`, and daemon loop behavior.

- [ ] **Step 5: Adapt scan mapping for the three protocols**

In `runDiscoveryScan`, map models by family:

```js
function providersFromEndpointModels(ep, models) {
  if (ep.family === "windsurf") return windsurfCloud.buildWindsurfProviders();
  return models.map((modelData) => {
    const upstream = modelData.id || modelData.name;
    const model = `${ep.family}/${upstream}`;
    return {
      name: `${ep.name}-${upstream.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`,
      family: ep.family,
      protocol: ep.protocol,
      url: ep.chatUrl || ep.family,
      key_env: ep.key_env,
      model,
      upstream_model: upstream,
      context: modelData.context_length || modelData.max_tokens || (ep.family === "codex" && /5\.5/.test(upstream) ? 1000000 : 200000),
      tier: /opus|sonnet|gpt-5\.5|gpt-5\.4/.test(upstream) ? 1 : 2,
      tc: providerConfig.inferCapabilities(model).includes("thinking"),
      caps: providerConfig.inferCapabilities(model),
      headers: {},
      alive: true,
      last_tested: new Date().toISOString(),
    };
  });
}
```

Use this helper instead of the old broad provider discovery mapping.

- [ ] **Step 6: Run discovery tests and verify they pass**

Run:

```bash
rtk npm test -- tests/discovery.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add llm-discovery.js seed-providers.json tests/discovery.test.js
rtk git commit -m "feat: scope discovery to supported providers"
```

## Task 5: Runtime Provider Hydration And Adapter Dispatch

**Files:**
- Modify: `lib/providers.js`
- Create: `lib/provider-adapters.js`
- Modify: `lib/routing.js`
- Modify: `lib/transforms.js`

- [ ] **Step 1: Write failing runtime dispatch tests**

Append to `tests/provider-config.test.js`:

```js
test("provider hydration preserves protocol metadata", () => {
  const providers = require("../lib/providers");
  const hydrated = providers.hydrateSeedProviders({
    providers: [{
      name: "Claude-Sonnet45",
      family: "claude",
      protocol: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      key_env: "CLAUDE_CODE_OAUTH_TOKEN",
      model: "claude/claude-sonnet-4-5",
      upstream_model: "claude-sonnet-4-5",
      context: 200000,
      tier: 1,
      tc: true,
      caps: ["text"],
    }],
    groups: config.GROUPS,
  });
  assert.equal(hydrated.providers[0].family, "claude");
  assert.equal(hydrated.providers[0].protocol, "anthropic");
  assert.equal(hydrated.providers[0].upstream_model, "claude-sonnet-4-5");
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
rtk npm test -- tests/provider-config.test.js
```

Expected: FAIL because hydration does not preserve all metadata.

- [ ] **Step 3: Preserve metadata in `lib/providers.js`**

In both `hydrateSeedProviders` and `hydrateProvidersFile`, add:

```js
family: p.family || "",
protocol: p.protocol || "openai",
upstream_model: p.upstream_model || p.model,
```

Keep existing fields untouched.

- [ ] **Step 4: Create `lib/provider-adapters.js`**

Create:

```js
"use strict";

const anthropic = require("./anthropic-adapter");
const windsurf = require("./windsurf-cloud");

function isOpenAIProtocol(provider) {
  return !provider.protocol || provider.protocol === "openai";
}

async function routeNonStreaming(provider, reqBody, openAIRoute) {
  if (isOpenAIProtocol(provider)) return openAIRoute(provider, reqBody);
  if (provider.protocol === "anthropic") {
    const upstream = await anthropic.postAnthropic(provider, reqBody);
    if (upstream.status >= 400) return upstream;
    const data = JSON.parse(upstream.body);
    return { status: upstream.status, headers: upstream.headers, body: JSON.stringify(anthropic.toOpenAIResponse(provider.model, data)) };
  }
  if (provider.protocol === "windsurf") {
    return windsurf.route(provider, reqBody);
  }
  throw new Error(`Unsupported provider protocol: ${provider.protocol}`);
}

module.exports = {
  isOpenAIProtocol,
  routeNonStreaming,
};
```

- [ ] **Step 5: Dispatch adapters from `lib/routing.js`**

At the top:

```js
const providerAdapters = require("./provider-adapters");
```

In `routeToProvider`, wrap the existing OpenAI-compatible body in a local function and call:

```js
async function routeToProvider(provider, reqBody) {
  return providerAdapters.routeNonStreaming(provider, reqBody, routeOpenAICompatibleProvider);
}
```

Move the previous `routeToProvider` body into:

```js
async function routeOpenAICompatibleProvider(provider, reqBody) {
  const body = transforms.transformRequest(provider, reqBody);
  body.model = provider.upstream_model || provider.model;
  body.stream = false;
  delete body.stream_options;
  // keep the remaining existing implementation unchanged
}
```

For streaming, initially let non-OpenAI protocols use the validated non-streaming path followed by `sendAsSSE`. Keep existing `routeStreamToProvider` for OpenAI/Codex protocol providers.

- [ ] **Step 6: Rename system identity in `lib/transforms.js`**

Change:

```js
`You are Bogdan's LLM Smart Proxy — senior staff engineer. Date: ${dateStr} ${timeStr}.`
```

to:

```js
`You are Project LLM Smart Proxy — senior staff engineer. Date: ${dateStr} ${timeStr}.`
```

Change the strip marker from:

```js
const proxyMarker = "You are Bogdan's LLM Smart Proxy";
```

to:

```js
const proxyMarker = "You are Project LLM Smart Proxy";
```

Also strip legacy injected prompts by removing any existing `You are Bogdan's LLM Smart Proxy` block before adding the new one.

- [ ] **Step 7: Run tests**

Run:

```bash
rtk npm test
```

Expected: PASS for all tests written so far.

- [ ] **Step 8: Commit**

```bash
rtk git add lib/providers.js lib/provider-adapters.js lib/routing.js lib/transforms.js tests/provider-config.test.js
rtk git commit -m "feat: dispatch provider protocols"
```

## Task 6: Docker, Environment, And Setup

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `setup.sh`
- Delete: `Dockerfile.kiro`
- Delete: `kiro-auth.js`

- [ ] **Step 1: Update Dockerfile copy list**

Ensure new runtime files are copied:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY llm-proxy.js llm-discovery.js llm-mempalace.js seed-providers.json package.json ./
COPY lib/ lib/
COPY .env.example .env.example
EXPOSE 18900
CMD ["node", "llm-proxy.js"]
```

- [ ] **Step 2: Replace Docker Compose services**

Set `docker-compose.yml` to:

```yaml
services:
  llm-proxy:
    build: .
    ports:
      - "18900:18900"
    env_file: .env
    environment:
      - MEMPALACE_URL=http://mempalace-mcp:8891
    volumes:
      - ./data:/data
    restart: unless-stopped

  llm-discovery:
    build: .
    command: ["node", "llm-discovery.js"]
    env_file: .env
    volumes:
      - ./data:/data
    restart: unless-stopped

  codex-proxy:
    build:
      context: .
      dockerfile: Dockerfile.codex
    volumes:
      - ./data/codex-auth.json:/root/.codex/auth.json:ro
    ports:
      - "10531:10531"
    restart: unless-stopped
    profiles: [codex]

  mempalace-mcp:
    build:
      context: .
      dockerfile: Dockerfile.mempalace
    volumes:
      - ./palace:/palace
      - ./data:/data
    ports:
      - "8891:8891"
    restart: unless-stopped
    profiles: [memory]
```

- [ ] **Step 3: Rewrite `.env.example`**

Use only relevant variables:

```bash
LLM_PROXY_PORT=18900
DATA_DIR=/data
DEV_MODE=false

ENABLE_WINDSURF=false
WINDSURF_API_KEY=

ENABLE_CLAUDE=false
CLAUDE_CODE_OAUTH_TOKEN=
ANTHROPIC_API_KEY=

ENABLE_CODEX=false
CODEX_API_KEY=proxy

MEMPALACE_ENABLED=false
MEMPALACE_URL=http://mempalace-mcp:8891
MEMPALACE_MAX_INJECT_TOKENS=2000
```

- [ ] **Step 4: Rewrite `setup.sh`**

Keep it focused:

```bash
#!/bin/bash
set -e

echo "=== Project LLM Smart Proxy Setup ==="

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker not installed."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose V2 not available."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env"
fi

mkdir -p data palace

read -p "Enable Windsurf provider? (y/N): " ENABLE_WS
if [[ "$ENABLE_WS" =~ ^[Yy]$ ]]; then
  sed -i.bak "s/^ENABLE_WINDSURF=.*/ENABLE_WINDSURF=true/" .env && rm -f .env.bak
  if ! grep -q "^WINDSURF_API_KEY=." .env; then
    echo "Run host auth: node windsurf-auth.js --env-file .env"
  fi
fi

read -p "Enable Claude provider? (y/N): " ENABLE_CLAUDE
if [[ "$ENABLE_CLAUDE" =~ ^[Yy]$ ]]; then
  sed -i.bak "s/^ENABLE_CLAUDE=.*/ENABLE_CLAUDE=true/" .env && rm -f .env.bak
  if ! grep -q "^CLAUDE_CODE_OAUTH_TOKEN=." .env && ! grep -q "^ANTHROPIC_API_KEY=." .env; then
    echo "Run on host: claude setup-token"
    echo "Then paste the token into .env as CLAUDE_CODE_OAUTH_TOKEN."
  fi
fi

PROFILES=""
read -p "Enable Codex provider? (y/N): " ENABLE_CODEX
if [[ "$ENABLE_CODEX" =~ ^[Yy]$ ]]; then
  sed -i.bak "s/^ENABLE_CODEX=.*/ENABLE_CODEX=true/" .env && rm -f .env.bak
  PROFILES="$PROFILES --profile codex"
  if [ ! -f data/codex-auth.json ]; then
    echo "Run on host: npx @openai/codex login"
    echo "Then copy: cp ~/.codex/auth.json data/codex-auth.json"
  fi
fi

docker compose $PROFILES up -d --build

echo "Proxy:  http://localhost:18900"
echo "Health: http://localhost:18900/health"
echo "Models: http://localhost:18900/v1/models"
```

Replace the repeated `sed -i.bak` calls with this helper so setup works on macOS and Linux:

```bash
set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    awk -v key="$key" -v value="$value" 'BEGIN{FS=OFS="="} $1==key {$0=key OFS value} {print}' .env > .env.tmp
    mv .env.tmp .env
  else
    printf "\n%s=%s\n" "$key" "$value" >> .env
  fi
}
```

Then call `set_env ENABLE_WINDSURF true`, `set_env ENABLE_CLAUDE true`, and `set_env ENABLE_CODEX true` in the matching branches.

- [ ] **Step 5: Remove Kiro files**

Run:

```bash
rtk git rm Dockerfile.kiro kiro-auth.js
```

- [ ] **Step 6: Verify Docker Compose config**

Run:

```bash
rtk docker compose config
```

Expected: exit 0 and services `llm-proxy`, `llm-discovery`, `codex-proxy`, `mempalace-mcp`.

- [ ] **Step 7: Commit**

```bash
rtk git add Dockerfile docker-compose.yml .env.example setup.sh
rtk git add -u Dockerfile.kiro kiro-auth.js
rtk git commit -m "chore: simplify docker setup for Project providers"
```

## Task 7: Documentation And Branding

**Files:**
- Rewrite: `README.md`
- Rewrite: `INSTRUCTIONS.md`
- Create: `tests/branding-docs.test.js`

- [ ] **Step 1: Write failing docs/branding tests**

Create `tests/branding-docs.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

test("public docs use Project branding and supported providers only", () => {
  const files = ["README.md", "INSTRUCTIONS.md", "package.json", "lib/transforms.js"];
  const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(text.includes("Bogdan's LLM Smart Proxy"), false);
  assert.equal(text.includes("Project LLM Smart Proxy"), true);
  for (const removed of ["Groq", "SambaNova", "Kiro", "OpenRouter", "ModelScope", "Cline Provider"]) {
    assert.equal(text.includes(removed), false, `${removed} should not appear in public setup docs`);
  }
});
```

- [ ] **Step 2: Run docs test and verify it fails**

Run:

```bash
rtk npm test -- tests/branding-docs.test.js
```

Expected: FAIL because current docs still mention old branding and removed providers.

- [ ] **Step 3: Rewrite `README.md`**

Include these sections, in this order:

```markdown
# Project LLM Smart Proxy

Local Docker smart proxy for three multi-model provider families: Windsurf, Claude, and Codex. Clients talk to one OpenAI-compatible endpoint; the proxy discovers models, scores providers, routes by capability, and fails over when an upstream is unavailable.

## Supported Providers

| Family | Auth on host | Runtime path | Models |
|---|---|---|---|
| Windsurf | `node windsurf-auth.js --env-file .env` | Native proxy adapter | `windsurf/swe-1.6-fast`, `windsurf/swe-1.6`, `windsurf/swe-1.5-fast` |
| Claude | `claude setup-token` then `CLAUDE_CODE_OAUTH_TOKEN` | Anthropic Messages adapter | `claude/...` models returned by discovery |
| Codex | `npx @openai/codex login` then copy `auth.json` | Local Codex proxy container | `codex/gpt-5.5`, `codex/gpt-5.4`, `codex/gpt-5.4-mini`, `codex/gpt-5.3-codex`, `codex/gpt-5.2` |

## Quick Start

```bash
chmod +x setup.sh
./setup.sh
```

## Manual Setup

```bash
cp .env.example .env
node windsurf-auth.js --env-file .env
claude setup-token
npx @openai/codex login
mkdir -p data
cp ~/.codex/auth.json data/codex-auth.json
docker compose --profile codex up -d --build
```

## Endpoint

Base URL: `http://localhost:18900/v1`
API key: any non-empty value, for example `proxy`
Default model: `auto`

## Test

```bash
curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```
```

Add these sections after the test example: `## Discovery`, `## Smart Groups`, `## Docker Profiles`, `## Troubleshooting`, and `## References`. `## Discovery` explains that scans are limited to Windsurf, Claude, and Codex. `## Smart Groups` lists `auto`, `auto-coding`, `auto-thinking`, `auto-tools`, `auto-text`, and `auto-max`. `## Docker Profiles` documents `codex` and `memory`. `## Troubleshooting` covers missing `WINDSURF_API_KEY`, missing `CLAUDE_CODE_OAUTH_TOKEN`, missing `data/codex-auth.json`, and empty `/v1/models`. `## References` links to the Claude Code auth and gateway docs plus the upstream GitHub repository.

- [ ] **Step 4: Rewrite `INSTRUCTIONS.md`**

Make it agent-focused:

```markdown
# Project LLM Smart Proxy Instructions

Use this project as a local Docker OpenAI-compatible proxy for Windsurf, Claude, and Codex.

## Setup

1. Copy `.env.example` to `.env`.
2. Enable the provider families needed in `.env`.
3. Authenticate on the host:
   - Windsurf: `node windsurf-auth.js --env-file .env`
   - Claude: `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN`
   - Codex: `npx @openai/codex login`, then `cp ~/.codex/auth.json data/codex-auth.json`
4. Start Docker: `docker compose --profile codex up -d --build`
5. Verify: `curl http://localhost:18900/health`

## Client Configuration

Base URL: `http://localhost:18900/v1`
API key: `proxy`
Model: `auto`
```

- [ ] **Step 5: Run branding/docs tests**

Run:

```bash
rtk npm test -- tests/branding-docs.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add README.md INSTRUCTIONS.md tests/branding-docs.test.js
rtk git commit -m "docs: rewrite setup for Project proxy"
```

## Task 8: Full Verification

**Files:**
- No new files unless failures require focused fixes.

- [ ] **Step 1: Run the complete unit test suite**

Run:

```bash
rtk npm test
```

Expected: all tests pass.

- [ ] **Step 2: Validate Docker Compose**

Run:

```bash
rtk docker compose config
```

Expected: exit 0.

- [ ] **Step 3: Build the main Docker image**

Run:

```bash
rtk docker compose build llm-proxy
```

Expected: exit 0.

- [ ] **Step 4: Build the Codex proxy image**

Run:

```bash
rtk docker compose --profile codex build codex-proxy
```

Expected: exit 0.

- [ ] **Step 5: Run syntax checks**

Run:

```bash
rtk node --check llm-proxy.js
rtk node --check llm-discovery.js
rtk node --check lib/provider-config.js
rtk node --check lib/anthropic-adapter.js
rtk node --check lib/windsurf-auth.js
rtk node --check lib/windsurf-cloud.js
rtk node --check lib/provider-adapters.js
```

Expected: each command exits 0.

- [ ] **Step 6: Run final git checks**

Run:

```bash
rtk git diff --check
rtk git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows only intentional implementation changes before final commit, or nothing after the final commit.

- [ ] **Step 7: Final commit**

If all verification passes and no uncommitted changes remain from prior task commits, no final commit is needed. If verification fixes were made, commit them:

```bash
rtk git add .
rtk git commit -m "fix: complete Project proxy verification"
```

## Manual Live Checks

Run these only with real host credentials:

```bash
rtk docker compose --profile codex up -d --build
rtk curl http://localhost:18900/health
rtk curl http://localhost:18900/v1/models
rtk curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello"}],"stream":false}'
```

Expected: health returns `status: ok`, models contain only `windsurf/`, `claude/`, `codex/` ids, and chat returns an OpenAI-compatible completion if at least one configured upstream credential is valid.
