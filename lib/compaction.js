"use strict";

const crypto = require("crypto");
const http = require("http");
const state = require("./state");

// Fast content hash for truncation cache (first 200 + last 200 + length = unique enough)
function contentHash(content) {
  const s = typeof content === "string" ? content : "";
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

// Hash a message for compaction drop cache (role + first 100 + last 100 chars of content)
function msgHash(m) {
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
  if (c.length < 50) return null; // too short to cache
  const key = m.role + "|" + c.substring(0, 100) + "|" + c.substring(c.length - 100) + "|" + c.length;
  return crypto.createHash("md5").update(key).digest("hex").substring(0, 12);
}

// Apply cached compaction drops — remove messages that were dropped in previous requests
function applyCompactionDrops(sessionId, messages) {
  if (!sessionId || !messages) return messages;
  const drops = state.compactionDropCache[sessionId];
  if (!drops || drops.size === 0) return messages;
  const before = messages.length;
  // Keep system messages and messages not in drop cache
  const filtered = messages.filter(m => {
    if (m.role === "system") return true;
    const h = msgHash(m);
    return !h || !drops.has(h);
  });
  const removed = before - filtered.length;
  if (removed > 0) state.log(`DROP-CACHE: session ${sessionId} — replayed ${removed} cached drops (${before}→${filtered.length} msgs)`);
  return filtered;
}

// Record which messages were dropped during compaction
function recordCompactionDrops(sessionId, originalMessages, compactedMessages) {
  if (!sessionId) return;
  const compactedSet = new Set();
  for (const m of compactedMessages) {
    const h = msgHash(m);
    if (h) compactedSet.add(h);
  }
  if (!state.compactionDropCache[sessionId]) state.compactionDropCache[sessionId] = new Set();
  const drops = state.compactionDropCache[sessionId];
  for (const m of originalMessages) {
    if (m.role === "system") continue;
    const h = msgHash(m);
    if (h && !compactedSet.has(h)) drops.add(h);
  }
  // Limit cache size per session
  if (drops.size > 1000) {
    const arr = [...drops];
    state.compactionDropCache[sessionId] = new Set(arr.slice(arr.length - 500));
  }
}

function estimateTokens(messages) {
  let chars = 0;
  for (const m of (messages || [])) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.text) chars += part.text.length;
      }
    }
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

// Detect garbled/garbage text — hallucinated thinking with random symbols, mixed scripts
function detectGarbledText(text) {
  // Skip compaction artifacts — these contain mixed formats by design
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

  // 3. Random symbol clusters (3+ consecutive non-word non-space)
  const symbolClusters = (text.match(/[^\w\s]{3,}/g) || []).length;

  // 4. Word coherence: real text has avg word length 3-12, garble has random lengths
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const longGarbleWords = words.filter(w => w.length > 20 && /[^a-zA-Z]/.test(w)).length;

  // 5. Digit-letter soup: numbers mixed randomly into words (7Ad, 13-, 74M, hiY6, 4Q)
  const digitLetterSoup = (text.match(/\d[a-zA-Z]|[a-zA-Z]\d/g) || []).length;

  // 6. Nonsense fragments: random capitalization mid-word (XICl, hiY, digu)
  // Exclude common programming patterns: camelCase (taskList), PascalCase (TaskList), acronyms (API, URL)
  const allFragments = text.match(/[a-z][A-Z][a-z]|[A-Z]{2,}[a-z][A-Z]/g) || [];
  const nonsenseFragments = allFragments.filter(f => !/^[a-z][A-Z][a-z]+$/.test(f)).length; // keep only truly random ones

  // 7. High unique-word ratio with short words (garble = many unique random fragments)
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  const uniqueRatio = words.length > 5 ? uniqueWords.size / words.length : 0;

  // 8. Repetitive content: same char/pattern repeated (e.g., "000000", "1 1 1 1 1 1")
  const repetitiveRuns = (text.match(/(.)\1{15,}/g) || []).length; // same char 16+ times
  const repetitivePatterns = (text.match(/(\b\S{1,3}\s+)\1{8,}/g) || []).length; // short token repeated 9+ times
  // Also detect: lines of just repeated single chars/digits
  const repetitiveLines = text.split("\n").filter(l => l.length > 10 && /^(.)\1+$/.test(l.trim())).length;

  // 9. Repeated sentences/phrases — model looping ("We need to continue" x20)
  const sentences = text.split(/[.!?\n]/).map(s => s.trim().toLowerCase()).filter(s => s.length > 15);
  const sentenceCounts = {};
  for (const s of sentences) { sentenceCounts[s] = (sentenceCounts[s] || 0) + 1; }
  const maxSentenceRepeat = Math.max(0, ...Object.values(sentenceCounts));

  // 10. Very low unique-to-total sentence ratio with many sentences = looping
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
  // Sentence looping — model stuck repeating same phrases
  if (maxSentenceRepeat >= 5) garbleScore += 5;
  else if (maxSentenceRepeat >= 3) garbleScore += 3;
  if (sentenceLoopRatio < 0.3 && sentences.length > 15) garbleScore += 4; // <30% unique sentences

  return garbleScore >= 5;
}

