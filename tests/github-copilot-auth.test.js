"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const auth = require("../github-copilot-auth");

test("parseArgs defaults to VS Code GitHub auth public client id for Copilot device flow", () => {
  assert.equal(auth.parseArgs([]).clientId, auth.VS_CODE_GITHUB_AUTH_CLIENT_ID);
  assert.deepEqual(
    auth.parseArgs(["--client-id", "abc123", "--env-file", ".env.local", "--scope", "read:user"]),
    { clientId: "abc123", envFile: ".env.local", scope: "read:user", help: false },
  );
  assert.equal(auth.parseArgs([], { GITHUB_COPILOT_CLIENT_ID: "env-client" }).clientId, "env-client");
  assert.equal(auth.parseArgs(["--client-id", "abc123"]).scope, "read:user user:email");
  assert.throws(() => auth.parseArgs(["--client-id"]), /requires a value/);
});

test("nextPollState handles GitHub device-flow pending and slow-down states", () => {
  assert.deepEqual(
    auth.nextPollState({ error: "authorization_pending" }, { interval: 5 }),
    { done: false, interval: 5 },
  );
  assert.deepEqual(
    auth.nextPollState({ error: "slow_down" }, { interval: 5 }),
    { done: false, interval: 10 },
  );
  assert.deepEqual(
    auth.nextPollState({ access_token: "ghu_token" }, { interval: 5 }),
    { done: true, token: "ghu_token", interval: 5 },
  );
  assert.throws(() => auth.nextPollState({ error: "expired_token" }, { interval: 5 }), /expired/);
});

test("writeToken upserts COPILOT_GITHUB_TOKEN without logging the secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-auth-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "ENABLE_COPILOT=true\nCOPILOT_GITHUB_TOKEN=old\n");

  const updated = auth.writeToken(envFile, "ghu_new");
  const text = fs.readFileSync(updated, "utf8");

  assert.equal(updated, envFile);
  assert.match(text, /^ENABLE_COPILOT=true$/m);
  assert.match(text, /^COPILOT_GITHUB_TOKEN=ghu_new$/m);
  assert.doesNotMatch(text, /old/);
});
