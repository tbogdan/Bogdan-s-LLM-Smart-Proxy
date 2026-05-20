"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = ["lib", "tests"];
const ROOT_FILES = [
  "llm-proxy.js",
  "llm-discovery.js",
  "llm-mempalace.js",
  "claude-auth.js",
  "windsurf-auth.js",
  "setup.sh",
  ".env.example",
];
const MATCHING_ONLY_FILES = new Set([
  "lib/compaction.js",
  "lib/routing.js",
  "lib/routing-policy.js",
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(filePath));
    else out.push(filePath);
  }
  return out;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

test("application and test prose stays English-only", () => {
  const files = [
    ...SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))),
    ...ROOT_FILES.map((file) => path.join(ROOT, file)).filter((file) => fs.existsSync(file)),
  ].filter((file) => file !== __filename && /\.(js|sh|env\.example)$/.test(file));

  const romanianPhrase = /\b(?:analizeaza|imbunatat|schimbari|modificari|adaugat|reparat|verifica|finalizat|terminat|ruleaza|fisiere|sumarizeaza|taskuri|continui|doriti|astept|scanez|sunt\s+claude|lucrez)\b/i;
  const diacritics = /[ăâîșțĂÂÎȘȚ]/;
  const offenders = [];

  for (const file of files) {
    const rel = relative(file);
    const text = fs.readFileSync(file, "utf8");
    if (diacritics.test(text)) offenders.push(`${rel}: contains Romanian diacritics`);
    if (!MATCHING_ONLY_FILES.has(rel) && romanianPhrase.test(text)) {
      offenders.push(`${rel}: contains Romanian prose phrase`);
    }
  }

  assert.deepEqual(offenders, []);
});
