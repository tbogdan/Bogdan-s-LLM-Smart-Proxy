"use strict";

const crypto = require("crypto");
const http = require("http");
const state = require("./state");
const mediaContent = require("./media-content");

const DEFAULT_AI_SUMMARY_MODEL = process.env.LLM_PROXY_AI_SUMMARY_MODEL || "auto-text";
const DEFAULT_AI_SUMMARY_TIMEOUT_MS = Number.parseInt(process.env.LLM_PROXY_AI_SUMMARY_TIMEOUT_MS || "12000", 10);
const DEFAULT_AI_SUMMARY_MAX_TOKENS = Number.parseInt(process.env.LLM_PROXY_AI_SUMMARY_MAX_TOKENS || "500", 10);
const DEFAULT_AI_SUMMARY_MIN_MESSAGES = Number.parseInt(process.env.LLM_PROXY_AI_SUMMARY_MIN_MESSAGES || "1", 10);

let aiSummaryConfig = {
  requester: requestAISummaryViaProxy,
  model: DEFAULT_AI_SUMMARY_MODEL,
  timeoutMs: Number.isFinite(DEFAULT_AI_SUMMARY_TIMEOUT_MS) ? DEFAULT_AI_SUMMARY_TIMEOUT_MS : 12000,
  maxTokens: Number.isFinite(DEFAULT_AI_SUMMARY_MAX_TOKENS) ? DEFAULT_AI_SUMMARY_MAX_TOKENS : 500,
  minDroppedMessages: Number.isFinite(DEFAULT_AI_SUMMARY_MIN_MESSAGES) ? DEFAULT_AI_SUMMARY_MIN_MESSAGES : 1,
};

function configureAISummary(nextConfig = {}) {
  const previous = { ...aiSummaryConfig };
  aiSummaryConfig = {
    ...aiSummaryConfig,
    ...nextConfig,
    requester: nextConfig.requester || requestAISummaryViaProxy,
  };
  return previous;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return mediaContent.textFromContent(content, { imagePlaceholder: true });
  }
  return content == null ? "" : JSON.stringify(content);
}

// Fast content hash for truncation cache (first 200 + last 200 + length = unique enough)
function contentHash(content) {
  const s = contentToText(content);
  if (s.length < 500) return null; // don't cache small content
  const key = s.substring(0, 200) + "|" + s.substring(s.length - 200) + "|" + s.length;
  return crypto.createHash("md5").update(key).digest("hex").substring(0, 12);
}

// Apply cached truncations to messages — call BEFORE any compaction
// This ensures IDE-cached messages get same truncation as previous requests
function applyCachedTruncations(messages) {
  if (!messages) return messages;
  let applied = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length < 500) continue;
    const hash = contentHash(m.content);
    if (hash && state.truncationCache[hash]) {
      messages[i] = { ...m, content: state.truncationCache[hash] };
      applied++;
    }
  }
  if (applied > 0) state.log(`TRUNC-CACHE: applied ${applied} cached truncations`);
  return messages;
}

function msgHash(msg) {
  const content = contentToText(msg.content);
  if (content.length < 50) return null;
  const key = `${msg.role}|${content.substring(0, 100)}|${content.substring(content.length - 100)}|${content.length}`;
  return crypto.createHash("md5").update(key).digest("hex").substring(0, 12);
}

function msgStableIdentity(msg) {
  if (!msg || typeof msg !== "object") return "";
  if (msg.role === "tool" && msg.tool_call_id) return `tool|${msg.tool_call_id}|${msg.name || ""}`;
  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const ids = msg.tool_calls.map((tc) => tc.id).filter(Boolean).join(",");
    if (ids) return `assistant_tool_calls|${ids}`;
  }
  return "";
}

function applyCompactionDrops(sessionId, messages) {
  if (!sessionId || !messages) return messages;
  const drops = state.compactionDropCache[sessionId];
  if (!drops || drops.size === 0) return messages;

  const before = messages.length;
  const filtered = messages.filter((msg) => {
    if (msg.role === "system") return true;
    const hash = msgHash(msg);
    return !hash || !drops.has(hash);
  });
  const removed = before - filtered.length;
  if (removed > 0) state.log(`DROP-CACHE: session ${sessionId} replayed ${removed} cached drops`);
  return filtered;
}

function recordCompactionDrops(sessionId, originalMessages, compactedMessages) {
  if (!sessionId || !originalMessages || !compactedMessages) return;
  const kept = new Set();
  const keptIdentities = new Set();
  for (const msg of compactedMessages) {
    const hash = msgHash(msg);
    if (hash) kept.add(hash);
    const identity = msgStableIdentity(msg);
    if (identity) keptIdentities.add(identity);
  }

  if (!state.compactionDropCache[sessionId]) state.compactionDropCache[sessionId] = new Set();
  const drops = state.compactionDropCache[sessionId];
  for (const msg of originalMessages) {
    if (msg.role === "system") continue;
    const hash = msgHash(msg);
    const identity = msgStableIdentity(msg);
    if (identity && keptIdentities.has(identity)) continue;
    if (hash && !kept.has(hash)) drops.add(hash);
  }

  if (drops.size > 1000) {
    const recent = [...drops].slice(-500);
    state.compactionDropCache[sessionId] = new Set(recent);
  }
}

function estimateTokens(messages) {
  let chars = 0;
  for (const m of (messages || [])) {
    chars += contentToText(m.content).length;
    chars += mediaContent.estimateImageTokens(m.content) * 4;
    if (m.reasoning_content) chars += m.reasoning_content.length;
    // Tool calls (assistant sending tool invocations)
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += (tc.function?.name || "").length;
        chars += (tc.function?.arguments || "").length;
      }
    }
    // Tool results (role=tool responses)
    if (m.role === "tool" && typeof m.content === "string") {
      // already counted above, but ensure tool name counted
      chars += (m.name || "").length;
    }
  }
  return Math.ceil(chars / 4);
}

