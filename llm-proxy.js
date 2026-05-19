#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const { URL } = require("url");
const mempalace = require("./llm-mempalace");

const state = require("./lib/state");
const scoring = require("./lib/scoring");
const providersMod = require("./lib/providers");
const compaction = require("./lib/compaction");
const transforms = require("./lib/transforms");
const routing = require("./lib/routing");
const responses = require("./lib/responses");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------------------
// Entry-point config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.LLM_PROXY_PORT || "18900", 10);
const THINKING_PROBE_INTERVAL = 60 * 60_000;

// ---------------------------------------------------------------------------
// Session token tracking
// ---------------------------------------------------------------------------
function trackSessionTokens(sessionId, inputTokens, outputTokens, providerName) {
  if (!state.sessionStats[sessionId]) {
    state.sessionStats[sessionId] = { totalInputTokens: 0, totalOutputTokens: 0, requests: 0, startTime: Date.now(), lastRequest: 0, providers: {} };
  }
  const s = state.sessionStats[sessionId];
  s.totalInputTokens += inputTokens;
  s.totalOutputTokens += outputTokens || 0;
  if (inputTokens > 0) s.requests++;
  s.lastRequest = Date.now();
  if (providerName) {
    if (!s.providers[providerName]) s.providers[providerName] = { input: 0, output: 0, requests: 0 };
    s.providers[providerName].input += inputTokens;
    s.providers[providerName].output += outputTokens || 0;
    if (inputTokens > 0) s.providers[providerName].requests++;
  }
}

// ---------------------------------------------------------------------------
// Wire late-bound dependencies into routing
// ---------------------------------------------------------------------------
routing.init({ sendError, trackSessionTokens });
responses.init({ handleChatCompletion: routing.handleChatCompletion });

