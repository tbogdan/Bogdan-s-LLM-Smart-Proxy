#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const MEMPALACE_URL = process.env.MEMPALACE_URL || "http://localhost:8891";
const MEMPALACE_ENABLED = process.env.MEMPALACE_ENABLED !== "false";
const MAX_INJECT_TOKENS = parseInt(process.env.MEMPALACE_MAX_INJECT_TOKENS || "2000", 10);
const MPC_TIMEOUT = 5000;
const SAVE_INTERVAL_MS = 30 * 60_000;
const SAVE_INTERVAL_REQS = 50;

let mpcAvailable = true;
let mpcSessionId = null;
let mpcInitialized = false;
const mpcPendingCallbacks = new Map(); // id → {resolve, timer}
let sseConnection = null;

// ---------------------------------------------------------------------------
// MCP SSE Client (supergateway protocol)
// Supergateway: GET /sse for SSE stream (receives responses), POST /message for requests
// ---------------------------------------------------------------------------

function mpcConnect() {
  if (sseConnection) return;

  const parsed = new URL(MEMPALACE_URL + "/sse");
  const mod = parsed.protocol === "https:" ? https : http;

  const req = mod.request(parsed, { method: "GET" }, (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c.toString();
      // Process complete SSE events
      const lines = buf.split("\n");
      buf = lines.pop() || ""; // keep incomplete line
      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event:")) eventType = line.substring(6).trim();
        if (line.startsWith("data:")) {
          const data = line.substring(5).trim();
          if (eventType === "endpoint") {
            // Extract sessionId from endpoint URL
            const match = data.match(/sessionId=([a-f0-9-]+)/);
            if (match) {
              mpcSessionId = match[1];
              mpcAvailable = true;
            }
          } else if (eventType === "message") {
            // JSON-RPC response — resolve pending callback
            try {
              const parsed = JSON.parse(data);
              const id = parsed.id;
              if (id && mpcPendingCallbacks.has(id)) {
                const cb = mpcPendingCallbacks.get(id);
                clearTimeout(cb.timer);
                mpcPendingCallbacks.delete(id);
                const text = parsed.result?.content?.[0]?.text || parsed.result || null;
                cb.resolve(text);
              }
            } catch { /* ignore parse errors */ }
          }
          eventType = "";
        }
      }
    });
    res.on("end", () => { sseConnection = null; mpcSessionId = null; mpcInitialized = false; setTimeout(mpcConnect, 1000); });
    res.on("error", () => { sseConnection = null; mpcAvailable = false; setTimeout(mpcConnect, 5000); });
  });

  req.on("error", () => { sseConnection = null; mpcAvailable = false; });
  req.end();
  sseConnection = req;
}

function mpcPost(body) {
  return new Promise((resolve) => {
    if (!mpcSessionId) { resolve(null); return; }
    const url = `${MEMPALACE_URL}/message?sessionId=${mpcSessionId}`;
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);

    const req = mod.request(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
      timeout: MPC_TIMEOUT,
    }, (res) => {
      // Supergateway returns 202 Accepted, actual response comes via SSE
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(res.statusCode < 400 ? "accepted" : null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(bodyStr);
    req.end();
  });
}

async function mpcCall(method, params) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return null;

  // Ensure SSE connection is open
  if (!sseConnection) mpcConnect();

  // Wait for sessionId (max 3s)
  for (let i = 0; i < 30 && !mpcSessionId; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!mpcSessionId) { mpcAvailable = false; return null; }

  // Initialize MCP session once
  if (!mpcInitialized) {
    await mpcPost({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "llm-proxy", version: "1.0" } }, id: -1 });
    await new Promise((r) => setTimeout(r, 500)); // wait for init response via SSE
    await mpcPost({ jsonrpc: "2.0", method: "notifications/initialized" });
    mpcInitialized = true;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Send request and wait for SSE response
  const callId = Date.now();
  const resultPromise = new Promise((resolve) => {
    const timer = setTimeout(() => { mpcPendingCallbacks.delete(callId); resolve(null); }, MPC_TIMEOUT);
    mpcPendingCallbacks.set(callId, { resolve, timer });
  });

  await mpcPost({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: method, arguments: params },
    id: callId,
  });

  return resultPromise;
}

