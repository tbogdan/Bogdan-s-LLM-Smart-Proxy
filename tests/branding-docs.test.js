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

const publicSetupFiles = [
  "README.md",
  "INSTRUCTIONS.md",
  ".env.example",
  "docker-compose.yml",
  "setup.sh",
];

const publicBrandingFiles = [
  "README.md",
  "INSTRUCTIONS.md",
  "package.json",
  ".env.example",
  "docker-compose.yml",
  "setup.sh",
];

const oldProviderTerms = [
  "Groq",
  "SambaNova",
  "Kiro",
  "OpenRouter",
  "ModelScope",
  "Cline Provider",
  "Dockerfile.kiro",
  "kiro-auth",
  "ENABLE_KIRO",
];

test("public docs and setup use current Project branding", () => {
  const contents = Object.fromEntries(requiredFiles.map((file) => [file, read(file)]));

  assert.match(Object.values(contents).join("\n"), /Project LLM Smart Proxy/);

  for (const [file, text] of publicBrandingFiles.map((file) => [file, contents[file]])) {
    assert.doesNotMatch(text, /Bogdan's LLM Smart Proxy/, file);
  }
});

test("public docs and setup mention only current provider families", () => {
  const contents = Object.fromEntries(publicSetupFiles.map((file) => [file, read(file)]));

  for (const [file, text] of Object.entries(contents)) {
    for (const term of oldProviderTerms) {
      assert.equal(text.includes(term), false, `${file} contains removed provider or flow: ${term}`);
    }
  }
});

test("README documents supported provider families and smart groups", () => {
  const readme = read("README.md");

  for (const family of ["Windsurf", "Claude", "Codex"]) {
    assert.match(readme, new RegExp(`\\b${family}\\b`));
  }

  for (const group of ["auto", "auto-coding", "auto-thinking", "auto-tools", "auto-text", "auto-max"]) {
    assert.match(readme, new RegExp(`\\b${group}\\b`));
  }
});