function normalizeHeuristicText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function looksLikeCoherentMarkdownReport(text) {
  if (!text || text.length < 500) return false;
  const normalized = normalizeHeuristicText(text);
  const structuredLines = (text.match(/^\s*(#{1,4}\s|[-*]\s|\d+\.\s|\*\*[^*\n]+\*\*)/gm) || []).length;
  if (structuredLines < 3) return false;
  if (!/(analiz|analysis|strategi|strategy|stare|current state|recommend|recomand|impact|effort|observabil|routing|teste|tests|priorit|workflow|recovery|verification|benchmark|evidence|stop condition|patch|fix|security|replay|signature|hmac|timestamp|regression|validation|constant.?time|original code)/.test(normalized)) {
    return false;
  }
  const words = normalized.split(/\s+/).filter((word) => /^[a-z][a-z0-9_-]{2,}$/.test(word));
  return words.length >= 60;
}

function looksLikeStructuredJsonReport(text) {
  if (!text || text.length < 80) return false;
  const value = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  if (!/^[\[{]/.test(value)) return false;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    const object = value.match(/\{[\s\S]*\}/);
    if (!object) return false;
    try { parsed = JSON.parse(object[0]); } catch { return false; }
  }
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!root || typeof root !== "object") return false;
  const keys = Object.keys(root);
  if (keys.length < 3) return false;
  const normalized = normalizeHeuristicText(value);
  return /(decision|architecture|optimization|risk|verification|fallback|benchmark|direct|proxy|routing|recovery)/.test(normalized);
}

function looksLikeCoherentCodePatch(text) {
  if (!text || text.length < 250) return false;
  const fencedBlocks = text.match(/```[a-z0-9_-]*\n[\s\S]*?```/gi) || [];
  if (fencedBlocks.length === 0) return false;
  const normalized = normalizeHeuristicText(text);
  const codeText = fencedBlocks.join("\n");
  const hasCodeSyntax = /\b(function|const|let|return|if|class|import|require|def|try|catch)\b/.test(codeText);
  const hasPatchContext = /\b(patch|fix|regression|test|verify|validation|security|token|signature|hmac|timingsafeequal|sha256)\b/.test(normalized);
  const enoughWords = normalized.split(/\s+/).filter((word) => /^[a-z][a-z0-9_-]{2,}$/.test(word)).length >= 25;
  return hasCodeSyntax && hasPatchContext && enoughWords;
}

function isMarkdownTableSeparatorLine(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || "");
}

function isLikelyMarkdownTableHeaderLine(line) {
  const trimmed = String(line || "").trim();
  if (!/^\|.*\|$/.test(trimmed)) return false;
  if (isMarkdownTableSeparatorLine(trimmed)) return true;
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length < 2 || cells.length > 6) return false;
  return cells.every((cell) => /^[A-Za-z][A-Za-z /_-]{0,24}$/.test(cell));
}

function isMarkdownSectionLabelLine(line) {
  const normalized = normalizeHeuristicText(String(line || "")
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/[:：]\s*$/, ""));
  return /^(evidence|action|stop condition|condition|verification|result|results|risk|risks|impact|recommendation|summary|next steps)$/.test(normalized);
}

function stripMarkdownCodeBlocks(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
}

