"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const routingPolicy = require("./routing-policy");
const hiddenMemoryMarkers = require("./memory/hidden-markers");
const state = require("./state");
const mediaContent = require("./media-content");
const ideCapabilities = require("./ide-capabilities");
const toolDialects = require("./tool-dialects");

let _handleChatCompletion;
let _taskRuntime;
const responseHistory = new Map();
const virtualCodexAgents = new Map();
const virtualCodexThreads = new Map();
const MAX_RESPONSE_HISTORY = Math.max(4, Number(process.env.LLM_PROXY_MAX_RESPONSE_HISTORY || 40) || 40);
const MAX_RESPONSE_HISTORY_MESSAGES = Math.max(40, Number(process.env.LLM_PROXY_MAX_RESPONSE_HISTORY_MESSAGES || 400) || 400);
const MAX_RESPONSE_HISTORY_CHARS = Math.max(20_000, Number(process.env.LLM_PROXY_MAX_RESPONSE_HISTORY_CHARS || 250_000) || 250_000);
const MAX_PROXY_HOSTED_VIRTUAL_LOOPS = Math.max(1, Number(process.env.LLM_PROXY_CODEX_VIRTUAL_SUBAGENT_MAX_LOOPS || 4) || 4);
const CODEX_VIRTUAL_SUBAGENT_TOOLS = [
  ...toolDialects.TOOL_FAMILIES.subagents.canonical.filter((name) => name !== "Task"),
  ...toolDialects.TOOL_FAMILIES.threads.canonical,
];
const PROXY_CACHE_ARTIFACT_LINE_RE =
  /^\s*(?:proxy suppressed invalid tool call "[^"]+": .+|tool call error:\s+the model attempted to call "[^"]+".+|llm_proxy_task_difficulty\b.*|llm_proxy_context_compaction_required\b.*|client=(?:claude_code|windsurf|codex|copilot|generic)\s+reason=(?:too_large_for_best_context|no_provider_fits_context|compaction_exhausted|direct_provider_context_overflow|context_overflow)\b.*|the proxy compacted locally when possible, but this request still does not fit any configured provider\.?|(?:claude code|windsurf|codex|copilot|client):\s+(?:run \/compact|compact|start|clear).+retry the same instruction\.?|earlier native tool history omitted for compatibility\b.*|historical tool (?:invocation|result)\s*\(\s*already\s+(?:executed|observed)\s*(?:\)|["']?\s*:?).*|past tool (?:invocation|result) \(context only\b.*)\s*$/i;
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>\s*[\s\S]*?<\/task-notification>/ig;
const TOOL_USE_ERROR_BLOCK_RE = /<tool_use_error>\s*[\s\S]*?<\/tool_use_error>/ig;
const SUBAGENT_USAGE_FOOTER_RE = /\n?agentId:\s*[^\n]+\(use SendMessage[^\n]*\)\s*\n?<usage>\s*[\s\S]*?<\/usage>\s*/ig;
const ORPHAN_TOOL_ARG_FRAGMENT_RE = /(?:^|[\n\r])\s*(?:["']?file_path["']?\s*:\s*["'][^"'\n]+["']\s*,\s*)?["'][^"'\n]*\/[^"'\n]+["']\s*,\s*["']?(?:limit|offset|start|end)["']?\s*:\s*\d+(?:\s*,\s*["']?(?:limit|offset|start|end)["']?\s*:\s*\d+)*(?:\s*,\s*["']?(?:file_path|path)["']?\s*:\s*["'][^"'\n]+["'])?\s*}\s*(?=$|[\n\r])/ig;
const UI_CHROME_LINE_RE = /^\s*(?:Show less|Show more|Update Todos)\s*$/gim;

function init({ handleChatCompletion, taskRuntime }) {
  _handleChatCompletion = handleChatCompletion;
  _taskRuntime = taskRuntime;
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

const CODEX_MODEL_MAP = {
  "o4-mini": "auto-coding",
  o3: "auto-coding",
  "o3-mini": "auto-coding",
  "gpt-5.5": "auto-coding",
  "gpt-5.4": "auto-coding",
  "gpt-5.4-mini": "auto-coding",
  "gpt-5.3-codex": "auto-coding",
  "gpt-5.2": "auto-coding",
  "codex-auto-review": "auto-coding",
};

function mapModel(model) {
  if (!model) return "auto-coding";
  if (CODEX_MODEL_MAP[model]) return CODEX_MODEL_MAP[model];
  if (/^auto(?:-|$)/.test(String(model))) return model;
  if (model in state.GROUPS) return model;
  if (state.PROVIDERS.some((p) => p.model === model || p.name === model)) return model;
  return "auto-coding";
}

function normalizeRole(role) {
  if (role === "developer") return "system";
  return role || "user";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return mediaContent.textFromContent(content);
}

function stripResponseProxyArtifacts(text = "") {
  let cleaned = String(text || "");
  let changed = false;

  const difficulty = routingPolicy.stripDifficultyMarkerFromText(cleaned, { includeLegacyBare: true });
  if (difficulty.changed) {
    cleaned = difficulty.content;
    changed = true;
  }
  const taskStatus = routingPolicy.stripTaskStatusMarkerFromText(cleaned);
  if (taskStatus.changed) {
    cleaned = taskStatus.content;
    changed = true;
  }
  const hiddenMarkers = hiddenMemoryMarkers.stripHiddenMemoryMarkers(cleaned);
  if (hiddenMarkers.changed) {
    cleaned = hiddenMarkers.content;
    changed = true;
  }

  const replaced = cleaned
    .replace(TASK_NOTIFICATION_BLOCK_RE, "\n")
    .replace(TOOL_USE_ERROR_BLOCK_RE, "\n")
    .replace(SUBAGENT_USAGE_FOOTER_RE, "\n")
    .replace(UI_CHROME_LINE_RE, "\n");
  if (replaced !== cleaned) {
    cleaned = replaced;
    changed = true;
  }

  const lines = cleaned.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (PROXY_CACHE_ARTIFACT_LINE_RE.test(line)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  cleaned = kept.join("\n");

  const orphanStripped = cleaned.replace(ORPHAN_TOOL_ARG_FRAGMENT_RE, (_match, offset, fullText) => {
    changed = true;
    const startsWithNewline = offset > 0 && /[\n\r]/.test(fullText[offset]);
    return startsWithNewline ? "\n" : "";
  });
  cleaned = orphanStripped
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { changed, text: cleaned };
}

function sanitizeVisibleAssistantText(text = "") {
  return stripResponseProxyArtifacts(text).text.trim();
}

function sanitizeReplayMessage(message) {
  if (!message || typeof message !== "object") return message;
  const cloned = { ...message };

  // Sanitize content field (string or array)
  if (typeof cloned.content === "string") {
    cloned.content = sanitizeVisibleAssistantText(cloned.content);
  } else if (Array.isArray(cloned.content)) {
    cloned.content = cloned.content.map((part) => {
      if (part && typeof part === "object" && typeof part.text === "string") {
        return { ...part, text: sanitizeVisibleAssistantText(part.text) };
      }
      return part;
    });
  }

  // Tool calls arguments should NOT be sanitized - preserve functional tool data
  // Only sanitize visible text content that can leak into conversation replay

  return cloned;
}

function chatFunctionTool(name, description, parameters, strict) {
  if (!name) return null;
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: parameters && typeof parameters === "object" ? parameters : { type: "object", properties: {} },
      ...(strict !== undefined ? { strict } : {}),
    },
  };
}

function registerTranslatedTool(registry, name, metadata = {}) {
  const key = String(name || "").trim();
  if (!key || !registry) return;
  if (!registry.byName[key]) registry.names.push(key);
  registry.byName[key] = { name: key, ...metadata };
}

function hostedToolSchema(tool = {}) {
  void tool;
  return {
    type: "object",
    properties: {
      query: { type: "string" },
      input: { type: "string" },
      reason: { type: "string" },
    },
    additionalProperties: true,
  };
}

function customToolInputSchema(tool = {}) {
  return {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: tool.description || `Free-form input for ${tool.name || "custom tool"}.`,
      },
    },
    required: ["input"],
    additionalProperties: false,
  };
}

function envEnabled(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return !/^(?:0|false|off|no)$/i.test(String(raw).trim());
}

function codexVirtualToolSchema(name = "") {
  if (name === "spawn_agent") {
    return {
      type: "object",
      properties: {
        message: { type: "string" },
        agent_type: { type: "string" },
        fork_context: { type: "boolean" },
        model: { type: "string" },
        reasoning_effort: { type: "string" },
        items: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["message"],
      additionalProperties: true,
    };
  }
  if (name === "wait_agent") {
    return {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" } },
        timeout_ms: { type: "integer" },
      },
      required: ["targets"],
      additionalProperties: false,
    };
  }
  if (name === "close_agent" || name === "resume_agent") {
    return {
      type: "object",
      properties: {
        target: { type: "string" },
        id: { type: "string" },
      },
      additionalProperties: false,
    };
  }
  if (name === "send_input") {
    return {
      type: "object",
      properties: {
        target: { type: "string" },
        message: { type: "string" },
        interrupt: { type: "boolean" },
        items: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["target"],
      additionalProperties: true,
    };
  }
  if (name === "create_thread") {
    return {
      type: "object",
      properties: {
        message: { type: "string" },
        title: { type: "string" },
        model: { type: "string" },
      },
      required: ["message"],
      additionalProperties: true,
    };
  }
  if (name === "read_thread") {
    return {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        id: { type: "string" },
      },
      additionalProperties: false,
    };
  }
  if (name === "send_message_to_thread") {
    return {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["thread_id", "message"],
      additionalProperties: true,
    };
  }
  if (name === "set_thread_pinned" || name === "set_thread_archived") {
    return {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        value: { type: "boolean" },
      },
      required: ["thread_id", "value"],
      additionalProperties: false,
    };
  }
  if (name === "set_thread_title") {
    return {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        title: { type: "string" },
      },
      required: ["thread_id", "title"],
      additionalProperties: false,
    };
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

function codexVirtualToolDescription(name = "") {
  if (["spawn_agent", "wait_agent", "close_agent", "send_input", "resume_agent"].includes(name)) {
    return `Codex virtual subagent discovery placeholder ${name}. Use it for bounded sidecar agent work when useful; if Codex omitted the executable handler, the proxy routes this through tool_search so the IDE can expose the native tool.`;
  }
  return `Codex virtual thread discovery placeholder ${name}. Use it only when thread coordination materially helps the active task; if Codex omitted the executable handler, the proxy routes this through tool_search so the IDE can expose the native tool.`;
}

function isCodexVirtualToolName(name = "") {
  return CODEX_VIRTUAL_SUBAGENT_TOOLS.includes(String(name || "").trim());
}

function codexVirtualDiscoveryQuery(name = "") {
  if (["spawn_agent", "wait_agent", "close_agent", "send_input", "resume_agent"].includes(name)) return name;
  if (["create_thread", "read_thread", "send_message_to_thread", "list_threads", "set_thread_pinned", "set_thread_archived", "set_thread_title"].includes(name)) return name;
  return name || "spawn_agent";
}

function codexVirtualToolTarget(name = "") {
  return toolDialects.nativeToolTarget("codex", name) || name;
}

