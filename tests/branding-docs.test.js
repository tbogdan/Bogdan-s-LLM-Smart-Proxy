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

  for (const group of ["auto", "auto-assess", "auto-sm", "auto-coding", "coding-sm", "auto-thinking", "auto-tools", "auto-text", "auto-max"]) {
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
