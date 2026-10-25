"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const setup = require("../lib/proxy-setup");

function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-setup-"));
  return { home, paths: setup.defaultPaths(home) };
}

const CODEX_FIXTURE = [
  "# user comment",
  'model = "gpt-6-luna"',
  "",
  "[features]",
  "multi_agent = true",
  "",
  "[model_providers.custom]",
  'name = "Keep"',
  'base_url = "https://example.com/v1"',
  "",
].join("\n");

test("claude on merges env, keeps other keys, and off restores the backup", () => {
  const { paths } = tempPaths();
  fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
  fs.writeFileSync(paths.claudeSettings, JSON.stringify({ env: { KEEP: "1" }, model: "opus", permissions: { a: 1 } }, null, 2));
  fs.writeFileSync(paths.shellFile, 'export PATH="/x"\n');

  const first = setup.setupTarget("claude", paths, { proxyUrl: "http://127.0.0.1:18900", model: "claude/x" });
  assert.equal(first.changed, true);
  assert.ok(first.backup);
  const second = setup.setupTarget("claude", paths, { proxyUrl: "http://127.0.0.1:18900", model: "claude/x" });
  assert.equal(second.changed, false);

  const saved = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
  assert.equal(saved.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18900");
  assert.equal(saved.env.ANTHROPIC_API_KEY, "proxy");
  assert.equal(saved.env.ANTHROPIC_MODEL, "claude/x");
  assert.equal(saved.env.KEEP, "1");
  assert.equal(saved.model, "opus");

  const shell = fs.readFileSync(paths.shellFile, "utf8");
  assert.match(shell, /ANTHROPIC_BASE_URL/);
  assert.match(shell, /LLM_PROXY_API_KEY/);
  assert.match(shell, /export PATH="\/x"/);

  const tracked = { on: true, backup: first.backup };
  setup.recordTarget(paths, "claude", tracked);
  const off = setup.teardownTarget("claude", paths, { proxyUrl: "http://127.0.0.1:18900" });
  assert.equal(off.restored, true);
  const restored = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
  assert.deepEqual(restored, { env: { KEEP: "1" }, model: "opus", permissions: { a: 1 } });
  assert.equal(setup.shellBlockPresent(paths), false);
  assert.match(fs.readFileSync(paths.shellFile, "utf8"), /export PATH="\/x"/);
});

test("claude off without backup removes only keys we set", () => {
  const { paths } = tempPaths();
  fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
  fs.writeFileSync(paths.claudeSettings, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18900", ANTHROPIC_API_KEY: "proxy", ANTHROPIC_MODEL: "mine", OTHER: "keep" },
  }));
  const off = setup.teardownTarget("claude", paths, { proxyUrl: "http://127.0.0.1:18900" });
  assert.deepEqual(off.removedKeys.sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  const saved = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
  assert.deepEqual(saved.env, { ANTHROPIC_MODEL: "mine", OTHER: "keep" });
});

