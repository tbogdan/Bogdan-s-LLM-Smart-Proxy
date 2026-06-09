"use strict";

/**
 * Tool Dialect Registry — shared tool family definitions and client aliases
 * for cross-app/provider tool parity (Codex, Claude Code, Copilot, Devin, Windsurf).
 *
 * Replaces scattered hardcoded tool detection with a unified system.
 * Reuse patterns from:
 *   - lib/responses.js: codexVirtualToolTarget() and CODEX_VIRTUAL_SUBAGENT_TOOLS
 *   - lib/ide-capabilities.js: detectToolCapabilities() name matching patterns
 */

// ---------------------------------------------------------------------------
// Canonical tool families
// ---------------------------------------------------------------------------

const TOOL_FAMILIES = {
  subagents: {
    canonical: [
      "Task",
      "spawn_agent",
      "wait_agent",
      "close_agent",
      "send_input",
      "resume_agent",
    ],
    description: "Subagent orchestration: spawn, wait, close, send input, resume.",
  },
  threads: {
    canonical: [
      "create_thread",
      "read_thread",
      "send_message_to_thread",
      "list_threads",
      "set_thread_pinned",
      "set_thread_archived",
      "set_thread_title",
    ],
    description: "Thread coordination: create, read, send, list, pin, archive, title.",
  },
  plans: {
    canonical: [
      "TodoWrite",
      "update_plan",
    ],
    description: "Plan/progress tracking: todo list or plan updates.",
  },
};

// ---------------------------------------------------------------------------
// Client alias maps — clientId → { family → [aliases] }
// ---------------------------------------------------------------------------

const CLIENT_ALIASES = {
  claude_code: {
    subagents: ["Task"],
    threads: [],
    plans: ["TodoWrite"],
  },
  codex: {
    subagents: [
      "multi_agent_v1.spawn_agent",
      "multi_agent_v1.wait_agent",
      "multi_agent_v1.close_agent",
      "multi_agent_v1.send_input",
      "multi_agent_v1.resume_agent",
      "spawn_agent",
      "wait_agent",
      "close_agent",
      "send_input",
      "resume_agent",
    ],
    threads: [
      "codex_app.create_thread",
      "codex_app.read_thread",
      "codex_app.send_message_to_thread",
      "codex_app.list_threads",
      "codex_app.set_thread_pinned",
      "codex_app.set_thread_archived",
      "codex_app.set_thread_title",
      "create_thread",
      "read_thread",
      "send_message_to_thread",
      "list_threads",
      "set_thread_pinned",
      "set_thread_archived",
      "set_thread_title",
    ],
    plans: ["update_plan"],
  },
  devin_desktop: {
    subagents: ["Task", "spawn_agent", "wait_agent", "close_agent"],
    threads: [],
    plans: ["TodoWrite", "update_plan"],
  },
  windsurf: {
    subagents: ["Task", "spawn_agent", "wait_agent", "close_agent"],
    threads: [],
    plans: ["TodoWrite", "update_plan"],
  },
  copilot: {
    subagents: [],
    threads: [],
    plans: [],
  },
};

// ---------------------------------------------------------------------------
// Native target mapping — canonical name → client-specific native target
// Reuses codexVirtualToolTarget() logic from responses.js
// ---------------------------------------------------------------------------

const CODEX_SUBAGENT_NATIVE_TARGETS = {
  spawn_agent: "multi_agent_v1.spawn_agent",
  wait_agent: "multi_agent_v1.wait_agent",
  close_agent: "multi_agent_v1.close_agent",
  send_input: "multi_agent_v1.send_input",
  resume_agent: "multi_agent_v1.resume_agent",
};

const CODEX_THREAD_NATIVE_TARGETS = {
  create_thread: "codex_app.create_thread",
  read_thread: "codex_app.read_thread",
  send_message_to_thread: "codex_app.send_message_to_thread",
  list_threads: "codex_app.list_threads",
  set_thread_pinned: "codex_app.set_thread_pinned",
  set_thread_archived: "codex_app.set_thread_archived",
  set_thread_title: "codex_app.set_thread_title",
};

// ---------------------------------------------------------------------------
// Capability queries — what tool_search queries each client should use
// to discover tools in a given family
// ---------------------------------------------------------------------------

