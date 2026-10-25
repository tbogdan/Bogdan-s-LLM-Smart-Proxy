"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createBodyAdmission } = require("../lib/http-body");
const { proxyCodexBackend: proxy } = require("../lib/codex-passthrough");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, handler, options = {}, observe = () => {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const admission = options.admission || createBodyAdmission();
  const outcomes = [];
  const server = http.createServer((req, res) => { observe(req, res); proxy(req, res, req.url, { upstream: `http://127.0.0.1:${upstream.address().port}`, admission, onComplete: result => outcomes.push(result), ...options, ...(options.classifyMetrics ? {onError:error=>error.code === "UPSTREAM_CLIENT_ABORTED" ? res._performanceObservation.abort() : res._performanceObservation.fail()} : {}) }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); upstream.closeAllConnections(); server.close(); upstream.close(); });
  return { port: server.address().port, admission, outcomes };
}
function request(port, body = "", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: "127.0.0.1", path: "/backend-api/test?q=1", method: "POST", headers }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on("error", reject);
    }); req.on("error", reject); req.end(body);
  });
}
test("normal upload close preserves delayed response and exact bytes/headers", async t => {
  const bytes = Buffer.from([0, 255, 1, 2]);
  const f = await fixture(t, (req, res) => {
    assert.equal(req.method, "POST"); assert.equal(req.url, "/backend-api/test?q=1"); assert.equal(req.headers.authorization, "Bearer fixture");
    const uploaded = []; req.on("data", chunk => uploaded.push(chunk)); req.on("end", () => { assert.deepEqual(Buffer.concat(uploaded), bytes); setTimeout(() => { res.writeHead(207, { "x-fixture": "ok" }); res.end(bytes); }, 20); });
  });
  const result = await request(f.port, bytes, { authorization: "Bearer fixture" });
  assert.equal(result.status, 207); assert.deepEqual(result.body, bytes); assert.equal(result.headers["x-fixture"], "ok");
  await delay(10); assert.equal(f.outcomes.length, 1); assert.deepEqual(f.admission.snapshot(), { inflightRequests: 0, retainedBodyBytes: 0 });
});
test("declared and chunked byte overflow return 413", async t => {
  const f = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, { maxBytes: 4 });
  assert.equal((await request(f.port, "12345", { "content-length": "5" })).status, 413);
  assert.equal((await request(f.port, "12345", { "transfer-encoding": "chunked" })).status, 413);
  assert.equal((await request(f.port, "1234")).status, 200);
});
test("shared admission rejects competing request and releases after response", async t => {
  const admission = createBodyAdmission({ maxInflightRequests: 1 }); const held = admission.admit();
  const f = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end()); }, { admission });
  assert.equal((await request(f.port)).status, 503); held.release();
  assert.equal((await request(f.port)).status, 200);
});
test("absolute deadline interrupts a continuously active response", async t => {
  let closed = false;
  const f = await fixture(t, (req, res) => { req.resume(); const timer = setInterval(() => res.write("x"), 5); res.on("close", () => { clearInterval(timer); closed = true; }); }, { timeoutMs: 50 });
  const result = request(f.port); await assert.rejects(Promise.race([result, delay(500).then(() => { throw new Error("test deadline"); })]), error => error.message !== "test deadline");
  await delay(20); assert.equal(closed, true); assert.equal(f.outcomes.length, 1);
});
test("streaming lease unretain is safe after cancellation and does not affect another lease", () => {
  const admission = createBodyAdmission(); const a = admission.admit(); const b = admission.admit();
  a.retain(10); b.retain(20); a.unretain(4); assert.equal(a.retainedBytes, 6); a.release(); a.unretain(6);
  assert.equal(admission.snapshot().retainedBodyBytes, 20); b.release();
});

