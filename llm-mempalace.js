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
    const [ctx, prefs] = await Promise.all([
      mpcSearch(`${project} status`, "sessions"),
      mpcSearch(`${project} preferences`, "preferences"),
    ]);
    if (ctx) parts.push(`Session: ${ctx}`);
    if (prefs) parts.push(`Preferences: ${prefs}`);
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
    const summary = session.recentResponses.slice(-10).join(" | ").substring(0, 500);
    mpcSave(`${project} session ${new Date().toISOString().split("T")[0]}`, summary, "sessions");
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

// Save full context before compaction — for recovery
async function saveCompactedContext(session, messages) {
  if (!MEMPALACE_ENABLED || !mpcAvailable) return;
  const project = session.projectName;

  // Save key messages: task definitions, decisions, tool results
  const important = (messages || []).filter((m) => {
    if (m.role === "system") return false; // system prompt saved separately
    const text = typeof m.content === "string" ? m.content : "";
    // Keep messages with tool calls, code blocks, errors, decisions
    if (m.tool_calls?.length > 0) return true;
    if (m.role === "tool") return true;
    if (/```|created|fixed|error|bug|import|schema|deploy/i.test(text)) return true;
    if (text.length > 200) return true; // substantial messages
    return false;
  });

  // Chunk into max 2000 char pieces for palace entries
  const chunks = [];
  let current = "";
  for (const m of important) {
    const text = typeof m.content === "string" ? m.content : "";
    const toolInfo = m.tool_calls ? ` [tools: ${m.tool_calls.map((t) => t.function?.name).join(",")}]` : "";
    const line = `${m.role}: ${text.substring(0, 150)}${toolInfo}\n`;
    if (current.length + line.length > 2000) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);

  // Save each chunk
  for (let i = 0; i < Math.min(chunks.length, 5); i++) { // max 5 chunks
    mpcSave(
      `${project} compacted ${new Date().toISOString().split("T")[0]} part${i + 1}`,
      chunks[i],
      "sessions"
    );
  }

  // Save task state if detected
  const taskMsgs = (messages || []).filter((m) => /\[\d+\/\d+\]/.test(typeof m.content === "string" ? m.content : ""));
  if (taskMsgs.length > 0) {
    const lastTask = taskMsgs[taskMsgs.length - 1];
    const taskText = typeof lastTask.content === "string" ? lastTask.content.substring(0, 500) : "";
    mpcSave(`${project} tasks — ${new Date().toISOString().split("T")[0]}`, taskText, "tasks");
  }
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
  mempalaceHealth,
  MEMPALACE_ENABLED,
};
