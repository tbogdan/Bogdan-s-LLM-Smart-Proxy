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
    claudeAuth.keychainServiceName({ env: { CLAUDE_CONFIG_DIR: "/tmp/Bogdan-claude" } }),
    "Claude Code-28675919",
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

test("readClaudeProfile extracts Claude Code local identity and current project session", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-profile-"));
  const cwd = path.join(dir, "project");
  await fs.mkdir(cwd);
  const configFile = path.join(dir, ".claude.json");
  await fs.writeFile(configFile, JSON.stringify({
    userID: "device-from-claude-json",
    oauthAccount: {
      accountUuid: "account-from-claude-json",
      organizationUuid: "org-from-claude-json",
    },
    projects: {
      [cwd]: {
        lastSessionId: "session-from-project",
        lastHintSessionId: "hint-session-from-project",
      },
    },
  }));

  const profile = claudeAuth.readClaudeProfile({
    configFile,
    cwd,
    execFileSyncImpl: () => "2.2.333 (Claude Code)\n",
  });

  assert.deepEqual(profile, {
    deviceId: "device-from-claude-json",
    accountUuid: "account-from-claude-json",
    organizationUuid: "org-from-claude-json",
    sessionId: "session-from-project",
    version: "2.2.333",
  });
});

test("requestDefaultsFromCapture extracts Claude Code billing build", () => {
  assert.deepEqual(
    claudeAuth.requestDefaultsFromCapture({
      headers: {
        "x-anthropic-billing-header": "cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;",
        "x-stainless-package-version": "0.94.0",
      },
      body: {
        max_tokens: 32000,
        output_config: { effort: "high" },
      },
    }),
    {
      maxTokens: 32000,
      stainlessPackageVersion: "0.94.0",
      billingBuild: "e37",
      outputEffort: "high",
    },
  );
});

test("requestDefaultsFromCapture extracts Claude Code billing build from debug text", () => {
  assert.deepEqual(
    claudeAuth.requestDefaultsFromCapture({
      headers: {
        "x-stainless-package-version": "0.94.0",
      },
      body: {
        max_tokens: 32000,
      },
      debugText: "attribution header x-anthropic-billing-header: cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=00000;",
    }),
    {
      maxTokens: 32000,
      stainlessPackageVersion: "0.94.0",
      billingBuild: "e37",
    },
  );
});

test("requestDefaultsFromCapture extracts Claude Code billing build from system body", () => {
  assert.deepEqual(
    claudeAuth.requestDefaultsFromCapture({
      body: {
        max_tokens: 32000,
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.150.e37; cc_entrypoint=sdk-cli; cch=abcde;" },
          { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        ],
      },
    }),
    {
      maxTokens: 32000,
      billingBuild: "e37",
    },
  );
});

test("writeApiKey upserts Claude Code profile metadata beside the managed key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-auth-profile-"));
  const envFile = path.join(dir, ".env.test");
  await fs.writeFile(envFile, [
    "ENABLE_CLAUDE=true",
    "ANTHROPIC_API_KEY=old",
    "CLAUDE_CODE_DEVICE_ID=old-device",
    "CLAUDE_CODE_MAX_TOKENS=old-max",
    "",
  ].join("\n"));

  const output = claudeAuth.writeApiKey(envFile, "sk-ant-api03-new", {
    deviceId: "device-from-profile",
    accountUuid: "account-from-profile",
    organizationUuid: "org-from-profile",
    sessionId: "session-from-profile",
    version: "2.2.333",
    billingBuild: "e37",
    maxTokens: 32000,
    stainlessPackageVersion: "0.94.0",
    betas: "claude-code-20250219,effort-2025-11-24",
  });
  const env = await fs.readFile(output, "utf8");

  assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-api03-new$/m);
  assert.match(env, /^CLAUDE_CODE_DEVICE_ID=device-from-profile$/m);
  assert.match(env, /^CLAUDE_CODE_ACCOUNT_UUID=account-from-profile$/m);
  assert.match(env, /^CLAUDE_CODE_ORGANIZATION_UUID=org-from-profile$/m);
  assert.match(env, /^CLAUDE_CODE_SESSION_ID=session-from-profile$/m);
  assert.match(env, /^CLAUDE_CODE_VERSION=2\.2\.333$/m);
  assert.match(env, /^CLAUDE_CODE_BILLING_BUILD=e37$/m);
  assert.match(env, /^CLAUDE_CODE_MAX_TOKENS=32000$/m);
  assert.match(env, /^CLAUDE_CODE_STAINLESS_PACKAGE_VERSION=0\.94\.0$/m);
  assert.match(env, /^CLAUDE_CODE_BETAS=claude-code-20250219,effort-2025-11-24$/m);
  assert.doesNotMatch(env, /old-device|old-max/);
});
