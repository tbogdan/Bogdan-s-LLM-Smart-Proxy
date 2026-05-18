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

const oldBrandingFiles = [
  "README.md",
  "INSTRUCTIONS.md",
  "package.json",
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

test("public docs and setup use current Project branding", () => {
  const contents = Object.fromEntries(requiredFiles.map((file) => [file, read(file)]));

  for (const file of exactBrandingFiles) {
    assert.match(contents[file], /Project LLM Smart Proxy/, `${file} should carry current prose branding`);
  }

  const packageJson = JSON.parse(contents["package.json"]);
  assert.equal(packageJson.name, "Project-llm-smart-proxy");

  for (const file of oldBrandingFiles) {
    assert.doesNotMatch(contents[file], /Bogdan's LLM Smart Proxy/, file);
  }
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
    for (const pattern of removedProviderDocPatterns) {
      assert.doesNotMatch(text, pattern, `${file} contains removed provider docs: ${pattern}`);
    }
  }
});

test("README documents supported provider families and smart groups", () => {
  const readme = read("README.md");

  for (const family of ["Windsurf", "Claude", "Codex"]) {
    assert.match(readme, new RegExp(`\\b${family}\\b`));
  }

  const smartGroups = readme.match(/## Smart Groups\n(?<section>[\s\S]*?)\n## Docker Profiles/);
  assert.ok(smartGroups, "README should contain a Smart Groups section before Docker Profiles");

  const listedGroups = smartGroups.groups.section
    .split("\n")
    .map((line) => line.match(/^\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((match) => match[1]);

  for (const group of ["auto", "auto-coding", "auto-thinking", "auto-tools", "auto-text", "auto-max"]) {
    assert.equal(listedGroups.includes(group), true, `README should list smart group \`${group}\``);
  }
});