// ---------------------------------------------------------------------------
// Thinking probe
// ---------------------------------------------------------------------------
async function probeThinking() {
  const thinkingProviders = state.PROVIDERS.filter((p) => {
    if (!p.key || !p.tc || p.alive === false) return false;
    const s = scoring.getScore(p.name);
    if (s.thinking_ok > 0) return false;
    if ((s._probeAttempts || 0) >= 3) return false;
    return true;
  });
  if (thinkingProviders.length === 0) return;
  state.log(`Thinking probe: ${thinkingProviders.length} unverified providers`);
  for (const p of thinkingProviders) {
    try {
      const body = transforms.transformRequest(p, {
        messages: [{ role: "user", content: "What is 15 * 37? Think step by step." }],
        max_tokens: 500,
      });
      const resp = await routing.makeRequest(p.url, {
        method: "POST",
        headers: transforms.buildHeaders(p),
      }, JSON.stringify(body));

      const s = scoring.getScore(p.name);
      s._probeAttempts = (s._probeAttempts || 0) + 1;
      if (resp.status < 400 && transforms.detectThinking(resp.body)) {
        scoring.recordThinkingOk(p.name);
        state.log(`Thinking OK: ${p.name}`);
      }
    } catch {
      const s = scoring.getScore(p.name);
      s._probeAttempts = (s._probeAttempts || 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Models endpoint
// ---------------------------------------------------------------------------
function handleModels(query) {
  const capFilter = query.get("cap");
  let list = state.PROVIDERS.filter((p) => p.key && p.alive !== false);
  if (capFilter) {
    list = list.filter((p) => p.caps.includes(capFilter));
  }

  const models = list.map((p) => ({
    id: p.model,
    object: "model",
    created: 0,
    owned_by: p.name,
    capabilities: p.caps,
    context_length: scoring.getEffectiveContext(p),
    tier: p.tier,
    thinking_capable: p.tc,
  }));

  // Add smart groups
  const groups = Object.keys(state.GROUPS).map((g) => ({
    id: g,
    object: "model",
    created: 0,
    owned_by: "llm-proxy",
    capabilities: state.GROUPS[g] === null ? ["all"] : [state.GROUPS[g]],
    context_length: 131072,
    tier: 0,
    thinking_capable: g === "auto-thinking",
    is_group: true,
    provider_count: routing.getProvidersForGroup(g, 0, null).length,
  }));

  // Add auto group (smart use-case detection)
  groups.unshift({
    id: "auto",
    object: "model",
    created: 0,
    owned_by: "llm-proxy",
    capabilities: ["all", "auto-detect"],
    context_length: Math.max(...state.PROVIDERS.filter((p) => p.key && p.alive !== false).map((p) => scoring.getEffectiveContext(p)), 0),
    tier: 0,
    thinking_capable: true,
    is_group: true,
    provider_count: state.PROVIDERS.filter((p) => p.key && p.alive !== false).length,
    description: "Auto-detects use case (coding, thinking, images, tools) and routes to best provider with full fallback",
  });

  return { object: "list", data: [...groups, ...models] };
}

// ---------------------------------------------------------------------------
// Capabilities endpoint
// ---------------------------------------------------------------------------
function handleCapabilities() {
  const caps = {};
  const allCaps = new Set();
  for (const p of state.PROVIDERS) {
    if (!p.key || p.alive === false) continue;
    for (const c of p.caps) {
      allCaps.add(c);
      if (!caps[c]) caps[c] = { providers: [], count: 0 };
      caps[c].providers.push(p.name);
      caps[c].count++;
    }
  }
  return {
    capabilities: caps,
    groups: Object.keys(state.GROUPS).map((g) => ({
      name: g,
      capability: state.GROUPS[g],
      provider_count: routing.getProvidersForGroup(g, 0, null).length,
    })),
    total_providers: state.PROVIDERS.filter((p) => p.key && p.alive !== false).length,
    total_capabilities: allCaps.size,
  };
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------
function handleHealth() {
  const active = state.PROVIDERS.filter((p) => p.key && p.alive !== false);
  const byTier = { 1: 0, 2: 0, 3: 0 };
  for (const p of active) byTier[p.tier] = (byTier[p.tier] || 0) + 1;

  return {
    status: "ok",
    uptime: process.uptime(),
    uptime_human: formatUptime(process.uptime()),
    providers_version: state.providersVersion,
    providers_source: fs.existsSync(state.PROVIDERS_FILE) ? "providers.json" : "seed",
    providers: {
      total: state.PROVIDERS.length,
      active: active.length,
      by_tier: byTier,
    },
    groups: Object.keys(state.GROUPS).map((g) => ({
      name: g,
      available: routing.getProvidersForGroup(g, 0, null).length,
    })),
    quota_disabled: Object.keys(state.quotaDisabled).length > 0 ? state.quotaDisabled : undefined,
    compat_overrides: Object.keys(state.providerCompat).length > 0 ? Object.keys(state.providerCompat).length : undefined,
    mempalace: mempalace.mempalaceHealth(),
    scores_file: fs.existsSync(state.SCORES_FILE),
    discovery_file: fs.existsSync(state.DISCOVERY_FILE),
    providers_file: fs.existsSync(state.PROVIDERS_FILE),
  };
}

// ---------------------------------------------------------------------------
// Scores endpoint
// ---------------------------------------------------------------------------
function handleScores() {
  return state.scores;
}

// ---------------------------------------------------------------------------
// Banned endpoint
// ---------------------------------------------------------------------------
function handleBanned() {
  const now = Date.now();
  const allProviders = state.PROVIDERS.filter((p) => p.key);

  const cooldowns = [];
  const quotaDisabledList = [];

  for (const p of allProviders) {
    const s = scoring.getScore(p.name);

    if (scoring.isOnCooldown(p.name)) {
      const expiresMs = s.cooldown_until - now;
      const expiresMin = Math.round(expiresMs / 60000);
      const stalling = (state.stallingTracker?.[p.name] || []).length;
      cooldowns.push({
        name: p.name,
        model: p.model,
        reason: s.cooldown_reason || "unknown",
        expires_in_min: Math.max(0, expiresMin),
        ...(stalling > 0 ? { stalling } : {}),
      });
    }

    if (scoring.isQuotaDisabled(p.name)) {
      const entry = state.quotaDisabled[p.name];
      const expiresMs = entry?.expires_at ? entry.expires_at - now : null;
      const expiresMin = expiresMs != null ? Math.round(expiresMs / 60000) : null;
      quotaDisabledList.push({
        name: p.name,
        model: p.model,
        reason: entry?.reason || "quota/billing error",
        ...(expiresMin != null ? { expires_in_min: Math.max(0, expiresMin) } : {}),
      });
    }
  }

  // Group bans: convert Sets to arrays
  const groupBans = {};
  for (const [group, names] of Object.entries(state.groupBans)) {
    const arr = names instanceof Set ? [...names] : names;
    if (arr.length > 0) groupBans[group] = arr;
  }

  const totalBanned = new Set([
    ...cooldowns.map((x) => x.name),
    ...quotaDisabledList.map((x) => x.name),
    ...Object.values(groupBans).flat(),
  ]).size;

  return {
    cooldowns,
    quota_disabled: quotaDisabledList,
    group_bans: groupBans,
    total_banned: totalBanned,
    total_active: allProviders.filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isQuotaDisabled(p.name)).length,
  };
}

// ---------------------------------------------------------------------------
// Discovery endpoint
// ---------------------------------------------------------------------------
function handleDiscovery() {
  try {
    if (fs.existsSync(state.DISCOVERY_FILE)) {
      return JSON.parse(fs.readFileSync(state.DISCOVERY_FILE, "utf8"));
    }
  } catch {}
  return { models: [], last_scan: null };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function sendError(res, status, message, details) {
  const body = JSON.stringify({ error: { message, type: "proxy_error", ...details } });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    // POST /v1/chat/completions
    if (method === "POST" && pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return sendError(res, 400, "Invalid JSON body");
      }
      const est = compaction.estimateTokens(parsed.messages);
      const model = parsed.model || "auto";
      const sid = mempalace.getSession(parsed.messages).id;
      const ss = state.sessionStats[sid];
      const sessionInfo = ss ? ` session[reqs=${ss.requests} in=${Math.round(ss.totalInputTokens/1000)}K out=${Math.round(ss.totalOutputTokens/1000)}K age=${Math.round((Date.now()-ss.startTime)/60000)}min]` : "";
      if (model === "auto") {
        const { caps, isAgent } = transforms.detectUseCase(parsed.messages, parsed);
        state.log(`Request: model=auto stream=${!!parsed.stream} msgs=${parsed.messages?.length || 0} ~${est}tok caps=[${[...caps]}] agent=${isAgent} sid=${sid}${sessionInfo}`);
      } else {
        state.log(`Request: model=${model} stream=${!!parsed.stream} msgs=${parsed.messages?.length || 0} ~${est}tok sid=${sid}${sessionInfo}`);
      }
      return await routing.handleChatCompletion(parsed, res);
    }

    // POST /v1/responses (Responses API — for Codex CLI)
    if (method === "POST" && pathname === "/v1/responses") {
      const body = await readBody(req);
      state.log(`Responses API: POST body=${body.length}chars`);
      return await responses.handleResponsesHTTP(req, res, body);
    }

    // GET /v1/models
    if (method === "GET" && pathname === "/v1/models") {
      return sendJSON(res, handleModels(urlObj.searchParams));
    }

    // GET /v1/capabilities
    if (method === "GET" && pathname === "/v1/capabilities") {
      return sendJSON(res, handleCapabilities());
    }

    // GET /health
    if (method === "GET" && pathname === "/health") {
      return sendJSON(res, handleHealth());
    }

    // GET /scores
    if (method === "GET" && pathname === "/scores") {
      return sendJSON(res, handleScores());
    }

    // GET /banned
    if (method === "GET" && pathname === "/banned") {
      return sendJSON(res, handleBanned());
    }

    // POST /ban — ban a provider by name or pattern
    // Body: {"pattern": "DSV4Flash", "hours": 12, "reason": "garbled output"}
    if (method === "POST" && pathname === "/ban") {
      const body = await readBody(req);
      try {
        const { pattern, name, hours, reason } = JSON.parse(body);
        const pat = pattern || name;
        if (!pat || !hours) return sendError(res, 400, "Need pattern + hours");
        const re = new RegExp(pat, "i");
        const banned = [];
        for (const p of state.PROVIDERS) {
          if (re.test(p.name) || re.test(p.model)) {
            scoring.setCooldown(p.name, hours * 3600_000, reason || `API ban ${hours}h`);
            const s = scoring.getScore(p.name);
            s.stalling = Math.max(s.stalling || 0, 5);
            s.last_stall_time = Date.now();
            scoring.saveScores();
            banned.push(p.name);
            state.log(`API-BAN: ${p.name} banned ${hours}h — ${reason || "manual"}`);
          }
        }
        return sendJSON(res, { banned, hours, reason });
      } catch { return sendError(res, 400, "Invalid JSON"); }
    }

    // POST /unban — clear cooldowns by pattern or "all"
    if (method === "POST" && pathname === "/unban") {
      const body = await readBody(req);
      try {
        const { pattern } = JSON.parse(body);
        const unbanned = [];
        for (const p of state.PROVIDERS) {
          if (!p.key) continue;
          const s = scoring.getScore(p.name);
          if (s.cooldown_until <= Date.now()) continue;
          if (pattern === "all" || (pattern && new RegExp(pattern, "i").test(p.name))) {
            s.cooldown_until = 0;
            unbanned.push(p.name);
          }
        }
        scoring.saveScores();
        state.log(`API-UNBAN: cleared ${unbanned.length} cooldowns (pattern: ${pattern})`);
        return sendJSON(res, { unbanned, count: unbanned.length });
      } catch { return sendError(res, 400, "Invalid JSON. Use {\"pattern\":\"all\"} or {\"pattern\":\"Groq\"}"); }
    }

    // GET /discovery
    if (method === "GET" && pathname === "/discovery") {
      return sendJSON(res, handleDiscovery());
    }

    // GET /stats — session token usage
    if (method === "GET" && pathname === "/stats") {
      const sessions = Object.entries(state.sessionStats).map(([id, s]) => ({
        session: id,
        requests: s.requests,
        input_tokens: s.totalInputTokens,
        output_tokens: s.totalOutputTokens,
        total_tokens: s.totalInputTokens + s.totalOutputTokens,
        started: new Date(s.startTime).toISOString(),
        last_request: new Date(s.lastRequest).toISOString(),
        age_minutes: Math.round((Date.now() - s.startTime) / 60000),
        providers: s.providers || {},
      }));
      const totals = {
        total_sessions: sessions.length,
        total_requests: sessions.reduce((s, x) => s + x.requests, 0),
        total_input_tokens: sessions.reduce((s, x) => s + x.input_tokens, 0),
        total_output_tokens: sessions.reduce((s, x) => s + x.output_tokens, 0),
      };
      totals.total_tokens = totals.total_input_tokens + totals.total_output_tokens;

      // Aggregate by source and provider across all sessions
      const byProvider = {};
      const bySource = {};
      const byModel = {};
      for (const sess of sessions) {
        for (const [prov, stats] of Object.entries(sess.providers || {})) {
          // Per provider
          if (!byProvider[prov]) byProvider[prov] = { input: 0, output: 0, requests: 0, total: 0 };
          byProvider[prov].input += stats.input;
          byProvider[prov].output += stats.output;
          byProvider[prov].requests += stats.requests;
          byProvider[prov].total = byProvider[prov].input + byProvider[prov].output;

          // Per source
          const source = prov.split("-")[0];
          if (!bySource[source]) bySource[source] = { input: 0, output: 0, requests: 0, total: 0, providers: 0 };
          bySource[source].input += stats.input;
          bySource[source].output += stats.output;
          bySource[source].requests += stats.requests;
          bySource[source].total = bySource[source].input + bySource[source].output;

          // Per model
          const p = state.PROVIDERS.find(x => x.name === prov);
          const model = p?.model || prov;
          if (!byModel[model]) byModel[model] = { input: 0, output: 0, requests: 0, total: 0, sources: [] };
          byModel[model].input += stats.input;
          byModel[model].output += stats.output;
          byModel[model].requests += stats.requests;
          byModel[model].total = byModel[model].input + byModel[model].output;
          if (!byModel[model].sources.includes(source)) byModel[model].sources.push(source);
        }
      }
      // Count unique providers per source
      for (const [prov] of Object.entries(byProvider)) {
        const source = prov.split("-")[0];
        if (bySource[source]) bySource[source].providers++;
      }

      return sendJSON(res, {
        ...totals,
        uptime_minutes: Math.round((Date.now() - (sessions[0]?.started ? new Date(sessions[0].started).getTime() : Date.now())) / 60000),
        by_source: bySource,
        by_provider: byProvider,
        by_model: byModel,
        sessions,
      });
    }

    // 404
    sendError(res, 404, "Not found");
  } catch (err) {
    state.log(`Server error: ${err.message}`);
    sendError(res, 500, "Internal server error", { detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
scoring.loadScores();
scoring.loadQuotaDisabled();
scoring.loadCompat();
providersMod.loadProviders();
providersMod.watchProvidersFile(() => { probeThinking().catch(() => {}); });

// Re-apply learned context limits
for (const [name, c] of Object.entries(state.providerCompat)) {
  if (c.real_context) {
    const p = state.PROVIDERS.find((pr) => pr.name === name);
    if (p && p.context > c.real_context) p.context = c.real_context;
  }
}

server.listen(PORT, () => {
  const active = state.PROVIDERS.filter((p) => p.key && p.alive !== false).length;
  state.log(`LLM Smart Proxy started on port ${PORT}`);
  state.log(`Active providers: ${active}/${state.PROVIDERS.length}`);
  state.log(`Smart groups: ${Object.keys(state.GROUPS).join(", ")}`);
  state.log(`Config source: ${fs.existsSync(state.PROVIDERS_FILE) ? "providers.json" : "seed-providers.json (fallback)"}`);
  state.log(`Endpoints: /v1/chat/completions, /v1/responses (WS+SSE), /v1/models, /v1/capabilities, /health, /scores, /discovery, /stats`);
});

// WebSocket server for /v1/responses (Codex CLI)
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/v1/responses") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      responses.handleResponsesWS(ws, req);
    });
  } else {
    socket.destroy();
  }
});

probeThinking().catch(() => {});
setInterval(() => { probeThinking().catch(() => {}); }, THINKING_PROBE_INTERVAL);

// Cache eviction — clean stale entries every hour
setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 24 * 3600_000; // 24h
  let evicted = 0;
  // Session stats — evict sessions older than 24h
  for (const [id, s] of Object.entries(state.sessionStats)) {
    if (now - s.lastRequest > MAX_AGE) { delete state.sessionStats[id]; evicted++; }
  }
  // Session compact cache — evict old
  for (const [id, c] of Object.entries(state.sessionCompactCache)) {
    if (now - c.timestamp > MAX_AGE) { delete state.sessionCompactCache[id]; evicted++; }
  }
  // Compaction drop cache — evict old sessions
  for (const id of Object.keys(state.compactionDropCache)) {
    if (!state.sessionStats[id]) { delete state.compactionDropCache[id]; evicted++; }
  }
  // Truncation cache — cap at 500 entries
  const truncKeys = Object.keys(state.truncationCache);
  if (truncKeys.length > 500) {
    for (const k of truncKeys.slice(0, truncKeys.length - 500)) { delete state.truncationCache[k]; evicted++; }
  }
  // File activity — evict sessions no longer tracked
  for (const id of Object.keys(state.fileActivity)) {
    if (!state.sessionStats[id]) { delete state.fileActivity[id]; evicted++; }
  }
  // Stalling tracker — evict old entries
  for (const [name, times] of Object.entries(state.stallingTracker)) {
    state.stallingTracker[name] = times.filter(t => now - t < 3600_000);
    if (state.stallingTracker[name].length === 0) { delete state.stallingTracker[name]; evicted++; }
  }
  if (evicted > 0) state.log(`CACHE-EVICT: cleaned ${evicted} stale entries`);
}, 3600_000);

process.on("SIGTERM", () => { scoring.saveScores(); process.exit(0); });
process.on("SIGINT", () => { scoring.saveScores(); process.exit(0); });
