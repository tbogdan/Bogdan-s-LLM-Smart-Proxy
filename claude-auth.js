#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function usage() {
  return [
    "Usage: node claude-auth.js [--env-path <path>] [--allow-claude-ai] [--skip-status-check]",
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
  const options = { envFile: ".env", allowClaudeAi: false, skipStatusCheck: false };
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.envFile) throw new Error("--env-path requires a value");
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

function validateClaudeStatus(status, { allowClaudeAi = false } = {}) {
  if (!status || status.loggedIn !== true) {
    throw new Error("Claude is not logged in. Run `claude auth login --console` first.");
  }
  if (!allowClaudeAi && status.authMethod === "claude.ai") {
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
  if (/^[A-Za-z0-9_./:$=@+-]+$/.test(value)) return value;
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

function writeApiKey(envFile, apiKey) {
  if (!isAnthropicApiKey(apiKey)) throw new Error("Extracted value does not look like an Anthropic API key.");
  const resolved = path.resolve(envFile);
  const current = readFileIfExists(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, upsertEnvValue(current, "ANTHROPIC_API_KEY", apiKey));
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
  const envPath = writeApiKey(options.envFile, apiKey);
  console.log(`Updated ANTHROPIC_API_KEY in ${envPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  candidateCredentialFiles,
  findApiKeyInJson,
  getManagedApiKey,
  isAnthropicApiKey,
  keychainServiceName,
  parseArgs,
  readClaudeStatus,
  readMacKeychainApiKey,
  safeAccountName,
  upsertEnvValue,
  validateClaudeStatus,
  writeApiKey,
};
