#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { registerWindsurfOneTimeToken, startLoopbackAuth } = require("./lib/windsurf-auth");

function usage() {
  return [
    "Usage: node windsurf-auth.js [--token <ott-or-url>] [--env-file <path>] [--register-url <url>] [--login-hint <email>]",
    "",
    "Runs Windsurf host auth, registers the one-time token, and stores WINDSURF_API_KEY in the selected env file.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { envFile: ".env", token: "", registerUrl: "", loginHint: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--token") {
      options.token = argv[++i] || "";
    } else if (arg === "--env-file") {
      options.envFile = argv[++i] || "";
    } else if (arg === "--register-url") {
      options.registerUrl = argv[++i] || "";
    } else if (arg === "--login-hint") {
      options.loginHint = argv[++i] || "";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.envFile) throw new Error("--env-file requires a value");
  return options;
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
  const resolved = path.resolve(envFile);
  const current = readFileIfExists(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, upsertEnvValue(current, "WINDSURF_API_KEY", apiKey));
  return resolved;
}

async function getOneTimeToken(options) {
  if (options.token) return options.token;
  const loopback = startLoopbackAuth({ loginHint: options.loginHint });
  const ready = await loopback.ready;
  console.log(`Open this Windsurf login URL in your host browser:\n${ready.url}`);
  return loopback.waitForToken();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const oneTimeToken = await getOneTimeToken(options);
  const registration = await registerWindsurfOneTimeToken(oneTimeToken, {
    registerUrl: options.registerUrl || undefined,
  });
  const envPath = writeApiKey(options.envFile, registration.apiKey);
  console.log(`Updated WINDSURF_API_KEY in ${envPath}`);
  if (registration.email) console.log(`Registered Windsurf account: ${registration.email}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  quoteEnvValue,
  upsertEnvValue,
  writeApiKey,
};