// Also estimate tools definition array size
function estimateToolsTokens(tools) {
  if (!tools?.length) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4);
}

// Track file read/write activity per session
function trackFileActivity(sid, filePath, op) {
  if (!sid || !filePath) return;
  if (!state.fileActivity[sid]) state.fileActivity[sid] = {};
  const fa = state.fileActivity[sid];
  if (!fa[filePath]) fa[filePath] = { lastRead: null, lastWrite: null, reads: 0, writes: 0 };
  const now = new Date().toISOString();
  if (op === "read") { fa[filePath].lastRead = now; fa[filePath].reads++; }
  if (op === "write") { fa[filePath].lastWrite = now; fa[filePath].writes++; }
}

// Get modification status for a file since last read
function fileModStatus(sid, filePath) {
  if (!sid || !filePath || !state.fileActivity[sid]?.[filePath]) return "";
  const fa = state.fileActivity[sid][filePath];
  if (fa.lastWrite && fa.lastRead && fa.lastWrite > fa.lastRead) {
    return ` ⚠ MODIFIED since last read (wrote ${fa.lastWrite})`;
  }
  if (fa.writes > 0) return ` (${fa.writes} write${fa.writes > 1 ? "s" : ""} total)`;
  return "";
}

// Extract file path from tool response content
function extractFilePath(content) {
  // Try common patterns
  const m = content.match(/^(?:File|Reading|Contents of|Updated|Created|Edited)\s+[`"']?([^\s`"'\n]+)/im)
    || content.match(/(?:file|path)[:\s]+[`"']?([^\s`"'\n,]+\.\w+)/i)
    || content.match(/^\s*(\S+\.\w{1,10})\s*$/m);
  return m ? m[1] : "";
}

function extractToolFacts(msg, sid) {
  const content = typeof msg.content === "string" ? msg.content : "";
  if (content.length < 300) return msg; // already small

  // Never truncate .md files (CLAUDE.md, INSTRUCTIONS.md, skills, etc.) or skill content
  const toolName = (msg.name || "tool").toLowerCase();
  if (/read|cat|file/i.test(toolName)) {
    const isMdFile = /\.md[\s"'`)\]|,]|\.md$/im.test(content);
    const isSkillContent = /skill|CLAUDE\.md|INSTRUCTIONS\.md|AGENTS\.md|\.claude|\.kilo|\.cursor|\.windsurf/i.test(content);
    if (isMdFile || isSkillContent) return msg; // preserve full content
  }

  // Check truncation cache first
  const hash = contentHash(content);
  if (hash && state.truncationCache[hash]) {
    return { ...msg, content: state.truncationCache[hash] };
  }

  // Helper: cache truncated content and return modified message
  const cacheAndReturn = (truncated) => {
    if (hash) state.truncationCache[hash] = truncated;
    const keys = Object.keys(state.truncationCache);
    if (keys.length > 500) { for (const k of keys.slice(0, keys.length - 500)) delete state.truncationCache[k]; }
    return { ...msg, content: truncated };
  };

  const name = (msg.name || "tool").toLowerCase();
  const allLines = content.split("\n");
  const lineCount = allLines.length;
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19) + "Z";

  const preview = content.substring(0, 100).replace(/\n/g, " ");
  const truncInfo = `(showing 100ch of ${content.length}ch, ${lineCount} lines truncated)`;

  // ── File read → path, line range, modification status ──
  if (/read|cat|file|notebookread/i.test(name)) {
    const filePath = extractFilePath(content);
    trackFileActivity(sid, filePath, "read");
    const modStatus = fileModStatus(sid, filePath);

    // Detect line range from numbered output (e.g., "  1\t...", " 42\t...")
    let firstLine = null, lastLine = null;
    for (let i = 0; i < Math.min(allLines.length, 5); i++) {
      const m = allLines[i].match(/^\s*(\d+)\t/);
      if (m) { firstLine = parseInt(m[1]); break; }
    }
    for (let i = allLines.length - 1; i >= Math.max(0, allLines.length - 5); i--) {
      const m = allLines[i].match(/^\s*(\d+)\t/);
      if (m) { lastLine = parseInt(m[1]); break; }
    }
    const lineRange = (firstLine && lastLine) ? `lines ${firstLine}-${lastLine}` : `${lineCount} lines`;

    return cacheAndReturn(`[READ ${ts}] ${filePath || "file"} — ${lineRange}${modStatus} ${truncInfo}\n${preview}`);
  }

  // ── Grep/search → count + preview ──
  if (/grep|search|glob|find|ripgrep|rg/i.test(name)) {
    const matches = allLines.filter(l => /:\d+:/.test(l) || /^\S+\.\w+$/.test(l.trim()));
    const matchCount = matches.length || lineCount;
    return cacheAndReturn(`[SEARCH ${ts}] ${matchCount} results ${truncInfo}\n${preview}`);
  }

  // ── Edit/Write → confirmation + file tracking ──
  if (/edit|write|patch/i.test(name)) {
    const filePath = extractFilePath(content);
    trackFileActivity(sid, filePath, "write");
    const fa = sid && filePath && state.fileActivity[sid]?.[filePath];
    const writeInfo = fa ? ` (write #${fa.writes})` : "";
    const success = /success|updated|created|written|applied/i.test(content);
    return cacheAndReturn(`[${success ? "✓ WRITE" : "? WRITE"} ${ts}]${filePath ? " " + filePath : ""}${writeInfo} ${truncInfo}\n${preview}`);
  }

  // ── Bash/exec → exit code + preview ──
  if (/bash|exec|shell|terminal|command/i.test(name)) {
    const exitMatch = content.match(/exit code:?\s*(\d+)/i) || content.match(/^(\d+)$/m);
    const exitCode = exitMatch ? ` exit=${exitMatch[1]}` : "";
    // Try to extract command from first line
    const cmdMatch = allLines[0]?.match(/^\$?\s*(.{0,60})/);
    const cmd = cmdMatch ? cmdMatch[1].trim() : "";
    return cacheAndReturn(`[EXEC ${ts}${exitCode}] ${cmd ? cmd + " — " : ""}${truncInfo}\n${preview}`);
  }

  // ── LSP/diagnostics → count + preview ──
  if (/lsp|diagnostic|lint/i.test(name)) {
    const findings = allLines.filter(l => /error|warning|info|hint/i.test(l));
    return cacheAndReturn(`[DIAG ${ts}] ${findings.length} findings ${truncInfo}\n${preview}`);
  }

  // ── Agent/subagent → preview ──
  if (/agent|subagent|dispatch/i.test(name)) {
    return cacheAndReturn(`[AGENT ${ts}] ${truncInfo}\n${preview}`);
  }

  // ── Generic ──
  return cacheAndReturn(`[TOOL ${ts}] ${name} — ${truncInfo}\n${preview}`);
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

  const content = typeof msg.content === "string" ? msg.content : "";

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

function compactMessages(messages, targetTokens, maxOutputTokens, mempalaceRefs, sid) {
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
  if (budget <= 0) {
    // Target too small even for system + output — return context_length_exceeded signal
    return null;
  }

  // Protect last N turns — reduce protection if it doesn't fit target
  // Try 3 turns, then 2, then 1
  let protectedMsgs, compressibleMsgs, protectedTokens;
  for (let protectTurns = 3; protectTurns >= 1; protectTurns--) {
    let protectIdx = nonSystem.length;
    let userCount = 0;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (nonSystem[i].role === "user") userCount++;
      if (userCount >= protectTurns) { protectIdx = i; break; }
    }
    protectedMsgs = nonSystem.slice(protectIdx);
    compressibleMsgs = nonSystem.slice(0, protectIdx);
    protectedTokens = estimateTokens(protectedMsgs);
    // If protected fits in budget, use this protection level
    if (protectedTokens + systemTokens + maxOutputTokens <= targetTokens) break;
    // If even 1 turn doesn't fit, apply tool extraction to protected too
    if (protectTurns === 1 && protectedTokens + systemTokens + maxOutputTokens > targetTokens) {
      protectedMsgs = protectedMsgs.map(m => m.role === "tool" ? extractToolFacts(m, sid) : m);
      protectedTokens = estimateTokens(protectedMsgs);
    }
  }
  const compressibleBudget = budget - protectedTokens;

  // If protected alone fits, only compress the old part
  if (compressibleBudget <= 0 && protectedTokens + systemTokens + maxOutputTokens <= targetTokens) {
    const summaryMsg = { role: "assistant", content: buildCompactSummary(compressibleMsgs, mempalaceRefs) };
    state.log(`COMPACT-BUDGET: old msgs dropped (protected ${protectedMsgs.length} msgs fit, ${compressibleMsgs.length} dropped)`);
    return { messages: [...system, summaryMsg, ...protectedMsgs], removed: compressibleMsgs.length };
  }

  // === PHASE 1: Smart extraction on OLD tool responses ===
  let working = compressibleMsgs.map((m) =>
    m.role === "tool" ? extractToolFacts(m, sid) : m
  );
  let workingTokens = estimateTokens(working);

  if (workingTokens + protectedTokens + systemTokens + maxOutputTokens <= targetTokens) {
    state.log(`COMPACT-P1: smart extraction sufficient (${estimateTokens(compressibleMsgs)}→${workingTokens}tok, protected=${protectedTokens}tok)`);
    return { messages: [...system, ...working, ...protectedMsgs], removed: 0 };
  }

  // === PHASE 2: Topic-based compaction ===
  // Group messages into topics (consecutive msgs about same file/task), then drop entire topics
  const firstUser = working[0];
  const rest = working.slice(1);
  if (rest.length === 0) return null;

  // Step 1: Build atomic groups (assistant+tool_calls+responses)
  const atomicGroups = [];
  let i = 0;
  while (i < rest.length) {
    const msg = rest[i];
    if (msg.role === "assistant" && msg.tool_calls?.length > 0) {
      const group = [msg];
      const callIds = new Set(msg.tool_calls.map(tc => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < rest.length && rest[j].role === "tool" && callIds.has(rest[j].tool_call_id)) {
        group.push(rest[j]);
        j++;
      }
      atomicGroups.push(group);
      i = j;
    } else {
      atomicGroups.push([msg]);
      i++;
    }
  }

  // Step 2: Merge atomic groups into topic segments by file/task affinity
  const topics = []; // [{key, groups: [atomicGroup], msgs: [msg], startIdx, endIdx}]
  let currentTopic = null;

  for (let gi = 0; gi < atomicGroups.length; gi++) {
    const group = atomicGroups[gi];
    const topicKey = detectTopicKey(group);

    if (currentTopic && currentTopic.key === topicKey) {
      // Same topic — merge
      currentTopic.groups.push(group);
      for (const m of group) currentTopic.msgs.push(m);
      currentTopic.endIdx = gi;
    } else {
      // New topic
      currentTopic = { key: topicKey, groups: [group], msgs: [...group], startIdx: gi, endIdx: gi };
      topics.push(currentTopic);
    }
  }

  // Step 3: Score topics and drop lowest-priority ones
  const scoredTopics = topics.map((topic, ti) => ({
    ...topic,
    priority: Math.max(...topic.msgs.map((m, mi) => messagePriority(m, ti * 5 + mi, rest.length))),
    tokens: estimateTokens(topic.msgs),
    topicIdx: ti,
  }));

  // Sort by priority ascending (drop lowest first)
  const sortedByPriority = [...scoredTopics].sort((a, b) => a.priority - b.priority);

  const droppedTopics = new Set();
  let droppedTokens = 0;
  const tokensToFree = workingTokens - compressibleBudget;
  for (const t of sortedByPriority) {
    if (droppedTokens >= tokensToFree) break;
    droppedTokens += t.tokens;
    droppedTopics.add(t.topicIdx);
  }

  // Step 4: Build result — surviving topics kept, dropped topics → per-topic summaries
  const surviving = [firstUser];
  const topicSummaries = [];
  let droppedMsgCount = 0;

  for (let ti = 0; ti < topics.length; ti++) {
    if (droppedTopics.has(ti)) {
      droppedMsgCount += topics[ti].msgs.length;
      topicSummaries.push(buildTopicSummary(topics[ti]));
    } else {
      surviving.push(...topics[ti].msgs);
    }
  }

  // Insert compacted summary (all dropped topic summaries) after first user msg
  const allDropped = [];
  for (let ti = 0; ti < topics.length; ti++) {
    if (droppedTopics.has(ti)) allDropped.push(...topics[ti].msgs);
  }
  const summaryContent = buildCompactSummary(allDropped, mempalaceRefs, topicSummaries);
  const summaryMsg = { role: "assistant", content: summaryContent };

  // Request AI summary for next request (async, non-blocking)
  requestAISummary(sid, allDropped);

  const result = [...system, surviving[0], summaryMsg, ...surviving.slice(1), ...protectedMsgs];
  const resultTokens = estimateTokens(result);

  if (resultTokens + maxOutputTokens <= targetTokens) {
    state.log(`COMPACT-P2: topic-drop ${droppedMsgCount}/${rest.length} msgs, ${droppedTopics.size}/${topics.length} topics (${workingTokens}→${resultTokens - systemTokens - protectedTokens}tok old, protected=${protectedTokens}tok)`);
    return { messages: result, removed: droppedMsgCount };
  }

  // === PHASE 3: Aggressive — keep only first user + summary + protected ===
  const aggressiveAllDropped = [...rest]; // everything except firstUser
  const aggressiveTopicSummaries = topics.map(t => buildTopicSummary(t));
  const aggressiveSummary = { role: "assistant", content: buildCompactSummary(aggressiveAllDropped, mempalaceRefs, aggressiveTopicSummaries) };
  const aggressiveResult = [...system, firstUser, aggressiveSummary, ...protectedMsgs];
  const aggressiveTokens = estimateTokens(aggressiveResult);

  if (aggressiveTokens + maxOutputTokens <= targetTokens) {
    state.log(`COMPACT-P3: aggressive (kept first + protected ${protectedMsgs.length}, dropped ${compressibleMsgs.length - 1}, ${topics.length} topics summarized)`);
    requestAISummary(sid, aggressiveAllDropped);
    return { messages: aggressiveResult, removed: compressibleMsgs.length - 1 };
  }

  // Phase 3b: Ultra-aggressive — keep only last 2 messages + topic summaries
  const lastTwo = nonSystem.slice(-2);
  const ultraAllDropped = nonSystem.slice(0, -2);
  const ultraTopicSummaries = groupAndSummarizeAll(ultraAllDropped);
  const ultraSummary = { role: "assistant", content: buildCompactSummary(ultraAllDropped, mempalaceRefs, ultraTopicSummaries) };
  const ultraResult = [...system, ultraSummary, ...lastTwo];
  state.log(`COMPACT-P3b: ultra-aggressive (kept system + last 2, dropped ${nonSystem.length - 2} msgs, ${ultraTopicSummaries.length} topics)`);
  requestAISummary(sid, ultraAllDropped);
  return { messages: ultraResult, removed: nonSystem.length - 2 };
}

// Detect topic key from an atomic message group
function detectTopicKey(group) {
  for (const m of group) {
    const content = typeof m.content === "string" ? m.content : "";
    const name = (m.name || "").toLowerCase();

    // File operations → topic = filename
    const pathMatch = content.match(/(?:file[: ]*|path[: ]*|Reading |Contents of |Updated |Created |Edited )([^\s\n,`"']+\.\w{1,10})/i)
      || content.match(/^\s*\d+\t.*?([^\s/]+\.\w{1,10})/m);
    if (pathMatch) return pathMatch[1].replace(/^.*\//, ""); // basename

    // Tool calls → extract file from arguments
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        const args = tc.function?.arguments || "";
        const fileMatch = args.match(/"(?:file_path|path|file|filename)":\s*"([^"]+)"/i);
        if (fileMatch) return fileMatch[1].replace(/^.*\//, "");
      }
    }

    // Bash commands
    if (/bash|exec|shell/i.test(name)) return "commands";

    // Error content
    if (/error|Error|ERR_|TypeError|Cannot|failed|crash/i.test(content)) return "errors";

    // Decision content
    if (/because|decided|chose|approach|strategy|architecture/i.test(content)) return "decisions";
  }
  return "general";
}

// Build per-topic summary line
function buildTopicSummary(topic) {
  const files = new Set();
  const lineRanges = [];
  const commands = [];
  const errors = [];
  const decisions = [];
  const writes = [];

  for (const m of topic.msgs) {
    const content = typeof m.content === "string" ? m.content : "";
    const name = (m.name || "").toLowerCase();

    const pathMatch = content.match(/(?:file[: ]*|path[: ]*|Reading |Contents of |Updated |Created |Edited )([^\s\n,`"']+\.\w{1,10})/i);
    if (pathMatch) files.add(pathMatch[1]);

    // Line ranges from reads
    if (/read|cat|file/i.test(name) && m.role === "tool") {
      const lines = content.split("\n");
      let first = null, last = null;
      for (let li = 0; li < Math.min(lines.length, 5); li++) {
        const lm = lines[li].match(/^\s*(\d+)\t/);
        if (lm) { first = parseInt(lm[1]); break; }
      }
      for (let li = lines.length - 1; li >= Math.max(0, lines.length - 5); li--) {
        const lm = lines[li].match(/^\s*(\d+)\t/);
        if (lm) { last = parseInt(lm[1]); break; }
      }
      if (first && last) lineRanges.push(`${(pathMatch?.[1] || "").replace(/^.*\//, "")}:${first}-${last}`);
    }

    if (/edit|write/i.test(name) && pathMatch) writes.push(pathMatch[1]);
    if (/bash|exec|shell/i.test(name) && m.role === "tool") {
      const cmd = content.split("\n")[0]?.substring(0, 60).trim();
      if (cmd) commands.push(cmd);
    }
    if (/error|Error|ERR_|TypeError|Cannot|failed/i.test(content)) {
      const err = content.match(/(?:error|Error|ERR_|TypeError|Cannot|failed)[^\n]{0,60}/i);
      if (err) errors.push(err[0].trim());
    }
    if (m.role === "assistant" && /because|decided|chose|approach/i.test(content)) {
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

// Quick topic grouping + summary for arbitrary message arrays (used in P3b)
function groupAndSummarizeAll(msgs) {
  const topics = [];
  let current = null;
  for (let i = 0; i < msgs.length; i++) {
    const key = detectTopicKey([msgs[i]]);
    if (current && current.key === key) {
      current.msgs.push(msgs[i]);
      current.endIdx = i;
    } else {
      current = { key, msgs: [msgs[i]], startIdx: i, endIdx: i };
      topics.push(current);
    }
  }
  return topics.map(t => buildTopicSummary(t));
}

// Build compact summary with per-topic summaries and full metadata
function buildCompactSummary(droppedMsgs, mempalaceRefs, topicSummaries) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19) + "Z";
  const parts = [`[CONTEXT COMPACTED ${ts} — ${droppedMsgs.length} messages removed]`];

  // MemPalace references with re-read instructions
  if (mempalaceRefs?.length > 0) {
    parts.push("Saved to MemPalace (use mempalace_search/mempalace_get_drawer to retrieve):");
    for (const ref of mempalaceRefs) {
      parts.push(`  → ${ref.title} [${ref.room}] — ${ref.summary}${ref.preview ? ": " + ref.preview : ""}`);
    }
  }

  // AI summary from previous compaction (if available)
  const sid = state._lastCompactSid;
  if (sid && state._aiSummaryCache?.[sid]) {
    parts.push(`AI Summary: ${state._aiSummaryCache[sid]}`);
    delete state._aiSummaryCache[sid];
  }

  // Per-topic summaries (pre-built from topic grouping)
  if (topicSummaries?.length > 0) {
    parts.push("Topics compacted:");
    for (const tsum of topicSummaries.slice(0, 20)) {
      parts.push(`  ${tsum}`);
    }
  }

  parts.push("To recover details: use Read tool on files above, or mempalace_search for saved context.");
  parts.push("Continue from the recent context below.");
  return parts.join("\n");
}

// Request AI summarization of compacted content (async, non-blocking)
// Result cached in state._aiSummaryCache[sid] for next compaction
function requestAISummary(sid, droppedMsgs) {
  if (!sid || droppedMsgs.length < 10) return;

  // Build condensed representation
  const condensed = [];
  for (const m of droppedMsgs.slice(-80)) {
    const content = typeof m.content === "string" ? m.content : "";
    const snippet = content.substring(0, 120).replace(/\n/g, " ");
    if (snippet.length > 20) condensed.push(`${m.role}: ${snippet}`);
  }
  if (condensed.length < 5) return;

  state._lastCompactSid = sid;

  // Async self-call to proxy for AI summary (fire and forget)
  const body = JSON.stringify({
    model: "auto-text",
    max_tokens: 500,
    messages: [
      { role: "system", content: "Summarize this conversation excerpt in 3-5 bullet points. Focus on: what was done, what files changed, key decisions, errors encountered. Be terse." },
      { role: "user", content: condensed.join("\n").substring(0, 4000) },
    ],
  });

  try {
    const req = http.request({ hostname: "127.0.0.1", port: 18900, path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const summary = parsed.choices?.[0]?.message?.content;
          if (summary && summary.length > 20) {
            if (!state._aiSummaryCache) state._aiSummaryCache = {};
            state._aiSummaryCache[sid] = summary.substring(0, 1000);
            state.log(`AI-SUMMARY: cached ${summary.length}ch summary for session ${sid}`);
          }
        } catch {}
      });
    });
    req.on("error", () => {}); // fire and forget
    req.write(body);
    req.end();
  } catch {}
}

module.exports = {
  estimateTokens,
  detectGarbledText,
  estimateToolsTokens,
  extractToolFacts,
  trackFileActivity,
  fileModStatus,
  messagePriority,
  compactMessages,
  buildCompactSummary,
  applyCachedTruncations,
  applyCompactionDrops,
  recordCompactionDrops,
};
