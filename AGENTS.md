<!-- orchestrate-core:agents:begin -->
Mandatory — before planning or executing work, load and follow the [orchestration entrypoint](.agents/skills/orchestrate/SKILL.md).
<!-- orchestrate-core:agents:end -->

## Orchestration bindings (project)

Generic rules live in `orchestrate-core`; this section only adds or tightens.

**Mandatory on every task (project):**

| What | When |
|---|---|
| `rtk proxy node --test tests/*.test.js` (or targeted file) | any change under `lib/`, `proxy.js`, `llm-proxy.js` |
| `rtk git status` + keep existing uncommitted changes | before any edit |
| Rebuild/recreate only `llm-proxy` container; never the others | runtime verification |
| No secrets in commits; scan staged diff | before commit/push |

**MCP servers confirmed live:** `context7`, `mempalace`, `sequentialthinking`, `filesystem`, `github`, `greptile`, `exa`, `headroom`. If a call fails, say the server is unreachable — never silently fall back.

**Per task type (Mandatory | Optional (trigger) | Available):**

| Task type | Mandatory | Optional | Available |
|---|---|---|---|
| BUG_FIX | reproduce before fixing; targeted test | `route-data-flow-tracer` (cross-layer) | `playwright` (UI-visible) |
| FEATURE | failing test first | `context7` (any library API) | … |
| CONFIG | verify via health + targeted probe | `context7` | … |

**Risk floors (override upward only):** proxy routing/auth/TLS → implementation X T3, independent review X T4; provider catalog/identity → S T3; tests only → W/S T2.

**Agent defaults:** backend fixes → `backend-fixer`; review → `code-reviewer` (gpt-6-sol, reasoning low per user); exploration → `explore`.
