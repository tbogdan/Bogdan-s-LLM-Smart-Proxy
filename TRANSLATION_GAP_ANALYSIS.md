# Cross-App/Provider Tool Translation Gap Analysis

**Repository**: llm-proxy  
**Scope**: Claude Code, Copilot, Devin, Windsurf, Codex translation coverage

---

## ✅ EXISTING IMPLEMENTATIONS

### 1. Subagent/Thread/Plan Tool Translation
**Location**: `lib/tool-dialects.js:1-385`

**Canonical families**: subagents, threads, plans  
**Clients mapped**: claude_code, codex, devin_desktop, windsurf, copilot

**Reusable functions**:
- `canonicalToolName(name)` → line 213-230 — resolves aliases to canonical
- `toolAliasesForClient(clientId, family)` → line 239-244
- `isSubagentToolName(name)` → line 256-276
- `isThreadToolName(name)` → line 284-299
- `nativeToolTarget(clientId, canonical)` — maps canonical → client-native
- `capabilityQuerieslientId, family)` — tool_search queries

### 2. Runtime Profile Detection
**Location**: `lib/ide-capabilities.js:145-330`

Profiles: claude-code-cli, claude-vscode, devin-desktop, windsurf, codex, github-copilot

Per-profile: wire_api, transport, capabilities (tools/plans/goals/subagents/m/skills/modes/threads/images/acp), expected_tools, tool_transform rules

 Capability Detection
**Location**: `lib/ide-capabilities.js:826-1005`

Function: `detectToolCapabilities(reqBody)` — extracts subagents/threads/plans/mcp/mcpResources

Patterns: Task, spawn_agent, multi_agent, create_thread, TodoWrite, update_plan, mcp__*, list_mcp_resources

**Tests**: tests/ide-capabilities.test.js:119-341 (13 tests, all clients)

### 4. Tool History Flattening
**Location**: `lib/transforms.js:365`

Function: `flattenToolHistoryForProvider(provider, body)` — collapses nested tool history for Windsurf/Devin

Compat: flattenNativeToolHistory (line ide-capabilities.js:582,596), preserveDevinSurfaceIdentity (line 594)

### 5. Provider Transform Metadata
**Location**: `lib/ide-capabilities.js:356-422`

Function: `providerTransformCapabilityMetadata(provider)` — extracts wire_protocol, request_shapes, tool_calls, context, modalities

### 6. Codex Virtual Tool Schema
**Location**: `lib/responses.js:119-238`

Functions:
- `codexVirtualToolSchema(name)` → line 119`codexVirtualToolDescription(name)` → line 227
- `codexVirtualDiscoveryQuery(name)` → line 238

Native targets: CODEX_SUBAGENT_NATIVE_TARGETS, CODEX_THREAD_NATIVE_TARGETS (tool-dialects.js:113-129)

### 7. Telemetry Filtering
**Location**: `lib/routing.js:7297`

Streaming filter strips chunks with inference_id, completion_tokens_per_sec, producer (provider-side telemetry only)

Note: Copilot auth uses telemetry.machineId/devDeviceId (copilot-fingerprint.js:159-196), not filtered

---

## ❌ GAPS IDENTIFIED

### GAP 1: MCP Resource Access Tools — No translation layer
**Evidence**:
- MCP detected: mcp__*, list_mcp_resources, read_mcp_resource (ide-capabilities.js:811-822)
- Expected in: claude-code-cli, claude-vscode, devin-desktop, windsurf, codex (line 174,202,230,259,295)
- **Missing**: No MCP family in tool-dialects.js TOOL_FAMILIES
- **Missing**: No MCP-specific canonicalToolName() handling
- **Missing**: No cross-client MCP alias mappingCodex MCP resources ≠ MCP tools per line 959)

### GAP 2: Goals/Modes Tool Translation — Partial coverage
**Evidence**:
- Goals: expected_tools.goals in Codex only (ide-capabilities.js:292: create_goal, get_goal, update_goal)
- Modes: expected_tools.modes in Codex only (line 294: request_user_input)
- **Missing**: No goals/modes families in tool-dialects.js
- **Missing**: No isGoalToolName() or isModeToolName() helpers
- **Missing**: No cross-client alias mapping