test("claude off keeps a foreign base url", () => {
  const { paths } = tempPaths();
  fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
  fs.writeFileSync(paths.claudeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example", ANTHROPIC_API_KEY: "proxy" } }));
  const off = setup.teardownTarget("claude", paths, { proxyUrl: "http://127.0.0.1:18900" });
  assert.deepEqual(off.removedKeys, ["ANTHROPIC_API_KEY"]);
  const saved = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
  assert.equal(saved.env.ANTHROPIC_BASE_URL, "https://other.example");
});

test("codex on/off roundtrip preserves comments and other providers", () => {
  const { paths } = tempPaths();
  fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
  fs.writeFileSync(paths.codexConfig, CODEX_FIXTURE);

  const first = setup.setupTarget("codex", paths, { proxyUrl: "http://127.0.0.1:18900" });
  assert.equal(first.changed, true);
  assert.ok(first.backup);
  const second = setup.setupTarget("codex", paths, { proxyUrl: "http://127.0.0.1:18900" });
  assert.equal(second.changed, false);

  const saved = fs.readFileSync(paths.codexConfig, "utf8");
  assert.match(saved, /# user comment/);
  assert.match(saved, /model = "codex\/gpt-5\.6-luna"/);
  assert.match(saved, /model_provider = "llm-proxy"/);
  assert.match(saved, /\[model_providers\.custom\]/);
  assert.match(saved, /base_url = "http:\/\/127\.0\.0\.1:18900\/v1"/);
  assert.match(saved, /wire_api = "responses"/);
  assert.match(saved, /env_key = "LLM_PROXY_API_KEY"/);

  setup.recordTarget(paths, "codex", { on: true, backup: first.backup });
  const off = setup.teardownTarget("codex", paths, {});
  assert.equal(off.restored, true);
  assert.equal(fs.readFileSync(paths.codexConfig, "utf8"), CODEX_FIXTURE);
});

test("codex on replaces a pre-existing llm-proxy block and restores it on off", () => {
  const { paths } = tempPaths();
  fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
  const before = `${CODEX_FIXTURE}\n[model_providers.llm-proxy]\nname = "Old"\nbase_url = "https://old.example/v1"\n`;
  fs.writeFileSync(paths.codexConfig, before);

  const on = setup.setupCodex(paths, { proxyUrl: "http://127.0.0.1:18900" });
  assert.match(on.previousBlock, /https:\/\/old\.example/);
  const saved = fs.readFileSync(paths.codexConfig, "utf8");
  assert.doesNotMatch(saved, /https:\/\/old\.example/);

  setup.recordTarget(paths, "codex", { on: true, backup: on.backup, previousTop: on.previousTop, previousBlock: on.previousBlock, previousModel: "codex/gpt-5.6-luna" });
  const off = setup.teardownCodex(paths, { state: setup.targetState(paths, "codex") });
  assert.equal(off.restored, true);
  assert.equal(fs.readFileSync(paths.codexConfig, "utf8"), before);
});

test("codex surgical off restores previous top-level values", () => {
  const { paths } = tempPaths();
  fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
  fs.writeFileSync(paths.codexConfig, CODEX_FIXTURE);
  const on = setup.setupCodex(paths, { proxyUrl: "http://127.0.0.1:18900", model: "codex/gpt-6-luna" });
  assert.deepEqual(on.previousTop.model, { present: true, value: '"gpt-6-luna"' });
  assert.deepEqual(on.previousTop.model_provider, { present: false, value: null });

  const off = setup.teardownCodex(paths, {
    state: { previousTop: on.previousTop, previousBlock: on.previousBlock, previousModel: "codex/gpt-6-luna" },
  });
  assert.equal(off.restored, true);
  assert.equal(fs.readFileSync(paths.codexConfig, "utf8"), CODEX_FIXTURE);
});

test("shell block is idempotent and removable", () => {
  const { paths } = tempPaths();
  assert.equal(setup.applyShellBlock(paths, "http://127.0.0.1:18900"), "added");
  assert.equal(setup.applyShellBlock(paths, "http://127.0.0.1:18900"), "unchanged");
  assert.equal(setup.applyShellBlock(paths, "http://127.0.0.1:18901"), "updated");
  assert.match(fs.readFileSync(paths.shellFile, "utf8"), /18901/);
  assert.equal(setup.removeShellBlock(paths), "removed");
  assert.equal(setup.removeShellBlock(paths), "absent");
  assert.equal(setup.shellBlockPresent(paths), false);
});

test("shell block roundtrip preserves exact bytes", () => {
  const { paths } = tempPaths();
  const original = 'export PATH="/x"\n';
  fs.writeFileSync(paths.shellFile, original);
  setup.applyShellBlock(paths, "http://127.0.0.1:18900");
  setup.removeShellBlock(paths);
  assert.equal(fs.readFileSync(paths.shellFile, "utf8"), original);
});

test("proxy url validation rejects non-http values", () => {
  assert.throws(() => setup.normalizeProxyUrl("notaurl"), /invalid --proxy-url/);
  assert.throws(() => setup.normalizeProxyUrl("ftp://x"), /invalid --proxy-url/);
  assert.equal(setup.normalizeProxyUrl("http://127.0.0.1:18900/"), "http://127.0.0.1:18900");
});

test("status reporters read managed state", () => {
  const { paths } = tempPaths();
  assert.equal(setup.claudeStatus(paths).configured, false);
  assert.equal(setup.codexStatus(paths).configured, false);
  setup.setupTarget("claude", paths, { proxyUrl: "http://127.0.0.1:18900" });
  const st = setup.claudeStatus(paths);
  assert.equal(st.configured, true);
  assert.equal(st.baseUrl, "http://127.0.0.1:18900");
  assert.equal(st.managed, true);
  setup.setupTarget("codex", paths, { proxyUrl: "http://127.0.0.1:18900" });
  const cx = setup.codexStatus(paths);
  assert.equal(cx.modelProvider, '"llm-proxy"');
  assert.equal(cx.managed, true);
});

test("proxyReachable retries transient failures", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw new Error("blip");
    return { ok: true };
  };
  assert.equal(await setup.proxyReachable("http://127.0.0.1:18900", { fetchFn: flaky, timeoutMs: 50 }), true);
  assert.equal(calls, 3);
  assert.equal(await setup.proxyReachable("http://127.0.0.1:18900", { fetchFn: async () => { throw new Error("down"); }, timeoutMs: 50 }), false);
});

