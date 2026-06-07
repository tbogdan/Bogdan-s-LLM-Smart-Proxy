"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_EXTENSION_VERSION = "0.49.0";
const DEFAULT_VSCODE_VERSION = "1.121.0";
const DEFAULT_FETCHER_ID = "node-http";
const DEFAULT_INTEGRATION_ID = "vscode-chat";
const DEFAULT_CAPI_API_VERSION = "2026-01-09";
const TOKEN_API_VERSION = "2025-04-01";

const sessionDefaults = {
  sessionId: randomId(),
  interactionId: randomId(),
  machineId: randomId(),
  deviceId: randomId(),
};

function randomId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function homeDir(env = process.env) {
  return env.HOME || os.homedir();
}

function codeStorageRoots(env = process.env) {
  const home = homeDir(env);
  return [
    env.VSCODE_USER_DATA_DIR,
    home ? path.join(home, "Library/Application Support/Code") : "",
    home ? path.join(home, "Library/Application Support/Code - Insiders") : "",
    home ? path.join(home, "Library/Application Support/VSCodium") : "",
    home ? path.join(home, "Library/Application Support/Windsurf") : "",
  ].filter(Boolean);
}

function extensionRoots(env = process.env) {
  const home = homeDir(env);
  return [
    env.VSCODE_EXTENSIONS_DIR,
    home ? path.join(home, ".vscode/extensions") : "",
    home ? path.join(home, ".vscode-insiders/extensions") : "",
    home ? path.join(home, ".windsurf/extensions") : "",
  ].filter(Boolean);
}

function appPackagePaths(env = process.env) {
  return [
    env.VSCODE_APP_PACKAGE_JSON,
    "/Applications/Visual Studio Code.app/Contents/Resources/app/package.json",
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/package.json",
    "/Applications/Windsurf.app/Contents/Resources/app/package.json",
  ].filter(Boolean);
}

function normalizeVersion(value, fallback = "") {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text.replace(/^(?:vscode|copilot-chat|githubcopilotchat)\//i, "");
}

function compareSemver(a, b) {
  const left = String(a || "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function discoverExtensionVersion(env = process.env) {
  const versions = [];

  for (const root of extensionRoots(env)) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^github\.copilot-chat-/i.test(entry.name)) continue;
      const fromName = entry.name.replace(/^github\.copilot-chat-/i, "");
      if (fromName) versions.push(fromName);
      const manifest = readJSON(path.join(root, entry.name, "package.json"));
      if (manifest?.version) versions.push(manifest.version);
    }
  }

  for (const root of codeStorageRoots(env)) {
    let entries = [];
    const cacheRoot = path.join(root, "CachedExtensionVSIXs");
    try {
      entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.name.match(/^github\.copilot-chat-([0-9][A-Za-z0-9.-]*)/i);
      if (match) versions.push(match[1]);
    }
  }

  return versions.sort(compareSemver).pop() || DEFAULT_EXTENSION_VERSION;
}

function discoverVSCodeVersion(env = process.env) {
  for (const file of appPackagePaths(env)) {
    const manifest = readJSON(file);
    if (manifest?.version) return manifest.version;
  }
  return DEFAULT_VSCODE_VERSION;
}

function discoverTelemetryIds(env = process.env) {
  for (const root of codeStorageRoots(env)) {
    const storage = readJSON(path.join(root, "User/globalStorage/storage.json"));
    const machineId = storage?.["telemetry.machineId"];
    const deviceId = storage?.["telemetry.devDeviceId"];
    if (machineId || deviceId) {
      return {
        machineId: machineId || readText(path.join(root, "machineid")),
        deviceId,
      };
    }
    const machineFile = readText(path.join(root, "machineid"));
    if (machineFile) return { machineId: machineFile, deviceId: "" };
  }
  return {};
}

