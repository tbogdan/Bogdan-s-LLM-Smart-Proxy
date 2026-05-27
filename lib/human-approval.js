"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const state = require("./state");
const memory = require("./memory");

const APPROVAL_AUDIT_FILE = path.join(state.DATA_DIR, "human-approvals.jsonl");
const APPROVAL_GATES = new Set(["human_signoff"]);
const APPROVAL_PROMPT_MARKER = "LLM_PROXY_HUMAN_APPROVAL_REQUIRED";
const DEFAULT_TTL_MS = 15 * 60_000;

function envEnabled(env = process.env) {
  const value = String(env.LLM_PROXY_HUMAN_APPROVAL_ENABLED ?? env.LLM_PROXY_HUMAN_APPROVAL ?? "true").toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(value);
}

function ttlMs(env = process.env) {
  const value = Number(env.LLM_PROXY_HUMAN_APPROVAL_TTL_MS || 0);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS;
}

function headerValue(headers = {}, name = "") {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function normalizeToken(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return normalizeToken(value.token || value.challenge || value.approved_by_user || value.approval_token);
  }
  let text = String(value).trim();
  if (!text) return "";
  const embedded = text.match(/\b(?:approved_by_user|approval_token|token)\s*[:=]\s*([a-f0-9]{32})\b/i);
  if (embedded) return embedded[1].toLowerCase();
  text = text.replace(/^approved_by_user\s*[:=]\s*/i, "").trim();
  text = text.replace(/^token\s*[:=]\s*/i, "").trim();
  return /^[a-f0-9]{32}$/i.test(text) ? text.toLowerCase() : "";
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part) return "";
      if (typeof part === "string") return part;
      return part.text || part.content || part.input || "";
    }).join("");
  }
  if (content && typeof content === "object") return content.text || content.content || "";
  return "";
}

function tokenFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const text = messageContentText(message?.content);
    if (message?.role === "assistant" && text.includes(APPROVAL_PROMPT_MARKER)) continue;
    if (message?.role && !["user", "tool", "function"].includes(message.role)) continue;
    const token = normalizeToken(text);
    if (token) return token;
  }
  return "";
}

