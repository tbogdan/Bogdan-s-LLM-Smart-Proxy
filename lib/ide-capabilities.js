"use strict";

function optionHeader(options = {}, name = "") {
  const headers = options.headers || {};
  const key = String(name || "").toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (String(headerName).toLowerCase() === key) return String(value || "");
  }
  return "";
}

function detectIdeClient(reqBody = {}, options = {}) {
  const explicit = String(reqBody._llmProxyClient || options.client || "").trim().toLowerCase();
  if (explicit) return clientDescriptor(explicit);

  const haystack = [
    optionHeader(options, "user-agent"),
    optionHeader(options, "x-client-name"),
    optionHeader(options, "x-requested-with"),
    optionHeader(options, "anthropic-client"),
    optionHeader(options, "openai-organization"),
    optionHeader(options, "x-stainless-package-version"),
    reqBody.model,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/(?:claude[-_ ]?code|anthropic\.claude|claude)/i.test(haystack)) return clientDescriptor("claude_code");
  if (/(?:windsurf|cascade|codeium)/i.test(haystack)) return clientDescriptor("windsurf");
  if (/(?:codex|openai-codex)/i.test(haystack)) return clientDescriptor("codex");
  if (/(?:copilot|github[-_ ]?copilot|vscode)/i.test(haystack)) return clientDescriptor("copilot");
  return clientDescriptor(options.defaultClient || "generic");
}

function clientDescriptor(id = "generic") {
  const normalized = String(id || "generic").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "claude" || normalized === "claude_code" || normalized === "claude_cli") {
    return {
      id: "claude_code",
      action: "Claude Code: run /compact or start a fresh task, then retry the same instruction.",
    };
  }
  if (normalized === "windsurf" || normalized === "cascade" || normalized === "codeium") {
    return {
      id: "windsurf",
      action: "Windsurf: compact or start a new Cascade conversation, then retry the same instruction.",
    };
  }
  if (normalized === "codex" || normalized === "openai_codex") {
    return {
      id: "codex",
      action: "Codex: start a fresh thread or compact the conversation, then retry the same instruction.",
    };
  }
  if (normalized === "copilot" || normalized === "github_copilot" || normalized === "vscode") {
    return {
      id: "copilot",
      action: "Copilot: start a new chat or clear the current chat context, then retry the same instruction.",
    };
  }
  return {
    id: "generic",
    action: "Client: compact or start a fresh conversation, then retry the same instruction.",
  };
}

function toolNames(reqBody = {}) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    const value = String(name || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    names.push(value);
  };

  for (const tool of reqBody.tools || []) add(tool?.function?.name || tool?.name);
  for (const fn of reqBody.functions || []) add(fn?.name);
  return names;
}

function normalizeToolName(name = "") {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function findTools(reqBody = {}, predicate) {
  return toolNames(reqBody).filter((name) => predicate(name, normalizeToolName(name)));
}

function detectToolCapabilities(reqBody = {}) {
  const plans = findTools(reqBody, (name, normalized) => (
    normalized === "update_plan" ||
    normalized === "todowrite" ||
    normalized === "todo_write" ||
    /(?:^|_)todo(?:write|_write)?$/.test(normalized)
  ));
  const goals = findTools(reqBody, (_name, normalized) => (
    normalized === "get_goal" ||
    normalized === "create_goal" ||
    normalized === "update_goal" ||
    /^goal_/.test(normalized) ||
    /_goal$/.test(normalized)
  ));
  const subagents = findTools(reqBody, (name, normalized) => (
    normalized === "task" ||
    normalized === "agent" ||
    normalized === "spawn_agent" ||
    normalized === "send_input" ||
    normalized === "wait_agent" ||
    normalized === "multi_agent_v1_spawn_agent" ||
    /(?:^|_)spawn_agent$/.test(normalized) ||
    /(?:^|_)subagent/.test(normalized) ||
    /^multi_agent/.test(normalized) ||
    /\bTask\b/.test(name)
  ));
  const modes = findTools(reqBody, (_name, normalized) => (
    normalized === "request_user_input" ||
    normalized === "plan_mode" ||
    normalized === "set_mode" ||
    normalized === "switch_mode"
  ));
  const skills = findTools(reqBody, (_name, normalized) => (
    normalized === "skill" ||
    normalized.includes("skill") ||
    normalized.includes("mcp")
  ));

  return {
    toolNames: toolNames(reqBody),
    plans,
    goals,
    subagents,
    modes,
    skills,
  };
}

function formatToolList(names = []) {
  if (!Array.isArray(names) || names.length === 0) return "";
  return names.slice(0, 5).join(", ");
}

function buildClientCapabilitySection(reqBody = {}, options = {}) {
  const client = detectIdeClient(reqBody, options);
  const caps = detectToolCapabilities(reqBody);
  const lines = [
    "CLIENT CAPABILITY CONTRACT:",
    `- Detected client: ${client.id}.`,
    "- The current tool schema is authoritative. Use only tools that are actually present; never invent, narrate, XML-wrap, markdown-wrap, or simulate absent client/IDE tools.",
  ];

  if (caps.plans.length > 0) {
    lines.push(`- Plan/progress: use ${formatToolList(caps.plans)} for live task tracking when the task has multiple steps or benefits from visible progress state.`);
  } else {
    lines.push("- Plan/progress: no dedicated plan tool detected. Keep any plan in concise visible text only when useful; do not mention TodoWrite, update_plan, or fake a plan tool call.");
  }

  if (caps.goals.length > 0) {
    lines.push(`- Goals: available via ${formatToolList(caps.goals)}. Use them only for explicit/current goal state and never mark completion before verification.`);
  } else {
    lines.push("- Goals: no dedicated goal tool detected. Track completion internally and report verified outcomes in the final answer.");
  }

  if (caps.subagents.length > 0) {
    lines.push(`- Subagents: available via ${formatToolList(caps.subagents)}. Use subagents whenever possible for independent research, log review, verification, or disjoint file-slice work; keep the immediate blocking step in the main agent.`);
  } else {
    lines.push("- Subagents: no dedicated subagent tool detected. Do not claim to dispatch agents; use available search/read/command tools and parallel tool calls when the protocol supports them.");
  }

  if (caps.modes.length > 0) {
    lines.push(`- Modes/user gates: available via ${formatToolList(caps.modes)} when the client exposes it; otherwise follow the proxy mode lane and explicit user gates.`);
  } else {
    lines.push("- Modes/user gates: no dedicated mode-switch tool detected. Follow the proxy mode lane and explicit user/developer instructions.");
  }

  if (caps.skills.length > 0) {
    lines.push(`- Skills/MCP: available via ${formatToolList(caps.skills)}. Prefer specialized skills/MCP tools for their domain instead of describing them as text.`);
  }

  return {
    client,
    capabilities: caps,
    lines,
  };
}

module.exports = {
  optionHeader,
  detectIdeClient,
  detectToolCapabilities,
  buildClientCapabilitySection,
};
