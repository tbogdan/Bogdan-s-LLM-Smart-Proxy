# Runtime Merge Inventory

**Date**: 2026-06-07  
**Purpose**: Snapshot current runtime entrypoints and behaviors to preserve during core runtime refactor.

---

## Summary

This document captures the essential behaviors and integrations of the current LLM Smart Proxy runtime that **must be preserved** when refactoring or merging with new implementations. It also lists **source-only modules** that will be imported from external sources.

---

## Core Entrypoint: `llm-proxy.js`

**Role**: HTTP server hosting `/v1/chat/completions`, `/v1/responses`, and management endpoints.

### Startup Sequence
1. Load providers (seed-providers.json or /data/providers.json)
2. Watch providers file for hot-reload
3. Load scores (learning/reputation)
4. Load quota-disabled list (Alibaba free-tier tracking)
5. Load compatibility overrides (learned context limits)
6. Initialize session stats tracking
7. Probe thinking capabilities on all unverified providers
8. Listen on PORT (default 18900)

### Key Endpoints to Preserve

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/chat/completions` | POST | Main OpenAI-compatible completion API |
| `/v1/responses` | POST+WS | Responses API for Codex CLI (HTTP + WebSocket) |
| `/v1/models` | GET | List providers and smart groups with capabilities |
| `/v1/capabilities` | GET | Aggregate capability matrix across all providers |
| `/health` | GET | System health, provider counts, uptime |
| `/scores` | GET | Provider reputation/latency data |
| `/banned` | GET | Cooldowns, quota bans, group bans |
| `/ban` | POST | Manual provider ban by pattern (hours, reason) |
| `/unban` | POST | Clear cooldowns by pattern or "all" |
| `/discovery` | GET | Latest discovery scan results |
| `/stats` | GET | Session token usage aggregates |

### Token Tracking

**Function**: `trackSessionTokens(sessionId, inputTokens, outputTokens, providerName)`

- Per-session counters: `totalInputTokens`, `totalOutputTokens`, `requests`, timestamps
- Per-provider breakdown within session
- Used for `/stats` endpoint and session-aware routing

### Cache Eviction (24h TTL, hourly task)

- **Session stats**: evict sessions > 24h old
- **Session compact cache**: evict stale compactions
- **Compaction drop cache**: evict if session no longer exists
- **Truncation cache**: cap at 500 entries
- **File activity**: evict sessions no longer tracked
- **Stalling tracker**: remove entries > 1h old

---

## Runtime Modules (to refactor/preserve)

### `lib/state.js`
**Responsibility**: Mutable application state container.

**Exports**:
- Constants: `DATA_DIR`, `SCORES_FILE`, `DISCOVERY_FILE`, `PROVIDERS_FILE`, `SEED_FILE`, timeouts
- Getters/setters for: `PROVIDERS[]`, `GROUPS{}`, `providersVersion`, `scores`, `quotaDisabled`, `providerCompat`
- Stable object references (mutated in-place):
  - `sessionStats`: per-session token tracking
  - `sessionCompactCache`: cached compactions per session
  - `groupBans`: per-group provider bans
  - `stallingTracker`: stalling detection timestamps
  - `truncationCache`: tool response truncations (content hash → shortened)
  - `compactionDropCache`: dropped messages per session (message hash → dropped)
  - `fileActivity`: IDE file read/write tracking per session
- Logging: `log(msg)` function

**Preserve**: All state shapes and cache keys (used by compaction, scoring, routing).

### `lib/scoring.js`
**Responsibility**: Provider reputation, cooldowns, quota management.

**Key Functions**:
- `getScore(name)`: Get/create provider score object
- `recordSuccess(name, latency)`: Increment success, update avg latency
- `recordFailure(name, error)`: Increment failures, save error
- `setCooldown(name, durationMs, reason)`: Set provider cooldown
- `isOnCooldown(name)`: Check if provider cooled
- `disableProviderQuota(name, reason)`: 3.5h cooldown for quota exhaustion
- `isQuotaDisabled(name)`: Check quota, auto-expire after 3.5h
- `isQuotaExhaustedError(statusCode, body)`: Detect Alibaba FreeTierOnly
- `recordThinkingOk(name)`: Mark provider as thinking-capable
- `getScore().thinking_ok`: 0/1 flag
- `getCompat(name)`: Provider compat overrides
- `getEffectiveContext(provider)`: Real context after compat adjustments
- `getEffectiveContextForPrompt(messages, provider)`: Dynamic reduction based on message count
- `isBannedFromGroup(name, groupName)`: Check group-specific bans

**Persist**: 
- `/data/scores.json`: provider scores + learning
- `/data/quota-disabled.json`: quota tracking
- `/data/compat.json`: learned context limits

**Preserve**: All scoring logic, quota detection, compat system.

### `lib/providers.js`
**Responsibility**: Load and hydrate provider config.

**Key Functions**:
- `loadSeedProviders()`: Load bundled seed-providers.json
- `hydrateSeedProviders(config)`: Convert seed format → runtime objects
- `resolveUrl(url)`: Replace Cloudflare `/accounts/me/` with account ID
- `loadProvidersFromFile()`: Load /data/providers.json (from discovery)
- `loadProviders()`: Try file first, fallback to seed
- `watchProvidersFile(callback)`: Auto-reload on file change, trigger thinking probe

**Provider Object Shape**:
```js
{
  name: string,              // "Claude-3.5-Sonnet-Batch"
  url: string,               // "https://api.anthropic.com/..."
  key: string,               // API key or "anonymous"
  key_env: string,           // env var name (for re-lookup)
  no_auth: boolean,          // Some providers need no auth
  model: string,             // "claude-3-5-sonnet-20241022"
  context: number,           // Original context window
  tier: number,              // 1=priority, 2=standard, 3=fallback
  tc: boolean,               // Thinking capable
  caps: string[],            // ["text", "vision", "tools", "coding", "thinking"]
  headers: object,           // Custom headers
  authHeader: string,        // Auth style (e.g. "Bearer")
  kilo: boolean,             // Kilo.me gateway
  alive: boolean,            // Not marked dead
  seed: boolean,             // From seed (not discovery)
}
```

**Preserve**: Provider schema, key resolution, hydration logic.

### `lib/routing.js`
**Responsibility**: Request routing, fallback logic, rate-limiting.

**Key Functions**:
- `init({ sendError, trackSessionTokens })`: Wire late dependencies
- `makeRequest(urlStr, options, body)`: Plain HTTP/HTTPS request
- `streamRequest(urlStr, options, body, onData, onEnd, onError)`: Streaming HTTP
- `getProvidersForGroup(groupName, estimatedTokens, reqBody)`: Filter/rank providers
- `handleChatCompletion(parsed, res)`: Main completion handler
- `buildUsageHeaders(provider, reqBody, usage)`: OpenAI-compatible response headers

**Routing Logic**:
- Detect use case (coding, thinking, images, tools) from messages
- Rank providers by tier, score, capability match
- Fallback to next best on failure
- Auto-upgrade context if needed (down-rank token limits)
- Stream or buffer based on client request
- Track tokens, record success/failure

**Preserve**: Routing algorithm, group resolution, fallback chain, usage header generation.

### `lib/transforms.js`
**Responsibility**: Per-provider request/response transformation.

**Key Functions**:
- `transformRequest(provider, reqBody)`: Apply provider-specific format
- `buildHeaders(provider)`: Build auth headers per provider
- `detectUseCase(messages, reqBody)`: Infer capabilities from request
- `detectThinking(respBody)`: Detect thinking_content in response
- **Per-provider quirks** (preserve exactly):
  - Anthropic: supports `thinking_budget_tokens`
  - Claude web: special header handling
  - Cursor IDE: model mapping
  - Kiro: model format conversions
  - Codex: response format translation
  - Others: model name rewrites, system message moves

**Preserve**: All provider-specific transforms, thinking detection.

### `lib/compaction.js`
**Responsibility**: Message context compression.

**Key Functions**:
- `contentHash(content)`: Fast truncation cache key (first+last 200ch + length)
- `applyCachedTruncations(messages)`: Reuse truncations across IDE cache
- `msgHash(m)`: Message identity for drop cache
- `applyCompactionDrops(sessionId, messages)`: Replay cached compaction
- `recordCompactionDrops(sessionId, originalMessages, compactedMessages)`: Cache drops
- `estimateTokens(messages)`: Fast char→token approximation (4-char avg)
- `estimateToolsTokens(tools)`: Tool schema overhead
- `compactMessages(messages, targetTokens, maxOutput, toolDefs, sessionId)`: Core algorithm
- **Compaction strategy**:
  - Preserve system message always
  - Summarize oldest user/assistant pairs
  - Keep last N messages verbatim
  - Use LLM-based summary fallback (if summarizer available)
  - Track dropped messages for session replay

**Preserve**: Compaction algorithm, drop cache, truncation cache, token estimation.

### `lib/responses.js`
**Responsibility**: Responses API (Codex CLI), translation, WebSocket/SSE.

**Key Functions**:
- `init({ handleChatCompletion })`: Wire completion handler
- `translateInput(request)`: Responses API format → Chat Completions
- `translateOutput(response)`: Chat Completions → Responses API
- `handleResponsesHTTP(req, res, body)`: HTTP endpoint
- `handleResponsesWS(ws, req)`: WebSocket upgrade
- **Model mapping** (Codex → proxy groups):
  - "o4-mini" → "auto-coding"
  - "o3" → "auto-coding"
  - "gpt-5.5" → "auto-coding"
  - etc. → all route to "auto-coding" or detected capability group

**Preserve**: Codex model mapping, request/response translation.

---

## Client Support Matrix (to preserve)

### Cursor IDE
- Uses `/v1/chat/completions` with `model="gpt-4"` or similar
- Maps to routing groups via `auto-coding` or explicit model match
- Expects standard OpenAI response + usage headers

### Claude.web (Browser)
- Uses `/v1/chat/completions` with `model="claude-*"`
- Message format: standard OpenAI
- Expects streaming + usage headers

### Codex CLI
- Uses `/v1/responses` (HTTP or WebSocket)
- Custom request/response format (via `translateInput`/`translateOutput`)
- Model names: "o4-mini", "o3", "gpt-5.5", etc. → mapped to groups

### Kiro Gateway
- Uses `/v1/chat/completions`
- Provider marked with `kilo: true` in seed
- Custom URL transforms (account ID resolution)

---

## Behavior Commitments (non-negotiable)

### /ban and /unban Endpoints
- **Pattern**: regex against provider name or model
- **Hours**: duration in hours (converted to ms)
- **Reason**: logged and stored
- **Behavior**: Sets provider cooldown + stalling score
- **Usage**: `POST /ban {"pattern":"Claude","hours":12,"reason":"garbled output"}`
- **Unban**: `POST /unban {"pattern":"all"}` or `{"pattern":"Groq"}`

### Group Bans (group-level provider blacklist)
- Stored in `state.groupBans[groupName]` as Set
- Checked during `getProvidersForGroup()`
- Converted to arrays for JSON export

### Provider Alive Flag
- `provider.alive === false` marks dead providers
- Not used in scoring/routing
- Preserved from seed or discovery

### Thinking Capability Probing
- Every 60 minutes on startup + periodically
- Unverified providers: send thinking request, check for `thinking_content`
- Mark as `thinking_ok: 1` in scores
- Stop after 3 failed probes per provider

### Context Limit Learning
- Track real context limits in `/data/compat.json`
- Override seed context if smaller learned value exists
- Applied at startup (line 520-525)

### Token Estimation
- **Formula**: 1 token ≈ 4 characters
- Applied to: messages, tools, tool responses
- Used for compaction trigger + context validation

---

## Source-Only Modules (will be imported, not modified)

These modules are **external** and **not** part of the core runtime refactor. They provide specialization and should be imported as-is:

| Module | Purpose | Status |
|--------|---------|--------|
| `lib/routing-policy.js` | Policy-based routing decisions | TBD (external) |
| `lib/provider-config.js` | Provider metadata + setup | TBD (external) |
| `lib/provider-adapters.js` | Provider-specific API wrappers | TBD (external) |
| `lib/anthropic-gateway.js` | Anthropic-specific gateway | TBD (external) |
| `lib/embeddings.js` | Embedding model discovery | TBD (external) |
| `lib/http-home.js` | Home page + status UI | TBD (external) |
| `claude-auth.js` | Claude-specific OAuth | TBD (external) |
| `github-copilot-auth.js` | GitHub Copilot OAuth | TBD (external) |
| `windsurf-auth.js` | Windsurf IDE OAuth | TBD (external) |

---

## Integration Points to Preserve

### Late-Bound Dependencies (via `.init()`)
- **routing.js**: Receives `sendError`, `trackSessionTokens` from llm-proxy.js
- **responses.js**: Receives `handleChatCompletion` from routing.js

### MemPalace Integration (llm-mempalace.js)
- Session detection: `getSession(messages).id`
- Session health: `mempalaceHealth()`
- Compaction feedback: session ID passed to `compactMessages()`
- Token injection: MCP responses injected before routing

### File Activity Tracking (state.js + transforms.js)
- IDE tracks read/write per session
- Deduplication: warn on 5+ consecutive identical reads
- Used for loop detection + stream guidance

---

## Known Quirks & Edge Cases

1. **Cloudflare Accounts**: URL template with `/accounts/me/` → resolved via `CLOUDFLARE_ACCOUNT_ID` env
2. **Alibaba Free Quota**: Special `FreeTierOnly` 403 detection → 3.5h cooldown
3. **Stalling Detection**: Track consecutive request failures → mark as stalling
4. **Group Bans**: Separate from provider cooldowns; per-group provider blacklist
5. **Truncation Cache**: Stable across requests (IDE caching) using fast content hash
6. **Drop Cache**: Compact decisions replayed if same session re-requests
7. **Context Override**: Real context learned at runtime, overrides seed

---

## Files Modified in This Inventory

- Created: `/data/runtime-merge-notes.md` (this file)

## Next Steps

1. ✅ Snapshot current behavior (this document)
2. ⬜ Merge new core runtime with preserved behaviors
3. ⬜ Validate all endpoints + behaviors still work
4. ⬜ Import source-only modules as needed
5. ⬜ Test with all IDE clients (Cursor, Claude.web, Codex, Kiro)
