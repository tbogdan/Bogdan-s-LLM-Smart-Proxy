"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const auth = require("../lib/windsurf-auth");

const execFileAsync = promisify(execFile);

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("buildLoginUrl uses real Windsurf signin token params", () => {
  const output = auth.buildLoginUrl({
    redirectUri: "http://127.0.0.1:1234/callback",
    state: "state-123",
    loginHint: "user@example.com",
  });

  const url = new URL(output);
  assert.equal(url.origin + url.pathname, auth.WINDSURF_LOGIN_URL);
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("client_id"), auth.WINDSURF_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1234/callback");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("prompt"), "login");
  assert.equal(url.searchParams.get("redirect_parameters_type"), "fragment");
  assert.equal(url.searchParams.get("workflow"), "");
  assert.equal(url.searchParams.get("login_hint"), "user@example.com");
});

test("normalizeOneTimeAuthToken extracts and prefixes OTT tokens", () => {
  assert.equal(auth.normalizeOneTimeAuthToken("abc123"), "ott$abc123");
  assert.equal(auth.normalizeOneTimeAuthToken("/ott$abc123"), "ott$abc123");
  assert.equal(auth.normalizeOneTimeAuthToken("ott$abc123"), "ott$abc123");
  assert.equal(
    auth.normalizeOneTimeAuthToken("http://127.0.0.1/callback#access_token=ott%24from-fragment&state=s"),
    "ott$from-fragment",
  );
  assert.equal(auth.normalizeOneTimeAuthToken("copy this /ott$embedded-token now"), "ott$embedded-token");
});

test("parseCallbackUrl returns forwarded one-time token and validates state when present", () => {
  assert.deepEqual(
    auth.parseCallbackUrl("http://127.0.0.1/callback-token?access_token=ott%24token&state=state-123", "state-123"),
    { token: "ott$token" },
  );
  assert.deepEqual(
    auth.parseCallbackUrl("http://127.0.0.1/callback#access_token=ott%24token&state=state-123", "state-123"),
    { token: "ott$token" },
  );
  assert.deepEqual(auth.parseCallbackUrl("http://127.0.0.1/callback?code=raw-code"), { token: "ott$raw-code" });
  assert.throws(
    () => auth.parseCallbackUrl("http://127.0.0.1/callback-token?access_token=ott%24token&state=wrong", "state-123"),
    /state/i,
  );
  assert.throws(
    () => auth.parseCallbackUrl("http://127.0.0.1/callback#access_token=ott%24token&state=wrong", "state-123"),
    /state/i,
  );
});

test("loopback callback page forwards original fragment params without overwriting state", async () => {
  const loopback = auth.startLoopbackAuth({ state: "server-state", timeoutMs: 1000 });
  const ready = await loopback.ready;

  try {
    const html = await new Promise((resolve, reject) => {
      http
        .get(ready.redirectUri, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        })
        .on("error", reject);
    });

    assert.match(html, /location\.hash\.slice\(1\)/);
    assert.doesNotMatch(html, /params\.set\(['"]state['"]/);
  } finally {
    loopback.close();
  }
});

test("protobuf helpers encode strings and parse string fields", () => {
  const body = Buffer.concat([auth.encodeString(1, "api-key"), auth.encodeString(2, "Windsurf User"), auth.encodeString(3, "u@example.com")]);
  const fields = auth.parseFields(body);

  assert.equal(Buffer.from(auth.encodeVarint(300)).toString("hex"), "ac02");
  assert.deepEqual(fields.get(1), ["api-key"]);
  assert.deepEqual(fields.get(2), ["Windsurf User"]);
  assert.deepEqual(fields.get(3), ["u@example.com"]);
});

test("registerWindsurfOneTimeToken posts proto token and parses API key fields", async () => {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      assert.equal(request.method, "POST");
      assert.equal(request.headers["content-type"], "application/proto");
      assert.equal(request.headers["user-agent"], "Project-llm-smart-proxy");
      assert.deepEqual(auth.parseFields(body).get(1), ["ott$one-time"]);
      response.writeHead(200, { "content-type": "application/proto" });
      response.end(Buffer.concat([auth.encodeString(1, "api-key-123"), auth.encodeString(2, "User"), auth.encodeString(3, "u@example.com")]));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const output = await auth.registerWindsurfOneTimeToken("one-time", {
      registerUrl: `http://127.0.0.1:${port}/register`,
    });

    assert.deepEqual(output, { apiKey: "api-key-123", name: "User", email: "u@example.com" });
  } finally {
    await closeServer(server);
  }
});

test("readHostToken returns host token by documented precedence", () => {
  assert.equal(
    auth.readHostToken({
      WINDSURF_API_KEY: "api-key",
      WINDSURF_ACCESS_TOKEN: "access-token",
      WINDSURF_TOKEN: "token",
    }),
    "api-key",
  );
  assert.equal(
    auth.readHostToken({
      WINDSURF_ACCESS_TOKEN: "access-token",
      WINDSURF_TOKEN: "token",
    }),
    "access-token",
  );
  assert.equal(auth.readHostToken({ WINDSURF_TOKEN: "token" }), "token");
  assert.equal(auth.readHostToken({}), "");
});

test("root windsurf-auth helper registers manual OTT and upserts WINDSURF_API_KEY", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "windsurf-auth-"));
  const envFile = path.join(dir, ".env.test");
  await fs.writeFile(envFile, "EXISTING=value\nWINDSURF_API_KEY=old-token\nAFTER=value\n");

  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/proto" });
      response.end(auth.encodeString(1, "registered-api-key"));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const { stdout } = await execFileAsync(
      process.execPath,
      ["windsurf-auth.js", "--token", "manual-ott", "--env-file", envFile, "--register-url", `http://127.0.0.1:${port}/register`],
      { cwd: path.resolve(__dirname, "..") },
    );

    assert.match(stdout, /WINDSURF_API_KEY/);
    assert.equal(await fs.readFile(envFile, "utf8"), "EXISTING=value\nWINDSURF_API_KEY=registered-api-key\nAFTER=value\n");
  } finally {
    await closeServer(server);
  }
});