function codexVirtualCanonicalTools() {
  return CODEX_VIRTUAL_SUBAGENT_TOOLS;
}

const CODEX_VIRTUAL_CANONICAL_SET = new Set(CODEX_VIRTUAL_SUBAGENT_TOOLS);

function codexVirtualCanonicalSet() {
  return CODEX_VIRTUAL_CANONICAL_SET;
}

function codexRequestHasUsableNativeVirtualTool(request = {}, name = "") {
  if (!name) return false;
  const canonical = toolDialects.canonicalToolName(name);
  if (!codexVirtualCanonicalSet().has(canonical)) return false;
  const target = codexVirtualToolTarget(canonical);
  for (const tool of request.tools || []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      if (tool.name && `${tool.name}.${canonical}` === target) return true;
      continue;
    }
    const toolName = tool?.function?.name || tool?.name || "";
    if (!toolName) continue;
    if (toolName === target) return true;
  }
  return false;
}

function codexProxyHostingForced() {
  return envEnabled("LLM_PROXY_CODEX_FORCE_PROXY_HOSTED_SUBAGENTS", false);
}

// When LLM_PROXY_CODEX_FORCE_NATIVE_SUBAGENTS=true: skip proxy-hosted virtual loop
// for all Codex sessions. Proxy emits function_call with namespace:multi_agent_v1
// and Codex desktop spawns native subprocesses (requires codex-force-multi-agent.sh).
function codexForceNativeSubagents() {
  return envEnabled("LLM_PROXY_CODEX_FORCE_NATIVE_SUBAGENTS", false);
}

function codexVirtualRegistryMeta(name = "", metadata = {}) {
  const canonical = toolDialects.canonicalToolName(name);
  // Default: proxy-host bare Codex compatibility placeholders. Current Codex
  // desktop sessions can expose bare spawn_agent/create_thread schemas through
  // the proxy but then reject execution with "unsupported call"; only namespace
  // targets such as multi_agent_v1.spawn_agent are treated as executable native
  // tools.
  const proxyHosted = codexForceNativeSubagents()
    ? false
    : (!codexRequestHasUsableNativeVirtualTool(metadata.request, canonical) || codexProxyHostingForced());
  return {
    kind: "virtual_codex_subagent",
    canonicalName: canonical,
    originalType: "virtual",
    virtual: true,
    proxyHosted,
    source: "codex_virtual_subagents",
    nativeTarget: codexVirtualToolTarget(canonical),
    discoveryQuery: codexVirtualDiscoveryQuery(canonical),
    ...metadata,
  };
}

function virtualCodexSubagentTools(existingTools = [], registry = null, request = {}) {
  const seen = new Set((existingTools || []).map((tool) => tool?.function?.name || tool?.name).filter(Boolean));
  const injected = [];
  for (const name of codexVirtualCanonicalTools()) {
    if (seen.has(name)) continue;
    if (codexRequestHasUsableNativeVirtualTool(request, name)) continue;
    const tool = chatFunctionTool(name, codexVirtualToolDescription(name), codexVirtualToolSchema(name), false);
    if (!tool) continue;
    registerTranslatedTool(registry, name, codexVirtualRegistryMeta(name, { request }));
    injected.push(tool);
  }
  return injected;
}

function registerCodexVirtualSubagentShadow(registry = null, name = "", metadata = {}) {
  if (!registry || !isCodexVirtualToolName(name)) return false;
  const responseName = codexVirtualToolTarget(name);
  registerTranslatedTool(registry, name, {
    ...codexVirtualRegistryMeta(name, metadata),
    originalType: metadata.originalType || "virtual_shadow",
    shadowOnly: true,
    responseName,
  });
  return true;
}

function shadowCodexVirtualSubagentTools(existingTools = [], registry = null, request = {}) {
  if (!registry) return [];
  const seen = new Set((existingTools || []).map((tool) => tool?.function?.name || tool?.name).filter(Boolean));
  const shadowed = [];
  for (const name of codexVirtualCanonicalTools()) {
    if (seen.has(name) || registry.byName?.[name]) continue;
    if (!codexRequestHasUsableNativeVirtualTool(request, name)) continue;
    const target = codexVirtualToolTarget(name);
    const targetPresent = seen.has(target) || Boolean(registry.byName?.[target]);
    if (!targetPresent) continue;
    if (registerCodexVirtualSubagentShadow(registry, name, { request })) shadowed.push(name);
  }
  return shadowed;
}

function shouldInjectCodexVirtualSubagentTools(request = {}, client = "") {
  if (String(client || "").toLowerCase() !== "codex") return false;
  const model = String(request.model || "").toLowerCase();
  if (model === "auto-memory") return false;
  return true;
}

function codexCapabilityRequestWithoutBareVirtuals(request = {}, client = "") {
  if (String(client || "").toLowerCase() !== "codex") return request;
  const filteredTools = (request.tools || []).filter((tool) => {
    if (!tool || tool.type !== "function") return true;
    const name = tool.function?.name || tool.name || "";
    return !isCodexVirtualToolName(name);
  });
  if (filteredTools.length === (request.tools || []).length) return request;
  return { ...request, tools: filteredTools };
}

function isHostedResponsesTool(tool = {}) {
  const type = String(tool?.type || "").trim();
  return /^(?:web_search|web_search_preview|file_search|computer_use|computer|code_interpreter|image_generation|local_shell|shell)$/.test(type) ||
    /_(?:call|tool)$/.test(type) && /(?:web_search|file_search|computer|code_interpreter|image_generation|shell)/.test(type);
}

function translateTool(tool, registry = null, options = {}) {
  if (!tool || typeof tool !== "object") return [];
  const shouldShadowBareCodexVirtualTool = (name = "") => (
    options.client === "codex" &&
    isCodexVirtualToolName(name) &&
    !options.namespace
  );
  const registerUnsupported = (reason) => {
    if (!registry) return [];
    registry.unsupported.push({
      type: tool.type || "",
      name: tool.name || tool.server_label || "",
      reason,
    });
    return [];
  };
  if (tool.type === "mcp") {
    return registerUnsupported("responses_mcp_descriptor_requires_namespace_translation");
  }
  if (tool.type === "mcp_resource" || tool.type === "mcp_resource_template") {
    return registerUnsupported("responses_mcp_resource_descriptor_not_chat_callable");
  }
  if (tool.type === "function") {
    if (tool.function?.name) {
      if (shouldShadowBareCodexVirtualTool(tool.function.name)) {
        registerCodexVirtualSubagentShadow(registry, tool.function.name, { originalType: "function_shadow" });
        return [];
      }
      registerTranslatedTool(registry, tool.function.name, { kind: "function", originalType: "function" });
      return [tool];
    }
    if (shouldShadowBareCodexVirtualTool(tool.name)) {
      registerCodexVirtualSubagentShadow(registry, tool.name, { originalType: "function_shadow" });
      return [];
    }
    const translated = chatFunctionTool(tool.name, tool.description, tool.parameters, tool.strict);
    if (translated) registerTranslatedTool(registry, tool.name, { kind: "function", originalType: "function" });
    return translated ? [translated] : [];
  }

  if (tool.type === "tool_search") {
    const name = tool.name || "tool_search";
    const translated = chatFunctionTool(
      name,
      tool.description || "Discover currently available deferred tools and connectors.",
      tool.parameters || {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      tool.strict,
    );
    if (translated) registerTranslatedTool(registry, name, { kind: "deferred", originalType: "tool_search" });
    return translated ? [translated] : [];
  }

  if (tool.type === "namespace" && Array.isArray(tool.tools)) {
    const translated = [];
    for (const child of tool.tools) {
      if (!child || child.type !== "function") continue;
      const childName = child.function?.name || child.name;
      if (!childName) continue;
      let name = childName;
      if (registry?.byName?.[name] && tool.name) {
        name = `${tool.name}.${childName}`;
      }
      const fn = chatFunctionTool(
        name,
        child.description || (tool.name ? `${tool.name} tool` : undefined),
        child.parameters || child.function?.parameters,
        child.strict || child.function?.strict,
      );
      if (fn) {
        // Forward a flat, provider-safe function name (bare child, qualified only
        // on collision) to the upstream model. The Codex runtime routes tool calls
        // by a SEPARATE (namespace, name) pair — its ResponseItem::FunctionCall has
        // a `namespace` field and tool names must match ^[a-zA-Z0-9_-]+$ (no dots).
        // We keep `namespace` + `childName` here so the response path re-attaches
        // the namespace; returning only the bare child made Codex reject the call
        // as "unsupported call".
        registerTranslatedTool(registry, name, {
          kind: "namespace_function",
          originalType: "namespace",
          namespace: tool.name || "",
          childName,
        });
        translated.push(fn);
      }
    }
    return translated;
  }

  if (tool.type === "custom" && tool.name) {
    const translated = chatFunctionTool(
      tool.name,
      tool.description || `Call custom tool ${tool.name} with free-form input.`,
      customToolInputSchema(tool),
      false,
    );
    if (translated) {
      registerTranslatedTool(registry, tool.name, {
        kind: "custom",
        originalType: "custom",
        inputFormat: tool.format || tool.input_format || null,
      });
    }
    return translated ? [translated] : [];
  }

  if (isHostedResponsesTool(tool)) {
    const name = tool.name || tool.type;
    const translated = chatFunctionTool(
      name,
      tool.description || `${tool.type} hosted Responses tool exposed by the client. Use only if the client can execute the resulting tool call.`,
      tool.parameters || hostedToolSchema(tool),
      tool.strict,
    );
    if (translated) {
      registerTranslatedTool(registry, name, {
        kind: "hosted",
        originalType: tool.type,
        hostedType: tool.type,
      });
    }
    return translated ? [translated] : [];
  }

  if (registry) {
    registry.unsupported.push({
      type: tool.type || "",
      name: tool.name || tool.server_label || "",
      reason: "unsupported_responses_tool_shape",
    });
  }
  return [];
}

function dedupeTranslatedTools(tools = [], registry = null) {
  const seen = new Set();
  const out = [];
  for (const tool of tools || []) {
    const name = tool?.function?.name || tool?.name;
    if (!name) continue;
    if (seen.has(name)) {
      if (registry) {
        registry.duplicates.push({
          name,
          reason: "duplicate_translated_tool_name",
        });
      }
      continue;
    }
    seen.add(name);
    out.push(tool);
  }
  return out;
}

function createToolRegistry() {
  return { names: [], byName: {}, unsupported: [], duplicates: [] };
}

function attachResponsesToolRegistry(target = {}, registry = null) {
  if (!registry) return target;
  Object.defineProperty(target, "_llmProxyResponsesToolRegistry", {
    value: registry,
    enumerable: true,
    configurable: true,
  });
  return target;
}

function responseToolRegistry(target = {}) {
  const registry = target?._llmProxyResponsesToolRegistry;
  return registry && typeof registry === "object" ? registry : null;
}

function canDeferVirtualCodexTool(meta = null, registry = null) {
  return meta?.kind === "virtual_codex_subagent" && meta.proxyHosted === true && Boolean(registry?.byName?.tool_search);
}

function isProxyHostedVirtualCodexTool(meta = null) {
  return meta?.kind === "virtual_codex_subagent" && meta.proxyHosted === true;
}

function codexVirtualDiscoveryArguments(meta = null, name = "") {
  return JSON.stringify({
    query: meta?.discoveryQuery || name || "spawn_agent",
    limit: 8,
  });
}

function codexVirtualDispatch(meta = null, name = "", argumentsText = "{}", registry = null) {
  if (canDeferVirtualCodexTool(meta, registry)) {
    return {
      name: "tool_search",
      arguments: codexVirtualDiscoveryArguments(meta, name),
      deferred: true,
    };
  }
  return {
    name: meta?.responseName || name,
    arguments: argumentsText || "{}",
    deferred: false,
  };
}

// Codex routes a tool call by a SEPARATE (namespace, name) pair, not a qualified
// name: ResponseItem::FunctionCall carries a `namespace` field and tool names must
// match ^[a-zA-Z0-9_-]+$. For a namespace tool the proxy forwarded a flat name to
// the provider, so on the way back we re-attach the namespace and emit the bare
// child name. Reserved Responses API namespaces (multi_agent_v1, codex_app) are
// derived from the dotted native target used for proxy-injected virtual tools.
function codexResponseToolIdentity(meta = null, fallbackName = "") {
  if (meta?.kind === "namespace_function" && meta.namespace) {
    return { name: meta.childName || fallbackName, namespace: meta.namespace };
  }
  const nativeTarget = String(meta?.nativeTarget || meta?.responseName || "");
  if (meta?.kind === "virtual_codex_subagent" && nativeTarget.includes(".")) {
    const dot = nativeTarget.indexOf(".");
    return { name: nativeTarget.slice(dot + 1), namespace: nativeTarget.slice(0, dot) };
  }
  return { name: fallbackName, namespace: undefined };
}

function customInputFromArguments(argumentsText = "") {
  const raw = String(argumentsText || "");
  try {
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of ["input", "patch", "content", "text", "code", "command"]) {
        if (typeof parsed[key] === "string") return parsed[key];
      }
    }
  } catch {}
  return raw;
}

