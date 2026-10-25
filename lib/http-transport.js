"use strict";
const { timeoutInteger } = require("./http-body");

const http = require("node:http");
const https = require("node:https");
const { AsyncLocalStorage } = require("node:async_hooks");
const { EventEmitter } = require("node:events");
const { positiveInteger } = require("./http-body");
const performanceMetrics = require("./performance-metrics");
const ownership = new AsyncLocalStorage();
const MiB = 1024 * 1024;
// Upstream payload is bounded by maxErrorBytes and private to recovery/classification.
// Never copy it into messages, enumerable metadata, or public error details.
function upstreamHttpError(status, body, headers = {}) {
  const error = Object.assign(new Error(`Upstream HTTP ${status}`), { status, statusCode: status, privateUpstreamError: true });
  Object.defineProperties(error, { body: { value: body, configurable: true }, headers: { value: headers, configurable: true } });
  return error;
}
function safeErrorText(error) {
  if (!error?.privateUpstreamError) return null;
  const body = String(error.body || "");
  const categories = [];
  if (/context.length|context window|input exceeds|too.large|maximum.*token|prompt.*too long|too long for (?:this )?model|token.*exceed|max.size.*token/i.test(body)) categories.push("context_length_exceeded");
  if (/rate.limit|too many requests/i.test(body)) categories.push("rate limit");
  if (/usage limit|quota|reached the limit|MONTHLY|out of.*messages/i.test(body)) categories.push("quota usage limit");
  if (/timeout|idle/i.test(body)) categories.push("timeout");
  if (/socket hang up/i.test(body)) categories.push("socket hang up");
  return [error.message, ...categories].join("; ");
}
function boundaryError(code, statusCode = 502) {
  const error = new Error(code === "UPSTREAM_RESPONSE_TOO_LARGE" ? "Upstream response exceeds byte limit" : code === "UPSTREAM_TIMEOUT" ? "Upstream timeout: absolute deadline exceeded" : "Upstream capacity exhausted");
  Object.assign(error, { code, statusCode, status: statusCode, localOverload: statusCode === 503 });
  return error;
}
function isLocalFailure(error) {
  return !!(error?.localOverload || error?.error?.localOverload || error?.code === "UPSTREAM_CLIENT_ABORTED" || error?.error?.code === "UPSTREAM_CLIENT_ABORTED");
}
function createRetainedBudget(maxBytes = 128 * MiB) {
  maxBytes = positiveInteger(maxBytes, 128 * MiB);
  let retainedBytes = 0, leases = 0, rejected = 0;
  return {
    lease(limit = 32 * MiB) {
      limit = positiveInteger(limit, 32 * MiB);
      let bytes = 0, released = false; leases++;
      return {
        retain(n) {
          if (released) throw new Error("Upstream lease already released");
          if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("Invalid retained bytes");
          if (bytes + n > limit) throw boundaryError("UPSTREAM_RESPONSE_TOO_LARGE");
          if (retainedBytes + n > maxBytes) { rejected++; throw boundaryError("UPSTREAM_RETAINED_OVERLOADED", 503); }
          bytes += n; retainedBytes += n;
        },
        unretain(n) {
          if (released) return;
          if (!Number.isSafeInteger(n) || n < 0 || n > bytes) throw new RangeError("Invalid retained byte release");
          bytes -= n; retainedBytes -= n;
        },
        release() { if (released) return; released = true; retainedBytes -= bytes; bytes = 0; leases--; },
        get bytes() { return bytes; },
      };
    },
    snapshot() { return { retainedBytes, leases, retainedRejected: rejected, maxRetainedBytes: maxBytes }; },
  };
}
function ownedLease(budget, limit) {
  const lease = budget.lease(limit), scope = ownership.getStore();
  if (scope) {
    if (scope.closed || scope.controller.signal.aborted) { lease.release(); throw abortError(); }
    scope.leases.add(lease);
  }
  return lease;
}
function hasRetainedPayload(value) {
  return !!value && (typeof value.body === "string" || Buffer.isBuffer(value.body) ||
    typeof value.continuationText === "string" || typeof value.error?.body === "string" || Buffer.isBuffer(value.error?.body));
}
function abortError() { return Object.assign(new Error("Downstream request closed"), {code:"UPSTREAM_CLIENT_ABORTED", statusCode:499, status:499}); }
function currentSignal(signal) {
  const parent = ownership.getStore()?.controller.signal;
  return parent && signal ? AbortSignal.any([parent, signal]) : parent || signal;
}
// A response-bound scope survives the handler returning. Background work uses a
// promise-bound scope. Explicit standalone transport callers own response.release().
function withOwnership(fn, response, retainResult = false) {
  if (response && typeof response.once !== "function") response = undefined;
  if (ownership.getStore()) return fn();
  const scope = { leases: new Set(), controller: new AbortController(), closed: false, streamState:{bytes:0}, attemptCount:0, networkAttemptCount:0 };
  const done = () => {
    if (scope.closed) return;
    scope.closed = true;
    response?.removeListener?.("finish", done); response?.removeListener?.("close", done); response?.removeListener?.("error", done);
    scope.controller.abort(abortError());
    for (const lease of scope.leases) lease.release();
    scope.leases.clear();
  };
  if (response) {
    for (const event of ["finish", "close", "error"]) response.once?.(event, done);
    if (response.destroyed || response.writableFinished) done();
  }
  return ownership.run(scope, async () => {
    let handedOff = false;
    try {
      const result = await fn();
      if (!response && retainResult && result && typeof result === "object") {
        Object.defineProperty(result, "release", {value:done, configurable:true});
        handedOff = true;
      }
      return result;
    } catch (error) {
      if (!response && retainResult && hasRetainedPayload(error)) {
        Object.defineProperty(error,"release",{value:done,configurable:true});
        handedOff=true;
      }
      throw error;
    } finally { if (!response && !handedOff) done(); }
  });
}
// Helper work has its own abort/retention lifetime. Timing it out must never
// cancel the enclosing client request, and late fallback dispatches see abort.
async function withDeadline(fn, timeoutMs) {
  const parent = ownership.getStore();
  const scope = { ...parent, leases: new Set(), controller: new AbortController(), closed: false,
    streamState: {bytes: 0}, native: false, attemptCount: 0, networkAttemptCount: 0 };
  const cancelParent = () => scope.controller.abort(parent.controller.signal.reason || abortError());
  if (parent) {
    parent.controller.signal.addEventListener("abort", cancelParent, {once: true});
    if (parent.controller.signal.aborted) cancelParent();
  }
  let timer, rejectAbort, completed = false;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(scope.controller.signal.reason || abortError()); });
  scope.controller.signal.addEventListener("abort", rejectAbort, {once: true});
  if (scope.controller.signal.aborted) rejectAbort();
  timer = setTimeout(() => scope.controller.abort(boundaryError("UPSTREAM_TIMEOUT", 504)), timeoutInteger(timeoutMs, 5000));
  try {
    const result = await Promise.race([Promise.resolve().then(() => ownership.run(scope, () => {
      if (scope.controller.signal.aborted) throw scope.controller.signal.reason;
      return fn();
    })), aborted]);
    completed = true;
    return result;
  } finally {
    clearTimeout(timer);
    parent?.controller.signal.removeEventListener("abort", cancelParent);
    scope.controller.signal.removeEventListener("abort", rejectAbort);
    scope.closed = true;
    // Also cancel unfinished work when a helper returns before its I/O settles.
    if (!scope.controller.signal.aborted) scope.controller.abort(abortError());
    for (const lease of scope.leases) {
      if (completed && parent && !parent.closed) parent.leases.add(lease);
      else lease.release();
    }
    scope.leases.clear();
  }
}
async function withAttempt(fn, options = {}) {
  const parent = ownership.getStore();
  if (!parent) return withOwnership(() => withAttempt(fn), undefined, true);
  const attempt = {...parent, leases:new Set(), attemptRetry:options.retry === true || parent.attemptCount++ > 0};
  let keep = false, propagated;
  try {
    const result = await ownership.run(attempt,fn);
    keep = !!result && !result.streamed && (!(result.status >= 400) || hasRetainedPayload(result));
    propagated = result;
    return result;
  } catch (error) {
    keep = hasRetainedPayload(error);
    propagated = error;
    throw error;
  } finally {
    if (keep && !parent.closed) {
      for (const lease of attempt.leases) parent.leases.add(lease);
      const previousRelease = propagated.release;
      let released = false;
      Object.defineProperty(propagated,"release",{configurable:true,value:() => {
        if(released)return;released=true;
        for(const lease of attempt.leases){lease.release();parent.leases.delete(lease);}
        previousRelease?.();
      }});
    } else for (const lease of attempt.leases) lease.release();
  }
}
function waitForDrain(response, signal) {
  if (response?.destroyed || signal?.aborted) return Promise.reject(signal?.reason || abortError());
  if (!response?.writableNeedDrain) return undefined;
  return new Promise((resolve,reject) => {
    const clean = () => {
      response.removeListener("drain",drained); response.removeListener("close",closed); response.removeListener("error",closed);
      signal?.removeEventListener("abort",closed);
    };
    const drained = () => {clean();resolve();};
    const closed = () => {clean();reject(signal?.reason || abortError());};
    response.once("drain",drained);response.once("close",closed);response.once("error",closed);signal?.addEventListener("abort",closed,{once:true});
  });
}
function createTransport(options = {}) {
  const env = options.env || process.env;
  const setting = (key, suffix, fallback) => positiveInteger(options[key] ?? env[`LLM_PROXY_${suffix}`], fallback);
  const config = {
    maxSockets: setting("maxSockets", "HTTP_MAX_SOCKETS", 64),
    maxTotalSockets: setting("maxTotalSockets", "HTTP_MAX_TOTAL_SOCKETS", 256),
    maxFreeSockets: setting("maxFreeSockets", "HTTP_MAX_FREE_SOCKETS", 16),
    maxRequests: setting("maxRequests", "HTTP_MAX_REQUESTS", 512),
    timeoutMs: timeoutInteger(options.timeoutMs ?? env.LLM_PROXY_UPSTREAM_TIMEOUT_MS, 300000),
    maxResponseBytes: setting("maxResponseBytes", "MAX_UPSTREAM_RESPONSE_BYTES", 32 * MiB),
    maxErrorBytes: setting("maxErrorBytes", "MAX_UPSTREAM_ERROR_BYTES", MiB),
    maxStreamBytes: setting("maxStreamBytes", "MAX_STREAM_BUFFER_BYTES", 32 * MiB),
    // Conservative charge for wire Buffer, decoded text, parsed/normalized body.
    representationMultiplier: positiveInteger(options.representationMultiplier, 8),
  };
  const budget = options.budget || createRetainedBudget(setting("maxRetainedBytes", "MAX_RETAINED_UPSTREAM_BYTES", 128 * MiB));
  const agents = { http: new http.Agent({keepAlive:true,...config}), https: new https.Agent({keepAlive:true,...config}) };
  const requests = new Set();
  let rejected = 0;
  const collector = (limit = config.maxStreamBytes, stream = true) => {
    const streamState = stream ? ownership.getStore()?.streamState || {bytes:0} : null;
    const lease = ownedLease(budget, limit * config.representationMultiplier);
    let received = 0, charged = 0, released = false;
    const releaseLease = lease.release;
    lease.release = () => {
      if (released) return;
      released=true;
      if(streamState)streamState.bytes-=charged;
      releaseLease();
    };
    return {
      retain(chunk) {
        const n = typeof chunk === "number" ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk));
        if (received + n > limit) throw boundaryError("UPSTREAM_RESPONSE_TOO_LARGE");
        const charge = n * config.representationMultiplier;
        if (streamState && streamState.bytes + charge > config.maxStreamBytes) throw boundaryError("UPSTREAM_RESPONSE_TOO_LARGE");
        lease.retain(charge); received += n; charged += charge;
        if (streamState) streamState.bytes += charge;
      },
      resize(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid retained size");
        if (released) return;
        if (bytes > received) { this.retain(bytes-received); return; }
        const debit = (received-bytes)*config.representationMultiplier;
        lease.unretain(debit); received=bytes; charged-=debit;
        if(streamState)streamState.bytes-=debit;
      },
      release: () => lease.release(),
      get bytes() { return received; },
    };
  };
  function request(url, options = {}, body, callbacks, buffered) {
    let req, res, timer, pendingDelivery, settled = false;
    const chunks = [];
    const hold = buffered ? collector(config.maxResponseBytes, false) : null;
    let errorHold, metricAttempt;
    const requestController = new AbortController();
    const parentSignal = currentSignal(options.signal);
    const signal = parentSignal ? AbortSignal.any([parentSignal,requestController.signal]) : requestController.signal;
    const abort = () => fail(signal?.reason instanceof Error ? signal.reason : abortError());
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (req) requests.delete(req);
    };
    const fail = (error, retainErrorBody = false) => {
      if (settled) return;
      settled = true; cleanup(); requestController.abort(error); hold?.release(); if (!retainErrorBody) errorHold?.release(); chunks.length = 0;
      res?.destroy?.(); req?.destroy?.();
      if (error?.code === "UPSTREAM_CLIENT_ABORTED") metricAttempt?.cancel(); else metricAttempt?.error();
      callbacks.error(error, error.statusCode);
    };
    try {
      if (requests.size >= config.maxRequests) { rejected++; throw boundaryError("UPSTREAM_TRANSPORT_OVERLOADED",503); }
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
      const parsed = new URL(url), secure = parsed.protocol === "https:";
      metricAttempt = beginNetworkDispatch({ category: options.metricCategory || "provider" });
      const { signal: ignored, timeoutMs, downstream, metricCategory, ...requestOptions } = options;
      req = (secure ? https : http).request(parsed, { ...requestOptions, agent: requestOptions.agent === undefined ? agents[secure ? "https" : "http"] : requestOptions.agent }, response => {
        if (settled) { response.destroy(); return; }
        res = response;
        if (!buffered && res.statusCode >= 400) errorHold = collector(config.maxErrorBytes, false);
        res.on("data", chunk => {
          if (settled) return;
          try {
            if (hold || errorHold) { (hold || errorHold).retain(chunk); chunks.push(chunk); }
            else {
              const result = callbacks.data(chunk, res);
              const waiting = result && typeof result.then === "function"
                ? result.then(() => waitForDrain(downstream,signal)) : waitForDrain(downstream,signal);
              if (waiting) { pendingDelivery=waiting; res.pause(); waiting.then(()=>{pendingDelivery=null;if(!settled)res.resume();},fail); }
            }
          } catch (error) { fail(error); }
        });
        res.once("aborted", () => fail(Object.assign(new Error("Upstream response aborted (truncated)"),{code:"UPSTREAM_TRUNCATED"})));
        res.on("error", fail);
        res.once("end", async () => {
          try { if (pendingDelivery) await pendingDelivery; } catch (error) { fail(error); return; }
          if (settled) return;
          if (res.complete === false) { fail(Object.assign(new Error("Upstream response aborted (truncated)"),{code:"UPSTREAM_TRUNCATED"})); return; }
          if (errorHold) {
            const body = Buffer.concat(chunks).toString("utf8");
            const error = upstreamHttpError(res.statusCode, body, res.headers);
            // Hand the collector to the consumer; withAttempt also attaches it to
            // the enclosing response lifetime. Empty errors release immediately.
            if (errorHold.bytes) Object.defineProperty(error,"release",{value:errorHold.release,configurable:true});
            fail(error, errorHold.bytes > 0); return;
          }
          settled = true; cleanup();
          if (res.statusCode >= 400) metricAttempt?.error(); else metricAttempt?.complete();
          try {
            if (buffered) {
              const result = {status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString("utf8")};
              chunks.length = 0;
              Object.defineProperty(result,"release",{value:hold.release,configurable:true});
              callbacks.end(result);
            } else await callbacks.end();
          } catch (error) { hold?.release(); callbacks.error(error); }
        });
      });
      requests.add(req);
      req.on("error", fail);
      req.once("close",()=>{if(!settled && !res?.complete)fail(Object.assign(new Error("Upstream request closed"),{code:"UPSTREAM_TRUNCATED"}));});
      signal?.addEventListener("abort",abort,{once:true});
      timer = setTimeout(()=>fail(boundaryError("UPSTREAM_TIMEOUT",504)),timeoutInteger(options.timeoutMs,config.timeoutMs)); timer.unref?.();
      req.end(body || undefined);
      return req;
    } catch (error) {
      queueMicrotask(()=>fail(error));
      return req || Object.assign(new EventEmitter(), {destroy: () => fail(abortError())});
    }
  }
  function makeRequest(url, options, body) { return new Promise((resolve,reject)=>request(url,options,body,{end:resolve,error:reject},true)); }
  function streamRequest(url, options, body, onData, onEnd, onError) { return request(url,options,body,{data:onData,end:onEnd,error:onError},false); }
  const count = name => Object.values(agents).reduce((sum,a)=>sum+Object.values(a[name]).reduce((n,list)=>n+list.length,0),0);
  return {config, agents, budget, collector, makeRequest, streamRequest,
    stats:()=>({inflight:requests.size,active:count("sockets"),pending:count("requests"),free:count("freeSockets"),transportRejected:rejected,...budget.snapshot()}),
    close:()=>{for(const req of requests)req.destroy(abortError());for(const agent of Object.values(agents))agent.destroy();},
  };
}
const shared = createTransport();
let nativeActive = 0;
const nativeControllers = new Set();
const maxNativeRequests = positiveInteger(process.env.LLM_PROXY_NATIVE_MAX_REQUESTS,32);
async function nativeOperation(fn) {
  if (!ownership.getStore()) return withOwnership(()=>nativeOperation(fn),undefined,true);
  const parent = ownership.getStore();
  if (parent.controller.signal.aborted) throw parent.controller.signal.reason || abortError();
  if (parent.native) return fn();
  if (nativeActive >= maxNativeRequests) throw boundaryError("UPSTREAM_TRANSPORT_OVERLOADED",503);
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.controller.signal.reason);
  parent.controller.signal.addEventListener("abort",cancel,{once:true});
  if(parent.controller.signal.aborted)cancel();
  const timer=setTimeout(()=>controller.abort(boundaryError("UPSTREAM_TIMEOUT",504)),shared.config.timeoutMs);timer.unref?.();
  const nativeScope = {...parent,controller,native:true};
  nativeActive++; nativeControllers.add(controller);
  try { return await ownership.run(nativeScope,fn); }
  finally { nativeActive--;nativeControllers.delete(controller);clearTimeout(timer);parent.controller.signal.removeEventListener("abort",cancel); }
}
function beginNetworkDispatch({category="provider",retry}={}) {
  const scope = ownership.getStore();
  const inferredRetry = scope ? scope.networkAttemptCount++ > 0 : false;
  return performanceMetrics.recordUpstreamDispatch({category,retry:retry === true || !!scope?.attemptRetry || inferredRetry});
}
function isClientCancellation(error, signal) {
  const reason = signal?.aborted ? signal.reason : undefined;
  if (error?.code === "UPSTREAM_CLIENT_ABORTED" || reason?.code === "UPSTREAM_CLIENT_ABORTED") return true;
  if (error?.code === "UPSTREAM_TIMEOUT" || reason?.code === "UPSTREAM_TIMEOUT" || error?.name === "TimeoutError" || reason?.name === "TimeoutError") return false;
  return error?.name === "AbortError" || reason?.name === "AbortError";
}
function settleNetworkAttempt(attempt,{error,status,signal}={}) {
  if(error) { if(isClientCancellation(error,signal))attempt.cancel();else attempt.error(); }
  else if(Number(status) >= 400)attempt.error();else attempt.complete();
}
async function trackedFetch(url, options = {}, metric = {}, fetchImpl = fetch) {
  if(options.signal?.aborted) throw options.signal.reason || Object.assign(new Error("Fetch aborted"),{name:"AbortError"});
  const attempt = beginNetworkDispatch(metric);
  try {
    const response = await fetchImpl(url,options);
    if(response.status >= 400 || !response.body) { settleNetworkAttempt(attempt,{status:response.status,signal:options.signal}); return response; }
    const reader=response.body.getReader();
    const body=new ReadableStream({
      async pull(controller){
        try { const item=await reader.read();if(item.done){attempt.complete();controller.close();}else controller.enqueue(item.value); }
        catch(error){settleNetworkAttempt(attempt,{error,signal:options.signal});controller.error(error);}
      },
      async cancel(reason){try{await reader.cancel(reason);}finally{settleNetworkAttempt(attempt,{error:reason instanceof Error?reason:Object.assign(new Error("Fetch body cancelled"),{name:"AbortError"}),signal:options.signal});}}
    });
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  } catch(error) {
    settleNetworkAttempt(attempt,{error,signal:options.signal});
    throw error;
  }
}
const sharedClose=shared.close;
shared.close=()=>{sharedClose();for(const controller of nativeControllers)controller.abort(abortError());};
const sharedStats=shared.stats;
shared.stats=()=>({...sharedStats(),nativeActive,maxNativeRequests});
performanceMetrics.setTransportStats(shared.stats);
async function readFetchBody(response, limit = shared.config.maxResponseBytes) {
  const hold = shared.collector(limit, false), chunks = [];
  try {
    for await (const chunk of response.body || []) { hold.retain(chunk); chunks.push(Buffer.from(chunk)); }
    return {body:Buffer.concat(chunks).toString("utf8"), release:hold.release};
  } catch (error) { hold.release(); throw error; }
}
module.exports = { ...shared, upstreamHttpError, safeErrorText, createTransport, createRetainedBudget, withOwnership, withDeadline, currentSignal, isLocalFailure, boundaryError, readFetchBody, nativeOperation, waitForDrain, withAttempt, beginNetworkDispatch, settleNetworkAttempt, trackedFetch };
