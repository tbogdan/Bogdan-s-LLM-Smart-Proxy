"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const WINDSURF_LOGIN_URL = "https://windsurf.com/windsurf/signin";
const WINDSURF_REGISTER_URL = "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser";
const WINDSURF_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u";
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_TIMEOUT_MS = 120000;
const USER_AGENT = "llm-proxy-llm-smart-proxy";

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
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.from([...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(bytes.length), ...bytes]);
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let next = offset;
  while (next < buffer.length) {
    const byte = buffer[next];
    value |= BigInt(byte & 0x7f) << shift;
    next += 1;
    if (byte < 0x80) return { value, next };
    shift += 7n;
  }
  return null;
}

function parseFields(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    if (!key) break;
    offset = key.next;
    const fieldNum = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);

    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      if (!value) break;
      offset = value.next;
      continue;
    }
    if (wireType !== 2) break;

    const length = readVarint(buffer, offset);
    if (!length) break;
    offset = length.next;
    const end = offset + Number(length.value);
    if (end > buffer.length) break;
    const value = buffer.subarray(offset, end).toString("utf8");
    offset = end;

    const values = fields.get(fieldNum) || [];
    values.push(value);
    fields.set(fieldNum, values);
  }
  return fields;
}

function buildLoginUrl({ redirectUri, state = crypto.randomUUID(), loginHint } = {}) {
  if (!redirectUri) throw new Error("Windsurf redirectUri is required");
  const url = new URL(WINDSURF_LOGIN_URL);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("client_id", WINDSURF_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "login");
  url.searchParams.set("redirect_parameters_type", "fragment");
  url.searchParams.set("workflow", "");
  if (loginHint && loginHint.trim()) url.searchParams.set("login_hint", loginHint.trim());
  return url.toString();
}

function createLoginUrl(options = {}) {
  return buildLoginUrl(options);
}

function normalizeOneTimeAuthToken(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("Windsurf one-time auth token is required");

  const embedded = trimmed.match(/\/?ott\$[^\s"'<>]+/);
  if (embedded) return embedded[0].replace(/^\//, "");

  try {
    const url = new URL(trimmed);
    const candidates = [];
    if (url.hash) candidates.push(new URLSearchParams(url.hash.slice(1)));
    candidates.push(url.searchParams);
    for (const params of candidates) {
      for (const key of ["authToken", "auth_token", "access_token", "token", "code"]) {
        const value = params.get(key);
        if (value && value.trim()) return normalizeOneTimeAuthToken(value);
      }
    }
  } catch {
    // Plain tokens are handled below.
  }

  if (trimmed.startsWith("ott$")) return trimmed;
  if (trimmed.startsWith("/ott$")) return trimmed.slice(1);
  return `ott$${trimmed}`;
}

function parseCallbackUrl(url, expectedState) {
  const parsed = new URL(url);
  const hashParams = parsed.hash ? new URLSearchParams(parsed.hash.slice(1)) : new URLSearchParams();
  const state = parsed.searchParams.get("state") || hashParams.get("state");
  if (expectedState && state !== expectedState) {
    throw new Error("Windsurf auth state mismatch");
  }

  for (const params of [parsed.searchParams, hashParams]) {
    for (const key of ["access_token", "authToken", "auth_token", "token", "code"]) {
      const value = params.get(key);
      if (value && value.trim()) return { token: normalizeOneTimeAuthToken(value) };
    }
  }
  throw new Error("Windsurf callback did not include an auth token");
}

async function registerWindsurfOneTimeToken(tokenInput, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const registerUrl = options.registerUrl || WINDSURF_REGISTER_URL;
  const oneTimeToken = normalizeOneTimeAuthToken(tokenInput);
  const response = await fetchImpl(registerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "user-agent": USER_AGENT,
    },
    body: encodeString(1, oneTimeToken),
  });

  if (!response.ok) {
    const body = typeof response.text === "function" ? await response.text() : "";
    const error = new Error(`Windsurf registration failed with HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  const body = Buffer.from(await response.arrayBuffer());
  const fields = parseFields(body);
  const apiKey = fields.get(1) && fields.get(1)[0] ? fields.get(1)[0].trim() : "";
  if (!apiKey) throw new Error("Windsurf registration response did not include an API key");
  return {
    apiKey,
    name: fields.get(2) ? fields.get(2)[0] : undefined,
    email: fields.get(3) ? fields.get(3)[0] : undefined,
  };
}

function startLoopbackAuth(options = {}) {
  const host = options.host || LOOPBACK_HOST;
  const timeoutMs = options.timeoutMs || LOOPBACK_TIMEOUT_MS;
  const state = options.state || crypto.randomUUID();
  let server;
  let settled = false;
  let resolveToken;
  let rejectToken;

  const tokenPromise = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  function settle(error, token) {
    if (settled) return;
    settled = true;
    if (error) rejectToken(error);
    else resolveToken(token);
  }

  server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:0`}`);
    if (url.pathname === "/callback-token") {
      try {
        settle(null, parseCallbackUrl(url.toString(), state).token);
      } catch (error) {
        settle(error);
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("OK");
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
<html><body>
<p>Windsurf authentication complete. You can close this tab.</p>
<script>
const params = new URLSearchParams(location.hash.slice(1));
fetch('/callback-token?' + params.toString()).catch(() => {});
</script>
</body></html>`);
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const redirectUri = `http://${host}:${server.address().port}/callback`;
      resolve({
        url: buildLoginUrl({ ...options, redirectUri, state }),
        redirectUri,
        port: server.address().port,
      });
    });
  });

  const timeout = setTimeout(() => settle(new Error("Windsurf authentication timed out")), timeoutMs);

  async function waitForToken() {
    try {
      return await tokenPromise;
    } finally {
      clearTimeout(timeout);
      server.close(() => {});
    }
  }

  return {
    ready,
    waitForToken,
    close() {
      clearTimeout(timeout);
      server.close(() => {});
    },
  };
}

function readHostToken(env = process.env) {
  return env.WINDSURF_API_KEY || env.WINDSURF_ACCESS_TOKEN || env.WINDSURF_TOKEN || "";
}

module.exports = {
  WINDSURF_LOGIN_URL,
  WINDSURF_REGISTER_URL,
  WINDSURF_CLIENT_ID,
  USER_AGENT,
  normalizeOneTimeAuthToken,
  buildLoginUrl,
  createLoginUrl,
  parseCallbackUrl,
  encodeVarint,
  encodeString,
  parseFields,
  registerWindsurfOneTimeToken,
  startLoopbackAuth,
  readHostToken,
};