function responseToolNames(tools = []) {
  const names = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object") continue;
    const name = tool?.function?.name || tool?.name || tool?.server_label || tool?.type;
    if (name) names.push(String(name));
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        const childName = child?.function?.name || child?.name;
        if (childName) names.push(String(childName));
      }
    }
  }
  return names;
}

function responseToolsLogSuffix(tools = []) {
  const names = responseToolNames(tools);
  if (!names.length) return "";
  const preview = names.slice(0, 24).join(",");
  return ` tool_names=${preview}${names.length > 24 ? `,+${names.length - 24}` : ""}`;
}

function responseOriginalToolsLogSuffix(tools = []) {
  const names = responseToolNames(tools);
  if (!names.length) return "";
  const preview = names.slice(0, 24).join(",");
  return ` request_tool_names=${preview}${names.length > 24 ? `,+${names.length - 24}` : ""}`;
}

function writeDevResponsesSnapshot({ request = {}, chatReq = {}, fullReq = {}, client = "", mode = "stream" } = {}) {
  if (!state.DEV_MODE) return;
  const originalToolNames = responseToolNames(request.tools);
  const translatedToolNames = responseToolNames(chatReq.tools);
  const registry = responseToolRegistry(chatReq) || responseToolRegistry(fullReq);
  state.log(`RESPONSES-TOOL-NAMES: mode=${mode} original=${JSON.stringify(originalToolNames)} translated=${JSON.stringify(translatedToolNames)}`);
  if (registry?.unsupported?.length) {
    state.log(`RESPONSES-TOOL-UNSUPPORTED: ${JSON.stringify(registry.unsupported.slice(0, 12))}`);
  }
  if (registry?.duplicates?.length) {
    state.log(`RESPONSES-TOOL-DUPLICATE: ${JSON.stringify(registry.duplicates.slice(0, 12))}`);
  }
  try {
    fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-responses-request.json"), JSON.stringify({
      ts: new Date().toISOString(),
      mode,
      client,
      requested_model: request.model || "",
      mapped_model: chatReq.model || "",
      input_items: responseInputItems(request.input).length,
      messages: fullReq.messages?.length || chatReq.messages?.length || 0,
      original_tool_names: originalToolNames,
      translated_tool_names: translatedToolNames,
      tool_registry: registry,
      capability_contract: chatReq._llmProxyCapabilityContract,
      raw_request: request,
    }, null, 2));
  } catch {}

  // Dedicated Codex capture: the snapshot above is overwritten on every Responses
  // request (incl. tool-less auto-memory calls), so a Codex session's tool list is
  // quickly clobbered. Persist a separate file only when the request looks like a
  // Codex tool request, so it survives later tool-less requests for diagnosis.
  try {
    const looksCodex = client === "codex" || originalToolNames.some((name) =>
      /^(?:multi_agent_v1|codex_app)\b/i.test(String(name)) ||
      ["update_plan", "exec_command", "tool_search", "read_thread", "read_thread_terminal"].includes(String(name)),
    );
    if (looksCodex && (request.tools?.length || originalToolNames.length)) {
      state.log(`RESPONSES-CODEX-CAPTURE: wrote dev-last-codex-request.json client=${client} tools=${originalToolNames.length}`);
      fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-codex-request.json"), JSON.stringify({
        ts: new Date().toISOString(),
        mode,
        client,
        requested_model: request.model || "",
        mapped_model: chatReq.model || "",
        original_tool_names: originalToolNames,
        translated_tool_names: translatedToolNames,
        tool_registry: registry,
        raw_tools: request.tools,
      }, null, 2));
    }
  } catch {}
}

function translatedToolNameSet(tools = []) {
  return new Set((tools || []).map((tool) => tool?.function?.name || tool?.name).filter(Boolean));
}

function translateToolChoice(toolChoice, tools = []) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  const names = translatedToolNameSet(tools);
  if (toolChoice.type === "function" && toolChoice.name) {
    if (names.size > 0 && !names.has(toolChoice.name)) return undefined;
    return { type: "function", function: { name: toolChoice.name } };
  }
  if ((toolChoice.type === "custom" || isHostedResponsesTool(toolChoice)) && toolChoice.name) {
    if (names.size > 0 && !names.has(toolChoice.name)) return undefined;
    return { type: "function", function: { name: toolChoice.name } };
  }
  if (toolChoice.type === "allowed_tools") {
    const allowedNames = (toolChoice.tools || [])
      .map((tool) => tool?.name || tool?.function?.name)
      .filter((name) => name && names.has(name));
    if (allowedNames.length === 0) return undefined;
    if (allowedNames.length === 1) {
      return { type: "function", function: { name: allowedNames[0] } };
    }
    return toolChoice.mode === "required" ? "required" : "auto";
  }
  return toolChoice;
}

function responseFormatFromRequest(request = {}) {
  const format = request.response_format || request.text?.format || request.text_format;
  if (!format) return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type !== "json_schema") return format;
  if (format.json_schema) return format;

  return {
    type: "json_schema",
    json_schema: {
      name: format.name || "response",
      schema: format.schema || format.parameters || {},
      strict: format.strict,
    },
  };
}

function schemaType(schema = {}) {
  const type = schema.type;
  if (Array.isArray(type)) return type[0];
  return type;
}

function resolveSchema(schema = {}, root = schema) {
  if (!schema?.$ref || typeof schema.$ref !== "string") return schema || {};
  const match = schema.$ref.match(/^#\/\$defs\/(.+)$/);
  if (!match) return schema;
  return root.$defs?.[match[1]] || schema;
}

function jsonCandidatesFromText(text) {
  const withoutAssessment = routingPolicy.stripDifficultyMarkerFromText(String(text || "")).content;
  const stripped = routingPolicy.stripTaskStatusMarkerFromText(withoutAssessment).content.trim();
  const candidates = [stripped];
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const firstObject = stripped.indexOf("{");
  const lastObject = stripped.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(stripped.slice(firstObject, lastObject + 1));
  const firstArray = stripped.indexOf("[");
  const lastArray = stripped.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(stripped.slice(firstArray, lastArray + 1));
  return [...new Set(candidates.filter(Boolean))];
}

const PRIVATE_MARKER_PREFIXES = [
  "LLM_PROXY_INTERNAL_ROUTING",
  "LLM_PROXY_TASK_DIFFICULTY",
  "LLM_PROXY_TASK_STATUS",
  "LLM_PROXY_MEMORY",
  "LLM_PROXY_RECALL",
];

function stripPrivateMarkersFromText(text = "") {
  const withoutAssessment = routingPolicy.stripDifficultyMarkerFromText(String(text || "")).content;
  const withoutTaskStatus = routingPolicy.stripTaskStatusMarkerFromText(withoutAssessment).content;
  return hiddenMemoryMarkers.stripHiddenMemoryMarkers(withoutTaskStatus).content;
}

function maybePrivateMarkerFragment(text = "") {
  const trimmed = String(text || "").trimStart().replace(/^\[\s*/, "");
  if (!trimmed) return true;
  const upper = trimmed.toUpperCase();
  if (PRIVATE_MARKER_PREFIXES.some((prefix) => prefix.startsWith(upper) || upper.startsWith(prefix))) return true;
  if (routingPolicy.maybeLegacyBareDifficultyMarkerFragment(trimmed)) return true;
  if (routingPolicy.maybeTaskStatusMarkerFragment(trimmed)) return true;
  return /^\s*LLM_PROXY_(?:INTERNAL_ROUTING|TASK_DIFFICULTY|TASK_STATUS)\b[^\r\n]*$/i.test(trimmed);
}

function parseJsonLoose(text) {
  for (const candidate of jsonCandidatesFromText(text)) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {}
  }
  return { ok: false, value: null };
}

function normalizedKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findAliasKey(object, propertyName, propertySchema = {}) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  if (Object.prototype.hasOwnProperty.call(object, propertyName)) return propertyName;

  const target = normalizedKey(propertyName);
  for (const key of Object.keys(object)) {
    const normalized = normalizedKey(key);
    if (normalized === target || normalized.endsWith(target)) return key;
  }

  if (schemaType(propertySchema) === "array") {
    const arrayKeys = Object.keys(object).filter((key) => Array.isArray(object[key]));
    if (arrayKeys.length === 1) return arrayKeys[0];
  }
  return null;
}

function arrayPropertyForWrappedValue(schema = {}, root = schema) {
  const resolved = resolveSchema(schema, root);
  const properties = resolved.properties || {};
  const required = resolved.required || [];
  const requiredArray = required.find((key) => schemaType(resolveSchema(properties[key], root)) === "array");
  if (requiredArray) return requiredArray;
  const arrayKeys = Object.keys(properties).filter((key) => schemaType(resolveSchema(properties[key], root)) === "array");
  return arrayKeys.length === 1 ? arrayKeys[0] : null;
}

