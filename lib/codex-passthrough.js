"use strict";
const http = require("node:http");
const https = require("node:https");
const { BodyLimitError, BodyTimeoutError, positiveInteger, timeoutInteger, DEFAULT_MAX_BODY_BYTES, DEFAULT_BODY_TIMEOUT_MS } = require("./http-body");
const performanceMetrics = require("./performance-metrics");
const DEFAULT_CODEX_BACKEND_TIMEOUT_MS = 300_000;

// Own both directions for the entire operation, including downstream flushing.
// No redirect handling: credentials stay within the configured upstream scope.
function proxyCodexBackend(req, res, fullPath, options) {
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BODY_BYTES);
  const timeoutMs = timeoutInteger(options.timeoutMs, DEFAULT_CODEX_BACKEND_TIMEOUT_MS);
  const bodyTimeoutMs = timeoutInteger(options.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS);
  let upstream, response, lease, timer, bodyTimer, metricAttempt;
  let stopped = false, completed = false, bytes = 0;
  const finish = (outcome) => {
    if (completed) return;
    completed = true;
    if (outcome === "aborted") metricAttempt?.cancel();
    stop();
    lease?.release();
    options.onComplete?.({ outcome, bytes });
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer); clearTimeout(bodyTimer);
    req.pause();
    req.removeListener("data", onData); req.removeListener("end", onEnd);
    upstream?.removeListener("drain", resumeUpload);
    response?.unpipe(res);
    upstream?.destroy(); response?.destroy();
  };
  const fail = (error) => {
    if (stopped) return;
    if (error?.code === "UPSTREAM_CLIENT_ABORTED") metricAttempt?.cancel(); else metricAttempt?.error();
    stop();
    options.onError?.(error);
    if (res.destroyed) { finish("aborted"); return; }
    if (res.headersSent) { finish("error"); res.destroy(); return; }
    res.writeHead(error.statusCode || 502, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: "codex backend passthrough failed", detail: error.message }));
  };
  const resumeUpload = () => { if (!stopped) req.resume(); };
  const onData = chunk => {
    if (stopped) return;
    if (bytes + chunk.length > maxBytes) { fail(new BodyLimitError()); return; }
    try { lease?.retain(chunk.length); } catch (error) { fail(error); return; }
    bytes += chunk.length;
    if (!upstream.write(chunk, error => { lease?.unretain(chunk.length); if (error) fail(error); })) req.pause();
  };
  const onEnd = () => { clearTimeout(bodyTimer); if (!stopped) upstream.end(); };
  req.on("error", fail);
  req.once("aborted", () => fail(Object.assign(new Error("Request upload aborted"), { code: "UPSTREAM_CLIENT_ABORTED" })));
  req.once("close", () => { if (!req.complete) fail(Object.assign(new Error("Request upload closed prematurely"), { code: "UPSTREAM_CLIENT_ABORTED" })); });
  res.on("error", () => finish("aborted"));
  res.once("finish", () => finish(stopped ? "error" : "success"));
  res.once("close", () => finish(res.writableFinished ? "success" : "aborted"));
  try {
    lease = options.admission?.admit();
    lease?.bindResponse(res);
    const declared = req.headers["content-length"];
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new BodyLimitError();
    const target = new URL(options.upstream.replace(/\/+$/, "") + fullPath);
    const headers = { ...req.headers, host: target.host };
    delete headers["content-length"]; delete headers["accept-encoding"];
    metricAttempt = performanceMetrics.recordUpstreamDispatch({ category: "ancillary" });
    upstream = (target.protocol === "http:" ? http : https).request(target, { method: req.method, headers }, up => {
      response = up;
      up.on("error", fail);
      if (stopped) { up.destroy(); return; }
      up.once("close", () => { if (!up.complete) fail(new Error("Upstream response closed prematurely")); });
      up.once("end", () => metricAttempt.complete());
      const responseHeaders = { ...up.headers };
      delete responseHeaders["transfer-encoding"];
      res.writeHead(up.statusCode || 502, responseHeaders);
      up.pipe(res);
    });
    upstream.on("error", fail);
    upstream.on("drain", resumeUpload);
    req.on("data", onData); req.once("end", onEnd);
    timer = setTimeout(() => fail(new Error("Codex backend operation deadline exceeded")), timeoutMs);
    bodyTimer = setTimeout(() => fail(new BodyTimeoutError()), bodyTimeoutMs);
    timer.unref(); bodyTimer.unref();
  } catch (error) { fail(error); }
}
module.exports = { proxyCodexBackend, DEFAULT_CODEX_BACKEND_TIMEOUT_MS };
