"use strict";

// Client setup for the local LLM proxy (`proxy setup <target> on|off|status`).
//
// Points Claude Code / Codex (CLI + agentic IDEs that share their config) at
// this proxy, with timestamped backups before every mutation and exact restore
// on `off`. All paths are injectable via options so tests run on temp dirs.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const DEFAULT_PROXY_URL = "http://127.0.0.1:18900";
const SHELL_BLOCK_START = "# >>> llm-proxy (managed by `proxy setup`; do not edit) >>>";
const SHELL_BLOCK_END = "# <<< llm-proxy <<<";
const STATE_VERSION = 1;
const MAX_BACKUPS_PER_FILE = 5;

const TARGETS = {
  claude: {
    description: "Claude Code CLI + IDE extensions (VS Code, Cursor, Antigravity) via ~/.claude/settings.json",
    restartApps: [{ match: "Antigravity IDE.app", app: "Antigravity IDE" }, { match: "Cursor.app", app: "Cursor" }, { match: "Visual Studio Code.app", app: "Visual Studio Code" }],
  },
  codex: {
    description: "Codex CLI + editors via ~/.codex/config.toml (custom Responses provider)",
    restartApps: [{ match: "ChatGPT.app", app: "ChatGPT" }, { match: "Cursor.app", app: "Cursor" }, { match: "Visual Studio Code.app", app: "Visual Studio Code" }],
  },
};

const CODEX_PROVIDER_ID = "llm-proxy";

function defaultPaths(home = os.homedir()) {
  return {
    home,
    claudeSettings: path.join(home, ".claude", "settings.json"),
    codexConfig: path.join(home, ".codex", "config.toml"),
    shellFile: shellFileFor(home),
    stateDir: path.join(home, ".llm-proxy"),
    stateFile: path.join(home, ".llm-proxy", "setup-state.json"),
  };
}

function shellFileFor(home = os.homedir()) {
  const shell = String(process.env.SHELL || "/bin/zsh");
  if (/bash/.test(shell)) return path.join(home, ".bash_profile");
  return path.join(home, ".zshrc");
}