function repairValueForSchema(value, schema = {}, root = schema) {
  const resolved = resolveSchema(schema, root);
  const type = schemaType(resolved);

  if (type === "object") {
    const properties = resolved.properties || {};
    if (Array.isArray(value)) {
      const arrayKey = arrayPropertyForWrappedValue(resolved, root);
      if (arrayKey) value = { [arrayKey]: value };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;

    const repaired = resolved.additionalProperties === false ? {} : { ...value };
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const aliasKey = findAliasKey(value, propertyName, resolveSchema(propertySchema, root));
      if (!aliasKey) continue;
      repaired[propertyName] = repairValueForSchema(value[aliasKey], propertySchema, root);
    }
    return repaired;
  }

  if (type === "array") {
    if (!Array.isArray(value)) return value;
    const itemSchema = resolveSchema(resolved.items || {}, root);
    return value.map((item) => repairValueForSchema(item, itemSchema, root));
  }

  return value;
}

function defaultValueForSchema(schema = {}, root = schema) {
  const resolved = resolveSchema(schema, root);
  const type = schemaType(resolved);

  if (type === "object") {
    const properties = resolved.properties || {};
    const result = {};
    for (const propertyName of resolved.required || []) {
      result[propertyName] = defaultValueForSchema(properties[propertyName] || {}, root);
    }
    return result;
  }

  if (type === "array") return [];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

function objectArrayPropertyWithEntityType(schema = {}, root = schema) {
  const resolved = resolveSchema(schema, root);
  if (schemaType(resolved) !== "object") return null;
  const properties = resolved.properties || {};
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const prop = resolveSchema(propertySchema, root);
    if (schemaType(prop) !== "array") continue;
    const item = resolveSchema(prop.items || {}, root);
    const itemProperties = item.properties || {};
    if (schemaType(item) === "object" && itemProperties.name && itemProperties.entity_type_id) {
      return propertyName;
    }
  }
  return null;
}

function structuredValueFromText(text, schema = {}) {
  const entityArrayKey = objectArrayPropertyWithEntityType(schema, schema);
  if (!entityArrayKey) return null;
  const rows = [];
  const lineRe = /^\s*[-*]\s*(.+?)\s*\(\s*entity_type_id\s*=\s*(\d+)\s*\)\s*$/gim;
  let match;
  while ((match = lineRe.exec(String(text || ""))) !== null) {
    rows.push({
      name: match[1].trim(),
      entity_type_id: Number.parseInt(match[2], 10),
    });
  }
  return rows.length > 0 ? { [entityArrayKey]: rows } : null;
}

function normalizeStructuredOutputText(text, request = {}) {
  const stripped = sanitizeVisibleAssistantText(text);
  const responseFormat = responseFormatFromRequest(request);
  const schema = responseFormat?.json_schema?.schema;
  if (!schema) return stripped;

  const parsed = parseJsonLoose(stripped);
  if (!parsed.ok) {
    const structured = structuredValueFromText(stripped, schema);
    return JSON.stringify(structured || defaultValueForSchema(schema, schema));
  }
  return JSON.stringify(repairValueForSchema(parsed.value, schema, schema));
}

function responseInputItems(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (input && typeof input === "object") return [input];
  return [];
}

function translateInput(request = {}, options = {}) {
  const messages = [];
  const model = mapModel(request.model);
  const callNames = {};
  const stream = options.stream == null ? true : options.stream === true;
  const client = String(options.client || ideCapabilities.detectIdeClient(request, { headers: options.headers }).id || "").trim();
  const capabilityOptions = { headers: options.headers, client };
  const toolRegistry = createToolRegistry();

  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }

  for (const item of responseInputItems(request.input)) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "message") {
      messages.push({
        role: normalizeRole(item.role),
        content: mediaContent.toOpenAIChatContent(item.content),
      });
      continue;
    }

    if (!item.type && (item.role || Object.prototype.hasOwnProperty.call(item, "content"))) {
      messages.push({
        role: normalizeRole(item.role),
        content: mediaContent.toOpenAIChatContent(item.content),
        ...(item.name ? { name: item.name } : {}),
        ...(item.tool_call_id ? { tool_call_id: item.tool_call_id } : {}),
        ...(Array.isArray(item.tool_calls) ? { tool_calls: item.tool_calls } : {}),
      });
      continue;
    }

    if (item.type === "function_call") {
      // Codex replays a namespaced tool call as a bare `name` plus a separate
      // `namespace` field. The provider only knows the flat forwarded name, so we
      // forward `item.name` as-is and drop the namespace (it is re-attached on the
      // way back out via codexResponseToolIdentity).
      callNames[item.call_id] = item.name;
      const toolCall = {
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments || "{}",
        },
      };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "assistant" && Array.isArray(prev.tool_calls)) {
        prev.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }

    if (item.type === "custom_tool_call") {
      callNames[item.call_id] = item.name;
      const toolCall = {
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: JSON.stringify({ input: item.input || "" }),
        },
      };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "assistant" && Array.isArray(prev.tool_calls)) {
        prev.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        name: callNames[item.call_id] || item.name || "unknown_tool",
        content: sanitizeVisibleAssistantText(typeof item.output === "string" ? item.output : JSON.stringify(item.output)),
      });
      continue;
    }

    if (item.type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        name: callNames[item.call_id] || item.name || "unknown_tool",
        content: sanitizeVisibleAssistantText(typeof item.output === "string" ? item.output : JSON.stringify(item.output)),
      });
      continue;
    }

    if (item.type !== "item_reference") {
      state.log(`RESPONSES: unknown input item type: ${item.type}`);
    }
  }

  let tools = dedupeTranslatedTools((request.tools || []).flatMap((tool) => translateTool(tool, toolRegistry, {
    client,
  })).filter(Boolean), toolRegistry);
  let capabilityRequest = codexCapabilityRequestWithoutBareVirtuals(request, client);
  if (shouldInjectCodexVirtualSubagentTools(request, client)) {
    const injected = virtualCodexSubagentTools(tools, toolRegistry, request);
    if (injected.length > 0) {
      tools = dedupeTranslatedTools([...tools, ...injected], toolRegistry);
      const proxyHosted = injected
        .map((tool) => tool.function.name)
        .filter((name) => toolRegistry.byName?.[name]?.proxyHosted === true);
      if (proxyHosted.length > 0) {
        state.log(`RESPONSES-CODEX-VIRTUAL-SUBAGENTS: proxy_hosted=${proxyHosted.join(",")}`);
      }
      const native = injected
        .map((tool) => tool.function.name)
        .filter((name) => toolRegistry.byName?.[name]?.proxyHosted === false);
      if (native.length > 0) {
        state.log(`RESPONSES-CODEX-VIRTUAL-SUBAGENTS: native_passthrough=${native.join(",")}`);
      }
    }
    const shadowed = shadowCodexVirtualSubagentTools(tools, toolRegistry, request);
    if (shadowed.length > 0) {
      state.log(`RESPONSES-CODEX-VIRTUAL-SUBAGENTS: shadowed=${shadowed.join(",")} via=tool_search`);
    }
    const hasNativeCodexSubagent = Boolean((capabilityRequest.tools || []).some((tool) => {
      const name = String(tool?.name || "");
      return /^multi_agent_v1(?:[._]|$)/i.test(name) || /^codex_app(?:[._]|$)/i.test(name);
    }));
    if (!hasNativeCodexSubagent) {
      const capabilityVirtualTools = codexVirtualCanonicalTools()
        .filter((name) => {
          const meta = toolRegistry.byName?.[name];
          if (meta?.proxyHosted === true) return true;
          return !toolRegistry.byName?.[codexVirtualToolTarget(name)];
        })
        .map((name) => ({
          type: "function",
          name,
          parameters: codexVirtualToolSchema(name),
        }));
      capabilityRequest = {
        ...capabilityRequest,
        tools: [
          ...(capabilityRequest.tools || []),
          ...capabilityVirtualTools,
        ],
      };
    }
  }
  const responseFormat = responseFormatFromRequest(request);
  const translated = {
    model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    response_format: responseFormat,
    max_tokens: request.max_output_tokens || request.max_tokens || 16384,
    stream,
  };
  const toolChoice = translateToolChoice(request.tool_choice, tools);
  if (toolChoice !== undefined) translated.tool_choice = toolChoice;
  if (request.parallel_tool_calls !== undefined) translated.parallel_tool_calls = request.parallel_tool_calls;
  if (client) translated._llmProxyClient = client;
  translated._llmProxyRuntimeProfile = ideCapabilities.detectRuntimeProfile(capabilityRequest, capabilityOptions);
  translated._llmProxyCapabilityContract = ideCapabilities.buildForwardedCapabilityContract(capabilityRequest, capabilityOptions);
  attachResponsesToolRegistry(translated, toolRegistry);
  if (translated._llmProxyCapabilityContract?.capabilities && Array.isArray(translated._llmProxyCapabilityContract.capabilities.subagents)) {
    const originalSubagents = translated._llmProxyCapabilityContract.capabilities.subagents.slice();
    translated._llmProxyCapabilityContract.capabilities.subagents = originalSubagents.filter((name) => {
      const meta = toolRegistry.byName?.[name];
      if (!meta) return true;
      if (meta.shadowOnly === true) return false;
      return true;
    });
  }
  return translated;
}

class CaptureResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.body = "";
  }

  setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headersSent = true;
    for (const [key, value] of Object.entries(headers || {})) {
      this.headers[String(key).toLowerCase()] = value;
    }
  }

  write(chunk) {
    this.body += chunk == null ? "" : chunk.toString();
  }

  end(chunk) {
    if (chunk) this.write(chunk);
  }
}

class MockResponse {
  constructor(onEvent, onError, onDone, options = {}) {
    this.onEvent = onEvent;
    this.onError = onError;
    this.onDone = onDone;
    this._client = String(options.client || "").toLowerCase();
    this._toolRegistry = options.toolRegistry || null;
    this.statusCode = null;
    this.headersSent = false;
    this._buffer = "";
    this._responseId = genId("resp");
    this._msgItemId = null;
    this._messageOutputIndex = null;
    this._contentStarted = false;
    this._textContent = "";
    this._toolCalls = {};
    this._toolCallOrder = [];
    this._usage = null;
    this._pendingPrivateText = "";
    this._deferredCodexText = "";
    this._sawToolCall = false;
    this._ended = false;
  }

  setHeader() {}

  writeHead(status) {
    if (this._ended) return;
    this.statusCode = status;
    this.headersSent = true;
    if (status >= 400) return;
    this.onEvent({
      type: "response.created",
      response: {
        id: this._responseId,
        object: "response",
        status: "in_progress",
        output: [],
      },
    });
  }

  _toolMeta(name = "") {
    return this._toolRegistry?.byName?.[name] || null;
  }

  _virtualDispatch(name = "", argumentsText = "{}") {
    return codexVirtualDispatch(this._toolMeta(name), name, argumentsText, this._toolRegistry);
  }

  _isCustomTool(name = "") {
    return this._toolMeta(name)?.kind === "custom";
  }

  _toolInput(entry = {}) {
    return this._isCustomTool(entry.name) ? customInputFromArguments(entry.arguments || "") : entry.arguments || "{}";
  }

  _toolAddedItem(callId, entry = {}) {
    if (this._isCustomTool(entry.name)) {
      return {
        id: entry.itemId,
        type: "custom_tool_call",
        call_id: callId,
        name: entry.name,
        input: "",
      };
    }
    return {
      id: entry.itemId,
      type: "function_call",
      call_id: callId,
      name: entry.name,
      ...(entry.namespace ? { namespace: entry.namespace } : {}),
      arguments: "",
    };
  }

