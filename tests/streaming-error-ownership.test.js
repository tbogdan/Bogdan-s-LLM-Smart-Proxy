"use strict";
process.env.LLM_PROXY_MAX_RETAINED_UPSTREAM_BYTES = "8192";
process.env.LLM_PROXY_MAX_STREAM_BUFFER_BYTES = "32768";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const http2 = require("node:http2");
const { EventEmitter, once } = require("node:events");
const transport = require("../lib/http-transport");
const metrics = require("../lib/performance-metrics");
const cloud = require("../lib/windsurf-cloud");

async function fixture(t, protocol, payload = "x".repeat(1024), status = 503) {
  const server = protocol === "HTTP2" ? http2.createServer() : http.createServer((req, res) => {
    res.writeHead(status); res.end(payload);
  });
  const sessions = new Set();
  if (protocol === "HTTP2") {
    server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
    server.on("stream", stream => { stream.on("error", () => {}); stream.respond({ ":status": status }); stream.end(payload); });
  }
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { for (const session of sessions) session.destroy(); server.closeAllConnections?.(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = protocol === "HTTP2"
    ? () => cloud.streamWindsurfCloud({ origin: url, key: "fixture", model: "fixture" }, { messages: [{ role: "user", content: "hello" }] }, {})
    : () => new Promise((resolve, reject) => transport.streamRequest(url, {}, null, () => assert.fail("error data delivered"), resolve, reject));
  return { call, url };
}
const rejected = promise => promise.then(() => assert.fail("expected rejection"), error => error);
test.after(() => transport.close());

for (const protocol of ["HTTP", "HTTP2"]) {
  for (const releaseBy of ["discard", "response finish", "standalone"]) {
    test(`${protocol} streaming error remains charged through delayed consumer until ${releaseBy}`, async t => {
      const { call } = await fixture(t, protocol);
      const client = new EventEmitter(); t.after(() => client.emit("close"));
      metrics.reset();
      const run = fn => releaseBy === "standalone" ? fn() : transport.withOwnership(fn, client);
      const held = await rejected(run(() => releaseBy === "standalone" ? call() : transport.withAttempt(call)));
      assert.equal(held.status, 503, held.message);
      assert.equal(transport.stats().retainedBytes, 8192);
      assert.equal(held.body.toString(), "x".repeat(1024));
      t.after(() => held.release?.());
      await new Promise(resolve => setTimeout(resolve, 10));
      const contender = await rejected(transport.withAttempt(call));
      assert.equal(contender.code, "UPSTREAM_RETAINED_OVERLOADED");
      assert.equal(transport.stats().retainedBytes, 8192);
      if (releaseBy === "response finish") client.emit("finish"); else held.release();
      held.release(); client.emit("close");
      assert.equal(transport.stats().retainedBytes, 0);
      assert.equal(transport.stats().leases, 0);
      const next = await rejected(call());
      assert.equal(transport.stats().retainedBytes, 8192);
      held.release(); // A repeated old release must not debit the new payload.
      assert.equal(transport.stats().retainedBytes, 8192);
      next.release(); next.release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(transport.stats().retainedBytes, 0);
      assert.equal(transport.stats().leases, 0);
      assert.equal(transport.stats().nativeActive, 0);
      assert.equal(metrics.snapshot().upstream.dispatches, 3);
      assert.equal(metrics.snapshot().upstream.errors, 3);
      assert.equal(metrics.snapshot().upstream.cancels, 0);
    });
  }
  test(`${protocol} empty streaming error releases immediately`, async t => {
    const { call } = await fixture(t, protocol, "");
    const client = new EventEmitter(); t.after(() => client.emit("close"));
    const error = await rejected(transport.withOwnership(() => transport.withAttempt(call), client));
    assert.equal(error.status, 503);
    assert.equal(transport.stats().retainedBytes, 0);
    assert.equal(transport.stats().leases, 0);
    error.release?.();
  });
}

test("native OpenAI streaming error preserves raw body for tool-choice recovery", async t => {
  const raw = JSON.stringify({ error: { param: "tool_choice", message: "unsupported tool_choice" } });
  const { url } = await fixture(t, "HTTP", raw, 400);
  const input = { messages: [], tools: [{ type: "function", function: { name: "edit" } }], tool_choice: "required" };
  const error = await rejected(transport.withAttempt(() => require("../lib/provider-adapters").routeNativeStream({ url, protocol: "openai", model: "fixture" }, input, {})));
  t.after(() => error.release?.());
  assert.equal(error.body, raw);
  assert.equal(require("../lib/tool-choice-recovery").shouldRecover(error, input), true);
  error.release();
  assert.equal(transport.stats().retainedBytes, 0);
});

for (const scoped of [false, true]) {
  test(`Windsurf successful stream releases immediately (${scoped ? "response scope" : "standalone"})`, async t => {
    const payload = Buffer.concat([
      cloud.connectEnvelope(cloud.encodeString(3, "hello")),
      cloud.connectEnvelope(Buffer.alloc(0), 2),
    ]);
    const { call } = await fixture(t, "HTTP2", payload, 200);
    const client = new EventEmitter(); t.after(() => client.emit("close"));
    const result = await (scoped ? transport.withOwnership(() => transport.withAttempt(call), client) : call());
    assert.equal(result.status, 200);
    assert.equal(transport.stats().retainedBytes, 0);
    assert.equal(transport.stats().leases, 0);
    assert.equal(transport.stats().nativeActive, 0);
    result.release?.();
  });
}


test("HTTP streaming rejection keeps sensitive payload private while recovery works", async t => {
  const secret = "UPSTREAM_PRIVATE_TOKEN_987";
  const raw = JSON.stringify({ error: { param: "tool_choice", message: "unsupported tool_choice " + secret } });
  const { call } = await fixture(t, "HTTP", raw, 400);
  const error = await rejected(call());
  t.after(() => error.release?.());
  assert.equal(error.message, "Upstream HTTP 400");
  assert.equal(error.body, raw);
  assert.equal(require("../lib/tool-choice-recovery").shouldRecover(error, { tools: [{}], tool_choice: "required" }), true);
  for (const exposed of [String(error), error.stack, JSON.stringify(error), JSON.stringify({ error: { message: error.message } })]) {
    assert.ok(!exposed.includes(secret), exposed);
  }
  assert.equal(Object.prototype.propertyIsEnumerable.call(error, "body"), false);
  error.release();
  assert.equal(transport.stats().retainedBytes, 0);
});
