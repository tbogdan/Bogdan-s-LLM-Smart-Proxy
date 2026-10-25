"use strict";

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_INFLIGHT_REQUESTS = 128;
const DEFAULT_MAX_INFLIGHT_BODY_BYTES = 64 * 1024 * 1024;

class BodyLimitError extends Error {
  constructor(message = "Request body too large") {
    super(message);
    this.name = "BodyLimitError";
    this.code = "REQUEST_BODY_TOO_LARGE";
    this.statusCode = 413;
  }
}

class BodyTimeoutError extends Error {
  constructor(message = "Request body deadline exceeded") {
    super(message);
    this.name = "BodyTimeoutError";
    this.code = "REQUEST_BODY_TIMEOUT";
    this.statusCode = 408;
  }
}

class RequestAbortedError extends Error {
  constructor(message = "Request body upload aborted") {
    super(message);
    this.name = "RequestAbortedError";
    this.code = "REQUEST_BODY_ABORTED";
  }
}

class AdmissionError extends Error {
  constructor(message = "Inbound request capacity exhausted") {
    super(message);
    this.name = "AdmissionError";
    this.code = "REQUEST_BODY_OVERLOADED";
    this.statusCode = 503;
  }
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutInteger(value, fallback) {
  const parsed = positiveInteger(value, fallback);
  return parsed <= 2147483647 ? parsed : fallback;
}

function contentLength(req) {
  const raw = req.headers?.["content-length"];
  if (raw === undefined) return null;
  if (!/^\d+$/.test(String(raw))) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function createBodyAdmission(options = {}) {
  const maxInflightRequests = positiveInteger(options.maxInflightRequests, DEFAULT_MAX_INFLIGHT_REQUESTS);
  const maxInflightBodyBytes = positiveInteger(options.maxInflightBodyBytes, DEFAULT_MAX_INFLIGHT_BODY_BYTES);
  let inflightRequests = 0;
  let retainedBodyBytes = 0;

  return {
    admit() {
      if (inflightRequests >= maxInflightRequests) throw new AdmissionError();
      inflightRequests += 1;
      let retained = 0;
      let released = false;
      let unbind = null;
      const lease = {
        retain(bytes) {
          if (released) throw new Error("Inbound admission lease already released");
          if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Retained bytes must be a non-negative safe integer");
          if (retainedBodyBytes + bytes > maxInflightBodyBytes) throw new AdmissionError();
          retained += bytes;
          retainedBodyBytes += bytes;
        },
        // Streaming writes release queued bytes after their write callback. Late
        // callbacks after cancellation must not debit another request's lease.
        unretain(bytes) {
          if (released) return;
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > retained) throw new RangeError("Invalid retained byte release");
          retained -= bytes;
          retainedBodyBytes -= bytes;
        },
        bindResponse(res) {
          if (released || unbind) return;
          const done = () => lease.release();
          const events = ["finish", "close", "error"];
          for (const event of events) res.once(event, done);
          unbind = () => {
            for (const event of events) res.removeListener(event, done);
            unbind = null;
          };
        },
        release() {
          if (released) return;
          released = true;
          if (unbind) unbind();
          retainedBodyBytes -= retained;
          inflightRequests -= 1;
        },
        get retainedBytes() { return retained; },
      };
      return lease;
    },
    snapshot() { return { inflightRequests, retainedBodyBytes }; },
  };
}

function readBody(req, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BODY_BYTES);
  const timeoutMs = timeoutInteger(options.timeoutMs, DEFAULT_BODY_TIMEOUT_MS);
  const admission = options.admission;
  const declared = contentLength(req);
  if (declared !== null && declared > maxBytes) return Promise.reject(new BodyLimitError());

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (received + buffer.length > maxBytes) {
        req.pause?.();
        settle(new BodyLimitError());
        return;
      }
      try { admission?.retain(buffer.length); }
      catch (error) { req.pause?.(); settle(error); return; }
      received += buffer.length;
      chunks.push(buffer);
    };
    const onEnd = () => settle(null, Buffer.concat(chunks, received).toString("utf8"));
    const onError = (error) => settle(error);
    const onClose = () => {
      if (!req.readableEnded) settle(new RequestAbortedError());
    };
    const timer = setTimeout(() => {
      req.pause?.();
      settle(new BodyTimeoutError());
    }, timeoutMs);
    timer.unref?.();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("close", onClose);
  });
}

module.exports = {
  timeoutInteger,
  AdmissionError,
  BodyLimitError,
  BodyTimeoutError,
  RequestAbortedError,
  createBodyAdmission,
  readBody,
  positiveInteger,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_MAX_INFLIGHT_REQUESTS,
  DEFAULT_MAX_INFLIGHT_BODY_BYTES,
};