function mpcSearch(query, room) {
  const params = { query };
  if (room) params.room = room;
  return mpcCall("mempalace_search", params);
}

function mpcSave(title, content, room) {
  return mpcCall("mempalace_add_drawer", { title, content, room });
}

// ---------------------------------------------------------------------------
// Session Tracking
// ---------------------------------------------------------------------------
const sessions = {};

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 500); i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return "s" + Math.abs(h).toString(36);
}

function detectProjectName(systemContent) {
  if (!systemContent) return "unknown";
  const pathMatch = systemContent.match(/\/(?:Users|home)\/[^/]+\/[^/]*\/([^/\s]+)/);
  if (pathMatch) return pathMatch[1];
  const nameMatch = systemContent.match(/(?:project|app|repo|codebase)\s+["']?(\w[\w-]+)/i);
  if (nameMatch) return nameMatch[1];
  return "unknown";
}

function getSession(messages) {
  const systemMsg = messages?.find((m) => m.role === "system");
  const sysContent = typeof systemMsg?.content === "string" ? systemMsg.content : "";
  const hash = sysContent ? simpleHash(sysContent) : "default";
  if (!sessions[hash]) {
    sessions[hash] = {
      id: hash,
      projectName: detectProjectName(sysContent),
      requestCount: 0,
      lastSave: Date.now(),
      lastRecall: 0,
      recentErrors: [],
      recentTasks: [],
      recentCorrections: [],
      recentResponses: [],
      isNew: true,
      lastProvider: null, // session affinity — prefer same provider
    };
  }
  sessions[hash].requestCount++;
  return sessions[hash];
}

// ---------------------------------------------------------------------------
// Detection Patterns
// ---------------------------------------------------------------------------
const TASK_PATTERNS = [
  /\[(\d+)\/(\d+)\]/,
  /\[(completed|in_progress)\]/,
  /step (\d+)/i,
  /TODO:|FIXME:/,
];

const CORRECTION_PATTERNS = [
  /\b(no |don't|stop |wrong|not that|instead|actually|nu |opreste|gresit|la fel)\b/i,
];

const ARCH_PATTERNS = [
  /creat(?:ed?|ing) (?:file|component|page|route|module)/i,
  /schema\.prisma|docker-compose|package\.json|tsconfig/i,
  /chose|picked|decided|using|switched to/i,
];

// ---------------------------------------------------------------------------
// Token Estimation & Budget
// ---------------------------------------------------------------------------
function estimateMemoryTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function truncateToBudget(parts, maxTokens) {
  const filtered = parts.filter(Boolean).map(String);
  let total = 0;
  const kept = [];
  for (const p of filtered) {
    const tokens = estimateMemoryTokens(p);
    if (total + tokens > maxTokens) {
      const remaining = maxTokens - total;
      if (remaining > 50) {
        kept.push(p.substring(0, remaining * 4));
      }
      break;
    }
    kept.push(p);
    total += tokens;
  }
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Recall — search palace, build injection string
// ---------------------------------------------------------------------------
async function recallMemories(session, reqBody) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return "";

  const parts = [];
  const project = session.projectName;

  if (session.isNew) {
    const [lastSession, tasks, prefs, arch, problems] = await Promise.all([
      mpcSearch(`${project} session`, "sessions"),
      mpcSearch(`${project} tasks`, "tasks"),
      mpcSearch(`${project} preferences`, "preferences"),
      mpcSearch(`${project} architecture`, "architecture"),
      mpcSearch(`${project} problems`, "problems"),
    ]);
    if (lastSession) parts.push(`Last session: ${lastSession}`);
    if (tasks) parts.push(`Tasks: ${tasks}`);
    if (prefs) parts.push(`Preferences: ${prefs}`);
    if (arch) parts.push(`Architecture: ${arch}`);
    if (problems) parts.push(`Known issues: ${problems}`);
    session.isNew = false;
  }

  const msgs = reqBody.messages || [];
  const lastUserMsg = msgs.filter((m) => m.role === "user").pop();
  const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content.trim() : "";

  if (/(?:continu[ea]|continue|go|do it|next|remember|recall|where were we|what were we)/i.test(lastUserText) && lastUserText.length < 50) {
    const [tasks, lastSess] = await Promise.all([
      mpcSearch(`${project} tasks`, "tasks"),
      mpcSearch(`${project} session`, "sessions"),
    ]);
    if (tasks) parts.push(`Tasks: ${tasks}`);
    if (lastSess) parts.push(`Last session: ${lastSess}`);
  }

  if (reqBody.tools?.length > 0 && lastUserText.length > 10) {
    const keywords = lastUserText.replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(" ");
    if (keywords) {
      const relevant = await mpcSearch(keywords);
      if (relevant) parts.push(`Related: ${relevant}`);
    }
  }

  if (session.recentErrors.length > 0) {
    const errText = session.recentErrors[0].substring(0, 100);
    const fix = await mpcSearch(errText, "problems");
    if (fix) parts.push(`Past fix: ${fix}`);
  }

  if (parts.length === 0) return "";

  const memory = truncateToBudget(parts, MAX_INJECT_TOKENS);
  return `\n[MEMORY — ${project}]:\n${memory}\n`;
}

// ---------------------------------------------------------------------------
// Save — async fire-and-forget after response
// ---------------------------------------------------------------------------
function triggerSaves(session, reqBody, responseBody) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return;

  const project = session.projectName;
  const now = Date.now();

  let assistantContent = "";
  try {
    const data = JSON.parse(responseBody);
    assistantContent = data.choices?.[0]?.message?.content || "";
  } catch { return; }

  if (assistantContent.length > 20) {
    session.recentResponses.push(assistantContent.substring(0, 200));
    if (session.recentResponses.length > 20) session.recentResponses.shift();
  }

  if (session.requestCount % SAVE_INTERVAL_REQS === 0 || now - session.lastSave > SAVE_INTERVAL_MS) {
    const date = new Date().toISOString().split("T")[0];
    const actionSummary = session.recentResponses.slice(-10).join(" | ").substring(0, 400);
    const taskSummary = session.recentTasks.length > 0 ? `\n\nTasks: ${session.recentTasks.join(", ")}` : "";

    // AAAK-style compressed summary with references
    const structured = [
      `PROJ:${project}|DATE:${date}|REQS:${session.requestCount}`,
      `SUM:${actionSummary}`,
      taskSummary ? `TASKS:${session.recentTasks.join("|")}` : "",
      `REF:${project}.code→sessions|${project}.tasks→tasks|${project}.arch→architecture|${project}.err→problems|${project}.pref→preferences`,
    ].filter(Boolean).join("\n").substring(0, 600);

    mpcSave(`${project} session ${date}`, structured, "sessions");
    session.lastSave = now;
    session.recentResponses = [];
  }

  if (TASK_PATTERNS.some((p) => p.test(assistantContent))) {
    const taskMatch = assistantContent.match(/\[\d+\/\d+\][^\n]*/g) || [];
    if (taskMatch.length > 0) {
      session.recentTasks = taskMatch.slice(-5);
      mpcSave(`${project} tasks — ${new Date().toISOString().split("T")[0]}`, taskMatch.join("\n"), "tasks");
    }
  }

  if (ARCH_PATTERNS.some((p) => p.test(assistantContent))) {
    const archSnippet = assistantContent.substring(0, 300);
    mpcSave(`${project} arch — ${new Date().toISOString().split("T")[0]}`, archSnippet, "architecture");
  }

  const msgs = reqBody.messages || [];
  const lastUser = msgs.filter((m) => m.role === "user").pop();
  const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
  if (CORRECTION_PATTERNS.some((p) => p.test(userText)) && userText.length < 200) {
    const prevAssistant = msgs.filter((m) => m.role === "assistant").pop();
    const prevText = typeof prevAssistant?.content === "string" ? prevAssistant.content.substring(0, 100) : "";
    mpcSave(`${project} pref — ${userText.substring(0, 50)}`, `User said: ${userText}\nAfter assistant: ${prevText}`, "preferences");
  }
}

function setLastProvider(session, providerName) {
  session.lastProvider = providerName;
}

function getLastProvider(session) {
  return session.lastProvider;
}

function saveError(session, errorMsg) {
  session.recentErrors.unshift(String(errorMsg).substring(0, 200));
  if (session.recentErrors.length > 5) session.recentErrors.pop();
}

function saveErrorResolution(session, errorMsg, resolution) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return;
  mpcSave(`${session.projectName} fix — ${String(errorMsg).substring(0, 50)}`, `Error: ${errorMsg}\nFix: ${resolution}`, "problems");
}

function saveStalling(providerName, groupName, reason) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return;
  mpcSave(`${providerName} banned from ${groupName}`, `Provider ${providerName} banned from group ${groupName}. Reason: ${reason}`, "stalling");
}