  _toolDoneItem(callId, entry = {}) {
    if (this._isCustomTool(entry.name)) {
      return {
        id: entry.itemId,
        type: "custom_tool_call",
        call_id: callId,
        name: entry.name,
        input: this._toolInput(entry),
        status: "completed",
      };
    }
    return {
      id: entry.itemId,
      type: "function_call",
      call_id: callId,
      name: entry.name,
      ...(entry.namespace ? { namespace: entry.namespace } : {}),
      arguments: entry.arguments,
      status: "completed",
    };
  }

  write(chunk) {
    if (this._ended) return;
    if (this.statusCode >= 400) {
      this._buffer += chunk;
      return;
    }

    this._buffer += chunk.toString();
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        this._handleStreamDone();
        continue;
      }

      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (parsed.usage) this._usage = parsed.usage;

      this._handleTextDelta(choice.delta);
      this._handleToolDeltas(choice.delta);
      this._handleFinish(choice.finish_reason);
    }
  }

  _handleStreamDone() {
    if (this._client === "codex" && this._sawToolCall) {
      this._deferredCodexText = "";
    }
    this._emitSanitizedText("", true);
    if (this._sawToolCall) this._finalizeToolCalls();
  }

  _handleTextDelta(delta = {}) {
    if (!delta.content) return;
    if (this._client === "codex") {
      this._deferredCodexText += String(delta.content || "");
      return;
    }
    this._emitSanitizedText(delta.content);
  }

  _emitText(text) {
    if (!text) return;
    if (!this._contentStarted) {
      this._contentStarted = true;
      this._msgItemId = genId("msg");
      this._messageOutputIndex = 0;
      this.onEvent({
        type: "response.output_item.added",
        output_index: this._messageOutputIndex,
        item: {
          id: this._msgItemId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      });
    }
    this._textContent += text;
    this.onEvent({
      type: "response.output_text.delta",
      item_id: this._msgItemId,
      output_index: this._messageOutputIndex,
      content_index: 0,
      delta: text,
    });
  }

  _emitSanitizedText(text, flush = false) {
    this._pendingPrivateText += String(text || "");
    let output = "";

    while (true) {
      const newlineIndex = this._pendingPrivateText.search(/\r?\n/);
      if (newlineIndex < 0) break;
      const newlineLength = this._pendingPrivateText[newlineIndex] === "\r" ? 2 : 1;
      const line = this._pendingPrivateText.slice(0, newlineIndex + newlineLength);
      this._pendingPrivateText = this._pendingPrivateText.slice(newlineIndex + newlineLength);
      output += stripPrivateMarkersFromText(line);
    }

    if (this._pendingPrivateText) {
      if (flush || !maybePrivateMarkerFragment(this._pendingPrivateText)) {
        output += stripPrivateMarkersFromText(this._pendingPrivateText);
        this._pendingPrivateText = "";
      }
    }

    // Apply full artifact stripping to catch multi-line <task-notification> blocks
    const finalOutput = stripResponseProxyArtifacts(output).text;
    this._emitText(finalOutput);
  }

  _handleToolDeltas(delta = {}) {
    if (!Array.isArray(delta.tool_calls)) return;
    if (delta.tool_calls.length > 0) this._sawToolCall = true;
    for (const tc of delta.tool_calls) {
      const index = tc.index || 0;
      const outputIndex = (this._contentStarted ? 1 : 0) + index;
      const callId = tc.id || this._toolCallOrder[index] || genId("call");
      if (!this._toolCalls[callId]) {
        const requestedName = tc.function?.name || "";
        const dispatch = this._virtualDispatch(requestedName, "");
        const identity = dispatch.deferred
          ? { name: dispatch.name }
          : codexResponseToolIdentity(this._toolMeta(requestedName), requestedName);
        this._toolCallOrder[index] = callId;
        this._toolCalls[callId] = {
          name: identity.name || requestedName,
          namespace: identity.namespace,
          requestedName,
          arguments: dispatch.deferred ? dispatch.arguments : "",
          deferredVirtual: dispatch.deferred === true,
          virtualArguments: "",
          itemId: genId("fc"),
          outputIndex,
          done: false,
        };
        this.onEvent({
          type: "response.output_item.added",
          output_index: outputIndex,
          item: this._toolAddedItem(callId, this._toolCalls[callId]),
        });
      }

      const entry = this._toolCalls[callId];
      if (tc.function?.name && !entry.requestedName) {
        const dispatch = this._virtualDispatch(tc.function.name, entry.arguments || "");
        const identity = dispatch.deferred
          ? { name: dispatch.name }
          : codexResponseToolIdentity(this._toolMeta(tc.function.name), tc.function.name);
        entry.name = identity.name || tc.function.name;
        entry.namespace = identity.namespace;
        entry.requestedName = tc.function.name;
        entry.deferredVirtual = dispatch.deferred === true;
        if (dispatch.deferred) entry.arguments = dispatch.arguments;
      }
      if (tc.function?.arguments) {
        if (entry.deferredVirtual) {
          entry.virtualArguments += tc.function.arguments;
          continue;
        }
        entry.arguments += tc.function.arguments;
        if (!this._isCustomTool(entry.name)) {
          this.onEvent({
            type: "response.function_call_arguments.delta",
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            call_id: callId,
            delta: tc.function.arguments,
          });
        }
      }
    }
  }

  _handleFinish(finishReason) {
    if (!finishReason) return;
    if (this._client === "codex" && !this._sawToolCall && this._deferredCodexText) {
      this._emitSanitizedText(this._deferredCodexText, true);
      this._deferredCodexText = "";
    } else if (this._client === "codex" && this._sawToolCall) {
      this._deferredCodexText = "";
    }
    this._emitSanitizedText("", true);

    if ((finishReason === "stop" || finishReason === "tool_calls") && this._msgItemId) {
      this.onEvent({
        type: "response.output_text.done",
        item_id: this._msgItemId,
        output_index: this._messageOutputIndex,
        content_index: 0,
        text: this._textContent,
      });
      this.onEvent({
        type: "response.output_item.done",
        output_index: this._messageOutputIndex,
        item: {
          id: this._msgItemId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: this._textContent }],
          status: "completed",
        },
      });
    }

    if (finishReason === "tool_calls" || this._sawToolCall) this._finalizeToolCalls();
  }

  _finalizeToolCalls() {
    for (let index = 0; index < this._toolCallOrder.length; index++) {
      const callId = this._toolCallOrder[index];
      const entry = this._toolCalls[callId];
      if (!entry || entry.done) continue;
      entry.done = true;
      if (this._isCustomTool(entry.name)) {
        this.onEvent({
          type: "response.custom_tool_call_input.done",
          item_id: entry.itemId,
          output_index: entry.outputIndex,
          call_id: callId,
          name: entry.name,
          input: this._toolInput(entry),
        });
      } else {
        this.onEvent({
          type: "response.function_call_arguments.done",
          item_id: entry.itemId,
          output_index: entry.outputIndex,
          call_id: callId,
          name: entry.name,
          arguments: entry.arguments,
        });
      }
      this.onEvent({
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: this._toolDoneItem(callId, entry),
      });
    }
  }

  end(body) {
    if (this._ended) return;
    this._ended = true;
    if (this.statusCode >= 400) {
      this.onError(this.statusCode, (this._buffer || "") + (body || ""));
      this.onDone();
      return;
    }

    if (this._client === "codex" && !this._sawToolCall && this._deferredCodexText) {
      this._emitSanitizedText(this._deferredCodexText, true);
      this._deferredCodexText = "";
    } else if (this._client === "codex" && this._sawToolCall) {
      this._deferredCodexText = "";
    }
    this._emitSanitizedText("", true);
    if (this._sawToolCall) this._finalizeToolCalls();

    const output = [];
    if (this._msgItemId) {
      output.push({
        id: this._msgItemId,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: this._textContent }],
        status: "completed",
      });
    }
    for (const callId of this._toolCallOrder) {
      const entry = this._toolCalls[callId];
      if (!entry) continue;
      output.push(this._toolDoneItem(callId, entry));
    }

    this.onEvent({
      type: "response.completed",
      response: {
        id: this._responseId,
        object: "response",
        status: "completed",
        output,
        usage: this._usage ? {
          input_tokens: this._usage.prompt_tokens || 0,
          output_tokens: this._usage.completion_tokens || 0,
          total_tokens: this._usage.total_tokens || 0,
        } : undefined,
      },
    });
    this.onDone();
  }
}

function appendAssistantToHistory(history, mockRes) {
  if (!history) return;
  const sanitizedText = sanitizeVisibleAssistantText(mockRes._textContent || "");
  if (mockRes._toolCallOrder.length > 0) {
    history.push({
      role: "assistant",
      content: mockRes._client === "codex" ? null : (sanitizedText || null),
      tool_calls: mockRes._toolCallOrder.map((callId) => {
        const entry = mockRes._toolCalls[callId];
        return { id: callId, type: "function", function: { name: entry.name, arguments: entry.arguments } };
      }),
    });
  } else if (sanitizedText) {
    history.push({ role: "assistant", content: sanitizedText });
  }
}

function cloneJson(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry));
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = cloneJson(entry);
    return out;
  }
  return value;
}

function cloneMessages(messages = []) {
  return cloneJson(messages || []);
}

function messageApproxChars(message = {}) {
  let total = 0;
  if (typeof message.content === "string") total += message.content.length;
  else if (Array.isArray(message.content)) total += contentToText(message.content).length;
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      total += String(toolCall?.function?.name || "").length;
      total += String(toolCall?.function?.arguments || "").length;
    }
  }
  if (message.function_call) {
    total += String(message.function_call.name || "").length;
    total += String(message.function_call.arguments || "").length;
  }
  if (message.role === "tool") total += String(message.name || "").length + String(message.tool_call_id || "").length;
  return total;
}

function trimStoredMessages(messages = [], options = {}) {
  const maxMessages = Math.max(4, Number(options.maxMessages || MAX_RESPONSE_HISTORY_MESSAGES) || MAX_RESPONSE_HISTORY_MESSAGES);
  const maxChars = Math.max(1_000, Number(options.maxChars || MAX_RESPONSE_HISTORY_CHARS) || MAX_RESPONSE_HISTORY_CHARS);
  const source = Array.isArray(messages) ? messages : [];
  if (source.length === 0) return [];

  const first = source[0];
  const preserveSystem = first?.role === "system";
  const tail = preserveSystem ? source.slice(1) : [...source];
  const kept = [];
  let chars = preserveSystem ? messageApproxChars(first) : 0;

  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const message = tail[i];
    const messageChars = messageApproxChars(message);
    const projectedCount = kept.length + (preserveSystem ? 1 : 0) + 1;
    const projectedChars = chars + messageChars;
    if (kept.length > 0 && (projectedCount > maxMessages || projectedChars > maxChars)) break;
    kept.push(message);
    chars = projectedChars;
  }

  kept.reverse();
  return preserveSystem ? [first, ...kept] : kept;
}

