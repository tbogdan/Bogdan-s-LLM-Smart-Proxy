"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const claudeAuth = require("../claude-auth");

test("keychainServiceName matches Claude Code managed API key service", () => {
  assert.equal(claudeAuth.keychainServiceName({ env: {} }), "Claude Code");
  assert.equal(
    claudeAuth.keychainServiceName({ env: { CLAUDE_CONFIG_DIR: "/tmp/Project-claude" } }),
    "Claude Code-eac8a763",
  );
});

test("validateClaudeStatus accepts Console login even when authMethod is reported as claude.ai", () => {
  assert.doesNotThrow(() => claudeAuth.validateClaudeStatus({
    loggedIn: true,
    authMethod: "claude.ai",
    apiKeySource: "/login managed key",
  }));
});

test("validateClaudeStatus rejects subscription login unless explicitly allowed", () => {
  assert.throws(
    () => claudeAuth.validateClaudeStatus({ loggedIn: true, authMethod: "claude.ai" }),
    /Anthropic Console/,
  );
  assert.doesNotThrow(() => claudeAuth.validateClaudeStatus({ loggedIn: true, authMethod: "claude.ai" }, { allowClaudeAi: true }));
  assert.doesNotThrow(() => claudeAuth.validateClaudeStatus({ loggedIn: true, authMethod: "console", apiKeySource: "/login managed key" }));
});

test("findApiKeyInJson finds managed Console API keys without knowing exact file shape", () => {
  assert.equal(
    claudeAuth.findApiKeyInJson({
      nested: {
        token: "not-this",
        apiKey: "sk-ant-api03-managed-key",
      },
    }),
    "sk-ant-api03-managed-key",
  );
  assert.equal(claudeAuth.findApiKeyInJson({ token: "oauth-token" }), "");
});

test("writeApiKey upserts ANTHROPIC_API_KEY", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-auth-"));
  const envFile = path.join(dir, ".env.test");
  await fs.writeFile(envFile, "ENABLE_CLAUDE=true\nANTHROPIC_API_KEY=old\n");

  const output = claudeAuth.writeApiKey(envFile, "sk-ant-api03-new");
  const env = await fs.readFile(output, "utf8");

  assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-api03-new$/m);
  assert.doesNotMatch(env, /old/);
});
