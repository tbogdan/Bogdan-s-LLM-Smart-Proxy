"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const copilotToken = require("../lib/copilot-token");

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
      { tokenUrl: `${baseUrl}/copilot_internal/v2/token` },
    );

    assert.equal(headers.Authorization, "Bearer capi-runtime-token");
    assert.equal(headers["X-Custom"], "keep");
    assert.equal(headers["Copilot-Integration-Id"], "vscode-chat");
    assert.match(headers["Editor-Version"], /^vscode\//);
    assert.match(headers["Editor-Plugin-Version"], /^copilot-chat\//);
    assert.equal(headers["X-GitHub-Api-Version"], "2026-01-09");
    assert.equal(tokenAuth, "token ghu_source");
    assert.equal(tokenRequests, 1);
  });
});

test("buildCopilotRuntimeHeaders reuses cached runtime token until refresh", async () => {
  let tokenRequests = 0;

  await withServer((req, res) => {
    if (req.url === "/copilot_internal/v2/token") {
      tokenRequests += 1;
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
    const options = { tokenUrl: `${baseUrl}/copilot_internal/v2/token` };

    const first = await copilotToken.buildCopilotRuntimeHeaders(provider, {}, options);
    const second = await copilotToken.buildCopilotRuntimeHeaders(provider, {}, options);

    assert.equal(first.Authorization, "Bearer capi-runtime-token-1");
    assert.equal(second.Authorization, "Bearer capi-runtime-token-1");
    assert.equal(tokenRequests, 1);
  });
});