// Detect garbled/garbage text — hallucinated thinking with random symbols, mixed scripts
function detectGarbledText(text) {
  if (/\[CONTEXT COMPACTED|previously read|Use Read tool|Tool output.*lines\]|Search:.*results\]|file:.*lines\.|COMPACT/.test(text)) return false;
  if (!text || text.length < 30) return false;

  // 1. Mixed script detection: CJK + Latin + Arabic in same short segment = garble
  const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
  const hasArabic = /[\u0600-\u06ff]/.test(text);
  const hasLatin = /[a-zA-Z]{3,}/.test(text);
  const mixedScripts = (hasCJK ? 1 : 0) + (hasArabic ? 1 : 0) + (hasLatin ? 1 : 0);

  // 2. Non-ASCII ratio
  const nonAscii = (text.match(/[^\x20-\x7E\n\r\t]/g) || []).length;
  const nonAsciiRatio = nonAscii / text.length;

  // 3. Random symbol clusters (3+ consecutive non-word non-space).
  // Strip common Markdown/code syntax first so coherent reports do not look like symbol soup.
  const textForSymbols = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " link ")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, " ")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\*\*/g, " ");
  const symbolClusters = (textForSymbols.match(/[^\w\s]{3,}/g) || []).length;

  // 4. Word coherence: real text has avg word length 3-12, garble has random lengths.
  // Code blocks naturally contain repeated assertions, v1-style identifiers, and long expressions.
  const textWithoutCode = stripMarkdownCodeBlocks(text);
  const words = textWithoutCode.split(/\s+/).filter(w => w.length > 0);
  const longGarbleWords = words.filter(w => w.length > 20 && /[^a-zA-Z]/.test(w)).length;

  // 5. Digit-letter soup: numbers mixed randomly into words (7Ad, 13-, 74M, hiY6, 4Q)
  const digitLetterSoup = (textWithoutCode.match(/\d[a-zA-Z]|[a-zA-Z]\d/g) || []).length;

  // 6. Nonsense fragments: random capitalization mid-word (XICl, hiY, digu)
  // Exclude common programming patterns: camelCase (taskList), PascalCase (TaskList), acronyms (API, URL)
  const allFragments = textWithoutCode.match(/[a-z][A-Z][a-z]|[A-Z]{2,}[a-z][A-Z]/g) || [];
  const nonsenseFragments = allFragments.filter(f => !/^[a-z][A-Z][a-z]+$/.test(f)).length; // keep only truly random ones

  // 7. High unique-word ratio with short words (garble = many unique random fragments)
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  const uniqueRatio = words.length > 5 ? uniqueWords.size / words.length : 0;

  // 8. Repetitive content: same char/pattern repeated (e.g., "000000", "1 1 1 1 1 1")
  const textForRepetition = textWithoutCode.replace(/\b[0-9a-f]{32,}\b/gi, " HEX ");
  const repetitiveRuns = (textForRepetition.match(/(.)\1{15,}/g) || []).length; // same char 16+ times
  const repetitivePatterns = (textForRepetition.match(/(\b\S{1,3}\s+)\1{8,}/g) || []).length; // short token repeated 9+ times
  // Also detect: lines of just repeated single chars/digits
  const repetitiveLines = textWithoutCode.split("\n").filter(l => l.length > 10 && /^(.)\1+$/.test(l.trim())).length;

  // 9. Repeated sentences/phrases — model looped instead of progressing
  const textForSentenceLoops = textWithoutCode
    .split("\n")
    .filter((line) => !isLikelyMarkdownTableHeaderLine(line) && !isMarkdownSectionLabelLine(line))
    .join("\n");
  const sentences = textForSentenceLoops.split(/[.!?\n]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 15);
  const sentenceCounts = {};
  for (const sentence of sentences) sentenceCounts[sentence] = (sentenceCounts[sentence] || 0) + 1;
  const maxSentenceRepeat = Math.max(0, ...Object.values(sentenceCounts));
  const uniqueSentences = Object.keys(sentenceCounts).length;
  const sentenceLoopRatio = sentences.length > 10 ? uniqueSentences / sentences.length : 1;

  // Scoring — each signal adds weight, garble has multiple signals
  let garbleScore = 0;
  if (mixedScripts >= 3) garbleScore += 4;
  else if (mixedScripts >= 2 && nonAsciiRatio > 0.02) garbleScore += 2;
  if (nonAsciiRatio > 0.15) garbleScore += 3;
  else if (nonAsciiRatio > 0.03) garbleScore += 1;
  if (symbolClusters > 5) garbleScore += 2;
  else if (symbolClusters > 2) garbleScore += 1;
  if (longGarbleWords > 2) garbleScore += 1;
  if (digitLetterSoup > 8) garbleScore += 3;
  else if (digitLetterSoup > 5) garbleScore += 2;
  else if (digitLetterSoup > 2) garbleScore += 1;
  if (nonsenseFragments > 5) garbleScore += 2;
  else if (nonsenseFragments > 2) garbleScore += 1;
  if (uniqueRatio > 0.95 && words.length > 10) garbleScore += 1;
  // Repetitive content is strong garble signal — usually definitive on its own
  if (repetitiveRuns > 0) garbleScore += 5;
  if (repetitivePatterns > 0) garbleScore += 5;
  if (repetitiveLines > 1) garbleScore += 3;
  if (maxSentenceRepeat >= 5) garbleScore += 5;
  else if (maxSentenceRepeat >= 3) garbleScore += 3;
  if (sentenceLoopRatio < 0.3 && sentences.length > 15) garbleScore += 4;

  const strongGarbleSignal =
    mixedScripts >= 3 ||
    repetitiveRuns > 0 ||
    repetitivePatterns > 0 ||
    repetitiveLines > 1 ||
    maxSentenceRepeat >= 5 ||
    (sentenceLoopRatio < 0.3 && sentences.length > 15);
  if (!strongGarbleSignal && looksLikeStructuredJsonReport(text)) return false;
  if (!strongGarbleSignal && garbleScore <= 8 && looksLikeCoherentCodePatch(text)) return false;
  if (!strongGarbleSignal && garbleScore <= 8 && looksLikeCoherentMarkdownReport(text)) return false;

  return garbleScore >= 5;
}

// Also estimate tools definition array size
function estimateToolsTokens(tools) {
  if (!tools?.length) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4);
}

function estimateRequestSchemaTokens(req = {}) {
  return estimateToolsTokens(req.tools) + estimateToolsTokens(req.functions);
}

function trackFileActivity(sessionId, filePath, op) {
  if (!sessionId || !filePath) return;
  if (!state.fileActivity[sessionId]) state.fileActivity[sessionId] = {};
  const activity = state.fileActivity[sessionId];
  if (!activity[filePath]) activity[filePath] = { lastRead: null, lastWrite: null, reads: 0, writes: 0 };
  const now = new Date().toISOString();
  if (op === "read") {
    activity[filePath].lastRead = now;
    activity[filePath].reads += 1;
  }
  if (op === "write") {
    activity[filePath].lastWrite = now;
    activity[filePath].writes += 1;
  }
}

function fileModStatus(sessionId, filePath) {
  if (!sessionId || !filePath || !state.fileActivity[sessionId]?.[filePath]) return "";
  const activity = state.fileActivity[sessionId][filePath];
  if (activity.lastWrite && activity.lastRead && activity.lastWrite > activity.lastRead) {
    return ` MODIFIED since last read (wrote ${activity.lastWrite})`;
  }
  if (activity.writes > 0) return ` (${activity.writes} write${activity.writes > 1 ? "s" : ""} total)`;
  return "";
}

