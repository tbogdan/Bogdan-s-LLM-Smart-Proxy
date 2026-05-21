"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const fingerprint = require("./copilot-fingerprint");

const DEFAULT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_TIMEOUT_MS = 30_000;
const REFRESH_SKEW_SECONDS = 60;
const DEFAULT_USER_AGENT = `GitHubCopilotChat/${fingerprint.DEFAULT_EXTENSION_VERSION}`;

const tokenCache = new Map();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isCopilotProvider(provider = {}) {
  return String(provider.family || "").toLowerCase() === "copilot"
    || /^copilot\//i.test(String(provider.model || ""));
}

function cacheKey(githubToken, tokenUrl) {
  return crypto
    .createHash("sha256")
    .update(String(tokenUrl || ""))
    .update("\0")
    .update(String(githubToken || ""))
    .digest("hex");
}

function clearCopilotTokenCache() {
  tokenCache.clear();
}

function normalizeHeaders(headers = {}) {
  const normalized = { ...headers };
  for (const key of Object.keys(normalized)) {
    if (key.toLowerCase() === "authorization") delete normalized[key];
  }
  return normalized;
}

function runtimeClientHeaders(options = {}) {
  return fingerprint.runtimeHeaders(options);
}

function requestJSON(urlStr, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(parsed, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...fingerprint.fetcherHeaders(),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = body ? JSON.parse(body) : null;
        } catch (error) {
          reject(new Error(`GitHub Copilot token response was not JSON (HTTP ${res.statusCode})`));
          return;
        }
        resolve({ status: res.statusCode, statusText: res.statusMessage, data, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("GitHub Copilot token request timed out"));
    });
    req.end();
  });
}

function tokenEnvelopeExpiry(envelope = {}) {
  const expiresAt = Number(envelope.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  const refreshIn = Number(envelope.refresh_in);
  if (Number.isFinite(refreshIn) && refreshIn > 0) return nowSeconds() + refreshIn;
  return nowSeconds() + 300;
}

function tokenFromEnvelope(envelope = {}) {
  return envelope.token || envelope.access_token || envelope.copilot_token || "";
}

function isFresh(entry) {
  return entry && entry.token && Number(entry.expiresAt) > nowSeconds() + REFRESH_SKEW_SECONDS;
}

async function exchangeGitHubTokenForCopilotToken(githubToken, options = {}) {
  if (!githubToken) throw new Error("Missing GitHub token for Copilot provider");
  const tokenUrl = options.tokenUrl || process.env.COPILOT_TOKEN_URL || DEFAULT_TOKEN_URL;
  const key = cacheKey(githubToken, tokenUrl);
  const cached = tokenCache.get(key);
  if (isFresh(cached)) return cached;

  const requestJSONFn = options.requestJSONFn || requestJSON;
  const response = await requestJSONFn(
    tokenUrl,
    fingerprint.tokenExchangeHeaders(githubToken, options),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
  );

  if (!response || Number(response.status) >= 400) {
    const status = response?.status ? `HTTP ${response.status}` : "no response";
    throw new Error(`GitHub Copilot token exchange failed (${status})`);
  }

  const token = tokenFromEnvelope(response.data);
  if (!token) throw new Error("GitHub Copilot token exchange response did not include a runtime token");

  const entry = {
    token,
    expiresAt: tokenEnvelopeExpiry(response.data),
    endpoints: response.data?.endpoints || {},
  };
  tokenCache.set(key, entry);
  return entry;
}

function isRuntimeTokenProvider(provider = {}) {
  return provider.authHeader === "copilot-runtime" || provider.key_env === "COPILOT_CAPI_TOKEN";
}

async function buildCopilotRuntimeHeaders(provider = {}, baseHeaders = {}, options = {}) {
  const headers = normalizeHeaders({
    ...(baseHeaders || {}),
    ...(provider.headers || {}),
    ...runtimeClientHeaders(options),
  });

  if (isRuntimeTokenProvider(provider)) {
    if (!provider.key) throw new Error("Missing Copilot runtime token");
    headers.Authorization = `Bearer ${provider.key}`;
    return headers;
  }

  const entry = await exchangeGitHubTokenForCopilotToken(provider.key, options);
  headers.Authorization = `Bearer ${entry.token}`;
  return headers;
}

module.exports = {
  DEFAULT_TOKEN_URL,
  DEFAULT_USER_AGENT,
  buildCopilotRuntimeHeaders,
  clearCopilotTokenCache,
  exchangeGitHubTokenForCopilotToken,
  isCopilotProvider,
  requestJSON,
  runtimeClientHeaders,
};
