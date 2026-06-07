#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

function usage() {
  return [
    "Usage: node claude-auth.js [--env-path <path>] [--allow-claude-ai] [--skip-status-check] [--session-id <uuid>] [--skip-cli-probe]",
    "",
    "Extracts the API key managed by `claude auth login --console` and stores it as ANTHROPIC_API_KEY.",
    "",
    "Expected flow:",
    "  claude auth logout",
    "  claude auth login --console",
    "  node claude-auth.js --env-path .env",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { envFile: ".env", allowClaudeAi: false, skipStatusCheck: false, sessionId: "", skipCliProbe: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--env-path") {
      options.envFile = argv[++i] || "";
    } else if (arg === "--allow-claude-ai") {
      options.allowClaudeAi = true;
    } else if (arg === "--skip-status-check") {
      options.skipStatusCheck = true;
    } else if (arg === "--session-id") {
      options.sessionId = argv[++i] || "";
    } else if (arg === "--skip-cli-probe") {
      options.skipCliProbe = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.envFile) throw new Error("--env-path requires a value");
  if (options.sessionId && !/^[0-9a-fA-F-]{8,}$/.test(options.sessionId)) throw new Error("--session-id must be a UUID-like value");
  return options;
}

function safeAccountName(env = process.env) {
  let account = env.USER || "";
  if (!account) {
    try {
      account = os.userInfo().username;
    } catch {
      account = "claude-code-user";
    }
  }
  return /^[a-zA-Z0-9._-]+$/.test(account) ? account : "claude-code-user";
}

function oauthFileSuffix(env = process.env) {
  return env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
}

function keychainServiceName({ env = process.env } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || "";
  const configSuffix = configDir
    ? `-${crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`
    : "";
  return `Claude Code${oauthFileSuffix(env)}${configSuffix}`;
}

function isAnthropicApiKey(value) {
  return /^sk-ant-api/i.test(String(value || "").trim());
}

function readClaudeStatus({ execFileSyncImpl = execFileSync } = {}) {
  const output = execFileSyncImpl("claude", ["auth", "status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

function parseClaudeVersion(output = "") {
  const match = String(output || "").match(/\b(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : "";
}

function readClaudeVersion({ execFileSyncImpl = execFileSync } = {}) {
  try {
    return parseClaudeVersion(execFileSyncImpl("claude", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    return "";
  }
}

function validateClaudeStatus(status, { allowClaudeAi = false } = {}) {
  if (!status || status.loggedIn !== true) {
    throw new Error("Claude is not logged in. Run `claude auth login --console` first.");
  }
  const hasApiKeySource = typeof status.apiKeySource === "string" && status.apiKeySource.length > 0 && status.apiKeySource !== "none";
  if (!allowClaudeAi && status.authMethod === "claude.ai" && !hasApiKeySource) {
    throw new Error("Claude is logged in with Claude.ai. Run `claude auth logout`, then `claude auth login --console` and choose Anthropic Console.");
  }
}

function readMacKeychainApiKey({ env = process.env, execFileSyncImpl = execFileSync } = {}) {
  if (process.platform !== "darwin") return "";
  try {
    const output = execFileSyncImpl("security", [
      "find-generic-password",
      "-a",
      safeAccountName(env),
      "-w",
      "-s",
      keychainServiceName({ env }),
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return isAnthropicApiKey(output) ? output : "";
  } catch {
    return "";
  }
}

function findApiKeyInJson(value) {
  if (typeof value === "string") return isAnthropicApiKey(value) ? value : "";
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findApiKeyInJson(item);
      if (found) return found;
    }
    return "";
  }
  for (const key of Object.keys(value)) {
    const found = findApiKeyInJson(value[key]);
    if (found) return found;
  }
  return "";
}

function readJsonFileApiKey(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return findApiKeyInJson(parsed);
  } catch {
    return "";
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function defaultClaudeJsonPath({ env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".claude.json");
}

function projectSessionId(config = {}, cwd = process.cwd()) {
  const projects = config.projects || {};
  const direct = projects[cwd];
  if (direct?.lastSessionId) return direct.lastSessionId;
  if (direct?.lastHintSessionId) return direct.lastHintSessionId;
  const resolved = path.resolve(cwd);
  const resolvedEntry = projects[resolved];
  if (resolvedEntry?.lastSessionId) return resolvedEntry.lastSessionId;
  if (resolvedEntry?.lastHintSessionId) return resolvedEntry.lastHintSessionId;
  return "";
}

function compactProfile(profile = {}) {
  const output = {};
  for (const [key, value] of Object.entries(profile)) {
    if (value == null || value === "") continue;
    output[key] = value;
  }
  return output;
}

function readClaudeProfile({
  env = process.env,
  configFile = defaultClaudeJsonPath({ env }),
  cwd = process.cwd(),
  execFileSyncImpl = execFileSync,
  sessionId = "",
} = {}) {
  const config = readJsonFile(configFile);
  return compactProfile({
    deviceId: config.userID,
    accountUuid: config.oauthAccount?.accountUuid,
    organizationUuid: config.oauthAccount?.organizationUuid,
    sessionId: sessionId || projectSessionId(config, cwd),
    version: readClaudeVersion({ execFileSyncImpl }),
  });
}

function parseClaudeCodeBillingBuild(header = "") {
  const match = String(header || "").match(/\bcc_version=(\d+\.\d+\.\d+)\.([A-Za-z0-9]+)/);
  return match ? match[2] : "";
}

function billingBuildFromBody(body = {}) {
  const system = body.system;
  const parts = Array.isArray(system) ? system : (system ? [system] : []);
  for (const part of parts) {
    const text = typeof part === "string" ? part : part?.text;
    const build = parseClaudeCodeBillingBuild(text);
    if (build) return build;
  }
  return "";
}

function requestDefaultsFromCapture(captured = {}) {
  const headers = captured.headers || {};
  const body = captured.body || {};
  const debugText = captured.debugText || "";
  return compactProfile({
    maxTokens: Number.isFinite(Number(body.max_tokens)) ? Number(body.max_tokens) : "",
    stainlessPackageVersion: headers["x-stainless-package-version"],
    billingBuild: parseClaudeCodeBillingBuild(headers["x-anthropic-billing-header"]) || billingBuildFromBody(body) || parseClaudeCodeBillingBuild(debugText),
    betas: headers["anthropic-beta"],
    outputEffort: body.output_config?.effort,
  });
}

async function captureClaudeCliRequestDefaults({
  env = process.env,
  timeoutMs = 8000,
} = {}) {
  const probeSessionId = crypto.randomUUID();
  const debugFile = path.join(os.tmpdir(), `claude-cli-probe-${probeSessionId}.log`);
  let server;
  let child;
  let bestCapture = null;
  let settleTimer = null;

  return await new Promise((resolve) => {
    const finish = (value) => {
      if (settleTimer) clearTimeout(settleTimer);
      try { child?.kill?.(); } catch {}
      try { server?.close?.(); } catch {}
      let debugText = "";
      try { debugText = fs.readFileSync(debugFile, "utf8"); } catch {}
      try { fs.unlinkSync(debugFile); } catch {}
      value = value || bestCapture;
      if (value?.headers || value?.body) {
        resolve(requestDefaultsFromCapture({ ...value, debugText }));
      } else {
        resolve(value || {});
      }
    };

    server = http.createServer((req, res) => {
      if (req.method !== "POST" || !String(req.url || "").startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        const capture = { headers: req.headers, body };
        const score = (body.thinking ? 100 : 0) + ((body.tools || []).length * 2) + (raw.length / 100000);
        const previousScore = bestCapture?._score || -1;
        if (!bestCapture || score > previousScore) bestCapture = { ...capture, _score: score };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_cli_probe",
          type: "message",
          role: "assistant",
          model: body.model || "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
        if (body.thinking || (body.tools || []).length > 0) {
          finish(bestCapture);
        } else {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(bestCapture), 1500);
          settleTimer.unref?.();
        }
      });
    });

    server.on("error", () => finish({}));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const childEnv = {
        ...env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || "sk-ant-api03-cli-probe",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_USE_BEDROCK: "",
        CLAUDE_CODE_USE_VERTEX: "",
      };
      child = spawn("claude", [
        "--setting-sources",
        "project",
        "--model",
        "claude-opus-4-8",
        "--effort",
        "high",
        "--session-id",
        probeSessionId,
        "--debug",
        "api",
        "--debug-file",
        debugFile,
        "-p",
        "Reply ok.",
      ], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});
      child.on("error", () => finish({}));
      child.on("exit", () => setTimeout(() => finish(bestCapture || {}), 50));
    });

    setTimeout(() => finish({}), timeoutMs).unref?.();
  });
}

function candidateCredentialFiles({ env = process.env } = {}) {
  const home = os.homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return [
    path.join(configDir, ".credentials.json"),
    path.join(home, ".claude.json"),
  ];
}

function readPlaintextApiKey({ env = process.env } = {}) {
  for (const filePath of candidateCredentialFiles({ env })) {
    const found = readJsonFileApiKey(filePath);
    if (found) return found;
  }
  return "";
}

function getManagedApiKey({ env = process.env, execFileSyncImpl = execFileSync } = {}) {
  if (isAnthropicApiKey(env.ANTHROPIC_API_KEY)) return env.ANTHROPIC_API_KEY.trim();
  return readMacKeychainApiKey({ env, execFileSyncImpl }) || readPlaintextApiKey({ env });
}

function quoteEnvValue(value) {
  if (/^[A-Za-z0-9_./:$=@+,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function upsertEnvValue(text, key, value) {
  const line = `${key}=${quoteEnvValue(value)}`;
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  let updated = false;
  const output = lines.map((existing) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(existing)) {
      updated = true;
      return line;
    }
    return existing;
  });
  if (!updated) output.push(line);
  return `${output.join("\n")}\n`;
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function writeApiKey(envFile, apiKey, profile = {}) {
  if (!isAnthropicApiKey(apiKey)) throw new Error("Extracted value does not look like an Anthropic API key.");
  const resolved = path.resolve(envFile);
  const current = readFileIfExists(resolved);
  let next = upsertEnvValue(current, "ANTHROPIC_API_KEY", apiKey);
  const entries = [
    ["CLAUDE_CODE_DEVICE_ID", profile.deviceId],
    ["CLAUDE_CODE_ACCOUNT_UUID", profile.accountUuid],
    ["CLAUDE_CODE_ORGANIZATION_UUID", profile.organizationUuid],
    ["CLAUDE_CODE_SESSION_ID", profile.sessionId],
    ["CLAUDE_CODE_VERSION", profile.version],
    ["CLAUDE_CODE_BILLING_BUILD", profile.billingBuild],
    ["CLAUDE_CODE_MAX_TOKENS", profile.maxTokens],
    ["CLAUDE_CODE_STAINLESS_PACKAGE_VERSION", profile.stainlessPackageVersion],
    ["CLAUDE_CODE_BETAS", profile.betas],
    ["CLAUDE_CODE_OUTPUT_EFFORT", profile.outputEffort],
  ];
  for (const [key, value] of entries) {
    if (value == null || value === "") continue;
    next = upsertEnvValue(next, key, String(value));
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, next);
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.skipStatusCheck) {
    validateClaudeStatus(readClaudeStatus(), { allowClaudeAi: options.allowClaudeAi });
  }
  const apiKey = getManagedApiKey();
  if (!apiKey) {
    throw new Error("Could not find Claude Console API key. Run `claude auth login --console`, then retry.");
  }
  const profile = readClaudeProfile({ sessionId: options.sessionId });
  const cliDefaults = options.skipCliProbe
    ? {}
    : await captureClaudeCliRequestDefaults({
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    });
  const envPath = writeApiKey(options.envFile, apiKey, { ...profile, ...cliDefaults });
  console.log(`Updated ANTHROPIC_API_KEY and Claude Code profile in ${envPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  candidateCredentialFiles,
  captureClaudeCliRequestDefaults,
  findApiKeyInJson,
  getManagedApiKey,
  isAnthropicApiKey,
  keychainServiceName,
  parseArgs,
  parseClaudeCodeBillingBuild,
  parseClaudeVersion,
  readClaudeProfile,
  readClaudeStatus,
  readClaudeVersion,
  requestDefaultsFromCapture,
  readMacKeychainApiKey,
  safeAccountName,
  upsertEnvValue,
  validateClaudeStatus,
  writeApiKey,
};
