#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const VS_CODE_GITHUB_AUTH_CLIENT_ID = "01ab8ac9400c4e429b23";

function usage() {
  return [
    "Usage: node github-copilot-auth.js [--client-id <oauth-client-id>] [--env-file <path>] [--scope <scope>]",
    "",
    "Runs GitHub OAuth device flow and stores COPILOT_GITHUB_TOKEN in the selected env file.",
    "Defaults to VS Code GitHub Authentication's public client id; set GITHUB_COPILOT_CLIENT_ID to override.",
  ].join("\n");
}

function parseArgs(argv, env = process.env) {
  const options = {
    clientId: env.GITHUB_COPILOT_CLIENT_ID || VS_CODE_GITHUB_AUTH_CLIENT_ID,
    envFile: ".env",
    scope: env.GITHUB_COPILOT_SCOPE || "read:user user:email",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--client-id") {
      options.clientId = argv[++i] || "";
      if (!options.clientId) throw new Error("--client-id requires a value");
    } else if (arg === "--env-file" || arg === "--env-path") {
      options.envFile = argv[++i] || "";
      if (!options.envFile) throw new Error(`${arg} requires a value`);
    } else if (arg === "--scope") {
      options.scope = argv[++i] || "";
      if (!options.scope) throw new Error("--scope requires a value");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requestJSON(urlStr, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = new URLSearchParams(body).toString();
    const req = https.request(urlStr, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
      timeout: 30_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode, data: JSON.parse(text) });
        } catch {
          reject(new Error(`GitHub returned non-JSON response (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("GitHub OAuth request timed out")); });
    req.write(bodyStr);
    req.end();
  });
}

async function requestDeviceCode({ clientId, scope, requestJSONImpl = requestJSON }) {
  if (!clientId) throw new Error("Missing GitHub OAuth client id. Set GITHUB_COPILOT_CLIENT_ID or pass --client-id.");
  const response = await requestJSONImpl(DEVICE_CODE_URL, { client_id: clientId, scope });
  if (response.status >= 400 || !response.data?.device_code) {
    throw new Error(`GitHub device-code request failed (HTTP ${response.status})`);
  }
  return response.data;
}

function nextPollState(responseData, state) {
  if (responseData?.access_token) {
    return { done: true, token: responseData.access_token, interval: state.interval };
  }
  const error = responseData?.error || "";
  if (error === "authorization_pending") return { done: false, interval: state.interval };
  if (error === "slow_down") return { done: false, interval: state.interval + 5 };
  if (error === "expired_token") throw new Error("GitHub device code expired. Start the auth flow again.");
  if (error === "access_denied") throw new Error("GitHub device flow was denied.");
  throw new Error(responseData?.error_description || error || "GitHub OAuth polling failed.");
}

async function pollForAccessToken({ clientId, deviceCode, interval = 5, requestJSONImpl = requestJSON, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let state = { interval: Math.max(1, Number(interval) || 5) };
  for (;;) {
    await sleep(state.interval * 1000);
    const response = await requestJSONImpl(ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (response.status >= 400) throw new Error(`GitHub OAuth polling failed (HTTP ${response.status})`);
    state = nextPollState(response.data, state);
    if (state.done) return state.token;
  }
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

function writeToken(envFile, token) {
  if (!/^gh(?:u|o|s|r|p)_|^github_pat_/i.test(String(token || ""))) {
    throw new Error("GitHub token format was not recognized.");
  }
  const resolved = path.resolve(envFile);
  const current = readFileIfExists(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, upsertEnvValue(current, "COPILOT_GITHUB_TOKEN", token), { mode: 0o600 });
  try { fs.chmodSync(resolved, 0o600); } catch {}
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const device = await requestDeviceCode(options);
  const url = device.verification_uri || device.verification_uri_complete;
  console.log(`Open this GitHub URL and approve the app:\n${url}`);
  if (device.user_code) console.log(`Code: ${device.user_code}`);
  const token = await pollForAccessToken({
    clientId: options.clientId,
    deviceCode: device.device_code,
    interval: device.interval,
  });
  const envPath = writeToken(options.envFile, token);
  console.log(`Updated COPILOT_GITHUB_TOKEN in ${envPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ACCESS_TOKEN_URL,
  DEVICE_CODE_URL,
  VS_CODE_GITHUB_AUTH_CLIENT_ID,
  nextPollState,
  parseArgs,
  pollForAccessToken,
  requestDeviceCode,
  upsertEnvValue,
  writeToken,
};
