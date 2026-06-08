"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const requiredFiles = [
  "README.md",
  "INSTRUCTIONS.md",
  "package.json",
  "lib/transforms.js",
  ".env.example",
  "docker-compose.yml",
  "setup.sh",
];

const exactBrandingFiles = [
  "README.md",
  "INSTRUCTIONS.md",
  "lib/transforms.js",
  "setup.sh",
];

const publicSetupFiles = [
  "README.md",
  "INSTRUCTIONS.md",
  ".env.example",
  "docker-compose.yml",
  "setup.sh",
];

const publicDocsFiles = [
  "README.md",
  "INSTRUCTIONS.md",
];

const removedFlowPatterns = [
  /\bDockerfile\.kiro\b/,
  /\bkiro-auth(?:\.js)?\b/,
  /\bENABLE_KIRO\b/,
  /\bGROQ_API_KEY\b/,
  /\bSAMBANOVA_API_KEY\b/,
  /\bOPENROUTER_API_KEY\b/,
  /\bMODELSCOPE_API_KEY\b/,
  /\bCLINE_API_KEY\b/,
  /\bKIRO_API_KEY\b/,
];

const removedProviderDocPatterns = [
  /\bGroq\b/,
  /\bSambaNova\b/,
  /\bKiro\b/,
  /\bOpenRouter\b/,
  /\bModelScope\b/,
  /\bCline Provider\b/,
];

const neutralRemovalPattern = /\b(?:removed|unsupported|no longer|deprecated|legacy|previously|formerly)\b/i;
const providerSetupContextPattern = /(?:^\s*[-*]\s+|^\s*\|.*\||\b(?:auth|authenticate|authentication|setup|enable|provider|providers|model|models|gateway|compose|docker|profile|env|api key|token|free key|supported|runtime|adapter|get .*key|console|dashboard)\b|[A-Z0-9_]+_(?:API_KEY|TOKEN)|ENABLE_[A-Z0-9_]+)/i;

const staleProviderSetupLines = (text) => text
  .split("\n")
  .filter((line) => removedProviderDocPatterns.some((pattern) => pattern.test(line)))
  .filter((line) => providerSetupContextPattern.test(line))
  .filter((line) => !neutralRemovalPattern.test(line));

test("stale provider line classifier allows neutral migration prose", () => {
  const lines = staleProviderSetupLines([
    "Groq was removed from this proxy.",
    "OpenRouter is no longer supported.",
    "ModelScope used to be available, but is unsupported now.",
  ].join("\n"));

  assert.deepEqual(lines, []);
});

test("stale provider line classifier rejects old setup/listing contexts", () => {
  const lines = staleProviderSetupLines([
    "| Groq | https://console.groq.com |",
    "- OpenRouter API key: set OPENROUTER_API_KEY",
    "Enable ModelScope provider in .env.",
    "Run Kiro auth before Docker Compose.",
  ].join("\n"));

  assert.deepEqual(lines, [
    "| Groq | https://console.groq.com |",
    "- OpenRouter API key: set OPENROUTER_API_KEY",
    "Enable ModelScope provider in .env.",
    "Run Kiro auth before Docker Compose.",
  ]);
});

test("public docs and setup use current Project branding", () => {
  const contents = Object.fromEntries(requiredFiles.map((file) => [file, read(file)]));

  for (const file of exactBrandingFiles) {
    assert.match(contents[file], /Project LLM Smart Proxy/, `${file} should carry current prose branding`);
  }

  const packageJson = JSON.parse(contents["package.json"]);
  assert.equal(packageJson.name, "Project-llm-smart-proxy");
});

test("public setup files do not include removed command or config flows", () => {
  const contents = Object.fromEntries(publicSetupFiles.map((file) => [file, read(file)]));

  for (const [file, text] of Object.entries(contents)) {
    for (const pattern of removedFlowPatterns) {
      assert.doesNotMatch(text, pattern, `${file} contains removed command or config flow: ${pattern}`);
    }
  }

  const packageJson = JSON.parse(read("package.json"));
  for (const scriptName of Object.keys(packageJson.scripts || {})) {
    assert.doesNotMatch(scriptName, /(?:kiro|groq|sambanova|openrouter|modelscope|cline)/i);
  }
});

test("public docs do not market or set up removed provider families", () => {
  const contents = Object.fromEntries(publicDocsFiles.map((file) => [file, read(file)]));

  for (const [file, text] of Object.entries(contents)) {
    for (const line of staleProviderSetupLines(text)) {
      assert.fail(`${file} contains removed provider setup/listing docs: ${line}`);
    }
  }
});