function isApprovalConfirmationText(text = "") {
  const normalized = String(text || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
  return /\b(?:approve|approved|confirm|confirmed|continue|proceed|yes|da|aprob|confirm|continua|mergem mai departe|go ahead)\b/.test(normalized);
}

function latestPendingForSession(sessionId = "", now = Date.now()) {
  if (!sessionId) return null;
  const approvals = approvalState();
  const pending = Object.values(approvals.pending || {})
    .filter((record) => record.session_id === sessionId && record.expires_at_ms > now)
    .sort((a, b) => Number(b.created_at_ms || 0) - Number(a.created_at_ms || 0));
  return pending[0] || null;
}

function implicitApprovalTokenFromMessages(messages = [], now = Date.now()) {
  const lastUser = [...(messages || [])].reverse().find((message) => message?.role === "user");
  if (!lastUser || !isApprovalConfirmationText(messageContentText(lastUser.content))) return "";
  const sawProxyPrompt = (messages || []).some((message) =>
    message?.role === "assistant" &&
    messageContentText(message.content).includes(APPROVAL_PROMPT_MARKER)
  );
  if (!sawProxyPrompt) return "";
  let session;
  try { session = memory.getSession(messages); } catch { session = null; }
  const pending = latestPendingForSession(session?.id || "", now);
  return pending?.challenge || "";
}

function extractApprovalToken(reqBody = {}, options = {}) {
  const headers = options.headers || {};
  const candidates = [
    headerValue(headers, "x-llm-proxy-approval"),
    headerValue(headers, "x-llm-proxy-approval-token"),
    headerValue(headers, "x-approved-by-user"),
    reqBody.approved_by_user,
    reqBody.approval_token,
    reqBody.llm_proxy_approval,
    reqBody.human_approval,
    reqBody.approval,
  ];
  for (const candidate of candidates) {
    const token = normalizeToken(candidate);
    if (token) return token;
  }
  const messageToken = tokenFromMessages(reqBody.messages || []);
  if (messageToken) return messageToken;
  const implicitToken = implicitApprovalTokenFromMessages(reqBody.messages || []);
  if (implicitToken) return implicitToken;
  return "";
}

function stripApprovalFields(reqBody = {}) {
  delete reqBody.approved_by_user;
  delete reqBody.approval_token;
  delete reqBody.llm_proxy_approval;
  delete reqBody.human_approval;
  delete reqBody.approval;
  return reqBody;
}

function simplifiedMessages(messages = []) {
  return (messages || []).map((message) => ({
    role: message?.role || "",
    content: messageContentText(message?.content),
    tool_calls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((call) => call?.function?.name || call?.name || "")
      : undefined,
  }));
}

function requestHash(reqBody = {}, profile = {}) {
  const tools = (reqBody.tools || []).map((tool) => tool?.function?.name || tool?.name || tool?.type || "");
  const functions = (reqBody.functions || []).map((fn) => fn?.name || "");
  const payload = {
    model: reqBody.model || "auto",
    messages: simplifiedMessages(reqBody.messages || []),
    tools,
    functions,
    gate: profile.stepShape?.gate || "",
    shape: profile.stepShape?.shape || "",
    taskKind: profile.taskKind || "",
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function latestUserText(reqBody = {}) {
  const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return messageContentText(messages[i].content);
  }
  return "";
}

function hasCurrentSecurityReviewIntent(reqBody = {}) {
  const raw = latestUserText(reqBody);
  const cleaned = stripApprovalTextFragments(raw).text || raw;
  const normalized = cleaned
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  if (!normalized || isApprovalConfirmationText(normalized)) return false;
  const reviewIntent = /\b(?:security\s+review|security\s+audit|audit|review|inspect|verify|check|analy[sz]e|threat\s+model|vulnerability|vulnerabilities)\b/.test(normalized);
  const securitySubject = /\b(?:security|vulnerab|sql\s+injection|xss|csrf|auth|authentication|authorization|permission|privilege|secret|credential|token|exploit|bypass|threat\s+model)\b/.test(normalized);
  const implementationOnly = /\b(?:implement|create|add|build|wire|refactor|docker|dashboard)\b/.test(normalized) &&
    !/\b(?:review|audit|threat\s+model|vulnerab|exploit|sql\s+injection|xss|csrf)\b/.test(normalized);
  return reviewIntent && securitySubject && !implementationOnly;
}

function gateInfo(profile = {}, reqBody = null) {
  const stepShape = profile.stepShape || {};
  const gate = stepShape.gate || "";
  if (!APPROVAL_GATES.has(gate)) return null;
  if (String(reqBody?.model || "").toLowerCase() === "auto-memory") return null;
  const taskKind = profile.taskKind || "general";
  const shape = stepShape.shape || "";
  const reviewLikeTasks = new Set([
    "completion_review",
    "code_review",
    "test_generation",
    "verification",
    "list_summary",
    "direct_answer",
    "explanation",
    "research",
    "planning",
    "documentation",
  ]);
  if (reviewLikeTasks.has(taskKind) && taskKind !== "security_review") return null;
  const reason = profile.reason || taskKind || shape || gate;
  const securityTask = taskKind === "security_review" || String(reason || "").toLowerCase() === "security_review";
  const securitySignoff = shape === "security" && securityTask;
  if (securitySignoff && reqBody && !hasCurrentSecurityReviewIntent(reqBody)) return null;
  const destructiveSignoff =
    shape === "destructive" &&
    !reviewLikeTasks.has(taskKind) &&
    /\b(?:irreversible|production[- ]impacting|production|real\s+(?:data|database|users?))\b/i.test(stepShape.summary || profile.reason || "");
  if (!securitySignoff && !destructiveSignoff) return null;
  return {
    gate,
    shape,
    task_kind: taskKind,
    reason,
    summary: stepShape.summary || "",
  };
}

function isApprovalPromptMessage(message = {}, record = {}) {
  if (message?.role !== "assistant") return false;
  const text = messageContentText(message.content);
  if (!text.includes(APPROVAL_PROMPT_MARKER)) return false;
  if (record.challenge && text.includes(record.challenge)) return true;
  if (record.approval_id && text.includes(record.approval_id)) return true;
  if (record.request_hash && text.includes(record.request_hash)) return true;
  return false;
}

function isApprovalReplyMessage(message = {}, token = "") {
  if (message?.role !== "user") return false;
  const text = messageContentText(message.content);
  if (token && normalizeToken(text) === token) return true;
  return isApprovalConfirmationText(text);
}

function stripApprovalTextFragments(text = "", token = "") {
  let changed = false;
  const tokenRe = /\b(?:approved_by_user|approval_token|token)\s*[:=]\s*[a-f0-9]{32}\b/ig;
  const kept = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    let line = rawLine;
    if (
      line.includes(APPROVAL_PROMPT_MARKER) ||
      /\bHUMAN-APPROVAL-(?:BLOCK|DEFER|REQUIRED)\b/i.test(line) ||
      /\bapproval_id=approval_[a-z0-9_-]+/i.test(line) ||
      /\bgate=human_signoff\b/i.test(line) ||
      /^\s*task=[a-z0-9_.:-]+\b/i.test(line) ||
      /^\s*reason=[a-z0-9_.:-]+\b/i.test(line) ||
      /\brequest_hash=[a-f0-9]{24,}\b/i.test(line) ||
      /The proxy stopped before provider execution because this task requires human sign-off\./i.test(line) ||
      /To continue, reply with:\s*approved_by_user:[a-f0-9]{32}/i.test(line) ||
      /The proxy will strip this approval exchange before routing the original request upstream\./i.test(line)
    ) {
      changed = true;
      continue;
    }
    const withoutToken = line.replace(tokenRe, "").replace(/\s{2,}/g, " ").trim();
    if (withoutToken !== line.trim()) changed = true;
    if (withoutToken) kept.push(withoutToken);
  }
  return { text: kept.join("\n").trim(), changed };
}

function hasApprovalArtifactText(text = "") {
  return (
    String(text || "").includes(APPROVAL_PROMPT_MARKER) ||
    /\bHUMAN-APPROVAL-(?:BLOCK|DEFER|REQUIRED)\b/i.test(text) ||
    /\bapproval_id=approval_[a-z0-9_-]+/i.test(text) ||
    /\bgate=human_signoff\b/i.test(text) ||
    /\brequest_hash=[a-f0-9]{24,}\b/i.test(text) ||
    /\b(?:approved_by_user|approval_token|token)\s*[:=]\s*[a-f0-9]{32}\b/i.test(text)
  );
}

function stripApprovalExchange(reqBody = {}, token = "", record = {}) {
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) return reqBody;
  const approvalToolCallIds = new Set();
  for (const message of reqBody.messages) {
    if ((message?.role === "tool" || message?.role === "function") && normalizeToken(messageContentText(message.content)) === token) {
      const id = message.tool_call_id || message.name || "";
      if (id) approvalToolCallIds.add(id);
    }
  }
  const stripped = [];
  let sawMatchingPrompt = false;
  let skippedImplicitReply = false;
  for (const message of reqBody.messages) {
    if (isApprovalPromptMessage(message, record)) {
      sawMatchingPrompt = true;
      continue;
    }
    if (["user", "tool", "function"].includes(message?.role) && normalizeToken(messageContentText(message.content)) === token) continue;
    if (
      message?.role === "assistant" &&
      approvalToolCallIds.size > 0 &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0 &&
      !messageContentText(message.content).trim() &&
      message.tool_calls.every((call) => approvalToolCallIds.has(call?.id || ""))
    ) {
      continue;
    }
    if (sawMatchingPrompt && !skippedImplicitReply && isApprovalReplyMessage(message, "")) {
      skippedImplicitReply = true;
      continue;
    }
    stripped.push(message);
  }
  if (stripped.length !== reqBody.messages.length) reqBody.messages = stripped;
  return reqBody;
}

