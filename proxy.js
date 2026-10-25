#!/usr/bin/env node
"use strict";

// `proxy setup` — point Claude Code / Codex (CLI + agentic IDEs) at the local
// LLM proxy, with backups and exact restore.
//
//   proxy setup claude on [--model claude/claude-sonnet-4-6] [--no-restart]
//   proxy setup claude off [--no-restart]
//   proxy setup codex on [--model codex/gpt-5.6-luna] [--no-restart]
//   proxy setup codex off [--no-restart]
//   proxy setup all on|off
//   proxy setup claude status | proxy status [--json]
//
// Global flags: --proxy-url http://127.0.0.1:18900 --json --force --restart/--no-restart

const setup = require("./lib/proxy-setup");

function usage() {
  return [
    "Usage: node proxy.js setup <claude|codex|all> <on|off|status> [options]",
    "       node proxy.js status [--json]",
    "",
    "Targets:",
    "  claude   Claude Code CLI + IDE extensions via ~/.claude/settings.json",
    "           (+ global ANTHROPIC_* env in your shell profile)",
    "  codex    Codex CLI + editors via ~/.codex/config.toml",
    "           (+ global LLM_PROXY_API_KEY in your shell profile)",
    "",
    "Options:",
    "  --proxy-url <url>   proxy base URL (default http://127.0.0.1:18900)",
    "  --model <id>        pin client model (claude: ANTHROPIC_MODEL, codex: model)",
    "  --restart           restart running related GUI apps (default on)",
    "  --no-restart        skip GUI app restarts",
    "  --json              machine-readable output",
    "  --force             (reserved) proceed despite warnings",
    "",
    "Every mutation writes a timestamped .bak-proxy-* backup first.",
    "Claude Code, Codex CLI and their IDE extensions pick the new config up",
    "on next invocation; GUI apps listed above are restarted to reload.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { command: null, target: null, action: null, proxyUrl: setup.DEFAULT_PROXY_URL, model: null, restart: true, json: false, force: false };
  const rest = [...argv];
  if (rest[0] === "status") { args.command = "status"; return args; }
  if (rest[0] !== "setup") return args;
  args.command = "setup";
  args.target = rest[1] || null;
  args.action = rest[2] || null;
  for (let i = 3; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--proxy-url") args.proxyUrl = rest[++i];
    else if (token === "--model") args.model = rest[++i];
    else if (token === "--restart") args.restart = true;
    else if (token === "--no-restart") args.restart = false;
    else if (token === "--json") args.json = true;
    else if (token === "--force") args.force = true;
    else if (token === "--help" || token === "-h") args.action = "help";
    else throw new Error(`unknown argument ${JSON.stringify(token)}`);
  }
  return args;
}

function emit(args, payload) {
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else for (const line of payload.lines) console.log(line);
}

async function describeTarget(paths, target, reachable) {
  const tracked = setup.targetState(paths, target);
  const detail = target === "claude" ? setup.claudeStatus(paths) : setup.codexStatus(paths);
  const managed = target === "claude"
    ? !!detail.managed
    : !!detail.managed;
  return {
    target,
    on: !!tracked.on,
    reachable,
    detail,
    shellBlock: setup.shellBlockPresent(paths),
    managed,
    lastChange: tracked.at || null,
  };
}

async function cmdStatus(args, paths) {
  const reachable = await setup.proxyReachable(args.proxyUrl);
  const targets = ["claude", "codex"];
  const described = [];
  for (const target of targets) described.push(await describeTarget(paths, target, reachable));
  const lines = [
    `proxy: ${args.proxyUrl} reachable=${reachable ? "yes" : "NO (start it with ./setup.sh --memory)"}`,
    `shell block (${paths.shellFile}): ${setup.shellBlockPresent(paths) ? "present" : "absent"} (restart the shell or run: source ${paths.shellFile})`,
  ];
  for (const d of described) {
    const det = d.detail;
    const what = d.target === "claude"
      ? `base=${det.baseUrl || "-"} key=${det.apiKey || "-"} model=${det.model || "(client default)"}`
      : `provider=${det.modelProvider || "-"} model=${det.model || "-"}`;
    lines.push(`${d.target}: ${d.on ? "ON" : "off"} (${what})${d.on && !d.managed ? " [files changed externally]" : ""}`);
  }
  emit(args, { lines, proxyUrl: args.proxyUrl, reachable, targets: described });
}

async function cmdSetup(args, paths) {
  const { target, action } = args;
  const wanted = target === "all" ? ["claude", "codex"] : [target];
  for (const t of wanted) {
    if (!setup.TARGETS[t]) throw new Error(`unknown target ${JSON.stringify(target)} (expected claude|codex|all)`);
  }
  if (!["on", "off", "status"].includes(action)) throw new Error(`unknown action ${JSON.stringify(action)} (expected on|off|status)`);
  const proxyUrl = setup.normalizeProxyUrl(args.proxyUrl);
  const reachable = await setup.proxyReachable(proxyUrl);
  if (action === "status") {
    const lines = [`proxy: ${proxyUrl} reachable=${reachable ? "yes" : "NO"}`];
    for (const t of wanted) {
      const d = await describeTarget(paths, t, reachable);
      lines.push(`${t}: ${d.on ? "ON" : "off"} ${JSON.stringify(d.detail)}`);
    }
    emit(args, { lines, targets: wanted });
    return;
  }

  if (!reachable) {
    console.error(`WARN: proxy not reachable at ${proxyUrl}/health — writing client config anyway (start it with ./setup.sh --memory).`);
  }

  const results = [];
  for (const t of wanted) {
    if (action === "on") {
      const result = setup.setupTarget(t, paths, { proxyUrl, model: args.model });
      setup.recordTarget(paths, t, {
        on: true,
        at: new Date().toISOString(),
        proxyUrl,
        model: args.model || (t === "codex" ? "codex/gpt-5.6-luna" : null),
        backup: result.backup,
        previousTop: result.previousTop || null,
        previousBlock: result.previousBlock || null,
        previousModel: args.model || (t === "codex" ? "codex/gpt-5.6-luna" : null),
      });
      results.push({ target: t, action: "on", changed: result.changed, created: !!result.created, backup: result.backup, shell: result.shell });
    } else {
      const before = setup.targetState(paths, t);
      const result = setup.teardownTarget(t, paths, { proxyUrl: before.proxyUrl || proxyUrl });
      setup.recordTarget(paths, t, null);
      results.push({ target: t, action: "off", ...result });
    }
  }

  let restarted = [];
  let skippedRestart = [];
  if (args.restart && process.platform === "darwin") {
    const apps = [];
    for (const t of wanted) {
      if (action === "off" && t === "claude") continue;
      for (const app of setup.TARGETS[t].restartApps) {
        if (!apps.some((a) => a.app === app.app)) apps.push(app);
      }
    }
    if (apps.length > 0) {
      const out = setup.restartApps(apps);
      restarted = out.restarted;
      skippedRestart = out.skipped;
    }
  }

  const lines = [];
  for (const r of results) {
    if (r.action === "on") {
      lines.push(`${r.target}: ON (proxy ${proxyUrl})${r.changed ? "" : " (already configured)"}`);
      if (r.backup) lines.push(`  backup: ${r.backup}`);
      lines.push(`  shell: ${r.shell}`);
    } else {
      lines.push(`${r.target}: OFF${r.restored ? " (restored from backup)" : ` (removed keys: ${(r.removedKeys || []).join(", ") || "none"})`}`);
      lines.push(`  shell: ${r.shell}`);
    }
  }
  if (restarted.length > 0) lines.push(`restarted apps: ${restarted.join(", ")}`);
  const idle = skippedRestart.filter((s) => !s.includes("("));
  if (idle.length > 0) lines.push(`apps not running (no restart needed): ${idle.join(", ")}`);
  const failed = skippedRestart.filter((s) => s.includes("("));
  for (const f of failed) lines.push(`restart skipped: ${f}`);
  if (args.restart && process.platform !== "darwin") lines.push("restart: only supported on macOS; restart apps manually");
  lines.push("note: already-open terminal tabs need `source ~/.zshrc` (or a new tab) for the new env");
  emit(args, { lines, results, restarted, skippedRestart, reachable });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = setup.defaultPaths();
  if (!args.command) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    if (args.command === "status") await cmdStatus(args, paths);
    else await cmdSetup(args, paths);
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ error: error.message }));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