test("restartApps restarts only running apps via injected hooks", () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...(args || [])]); };
  let quit = false;
  const ps = () => (quit
    ? "5678 /Applications/Cursor.app/Contents/MacOS/Cursor\n"
    : "1234 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n5678 /Applications/Cursor.app/Contents/MacOS/Cursor\n");
  const execQuit = (cmd, args) => {
    calls.push([cmd, ...(args || [])]);
    if (cmd === "osascript") quit = true;
    if (cmd === "sleep") { /* instant in tests */ }
  };
  const out = setup.restartApps(
    [{ match: "ChatGPT.app", app: "ChatGPT" }, { match: "Nope.app", app: "Nope" }],
    { exec: execQuit, ps },
  );
  assert.deepEqual(out.restarted, ["ChatGPT"]);
  assert.deepEqual(out.skipped, ["Nope"]);
  assert.ok(calls.some(([c]) => c === "osascript"));
  assert.ok(calls.some(([c]) => c === "open"));
});


test("proxy URL rejects shell injection and non-origin inputs before writing files", () => {
  const invalid = ['http://$(id)', 'http://`id`', 'http://host";id', 'http://host\nname', 'http://user:pass@host', 'http://host?x=1', 'http://host#x', 'http://host/path', 'http://host:99999', 'http://bad_host', 'http://host\\name'];
  for (const proxyUrl of invalid) {
    assert.throws(() => setup.normalizeProxyUrl(proxyUrl), /invalid --proxy-url/, proxyUrl);
    const { home, paths } = tempPaths();
    try {
      assert.throws(() => setup.setupTarget("codex", paths, { proxyUrl }), /invalid --proxy-url/);
      assert.deepEqual(fs.readdirSync(home), []);
      assert.throws(() => setup.applyShellBlock(paths, proxyUrl), /invalid --proxy-url/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test("valid proxy origins survive generated shell evaluation literally", () => {
  const { execFileSync } = require("node:child_process");
  for (const proxyUrl of ['http://localhost:18900', 'https://proxy.example:8443', 'http://[::1]:18900']) {
    const { home, paths } = tempPaths();
    try {
      setup.applyShellBlock(paths, proxyUrl);
      const value = execFileSync('/bin/sh', ['-c', '. "$1"; printf "%s" "$ANTHROPIC_BASE_URL"', 'fixture', paths.shellFile], { encoding: 'utf8' });
      assert.equal(value, proxyUrl);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});