function stripApprovalArtifacts(reqBody = {}, token = "") {
  if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) return 0;
  const approvalToolCallIds = new Set();
  for (const message of reqBody.messages) {
    if ((message?.role === "tool" || message?.role === "function") && normalizeToken(messageContentText(message.content))) {
      const id = message.tool_call_id || message.name || "";
      if (id) approvalToolCallIds.add(id);
    }
  }

  const kept = [];
  let removed = 0;
  for (const message of reqBody.messages) {
    const text = messageContentText(message?.content);
    const messageToken = normalizeToken(text);
    if (message?.role === "assistant" && hasApprovalArtifactText(text)) {
      const cleaned = stripApprovalTextFragments(text, token);
      removed++;
      if (cleaned.text || Array.isArray(message.tool_calls)) {
        kept.push({
          ...message,
          content: cleaned.text || (Array.isArray(message.tool_calls) ? null : ""),
        });
      }
      continue;
    }
    if (["user", "tool", "function"].includes(message?.role) && (messageToken || hasApprovalArtifactText(text))) {
      const cleaned = stripApprovalTextFragments(text, token);
      if (cleaned.changed) {
        removed++;
        if (cleaned.text) kept.push({ ...message, content: cleaned.text });
        continue;
      }
    }
    if (["user", "tool", "function"].includes(message?.role) && messageToken && (!token || messageToken === token)) {
      removed++;
      continue;
    }
    if (
      message?.role === "assistant" &&
      approvalToolCallIds.size > 0 &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0 &&
      !text.trim() &&
      message.tool_calls.every((call) => approvalToolCallIds.has(call?.id || ""))
    ) {
      removed++;
      continue;
    }
    kept.push(message);
  }
  if (removed > 0) reqBody.messages = kept;
  return removed;
}

