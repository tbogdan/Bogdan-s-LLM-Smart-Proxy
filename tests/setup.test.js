const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
test("installer dry-run preserves existing custom env and performs no compose mutation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-"));
  fs.copyFileSync(
    path.join(__dirname, "../setup.sh"),
    path.join(dir, "setup.sh"),
  );
  fs.copyFileSync(
    path.join(__dirname, "../.env.example"),
    path.join(dir, ".env.example"),
  );
  const before =
    "LLM_PROXY_PORT=19444\nMEMORY_BACKEND=custom\nENABLE_CODEX=false\n";
  fs.writeFileSync(path.join(dir, ".env"), before);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    '#!/bin/sh\necho "$*" >> "$DOCKER_CALLS"\nexit 0\n',
    { mode: 0o755 },
  );
  const log = path.join(dir, "calls");
  const r = spawnSync("bash", ["setup.sh", "--dry-run"], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      DOCKER_CALLS: log,
    },
    input: "",
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), before);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  assert.ok(!/compose.*(?:up|down|build|pull)/.test(calls), calls);
  assert.match(r.stdout, /19444/);
});