function saveProjectContext(session, systemContent) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return;
  const summary = String(systemContent).substring(0, 500);
  mpcSave(`${session.projectName} context — ${new Date().toISOString().split("T")[0]}`, summary, "projects");
}

// Save full context before compaction — categorize and return references
async function saveCompactedContext(session, messages) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return [];
  const project = session.projectName;
  const date = new Date().toISOString().split("T")[0];
  const refs = []; // {title, room, summary} — returned for inclusion in compacted summary

  // Categorize messages
  const categories = {
    code: [],      // code blocks, file operations
    errors: [],    // errors, bugs, fixes
    tools: [],     // tool calls and results
    tasks: [],     // task progress [1/N]
    decisions: [], // architecture, tech choices
    other: [],     // everything else substantial
  };

  for (const m of (messages || [])) {
    if (m.role === "system") continue;
    const text = typeof m.content === "string" ? m.content : "";
    const toolInfo = m.tool_calls ? `|T:${m.tool_calls.map((t) => t.function?.name).join(",")}` : "";
    const line = `${m.role[0]}:${text.substring(0, 150).replace(/\n/g, " ")}${toolInfo}`;

    if (m.tool_calls?.length > 0 || m.role === "tool") {
      categories.tools.push(line);
    } else if (/\[\d+\/\d+\]|TODO|FIXME|step \d/i.test(text)) {
      categories.tasks.push(line);
    } else if (/error|bug|fix|fail|crash|exception|TypeError|Cannot/i.test(text)) {
      categories.errors.push(line);
    } else if (/```|function |class |import |const |def |create|modify|edit/i.test(text)) {
      categories.code.push(line);
    } else if (/chose|decided|using|switched|architecture|schema|deploy|docker/i.test(text)) {
      categories.decisions.push(line);
    } else if (text.length > 100) {
      categories.other.push(line);
    }
  }

  // Save each non-empty category to appropriate room
  const roomMap = {
    code: "sessions",
    errors: "problems",
    tools: "sessions",
    tasks: "tasks",
    decisions: "architecture",
    other: "sessions",
  };

  for (const [cat, lines] of Object.entries(categories)) {
    if (lines.length === 0) continue;
    const content = lines.join("\n").substring(0, 2000);
    const title = `${project} ${cat} — ${date}`;
    const room = roomMap[cat];
    mpcSave(title, content, room);
    refs.push({
      title,
      room,
      summary: `${lines.length} ${cat} entries`,
      preview: lines[0].substring(0, 80),
    });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
function mempalaceHealth() {
  return {
    enabled: MEMPALACE_ENABLED,
    available: mpcAvailable,
    url: MEMPALACE_URL,
    max_inject_tokens: MAX_INJECT_TOKENS,
    sessions: Object.keys(sessions).length,
  };
}

setInterval(() => {
  if (MEMPALACE_ENABLED && !mpcAvailable) {
    sseConnection = null;
    mpcSessionId = null;
    mpcInitialized = false;
    mpcConnect();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getSession,
  recallMemories,
  triggerSaves,
  saveError,
  saveErrorResolution,
  saveStalling,
  saveProjectContext,
  saveCompactedContext,
  setLastProvider,
  getLastProvider,
  mempalaceHealth,
  MEMPALACE_ENABLED,
};
