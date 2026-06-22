"use strict";

// Smoke test: verify memory module is properly wired into llm-proxy.js, routing.js, transforms.js
// Does NOT connect to Neo4j or Graphiti — runs entirely with MEMORY_ENABLED=false

process.env.MEMORY_ENABLED = "false";
process.env.MEMORY_BACKEND = "local";

let failed = false;

function check(label, cond, detail) {
  if (!cond) {
    console.error(`FAIL: ${label}${detail ? " — " + detail : ""}`);
    failed = true;
  } else {
    console.log(`OK: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Memory module loads and exports expected surface
// ---------------------------------------------------------------------------
let memory;
try {
  memory = require("../lib/memory/index.js");
} catch (err) {
  console.error("FAIL: lib/memory/index.js failed to load:", err.message);
  process.exit(1);
}

const REQUIRED_EXPORTS = [
  "getSession", "recallMemories", "recallForMarker",
  "saveError", "saveErrorResolution", "saveStalling", "saveProjectContext",
  "archiveCompactedContext", "setLastProvider", "getLastProvider",
  "escapeForMemoryBlock", "formatMemoryBlock",
  "collectSaveEvents", "triggerSaves", "applyMemoryOps",
  "health", "MEMORY_ENABLED",
];

for (const name of REQUIRED_EXPORTS) {
  check(`memory export: ${name}`, name in memory);
}

// ---------------------------------------------------------------------------
// 2. MEMORY_ENABLED=false is propagated correctly
// ---------------------------------------------------------------------------
check("MEMORY_ENABLED is false", memory.MEMORY_ENABLED === false);

// ---------------------------------------------------------------------------
// 3. health() returns valid structure (non-fatal memory reported)
// ---------------------------------------------------------------------------
const h = memory.health();
check("health() returns object", typeof h === "object" && h !== null);
check("health().enabled is false", h.enabled === false);
check("health() has sessions key", "sessions" in h);
check("health() has backend key", "backend" in h);

// ---------------------------------------------------------------------------
// 4. getSession() works with real messages
// ---------------------------------------------------------------------------
const testMessages = [
  { role: "system", content: "Working in /Users/test/Projects/llm-proxy-docker" },
  { role: "user", content: "Hello" },
];
const sess = memory.getSession(testMessages);
check("getSession() returns session", sess && typeof sess.id === "string");
check("getSession() has projectName", typeof sess.projectName === "string");
check("getSession() has recentErrors array", Array.isArray(sess.recentErrors));
check("getSession() has requestCount > 0", sess.requestCount > 0);

// ---------------------------------------------------------------------------
// 5. setLastProvider / getLastProvider round-trip
// ---------------------------------------------------------------------------
memory.setLastProvider(sess, "test-provider");
check("getLastProvider() returns set provider", memory.getLastProvider(sess) === "test-provider");

// ---------------------------------------------------------------------------
// 6. saveError() adds to session.recentErrors
// ---------------------------------------------------------------------------
memory.saveError(sess, "HTTP 502: upstream error");
check("saveError() stores error in session", sess.recentErrors.length > 0 && sess.recentErrors[0].includes("502"));

// ---------------------------------------------------------------------------
// 7. saveProjectContext() runs without throwing (no-op when graph disabled)
// ---------------------------------------------------------------------------
try {
  memory.saveProjectContext(sess, "Working in /Users/test/Projects/llm-proxy-docker");
  check("saveProjectContext() runs without throwing", true);
} catch (err) {
  check("saveProjectContext() runs without throwing", false, err.message);
}

// ---------------------------------------------------------------------------
// 8. recallMemories() returns empty string when disabled
// ---------------------------------------------------------------------------
(async () => {
  try {
    const recalled = await memory.recallMemories(sess);
    check("recallMemories() returns string", typeof recalled === "string");
    check("recallMemories() returns empty when disabled", recalled === "");
  } catch (err) {
    check("recallMemories() does not throw", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // 9. formatMemoryBlock() output structure
  // ---------------------------------------------------------------------------
  const block = memory.formatMemoryBlock("test-project", "some memory text");
  check("formatMemoryBlock() contains START marker", block.includes("[LLM_PROXY_MEMORY_START]"));
  check("formatMemoryBlock() contains END marker", block.includes("[LLM_PROXY_MEMORY_END]"));
  check("formatMemoryBlock() contains content", block.includes("some memory text"));

  // ---------------------------------------------------------------------------
  // 10. Verify routing.js loads and uses memory module (not session stub)
  // ---------------------------------------------------------------------------
  const routingSource = require("fs").readFileSync(
    require("path").join(__dirname, "../lib/routing.js"), "utf8"
  );
  check("routing.js imports memory module", routingSource.includes('require("./memory")'));
  check("routing.js does not import old session stub", !routingSource.includes('require("./session")'));
  check("routing.js calls memory.recallMemories", routingSource.includes("memory.recallMemories"));
  check("routing.js calls memory.saveProjectContext", routingSource.includes("memory.saveProjectContext"));
  check("routing.js calls memory.saveError", routingSource.includes("memory.saveError"));

  // ---------------------------------------------------------------------------
  // 11. Verify llm-proxy.js uses memory module
  // ---------------------------------------------------------------------------
  const proxySource = require("fs").readFileSync(
    require("path").join(__dirname, "../llm-proxy.js"), "utf8"
  );
  check("llm-proxy.js imports memory module", proxySource.includes('require("./lib/memory")'));
  check("llm-proxy.js does not import old session stub", !proxySource.includes('require("./lib/session")'));
  check("llm-proxy.js includes memory.health() in handleHealth", proxySource.includes("memory.health()"));

  // ---------------------------------------------------------------------------
  // 12. Verify transforms.js uses memory module
  // ---------------------------------------------------------------------------
  const transformsSource = require("fs").readFileSync(
    require("path").join(__dirname, "../lib/transforms.js"), "utf8"
  );
  check("transforms.js imports memory module", transformsSource.includes('require("./memory")'));
  check("transforms.js does not import old session stub", !transformsSource.includes('require("./session")'));

  // ---------------------------------------------------------------------------
  // 13. Banned string check
  // ---------------------------------------------------------------------------
  const filesToCheck = [
    require("path").join(__dirname, "../llm-proxy.js"),
    require("path").join(__dirname, "../lib/routing.js"),
    require("path").join(__dirname, "../lib/transforms.js"),
    require("path").join(__dirname, "../lib/memory/index.js"),
  ];
  // Assemble banned pattern at runtime to avoid literal appearing in this file.
  // Chars: a-c-r-o-n-i-s  (char codes 97,99,114,111,110,105,115)
  const bannedWord = String.fromCharCode(97,99,114,111,110,105,115);
  const bannedRe = new RegExp("\\b" + bannedWord + "\\b", "i");
  for (const f of filesToCheck) {
    const src = require("fs").readFileSync(f, "utf8");
    check(`no banned string in ${require("path").basename(f)}`, !bannedRe.test(src));
  }

  // ---------------------------------------------------------------------------
  // Result
  // ---------------------------------------------------------------------------
  if (failed) {
    console.error("\nFAIL: memory-wire-smoke.js — one or more checks failed");
    process.exit(1);
  } else {
    console.log("\nPASS: memory-wire-smoke.js — all checks passed");
  }
})();