const CAPABILITY_QUERIES = {
  claude_code: {
    subagents: ["Task"],
    threads: [],
    plans: ["TodoWrite"],
  },
  codex: {
    subagents: ["spawn_agent", "multi_agent_v1"],
    threads: ["create_thread", "codex_app"],
    plans: ["update_plan"],
  },
  devin_desktop: {
    subagents: ["spawn_agent", "Task"],
    threads: [],
    plans: ["TodoWrite", "update_plan"],
  },
  windsurf: {
    subagents: ["spawn_agent", "Task"],
    threads: [],
    plans: ["TodoWrite", "update_plan"],
  },
  copilot: {
    subagents: [],
    threads: [],
    plans: [],
  },
};

// ---------------------------------------------------------------------------
// Internal lookup helpers
// ---------------------------------------------------------------------------

const _CANONICAL_SET = new Set(
  Object.values(TOOL_FAMILIES).flatMap((family) => family.canonical),
);

const _ALIAS_TO_CANONICAL = new Map();

// Build reverse alias map: alias → canonical name
for (const [, families] of Object.entries(CLIENT_ALIASES)) {
  for (const [familyName, aliases] of Object.entries(families)) {
    const canonicals = TOOL_FAMILIES[familyName]?.canonical || [];
    for (const alias of aliases) {
      // Map alias back to the canonical name it represents
      const match = canonicals.find((c) =>
        alias === c ||
        alias.endsWith(`.${c}`) ||
        alias.replace(/[^a-z0-9]/gi, "").toLowerCase() === c.replace(/[^a-z0-9]/gi, "").toLowerCase()
      );
      if (match) {
        _ALIAS_TO_CANONICAL.set(alias, match);
      }
    }
  }
}

// Also map canonical names to themselves
for (const name of _CANONICAL_SET) {
  _ALIAS_TO_CANONICAL.set(name, name);
}

// Subagent and thread name sets for fast membership checks
const _SUBAGENT_NAMES = new Set(TOOL_FAMILIES.subagents.canonical);
const _THREAD_NAMES = new Set(TOOL_FAMILIES.threads.canonical);
const _PLAN_NAMES = new Set(TOOL_FAMILIES.plans.canonical);

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Resolve any tool name (alias or canonical) to its canonical name.
 * Returns the input unchanged if no mapping is found.
 *
 * @param {string} name - Tool name, possibly a client-specific alias.
 * @returns {string} Canonical tool name.
 */
function canonicalToolName(name) {
  const key = String(name || "").trim();
  if (!key) return key;
  // Direct lookup first
  if (_ALIAS_TO_CANONICAL.has(key)) return _ALIAS_TO_CANONICAL.get(key);
  // Try stripping namespace prefix (e.g. "multi_agent_v1.spawn_agent" → "spawn_agent")
  const dotIndex = key.lastIndexOf(".");
  if (dotIndex >= 0) {
    const bare = key.slice(dotIndex + 1);
    if (_ALIAS_TO_CANONICAL.has(bare)) return _ALIAS_TO_CANONICAL.get(bare);
  }
  // Try normalized match
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [alias, canonical] of _ALIAS_TO_CANONICAL) {
    if (alias.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized) return canonical;
  }
  return key;
}

/**
 * Get the list of tool aliases a specific client uses for a given family.
 *
 * @param {string} clientId - Client identifier (e.g. "claude_code", "codex").
 * @param {string} family - Tool family name ("subagents", "threads", "plans").
 * @returns {string[]} Array of alias names the client uses for that family.
 */
function toolAliasesForClient(clientId, family) {
  const normalized = String(clientId || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  const aliases = CLIENT_ALIASES[normalized];
  if (!aliases) return [];
  return Array.isArray(aliases[family]) ? [...aliases[family]] : [];
}

/**
 * Check if a tool name belongs to the subagent family.
 * Handles both canonical names and common aliases/prefixes.
 *
 * Reuses the detection patterns from ide-capabilities.js detectToolCapabilities()
 * and responses.js CODEX_VIRTUAL_SUBAGENT_TOOLS.
 *
 * @param {string} name - Tool name to check.
 * @returns {boolean}
 */
function isSubagentToolName(name) {
  const key = String(name || "").trim();
  if (!key) return false;
  // Canonical match
  if (_SUBAGENT_NAMES.has(key)) return true;
  // Namespace-prefixed match (e.g. "multi_agent_v1.spawn_agent")
  const dotIndex = key.lastIndexOf(".");
  if (dotIndex >= 0 && _SUBAGENT_NAMES.has(key.slice(dotIndex + 1))) return true;
  // Normalized match covering patterns from ide-capabilities.js
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "task") return true;
  if (normalized === "agent") return true;
  if (/(?:^|_)spawn_agent$/.test(normalized)) return true;
  if (/(?:^|_)create_thread$/.test(normalized)) return true;
  if (/(?:^|_)send_message_to_thread$/.test(normalized)) return true;
  if (/(?:^|_)subagent/.test(normalized)) return true;
  if (/^multi_agent/.test(normalized)) return true;
  // Bare "Task" with capital T check (from ide-capabilities.js)
  if (/\bTask\b/.test(key)) return true;
  return false;
}