function resolveClientInfo(options = {}) {
  const env = options.env || process.env;
  const telemetry = discoverTelemetryIds(env);
  const extensionVersion = normalizeVersion(
    options.extensionVersion ||
      env.COPILOT_EXTENSION_VERSION ||
      env.COPILOT_CHAT_EXTENSION_VERSION ||
      discoverExtensionVersion(env),
    DEFAULT_EXTENSION_VERSION,
  );
  const vscodeVersion = normalizeVersion(
    options.vscodeVersion ||
      env.COPILOT_VSCODE_VERSION ||
      env.COPILOT_EDITOR_VERSION ||
      discoverVSCodeVersion(env),
    DEFAULT_VSCODE_VERSION,
  );

  return {
    extensionVersion,
    vscodeVersion,
    sessionId: options.sessionId || env.COPILOT_VSCODE_SESSION_ID || sessionDefaults.sessionId,
    machineId: options.machineId || env.COPILOT_VSCODE_MACHINE_ID || telemetry.machineId || sessionDefaults.machineId,
    deviceId: options.deviceId || env.COPILOT_EDITOR_DEVICE_ID || telemetry.deviceId || sessionDefaults.deviceId,
    interactionId: options.interactionId || env.COPILOT_INTERACTION_ID || sessionDefaults.interactionId,
    fetcherId: options.fetcherId || env.COPILOT_FETCHER_ID || DEFAULT_FETCHER_ID,
    integrationId: options.integrationId || env.COPILOT_INTEGRATION_ID || DEFAULT_INTEGRATION_ID,
    hmacSecret: options.hmacSecret || env.COPILOT_REQUEST_HMAC_SECRET || env.COPILOT_HMAC_SECRET || "",
  };
}

function userAgent(options = {}) {
  const explicit = options.userAgent || options.env?.COPILOT_USER_AGENT || process.env.COPILOT_USER_AGENT;
  if (explicit) return explicit;
  return `GitHubCopilotChat/${resolveClientInfo(options).extensionVersion}`;
}

function fetcherHeaders(options = {}) {
  const info = resolveClientInfo(options);
  return {
    "User-Agent": userAgent(options),
    "X-VSCode-User-Agent-Library-Version": info.fetcherId,
  };
}

function requestHmac(secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret) return "";
  const timestamp = String(now);
  const digest = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");
  return `${timestamp}.${digest}`;
}

function capiClientHeaders(options = {}) {
  const info = resolveClientInfo(options);
  const integrationId = info.integrationId;
  const headers = {
    ...fetcherHeaders(options),
    "X-GitHub-Api-Version": options.githubApiVersion || options.env?.COPILOT_GITHUB_API_VERSION || DEFAULT_CAPI_API_VERSION,
    "VScode-SessionId": info.sessionId,
    "VScode-MachineId": info.machineId,
    "Editor-Device-Id": info.deviceId,
    "Editor-Plugin-Version": `copilot-chat/${info.extensionVersion}`,
    "Editor-Version": `vscode/${info.vscodeVersion}`,
    "Copilot-Integration-Id": integrationId,
  };

  if (integrationId === "vscode-chat-dev" && info.hmacSecret) {
    headers["Request-Hmac"] = requestHmac(info.hmacSecret, options.hmacTimestamp);
  }

  return headers;
}

function capiRequestHeaders(options = {}) {
  const requestId = options.requestId || randomId();
  const intent = options.intent || "conversation-panel";
  const headers = {
    "X-Request-Id": requestId,
    "OpenAI-Intent": intent,
    "X-Interaction-Type": options.interactionType || intent,
    "X-Agent-Task-Id": options.agentTaskId || requestId,
  };

  if (options.includeInteractionHeaders !== false) {
    const info = resolveClientInfo(options);
    headers["X-Interaction-Id"] = options.interactionId || info.interactionId;
    headers["X-Initiator"] = options.initiator || "user";
  }

  return headers;
}

function tokenExchangeHeaders(githubToken, options = {}) {
  return {
    ...fetcherHeaders(options),
    Authorization: `token ${githubToken}`,
    "X-GitHub-Api-Version": TOKEN_API_VERSION,
  };
}

function runtimeHeaders(options = {}) {
  return {
    ...capiClientHeaders(options),
    ...capiRequestHeaders(options),
  };
}

module.exports = {
  DEFAULT_CAPI_API_VERSION,
  DEFAULT_EXTENSION_VERSION,
  DEFAULT_FETCHER_ID,
  DEFAULT_INTEGRATION_ID,
  DEFAULT_VSCODE_VERSION,
  TOKEN_API_VERSION,
  capiClientHeaders,
  capiRequestHeaders,
  fetcherHeaders,
  requestHmac,
  resolveClientInfo,
  runtimeHeaders,
  tokenExchangeHeaders,
  userAgent,
};