function assistantMessageFromChatCompletion(openai = {}, options = {}) {
  const message = openai.choices?.[0]?.message || null;
  if (!message) return null;
  const suppressVisibleText = shouldSuppressVisibleTextForToolCalls(message, options);
  const sanitizedContent = suppressVisibleText ? null : sanitizeVisibleAssistantText(message.content ?? "");
  const out = { role: "assistant", content: sanitizedContent || null };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls.map((toolCall) => ({
      id: toolCall.id || genId("call"),
      type: toolCall.type || "function",
      function: {
        name: toolCall.function?.name || "unknown_tool",
        arguments: toolCall.function?.arguments || "{}",
      },
    }));
  }
  return out.content != null || out.tool_calls?.length ? out : null;
}

function rememberResponseHistory(responseId, messages = [], context = {}) {
  if (!responseId) return;
  const sanitizedMessages = (messages || []).map(sanitizeReplayMessage);
  const trimmedMessages = trimStoredMessages(sanitizedMessages);
  responseHistory.set(responseId, {
    taskId: context._llmProxyTaskId,
    messages: cloneMessages(trimmedMessages),
    tools: cloneJson(context.tools),
    responsesToolRegistry: cloneJson(responseToolRegistry(context)),
    tool_choice: cloneJson(context.tool_choice),
    function_call: cloneJson(context.function_call),
    parallel_tool_calls: cloneJson(context.parallel_tool_calls),
  });
  while (responseHistory.size > MAX_RESPONSE_HISTORY) {
    responseHistory.delete(responseHistory.keys().next().value);
  }
}

function responseContextForPreviousResponse(request = {}) {
  const previousId = request.previous_response_id || request.previousResponseId;
  if (!previousId) return null;
  const record = responseHistory.get(previousId);
  if (!record) {
    state.log(`RESPONSES-HISTORY-MISS: previous_response_id=${previousId}`);
    return null;
  }
  if (Array.isArray(record)) {
    return { messages: cloneMessages(record) };
  }
  return {
    messages: cloneMessages(record.messages || []),
    tools: cloneJson(record.tools),
    responsesToolRegistry: cloneJson(record.responsesToolRegistry),
    tool_choice: cloneJson(record.tool_choice),
    function_call: cloneJson(record.function_call),
    parallel_tool_calls: cloneJson(record.parallel_tool_calls),
  };
}

function hydrateInheritedToolContext(chatReq = {}, previousContext = null) {
  if (!previousContext) return chatReq;
  if (previousContext.taskId) chatReq._llmProxyTaskId = previousContext.taskId;
  const hadTools = (chatReq.tools?.length || 0) > 0;
  if (!hadTools && previousContext.tools?.length) {
    chatReq.tools = cloneJson(previousContext.tools);
    state.log(`RESPONSES-TOOLS-HIT: inherited ${chatReq.tools.length} tool schema(s) from previous_response_id`);
  }
  const currentRegistry = responseToolRegistry(chatReq);
  if ((!currentRegistry || (currentRegistry.names || []).length === 0) && previousContext.responsesToolRegistry) {
    attachResponsesToolRegistry(chatReq, cloneJson(previousContext.responsesToolRegistry));
  }
  const hasTools = (chatReq.tools?.length || 0) > 0;
  if (hasTools && chatReq.tool_choice === undefined && previousContext.tool_choice !== undefined) {
    chatReq.tool_choice = cloneJson(previousContext.tool_choice);
  }
  if (hasTools && chatReq.function_call === undefined && previousContext.function_call !== undefined) {
    chatReq.function_call = cloneJson(previousContext.function_call);
  }
  if (hasTools && chatReq.parallel_tool_calls === undefined && previousContext.parallel_tool_calls !== undefined) {
    chatReq.parallel_tool_calls = cloneJson(previousContext.parallel_tool_calls);
  }
  return chatReq;
}

function repairToolOutputNames(messages = []) {
  const callNames = {};
  for (const message of messages || []) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const callId = toolCall?.id;
        const name = toolCall?.function?.name;
        if (callId && name) callNames[callId] = name;
      }
    }
    if (message?.role === "tool" && message.tool_call_id) {
      const recovered = callNames[message.tool_call_id];
      if (recovered && (!message.name || message.name === "unknown_tool")) {
        message.name = recovered;
      }
    }
  }
  return messages;
}

function mergeHistory(chatReq, conversationHistory) {
  if (!conversationHistory) return chatReq.messages;
  if (conversationHistory.length === 0) {
    conversationHistory.push(...chatReq.messages);
    return repairToolOutputNames([...conversationHistory]);
  }

  const systemMsgs = chatReq.messages.filter((m) => m.role === "system");
  const nonSystem = chatReq.messages.filter((m) => m.role !== "system");
  const existingSystem = conversationHistory.find((m) => m.role === "system");
  if (systemMsgs.length > 0 && (!existingSystem || existingSystem.content !== systemMsgs[0].content)) {
    if (existingSystem) existingSystem.content = systemMsgs[0].content;
    else conversationHistory.unshift(systemMsgs[0]);
  }
  conversationHistory.push(...nonSystem);
  const preserveSystem = conversationHistory[0]?.role === "system";
  while (conversationHistory.length > MAX_RESPONSE_HISTORY_MESSAGES) {
    if (preserveSystem && conversationHistory.length > 1) {
      conversationHistory.splice(1, 1);
      continue;
    }
    conversationHistory.shift();
  }
  return repairToolOutputNames([...conversationHistory]);
}

function usageFromChatCompletion(openai = {}) {
  const usage = openai.usage || {};
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
}

function shouldSuppressVisibleTextForToolCalls(message = {}, options = {}) {
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (!hasToolCalls) return false;
  return String(options.client || "").toLowerCase() === "codex";
}

function responseOutputItemFromToolCall(toolCall = {}, options = {}) {
  const name = toolCall.function?.name || "unknown_tool";
  const registry = options.toolRegistry || null;
  const meta = registry?.byName?.[name] || null;
  const callId = toolCall.id || genId("call");
  const dispatch = codexVirtualDispatch(meta, name, toolCall.function?.arguments || "{}", registry);
  if (dispatch.deferred) {
    state.log(`RESPONSES-CODEX-VIRTUAL-DISCOVERY: ${name}->tool_search query=${meta?.discoveryQuery || name}`);
    return {
      id: genId("fc"),
      type: "function_call",
      call_id: callId,
      name: dispatch.name,
      arguments: dispatch.arguments,
      status: "completed",
    };
  }
  if (meta?.kind === "custom") {
    return {
      id: genId("ctc"),
      type: "custom_tool_call",
      call_id: callId,
      name,
      input: customInputFromArguments(toolCall.function?.arguments || ""),
      status: "completed",
    };
  }
  const identity = codexResponseToolIdentity(meta, dispatch.name || name);
  return {
    id: genId("fc"),
    type: "function_call",
    call_id: callId,
    // Bare name + separate `namespace` field, matching codex-rs's routing.
    name: identity.name,
    ...(identity.namespace ? { namespace: identity.namespace } : {}),
    arguments: toolCall.function?.arguments || "{}",
    status: "completed",
  };
}

function chatCompletionToResponse(openai = {}, request = {}, options = {}) {
  const choice = openai.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  let outputText = "";
  const suppressVisibleText = shouldSuppressVisibleTextForToolCalls(message, options);

  if (!suppressVisibleText && message.content != null && message.content !== "") {
    outputText = normalizeStructuredOutputText(contentToText(message.content), request);
    output.push({
      id: genId("msg"),
      type: "message",
      role: message.role || "assistant",
      content: [{ type: "output_text", text: outputText }],
      status: "completed",
    });
  }

  for (const toolCall of message.tool_calls || []) {
    if (toolCall?.type !== "function") continue;
    output.push(responseOutputItemFromToolCall(toolCall, options));
  }

  return {
    id: genId("resp"),
    object: "response",
    created_at: openai.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: request.model || openai.model,
    output,
    output_text: outputText,
    usage: usageFromChatCompletion(openai),
  };
}

function parseToolArguments(argumentsText = "{}") {
  const parsed = parseJsonLoose(argumentsText || "{}");
  if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) return parsed.value;
  return {};
}

