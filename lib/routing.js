"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const state = require("./state");
const scoring = require("./scoring");
const compaction = require("./compaction");
const transforms = require("./transforms");
const providers = require("./providers");
const mempalace = require("../llm-mempalace");

// Late-bound dependencies from entry point (set via init())
let _sendError;
let _trackSessionTokens;

function init({ sendError, trackSessionTokens }) {
  _sendError = sendError;
  _trackSessionTokens = trackSessionTokens;
}

// Build OpenAI-compatible usage headers for IDE/client consumption
function buildUsageHeaders(provider, reqBody, usage) {
  const effCtx = scoring.getEffectiveContext(provider);
  const inputTokens = usage?.prompt_tokens || compaction.estimateTokens(reqBody.messages);
  const outputTokens = usage?.completion_tokens || 0;
  const totalTokens = inputTokens + outputTokens;
  const remaining = Math.max(0, effCtx - totalTokens);
  const sid = mempalace.getSession(reqBody.messages)?.id;
  const ss = sid ? state.sessionStats[sid] : null;

  return {
    "X-LLM-Provider": provider.name,
    "X-LLM-Model": provider.model,
    "X-LLM-Context-Length": String(effCtx),
    "X-LLM-Tokens-Used": String(totalTokens),
    "X-LLM-Tokens-Remaining": String(remaining),
    "X-LLM-Prompt-Tokens": String(inputTokens),
    "X-LLM-Completion-Tokens": String(outputTokens),
    ...(ss ? {
      "X-LLM-Session-Requests": String(ss.requests),
      "X-LLM-Session-Total-Tokens": String(ss.totalInputTokens + ss.totalOutputTokens),
    } : {}),
  };
}

function makeRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(parsed, options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("utf8") });
      });
    });
    req.on("error", reject);
    req.setTimeout(state.REQUEST_TIMEOUT, () => { req.destroy(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

function streamRequest(urlStr, options, body, onData, onEnd, onError) {
  const parsed = new URL(urlStr);
  const mod = parsed.protocol === "https:" ? https : http;
  const req = mod.request(parsed, options, (res) => {
    if (res.statusCode >= 400) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        onError(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`), res.statusCode);
      });
      return;
    }
    res.on("data", onData);
    res.on("end", onEnd);
    res.on("error", onError);
  });
  req.on("error", (e) => onError(e));
  req.setTimeout(state.REQUEST_TIMEOUT, () => { req.destroy(new Error("timeout")); });
  if (body) req.write(body);
  req.end();
  return req;
}

function getProvidersForGroup(groupName, estimatedTokens, reqBody) {
  const cap = state.GROUPS[groupName];
  const { caps: detectedCaps, isAgent, needsUpgrade } = transforms.detectUseCase(reqBody?.messages, reqBody);

  // All alive providers with enough context
  const all = state.PROVIDERS.filter((p) => p.key && p.alive !== false)
    .filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isQuotaDisabled(p.name) && !scoring.isBannedFromGroup(p.name, groupName));
  const withContext = estimatedTokens > 0 ? all.filter((p) => scoring.getEffectiveContext(p) >= estimatedTokens) : all;

  // Does request carry reasoning_content or need thinking?
  const hasReasoning = (reqBody?.messages || []).some((m) => m.reasoning_content);
  const needsThinking = cap === "thinking" || detectedCaps.has("thinking");
  const needsTools = cap === "tools" || detectedCaps.has("tools") || isAgent;
  const hasToolHistory = (reqBody?.messages || []).some((m) => m.role === "assistant" && m.tool_calls?.length > 0);

  // Score each provider: base score + smartness + group match + detected caps + agent boost + compat
  const scored = withContext.map((p) => {
    let bonus = 0;
    const compat = scoring.getCompat(p.name);

    // Benchmark-backed model scoring for this group's category
    bonus += transforms.smartnessBonus(p, cap, reqBody);

    // Group capability match: strong bonus for matching, but don't exclude non-matching
    if (cap !== null && cap !== undefined) {
      if (p.caps.includes(cap)) bonus += 0.6;
      else bonus -= 0.3; // penalize but still include as fallback
    }

    // Group-specific hard requirements: coding/max need tools+thinking
    if (cap === "coding" || cap === "max") {
      if (p.caps.includes("tools")) bonus += 0.3;
      else bonus -= 0.5;
      if (p.tc || p.caps.includes("thinking")) bonus += 0.2;
      else bonus -= 0.3;
    }

    // Detected use-case bonus (from message analysis)
    for (const dc of detectedCaps) {
      if (p.caps.includes(dc)) bonus += 0.2;
    }

    // Agent/IDE mode: prefer tier 1, require tools
    if (isAgent) {
      if (p.tier === 1) bonus += 0.4;
      if (p.tier === 3) bonus -= 0.4;
      if (!p.caps.includes("tools")) bonus -= 0.8;
    }

    // Complexity escalation: model flagged task as complex, or implementation active
    if (needsUpgrade) {
      if (p.tier === 1) bonus += 0.8; // strong preference for frontier models
      if (p.tier === 3) bonus -= 1.0;
      if (p.tc) bonus += 0.3; // thinking-capable models handle complex tasks better
    }

    // Learned compat penalties: avoid providers that will fail for this request type
    if (compat.no_reasoning && hasReasoning) bonus -= 0.5;
    if (compat.no_extra_body && needsThinking) bonus -= 0.3;
    if (compat.max_tokens_cap && needsTools) bonus -= 0.1;
    if (compat.no_reasoning && needsThinking) bonus -= 0.3;
    if (compat.no_tool_history && hasToolHistory) bonus -= 99; // hard exclude — will fail on tool replay
    if (compat.no_tools && needsTools) bonus -= 99; // hard exclude — model can't use tools

    // Session affinity — prefer same provider that worked last in this session
    const lastProv = reqBody?._sessionLastProvider;
    if (lastProv) {
      if (p.name === lastProv) bonus += 0.4; // strong preference for same provider
      else if (p.model === state.PROVIDERS.find((x) => x.name === lastProv)?.model) bonus += 0.2; // same model different source
    }

    return { provider: p, score: scoring.providerScore(p) + bonus };
  });

  return scored.sort((a, b) => b.score - a.score).map((s) => s.provider);
}

// auto group: same logic but no specific group capability filter
function getProvidersForAuto(messages, estimatedTokens, reqBody) {
  const { caps: detectedCaps, isAgent, needsUpgrade } = transforms.detectUseCase(messages, reqBody);
  const hasReasoning = (messages || []).some((m) => m.reasoning_content);
  const needsThinking = detectedCaps.has("thinking");
  const hasToolHistory = (messages || []).some((m) => m.role === "assistant" && m.tool_calls?.length > 0);

  const all = state.PROVIDERS.filter((p) => p.key && p.alive !== false)
    .filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isQuotaDisabled(p.name) && !scoring.isBannedFromGroup(p.name, "auto"));
  const withContext = estimatedTokens > 0 ? all.filter((p) => scoring.getEffectiveContext(p) >= estimatedTokens) : all;

  const scored = withContext.map((p) => {
    let bonus = 0;
    const compat = scoring.getCompat(p.name);

    // Benchmark-backed model scoring — detect primary category from use case
    const primaryCap = detectedCaps.has("coding") ? "coding"
      : detectedCaps.has("thinking") ? "thinking"
      : detectedCaps.has("images") ? "images"
      : detectedCaps.has("tools") ? "tools"
      : "text";
    bonus += transforms.smartnessBonus(p, primaryCap, reqBody);

    for (const cap of detectedCaps) {
      if (p.caps.includes(cap)) bonus += 0.3;
    }
    if (isAgent) {
      if (p.tier === 1) bonus += 0.5;
      if (p.tier === 3) bonus -= 0.5;
      if (!p.caps.includes("tools")) bonus -= 1.0;
    }
    if (needsUpgrade) {
      if (p.tier === 1) bonus += 0.8;
      if (p.tier === 3) bonus -= 1.0;
      if (p.tc) bonus += 0.3;
    }
    // Learned compat penalties
    if (compat.no_reasoning && hasReasoning) bonus -= 0.5;
    if (compat.no_extra_body && needsThinking) bonus -= 0.3;
    if (compat.no_reasoning && needsThinking) bonus -= 0.3;
    if (compat.no_tool_history && hasToolHistory) bonus -= 99; // hard exclude

    // Session affinity
    const lastProv = reqBody?._sessionLastProvider;
    if (lastProv) {
      if (p.name === lastProv) bonus += 0.4;
      else if (p.model === state.PROVIDERS.find((x) => x.name === lastProv)?.model) bonus += 0.2;
    }

    return { provider: p, score: scoring.providerScore(p) + bonus };
  });

  return scored.sort((a, b) => b.score - a.score).map((s) => s.provider);
}

function findProviderByModel(model) {
  const alive = state.PROVIDERS.filter((p) => p.alive !== false && p.key);

  // Find all matches, prefer non-cooldown
  function bestOf(candidates) {
    if (candidates.length === 0) return null;
    const available = candidates.filter((p) => !scoring.isOnCooldown(p.name) && !scoring.isQuotaDisabled(p.name));
    if (available.length > 0) {
      // Return highest-scored available provider
      return available.sort((a, b) => scoring.providerScore(b) - scoring.providerScore(a))[0];
    }
    return candidates[0]; // fallback to first match even if on cooldown
  }

  // Exact model match (multiple sources may have same model)
  let matches = alive.filter((p) => p.model === model);
  if (matches.length > 0) return bestOf(matches);
  // Name match
  matches = alive.filter((p) => p.name.toLowerCase() === model.toLowerCase());
  if (matches.length > 0) return bestOf(matches);
  // Partial match
  matches = alive.filter((p) => p.model.includes(model));
  return bestOf(matches);
}

async function routeToProvider(provider, reqBody) {
  const body = transforms.transformRequest(provider, reqBody);
  body.stream = false; // force non-streaming
  delete body.stream_options; // stream_options invalid when stream=false
  const bodyStr = JSON.stringify(body);
  const headers = transforms.buildHeaders(provider);
  const start = Date.now();

  if (state.DEV_MODE) {
    state.log(`DEV-REQ: ${provider.name} (${provider.model}) ctx=${scoring.getEffectiveContext(provider)} body=${bodyStr.length}chars msgs=${body.messages?.length}`);
    try { fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-request.json"), bodyStr); } catch {}
  }

  const resp = await makeRequest(provider.url, { method: "POST", headers }, bodyStr);
  const latency = Date.now() - start;

  if (state.DEV_MODE) {
    state.log(`DEV-RESP: ${provider.name} status=${resp.status} ${latency}ms body=${(resp.body || "").length}chars`);
    try { fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-response.json"), resp.body || ""); } catch {}
  }

  if (resp.status >= 400) {
    const errPreview = (resp.body || "").substring(0, 200);
    state.log(`FAIL: ${provider.name} status=${resp.status}  ${errPreview}`);
    if (scoring.isQuotaExhaustedError(resp.status, resp.body)) {
      scoring.disableProviderQuota(provider.name, `HTTP ${resp.status}: quota/billing error`);
    }
    if (scoring.isTemporaryRateLimit(resp.status, resp.body)) {
      scoring.setCooldown(provider.name, 60 * 60_000, `rate limit HTTP ${resp.status}`);
    } else if (resp.status === 502 || resp.status === 504 || /timeout|idle/i.test(resp.body)) {
      scoring.setCooldown(provider.name, undefined, `HTTP ${resp.status} gateway/timeout`);
    }
    scoring.detectIncompatibility(provider.name, resp.status, resp.body);
    try { mempalace.saveError(mempalace.getSession(reqBody.messages), errPreview); } catch {}
    throw { status: resp.status, body: resp.body, latency };
  }

  // Unwrap wrapped responses (Cline wraps in {"data": {...}, "success": true})
  try {
    const wrapped = JSON.parse(resp.body);
    if (wrapped.data?.choices && wrapped.success !== undefined) {
      resp.body = JSON.stringify(wrapped.data);
    }
    // Also handle {"error": "...", "success": false}
    if (wrapped.success === false && wrapped.error) {
      throw { status: 502, body: resp.body, latency };
    }
  } catch (e) {
    if (e.status) throw e; // re-throw our own errors
  }

  // Validate response is OpenAI-compatible (has choices array)
  try {
    const parsed = JSON.parse(resp.body);
    if (!parsed.choices || !Array.isArray(parsed.choices)) {
      // Provider likely only supports streaming — mark stream_only
      const c = scoring.getCompat(provider.name);
      if (!c.stream_only) { c.stream_only = true; scoring.saveCompat(); state.log(`COMPAT: ${provider.name} → stream_only (no choices in response)`); }
      throw { status: 502, body: resp.body, latency };
    }
  } catch (e) {
    if (e.status) throw e;
    const c = scoring.getCompat(provider.name);
    if (!c.stream_only) { c.stream_only = true; scoring.saveCompat(); state.log(`COMPAT: ${provider.name} → stream_only (unparseable non-stream response)`); }
    throw { status: 502, body: resp.body, latency };
  }

  // Stalling detection — model says "Let me check" and stops without acting
  if (reqBody?.tools?.length > 0 || reqBody?.functions?.length > 0) {
    const stallingDetected = transforms.detectStalling(resp.body);
    if (stallingDetected) {
      scoring.recordStalling(provider.name);
      throw { status: 422, body: resp.body, latency, stalling: true };
    }

    // Text-only response when tools available = model can't use tools properly
    // Record as stalling so provider gets deprioritized for tool-heavy requests
    try {
      const parsed = JSON.parse(resp.body);
      const choice = parsed.choices?.[0];
      if (choice && !choice.message?.tool_calls?.length && (choice.message?.content || "").length > 20) {
        scoring.recordStalling(provider.name);
        state.log(`NO-TOOLS: ${provider.name} responded with text-only (${(choice.message.content||"").length} chars) when ${reqBody.tools.length} tools available — stalling+retry`);
        throw { status: 422, body: resp.body, latency, stalling: true };
      }
    } catch (e) { if (e.stalling) throw e; }
  }

  // Detect garbled output in non-streaming response
  try {
    const parsed = JSON.parse(resp.body);
    const content = (parsed.choices?.[0]?.message?.content || "") + (parsed.choices?.[0]?.message?.reasoning || "") + (parsed.choices?.[0]?.message?.reasoning_content || "");
    if (content.length > 30 && compaction.detectGarbledText(content)) {
      state.log(`GARBLE-DETECTED: ${provider.name} content="${content.substring(0, 100)}..."`);
      scoring.recordFailure(provider.name, "garbled output");
      scoring.setCooldown(provider.name, 3600_000);
      throw { status: 502, body: resp.body, latency, garbled: true };
    }
  } catch (e) { if (e.garbled) throw e; }

  // Fix malformed tool call arguments JSON (mismatched braces etc)
  try {
    const parsed = JSON.parse(resp.body);
    const tcs = parsed.choices?.[0]?.message?.tool_calls;
    if (tcs) {
      let fixed = false;
      for (const tc of tcs) {
        if (tc.function?.arguments) {
          try { JSON.parse(tc.function.arguments); } catch {
            // Try basic repair: balance braces
            let args = tc.function.arguments;
            const opens = (args.match(/\{/g) || []).length;
            const closes = (args.match(/\}/g) || []).length;
            if (opens > closes) args += "}".repeat(opens - closes);
            else if (closes > opens) args = "{".repeat(closes - opens) + args;
            try { JSON.parse(args); tc.function.arguments = args; fixed = true; } catch {
              tc.function.arguments = "{}"; fixed = true;
            }
          }
        }
      }
      if (fixed) {
        resp.body = JSON.stringify(parsed);
        state.log(`JSON-REPAIR: ${provider.name} — fixed malformed tool call arguments`);
      }
    }
  } catch {}

  scoring.recordSuccess(provider.name, latency);

  // Extract usage stats from response
  let usage = null;
  try {
    const parsed = JSON.parse(resp.body);
    usage = parsed.usage || null;
  } catch {}
  const usageStr = usage ? ` usage[in=${usage.prompt_tokens||0} out=${usage.completion_tokens||0} total=${usage.total_tokens||0}]` : "";
  state.log(`OK: ${provider.name} ${latency}ms${usageStr}`);

  // Track provider-level usage from response
  {
    const sid = mempalace.getSession(reqBody.messages).id;
    const inTok = usage?.prompt_tokens || compaction.estimateTokens(reqBody.messages);
    const outTok = usage?.completion_tokens || 0;
    _trackSessionTokens(sid, inTok, outTok, provider.name);
  }

  // Session affinity — remember which provider worked
  try { mempalace.setLastProvider(mempalace.getSession(reqBody.messages), provider.name); } catch {}
  // Track in sessionStats for reliable cross-request lookups
  try { const sid = mempalace.getSession(reqBody.messages).id; if (state.sessionStats[sid]) state.sessionStats[sid].lastProvider = provider.name; } catch {}

  // MemPalace: save after successful response
  try {
    const s = mempalace.getSession(reqBody.messages);
    mempalace.triggerSaves(s, reqBody, resp.body);
  } catch { /* graceful degradation */ }

  // Thinking detection
  if (provider.tc && transforms.detectThinking(resp.body)) {
    scoring.recordThinkingOk(provider.name);
  }

  return resp;
}

// ---------------------------------------------------------------------------
// Route streaming request to a provider
// ---------------------------------------------------------------------------
function routeStreamToProvider(provider, reqBody, clientRes) {
  return new Promise((resolve, reject) => {
    const body = transforms.transformRequest(provider, reqBody);
    body.stream = true;
    const bodyStr = JSON.stringify(body);
    const headers = transforms.buildHeaders(provider);
    const start = Date.now();

    if (state.DEV_MODE) {
      state.log(`DEV-STREAM-REQ: ${provider.name} (${provider.model}) ctx=${scoring.getEffectiveContext(provider)} body=${bodyStr.length}chars msgs=${body.messages?.length}`);
      try { fs.writeFileSync(path.join(state.DATA_DIR, "dev-last-request.json"), bodyStr); } catch {}
    }
    let headersSent = false;

    let dataChunks = 0;
    let hasToolCallsInStream = false;
    const buffered = [];
    let lastChunkTime = Date.now();

    // Watchdog: kill stream if no data for 30s
    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkTime > 30_000) {
        clearInterval(watchdog);
        state.log(`STREAM-STALE: ${provider.name} no data for 30s, killing`);
        try { streamReq?.destroy(); } catch {}
      }
    }, 10_000);

    let streamedContent = ""; // accumulate content for garble detection
    let lastDataChunk = ""; // keep last SSE data for usage extraction
    let streamLoopAborted = false; // mid-stream loop detection flag

    const streamReq = streamRequest(
      provider.url,
      { method: "POST", headers },
      bodyStr,
      (chunk) => {
        lastChunkTime = Date.now();
        const text = chunk.toString();
        if (/data:\s*\{/.test(text)) dataChunks++;

        // Extract content + reasoning from SSE for garble detection
        for (const field of [/"content"\s*:\s*"([^"]{0,500})"/, /"reasoning_content"\s*:\s*"([^"]{0,500})"/, /"reasoning"\s*:\s*"([^"]{0,500})"/]) {
          const m = text.match(field);
          if (m) streamedContent += m[1];
        }
        // Track tool calls in stream
        if (/"tool_calls"/.test(text)) hasToolCallsInStream = true;
        // Keep last data chunk for usage extraction
        if (/data:\s*\{/.test(text)) lastDataChunk = text;

        // Mid-stream loop detection: every 100 chunks, check for repetitive content
        if (dataChunks > 0 && dataChunks % 100 === 0 && streamedContent.length > 500 && !streamLoopAborted) {
          const sentences = streamedContent.split(/[.!?\n]/).map(s => s.trim().toLowerCase()).filter(s => s.length > 15);
          if (sentences.length > 20) {
            const counts = {};
            for (const s of sentences) counts[s] = (counts[s] || 0) + 1;
            const maxRepeat = Math.max(0, ...Object.values(counts));
            const uniqueRatio = Object.keys(counts).length / sentences.length;
            if (maxRepeat >= 10 || (uniqueRatio < 0.2 && sentences.length > 30)) {
              streamLoopAborted = true;
              state.log(`STREAM-LOOP-ABORT: ${provider.name} ${dataChunks} chunks — sentence repeated ${maxRepeat}x, unique=${Math.round(uniqueRatio*100)}%. Aborting stream.`);
              scoring.recordStalling(provider.name);
              scoring.setCooldown(provider.name, 900_000, "stream loop detected");
              // Send [DONE] to close stream gracefully, then destroy
              if (headersSent) {
                clientRes.write("data: [DONE]\n\n");
                clientRes.end();
              }
              try { streamReq.destroy?.(); } catch {}
            }
          }
        }

        if (!headersSent) {
          buffered.push(chunk);
          if (dataChunks >= 3) {
            // Commit — flush buffered chunks after 15 clean chunks (enough to detect garble)
            clientRes.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...buildUsageHeaders(provider, reqBody, null),
            });
            headersSent = true;
            for (const b of buffered) clientRes.write(b);
            buffered.length = 0;
          }
        } else {
          // Filter out non-SSE telemetry/metadata chunks (SambaNova sends telemetry as last chunk)
          const chunkStr = chunk.toString();
          if (/data:\s*\{/.test(chunkStr)) {
            // Validate it's a chat completion chunk, not telemetry
            const jsonMatch = chunkStr.match(/data:\s*(\{.+\})/);
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (parsed.inference_id || parsed.completion_tokens_per_sec || parsed.producer) {
                  // Telemetry object — skip, don't forward to client
                  state.log(`FILTER-TELEMETRY: ${provider.name} — stripped telemetry chunk`);
                  return;
                }
              } catch {}
            }
          }
          clientRes.write(chunk);
        }
      },
      () => {
        const latency = Date.now() - start;
        clearInterval(watchdog);

        scoring.recordSuccess(provider.name, latency);

        // Detect empty/low responses
        if (dataChunks <= 2) {
          const scLen = streamedContent.replace(/\\[nrt"]/g, "").length;
          state.log(`LOW-CHUNKS: ${provider.name} ${dataChunks} chunks ${latency}ms — streamedContent=${scLen}chars tools=${hasToolCallsInStream} headersSent=${headersSent}`);
        }
        if (dataChunks <= 1 && !hasToolCallsInStream && streamedContent.replace(/\\[nrt"]/g, "").length < 10) {
          scoring.recordStalling(provider.name);
          // Don't end client response — will be handled by failover if not headersSent
          if (!headersSent) {
            reject({ error: new Error("empty response"), statusCode: 502, headersSent: false, latency });
            return;
          }
        }

        // Detect bad responses that technically "succeed" but are useless:
        // 1. Tiny response after long wait (provider stalling)
        // 2. Fast response with few chunks and no real content (thinking-only garbage)
        // 3. Only reasoning/thinking content with no actual response
        const hasRealContent = /"content"\s*:\s*"[^"]{10,}"/.test(streamedContent) ||
                               streamedContent.replace(/\\[nrt"]/g, "").length > 50;
        const thinkingOnly = !hasRealContent && (/"reasoning/.test(streamedContent) || /"thinking/.test(streamedContent));

        if (dataChunks <= 5 && latency > 60000) {
          state.log(`TINY-RESPONSE: ${provider.name} only ${dataChunks} chunks in ${latency}ms — likely stalling`);
          scoring.recordStalling(provider.name);
        } else if (thinkingOnly && dataChunks < 20 && latency < 15000) {
          // Fast response with only thinking/reasoning, no real content = garbled thinking
          state.log(`THINKING-ONLY: ${provider.name} ${dataChunks} chunks ${latency}ms — only reasoning, no content. Likely garbled.`);
          scoring.recordStalling(provider.name);
          scoring.setCooldown(provider.name, 300_000); // 5min cooldown
        } else if (!hasToolCallsInStream && hasRealContent && reqBody?.tools?.length > 0 && dataChunks >= 1) {
          // Text-only streaming response when tools available = model can't use tools
          state.log(`NO-TOOLS-STREAM: ${provider.name} text-only (${dataChunks} chunks) with ${reqBody.tools.length} tools available`);
          // Don't recordStalling here — IDE may retry and model uses tools on second attempt
          // Stalling detection in handleChatCompletion handles actual user-facing loops
        } else if (dataChunks > 10 && hasRealContent) {
          // Post-stream garble check on accumulated content (can't retry, but record for scoring)
          if (streamedContent.length > 200 && compaction.detectGarbledText(streamedContent)) {
            state.log(`GARBLE-STREAM: ${provider.name} ${dataChunks} chunks — garbled content detected post-stream`);
            scoring.recordStalling(provider.name);
            scoring.setCooldown(provider.name, 900_000, "garbled stream output"); // 15min
          } else {
            // Good response — reset stalling tracker for this provider
            if (state.stallingTracker[provider.name]) state.stallingTracker[provider.name] = [];
          }
        }

        // Extract usage from last SSE chunk (many providers include it)
        let streamUsage = null;
        try {
          const jsonMatch = lastDataChunk.match(/data:\s*(\{.+\})/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1]);
            streamUsage = parsed.usage || null;
          }
        } catch {}
        const usageStr = streamUsage ? ` usage[in=${streamUsage.prompt_tokens||0} out=${streamUsage.completion_tokens||0} total=${streamUsage.total_tokens||0}]` : "";
        state.log(`STREAM-OK: ${provider.name} ${latency}ms chunks=${dataChunks}${usageStr}`);

        // Track provider-level usage
        try {
          const sid = mempalace.getSession(reqBody.messages).id;
          const inTok = streamUsage?.prompt_tokens || compaction.estimateTokens(reqBody.messages);
          const outTok = streamUsage?.completion_tokens || 0;
          _trackSessionTokens(sid, inTok, outTok, provider.name);
        } catch {}

        try { mempalace.setLastProvider(mempalace.getSession(reqBody.messages), provider.name); } catch {}
        try { const sid2 = mempalace.getSession(reqBody.messages).id; if (state.sessionStats[sid2]) state.sessionStats[sid2].lastProvider = provider.name; } catch {}
        // Flush buffered chunks if headers never sent (response came in <3 chunks)
        if (!headersSent && dataChunks === 0) {
          // Zero data chunks = empty response. Reject for failover.
          state.log(`EMPTY-STREAM: ${provider.name} 0 data chunks — rejecting for failover`);
          scoring.recordStalling(provider.name);
          reject({ error: new Error("empty stream"), statusCode: 502, headersSent: false, latency });
          return;
        }
        if (!headersSent && buffered.length > 0) {
          clientRes.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...buildUsageHeaders(provider, reqBody, null),
          });
          headersSent = true;
          for (const b of buffered) clientRes.write(b);
          buffered.length = 0;
          state.log(`FLUSH-BUFFER: ${provider.name} — flushed ${dataChunks} buffered chunks on stream end`);
        }
        if (headersSent) {
          clientRes.end();
        }
        resolve({ streamed: true, headersSent });
      },
      (err, statusCode) => {
        const latency = Date.now() - start;
        if (statusCode === 429) scoring.setCooldown(provider.name);
        // Timeout/gateway errors — cooldown so failover picks different provider
        if (scoring.isTemporaryRateLimit(statusCode, err.message || "")) {
          scoring.setCooldown(provider.name, 60 * 60_000);
        } else if (statusCode === 502 || statusCode === 504 || /timeout|idle/i.test(err.message || "")) {
          scoring.setCooldown(provider.name);
        }
        if (scoring.isQuotaExhaustedError(statusCode, err.message || "")) {
          scoring.disableProviderQuota(provider.name, `HTTP ${statusCode}: quota/billing error`);
        }
        clearInterval(watchdog);
        scoring.detectIncompatibility(provider.name, statusCode, err.message || "");
        scoring.recordFailure(provider.name, err.message);
        state.log(`STREAM-ERR: ${provider.name} ${latency}ms status=${statusCode} headersSent=${headersSent} chunks=${dataChunks} err=${(err.message || "").substring(0, 80)}`);

        // Stream abort with minimal data = likely quota/stall — cooldown
        if (dataChunks <= 2 && /aborted|socket hang up|ECONNRESET/i.test(err.message || "")) {
          scoring.setCooldown(provider.name, 600_000, "stream aborted");
          state.log(`STREAM-STALL: ${provider.name} aborted after ${dataChunks} chunks — cooldown 10min`);
        }

        reject({ error: err, statusCode, headersSent, latency });
      }
    );
  });
}

async function handleChatCompletion(reqBody, clientRes) {
  const requestedModel = reqBody.model || "auto";
  const isStreaming = reqBody.stream === true;
  const isGroup = requestedModel in state.GROUPS || requestedModel === "auto";

  // Intercept "ban ai XX" — only trigger on LAST user message, strip from all others
  const BAN_RE = /\bban\s+ai\s+(\d+)\b/i;
  // Find last user message
  let banMatch = null;
  let lastUserIdx = -1;
  if (reqBody.messages) {
    for (let bi = reqBody.messages.length - 1; bi >= 0; bi--) {
      if (reqBody.messages[bi]?.role === "user") { lastUserIdx = bi; break; }
    }
    if (lastUserIdx >= 0) {
      const m = reqBody.messages[lastUserIdx];
      const text = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.filter(p => p.type === "text").map(p => p.text).join(" ") : "";
      banMatch = text.match(BAN_RE);
    }
  }
  if (banMatch) {
    const banHours = parseInt(banMatch[1], 10);
    const banSid = mempalace.getSession(reqBody.messages)?.id;
    const banSs = banSid ? state.sessionStats[banSid] : null;
    const banProvider = banSs?.lastProvider;

    // Always strip "ban ai XX" from all messages (clears IDE cache residue)
    reqBody.messages = reqBody.messages.map(m => {
      if (typeof m.content === "string" && BAN_RE.test(m.content)) {
        const cleaned = m.content.replace(BAN_RE, "").trim();
        return cleaned ? { ...m, content: cleaned } : null;
      }
      if (Array.isArray(m.content)) {
        const parts = m.content.map(p => p.type === "text" && BAN_RE.test(p.text) ? { ...p, text: p.text.replace(BAN_RE, "").trim() } : p).filter(p => p.type !== "text" || p.text);
        return parts.length > 0 ? { ...m, content: parts } : null;
      }
      return m;
    }).filter(Boolean);

    if (banProvider && banHours > 0) {
      // Have a provider to ban — apply cooldown and return confirmation
      scoring.setCooldown(banProvider, banHours * 60 * 60_000, `user ban ${banHours}h`);
      state.log(`USER-BAN: ${banProvider} banned for ${banHours}h by user command`);
      const msg = `Banned **${banProvider}** for ${banHours} hour${banHours > 1 ? "s" : ""}. Will use other providers.`;
      if (isStreaming) {
        clientRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        clientRes.write(`data: ${JSON.stringify({ id: "chatcmpl-ban", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "llm-proxy", choices: [{ index: 0, delta: { role: "assistant", content: msg }, finish_reason: null }] })}\n\n`);
        clientRes.write(`data: ${JSON.stringify({ id: "chatcmpl-ban", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "llm-proxy", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        clientRes.write("data: [DONE]\n\n");
        clientRes.end();
      } else {
        clientRes.writeHead(200, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({
          id: "chatcmpl-ban", object: "chat.completion", created: Math.floor(Date.now() / 1000),
          model: "llm-proxy", choices: [{ index: 0, message: { role: "assistant", content: msg }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      }
      return;
    }
    // No provider to ban (stale cache, fresh restart) — just strip and continue routing normally
    state.log(`BAN-STRIP: stripped stale "ban ai" from messages, continuing routing (no lastProvider)`)
  }

  // Permanent filter: strip any leftover "ban ai XX" from cached IDE messages
  if (reqBody.messages) {
    for (const m of reqBody.messages) {
      if (typeof m.content === "string" && BAN_RE.test(m.content)) {
        m.content = m.content.replace(BAN_RE, "").trim();
      }
    }
  }

  // Early consecutive-read dedup on reqBody — removes ONLY consecutive identical
  // idempotent tool calls (read, glob, grep, etc.) with no other calls between them.
  // Non-consecutive duplicates are kept: file may have changed between calls.
  const IDEMPOTENT_RE = /^(read|glob|grep|search|find|ripgrep|rg|cat|file|notebookread|list_dir|view_file)$/i;
  if (reqBody.messages && reqBody.messages.length > 20) {
    const msgs = reqBody.messages;
    const toRemove = new Set();

    // Build list of tool call keys in order: [{ idx, key, callId, respIdx }]
    const calls = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls?.length === 1) {
        const tc = m.tool_calls[0];
        const name = tc.function?.name || "";
        if (!IDEMPOTENT_RE.test(name)) continue;
        const key = name + ":" + (tc.function?.arguments || "");
        // Find matching tool response
        let respIdx = -1;
        for (let j = i + 1; j < msgs.length && j <= i + 3; j++) {
          if (msgs[j].role === "tool" && msgs[j].tool_call_id === tc.id) { respIdx = j; break; }
        }
        calls.push({ idx: i, key, respIdx });
      }
    }

    // Mark consecutive duplicates for removal (keep last in each run)
    for (let c = 0; c < calls.length - 1; c++) {
      if (calls[c].key === calls[c + 1].key) {
        // Check nothing non-tool between them (only tool responses allowed)
        let onlyToolsBetween = true;
        const gapStart = Math.max(calls[c].idx, calls[c].respIdx) + 1;
        const gapEnd = calls[c + 1].idx;
        for (let g = gapStart; g < gapEnd; g++) {
          if (msgs[g].role !== "tool") { onlyToolsBetween = false; break; }
        }
        if (onlyToolsBetween) {
          toRemove.add(calls[c].idx);
          if (calls[c].respIdx >= 0) toRemove.add(calls[c].respIdx);
        }
      }
    }

    if (toRemove.size > 0) {
      const keySet = new Set(calls.filter(c => toRemove.has(c.idx)).map(c => c.key));
      reqBody.messages = msgs.filter((_, i) => !toRemove.has(i));
      state.log(`CONSEC-DEDUP-EARLY: removed ${toRemove.size} consecutive identical read calls (${[...keySet].map(k => { const [n, ...r] = k.split(":"); return `${n}(args=${r.join(":").length}ch)`; }).join(",")})`);
    }
  }
  const estTokens = compaction.estimateTokens(reqBody.messages) + compaction.estimateToolsTokens(reqBody.tools);
  const requestedMaxTokens = reqBody.max_tokens || 4096;
  const totalNeeded = estTokens + requestedMaxTokens;
  reqBody._estimatedTokens = totalNeeded; // pass to scoring for context-aware ranking

  // Session compact cache: if IDE sends context we already compacted,
  // replace old portion with compact version, keep only truly new messages
  const sid = mempalace.getSession(reqBody.messages)?.id;
  if (sid && state.sessionCompactCache[sid] && reqBody.messages?.length > 20) {
    const cache = state.sessionCompactCache[sid];
    const cacheAge = Date.now() - cache.timestamp;
    if (cacheAge < 600_000 && reqBody.messages.length >= cache.originalMsgCount) {
      // Find new messages: those that weren't in original set (by role+content hash)
      const lastCachedMsg = cache.lastOriginalContent;
      let splitIdx = -1;
      // Find where old context ends in IDE's messages
      for (let i = reqBody.messages.length - 1; i >= 0; i--) {
        const content = typeof reqBody.messages[i].content === "string" ? reqBody.messages[i].content : "";
        if (content === lastCachedMsg) {
          splitIdx = i + 1;
          break;
        }
      }
      if (splitIdx === -1) {
        // Can't find split point — fall back to position-based
        splitIdx = cache.originalMsgCount;
      }
      const newMsgs = reqBody.messages.slice(splitIdx);
      reqBody.messages = [...cache.compactedMessages, ...newMsgs];
      const newEst = compaction.estimateTokens(reqBody.messages) + compaction.estimateToolsTokens(reqBody.tools);
      state.log(`CACHE-HIT: session ${sid} (${cache.originalMsgCount}→${cache.compactedMessages.length} cached + ${newMsgs.length} new = ${reqBody.messages.length} msgs, ${estTokens}→${newEst}tok)`);
      reqBody._estimatedTokens = newEst + requestedMaxTokens;
    } else if (cacheAge >= 600_000) {
      delete state.sessionCompactCache[sid];
    }
  }

  // Apply cached compaction drops from previous requests (instant replay)
  if (sid && reqBody.messages) {
    reqBody.messages = compaction.applyCompactionDrops(sid, reqBody.messages);
  }

  // Re-estimate after potential cache hit + drop replay
  const currentTokens = compaction.estimateTokens(reqBody.messages) + compaction.estimateToolsTokens(reqBody.tools);

  // Detect summarization requests — IDE asking to compact/summarize context
  // These bypass context limits entirely (the whole point is to summarize large context)
  const lastMsg = reqBody.messages?.[reqBody.messages.length - 1];
  const lastContent = (typeof lastMsg?.content === "string" ? lastMsg.content : "").trim();
  const isSummarizationRequest = lastContent.length < 200 && /\b(summariz|what did we|what have we|recap|context|compaction|condense|shorten|compress|so far|up to now|overview of .*(session|conversation|work|progress))\b/i.test(lastContent);

  // Early check: if input exceeds 90% of best available context, tell IDE to compact.
  // Summarization requests skip this check entirely — they need full context to summarize.
  if (isGroup && reqBody.messages?.length > 20 && !isSummarizationRequest) {
    const bestCtx = Math.max(...state.PROVIDERS.filter(p => p.key && p.alive !== false).map(p => scoring.getEffectiveContext(p)), 0);
    if (bestCtx > 0 && currentTokens > bestCtx * 0.9) {
      state.log(`IDE-COMPACT: input ${currentTokens}tok > 90% of best ctx ${bestCtx} — returning context_length_exceeded`);
      const body = JSON.stringify({
        error: {
          message: `This model's maximum context length is ${bestCtx} tokens. However, you requested ${currentTokens + requestedMaxTokens} tokens (${currentTokens} in the messages, ${requestedMaxTokens} in the completion). Please reduce the length of the messages or completion.`,
          type: "invalid_request_error",
          param: "messages",
          code: "context_length_exceeded",
        },
      });
      clientRes.writeHead(400, { "Content-Type": "application/json" });
      clientRes.end(body);
      return;
    }
  }

  // MemPalace: recall memories and inject into context
  const mpSession = mempalace.getSession(reqBody.messages);

  // Track session tokens
  _trackSessionTokens(mpSession.id, currentTokens, 0);
  // Get last provider from session stats (more reliable than mempalace session objects)
  const ss = state.sessionStats[mpSession.id];
  reqBody._sessionLastProvider = ss?.lastProvider || mempalace.getLastProvider(mpSession);
  let memoryInjection = "";
  try {
    memoryInjection = await mempalace.recallMemories(mpSession, reqBody);
  } catch { /* graceful degradation */ }
  if (memoryInjection) reqBody._memoryInjection = memoryInjection;

  // Save project context on first request of session
  if (mpSession.requestCount === 1) {
    const sysMsg = reqBody.messages?.find((m) => m.role === "system");
    if (sysMsg) mempalace.saveProjectContext(mpSession, typeof sysMsg.content === "string" ? sysMsg.content : "");
  }

  // Detect "continua loop" — user retrying because previous response was useless
  // Skip if last request was < 2s ago (IDE auto-retry, not user action)
  const lastReqTime = ss?.lastRequest || 0;
  const timeSinceLastReq = Date.now() - lastReqTime;
  if (reqBody.messages?.length >= 3 && timeSinceLastReq > 2000) {
    const msgs = reqBody.messages;
    let continuaCount = 0;
    let shortAssistantCount = 0;
    // Scan last 10 messages for stalling patterns
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 10); i--) {
      const m = msgs[i];
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content.trim() : "";
        if (/(?:continu[ea]|continue|go|do it|next|remember|recall|where were we|what were we)/i.test(text) && text.length < 50) {
          continuaCount++;
        }
      }
      if (m.role === "assistant" && !m.tool_calls?.length) {
        const ac = typeof m.content === "string" ? m.content : "";
        // Short response without tool calls = stalling
        if (ac.length < 800) shortAssistantCount++;
        // Fake execution (shell commands as text)
        let fe = 0;
        for (const pat of transforms.FAKE_EXEC_PATTERNS) { if (pat.test(ac)) fe++; }
        if (fe >= 1) shortAssistantCount++;
      }
    }
    // Stalling detected — penalize only the provider that actually served the stalling response
    if ((continuaCount >= 2 || shortAssistantCount >= 3) && continuaCount + shortAssistantCount >= 3) {
      // Identify the provider that actually responded (session affinity tracks this)
      const stallingProvider = reqBody._sessionLastProvider;
      if (stallingProvider) {
        const banGroup = requestedModel === "auto" ? "auto" : requestedModel;

        if (continuaCount >= 3) {
          scoring.recordStalling(stallingProvider);
          scoring.banFromGroup(stallingProvider, banGroup);
          mempalace.saveStalling(stallingProvider, banGroup, "repeated stalling");
          state.log(`STALL-BAN: ${continuaCount}x continua, banned ${stallingProvider} from ${banGroup}`);
        } else {
          scoring.recordStalling(stallingProvider);
          scoring.setCooldown(stallingProvider, 5 * 60_000);
          state.log(`STALL-COOL: ${continuaCount}x continua, ${stallingProvider} cooled 5min`);
        }
      }
    }
  }

  // No pre-routing compaction — only compact reactively:
  // 1. Post-routing in transformRequest (per-provider effective context)
  // 2. On context_length_exceeded error from provider (retry with compaction)

  if (isGroup) {
    // auto group: detect use case, try all providers with smart ordering
    let providers = requestedModel === "auto"
      ? getProvidersForAuto(reqBody.messages, totalNeeded, reqBody)
      : getProvidersForGroup(requestedModel, totalNeeded, reqBody);

    // Pre-routing compaction: 4-layer sequential reduction from ORIGINAL context
    // Each layer targets % of original, stop when enough providers available
    if (providers.length <= 3 && reqBody.messages?.length > 10) {
      const allCount = (requestedModel === "auto"
        ? getProvidersForAuto(reqBody.messages, 0, reqBody)
        : getProvidersForGroup(requestedModel, 0, reqBody)
      ).length;
      if (allCount > providers.length * 2) {
        const layers = [0.9, 0.75, 0.5, 0.2];
        const originalTokens = compaction.estimateTokens(reqBody.messages);
        const originalMessages = [...reqBody.messages]; // snapshot original
        for (const pct of layers) {
          const target = Math.floor(originalTokens * pct);
          if (target < 2000) break;
          // Always compact from ORIGINAL messages, not previous compaction result
          const compacted = compaction.compactMessages(originalMessages, target, requestedMaxTokens, [], sid);
          if (!compacted) continue;
          reqBody.messages = compacted.messages;
          const newEst = compaction.estimateTokens(reqBody.messages) + compaction.estimateToolsTokens(reqBody.tools);
          reqBody._estimatedTokens = newEst + requestedMaxTokens;
          // Record ALL drops from original → this layer's result
          if (sid) compaction.recordCompactionDrops(sid, originalMessages, compacted.messages);
          providers = requestedModel === "auto"
            ? getProvidersForAuto(reqBody.messages, newEst + requestedMaxTokens, reqBody)
            : getProvidersForGroup(requestedModel, newEst + requestedMaxTokens, reqBody);
          state.log(`PRE-COMPACT L${layers.indexOf(pct)+1}: ${Math.round(pct*100)}% → ${originalTokens}→${newEst}tok (${compacted.removed} dropped) → ${providers.length} providers`);
          if (providers.length > 3) break;
        }
      }
    }

    // Emergency cooldown release: if <=2 providers available, release shortest cooldowns
    if (providers.length <= 2) {
      const cooledProviders = state.PROVIDERS.filter(p => p.key && p.alive !== false && scoring.isOnCooldown(p.name) && !scoring.isQuotaDisabled(p.name));
      if (cooledProviders.length > 0) {
        // Sort by cooldown expiry (soonest first), release up to 5
        cooledProviders.sort((a, b) => (scoring.getScore(a.name).cooldown_until || 0) - (scoring.getScore(b.name).cooldown_until || 0));
        const toRelease = cooledProviders.slice(0, 5);
        for (const p of toRelease) {
          const s = scoring.getScore(p.name);
          s.cooldown_until = 0;
          state.log(`EMERGENCY-RELEASE: ${p.name} (was: ${s.cooldown_reason || "unknown"})`);
        }
        scoring.saveScores();
        // Re-select providers
        providers = requestedModel === "auto"
          ? getProvidersForAuto(reqBody.messages, reqBody._estimatedTokens || totalNeeded, reqBody)
          : getProvidersForGroup(requestedModel, reqBody._estimatedTokens || totalNeeded, reqBody);
        state.log(`EMERGENCY-RELEASE: freed ${toRelease.length} providers → now ${providers.length} available`);
      }
    }

    if (providers.length === 0) {
      // Check WHY no providers: context too large, or all on cooldown?
      const allProviders = requestedModel === "auto"
        ? getProvidersForAuto(reqBody.messages, 0, reqBody) // 0 = ignore context filter
        : getProvidersForGroup(requestedModel, 0, reqBody);
      const currentTokens = compaction.estimateTokens(reqBody.messages);
      const currentTotal = currentTokens + requestedMaxTokens;

      if (allProviders.length > 0) {
        const maxContext = Math.max(...allProviders.map((p) => scoring.getEffectiveContext(p)));
        if (currentTotal > maxContext) {
          // Genuine context overflow — return context_length_exceeded
          const body = JSON.stringify({
            error: {
              message: `This model's maximum context length is ${maxContext} tokens. However, you requested ${currentTotal} tokens (${currentTokens} in the messages, ${requestedMaxTokens} in the completion). Please reduce the length of the messages or completion.`,
              type: "invalid_request_error",
              param: "messages",
              code: "context_length_exceeded",
            },
          });
          clientRes.writeHead(400, { "Content-Type": "application/json" });
          clientRes.end(body);
          return;
        }
        // Context fits but all providers filtered (cooldown/quota/banned)
        // Return 503 retry — don't tell IDE to compact (context is fine)
        state.log(`NO-PROVIDERS: ${requestedModel} has ${allProviders.length} providers but all filtered. input=${currentTotal}tok fits ${maxContext}ctx`);
        return _sendError(clientRes, 503, "All providers temporarily unavailable. Please retry.", { group: requestedModel, available: allProviders.length, retry_after: 30 });
      }
      return _sendError(clientRes, 503, "No providers available for group: " + requestedModel);
    }

    // Log routing decision with scoring rationale
    if (providers.length > 0) {
      const top3 = providers.slice(0, 3).map((p) => {
        const ctx = scoring.getEffectiveContext(p);
        const score = scoring.providerScore(p);
        return `${p.name}(${p.model},ctx=${ctx},tier=${p.tier},score=${score.toFixed(2)})`;
      });
      const actualInput = reqBody._estimatedTokens || estTokens;
      const { needsUpgrade: _upg } = transforms.detectUseCase(reqBody.messages, reqBody);
      state.log(`ROUTING: ${requestedModel} candidates=[${top3.join(", ")}] total=${providers.length} input=${actualInput}tok${_upg ? " UPGRADE" : ""}`);
    }

    const errors = [];
    const routeDeadline = Date.now() + 45_000; // 45s total across all retries
    for (const provider of providers) {
      // Check total deadline
      if (Date.now() > routeDeadline) {
        state.log(`DEADLINE: ${requestedModel} exceeded 45s total routing time after ${errors.length} failures`);
        break;
      }
      try {
        const pCtx = scoring.getEffectiveContext(provider);
        const pScore = scoring.providerScore(provider);
        state.log(`Route: ${requestedModel} → ${provider.name} (${provider.model}) via=${provider.name.split("-")[0]} ctx=${pCtx} tier=${provider.tier} score=${pScore.toFixed(2)} stream_only=${!!scoring.getCompat(provider.name).stream_only}`);

        if (isStreaming) {
          await routeStreamToProvider(provider, reqBody, clientRes);
          return;
        } else {
          // Non-streaming explicitly requested by client
          const resp = await routeToProvider(provider, reqBody);
          let usage = null;
          try { usage = JSON.parse(resp.body).usage; } catch {}
          clientRes.writeHead(resp.status, {
            "Content-Type": "application/json",
            ...buildUsageHeaders(provider, reqBody, usage),
          });
          clientRes.end(resp.body);
          return;
        }
      } catch (err) {
        if (err.headersSent) { clientRes.end(); return; }
        const status = err.status || err.statusCode || 500;
        const msg = err.body || err.error?.message || String(err);
        // Don't override longer cooldowns already set by routeToProvider/detectIncompatibility
        if (status === 429 && !scoring.isOnCooldown(provider.name)) scoring.setCooldown(provider.name);
        scoring.recordFailure(provider.name, msg);
        const errFull = typeof msg === "string" ? msg.substring(0, 300) : String(msg).substring(0, 300);
        state.log(`FAIL: ${provider.name} status=${status} ${err.timeout ? "TIMEOUT" : ""} ${errFull}`);
        errors.push({ provider: provider.name, status, error: typeof msg === "string" ? msg.substring(0, 200) : String(msg) });

        // Categorize error for routing decisions
        const CTX_ERR_RE = /context.length|too.large|maximum.*token|too large for model/i;
        const isCtxErr = CTX_ERR_RE.test(errFull);
        const isRateLimit = status === 429 || /rate.limit|too many requests/i.test(errFull);
        const isQuota = /usage limit|quota|reached the limit|MONTHLY|out of.*messages/i.test(errFull);
        const isSocketDrop = /socket hang up/i.test(errFull) && /codex/i.test(provider.name);
        const isTimeout = status === 504 || status === 502 || /timeout|idle/i.test(errFull);

        if (isCtxErr) {
          state.log(`REROUTE: ${provider.name} context too large (${scoring.getEffectiveContext(provider)} ctx) → trying next provider with larger context`);
        } else if (isRateLimit) {
          state.log(`REROUTE: ${provider.name} rate limited → trying next provider`);
        } else if (isQuota || isSocketDrop) {
          state.log(`REROUTE: ${provider.name} quota exhausted → trying next provider (cooldown 1h)`);
          scoring.setCooldown(provider.name, 3600_000);
        } else if (isTimeout) {
          state.log(`REROUTE: ${provider.name} timeout/502 → trying next provider`);
        } else {
          state.log(`REROUTE: ${provider.name} error ${status} → trying next provider`);
        }

        // Step 2: Mid-loop — after 2+ context errors from different providers,
        // compact at 80% of the failing provider's effective context and retry
        if (isCtxErr) {
          const ctxErrCount = errors.filter((e) => CTX_ERR_RE.test(e.error)).length;
          const midRetries = reqBody._midCompactRetries || 0;
          if (ctxErrCount >= 2 && midRetries < 2 && reqBody.messages?.length > 4) {
            reqBody._midCompactRetries = midRetries + 1;
            const failedCtx = scoring.getEffectiveContext(provider);
            const target = Math.floor(failedCtx * 0.8);
            state.log(`MID-COMPACT: 2+ context errors → compacting to 80% of ${provider.name} ctx (${failedCtx} → target ${target}tok)`);
            let refs = [];
            try { refs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
            const midOrig = [...reqBody.messages];
            const compacted = compaction.compactMessages(reqBody.messages, target, requestedMaxTokens, refs, sid);
            if (compacted) {
              reqBody.messages = compacted.messages;
              if (sid) compaction.recordCompactionDrops(sid, midOrig, compacted.messages);
              const newEst = compaction.estimateTokens(reqBody.messages);
              state.log(`MID-COMPACT #${reqBody._midCompactRetries}: ${estTokens}tok → ${newEst}tok → retrying all providers`);
              return await handleChatCompletion(reqBody, clientRes);
            }
          }
        }
        continue;
      }
    }

    // Step 4: ALL providers failed — progressive compaction at current effective context
    const CTX_ERR_RE2 = /context.length|too.long|token.*exceed|max.size.*token|too.large|timeout|idle|502|504/i;
    const contextOrTimeoutErrors = errors.filter((e) => CTX_ERR_RE2.test(e.error) || e.status === 502 || e.status === 504);
    const isContextProblem = contextOrTimeoutErrors.length > errors.length / 3;

    state.log(`ALL-FAILED: ${errors.length} errors (${contextOrTimeoutErrors.length} context/timeout, ${errors.length - contextOrTimeoutErrors.length} other) isContextProblem=${isContextProblem}`);

    if (isContextProblem && reqBody.messages?.length > 4) {
      const postRetries = reqBody._postCompactRetries || 0;
      const targets = [0.7, 0.55];
      if (postRetries < targets.length) {
        reqBody._postCompactRetries = postRetries + 1;
        reqBody._midCompactRetries = 0;
        const allP = requestedModel === "auto"
          ? getProvidersForAuto(reqBody.messages, 0, reqBody)
          : getProvidersForGroup(requestedModel, 0, reqBody);
        const maxCtx = Math.max(...allP.map((p) => scoring.getEffectiveContext(p)), 131072);
        const target = Math.floor(maxCtx * targets[postRetries]);

        state.log(`POST-COMPACT: all providers failed → compact to ${Math.round(targets[postRetries]*100)}% of max ctx ${maxCtx} = ${target}tok (attempt #${postRetries + 1})`);
        let refs = [];
        try { refs = await mempalace.saveCompactedContext(mpSession, reqBody.messages) || []; } catch {}
        const postOrig = [...reqBody.messages];
        const compacted = compaction.compactMessages(reqBody.messages, target, requestedMaxTokens, refs, sid);
        if (compacted) {
          reqBody.messages = compacted.messages;
          if (sid) compaction.recordCompactionDrops(sid, postOrig, compacted.messages);
          const newEst = compaction.estimateTokens(reqBody.messages);
          state.log(`POST-COMPACT #${postRetries + 1}: ${estTokens}tok → ${newEst}tok → retrying all providers`);
          return await handleChatCompletion(reqBody, clientRes);
        } else {
          state.log(`POST-COMPACT #${postRetries + 1}: compaction failed (messages too short to compact further)`);
        }
      }
    }

    // Step 5: Everything failed — return context_length_exceeded to trigger IDE compaction
    if (isContextProblem) {
      const maxContext = Math.max(...state.PROVIDERS.filter((p) => p.key && p.alive !== false).map((p) => scoring.getEffectiveContext(p)), 0);
      const currentEst = compaction.estimateTokens(reqBody.messages);
      state.log(`CONTEXT-EXCEEDED: all compaction attempts exhausted. ${currentEst}tok + ${requestedMaxTokens}max_tokens > ${maxContext} max_ctx — returning context_length_exceeded to IDE`);
      const body = JSON.stringify({
        error: {
          message: `This model's maximum context length is ${maxContext} tokens. However, you requested ${currentEst + requestedMaxTokens} tokens (${currentEst} in the messages, ${requestedMaxTokens} in the completion). Please reduce the length of the messages or completion.`,
          type: "invalid_request_error",
          param: "messages",
          code: "context_length_exceeded",
        },
      });
      clientRes.writeHead(400, { "Content-Type": "application/json" });
      clientRes.end(body);
      return;
    }
    return _sendError(clientRes, 503, "All providers in group failed", { group: requestedModel, attempts: errors });
  }

  // Direct provider/model routing
  const provider = findProviderByModel(requestedModel);
  if (!provider) {
    return _sendError(clientRes, 404, "Model not found: " + requestedModel);
  }

  try {
    const directScore = scoring.providerScore(provider);
    state.log(`Route: ${requestedModel} → ${provider.name} (${provider.model}) via=${provider.name.split("-")[0]} tier=${provider.tier} score=${directScore.toFixed(2)}`);
    if (isStreaming) {
      await routeStreamToProvider(provider, reqBody, clientRes);
    } else {
      const resp = await routeToProvider(provider, reqBody);
      let usage = null;
      try { usage = JSON.parse(resp.body).usage; } catch {}
      clientRes.writeHead(resp.status, {
        "Content-Type": "application/json",
        ...buildUsageHeaders(provider, reqBody, usage),
      });
      clientRes.end(resp.body);
    }
  } catch (err) {
    if (err.headersSent) { clientRes.end(); return; }
    const status = err.status || err.statusCode || 502;
    scoring.recordFailure(provider.name, err.body || err.error?.message || "unknown");
    if (status === 429) scoring.setCooldown(provider.name);
    _sendError(clientRes, status, "Provider error", { provider: provider.name, detail: typeof err.body === "string" ? err.body.substring(0, 500) : undefined });
  }
}

function sendAsSSE(res, responseBody, provider, reqBody) {
  let usage = null;
  try { usage = JSON.parse(responseBody).usage; } catch {}
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...buildUsageHeaders(provider, reqBody, usage),
  });

  try {
    const data = JSON.parse(responseBody);
    const choice = data.choices?.[0];
    if (!choice) { res.write(`data: ${responseBody}\n\n`); res.write("data: [DONE]\n\n"); res.end(); return; }

    const content = choice.message?.content || "";
    const toolCalls = choice.message?.tool_calls;

    // Send content in chunks for streaming feel
    if (content && !toolCalls?.length) {
      const chunkSize = 20; // ~20 chars per SSE event
      for (let i = 0; i < content.length; i += chunkSize) {
        const delta = content.substring(i, i + chunkSize);
        const chunk = {
          id: data.id || "chatcmpl-proxy",
          object: "chat.completion.chunk",
          created: data.created || Math.floor(Date.now() / 1000),
          model: data.model,
          choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: delta } : { content: delta }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }

    // Send tool calls as single chunk (can't split)
    if (toolCalls?.length) {
      const chunk = {
        id: data.id || "chatcmpl-proxy",
        object: "chat.completion.chunk",
        created: data.created || Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [{ index: 0, delta: { role: "assistant", content: content || null, tool_calls: toolCalls }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Final chunk with finish_reason
    const finalChunk = {
      id: data.id || "chatcmpl-proxy",
      object: "chat.completion.chunk",
      created: data.created || Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
      usage: data.usage,
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
  } catch {
    // Fallback: send raw response as single SSE event
    res.write(`data: ${responseBody}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

module.exports = {
  init,
  makeRequest,
  streamRequest,
  getProvidersForGroup,
  getProvidersForAuto,
  findProviderByModel,
  routeToProvider,
  routeStreamToProvider,
  handleChatCompletion,
  sendAsSSE,
};
