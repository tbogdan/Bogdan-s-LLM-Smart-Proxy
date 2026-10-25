"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const path = require("node:path");

const {
  AdmissionError,
  BodyLimitError,
  BodyTimeoutError,
  createBodyAdmission,
  readBody,
} = require("../lib/http-body");

function requestStream(headers = {}) {
  const req = new PassThrough();
  req.headers = headers;
  return req;
}

test("readBody enforces byte limits at the exact boundary for UTF-8 chunks", async () => {
  const exact = requestStream();
  const exactRead = readBody(exact, { maxBytes: 4, timeoutMs: 1_000 });
  exact.end(Buffer.from("😀"));
  assert.equal(await exactRead, "😀");

  const oversized = requestStream();
  const oversizedRead = readBody(oversized, { maxBytes: 3, timeoutMs: 1_000 });
  oversized.end(Buffer.from("😀"));
  await assert.rejects(oversizedRead, (error) => (
    error instanceof BodyLimitError && error.code === "REQUEST_BODY_TOO_LARGE"
  ));
});

test("readBody handles absent and chunked lengths while rejecting oversized declarations before collection", async () => {
  const chunked = requestStream({ "transfer-encoding": "chunked" });
  const chunkedRead = readBody(chunked, { maxBytes: 5, timeoutMs: 1_000 });
  chunked.write("ab");
  chunked.end("cde");
  assert.equal(await chunkedRead, "abcde");

  const declared = requestStream({ "content-length": "6" });
  await assert.rejects(
    readBody(declared, { maxBytes: 5, timeoutMs: 1_000 }),
    (error) => error instanceof BodyLimitError,
  );
  assert.equal(declared.listenerCount("data"), 0);
});

test("readBody propagates read errors and aborts and removes its listeners", async () => {
  for (const failure of [new Error("read failed"), new Error("client closed")]) {
    const req = requestStream();
    const pending = readBody(req, { maxBytes: 100, timeoutMs: 1_000 });
    if (failure.message === "read failed") req.destroy(failure);
    else req.emit("close");
    await assert.rejects(pending, failure.message === "read failed" ? /read failed/ : /aborted/i);
    for (const event of ["data", "end", "error", "close"]) assert.equal(req.listenerCount(event), 0);
  }
});

test("readBody uses an absolute deadline even when chunks keep arriving", async () => {
  const req = requestStream();
  const interval = setInterval(() => req.write("x"), 5);
  try {
    await assert.rejects(
      readBody(req, { maxBytes: 1_000, timeoutMs: 25 }),
      (error) => error instanceof BodyTimeoutError && error.code === "REQUEST_BODY_TIMEOUT",
    );
  } finally {
    clearInterval(interval);
    req.destroy();
  }
});

test("admission rejects concurrent aggregate retained bytes and releases exactly once", () => {
  const admission = createBodyAdmission({ maxInflightRequests: 2, maxInflightBodyBytes: 5 });
  const first = admission.admit();
  const second = admission.admit();
  first.retain(3);
  second.retain(2);
  assert.throws(() => second.retain(1), (error) => (
    error instanceof AdmissionError && error.code === "REQUEST_BODY_OVERLOADED"
  ));
  assert.deepEqual(admission.snapshot(), { inflightRequests: 2, retainedBodyBytes: 5 });
  first.release();
  first.release();
  second.release();
  assert.deepEqual(admission.snapshot(), { inflightRequests: 0, retainedBodyBytes: 0 });
});

test("admission rejects excess request slots without a waiting queue", () => {
  const admission = createBodyAdmission({ maxInflightRequests: 1, maxInflightBodyBytes: 10 });
  const first = admission.admit();
  assert.throws(() => admission.admit(), (error) => error instanceof AdmissionError);
  first.release();
  assert.doesNotThrow(() => admission.admit().release());
});