function responseFromCaptureBody(body = "") {
  const text = String(body || "").trim();
  if (!text) return null;
  const parsed = parseJsonLoose(text);
  if (parsed.ok) return parsed.value;

  const chunks = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    const chunk = parseJsonLoose(data);
    if (chunk.ok) chunks.push(chunk.value);
  }
  if (chunks.length === 0) return null;

  const message = { role: "assistant", content: "", tool_calls: [] };
  const usage = chunks.find((chunk) => chunk?.usage)?.usage;
  const finishReason = chunks.map((chunk) => chunk?.choices?.[0]?.finish_reason).filter(Boolean).at(-1) || "stop";
  const toolByIndex = new Map();
  for (const chunk of chunks) {
    const delta = chunk?.choices?.[0]?.delta || {};
    if (delta.content) message.content += String(delta.content);
    for (const tc of delta.tool_calls || []) {
      const index = tc.index || 0;
      if (!toolByIndex.has(index)) {
        toolByIndex.set(index, {
          id: tc.id || genId("call"),
          type: "function",
          function: { name: tc.function?.name || "", arguments: "" },
        });
      }
      const existing = toolByIndex.get(index);
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.function.name = tc.function.name;
      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
    }
  }
  message.tool_calls = [...toolByIndex.values()].filter((tc) => tc.function.name);
  if (message.tool_calls.length === 0) delete message.tool_calls;
  if (!message.content) message.content = message.tool_calls ? null : "";
  return {
    id: genId("chatcmpl"),
    model: "auto-coding",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

function splitProxyHostedVirtualToolCalls(openai = {}, registry = null) {
  const calls = openai?.choices?.[0]?.message?.tool_calls || [];
  const proxyHosted = [];
  const passthrough = [];
  for (const toolCall of calls) {
    const name = toolCall?.function?.name || "";
    if (toolCall?.type === "function" && isProxyHostedVirtualCodexTool(registry?.byName?.[name])) {
      proxyHosted.push(toolCall);
      continue;
    }
    passthrough.push(toolCall);
  }
  return { proxyHosted, passthrough };
}

function virtualPromptTextFromArgs(args = {}) {
  if (typeof args.message === "string" && args.message.trim()) return args.message.trim();
  if (typeof args.prompt === "string" && args.prompt.trim()) return args.prompt.trim();
  if (typeof args.task === "string" && args.task.trim()) return args.task.trim();
  if (Array.isArray(args.items)) {
    const text = args.items
      .map((item) => item?.text || item?.content || item?.message || "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return "Inspect the active task context and return a concise useful finding for the main agent.";
}

function parentContextExcerpt(messages = []) {
  const nonTool = (messages || [])
    .filter((message) => message.role !== "tool")
    .slice(-8)
    .map((message) => `${message.role || "unknown"}: ${contentToText(message.content).slice(0, 2000)}`)
    .join("\n\n");
  return nonTool.slice(-8000);
}

async function runProxyHostedVirtualSubagent(args = {}, context = {}) {
  const id = genId("vagent");
  const prompt = virtualPromptTextFromArgs(args);
  const parent = args.fork_context ? parentContextExcerpt(context.messages) : "";
  const activeTask = require("./task-context").current();
  const registry = require("../vendor/llm-orchestrator/registries/agent-roles.json");
  const requestedRole = args.agent_type || args.role || "general";
  const role = registry.roles.some(entry => entry.id === requestedRole) ? requestedRole : "general";
  if (activeTask) await activeTask.runtime.reserveAgent({role,permissions:"RO",files:[]});
  const brief = activeTask ? require("./orchestrator-bridge").buildAgentBrief({
    task: prompt,
    constraints: Array.isArray(args.constraints) ? args.constraints : [],
    acceptance: Array.isArray(args.acceptance) ? args.acceptance : [],
    assignment: { role, permissions: "RO", maxIterations: 1, maxOutputTokens: Math.min(Number(args.max_tokens) || 4096, 8192) },
    evidenceRefs: Array.isArray(args.evidence_refs) ? args.evidence_refs : [],
  }) : null;
  const capture = new CaptureResponse();
  const messages = [
    {
      role: "system",
      content: [
        "You are a proxy-hosted Codex virtual subagent running inside llm-proxy, NOT on the user's machine.",
        "You have NO tool access: no filesystem, no shell/exec, no MCP, no network. You cannot read files or run commands.",
        "Work ONLY from the text provided in the subtask and parent context. If the task needs host filesystem/shell access, say so explicitly and state exactly what input the main agent must inline for you to proceed.",
        "Do NOT attempt tool calls — they will not execute. Return a compact, complete textual finding or answer.",
        ...(brief ? [brief.instructions, "Report what is proven, uncertain, and blocked; never claim to have run host checks."] : []),
      ].join(" "),
    },
    {
      role: "user",
      content: `${parent ? `Parent context excerpt:\n${parent}\n\n` : ""}Subtask:\n${prompt}`,
    },
  ];
  // Deliberately forward NO tools: a proxy-hosted subagent is a single,
  // non-looped completion with no client to execute tool calls (and the proxy
  // runs on a different host than the user's machine). Forwarding host tools
  // only made the model emit unexecutable tool_calls, leaving message.content
  // empty -> the old "No textual result" failure.
  await _handleChatCompletion({
    model: mapModel(args.model) || context.model || "auto-coding",
    messages,
    max_tokens: Math.min(Number(args.max_tokens || 4096) || 4096, 8192),
    stream: false,
    _llmProxyClient: "codex_virtual_subagent",
    ...(activeTask ? { _llmProxyRole: role } : {}),
  }, capture, { headers: context.headers, internal: true });

  let result = "";
  if (capture.statusCode >= 400) {
    result = `Virtual subagent failed with status ${capture.statusCode}: ${capture.body || "unknown error"}`;
  } else {
    const openai = responseFromCaptureBody(capture.body);
    const message = openai?.choices?.[0]?.message || {};
    result = sanitizeVisibleAssistantText(contentToText(message.content || ""));
    if (!result && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const attempted = [...new Set(message.tool_calls.map((tc) => tc?.function?.name).filter(Boolean))].join(", ");
      result = `Proxy-hosted subagents run without host tool access (no filesystem/shell), so the attempted tool call(s) [${attempted}] could not execute. Inline the required data in the spawn_agent message, or run host-affecting work from the main agent.`;
    }
  }
  if (!result) result = "No textual result returned by virtual subagent.";

  const record = {
    id,
    status: "completed",
    agent_type: args.agent_type || "default",
    prompt,
    result,
    created_at: new Date().toISOString(),
  };
  virtualCodexAgents.set(id, record);
  return record;
}

async function executeProxyHostedCodexVirtualTool(name = "", args = {}, context = {}) {
  if (name === "spawn_agent") {
    const record = await runProxyHostedVirtualSubagent(args, context);
    return {
      agent_id: record.id,
      id: record.id,
      status: record.status,
      summary: record.result.slice(0, 1000),
      result: record.result,
      proxy_hosted: true,
    };
  }
  if (name === "wait_agent") {
    const targets = Array.isArray(args.targets) ? args.targets : [args.target || args.id].filter(Boolean);
    return {
      statuses: targets.map((target) => virtualCodexAgents.get(target) || {
        id: target,
        status: "not_found",
        result: "No proxy-hosted virtual agent with this id.",
      }),
      proxy_hosted: true,
    };
  }
  if (name === "close_agent") {
    const target = args.target || args.id;
    const previous = target ? virtualCodexAgents.get(target) : null;
    if (target) virtualCodexAgents.delete(target);
    return { target, previous_status: previous || null, status: "closed", proxy_hosted: true };
  }
  if (name === "send_input" || name === "resume_agent") {
    const target = args.target || args.id;
    const previous = target ? virtualCodexAgents.get(target) : null;
    if (!previous) return { target, status: "not_found", proxy_hosted: true };
    const record = await runProxyHostedVirtualSubagent({
      ...args,
      message: `${previous.prompt}\n\nFollow-up:\n${virtualPromptTextFromArgs(args)}`,
      agent_type: previous.agent_type,
      fork_context: false,
    }, context);
    return { target, status: "completed", result: record.result, proxy_hosted: true };
  }
  if (name === "create_thread") {
    const record = await runProxyHostedVirtualSubagent(args, context);
    const threadId = genId("vthread");
    virtualCodexThreads.set(threadId, {
      id: threadId,
      title: args.title || virtualPromptTextFromArgs(args).slice(0, 80),
      messages: [{ role: "user", content: virtualPromptTextFromArgs(args) }, { role: "assistant", content: record.result }],
    });
    return { thread_id: threadId, id: threadId, status: "completed", result: record.result, proxy_hosted: true };
  }
  if (name === "read_thread") {
    const id = args.thread_id || args.id;
    return virtualCodexThreads.get(id) || { id, status: "not_found", messages: [], proxy_hosted: true };
  }
  if (name === "send_message_to_thread") {
    const id = args.thread_id || args.id;
    const thread = virtualCodexThreads.get(id) || { id, title: id || "virtual thread", messages: [] };
    const message = args.message || virtualPromptTextFromArgs(args);
    const record = await runProxyHostedVirtualSubagent({ message, fork_context: false }, context);
    thread.messages.push({ role: "user", content: message }, { role: "assistant", content: record.result });
    virtualCodexThreads.set(id, thread);
    return { thread_id: id, status: "completed", result: record.result, proxy_hosted: true };
  }
  if (name === "list_threads") {
    return { threads: [...virtualCodexThreads.values()].map((thread) => ({ id: thread.id, title: thread.title })), proxy_hosted: true };
  }
  if (name === "set_thread_pinned" || name === "set_thread_archived" || name === "set_thread_title") {
    const id = args.thread_id || args.id;
    const thread = virtualCodexThreads.get(id) || { id, messages: [] };
    if (name === "set_thread_title") thread.title = args.title || thread.title || id;
    if (name === "set_thread_pinned") thread.pinned = Boolean(args.value);
    if (name === "set_thread_archived") thread.archived = Boolean(args.value);
    virtualCodexThreads.set(id, thread);
    return { thread_id: id, status: "updated", proxy_hosted: true };
  }
  return { status: "unsupported_virtual_tool", name, proxy_hosted: true };
}

async function runChatCompletionWithProxyHostedVirtualTools(fullReq = {}, options = {}) {
  if (_taskRuntime && !require('./task-context').current()) return _taskRuntime.handle(fullReq, null, options, prepared => runChatCompletionWithProxyHostedVirtualToolsCore(prepared, options));
  return runChatCompletionWithProxyHostedVirtualToolsCore(fullReq, options);
}
async function runChatCompletionWithProxyHostedVirtualToolsCore(fullReq = {}, options = {}) {
  const registry = responseToolRegistry(fullReq);
  let currentReq = fullReq;
  const pendingPassthrough = [];
  for (let loop = 0; loop < MAX_PROXY_HOSTED_VIRTUAL_LOOPS; loop++) {
    const capture = new CaptureResponse();
    await _handleChatCompletion({ ...currentReq, stream: false }, capture, { headers: options.headers, internal: true });
    if (capture.statusCode >= 400) return { status: capture.statusCode, body: capture.body, openai: null, messages: currentReq.messages };

    const openai = responseFromCaptureBody(capture.body);
    if (!openai) return { status: 502, body: JSON.stringify({ error: { message: "Invalid upstream response" } }), openai: null, messages: currentReq.messages };

    const { proxyHosted, passthrough } = splitProxyHostedVirtualToolCalls(openai, registry);
    if (proxyHosted.length === 0) {
      if (pendingPassthrough.length > 0) {
        const message = openai?.choices?.[0]?.message;
        if (message) {
          const existing = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          const merged = [...existing];
          for (const call of pendingPassthrough) {
            const exists = merged.some((item) => item?.id === call?.id || (
              item?.function?.name === call?.function?.name && item?.function?.arguments === call?.function?.arguments
            ));
            if (!exists) merged.push(call);
          }
          if (merged.length > 0) message.tool_calls = merged;
        }
      }
      return { status: 200, body: capture.body, openai, messages: currentReq.messages };
    }

    if (passthrough.length > 0) pendingPassthrough.push(...passthrough);
    state.log(`RESPONSES-CODEX-VIRTUAL-HOSTED: executing=${proxyHosted.map((call) => call.function?.name).join(",")} loop=${loop + 1}`);
    const assistantMessage = {
      role: "assistant",
      content: sanitizeVisibleAssistantText(openai.choices?.[0]?.message?.content || "") || null,
      tool_calls: proxyHosted,
    };
    const toolMessages = [];
    for (const call of proxyHosted) {
      const name = call.function?.name || "";
      const args = parseToolArguments(call.function?.arguments || "{}");
      const result = await executeProxyHostedCodexVirtualTool(name, args, {
        headers: options.headers,
        messages: currentReq.messages,
        model: currentReq.model,
        tools: currentReq.tools,
      });
      toolMessages.push({
        role: "tool",
        tool_call_id: call.id || genId("call"),
        name,
        content: sanitizeVisibleAssistantText(JSON.stringify(result)),
      });
    }
    currentReq = {
      ...currentReq,
      messages: [...(currentReq.messages || []), assistantMessage, ...toolMessages],
    };
  }
  return {
    status: 500,
    body: JSON.stringify({ error: { message: "Proxy-hosted Codex virtual subagent loop exceeded limit" } }),
    openai: null,
    messages: currentReq.messages,
  };
}

function shouldUseProxyHostedVirtualLoop(fullReq = {}, client = "") {
  if (String(client || "").toLowerCase() !== "codex") return false;
  const registry = responseToolRegistry(fullReq);
  if (!registry) return false;
  return Object.values(registry.byName || {}).some((meta) => isProxyHostedVirtualCodexTool(meta));
}

function messagesWithAssistantFromOpenAI(messages = [], openai = {}, options = {}) {
  const out = cloneMessages(messages || []);
  const assistant = assistantMessageFromChatCompletion(openai, options);
  if (assistant) out.push(assistant);
  return out;
}

function emitResponseObjectAsEvents(response = {}, emitEvent) {
  const responseId = response.id || genId("resp");
  emitEvent({
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      output: [],
    },
  });

  for (let outputIndex = 0; outputIndex < (response.output || []).length; outputIndex++) {
    const item = response.output[outputIndex];
    if (!item) continue;
    if (item.type === "message") {
      const content = item.content || [];
      const text = content.map((part) => part?.text || "").join("");
      const itemId = item.id || genId("msg");
      emitEvent({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id: itemId,
          type: "message",
          role: item.role || "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      });
      if (text) {
        emitEvent({
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          delta: text,
        });
      }
      emitEvent({
        type: "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text,
      });
      emitEvent({
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          id: itemId,
          type: "message",
          role: item.role || "assistant",
          content: [{ type: "output_text", text }],
          status: "completed",
        },
      });
      continue;
    }
    if (item.type === "function_call") {
      emitEvent({ type: "response.output_item.added", output_index: outputIndex, item: { ...item, arguments: "" } });
      emitEvent({
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments || "{}",
      });
      emitEvent({ type: "response.output_item.done", output_index: outputIndex, item });
      continue;
    }
    emitEvent({ type: "response.output_item.added", output_index: outputIndex, item });
    emitEvent({ type: "response.output_item.done", output_index: outputIndex, item: { ...item, status: item.status || "completed" } });
  }

  emitEvent({
    type: "response.completed",
    response: {
      ...response,
      id: responseId,
      status: "completed",
    },
  });
}

async function processRequest(request, emitEvent, emitError, emitDone, conversationHistory, options = {}) {
  if (!_handleChatCompletion) throw new Error("responses.init() was not called");
  const client = ideCapabilities.detectIdeClient(request, { headers: options.headers }).id;
  const chatReq = translateInput(request, { client, headers: options.headers });
  const previousContext = responseContextForPreviousResponse(request);
  hydrateInheritedToolContext(chatReq, previousContext);
  const activeHistory = conversationHistory || (options.persistResponseHistory ? (previousContext?.messages || []) : previousContext?.messages);
  const messages = mergeHistory(chatReq, activeHistory);
  const fullReq = { ...chatReq, messages, metadata: { ...(request.metadata || {}), ...(chatReq.metadata || {}) } };

  state.log(`RESPONSES: model=${request.model || ""}->${chatReq.model} input=${request.input?.length || 0} items msgs=${messages.length} tools=${chatReq.tools?.length || 0}${responseToolsLogSuffix(chatReq.tools)}${responseOriginalToolsLogSuffix(request.tools)}`);
  writeDevResponsesSnapshot({ request, chatReq, fullReq, client, mode: "stream" });

  if (shouldUseProxyHostedVirtualLoop(fullReq, client)) {
    try {
      const result = await runChatCompletionWithProxyHostedVirtualTools(fullReq, { headers: options.headers });
      if (result.status >= 400) {
        emitError(result.status, result.body || JSON.stringify({ error: { message: "Responses upstream request failed" } }));
        emitDone();
        return;
      }
      const response = chatCompletionToResponse(result.openai, request, { client, toolRegistry: responseToolRegistry(fullReq) });
      const storedMessages = messagesWithAssistantFromOpenAI(result.messages || fullReq.messages, result.openai, { client });
      if (activeHistory && options.persistResponseHistory) rememberResponseHistory(response.id, storedMessages, fullReq);
      emitResponseObjectAsEvents(response, emitEvent);
      emitDone();
    } catch (err) {
      state.log(`RESPONSES: virtual hosted error: ${err.message || err}`);
      emitError(500, JSON.stringify({ error: { message: String(err.message || err) } }));
      emitDone();
    }
    return;
  }

  const mockRes = new MockResponse(
    emitEvent,
    emitError,
    () => {
      appendAssistantToHistory(conversationHistory, mockRes);
      if (activeHistory && activeHistory !== conversationHistory) appendAssistantToHistory(activeHistory, mockRes);
      if (activeHistory && options.persistResponseHistory) rememberResponseHistory(mockRes._responseId, activeHistory, fullReq);
      emitDone();
    },
    { client, toolRegistry: responseToolRegistry(fullReq) },
  );

  try {
    await _handleChatCompletion(fullReq, mockRes, { headers: options.headers, internal: true });
  } catch (err) {
    state.log(`RESPONSES: error: ${err.message || err}`);
    emitError(500, JSON.stringify({ error: { message: String(err.message || err) } }));
  }
}

async function processJsonRequest(request, options = {}) {
  if (!_handleChatCompletion) throw new Error("responses.init() was not called");
  const client = ideCapabilities.detectIdeClient(request, { headers: options.headers }).id;
  const chatReq = translateInput(request, { stream: false, client, headers: options.headers });
  const previousContext = responseContextForPreviousResponse(request);
  hydrateInheritedToolContext(chatReq, previousContext);
  const activeHistory = options.persistResponseHistory ? (previousContext?.messages || []) : previousContext?.messages;
  const messages = mergeHistory(chatReq, activeHistory);
  const fullReq = { ...chatReq, messages, metadata: { ...(request.metadata || {}), ...(chatReq.metadata || {}) } };

  state.log(`RESPONSES: model=${request.model || ""}->${chatReq.model} input=${responseInputItems(request.input).length} items msgs=${fullReq.messages.length} tools=${chatReq.tools?.length || 0}${responseToolsLogSuffix(chatReq.tools)}${responseOriginalToolsLogSuffix(request.tools)} stream=false`);
  writeDevResponsesSnapshot({ request, chatReq, fullReq, client, mode: "json" });

  if (shouldUseProxyHostedVirtualLoop(fullReq, client)) {
    const result = await runChatCompletionWithProxyHostedVirtualTools(fullReq, { headers: options.headers });
    if (result.status >= 400) {
      return {
        status: result.status,
        body: result.body || JSON.stringify({ error: { message: "Responses upstream request failed" } }),
      };
    }
    const response = chatCompletionToResponse(result.openai, request, { client, toolRegistry: responseToolRegistry(fullReq) });
    const storedMessages = messagesWithAssistantFromOpenAI(result.messages || fullReq.messages, result.openai, { client });
    if (options.persistResponseHistory) rememberResponseHistory(response.id, storedMessages, fullReq);
    return {
      status: 200,
      body: JSON.stringify(response),
    };
  }

  const capture = new CaptureResponse();
  await _handleChatCompletion(fullReq, capture, { headers: options.headers, internal: true });
  if (capture.statusCode >= 400) {
    return {
      status: capture.statusCode,
      body: capture.body || JSON.stringify({ error: { message: "Responses upstream request failed" } }),
    };
  }

  let openai;
  try {
    openai = JSON.parse(capture.body);
  } catch {
    return {
      status: 502,
      body: JSON.stringify({ error: { message: "Invalid upstream response" } }),
    };
  }

  const response = chatCompletionToResponse(openai, request, { client, toolRegistry: responseToolRegistry(fullReq) });
  if (options.persistResponseHistory) {
    const storedHistory = activeHistory ? cloneMessages(activeHistory) : cloneMessages(fullReq.messages);
    const assistantMessage = assistantMessageFromChatCompletion(openai, { client });
    if (assistantMessage) storedHistory.push(assistantMessage);
    rememberResponseHistory(response.id, storedHistory, fullReq);
  }

  return {
    status: 200,
    body: JSON.stringify(response),
  };
}

function handleResponsesWS(ws, req) {
  state.log(`RESPONSES-WS: connection from ${req.socket.remoteAddress}`);
  const conversationHistory = [];
  const pendingItems = [];
  let sessionModel = null;
  let sessionInstructions = null;
  let sessionTools = null;
  const sessionId = genId("sess");

  // OpenAI Realtime/Responses WS protocol: server sends session.created immediately on connect.
  // Codex waits for this event before proceeding with session.update / response.create.
  ws.send(JSON.stringify({
    type: "session.created",
    event_id: genId("evt"),
    session: {
      id: sessionId,
      object: "realtime.session",
      model: null,
      tools: [],
      tool_choice: "auto",
      temperature: 1.0,
    },
  }));

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error: { message: "Invalid JSON" } }));
      return;
    }

    if (msg.type === "session.update") {
      if (msg.session?.model) sessionModel = msg.session.model;
      if (msg.session?.instructions) sessionInstructions = msg.session.instructions;
      if (msg.session?.tools) sessionTools = msg.session.tools;
      if (ws.readyState === 1) ws.send(JSON.stringify({
        type: "session.updated",
        event_id: genId("evt"),
        session: { id: sessionId, ...msg.session || {} },
      }));
      return;
    }

    if (msg.type === "conversation.item.create" || msg.type === "response.input_item.create") {
      const item = msg.item || msg.input_item;
      if (item) {
        pendingItems.push(item);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "conversation.item.created", item }));
      }
      return;
    }

    if (msg.type === "response.create") {
      const request = msg.response ? { ...msg.response, model: msg.response.model || msg.model } : { ...msg };
      delete request.type;
      request.input = [...pendingItems, ...(request.input || [])];
      pendingItems.length = 0;
      request.metadata = { ...(request.metadata || {}), conversation_id: request.metadata?.conversation_id || sessionId };
      if (!request.model && sessionModel) request.model = sessionModel;
      if (!request.instructions && sessionInstructions) request.instructions = sessionInstructions;
      if (!request.tools && sessionTools) request.tools = sessionTools;

      await processRequest(
        request,
        (event) => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); },
        (status, body) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error: { message: body, code: status } })); },
        () => {},
        conversationHistory,
        { headers: req.headers },
      );
      return;
    }

    state.log(`RESPONSES-WS: unknown event type=${msg.type}`);
  });

  ws.on("close", () => state.log("RESPONSES-WS: closed"));
  ws.on("error", (err) => state.log(`RESPONSES-WS: error: ${err.message}`));
}

