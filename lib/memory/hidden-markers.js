"use strict";

const RECALL_PREFIX = "LLM_PROXY_RECALL";
const MEMORY_PREFIX = "LLM_PROXY_MEMORY";
const HIDDEN_MARKER_LINE_RE = /^\s*\[?\s*(LLM_PROXY_(?:RECALL|MEMORY)\b[^\r\n]*?)\s*\]?\s*$/i;
const FENCE_RE = /^\s*```/;

function normalizeMarkerText(text) {
  const raw = String(text || "").trim();
  const match = raw.match(HIDDEN_MARKER_LINE_RE);
  return match ? match[1].trim() : raw;
}

function parseKeyValues(text) {
  const fields = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)=(?:"([^"]*)"|([^\s]+))/g;
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    fields[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return fields;
}

function parseVersion(value) {
  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) && version > 0 ? version : 1;
}

function parseBudget(value) {
  const budget = Number.parseInt(value, 10);
  if (!Number.isFinite(budget)) return 1000;
  return Math.max(200, Math.min(4000, budget));
}

function parseTypes(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeSlug(value, fallback = "") {
  const slug = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || fallback;
}

function parseRecallMarker(text) {
  const raw = normalizeMarkerText(text);
  if (!new RegExp(`^${RECALL_PREFIX}\\b`, "i").test(raw)) return null;
  const fields = parseKeyValues(raw);
  const query = String(fields.q || fields.query || "").trim();
  if (!query) return null;
  return {
    version: parseVersion(fields.v || fields.version),
    query,
    types: parseTypes(fields.types || fields.type),
    budget: parseBudget(fields.budget),
    reason: sanitizeSlug(fields.reason, "recall"),
  };
}

function parseMemoryMarker(text) {
  const raw = normalizeMarkerText(text);
  if (!new RegExp(`^${MEMORY_PREFIX}\\b`, "i").test(raw)) return null;
  const fields = parseKeyValues(raw);
  const op = sanitizeSlug(fields.op || fields.signal, "note");
  return {
    version: parseVersion(fields.v || fields.version),
    op,
    target: String(fields.target || "").trim(),
    type: sanitizeSlug(fields.type, "note"),
    confidence: sanitizeSlug(fields.confidence, "medium"),
  };
}

function stripHiddenMemoryMarkers(content) {
  const raw = String(content || "");
  const source = raw.replace(/^\s+/, "");
  const lines = source.split(/\r?\n/);
  if (lines.length === 0) return { content: raw, recall: null, memory: null, memories: [] };

  let recall = null;
  let memory = null;
  const memories = [];
  const kept = [];
  let changed = false;
  let inFence = false;

  for (const line of lines) {
    if (!inFence) {
      const recallMarker = parseRecallMarker(line);
      const memoryMarker = parseMemoryMarker(line);
      if (recallMarker || memoryMarker) {
        if (recallMarker && !recall) recall = recallMarker;
        if (memoryMarker) {
          if (!memory) memory = memoryMarker;
          memories.push(memoryMarker);
        }
        changed = true;
        continue;
      }
    }

    kept.push(line);
    if (FENCE_RE.test(line)) inFence = !inFence;
  }

  if (!changed) return { content: raw, recall: null, memory: null, memories: [] };

  return {
    content: kept.join("\n").replace(/^[\s:;,\-.]+/, "").trimStart(),
    recall,
    memory,
    memories,
  };
}

module.exports = {
  parseRecallMarker,
  parseMemoryMarker,
  stripHiddenMemoryMarkers,
};