test("README documents supported provider families and smart groups", () => {
  const readme = read("README.md");

  for (const family of ["Windsurf", "Claude", "Codex", "Copilot"]) {
    assert.match(readme, new RegExp(`\\b${family}\\b`));
  }

  const smartGroups = readme.match(/## Smart Groups\n(?<section>[\s\S]*?)\n## Docker Profiles/);
  assert.ok(smartGroups, "README should contain a Smart Groups section before Docker Profiles");

  const listedGroups = smartGroups.groups.section
    .split("\n")
    .map((line) => line.match(/^\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((match) => match[1]);

  for (const group of ["auto", "auto-assess", "auto-sm", "auto-memory", "auto-coding", "coding-sm", "auto-thinking", "auto-tools", "auto-text", "auto-max"]) {
    assert.equal(listedGroups.includes(group), true, `README should list smart group \`${group}\``);
  }
});

test("Claude setup docs prefer Console login and local key extraction", () => {
  const docs = `${read("README.md")}\n${read("INSTRUCTIONS.md")}\n${read("setup.sh")}`;

  assert.match(docs, /platform\.claude\.com/);
  assert.match(docs, /claude auth login --console/);
  assert.match(docs, /claude-auth\.js --env-path/);
  assert.match(docs, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(docs, /claude setup-token/);
  assert.doesNotMatch(docs, /claude\.ai/i);
});

test("setup copies existing Codex auth into the Docker bind mount target", () => {
  const setup = read("setup.sh");

  assert.match(setup, /CODEX_SOURCE_AUTH="\$\{CODEX_HOME:-\$HOME\/\.codex\}\/auth\.json"/);
  assert.match(setup, /cp "\$CODEX_SOURCE_AUTH" "data\/codex-auth\.json"/);
  assert.match(setup, /\[ -d "data\/codex-auth\.json" \]/);
  assert.match(setup, /rmdir "data\/codex-auth\.json"/);
});

test("Codex auth bind mount stays writable for token refresh", () => {
  const compose = read("docker-compose.yml");

  assert.match(compose, /- \.\/data\/codex-auth\.json:\/root\/\.codex\/auth\.json\s*$/m);
  assert.doesNotMatch(compose, /codex-auth\.json:\/root\/\.codex\/auth\.json:ro/);
});

test("Graphiti MCP image allows Compose service host headers for internal MCP traffic", () => {
  const dockerfile = read("Dockerfile.graphiti-mcp");

  assert.match(dockerfile, /TransportSecuritySettings/);
  assert.match(dockerfile, /graphiti-mcp:\*/);
});

test("public env only exposes operator-owned source and routing settings", () => {
  const envExample = read(".env.example");
  const compose = read("docker-compose.yml");
  const envKeys = envExample
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("=", 1)[0]);

  assert.deepEqual(envKeys, [
    "COMPOSE_PROJECT_NAME",
    "LLM_PROXY_PORT",
    "CODEX_PROXY_PORT",
    "DATA_DIR",
    "DEV_MODE",
    "ENABLE_WINDSURF",
    "WINDSURF_API_KEY",
    "ENABLE_CLAUDE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_DEVICE_ID",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_CODE_BILLING_BUILD",
    "CLAUDE_CODE_MAX_TOKENS",
    "CLAUDE_CODE_STAINLESS_PACKAGE_VERSION",
    "CLAUDE_CODE_BETAS",
    "CLAUDE_CODE_OUTPUT_EFFORT",
    "ENABLE_CODEX",
    "ENABLE_COPILOT",
    "COPILOT_GITHUB_TOKEN",
    "LLM_COST_TARGET",
    "LLM_THINKING_TARGET",
    "LLM_SPEED_TARGET",
    "LLM_ROUTING_POLICY",
    "LLM_PROXY_PROMPT_INJECTION",
    "WINDSURF_ENTERPRISE",
  ]);

  for (const pattern of [
    /^MEMORY_/m,
    /^GRAPHITI_/m,
    /^NEO4J_/m,
    /^LLM_PROXY_AI_SUMMARY_/m,
    /^LLM_PROXY_EMBEDDING_/m,
    /^WINDSURF_(?:MODELS|IDE_VERSION|USER_AGENT|API_ORIGIN|CHAT_ORIGIN|CONNECT|INCLUDE_)/m,
    /^GITHUB_COPILOT_/m,
    /^COPILOT_MODELS/m,
    /^CODEX_API_KEY=/m,
  ]) {
    assert.doesNotMatch(envExample, pattern, `.env.example should not expose internal config ${pattern}`);
  }

  for (const pattern of [/\$\{MEMORY_/, /\$\{GRAPHITI_/, /\$\{NEO4J_/, /\$\{LLM_PROXY_(?:AI_SUMMARY|EMBEDDING)_/]) {
    assert.doesNotMatch(compose, pattern, `docker-compose.yml should hardcode internal config ${pattern}`);
  }

  assert.match(compose, /MEMORY_ENABLED:\s+"true"/);
  assert.match(compose, /MEMORY_BACKEND:\s+graphiti/);
  assert.match(compose, /GRAPHITI_MCP_ENABLED:\s+"true"/);
  assert.match(compose, /MODEL_NAME:\s+auto-memory/);
  assert.match(compose, /OPENAI_API_URL:\s+http:\/\/llm-proxy:18900\/v1/);
  assert.match(compose, /NEO4J_AUTH:\s+"neo4j\/graphiti-memory-local"/);
  assert.match(compose, /CODEX_API_KEY:\s+proxy/);
  assert.doesNotMatch(compose, /profiles:\s+\[(?:memory|semantic-memory)/);
  assert.doesNotMatch(compose, /["']7687:7687["']/);
  assert.doesNotMatch(compose, /["']7474:7474["']/);
  assert.doesNotMatch(compose, /["']127\.0\.0\.1:18080:8000["']/);
});
