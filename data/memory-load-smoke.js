"use strict";

// Smoke test: verify lib/memory/index.js loads without runtime errors
// Does NOT connect to Neo4j or Graphiti MCP — just validates module structure

// Disable memory backends so no real connections are attempted
process.env.MEMORY_ENABLED = "false";
process.env.MEMORY_BACKEND = "local";

let memory;
try {
  memory = require("../lib/memory/index.js");
} catch (err) {
  console.error("FAIL: lib/memory/index.js failed to load:", err.message);
  process.exit(1);
}

// Verify expected exports exist
const expectedExports = [
  "getSession",
  "recallMemories",
  "recallForMarker",
  "saveError",
  "saveProjectContext",
  "archiveCompactedContext",
  "setLastProvider",
  "getLastProvider",
  "escapeForMemoryBlock",
  "formatMemoryBlock",
  "applyMemoryOps",
  "health",
  "MEMORY_ENABLED",
];

let failed = false;
for (const name of expectedExports) {
  if (!(name in memory)) {
    console.error(`FAIL: missing export: ${name}`);
    failed = true;
  }
}

if (failed) process.exit(1);

// Verify health() works
const h = memory.health();
if (typeof h !== "object" || h === null) {
  console.error("FAIL: health() did not return an object");
  process.exit(1);
}

// Verify getSession + formatMemoryBlock work
const session = memory.getSession([{ role: "system", content: "Working in /Users/test/Projects/llm-proxy" }]);
if (!session || typeof session.id !== "string") {
  console.error("FAIL: getSession() did not return a session with id");
  process.exit(1);
}

const block = memory.formatMemoryBlock("llm-proxy", "test memory content");
if (!block.includes("LLM_PROXY_MEMORY_START") || !block.includes("test memory content")) {
  console.error("FAIL: formatMemoryBlock() output malformed");
  process.exit(1);
}

console.log("OK: lib/memory/index.js loaded successfully");
console.log("OK: all expected exports present");
console.log("OK: health():", JSON.stringify(h));
console.log("OK: getSession() returned session id:", session.id);
console.log("OK: formatMemoryBlock() produced correct output");
console.log("PASS: memory module smoke test complete");