function approvalState() {
  if (!state.humanApprovals.pending) state.humanApprovals.pending = {};
  if (!state.humanApprovals.byRequestHash) state.humanApprovals.byRequestHash = {};
  if (!state.humanApprovals.audit) state.humanApprovals.audit = [];
  return state.humanApprovals;
}

function appendAudit(event) {
  const entry = { ts: new Date().toISOString(), ...event };
  const approvals = approvalState();
  approvals.audit.push(entry);
  if (approvals.audit.length > 500) approvals.audit.splice(0, approvals.audit.length - 500);
  try {
    fs.mkdirSync(state.DATA_DIR, { recursive: true });
    fs.appendFileSync(APPROVAL_AUDIT_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Audit persistence should never break request routing.
  }
}

function cleanupExpired(now = Date.now()) {
  const approvals = approvalState();
  for (const [challenge, record] of Object.entries(approvals.pending)) {
    if (record.expires_at_ms <= now) {
      record.status = record.status === "approved" ? record.status : "expired";
      delete approvals.pending[challenge];
      if (approvals.byRequestHash[record.request_hash] === challenge) delete approvals.byRequestHash[record.request_hash];
      appendAudit({ event: "expired", approval_id: record.approval_id, challenge, request_hash: record.request_hash });
    }
  }
}

function existingPending(requestHashValue, now = Date.now()) {
  const approvals = approvalState();
  const challenge = approvals.byRequestHash[requestHashValue];
  if (!challenge) return null;
  const record = approvals.pending[challenge];
  if (!record || record.expires_at_ms <= now) return null;
  return record;
}

function createPending(reqBody, profile, info, requestHashValue, now = Date.now()) {
  cleanupExpired(now);
  const existing = existingPending(requestHashValue, now);
  if (existing) return existing;

  const session = memory.getSession(reqBody.messages || []);
  const challenge = crypto.randomBytes(16).toString("hex");
  const expiresAtMs = now + ttlMs();
  const record = {
    approval_id: `approval_${now}_${crypto.randomBytes(4).toString("hex")}`,
    challenge,
    status: "pending",
    approved_by_user: false,
    request_hash: requestHashValue,
    session_id: session?.id || "unknown",
    gate: info.gate,
    shape: info.shape,
    task_kind: info.task_kind,
    reason: info.reason,
    summary: info.summary,
    created_at_ms: now,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    expires_at_ms: expiresAtMs,
  };
  const approvals = approvalState();
  approvals.pending[challenge] = record;
  approvals.byRequestHash[requestHashValue] = challenge;
  appendAudit({ event: "pending", ...auditRecord(record) });
  return record;
}

function auditRecord(record = {}) {
  return {
    approval_id: record.approval_id,
    challenge: record.challenge,
    status: record.status,
    approved_by_user: !!record.approved_by_user,
    request_hash: record.request_hash,
    session_id: record.session_id,
    gate: record.gate,
    shape: record.shape,
    task_kind: record.task_kind,
    reason: record.reason,
    expires_at: record.expires_at,
  };
}

function approvalPayload(record, code = "human_signoff_required", message = "") {
  const gateLabel = "human sign-off";
  return {
    error: {
      message: message || `This request requires ${gateLabel} before the proxy will route it. Retry after review with header X-LLM-Proxy-Approval: approved_by_user:${record.challenge}, or set body field approved_by_user to the same value.`,
      type: "human_approval_required",
      param: "messages",
      code,
    },
    approval: {
      required: true,
      approved_by_user: false,
      approval_id: record.approval_id,
      challenge: record.challenge,
      token_format: `approved_by_user:${record.challenge}`,
      gate: record.gate,
      shape: record.shape,
      task_kind: record.task_kind,
      reason: record.reason,
      request_hash: record.request_hash,
      expires_at: record.expires_at,
      audit_file: APPROVAL_AUDIT_FILE,
    },
  };
}

function profileFromApprovalRecord(record = {}) {
  return {
    taskKind: record.task_kind || "general",
    reason: record.reason || record.task_kind || record.shape || record.gate || "human_signoff",
    stepShape: {
      gate: record.gate || "human_signoff",
      shape: record.shape || "",
      summary: record.summary || "",
    },
  };
}

function approvalPromptText(record = {}) {
  const gateLabel = "human sign-off";
  return [
    APPROVAL_PROMPT_MARKER,
    `approval_id=${record.approval_id}`,
    `gate=${record.gate}`,
    `task=${record.task_kind}`,
    `reason=${record.reason}`,
    `request_hash=${record.request_hash}`,
    "",
    `The proxy stopped before provider execution because this task requires ${gateLabel}.`,
    `To continue, reply with: approved_by_user:${record.challenge}`,
    "The proxy will strip this approval exchange before routing the original request upstream.",
  ].join("\n");
}

function chatApprovalPayload(record = {}, reqBody = {}) {
  const content = approvalPromptText(record);
  return {
    id: `chatcmpl_approval_${record.approval_id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: reqBody.model || "llm-proxy",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(content.length / 4),
      total_tokens: Math.ceil(content.length / 4),
    },
    approval: approvalPayload(record).approval,
  };
}

function block(record, code, message) {
  return { ok: false, status: 409, record, payload: approvalPayload(record, code, message) };
}

function enforce(reqBody = {}, profile = {}, options = {}) {
  const token = normalizeToken(reqBody._llmProxyHumanApprovalToken) || extractApprovalToken(reqBody, options);
  delete reqBody._llmProxyHumanApprovalToken;
  stripApprovalFields(reqBody);

  if (options.internal || !envEnabled(options.env || process.env)) return { ok: true };
  if (reqBody._llmProxyInternalAssessment || reqBody._llmProxyInternalSummary || reqBody._llmProxyBypassOptimizations) return { ok: true };

  const now = Date.now();
  cleanupExpired(now);
  const approvals = approvalState();
  const record = token ? approvals.pending[token] : null;
  const profileInfo = gateInfo(profile, record ? null : reqBody);
  if (record) stripApprovalExchange(reqBody, token, record);
  if (token && record && !profileInfo) {
    appendAudit({ event: "ignored", code: "approval_token_not_needed", approval_id: record.approval_id, challenge: token, request_hash: record.request_hash });
    return { ok: true, ignored: true, record };
  }
  const recordInfo = record ? {
    gate: record.gate,
    shape: record.shape,
    task_kind: record.task_kind,
    reason: record.reason,
    summary: record.summary,
  } : null;
  const info = recordInfo || profileInfo;
  if (!info) return { ok: true };
  const hashProfile = record ? profileFromApprovalRecord(record) : {
    taskKind: info.task_kind,
    reason: info.reason,
    stepShape: {
      gate: info.gate,
      shape: info.shape,
      summary: info.summary,
    },
  };
  if (!token) {
    if (options.approveOnly) return { ok: true };
    const hash = requestHash(reqBody, hashProfile);
    return block(createPending(reqBody, profile, info, hash, now), "human_signoff_required");
  }

  const hash = requestHash(reqBody, hashProfile);
  if (!record) {
    const pending = createPending(reqBody, profile, info, hash, now);
    appendAudit({ event: "rejected", code: "approval_token_invalid", challenge: token, request_hash: hash, gate: info.gate });
    return block(pending, "approval_token_invalid", "Approval token is invalid or expired. Use the new challenge token returned in this response.");
  }
  if (record.expires_at_ms <= now) {
    delete approvals.pending[token];
    if (approvals.byRequestHash[record.request_hash] === token) delete approvals.byRequestHash[record.request_hash];
    record.status = "expired";
    appendAudit({ event: "expired", ...auditRecord(record) });
    if (!gateInfo(profile, reqBody)) return { ok: true, ignored: true, record };
    const pending = createPending(reqBody, profile, info, hash, now);
    return block(pending, "approval_token_expired", "Approval token expired. Use the new challenge token returned in this response.");
  }
  if (record.request_hash !== hash) {
    if (!gateInfo(profile, reqBody)) {
      appendAudit({ event: "ignored", code: "approval_request_mismatch_not_needed", approval_id: record.approval_id, challenge: token, expected_hash: record.request_hash, request_hash: hash });
      return { ok: true, ignored: true, record };
    }
    const pending = createPending(reqBody, profile, info, hash, now);
    appendAudit({ event: "rejected", code: "approval_request_mismatch", approval_id: record.approval_id, challenge: token, expected_hash: record.request_hash, request_hash: hash });
    return block(pending, "approval_request_mismatch", "Approval token belongs to a different request. Review this request and approve the new challenge token.");
  }

  record.status = "approved";
  record.approved_by_user = true;
  record.approved_at = new Date(now).toISOString();
  appendAudit({ event: "approved", ...auditRecord(record), approved_at: record.approved_at });
  return { ok: true, approved: true, record };
}

function wantsHttpError(reqBody = {}, env = process.env) {
  const mode = String(env.LLM_PROXY_HUMAN_APPROVAL_RESPONSE_MODE || "").trim().toLowerCase();
  return mode === "http_error" || mode === "409" || reqBody._llmProxyHumanApprovalHttpError === true;
}

function writeBlockedResponse(res, result, reqBody = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-LLM-Proxy-Approval-Required": "true",
    "X-LLM-Proxy-Approval-Challenge": result.record.challenge,
    "X-LLM-Proxy-Approval-Gate": result.record.gate,
  };

  if (wantsHttpError(reqBody)) {
    res.writeHead(result.status || 409, headers);
    res.end(JSON.stringify(result.payload));
    return;
  }

  if (reqBody.stream === true) {
    const id = `chatcmpl_approval_${result.record.approval_id || Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const content = approvalPromptText(result.record);
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: reqBody.model || "llm-proxy", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: reqBody.model || "llm-proxy", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: reqBody.model || "llm-proxy", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil(content.length / 4) } })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }

  res.writeHead(200, headers);
  res.end(JSON.stringify(chatApprovalPayload(result.record, reqBody)));
}

function health() {
  cleanupExpired();
  const approvals = approvalState();
  const pending = Object.values(approvals.pending);
  return {
    enabled: envEnabled(),
    pending: pending.length,
    approved_recent: approvals.audit.filter((entry) => entry.event === "approved").length,
    audit_file: APPROVAL_AUDIT_FILE,
  };
}

module.exports = {
  APPROVAL_AUDIT_FILE,
  enforce,
  writeBlockedResponse,
  stripApprovalFields,
  stripApprovalArtifacts,
  stripApprovalExchange,
  extractApprovalToken,
  health,
  requestHash,
  approvalPromptText,
};