test("upload backpressure pauses incoming stream and resumes after drain", async t => {
  let pauses = 0, resumes = 0, incoming;
  const f = await fixture(t, (req, res) => { req.pause(); setTimeout(() => { req.resume(); req.on("end", () => res.end("ok")); }, 40); }, {}, req => {
    incoming = req; const pause = req.pause, resume = req.resume;
    req.pause = function () { pauses++; return pause.call(this); };
    req.resume = function () { resumes++; return resume.call(this); };
  });
  assert.equal((await request(f.port, Buffer.alloc(8 * 1024 * 1024))).status, 200);
  assert.ok(pauses > 0); assert.ok(resumes > 1); assert.equal(incoming.readableEnded, true);
});
test("slow download consumer bounds response queue and resumes upstream", async t => {
  let peak = 0, falseWrites = 0;
  const bytes = 12 * 1024 * 1024;
  const f = await fixture(t, (req, res) => { req.resume(); let sent = 0; function send() { while (sent < bytes) { sent += 65536; if (!res.write(Buffer.alloc(65536))) { res.once("drain", send); return; } } res.end(); } send(); }, {}, (req, res) => {
    const write = res.write; res.write = function (...args) { const result = write.apply(this, args); peak = Math.max(peak, this.writableLength); if (!result) falseWrites++; return result; };
  });
  const received = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: f.port }, res => { let count = 0; res.pause(); setTimeout(() => { res.on("data", c => count += c.length); res.resume(); }, 70); res.on("end", () => resolve(count)); res.on("error", reject); }).on("error", reject);
  });
  assert.equal(received, bytes); assert.ok(falseWrites > 0); assert.ok(peak < 256 * 1024, `queue ${peak}`);
});
test("premature downstream close aborts upstream once", async t => {
  let closed = false;
  const f = await fixture(t, (req, res) => { req.resume(); const timer = setInterval(() => res.write("chunk"), 5); res.on("close", () => { clearInterval(timer); closed = true; }); });
  await new Promise(resolve => { http.get({ host: "127.0.0.1", port: f.port }, res => { res.once("data", () => { res.destroy(); resolve(); }); }); });
  await delay(50); assert.equal(closed, true); assert.equal(f.outcomes.length, 1); assert.equal(f.admission.snapshot().inflightRequests, 0);
});

test("upstream failure before headers maps to 502 and premature EOF destroys sent response", async t => {
  const before = await fixture(t, req => req.socket.destroy());
  assert.equal((await request(before.port)).status, 502);
  await delay(10); assert.equal(before.outcomes[0]?.outcome, "error");
  const after = await fixture(t, (req, res) => { req.resume(); res.writeHead(200, { "content-length": "100" }); res.write("partial"); setTimeout(() => res.destroy(), 10); });
  await assert.rejects(request(after.port)); await delay(10);
  assert.equal(after.outcomes.length, 1); assert.equal(after.outcomes[0].outcome, "error"); assert.equal(after.admission.snapshot().inflightRequests, 0);
});
test("body deadline returns 408 and shared queued byte budget returns 503", async t => {
  const slow = await fixture(t, req => req.resume(), { bodyTimeoutMs: 25, timeoutMs: 500 });
  const status = await new Promise((resolve, reject) => { const req = http.request({ host: "127.0.0.1", port: slow.port, method: "POST" }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); }); req.on("error", reject); req.write("x"); });
  assert.equal(status, 408);
  const admission = createBodyAdmission({ maxInflightBodyBytes: 4 }); const held = admission.admit(); held.retain(4);
  const full = await fixture(t, req => req.resume(), { admission });
  assert.equal((await request(full.port, "x")).status, 503); assert.equal(admission.snapshot().retainedBodyBytes, 4); held.release();
});
test("incoming upload abort cancels upstream and settles once", async t => {
  let closed = false, admitted;
  const arrived = new Promise(resolve => admitted = resolve);
  const f = await fixture(t, req => { req.on("error", () => {}); req.on("close", () => { closed = true; }); req.resume(); admitted(); });
  const req = http.request({ host: "127.0.0.1", port: f.port, method: "POST" }); req.on("error", () => {}); req.write(Buffer.alloc(65536));
  await arrived; req.destroy(); await delay(40);
  assert.equal(closed, true); assert.equal(f.outcomes.length, 1); assert.deepEqual(f.admission.snapshot(), { inflightRequests: 0, retainedBodyBytes: 0 });
});
test("aborted upload is a client abort while backend failure is a client error", async t => {
  const metrics = require("../lib/performance-metrics"); metrics.reset();
  const observe = (req,res) => { res._performanceObservation = metrics.observeClient(req,res); };
  let arrived; const seen = new Promise(resolve => arrived=resolve);
  const aborted = await fixture(t, req => { req.resume(); arrived(); }, { classifyMetrics:true }, observe);
  const upload = http.request({host:"127.0.0.1",port:aborted.port,method:"POST"});upload.on("error",()=>{});upload.write("x");await seen;upload.destroy();await delay(30);
  assert.equal(metrics.snapshot().client.aborted,1);assert.equal(metrics.snapshot().client.errors,0);
  metrics.reset();
  const failed = await fixture(t, req => req.socket.destroy(), { classifyMetrics:true }, observe);
  await request(failed.port);await delay(10);
  assert.equal(metrics.snapshot().client.errors,1);
  metrics.reset();
  const deadline = await fixture(t, (req,res) => { req.resume(); res.writeHead(200); res.write("partial"); }, { classifyMetrics:true, timeoutMs:20 }, observe);
  await assert.rejects(request(deadline.port));await delay(10);
  assert.equal(metrics.snapshot().client.errors,1);assert.equal(metrics.snapshot().client.aborted,0);
});
test("invalid operation deadline uses safe default", async t => {
  const f = await fixture(t, (req, res) => { req.resume(); setTimeout(() => res.end("ok"), 20); }, { timeoutMs: -1 });
  assert.equal((await request(f.port)).status, 200);
});