function normalizeProxyUrl(url) {
  const value = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(value)) {
    throw new Error(`invalid --proxy-url ${JSON.stringify(url)} (expected http(s)://host:port)`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// State + backups
// ---------------------------------------------------------------------------

function readState(paths) {
  try {
    const raw = fs.readFileSync(paths.stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return { version: STATE_VERSION, targets: {}, ...parsed };
  } catch {}
  return { version: STATE_VERSION, targets: {} };
}

function writeState(paths, state) {
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak-proxy-${Date.now()}`;
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  pruneBackups(file);
  return backup;
}

function pruneBackups(file) {
  const dir = path.dirname(file);
  const base = `${path.basename(file)}.bak-proxy-`;
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.startsWith(base)).sort();
  } catch {
    return;
  }
  while (entries.length > MAX_BACKUPS_PER_FILE) {
    const oldest = entries.shift();
    try { fs.unlinkSync(path.join(dir, oldest)); } catch {}
  }
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// ---------------------------------------------------------------------------
// Shell profile block (global env for terminal + child processes)
// ---------------------------------------------------------------------------

function shellBlock(proxyUrl) {
  return [
    SHELL_BLOCK_START,
    `export ANTHROPIC_BASE_URL="${proxyUrl}"`,
    `export ANTHROPIC_API_KEY="proxy"`,
    `export LLM_PROXY_API_KEY="proxy"`,
    SHELL_BLOCK_END,
    "",
  ].join("\n");
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function applyShellBlock(paths, proxyUrl) {
  const current = readText(paths.shellFile) || "";
  const block = shellBlock(proxyUrl);
  if (current.includes(SHELL_BLOCK_START)) {
    const next = current.replace(
      new RegExp(`${escapeRegExp(SHELL_BLOCK_START)}[\\s\\S]*?${escapeRegExp(SHELL_BLOCK_END)}\n?`, ""),
      block,
    );
    if (next !== current) {
      backupFile(paths.shellFile);
      ensureParent(paths.shellFile);
      fs.writeFileSync(paths.shellFile, next);
      return "updated";
    }
    return "unchanged";
  }
  backupFile(paths.shellFile);
  ensureParent(paths.shellFile);
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(paths.shellFile, `${current}${prefix}\n${block}`);
  return "added";
}

function removeShellBlock(paths) {
  const current = readText(paths.shellFile);
  if (!current || !current.includes(SHELL_BLOCK_START)) return "absent";
  backupFile(paths.shellFile);
  let next = current.replace(
    new RegExp(`\n?${escapeRegExp(SHELL_BLOCK_START)}[\\s\\S]*?${escapeRegExp(SHELL_BLOCK_END)}\n?`, ""),
    "\n",
  ).replace(/^\n+/, "");
  next = next.replace(/\n+$/, "\n");
  if (next === "\n") next = "";
  fs.writeFileSync(paths.shellFile, next);
  return "removed";
}

function shellBlockPresent(paths) {
  const current = readText(paths.shellFile);
  return !!current && current.includes(SHELL_BLOCK_START);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Claude: ~/.claude/settings.json env merge
// ---------------------------------------------------------------------------

const CLAUDE_MANAGED_ENV = {
  ANTHROPIC_BASE_URL: (proxyUrl) => proxyUrl,
  ANTHROPIC_API_KEY: () => "proxy",
  // Claude Code disables optimistic ToolSearch behind non-first-party hosts
  // unless explicitly enabled; the proxy forwards tool_reference blocks.
  ENABLE_TOOL_SEARCH: () => "true",
};

function readJsonFile(file) {
  const raw = readText(file);
  if (raw == null) return { exists: false, data: {} };
  try {
    return { exists: true, data: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}); fix it or move it aside first`);
  }
}

function setupClaude(paths, { proxyUrl, model } = {}) {
  const { exists, data } = readJsonFile(paths.claudeSettings);
  const settings = data && typeof data === "object" ? data : {};
  const env = { ...(settings.env || {}) };
  let changed = false;
  for (const [key, valueFor] of Object.entries(CLAUDE_MANAGED_ENV)) {
    const next = valueFor(proxyUrl);
    if (env[key] !== next) { env[key] = next; changed = true; }
  }
  if (model != null) {
    if (env.ANTHROPIC_MODEL !== model) { env.ANTHROPIC_MODEL = model; changed = true; }
  }
  let backup = null;
  if (!exists || changed) {
    backup = backupFile(paths.claudeSettings);
    ensureParent(paths.claudeSettings);
    fs.writeFileSync(paths.claudeSettings, JSON.stringify({ ...settings, env }, null, 2) + "\n", { mode: 0o600 });
  }
  return { changed, backup, created: !exists };
}

function teardownClaude(paths, { proxyUrl } = {}) {
  if (fs.existsSync(paths.claudeSettings)) backupFile(paths.claudeSettings);
  const { exists, data } = readJsonFile(paths.claudeSettings);
  if (!exists) return { restored: false, removedKeys: [] };
  const settings = data && typeof data === "object" ? data : {};
  const env = { ...(settings.env || {}) };
  const removedKeys = [];
  const expectations = { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_API_KEY: "proxy", ENABLE_TOOL_SEARCH: "true" };
  for (const [key, expected] of Object.entries(expectations)) {
    if (env[key] === undefined) continue;
    if (expected == null || env[key] === expected) { delete env[key]; removedKeys.push(key); }
  }
  if (Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;
  ensureParent(paths.claudeSettings);
  fs.writeFileSync(paths.claudeSettings, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return { restored: false, removedKeys };
}

function claudeStatus(paths) {
  try {
    const { exists, data } = readJsonFile(paths.claudeSettings);
    const env = (data && data.env) || {};
    return {
      configured: exists,
      baseUrl: env.ANTHROPIC_BASE_URL || null,
      apiKey: env.ANTHROPIC_API_KEY ? `${String(env.ANTHROPIC_API_KEY).slice(0, 2)}…` : null,
      model: env.ANTHROPIC_MODEL || data.model || null,
      managed: env.ANTHROPIC_BASE_URL != null,
    };
  } catch (error) {
    return { configured: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/config.toml surgical edit (no TOML dependency)
// ---------------------------------------------------------------------------

const CODEX_MANAGED_TABLE = `[model_providers.${CODEX_PROVIDER_ID}]`;

function codexBlock(proxyUrl) {
  return [
    "# >>> llm-proxy (managed by `proxy setup`) >>>",
    CODEX_MANAGED_TABLE,
    'name = "LLM Proxy"',
    `base_url = "${proxyUrl}/v1"`,
    'env_key = "LLM_PROXY_API_KEY"',
    'wire_api = "responses"',
    "# <<< llm-proxy <<<",
  ];
}

function isTableHeader(line) {
  return /^\s*\[[^\]]+\]\s*(#.*)?$/.test(line);
}

function writeTomlFile(file, lines) {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === "") next.pop();
  ensureParent(file);
  fs.writeFileSync(file, `${next.join("\n")}\n`, { mode: 0o600 });
}

function splitTomlTopLevel(lines) {
  const firstTable = lines.findIndex(isTableHeader);
  return firstTable === -1 ? { top: lines, rest: [] } : { top: lines.slice(0, firstTable), rest: lines.slice(firstTable) };
}

function findManagedBlock(lines) {
  const start = lines.findIndex((line) => line.includes(">>> llm-proxy (managed by `proxy setup`) >>>"));
  if (start !== -1) {
    let end = lines.findIndex((line, i) => i > start && line.includes("<<< llm-proxy <<<"));
    end = end === -1 ? lines.length - 1 : end;
    return { start, end, marked: true };
  }
  const header = lines.findIndex((line) => line.trim() === CODEX_MANAGED_TABLE);
  if (header === -1) return null;
  let end = lines.length - 1;
  for (let i = header + 1; i < lines.length; i += 1) {
    if (isTableHeader(lines[i])) { end = i - 1; break; }
  }
  return { start: header, end, marked: false };
}

function tomlTopValue(lines, key) {
  const { top } = splitTomlTopLevel(lines);
  const match = top.find((line) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line));
  if (!match) return { present: false, value: null };
  const value = match.match(/=\s*(.+?)\s*(#.*)?$/);
  return { present: true, value: (value ? value[1] : "").trim() };
}

function setTomlTopValue(lines, key, value) {
  const { top, rest } = splitTomlTopLevel(lines);
  const line = `${key} = ${JSON.stringify(value)}`;
  const index = top.findIndex((l) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(l));
  const nextTop = [...top];
  if (index === -1) {
    let insertAt = nextTop.length;
    while (insertAt > 0 && nextTop[insertAt - 1].trim() === "") insertAt -= 1;
    nextTop.splice(insertAt, 0, line);
  } else {
    nextTop[index] = line;
  }
  return [...nextTop, ...rest];
}

function removeTomlTopValue(lines, key, onlyIfValue = undefined) {
  const { top, rest } = splitTomlTopLevel(lines);
  const index = top.findIndex((l) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(l));
  if (index === -1) return { lines, removed: false };
  if (onlyIfValue !== undefined) {
    const current = tomlTopValue(lines, key);
    if (!current.present || current.value !== JSON.stringify(onlyIfValue)) return { lines, removed: false };
    const result = [...top.slice(0, index), ...top.slice(index + 1), ...rest];
    return { lines: result, removed: true };
  }
  return { lines, removed: false };
}

function setupCodex(paths, { proxyUrl, model = "codex/gpt-5.6-luna" } = {}) {
  const raw = readText(paths.codexConfig);
  const lines = raw == null ? [] : raw.replace(/\n$/, "").split("\n");
  const previousTop = {
    model: tomlTopValue(lines, "model"),
    model_provider: tomlTopValue(lines, "model_provider"),
  };
  let previousBlock = null;
  const existing = findManagedBlock(lines);
  if (existing) previousBlock = lines.slice(existing.start, existing.end + 1).join("\n");

  let next = setTomlTopValue(lines, "model", model);
  next = setTomlTopValue(next, "model_provider", CODEX_PROVIDER_ID);
  const block = codexBlock(proxyUrl);
  const at = findManagedBlock(next);
  if (at) next = [...next.slice(0, at.start), ...block, ...next.slice(at.end + 1)];
  else {
    while (next.length > 0 && next[next.length - 1].trim() === "") next.pop();
    next = [...next, "", ...block];
  }

  const changed = next.join("\n") !== lines.join("\n");
  let backup = null;
  if (raw == null || changed) {
    backup = backupFile(paths.codexConfig);
    writeTomlFile(paths.codexConfig, next);
  }
  return { changed, backup, created: raw == null, previousTop, previousBlock };
}

function teardownCodex(paths, { state } = {}) {
  const raw = readText(paths.codexConfig);
  if (raw == null) return { restored: false };
  if (fs.existsSync(paths.codexConfig)) backupFile(paths.codexConfig);
  let lines = raw.replace(/\n$/, "").split("\n");

  const at = findManagedBlock(lines);
  if (at) {
    if (state && state.previousBlock != null) {
      lines = [...lines.slice(0, at.start), ...state.previousBlock.split("\n"), ...lines.slice(at.end + 1)];
    } else {
      lines = [...lines.slice(0, at.start), ...lines.slice(at.end + 1)];
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("");
  }

  const previousTop = (state && state.previousTop) || {};
  for (const key of ["model_provider", "model"]) {
    const prev = previousTop[key];
    if (prev && prev.present) {
      lines = setTomlTopValue(lines, key, JSON.parse(prev.value));
    } else if (prev && !prev.present) {
      const expected = key === "model_provider" ? CODEX_PROVIDER_ID : state.previousModel;
      const result = removeTomlTopValue(lines, key, expected);
      lines = result.lines;
    }
  }

  ensureParent(paths.codexConfig);
  writeTomlFile(paths.codexConfig, lines);
  return { restored: true };
}

function codexStatus(paths) {
  const raw = readText(paths.codexConfig);
  if (raw == null) return { configured: false };
  const lines = raw.replace(/\n$/, "").split("\n");
  const at = findManagedBlock(lines);
  return {
    configured: true,
    model: tomlTopValue(lines, "model").value,
    modelProvider: tomlTopValue(lines, "model_provider").value,
    managed: at != null,
  };
}

// ---------------------------------------------------------------------------
// Proxy reachability + app restart (darwin)
// ---------------------------------------------------------------------------

async function proxyReachable(proxyUrl, { fetchFn = fetch, timeoutMs = 5000, retries = 2 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const controller = AbortSignal.timeout(timeoutMs);
      const res = await fetchFn(`${proxyUrl}/health`, { signal: controller });
      if (res.ok) return true;
    } catch {
      // fall through to retry
    }
    if (attempt >= retries) return false;
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

function runningAppCommands() {
  try {
    return execSync("ps -ax -o command=", { encoding: "utf8" });
  } catch {
    return "";
  }
}

function awaitGone(ps, match, exec, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      if (!ps().includes(match)) return true;
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    try {
      exec("sleep", ["0.5"]);
    } catch {
      return false;
    }
  }
}

function restartApps(names, { exec = execFileSync, ps = runningAppCommands } = {}) {
  const haystack = ps();
  const restarted = [];
  const skipped = [];
  for (const { match, app } of names) {
    if (!haystack.includes(match)) { skipped.push(app); continue; }
    try {
      exec("osascript", ["-e", `tell application "${app}" to quit`]);
      if (awaitGone(ps, match, exec, 15000)) {
        exec("open", ["-a", app]);
        restarted.push(app);
      } else if (awaitGone(ps, match, exec, 15000)) {
        // Slow quitters (large workspaces): one extra grace window before giving up.
        exec("open", ["-a", app]);
        restarted.push(`${app} (slow quit)`);
      } else {
        skipped.push(`${app} (quit timed out — quit it manually with Cmd+Q, then reopen)`);
      }
    } catch (error) {
      skipped.push(`${app} (${error.message.split("\n")[0]})`);
    }
  }
  return { restarted, skipped };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function targetState(paths, target) {
  const state = readState(paths);
  return state.targets[target] || { on: false };
}

function setupTarget(target, paths, opts) {
  const { proxyUrl, model } = opts;
  if (target === "claude") {
    const result = setupClaude(paths, { proxyUrl, model });
    const shell = applyShellBlock(paths, proxyUrl);
    return { ...result, shell, files: [paths.claudeSettings, paths.shellFile] };
  }
  if (target === "codex") {
    const result = setupCodex(paths, { proxyUrl, model: model || "codex/gpt-5.6-luna" });
    const shell = applyShellBlock(paths, proxyUrl);
    return { ...result, shell, files: [paths.codexConfig, paths.shellFile] };
  }
  throw new Error(`unknown target ${JSON.stringify(target)} (expected claude|codex)`);
}

function teardownTarget(target, paths, opts) {
  const state = readState(paths);
  const tracked = state.targets[target];
  const { proxyUrl } = opts;
  if (target === "claude") {
    if (tracked && tracked.backup && fs.existsSync(tracked.backup)) {
      backupFile(paths.claudeSettings);
      fs.copyFileSync(tracked.backup, paths.claudeSettings);
      fs.chmodSync(paths.claudeSettings, 0o600);
      try { fs.unlinkSync(tracked.backup); } catch {}
      const shell = removeShellBlock(paths);
      return { restored: true, shell };
    }
    const result = teardownClaude(paths, { proxyUrl });
    const shell = removeShellBlock(paths);
    return { ...result, shell };
  }
  if (target === "codex") {
    if (tracked && tracked.backup && fs.existsSync(tracked.backup)) {
      backupFile(paths.codexConfig);
      fs.copyFileSync(tracked.backup, paths.codexConfig);
      fs.chmodSync(paths.codexConfig, 0o600);
      try { fs.unlinkSync(tracked.backup); } catch {}
      const shell = removeShellBlock(paths);
      return { restored: true, shell };
    }
    const result = teardownCodex(paths, { state: tracked });
    const shell = removeShellBlock(paths);
    return { ...result, shell };
  }
  throw new Error(`unknown target ${JSON.stringify(target)} (expected claude|codex)`);
}

function recordTarget(paths, target, entry) {
  const state = readState(paths);
  if (entry == null) delete state.targets[target];
  else state.targets[target] = entry;
  writeState(paths, state);
}

module.exports = {
  DEFAULT_PROXY_URL,
  TARGETS,
  CODEX_PROVIDER_ID,
  defaultPaths,
  normalizeProxyUrl,
  readState,
  applyShellBlock,
  removeShellBlock,
  shellBlockPresent,
  setupClaude,
  teardownClaude,
  claudeStatus,
  setupCodex,
  teardownCodex,
  codexStatus,
  proxyReachable,
  restartApps,
  setupTarget,
  teardownTarget,
  recordTarget,
  targetState,
};
