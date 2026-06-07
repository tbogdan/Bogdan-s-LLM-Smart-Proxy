"use strict";

// ---------------------------------------------------------------------------
// Session tracking — derives a stable session ID from the system message.
// Previously embedded in llm-mempalace.js; extracted here so routing modules
// can identify sessions without pulling in the full mempalace stack.
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

/**
 * Return (or create) a session object keyed by the system message hash.
 * @param {Array} messages  — the messages array from the request body
 * @returns {{ id: string, projectName: string, requestCount: number, lastProvider: string|null }}
 */
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
      lastProvider: null,
    };
  }
  sessions[hash].requestCount++;
  return sessions[hash];
}

/**
 * Record the last provider used for this session (session affinity).
 * @param {{ lastProvider: string|null }} session
 * @param {string} providerName
 */
function setLastProvider(session, providerName) {
  if (session) session.lastProvider = providerName;
}

/**
 * Return the last provider recorded for this session, or null.
 * @param {{ lastProvider: string|null }} session
 */
function getLastProvider(session) {
  return session?.lastProvider || null;
}

module.exports = { getSession, setLastProvider, getLastProvider };