/**
 * Check if a tool name belongs to the thread family.
 *
 * @param {string} name - Tool name to check.
 * @returns {boolean}
 */
function isThreadToolName(name) {
  const key = String(name || "").trim();
  if (!key) return false;
  // Canonical match
  if (_THREAD_NAMES.has(key)) return true;
  // Namespace-prefixed match (e.g. "codex_app.create_thread")
  const dotIndex = key.lastIndexOf(".");
  if (dotIndex >= 0 && _THREAD_NAMES.has(key.slice(dotIndex + 1))) return true;
  // Normalized match
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const canonical of _THREAD_NAMES) {
    const cn = canonical.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized === cn || normalized.endsWith(cn)) return true;
  }
  return false;
}

/**
 * Map a canonical tool name to the client-specific native target.
 * Reuses codexVirtualToolTarget() logic from responses.js:
 *   - Codex subagent tools → "multi_agent_v1.<name>"
 *   - Codex thread tools   → "codex_app.<name>"
 *   - Claude Code          → "Task" for subagents
 *   - Copilot              → null (no native subagent support)
 *   - Devin/Windsurf       → bare canonical name (ACP/Windsurf Connect schema)
 *
 * @param {string} clientId - Client identifier.
 * @param {string} canonicalName - Canonical tool name.
 * @returns {string|null} Native target name, or null if the client has no native mapping.
 */
function nativeToolTarget(clientId, canonicalName) {
  const normalized = String(clientId || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  const name = String(canonicalName || "").trim();
  if (!name) return null;

  // Copilot: never synthesize subagent support
  if (normalized === "copilot" || normalized === "github_copilot") {
    if (_SUBAGENT_NAMES.has(name) || _THREAD_NAMES.has(name)) return null;
    return name;
  }

  // Codex: namespace-prefixed targets (from responses.js codexVirtualToolTarget)
  if (normalized === "codex") {
    if (CODEX_SUBAGENT_NATIVE_TARGETS[name]) return CODEX_SUBAGENT_NATIVE_TARGETS[name];
    if (CODEX_THREAD_NATIVE_TARGETS[name]) return CODEX_THREAD_NATIVE_TARGETS[name];
    // Plans and other tools pass through
    return name;
  }

  // Claude Code: Task for subagents, TodoWrite for plans
  if (normalized === "claude_code") {
    if (name === "Task") return "Task";
    if (_SUBAGENT_NAMES.has(name) && name !== "Task") return null; // Claude Code only uses Task
    if (name === "TodoWrite") return "TodoWrite";
    return name;
  }

  // Devin Desktop / Windsurf: bare canonical names via ACP/Windsurf Connect
  if (normalized === "devin_desktop" || normalized === "windsurf") {
    if (_SUBAGENT_NAMES.has(name) || _THREAD_NAMES.has(name) || _PLAN_NAMES.has(name)) return name;
    return name;
  }

  // Generic: pass through
  return name;
}

/**
 * Get the tool_search / capability discovery queries a client should use
 * for a given tool family.
 *
 * @param {string} clientId - Client identifier.
 * @param {string} family - Tool family name ("subagents", "threads", "plans").
 * @returns {string[]} Array of query strings for tool_search discovery.
 */
function capabilityQueriesForClient(clientId, family) {
  const normalized = String(clientId || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  const queries = CAPABILITY_QUERIES[normalized];
  if (!queries) return [];
  return Array.isArray(queries[family]) ? [...queries[family]] : [];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Data constants
  TOOL_FAMILIES,
  CLIENT_ALIASES,
  CAPABILITY_QUERIES,
  CODEX_SUBAGENT_NATIVE_TARGETS,
  CODEX_THREAD_NATIVE_TARGETS,

  // Helper functions
  canonicalToolName,
  toolAliasesForClient,
  isSubagentToolName,
  isThreadToolName,
  nativeToolTarget,
  capabilityQueriesForClient,
};