function extractFilePath(content) {
  const match = content.match(/^(?:File|Reading|Contents of|Updated|Created|Edited)\s+[`"']?([^\s`"'\n]+)/im)
    || content.match(/(?:file|path)[:\s]+[`"']?([^\s`"'\n,]+\.\w+)/i)
    || content.match(/^\s*(\S+\.\w{1,10})\s*$/m);
  return match ? match[1] : "";
}

function extractToolFacts(msg, sessionId) {
  const content = contentToText(msg.content);
  if (content.length < 300) return msg;

  const toolName = (msg.name || "tool").toLowerCase();
  if (/read|cat|file/i.test(toolName)) {
    const isMarkdownFile = /\.md(?:[\s"'`)\]|,]|$)/im.test(content);
    const isInstructionContent = /skill|CLAUDE\.md|INSTRUCTIONS\.md|AGENTS\.md|\.claude|\.agents|\.windsurf/i.test(content);
    if (isMarkdownFile || isInstructionContent) return msg;
  }

  const hash = contentHash(content);
  if (hash && state.truncationCache[hash]) {
    return { ...msg, content: state.truncationCache[hash] };
  }

  const cacheAndReturn = (truncated) => {
    if (hash) state.truncationCache[hash] = truncated;
    const keys = Object.keys(state.truncationCache);
    if (keys.length > 500) {
      for (const key of keys.slice(0, keys.length - 500)) delete state.truncationCache[key];
    }
    return { ...msg, content: truncated };
  };

  const name = (msg.name || "tool").toLowerCase();
  const allLines = content.split("\n");
  const lineCount = allLines.length;
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19) + "Z";
  const preview = content.substring(0, 100).replace(/\n/g, " ");
  const truncInfo = `(showing 100ch of ${content.length}ch, ${lineCount} lines truncated)`;

  if (/read|cat|file|notebookread/i.test(name)) {
    const filePath = extractFilePath(content);
    trackFileActivity(sessionId, filePath, "read");
    const modStatus = fileModStatus(sessionId, filePath);
    let firstLine = null;
    let lastLine = null;
    for (let i = 0; i < Math.min(allLines.length, 5); i += 1) {
      const match = allLines[i].match(/^\s*(\d+)\t/);
      if (match) {
        firstLine = parseInt(match[1], 10);
        break;
      }
    }
    for (let i = allLines.length - 1; i >= Math.max(0, allLines.length - 5); i -= 1) {
      const match = allLines[i].match(/^\s*(\d+)\t/);
      if (match) {
        lastLine = parseInt(match[1], 10);
        break;
      }
    }
    const lineRange = firstLine && lastLine ? `lines ${firstLine}-${lastLine}` : `${lineCount} lines`;
    return cacheAndReturn(`[READ ${ts}] ${filePath || "file"} - ${lineRange}${modStatus} ${truncInfo}\n${preview}`);
  }

  if (/grep|search|glob|find|ripgrep|rg/i.test(name)) {
    const matches = allLines.filter((line) => /:\d+:/.test(line) || /^\S+\.\w+$/.test(line.trim()));
    const matchCount = matches.length || lineCount;
    return cacheAndReturn(`[SEARCH ${ts}] ${matchCount} results ${truncInfo}\n${preview}`);
  }

  if (/edit|write|patch/i.test(name)) {
    const filePath = extractFilePath(content);
    trackFileActivity(sessionId, filePath, "write");
    const activity = sessionId && filePath && state.fileActivity[sessionId]?.[filePath];
    const writeInfo = activity ? ` (write #${activity.writes})` : "";
    const success = /success|updated|created|written|applied/i.test(content);
    return cacheAndReturn(`[${success ? "WRITE" : "? WRITE"} ${ts}]${filePath ? " " + filePath : ""}${writeInfo} ${truncInfo}\n${preview}`);
  }

  if (/bash|exec|shell|terminal|command/i.test(name)) {
    const exitMatch = content.match(/exit code:?\s*(\d+)/i) || content.match(/^(\d+)$/m);
    const exitCode = exitMatch ? ` exit=${exitMatch[1]}` : "";
    const cmdMatch = allLines[0]?.match(/^\$?\s*(.{0,60})/);
    const cmd = cmdMatch ? cmdMatch[1].trim() : "";
    return cacheAndReturn(`[EXEC ${ts}${exitCode}] ${cmd ? `${cmd} - ` : ""}${truncInfo}\n${preview}`);
  }

  if (/lsp|diagnostic|lint/i.test(name)) {
    const findings = allLines.filter((line) => /error|warning|info|hint/i.test(line));
    return cacheAndReturn(`[DIAG ${ts}] ${findings.length} findings ${truncInfo}\n${preview}`);
  }

  if (/agent|subagent|dispatch/i.test(name)) {
    return cacheAndReturn(`[AGENT ${ts}] ${truncInfo}\n${preview}`);
  }

  return cacheAndReturn(`[TOOL ${ts}] ${name} - ${truncInfo}\n${preview}`);
}

function truncateTextToTokenBudget(text, budgetTokens, label = "truncated") {
  const value = String(text || "");
  const maxChars = Math.max(0, Math.floor(Number(budgetTokens || 0) * 4));
  if (value.length <= maxChars) return value;
  if (maxChars < 80) return `[${label}: ${value.length} chars omitted]`;
  const suffix = `\n[${label}: ${value.length - maxChars + 80} chars omitted]`;
  return value.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

function shrinkMessagesToFit(messages, targetTokens, maxOutputTokens, sessionId) {
  const result = messages.map((msg) => ({ ...msg }));
  const latestUserIndex = result.map((msg) => msg.role).lastIndexOf("user");
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = result.length - 1; i >= 0; i -= 1) {
      if (estimateTokens(result) + maxOutputTokens <= targetTokens) return result;
      if (result[i].role === "system") continue;
      if (i === latestUserIndex) continue;
      if (result[i].role === "tool") {
        result[i] = extractToolFacts(result[i], sessionId);
      }
      const text = contentToText(result[i].content);
      if (text.length < 120) continue;
      const current = estimateTokens(result) + maxOutputTokens;
      const over = current - targetTokens;
      const currentMsgTokens = estimateTokens([result[i]]);
      const nextBudget = Math.max(20, currentMsgTokens - over - 20);
      result[i] = {
        ...result[i],
        content: truncateTextToTokenBudget(text, nextBudget, "compacted recent message"),
      };
    }
  }
  return result;
}

// Score a message for retention priority (higher = keep)
function messagePriority(msg, index, total) {
  let score = 5; // base

  // Recency: exponential — recent msgs much more important
  const recency = index / total;
  if (recency > 0.9) score += 10;      // last 10% — critical
  else if (recency > 0.8) score += 6;  // last 20%
  else if (recency > 0.6) score += 3;  // last 40%
  else if (recency < 0.2) score -= 2;  // very old

  const content = contentToText(msg.content);

  if (msg.role === "user") {
    score += 7; // user messages always important
    if (/fix|implement|add|create|update|change|refactor|debug|deploy/i.test(content)) score += 3;
    if (content.length < 20) score -= 2; // short "ok" / "continua"
  }

  if (msg.role === "assistant") {
    if (msg.tool_calls?.length > 0) score += 5; // tool-using assistant = took action
    if (/because|decided|chose|architecture|design|approach|strategy/i.test(content)) score += 4; // decisions
    if (/error|fix|bug|issue|problem|solved|resolved/i.test(content)) score += 3; // error handling
    if (/```/.test(content)) score += 2; // contains code
    if (content.length < 80 && !msg.tool_calls?.length) score -= 4; // short ack without action
  }

  if (msg.role === "tool") {
    score += 1; // tool responses lowest base (info already acted on)
    if (/edit|write|success|created|updated/i.test(msg.name || "")) score += 3; // mutations > reads
    if (/read|cat|file/i.test(msg.name || "")) score += 0; // reads can be re-done
  }

  return score;
}

function compactMessages(messages, targetTokens, maxOutputTokens, memoryRefs, sessionId) {
  if (!messages || messages.length < 4) return null;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length < 6) return null;

  // === BUDGET SLOTS ===
  // System: 100% (never touch)
  // Tool schemas: separate (not in messages)
  // Last 3 conversation turns (~6-12 msgs): 100% verbatim
  // Everything else: compress to fit remaining budget

  const systemTokens = estimateTokens(system);
  const budget = targetTokens - maxOutputTokens - systemTokens;
  if (budget <= 0) return null;

  let protectedMsgs;
  let compressibleMsgs;
  let protectedTokens;
  for (let protectTurns = 3; protectTurns >= 1; protectTurns -= 1) {
    let protectIdx = nonSystem.length;
    let userCount = 0;
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
      if (nonSystem[i].role === "user") userCount += 1;
      if (userCount >= protectTurns) {
        protectIdx = i;
        break;
      }
    }
    protectedMsgs = nonSystem.slice(protectIdx);
    compressibleMsgs = nonSystem.slice(0, protectIdx);
    protectedTokens = estimateTokens(protectedMsgs);
    if (protectedTokens + systemTokens + maxOutputTokens <= targetTokens) break;
    if (protectTurns === 1 && protectedTokens + systemTokens + maxOutputTokens > targetTokens) {
      protectedMsgs = protectedMsgs.map((m) => (m.role === "tool" ? extractToolFacts(m, sessionId) : m));
      protectedTokens = estimateTokens(protectedMsgs);
    }
  }
  const compressibleBudget = budget - protectedTokens;

  // If protected alone fits, only compress the old part
  if (compressibleBudget <= 0 && protectedTokens + systemTokens + maxOutputTokens <= targetTokens) {
    // Drop all old messages, keep only protected
    const summaryMsg = { role: "assistant", content: buildCompactSummary(compressibleMsgs, memoryRefs) };
    state.log(`COMPACT-BUDGET: old msgs dropped (protected ${protectedMsgs.length} msgs fit, ${compressibleMsgs.length} dropped)`);
    return {
      messages: [...system, summaryMsg, ...protectedMsgs],
      removed: compressibleMsgs.length,
      summaryIndex: system.length,
      droppedMessages: compressibleMsgs,
      topicSummaries: [],
    };
  }

  // === PHASE 1: Smart extraction on OLD tool responses ===
  let working = compressibleMsgs.map((m) =>
    m.role === "tool" ? extractToolFacts(m, sessionId) : m
  );
  let workingTokens = estimateTokens(working);

  if (workingTokens + protectedTokens + systemTokens + maxOutputTokens <= targetTokens) {
    state.log(`COMPACT-P1: smart extraction sufficient (${estimateTokens(compressibleMsgs)}→${workingTokens}tok, protected=${protectedTokens}tok)`);
    return { messages: [...system, ...working, ...protectedMsgs], removed: 0 };
  }

  // === PHASE 2: Topic-based compaction ===
  const firstUser = working[0];
  const rest = working.slice(1);
  if (rest.length === 0) return null;

  const atomicGroups = [];
  let i = 0;
  while (i < rest.length) {
    const msg = rest[i];
    if (msg.role === "assistant" && msg.tool_calls?.length > 0) {
      const group = [msg];
      const callIds = new Set(msg.tool_calls.map((tc) => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < rest.length && rest[j].role === "tool" && callIds.has(rest[j].tool_call_id)) {
        group.push(rest[j]);
        j += 1;
      }
      atomicGroups.push(group);
      i = j;
    } else {
      atomicGroups.push([msg]);
      i += 1;
    }
  }

  const topics = [];
  let currentTopic = null;
  for (let groupIdx = 0; groupIdx < atomicGroups.length; groupIdx += 1) {
    const group = atomicGroups[groupIdx];
    const topicKey = detectTopicKey(group);
    if (currentTopic && currentTopic.key === topicKey) {
      currentTopic.groups.push(group);
      currentTopic.msgs.push(...group);
      currentTopic.endIdx = groupIdx;
    } else {
      currentTopic = { key: topicKey, groups: [group], msgs: [...group], startIdx: groupIdx, endIdx: groupIdx };
      topics.push(currentTopic);
    }
  }

  const scoredTopics = topics.map((topic, topicIdx) => ({
    ...topic,
    priority: Math.max(...topic.msgs.map((m, mi) => messagePriority(m, topicIdx * 5 + mi, rest.length))),
    tokens: estimateTokens(topic.msgs),
    topicIdx,
  }));
  scoredTopics.sort((a, b) => a.priority - b.priority);

  const droppedTopics = new Set();
  let droppedTokens = 0;
  const tokensToFree = workingTokens - compressibleBudget;
  for (const topic of scoredTopics) {
    if (droppedTokens >= tokensToFree) break;
    droppedTokens += topic.tokens;
    droppedTopics.add(topic.topicIdx);
  }

  const surviving = [firstUser];
  const topicSummaries = [];
  const droppedMsgs = [];
  let droppedMsgCount = 0;
  for (let topicIdx = 0; topicIdx < topics.length; topicIdx += 1) {
    if (droppedTopics.has(topicIdx)) {
      droppedMsgCount += topics[topicIdx].msgs.length;
      topicSummaries.push(buildTopicSummary(topics[topicIdx]));
      droppedMsgs.push(...topics[topicIdx].msgs);
    } else {
      surviving.push(...topics[topicIdx].msgs);
    }
  }

  const summaryMsg = { role: "assistant", content: buildCompactSummary(droppedMsgs, memoryRefs, topicSummaries) };

  const result = [...system, surviving[0], summaryMsg, ...surviving.slice(1), ...protectedMsgs];
  const resultTokens = estimateTokens(result);

  if (resultTokens + maxOutputTokens <= targetTokens) {
    state.log(`COMPACT-P2: topic-drop ${droppedMsgCount}/${rest.length} msgs, ${droppedTopics.size}/${topics.length} topics (${workingTokens}→${resultTokens - systemTokens - protectedTokens}tok old, protected=${protectedTokens}tok)`);
    return {
      messages: result,
      removed: droppedMsgCount,
      summaryIndex: system.length + 1,
      droppedMessages: droppedMsgs,
      topicSummaries,
    };
  }

  // === PHASE 3: Aggressive — keep only first user + summary + protected ===
  const aggressiveTopicSummaries = topics.map((topic) => buildTopicSummary(topic));
  const aggressiveSummary = { role: "assistant", content: buildCompactSummary(rest, memoryRefs, aggressiveTopicSummaries) };
  const aggressiveResult = [...system, firstUser, aggressiveSummary, ...protectedMsgs];
  const aggressiveTokens = estimateTokens(aggressiveResult);

  if (aggressiveTokens + maxOutputTokens <= targetTokens) {
    state.log(`COMPACT-P3: aggressive (kept first + protected ${protectedMsgs.length}, dropped ${compressibleMsgs.length - 1}, ${topics.length} topics summarized)`);
    return {
      messages: aggressiveResult,
      removed: compressibleMsgs.length - 1,
      summaryIndex: system.length + 1,
      droppedMessages: rest,
      topicSummaries: aggressiveTopicSummaries,
    };
  }

  // Phase 3b: Ultra-aggressive — keep only last 2 messages
  const lastTwo = nonSystem.slice(-2).map((m) => (m.role === "tool" ? extractToolFacts(m, sessionId) : m));
  const ultraAllDropped = nonSystem.slice(0, -2);
  const ultraSummary = { role: "assistant", content: buildCompactSummary(ultraAllDropped, memoryRefs, groupAndSummarizeAll(ultraAllDropped)) };
  let ultraResult = [...system, ultraSummary, ...lastTwo];
  if (estimateTokens(ultraResult) + maxOutputTokens > targetTokens) {
    ultraResult = shrinkMessagesToFit(ultraResult, targetTokens, maxOutputTokens, sessionId);
  }
  if (estimateTokens(ultraResult) + maxOutputTokens > targetTokens) {
    state.log(`COMPACT-P3b: unable to fit ultra-aggressive context within target ${targetTokens}tok`);
    return null;
  }
  state.log(`COMPACT-P3b: ultra-aggressive (kept system + last 2, dropped ${nonSystem.length - 2} msgs)`);
  return {
    messages: ultraResult,
    removed: nonSystem.length - 2,
    summaryIndex: system.length,
    droppedMessages: ultraAllDropped,
    topicSummaries: groupAndSummarizeAll(ultraAllDropped),
  };
}

function detectTopicKey(group) {
  for (const msg of group) {
    const content = contentToText(msg.content);
    const name = (msg.name || "").toLowerCase();

    const pathMatch = content.match(/(?:file[: ]*|path[: ]*|Reading |Contents of |Updated |Created |Edited )([^\s\n,`"']+\.\w{1,10})/i)
      || content.match(/^\s*\d+\t.*?([^\s/]+\.\w{1,10})/m);
    if (pathMatch) return pathMatch[1].replace(/^.*\//, "");

    if (msg.tool_calls) {
      for (const toolCall of msg.tool_calls) {
        const args = toolCall.function?.arguments || "";
        const fileMatch = args.match(/"(?:file_path|path|file|filename)":\s*"([^"]+)"/i);
        if (fileMatch) return fileMatch[1].replace(/^.*\//, "");
      }
    }

    if (/bash|exec|shell/i.test(name)) return "commands";
    if (/error|Error|ERR_|TypeError|Cannot|failed|crash/i.test(content)) return "errors";
    if (/because|decided|chose|approach|strategy|architecture/i.test(content)) return "decisions";
  }
  return "general";
}

function buildTopicSummary(topic) {
  const files = new Set();
  const lineRanges = [];
  const commands = [];
  const errors = [];
  const decisions = [];
  const writes = [];

  for (const msg of topic.msgs) {
    const content = contentToText(msg.content);
    const name = (msg.name || "").toLowerCase();
    const pathMatch = content.match(/(?:file[: ]*|path[: ]*|Reading |Contents of |Updated |Created |Edited )([^\s\n,`"']+\.\w{1,10})/i);
    if (pathMatch) files.add(pathMatch[1]);

    if (/read|cat|file/i.test(name) && msg.role === "tool") {
      const lines = content.split("\n");
      let first = null;
      let last = null;
      for (let i = 0; i < Math.min(lines.length, 5); i += 1) {
        const match = lines[i].match(/^\s*(\d+)\t/);
        if (match) {
          first = parseInt(match[1], 10);
          break;
        }
      }
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i -= 1) {
        const match = lines[i].match(/^\s*(\d+)\t/);
        if (match) {
          last = parseInt(match[1], 10);
          break;
        }
      }
      if (first && last) lineRanges.push(`${(pathMatch?.[1] || "").replace(/^.*\//, "")}:${first}-${last}`);
    }

    if (/edit|write/i.test(name) && pathMatch) writes.push(pathMatch[1]);
    if (/bash|exec|shell/i.test(name) && msg.role === "tool") {
      const command = content.split("\n")[0]?.substring(0, 60).trim();
      if (command) commands.push(command);
    }
    if (/error|Error|ERR_|TypeError|Cannot|failed/i.test(content)) {
      const err = content.match(/(?:error|Error|ERR_|TypeError|Cannot|failed)[^\n]{0,60}/i);
      if (err) errors.push(err[0].trim());
    }
    if (msg.role === "assistant" && /because|decided|chose|approach/i.test(content)) {
      decisions.push(content.substring(0, 80).replace(/\n/g, " ").trim());
    }
  }

  const bits = [`[${topic.key}] msgs ${topic.startIdx}-${topic.endIdx} (${topic.msgs.length} msgs)`];
  if (files.size > 0) bits.push(`files: ${[...files].slice(0, 5).join(", ")}`);
  if (lineRanges.length > 0) bits.push(`read: ${lineRanges.slice(0, 5).join(", ")}`);
  if (writes.length > 0) bits.push(`wrote: ${writes.slice(0, 3).join(", ")}`);
  if (commands.length > 0) bits.push(`cmds: ${commands.slice(0, 3).join("; ")}`);
  if (errors.length > 0) bits.push(`errors: ${errors.slice(0, 2).join("; ")}`);
  if (decisions.length > 0) bits.push(`decided: ${decisions.slice(0, 2).join(" | ")}`);
  return bits.join(" | ");
}

function groupAndSummarizeAll(messages) {
  const topics = [];
  let current = null;
  for (let i = 0; i < messages.length; i += 1) {
    const key = detectTopicKey([messages[i]]);
    if (current && current.key === key) {
      current.msgs.push(messages[i]);
      current.endIdx = i;
    } else {
      current = { key, msgs: [messages[i]], startIdx: i, endIdx: i };
      topics.push(current);
    }
  }
  return topics.map((topic) => buildTopicSummary(topic));
}

// Build compact summary for dropped messages with re-read hints
function buildCompactSummary(droppedMsgs, memoryRefs, topicSummaries, aiSummary) {
  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19) + "Z";
  const parts = [`[CONTEXT COMPACTED ${timestamp} - ${droppedMsgs.length} messages removed]`];

  // Memory references
  if (memoryRefs?.length > 0) {
    parts.push("Full context archived to Memory:");
    for (const ref of memoryRefs) {
      const uri = ref.uri ? ` ${ref.uri}` : "";
      const kind = ref.kind || ref.room || "episode";
      parts.push(`  -> ${ref.title || "compacted context"} [${kind}]${uri} - ${ref.summary || "archived"}${ref.preview ? `: ${ref.preview}` : ""}`);
    }
  }

  if (topicSummaries?.length > 0) {
    parts.push("Topics compacted:");
    for (const summary of topicSummaries.slice(0, 20)) {
      parts.push(`  ${summary}`);
    }
  }

  if (aiSummary) {
    parts.push("AI Summary:");
    for (const line of String(aiSummary).split("\n").filter(Boolean).slice(0, 12)) {
      parts.push(`  ${line}`);
    }
  }

  // Extract re-read hints: which files were read (so LLM knows to re-request)
  const filesRead = new Set();
  const filesEdited = new Set();
  const decisions = [];

  for (const m of droppedMsgs) {
    const content = contentToText(m.content);
    const name = (m.name || "").toLowerCase();

    // Track files from tool responses
    if (m.role === "tool") {
      const pathMatch = content.match(/(?:file[: ]*|path[: ]*)([^\s\n,`"']+\.\w{1,10})/i)
        || content.match(/^(\d+)\t.*?([^\s/]+\.\w{1,10})/m);
      if (/read|cat|file/i.test(name) && pathMatch) filesRead.add(pathMatch[1]);
      if (/edit|write/i.test(name) && pathMatch) filesEdited.add(pathMatch[1]);
    }

    // Track decisions from assistant messages
    if (m.role === "assistant" && /because|decided|chose|approach|strategy|architecture/i.test(content)) {
      const snippet = content.substring(0, 120).replace(/\n/g, " ").trim();
      if (snippet) decisions.push(snippet);
    }
  }

  if (filesRead.size > 0) {
    parts.push(`Files previously read (re-read with Read tool if needed): ${[...filesRead].slice(0, 20).join(", ")}`);
  }
  if (filesEdited.size > 0) {
    parts.push(`Files edited: ${[...filesEdited].slice(0, 20).join(", ")}`);
  }
  if (decisions.length > 0) {
    parts.push("Key decisions: " + decisions.slice(0, 5).join(" | "));
  }

  parts.push('To recover details: use Read on files above, or request private recall with LLM_PROXY_RECALL v=1 q="<needed context>" types=architecture,decisions,procedures budget=1200 reason=compaction_recovery.');
  parts.push("Continue from the recent context below.");
  return parts.join("\n");
}

function aiSummaryCacheKey(sessionId, droppedMsgs) {
  const digestInput = droppedMsgs.map((msg) => {
    const content = contentToText(msg.content);
    return `${msg.role}|${msg.name || ""}|${content.substring(0, 240)}|${content.substring(Math.max(0, content.length - 240))}|${content.length}`;
  }).join("\n");
  const digest = crypto.createHash("sha256").update(digestInput).digest("hex").substring(0, 20);
  return `${sessionId || "no-session"}:${digest}`;
}

function buildAISummaryInput(droppedMsgs) {
  const condensed = [];
  for (const msg of droppedMsgs.slice(-100)) {
    const content = contentToText(msg.content);
    const snippet = content.replace(/\s+/g, " ").substring(0, 180).trim();
    if (snippet.length > 20) condensed.push(`${msg.role}${msg.name ? `:${msg.name}` : ""}: ${snippet}`);
  }
  return condensed.join("\n").substring(0, 6000);
}

async function requestAISummaryViaProxy({ condensed, model, maxTokens, timeoutMs }) {
  const body = JSON.stringify({
    _llmProxyInternalSummary: true,
    model,
    max_tokens: maxTokens,
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "Summarize this compacted conversation excerpt in 3-5 concise bullets.",
          "Focus on completed work, files touched, key decisions, errors, and next useful context.",
          "Return only the summary. Do not call tools.",
        ].join(" "),
      },
      { role: "user", content: condensed },
    ],
  });

  const port = Number.parseInt(process.env.PORT || "18900", 10);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: Number.isFinite(port) ? port : 18900,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.substring(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(text);
          resolve(parsed.choices?.[0]?.message?.content || "");
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("AI summary timeout")));
    req.write(body);
    req.end();
  });
}

async function getAISummary(sessionId, droppedMsgs, options = {}) {
  if (!droppedMsgs?.length || droppedMsgs.length < aiSummaryConfig.minDroppedMessages) return null;

  const condensed = buildAISummaryInput(droppedMsgs);
  if (condensed.length < 80) return null;

  const cacheKey = aiSummaryCacheKey(sessionId, droppedMsgs);
  if (state.aiSummaryCache[cacheKey]) {
    state.log(`AI-SUMMARY: cache hit for ${sessionId || "no-session"}`);
    return state.aiSummaryCache[cacheKey];
  }

  const requester = options.requester || aiSummaryConfig.requester;
  try {
    const summary = await requester({
      sessionId,
      droppedMsgs,
      condensed,
      model: options.model || aiSummaryConfig.model,
      maxTokens: options.maxTokens || aiSummaryConfig.maxTokens,
      timeoutMs: options.timeoutMs || aiSummaryConfig.timeoutMs,
    });
    const clean = String(summary || "").trim().substring(0, 1200);
    if (clean.length < 20) return null;
    state.aiSummaryCache[cacheKey] = clean;
    const keys = Object.keys(state.aiSummaryCache);
    if (keys.length > 500) {
      for (const key of keys.slice(0, keys.length - 500)) delete state.aiSummaryCache[key];
    }
    state.log(`AI-SUMMARY: generated ${clean.length}ch summary for ${sessionId || "no-session"}`);
    return clean;
  } catch (error) {
    state.log(`AI-SUMMARY: unavailable for ${sessionId || "no-session"} (${error.message})`);
    return null;
  }
}

async function compactMessagesAsync(messages, targetTokens, maxOutputTokens, memoryRefs, sessionId, options = {}) {
  const compacted = compactMessages(messages, targetTokens, maxOutputTokens, memoryRefs, sessionId);
  if (!compacted || options.skipAISummary) return compacted;
  if (!Number.isInteger(compacted.summaryIndex) || !compacted.droppedMessages?.length) return compacted;

  const aiSummary = await getAISummary(sessionId, compacted.droppedMessages, options);
  if (!aiSummary) return { ...compacted, aiSummaryUsed: false };

  const summaryMsg = compacted.messages[compacted.summaryIndex];
  const messagesWithAISummary = compacted.messages.slice();
  messagesWithAISummary[compacted.summaryIndex] = {
    ...summaryMsg,
    content: buildCompactSummary(compacted.droppedMessages, memoryRefs, compacted.topicSummaries, aiSummary),
  };

  return {
    ...compacted,
    messages: messagesWithAISummary,
    aiSummaryUsed: true,
  };
}

module.exports = {
  estimateTokens,
  detectGarbledText,
  estimateToolsTokens,
  estimateRequestSchemaTokens,
  extractToolFacts,
  trackFileActivity,
  fileModStatus,
  messagePriority,
  compactMessages,
  buildCompactSummary,
  configureAISummary,
  compactMessagesAsync,
  applyCachedTruncations,
  applyCompactionDrops,
  recordCompactionDrops,
};