test("admission retains bytes until downstream response completion and settles finish-close races once", () => {
  const admission = createBodyAdmission({ maxInflightRequests: 1, maxInflightBodyBytes: 10 });
  const lease = admission.admit();
  const response = new EventEmitter();
  lease.retain(7);
  lease.bindResponse(response);
  assert.deepEqual(admission.snapshot(), { inflightRequests: 1, retainedBodyBytes: 7 });
  response.emit("finish");
  response.emit("close");
  assert.deepEqual(admission.snapshot(), { inflightRequests: 0, retainedBodyBytes: 0 });
  for (const event of ["finish", "close", "error"]) assert.equal(response.listenerCount(event), 0);
});

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startProxy(env) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "llm-proxy.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, LLM_PROXY_PORT: String(port), LLM_PROXY_PROBE_ENABLED: "false", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      let done = false, polling, request;
      const finish = error => {
        if (done) return;
        done = true; clearTimeout(deadline); clearTimeout(polling);
        child.removeListener("exit", exited); request?.destroy();
        if (error) reject(error); else resolve();
      };
      const exited = code => finish(new Error(`proxy exited ${code}: ${output}`));
      const deadline = setTimeout(() => finish(new Error(`proxy startup timeout: ${output}`)), 5_000);
      const retry = () => { if (!done) polling = setTimeout(poll, 20); };
      const poll = () => {
        if (done) return;
        request = http.get({host:"127.0.0.1",port,path:"/health"}, res => {
          res.resume(); if (res.statusCode === 200) finish(); else retry();
        });
        request.on("error", retry);
      };
      child.once("exit", exited); poll();
    });
  } catch (error) { await stopProxy(child); throw error; }
  return { child, port, output: () => output };
}

async function stopProxy(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/embeddings", method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("real proxy returns 413 before invalid JSON reaches its route parser", { timeout: 10_000 }, async () => {
  const proxy = await startProxy({ LLM_PROXY_MAX_BODY_BYTES: "4" });
  try {
    const response = await post(proxy.port, "not-json", { "content-length": "8" });
    assert.equal(response.status, 413);
    assert.match(response.body, /REQUEST_BODY_TOO_LARGE/);
  } finally {
    await stopProxy(proxy.child);
  }
});

test("real proxy preserves the existing invalid JSON response below the body limit", { timeout: 10_000 }, async () => {
  const proxy = await startProxy({ LLM_PROXY_MAX_BODY_BYTES: "20" });
  try {
    const response = await post(proxy.port, "not-json", { "content-length": "8" });
    assert.equal(response.status, 400);
    assert.match(response.body, /Invalid JSON body/);
  } finally {
    await stopProxy(proxy.child);
  }
});

test("real proxy enforces the absolute body deadline during a trickle upload", { timeout: 10_000 }, async () => {
  const proxy = await startProxy({ LLM_PROXY_BODY_TIMEOUT_MS: "35" });
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: proxy.port, path: "/v1/embeddings", method: "POST",
        headers: { "transfer-encoding": "chunked" },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.write("{");
      const interval = setInterval(() => req.write(" "), 10);
      req.once("close", () => clearInterval(interval));
    });
    assert.equal(response.status, 408);
    assert.match(response.body, /REQUEST_BODY_TIMEOUT/);
  } finally {
    await stopProxy(proxy.child);
  }
});

test("real proxy immediately rejects concurrent retained-body overload while health stays reachable", { timeout: 10_000 }, async () => {
  const proxy = await startProxy({
    LLM_PROXY_MAX_BODY_BYTES: "20",
    LLM_PROXY_MAX_INFLIGHT_REQUESTS: "2",
    LLM_PROXY_MAX_INFLIGHT_BODY_BYTES: "5",
  });
  const slow = http.request({ host: "127.0.0.1", port: proxy.port, path: "/v1/embeddings", method: "POST", headers: { "transfer-encoding": "chunked" } });
  slow.on("error", () => {});
  slow.write("12345");
  await new Promise((resolve) => setTimeout(resolve, 40));
  try {
    const overloaded = await post(proxy.port, "x", { "content-length": "1" });
    assert.equal(overloaded.status, 503);
    assert.equal(overloaded.headers["retry-after"], "1");
    const health = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: proxy.port, path: "/health" }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      }).on("error", reject);
    });
    assert.equal(health, 200);
  } finally {
    slow.destroy();
    await stopProxy(proxy.child);
  }
});