### GAP 3: Tool Name Sanitization/Restore — Impmentation not located
**Evidence**:	 requires: sanitize_namue, restore_names: capabilities.js:494-495)
- toolNam[A-Za-z0-9_-]{1,64}$, maxLength: 64 (line 49- **Missing**: No sanitizeName/restoreName functib/transforms.js (grep: 0 matches)
-sing**: No test coverage in tests/transforms.test.js

### GAP 4: Analytics/Usage/Call-Home Exclusions — Minimal filtering
**Evidence**:
- Single filter: FILTER-TELEMETRY (routing.js:7297) strips streaming chunks only
- telemetry.machineId sourced for Copilot auth only (copilot-fingerprint.js:159-196)
- **Missing**: No general analytics/usage/call-home exclusion policy
- **Missing**: No client-side analytics tool/header filtering
- **Missing**: No explicit exclusion list in tool-dialects.js

### GAP 5: Artifact Stripping — Declared but not found
**Evidence**:
- strip_artifacts: true declared (ide-c.js:180,208,237,266)
- Artifacts: ification, tool_use_error, subagent_usage_foote465)
- Compat flaripTaskNotificationArtifacts, stripToolUseErrtifacts, stripSubagentUsageFooter (line 469-471)
- **Missing**: No stripTaskNotification/stripToolUseError/stripSubagentUsage implementations in lib/transforms.js (grep: 0 matches)

### GAP 6: Cross-Provider Request Shape Translation — Partial routing only
**Evidence**:
- request_shapes: openai_chat_completions, openai_responses_bridge, anthropic_messages, windsurf_connect (ide-capabilities.js:366-371)
- Cross-provider catalog defined (line 403-422)
- **Missing**: No transformRequest() coverage for windsurf_connect ↔ anthropic_messages bidirectional translation
- **Missing**: No test coverage for Responses API → Anthropic Messages path (transforms.test.js: 68 tests, no hits)

---

## 📍 REUSABLE FUNCTIONS BY FILE

### lib/tool-dialects.js
- canonicalToolName() — line 213-230
- toolAliasesForClient() — line 239-244
- isSubagentToolName() — line 256-276
- isThreadToolName() — line 284-299
- Exports: line 370-385 (TOOL_FAMILIES, CLIENT_ALIASES, CAPABILITY_QUERIES, helpers)

### lib/ide-capabilities.js
- detectIdeClient() — line 37-63
- dentimeProfile() — line 424-690
- detectToolCapabilities() — line 826-1005
- buildClientCapability) — line 1006-1100
- Exports: line 1278-1291 (13 functions)

### lib/transforms.js
- flattenToolHistoryder() — line 365
- transformRequest() — exported
- Exports: line 2070-2082 (10 functions)

### lib/responses.js
- codexVirtualToolSchema() — line 119
- codexVirtualToolDescription() — line 227
- codexVirtualDiscoveryQuery() — line 238

---

## 📊 COVERAGE MATRIX

| Feature | Claude Code | Codex | Devin | Windsurf | Copilot | Gap? |
|---------|-------------|-------|-------|----------|---------|------|
| Subagents | ✅ Task | ✅ spawn_agent, multi_agent_v1 | ✅ Task, spawn_agent | ✅ Task, spawn_agent | ❌ [] | - |
| Threads | ❌ [] | ✅ codex_app.*, create_thread | ❌ [] | ❌ [] | ❌ [] | - |
| Plans | ✅ TodoWrite | ✅ update_plan | ✅ both | ✅ both | ❌ [] | - |
| MCP | ✅ mcp__* | ✅ mcp__* | ✅ mcp__* | ✅ mcp__* | ❌ no | ⚠ 1 |
| Goals | ❌ no | ✅ create_goal, get_goal | ❌ no | ❌ no | ❌ no | ⚠️ GAP 2 |
| Modes | ❌ no | ✅ request_user_input | ✅ yes | ✅ yes | ❌ no | ⚠️ GAP 2 |
| ACP | ❌ no | ❌ no |es | ❌ no | - |
| Tool name sanitization | ❌ no | ❌ no | ❌ no | ❌ no | ✅ required | ⚠️ GAP 3 |
| Artifact stripping | ✅ declared | ❌ no | ✅ declared | ✅ declared | ❌ no | ⚠️ GAP 5 |
| Analytics filtering | ❌ no | ❌ no | ❌ no | ❌ no | ⚠️ partial | ⚠️ *Legend**: ✅ Implemented | ❌ Not| ⚠️ Declared but missing implementation

---

## 🧪 TEST COVERAGE

- **tests/ide-ces.test.js** — 13 tests (lines 19-341): runtime profiles, capability detl 6 clients
- **tests/transforms.ts** — 68 tests: request transformations (no name sanitization, artifact stripping, or windsurf_connect↔anthropic_messages)
- **tests/routing-policy.test.js** — 2317 lines: provider policy, routing bonuses
- **Total test lines**: 32,599 across 28 test files

---

## 🔧 NEXT STEPS

1. **Extend tool-dialects.js**: Add MCP, goals, modes families + client aliases
2. **Implement missing trs**: sanitizeName/restoreName, artifact stripping functions
3. **Add MCP translation layer**: Cross-client MCP resource/template/tool mapping
4. **Define analytics exclusion policy**: Explicit tool/header/metadata filtering beyond streaming telemetry
5. **Test coverage**: Add transform tests for name sanitization, artifact stripping, MCP translation
6. **Document transform paths**: Complete request shape translation matrix (6 wire protocols × 6 clients)
