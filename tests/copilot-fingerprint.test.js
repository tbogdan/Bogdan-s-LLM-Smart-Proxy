"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fingerprint = require("../lib/copilot-fingerprint");

test("discoverExtensionVersion prefers active bundled Copilot extension over cached VSIX", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-fingerprint-"));
  const appPackage = path.join(dir, "app-copilot-package.json");
  const codeDir = path.join(dir, "Code");
  const cacheRoot = path.join(codeDir, "CachedExtensionVSIXs");
  fs.mkdirSync(path.join(cacheRoot, "github.copilot-chat-0.48.1"), { recursive: true });
  fs.writeFileSync(appPackage, JSON.stringify({ version: "0.51.0" }));

  assert.equal(fingerprint.discoverExtensionVersion({
    COPILOT_APP_EXTENSION_PACKAGE_JSON: appPackage,
    VSCODE_USER_DATA_DIR: codeDir,
    VSCODE_EXTENSIONS_DIR: path.join(dir, "missing-extensions"),
  }), "0.51.0");
});
