"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const copilotToken = require("../lib/copilot-token");

const COPILOT_CLIENT_TEST_OPTIONS = {
  extensionVersion: "0.48.1",
  vscodeVersion: "1.121.0",
  sessionId: "session-123",
  machineId: "machine-123",
  deviceId: "device-123",
  interactionId: "interaction-123",
};

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("buildCopilotRuntimeHeaders exchanges a GitHub token for a Copilot bearer token", async () => {
  let tokenRequests = 0;
  let tokenAuth = "";

  await withServer((req, res) => {
    if (req.url === "/copilot_internal/v2/token") {
      tokenRequests += 1;
      assert.equal(req.method, "GET");
      assert.equal(req.headers["user-agent"], "GitHubCopilotChat/0.48.1");
      assert.equal(req.headers["x-vscode-user-agent-library-version"], "node-http");
      assert.equal(req.headers["copilot-integration-id"], undefined);
      assert.equal(req.headers["vscode-sessionid"], undefined);
      tokenAuth = req.headers.authorization || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        token: "capi-runtime-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1800,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  }, async (baseUrl) => {
    copilotToken.clearCopilotTokenCache();
    const headers = await copilotToken.buildCopilotRuntimeHeaders(
      {
        family: "copilot",
        key: "ghu_source",
        headers: { Authorization: "Bearer stale-github-token", "X-Custom": "keep" },
      },
      { "Content-Type": "application/json" },
      {
        ...COPILOT_CLIENT_TEST_OPTIONS,
        tokenUrl: `${baseUrl}/copilot_internal/v2/token`,
        requestId: "request-123",
      },
    );

    assert.equal(headers.Authorization, "Bearer capi-runtime-token");
    assert.equal(headers["X-Custom"], "keep");
    assert.equal(headers["User-Agent"], "GitHubCopilotChat/0.48.1");
    assert.equal(headers["X-VSCode-User-Agent-Library-Version"], "node-http");
    assert.equal(headers["Copilot-Integration-Id"], "vscode-chat");
    assert.equal(headers["Editor-Version"], "vscode/1.121.0");
    assert.equal(headers["Editor-Plugin-Version"], "copilot-chat/0.48.1");
    assert.equal(headers["X-GitHub-Api-Version"], "2026-01-09");
    assert.equal(headers["VScode-SessionId"], "session-123");
    assert.equal(headers["VScode-MachineId"], "machine-123");
    assert.equal(headers["Editor-Device-Id"], "device-123");
    assert.equal(headers["X-Request-Id"], "request-123");
    assert.equal(headers["OpenAI-Intent"], "conversation-panel");
    assert.equal(headers["X-Interaction-Type"], "conversation-panel");
    assert.equal(headers["X-Agent-Task-Id"], "request-123");
    assert.equal(headers["X-Interaction-Id"], "interaction-123");
    assert.equal(headers["X-Initiator"], "user");
    assert.equal(tokenAuth, "token ghu_source");
    assert.equal(tokenRequests, 1);
  });
});

test("buildCopilotRuntimeHeaders reuses cached runtime token until refresh", async () => {
  let tokenRequests = 0;

  await withServer((req, res) => {
    if (req.url === "/copilot_internal/v2/token") {
      tokenRequests += 1;
      assert.equal(req.method, "GET");
      assert.equal(req.headers["user-agent"], "GitHubCopilotChat/0.48.1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        token: `capi-runtime-token-${tokenRequests}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1800,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  }, async (baseUrl) => {
    copilotToken.clearCopilotTokenCache();
    const provider = { family: "copilot", key: "ghu_source" };
    const options = {
      ...COPILOT_CLIENT_TEST_OPTIONS,
      tokenUrl: `${baseUrl}/copilot_internal/v2/token`,
    };

    const first = await copilotToken.buildCopilotRuntimeHeaders(provider, {}, options);
    const second = await copilotToken.buildCopilotRuntimeHeaders(provider, {}, options);

    assert.equal(first.Authorization, "Bearer capi-runtime-token-1");
    assert.equal(second.Authorization, "Bearer capi-runtime-token-1");
    assert.equal(tokenRequests, 1);
  });
});

test("runtimeClientHeaders can emit Copilot dev Request-Hmac when a secret is configured", () => {
  const headers = copilotToken.runtimeClientHeaders({
    ...COPILOT_CLIENT_TEST_OPTIONS,
    integrationId: "vscode-chat-dev",
    hmacSecret: "secret",
    hmacTimestamp: 12345,
    requestId: "request-hmac",
  });

  assert.equal(headers["Copilot-Integration-Id"], "vscode-chat-dev");
  assert.equal(
    headers["Request-Hmac"],
    "12345.f88c7ebe4740db59c873cecf5e1f18e3726a1ad64068a13d764b79028430ab0e",
  );
});