async function handleResponsesHTTP(req, res, body) {
  let request;
  try {
    request = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
    return;
  }

  const accept = String(req.headers?.accept || "");
  const wantsEventStream = request.stream === true || /text\/event-stream/i.test(accept);
  if (!wantsEventStream) {
    try {
      const result = await processJsonRequest(request, { headers: req.headers, persistResponseHistory: true });
      res.writeHead(result.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(result.body);
    } catch (err) {
      state.log(`RESPONSES: error: ${err.message || err}`);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
    }
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  let responseClosed = false;
  const markClosed = () => { responseClosed = true; };
  if (typeof res.on === "function") {
    res.on("close", markClosed);
    res.on("error", (err) => {
      responseClosed = true;
      state.log(`RESPONSES-SSE: client response error: ${err.message || err}`);
    });
  }
  const canWrite = () => !responseClosed && !res.writableEnded && !res.destroyed;
  const writeSseEvent = (event) => {
    if (!canWrite()) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      responseClosed = true;
      state.log(`RESPONSES-SSE: write skipped after close: ${err.message || err}`);
    }
  };
  const closeSse = () => {
    if (responseClosed) return;
    responseClosed = true;
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  await processRequest(
    request,
    (event) => writeSseEvent(event),
    (status, bodyText) => writeSseEvent({ type: "error", error: { message: bodyText, code: status } }),
    closeSse,
    null,
    { headers: req.headers, persistResponseHistory: true },
  );
}

module.exports = {
  init,
  translateInput,
  MockResponse,
  processRequest,
  handleResponsesWS,
  handleResponsesHTTP,
  mergeHistory,
  rememberResponseHistory,
  responseContextForPreviousResponse,
  trimStoredMessages,
  stripResponseProxyArtifacts,
};
