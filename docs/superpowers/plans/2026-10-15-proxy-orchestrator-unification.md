# Proxy and Orchestrator Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method awaits user selection; no implementation has started.

**Goal:** Reduce total cost per successfully completed task through appropriate model/agent selection, stable caches, recoverable context reduction and account-aware fallback; reconcile both proxy variants, sanitize publishable history, embed the orchestrator, refresh model evidence and simplify installation/presentation.

**Architecture:** Keep the local transport/runtime as the integration baseline and embed the pinned orchestrator behind a CommonJS adapter. A persistent task ledger controls all inference, while an account/bucket availability ledger governs fallback. Preserve transmitted prefixes, compress only suitable new tool data with recoverable originals, and dispatch scoped roles with verified results; measure completion quality and total cost before enabling optimizations.

**Tech Stack:** Node.js >=22, CommonJS proxy, ESM orchestrator 1.4.0, node:test, existing ws and neo4j-driver dependencies, Docker Compose, Git, isolated Python environment for git-filter-repo.

**Spec:** `docs/superpowers/specs/2026-10-15-proxy-orchestrator-unification-design.md` (original core approved 2026-10-15; revision 2 adds Headroom, agents-library, account-limit fallback, efficiency evidence and easy onboarding).

**Reference/gap analysis:** `docs/superpowers/specs/2026-10-15-reference-projects-gap-analysis.md`.

## Global Constraints

- Select an appropriate LLM when a new task starts. Do not rescore ordinary continuations into a different LLM.
- Use at most three distinct LLMs across a task, including orchestration helpers.
- Parent/child agents share the parent's three-model budget.
- ID explicit plus identified conversation is the approved task boundary. Do not make every user message a new task.
- Fallback is required for unavailable or demonstrably unsuitable routes: prefer the same canonical model on another eligible provider, then a similar eligible model, within the task's remaining distinct-model budget.
- Keep recovery data and ignored historical archives outside publishable refs. Preserve the user's ten tracked modifications and untracked `.serena/` data.
- Include the orchestrator and required resources in the Docker build; no dependency on a sibling host directory at runtime.
- Preserve upstream LICENSE, NOTICE and embedded attribution markers.
- Public model listings prove neither account access nor measured quality. Unknown price/access remains unknown.
- Do not launch the existing exhaustive inference-probing discovery path during initial listing refresh.
- Remote force-push/publication is a final separately authorized step after the clean result is reviewable.
- Optimize total completion cost and account consumption subject to correctness/review floors; report estimation uncertainty and never promise a fixed savings percentage.
- Preserve transmitted history and signed/opaque protocol payloads. Compress suitable new tool data only when exact originals remain retrievable for the task lifetime.
- Track rate limits and depleted credits by proven account/quota bucket; do not rotate among models on the same exhausted account or mistake a timeout for zero credits.
- Reuse upstream agent roles/permission profiles; load only relevant role instructions and evidence. Additional agents and review iterations consume explicit task budgets.
- Adopt reference-project concepts through original code. No wholesale agents-library copy or mandatory Headroom service/ML runtime; record provenance/notices for any code actually reused.
- Make README/installation reflect implemented and measured behavior. Host Docker/Compose is the default prerequisite; one provider suffices for a new installation.

## Review Focus

1. Two clients send identical system prompts or explicit task IDs: allocations must remain scoped; tested in Task 5.
2. Two concurrent fallbacks race for the final model slot, or process restarts after reservation: never admit a fourth model; tested in Tasks 5 and 8.
3. A stream emits output before an upstream failure: never replay the whole request or tool side effects silently; tested in Task 8.
4. A pricing page lists Batch/Flex/Fast tables or a promotion expires: do not substitute them for Standard pricing or mark a stale/free route current; tested in Task 3.
5. Context compaction drops the first user message, or Responses resumes by previous_response_id: retain task identity and budget; tested in Tasks 5 and 8.

Additional revision-2 regressions: same-account quota sharing versus healthy
independent accounts (Task 4); middle-content hash collisions, missing originals
and mixed retrieval/client tools (Tasks 7 and 8); ineffective extra agents and
stale review gates (Tasks 9 and 10); repeated installer runs and partial provider
readiness (Task 11).

## File and interface map

All paths below are relative to the isolated integration checkout unless absolute.

| Boundary | Files | Responsibility |
| --- | --- | --- |
| Recovery and Git audit | external recovery directory; `scripts/audit-publication-history.py`; `scripts/sanitize-publication-history.py`; `tests/history-cleanup.test.js` | Snapshot, reconcile evidence, isolated history sanitation and verification |
| Embedded package | `vendor/llm-orchestrator/**`; `scripts/vendor-orchestrator.mjs`; `tests/orchestrator-bundle.test.js` | Reproducible attributed package/resources, source SHA and hashes |
| Shared routing | `lib/orchestrator-bridge.js`; `tests/orchestrator-bridge.test.js` | Load ESM, adapt inventory/profile, rank eligible roles and validate flow contracts |
| Pricing and listing | `lib/model-inventory.js`; `lib/model-pricing.js`; `scripts/refresh-model-catalog.js`; `data/model-catalog-evidence.json`; discovery/config metadata modules | Bounded listings, provider-specific pricing evidence and atomic refresh |
| Account availability | `lib/account-availability.js`; `lib/upstream-failure.js`; focused tests; provider config/scoring | Scoped rate/quota circuits, reset evidence and healthy-account fallback |
| Task identity/state | `lib/task-routing.js`; `lib/task-store.js`; `tests/task-routing.test.js`; `tests/task-store.test.js` | Scoped identities, role pins, atomic three-model ledger, persistence |
| Request integration | `lib/routing.js`; `lib/responses.js`; `lib/anthropic-gateway.js`; `llm-proxy.js`; `lib/memory/index.js` | Carry task identity and enforce allocation on every request/helper/child path |
| Cache adapter | `lib/task-cache.js`; `lib/transforms.js`; `lib/provider-adapters.js`; `lib/anthropic-adapter.js` | Stable prefix snapshots, supported cache controls, cache usage accounting |
| Recoverable context | `lib/context-optimizer.js`; `lib/context-store.js`; `lib/tool-retrieval.js`; `lib/compaction.js`; dedicated tests | Incremental deterministic compression and scoped bounded original retrieval |
| Lean role dispatch | `config/proxy-orchestration.json`; bridge/Responses integration; original proxy role schema and tests | Relevant roles, compact briefs, one writer, evidence-backed reviews and bounded loops |
| Efficiency evaluation | `scripts/benchmark-efficiency.js`; sanitized `tests/fixtures/efficiency/**`; `tests/efficiency-contract.test.js` | Controlled baseline comparisons for quality, total cost and latency |
| Onboarding and docs | `setup.sh`; `scripts/doctor.js`; `tests/setup.test.js`; README/INSTRUCTIONS and `docs/operator/**` | One-command setup, read-only diagnostics, idempotent client configuration and evidence-backed presentation |
| Delivery | Dockerfile, `.dockerignore`, package manifests, README/INSTRUCTIONS, existing protocol tests | Portable build, diagnostics, operator controls and integrated regression evidence |

### Shared contracts

New modules use these names consistently; integration tasks consume them.

```js
// lib/task-store.js (CommonJS)
createTaskStore({ dataDir, now = Date.now })
// -> { transaction(taskKey, update), get(taskKey), close() }
// transaction serializes this key and atomically persists before resolving.
// update(currentRecord|null) -> { record, result }; returned result is awaited.

// lib/task-routing.js
resolveTaskIdentity({ clientScope, taskId, conversationId, parentTaskKey,
  previousTaskKey, conversationAnchor })
// -> { key, taskId, source, confidence }; missing stable scope is explicit.
createTaskRouter({ store, rankCandidates, now = Date.now })
// -> { acquire(input), recordFailure(input), inspect(taskKey) }
// acquire({ identity, role, profile, candidates, event })
// -> { taskKey, canonicalModel, providerId, accountRef, routeId, upstreamModel, effort,
//      role, inventoryRevision, reason, reservationId }
// event: start | continue | unavailable | capability_mismatch | independent_review
// Neither transient scoring nor arbitrary user text is a fallback event.
// Candidates use the normalized model-inventory contract below.

// lib/model-inventory.js
normalizeInventory({ observations, observedAt })
// -> { revision, observedAt, models, limitations }
// model: { canonicalModel, providerId, accountRef, routeId, upstreamModel, capabilities, efforts,
//   contextWindow, availability, source, observedAt, priceRef }
// canonicalModel includes lab/model/version/variant; provider aliases merge only
// with verified identity evidence. Unknown variants are separate models.

// lib/model-pricing.js
normalizePriceObservation(observation)
// -> { providerId, upstreamModel, billingBasis, serviceTier, currency,
//      inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok,
//      longContextThreshold, validFrom, validUntil, source, observedAt, status }

// lib/orchestrator-bridge.js
loadOrchestrator() // Promise<{ classify, rankModels, ...upstream exports }>
rankTaskCandidates({ profile, inventory, role, taskAllocation })
// Promise<{ ranked, classification, exclusions, inventoryRevision }>
buildProxyFlow({ taskType, complexity, inventory, taskAllocation })
// Promise<{ phases, contracts, limitations }>

// lib/task-cache.js
createTaskCache({ store })
// -> { prepare({ allocation, body, adapterCapabilities }), usage(upstreamUsage) }
// prepare -> { body, cacheKey, prefixHash, changes, supported }
// usage -> { readTokens, writeTokens, source }; absent usage is unknown, not hit.

// lib/upstream-failure.js
classifyUpstreamFailure({ providerKind, status, headers, errorBody, transportError })
// -> { kind, scope, retryAt, resetAt, evidence }
// kind: rate_limit | credit_exhausted | auth_expired | forbidden | transient |
//       capability_mismatch | invalid_request | unknown
// scope: route | model | quota_bucket | account; scope must follow provider evidence.

// lib/account-availability.js
createAccountAvailabilityStore({ dataDir, now = Date.now })
// -> { observe({ route, failure }), isEligible(route), beginHalfOpen(route),
//      reset({ accountKey, evidence }), snapshot(), close() }
// Persist opaque account references, never credentials or raw auth responses.

// lib/context-store.js
createContextStore({ dataDir, maxBytes, now = Date.now })
// -> { put({ taskKey, role, bytes, strategyVersion }),
//      get({ taskKey, ref, start, end }), releaseTask(taskKey), close() }
// put -> { ref, sha256, bytes, strategyVersion }; get -> exact bounded original.

// lib/context-optimizer.js
createContextOptimizer({ store, tokenCounter, config })
// -> { prepare({ taskKey, role, messages, retrievalAvailable, wireProfile }) }
// prepare -> { messages, refs, diagnostics, strategyVersion }.
// Store succeeds before replacement; earlier transformations replay unchanged.

// lib/tool-retrieval.js
resolveOriginalTool({ taskKey, calls, store, maxBytes, maxCalls })
// -> { handledResults, clientCalls, errors }; preserve IDs/order and client calls.

// lib/orchestrator-bridge.js additions
selectProxyRoles({ profile, capabilities, budget, registry })
// -> { roles, phases, omitted, reviewFloor, estimatedOverhead }
buildAgentBrief({ task, constraints, acceptance, assignment, evidenceRefs })
// -> { instructions, context, limits }; hard constraints remain verbatim.
validateReviewEvidence({ finding, revision, evidence })
// -> { verdict, confidence, reason }; verdict confirmed | refuted | uncertain.
```

## Phase A — Recoverable integration and embedded package

### Task 1: Preserve both sources and reconcile runtime behavior

**Files:** external bundle/working-change manifest; all 29 conflicted paths; existing tests; `.gitignore`.

**Consumes:** local HEAD `733d5b3`, remote main `c187a42`, common ancestor `b9b83ef`, current tracked/untracked changes.

**Produces:** isolated `codex/proxy-orchestrator-unification` integration branch with conflict decisions, saved working changes applied, all pre-existing behavior validated or explicitly recorded failing.

- [ ] Record exact current SHAs, status, linked worktree state and tracked/untracked file hashes again. Stop reconciliation if the user has changed source files since the recovery snapshot; incorporate that delta before replacing anything.
- [ ] Create an external recovery directory with restrictive permissions. Save a verified all-refs Git bundle, `git diff --binary HEAD`, untracked `.serena/`, and exact hashes. Copy this spec, plan and companion reference-gap analysis separately: their parent directory is ignored, so a normal bundle or untracked-file listing will miss them. Keep `.env` and runtime data in place and unversioned.
- [ ] Use the managed-worktree tool with explicit `ref: HEAD`. The source has no remote default configured. Create the integration branch in the returned workspace; do not reuse an unrelated worktree.
- [ ] Recheck GitHub SHA with `git ls-remote`; obtain the verified remote commit if it changed. Record the source SHA and use that object in the merge.
- [ ] Run source tests in isolation: local `node --test tests/*.test.js`, remote declared smoke command plus any remote test files. Capture exit codes and counts. If a baseline fails, establish the cause and record it before attributing it to the merge.
- [ ] Merge remote with `--no-commit`; reconcile core transport/protocol files using local behavior as baseline. Review every conflict rather than using blanket `--ours` or `--theirs`. Reconcile provider seeds by canonical identity; preserve protocol/auth differences.
- [ ] Recover remote-only scripts, auth helpers, documentation links and memory/deploy coverage. Compare changed function bodies and tests, not only names. Maintain `data/integration-decisions.json` containing source SHAs, path, decision and validation references; no private runtime data.
- [ ] Copy the spec, plan and companion reference-gap analysis into the integration checkout and force-add only these intended brand-free documents plus the integration-decisions report. Do not force-add their archived neighbors or private runtime files.
- [ ] Apply saved working diff, including the ten modified tracked files. Where an archived document is untracked afterward, restore it physically as ignored local data. Preserve `.serena/` without committing it.
- [ ] Run affected protocol/discovery/config tests and the integrated suite; commit the reconciled runtime after review. Existing ignored-but-tracked archived plans and operational journals must leave the index while remaining recoverable locally.

### Task 2: Bundle the orchestrator and load its actual router

**Files:** create vendor distribution, vendoring script, bridge and bundle/bridge tests; modify Dockerfile, `.dockerignore`, package manifests.

**Consumes:** orchestrator `834089e`, package 1.4.0, upstream package `files` allowlist and its LICENSE/NOTICE.

**Produces:** `loadOrchestrator`, `rankTaskCandidates`, `buildProxyFlow` contracts above; portable Docker context.

- [ ] Write a failing bundle test using the real source manifest: verify LICENSE/NOTICE, router, registries, schemas and referenced resources exist in `vendor/llm-orchestrator`; reject nested `.git`, `.orchestrator-run`, `.serena`, `.env`, symlinks escaping the bundle and hard-coded sibling host paths.
- [ ] Run `rtk proxy node --test tests/orchestrator-bundle.test.js`; expect failure because no bundle exists.
- [ ] Implement vendoring from the package allowlist, following only in-root regular resources. Write `vendor/llm-orchestrator/provenance.json` with source SHA, package version, adaptation description and SHA-256 file manifest. Preserve attribution. Do not copy host accounts or auto-install external MCP servers.
- [ ] Implement memoized dynamic `import()` in the bridge. Use upstream `classify`, `rankModels`, `buildShardContracts` and capability resolution rather than a second copy of their algorithms. Inject normalized live inventory and per-task allowed models.

```js
let corePromise;
function loadOrchestrator() {
  return corePromise ??= import('../vendor/llm-orchestrator/lib/router.mjs');
}
// Import dispatch-contract.mjs and capability-resolver.mjs separately in
// buildProxyFlow; their exports are not part of router.mjs.
```
- [ ] Add bridge tests asserting known classification matches upstream for SIMPLE/MODERATE/COMPLEX/CRITICAL tasks, unavailable models are excluded, review floors remain enforced, and self-review never satisfies independent review.
- [ ] Run `rtk proxy node --test tests/orchestrator-bundle.test.js tests/orchestrator-bridge.test.js`; expect pass. Run bundled upstream router/contract/model-discovery/attribution tests using its own manifest layout.
- [ ] Update Docker COPY paths and scripts so an image can load the bundle with no sibling directory. Add a `.dockerignore` excluding credentials, runtime data, Git/worktrees and local archives while including the required evidence catalog. Commit bundle/bridge changes.

## Phase B — Fresh model evidence, stable tasks and orchestration

### Task 3: Separate read-only listing, billing evidence and inference probes

**Files:** create inventory/pricing modules, refresh script, evidence JSON and tests; modify `llm-discovery.js`, `lib/provider-config.js`, `lib/provider-metadata-overrides.js`, `seed-providers.json` and applicable embedded model metadata.

**Consumes:** configured provider families and normalized observations; no credentials enter evidence.

**Produces:** `normalizeInventory`, `normalizePriceObservation`, versioned provider-specific evidence and a bounded refresh command.

- [ ] Write failing tests for configured/exposed/verified status separation; identical display names with different version/effort variants; unsupported effort; expired promotion; unknown price; Standard vs Batch/Flex/Fast distinction; direct API USD vs subscription multiplier; failed listing retaining stale prior evidence.
- [ ] Include this exact invariant in `tests/model-pricing.test.js`:

```js
const row = normalizePriceObservation({
  providerId: 'fixture-provider', upstreamModel: 'fixture-model',
  billingBasis: 'subscription', serviceTier: 'standard',
  observedAt: '2026-10-15T00:00:00Z', source: 'fixture:subscription',
  premiumMultiplier: 2,
});
assert.equal(row.inputPerMTok, null);
assert.equal(row.billingBasis, 'subscription');
```

- [ ] Run inventory/pricing tests and confirm failure before modules exist.
- [ ] Implement normalized schemas, atomic output replacement and `refresh-model-catalog --mode list --output <path>`. Listing mode must never call `probeSeedProviderDetailed`, `testThinking`, `testContextSize` or inference endpoints. Test that with injected functions that throw if invoked.
- [ ] Retrieve official catalogs/prices for configured providers, including non-core provider keys present locally. Store canonical URLs, time, rate units, service tier, context thresholds, source confidence and promotion expiry. Retrieve bounded account model listings where supported; sanitize errors without auth headers/body dumps.
- [ ] Reconcile exact IDs/efforts/context and retire/deprecate missing models only with source evidence. Keep temporary listing failure separate from retirement. Do not admit unmeasured models into critical roles by invented scores. Newer known model successors may replace cost metadata with provenance, not fabricate benchmarks.
- [ ] Add an explicitly separate `--mode probe --max-models <n> --max-output-tokens <n>` for selected small validation calls. Never context-sweep every seeded model by default. Actual billing/access proof remains separate from successful listing.
- [ ] Run `rtk proxy node --test tests/model-inventory.test.js tests/model-pricing.test.js tests/discovery.test.js tests/provider-metadata-overrides.test.js`. Verify evidence output is free of credentials and reproducible under fixture inputs; commit catalog and refresh logic.

### Task 4: Account-aware rate-limit and credit fallback

**Files:** create `lib/upstream-failure.js`, `lib/account-availability.js`, tests;
modify provider config/metadata, scoring and normalized route evidence.

**Consumes:** discovered routes with opaque `accountRef`, billing-bucket evidence
and structured upstream errors. **Produces:** failure classification and shared
availability contracts above, used before candidate ranking and retry.

- [ ] Write failing fixtures for 429 with numeric/date Retry-After, account-wide
  daily limit, model-specific throughput limit, explicit depleted credits,
  expired credential, permission denial, transport timeout and unknown balance.
  Include a request echo containing the word credits: it must not become billing
  evidence. Status 402/403/429 alone does not prove a provider-specific cause.
- [ ] Test two models sharing one configured account, one model on an independent
  account and one via a different provider. Empty credits disable the shared
  exhausted bucket only. Access-token rotation must retain account quota state.
- [ ] Run `rtk proxy node --test tests/upstream-failure.test.js tests/account-availability.test.js`;
  confirm failures before implementation.
- [ ] Add explicit account-to-route references with backward-compatible defaults
  for existing single-account configurations. Keep secret values in existing env
  or credential storage. Never infer a new usable account from an env variable
  name alone or combine unrelated provider accounts by matching display labels.
- [ ] Normalize provider-supported structured codes/headers and reset timestamps.
  Persist scoped circuits; use bounded retry for transient limits, known reset
  times for quota and confirmed positive evidence/operator reset for empty credits.
  Unknown reset times stay unknown with bounded recheck, never an invented hour.
- [ ] Implement one half-open probe lease per eligible bucket after cooldown.
  Exhausted accounts must not be retried once per model or by every concurrent
  worker. Credential refresh may run once through the supported existing flow;
  a failed refresh does not become an unlimited account-switch loop.
- [ ] Test persistence/restart and concurrent half-open admission; test no clear
  of quota circuits by scoring/diversity fallback. Verify other configured healthy
  accounts can serve the same pinned canonical model before admitting a new LLM.
- [ ] Re-run focused tests plus provider config/scoring regressions, then commit.

### Task 5: Persistent task identity and atomic three-model ledger

**Files:** create task store/router modules and focused tests; modify `lib/state.js` only for initialization/lifecycle wiring.

**Consumes:** normalized inventory and `rankTaskCandidates`; produces allocation contracts used by all later inference paths.

- [ ] Write failing tests for explicit task ID; parent task inheritance; conversation continuation; new task reset; scope isolation when two clients use identical IDs/system prompts; missing reliable identity reporting; malformed IDs; two tasks concurrently allocating different primaries.
- [ ] Write store tests for concurrent writes, crash/reopen, corrupt/truncated state, bounded retention and active-record eviction rejection. Persistence failure must reject dispatch rather than silently reset the budget.
- [ ] Add a lifetime-budget regression with four eligible fixture models:

```js
const first = await router.acquire({ identity, role: 'primary', profile, candidates, event: 'start' });
await router.recordFailure({ taskKey: first.taskKey, reservationId: first.reservationId, reason: 'unavailable' });
const second = await router.acquire({ identity, role: 'primary', profile, candidates, event: 'unavailable' });
await router.recordFailure({ taskKey: second.taskKey, reservationId: second.reservationId, reason: 'unavailable' });
const third = await router.acquire({ identity, role: 'primary', profile, candidates, event: 'unavailable' });
await router.recordFailure({ taskKey: third.taskKey, reservationId: third.reservationId, reason: 'unavailable' });
await assert.rejects(
  router.acquire({ identity, role: 'primary', profile, candidates, event: 'unavailable' }),
  { code: 'TASK_MODEL_BUDGET_EXHAUSTED' },
);
```

Fixtures declare `identity`, `profile`, `candidates` and router with an isolated temporary store; every attempted route is recorded, including failed ones.

- [ ] Confirm focused tests fail. Implement per-key serialized transactions, one digest-named state file per task, atomic rename, bounded IDs and restrictive file permissions. Do not persist independent task transactions by overwriting one shared JSON snapshot: concurrent keys would lose updates. Deployment shares a single writer; reject conflicting multi-process writers rather than relying on a process-local mutex across replicas.
- [ ] Persist role pins, canonical IDs attempted, provider route, effort, snapshot revision, reservations, timestamps, failures and cache-snapshot references. Do not store raw credentials or full request transcripts.
- [ ] Implement continuation returning the existing pin regardless of rank changes. Admit another canonical model only for allowed events, reserving before dispatch. Filter routes through Task 4's account availability; prefer equivalent same-model routes for unavailable providers/accounts. Merge aliases only on proven identity. Lost reservations count conservatively after restart.
- [ ] Test a final-slot race using `Promise.allSettled`: at most one distinct new model can be admitted. Close/reopen the store and confirm the fourth remains rejected. Test a same-model alternate provider changes route without increasing canonical model count.
- [ ] Run `rtk proxy node --test tests/task-store.test.js tests/task-routing.test.js`; expect pass; commit.

### Task 6: Preserve cacheable prefixes and supported cache controls

**Files:** create `lib/task-cache.js`, `tests/task-cache.test.js`; modify transform/provider/Anthropic adapters and usage accounting tests.

**Consumes:** a committed task allocation and task store; produces stable prepared body and observed cache usage.

- [ ] Write failing tests: two continuations preserve initial system/developer/tool-prefix bytes; changing memory is appended after the reusable prefix; task scopes yield distinct cache keys; caller cache settings survive; unsupported adapters receive no new fields; changed tool requirements invalidate only the affected snapshot.
- [ ] Test legitimate changed client system instructions: honor the new content
  and record the cache invalidation; do not overwrite it with the saved version.
  Pin only proxy-owned text and transformation decisions. Opaque reasoning,
  signatures and encrypted blocks remain unchanged.
- [ ] Test that reasoning and tool-schema ordering remain pinned for the same role. Preserve existing tool-result ordering and semantic trust boundaries. Never sort tools/messages purely to force a cache hit.
- [ ] Run `rtk proxy node --test tests/task-cache.test.js`; confirm failure before implementation.
- [ ] Implement first-use immutable instruction snapshots stored by task/role and prefix hashes. Separate changing telemetry from prompt content. Apply documented provider-supported cache fields; preserve caller-selected TTL/mode. Missing support stays explicit.
- [ ] Add tests for exact OpenAI/Anthropic usage shapes; absent `cached_tokens` is unknown, not a cache hit. Keep cache creation/read costs distinct and provider billing basis attached.
- [ ] Run cache tests with transforms/provider-adapters/Anthropic-adapter tests and commit. A live cache hit is a separate final check; unit tests prove request stability only.

### Task 7: Incremental recoverable tool-data compression

**Files:** create context optimizer/store/retrieval modules and dedicated tests;
modify `lib/compaction.js`, `lib/state.js` and adapter capability metadata.

**Consumes:** scoped task/role, Task 6 prefix snapshots, model tokenizer evidence
and confirmed retrieval support. **Produces:** deterministic prepared tool data,
exact recoverable originals and transparent retrieval results using contracts above.

- [ ] Write failing tests: a repeated log folds duplicates but preserves errors
  and counts; large JSON preserves selected field types and records omitted
  rows; small/uncertain input passes through. Instructions, exact-edit code/diffs,
  full Git status, IDs, signed reasoning and multimodal blocks remain untouched.
- [ ] Add two payloads with identical first/last 200 characters and length but
  different middle content. They must receive different full-content SHA-256
  identities and recover their own exact bytes. Cross-task hash knowledge must
  not authorize original retrieval.
- [ ] Add warm-prefix tests: replay compressed historical tool results identically
  even when the client resends original bytes or optimizer defaults change.
  Only new eligible tool output is optimized. Avoid recompressing prior assistant
  reasoning or moving client instructions for cache gains.
- [ ] Run `rtk proxy node --test tests/context-store.test.js tests/context-optimizer.test.js tests/tool-retrieval.test.js`;
  confirm failures before implementation.
- [ ] Implement durable scoped exact-original storage and immutable transformed
  representations keyed by full content, wire profile and strategy version.
  Pin referenced originals for active tasks; on disk limit/storage failure,
  forward new originals uncompressed. Preserve existing references after restart.
- [ ] Implement bounded deterministic log/JSON/data transforms, reusing safe
  current compaction functions. Replace unsafe first/last-only truncation keys
  and preview-only paths for optimized data. No ML or extra LLM call by default.
  Enforce maximum processing time/bytes; failure returns the untouched input.
- [ ] Define a stable namespaced retrieval tool before the task's first request
  where supported. Without an accessible retrieval path, disable lossy data
  reduction. Retrieve ranges/filters with explicit byte/call limits; retrieval
  results bypass further compression. A digest never claims semantic losslessness
  merely because bytes exist on disk: retrieval behavior must also pass tests.
- [ ] Test mixed original-retrieval and client tool calls, missing originals,
  changed/deleted source files, active retention under store pressure and partial
  streams. Keep client tool IDs/results in order; do not execute client tools.
- [ ] Wire the new behavior into existing compaction instead of stacking a second
  independent compressor. Context-pressure compaction remains explicit and uses
  recoverable snapshots or clear guidance. Warm prefix rewrites need measured
  benefit or actual context pressure; a guessed TTL is insufficient.
- [ ] Run focused tests plus compaction/transforms/streaming regressions; commit.

### Task 8: Enforce task allocation on every transport, retry and helper path

**Files:** modify `lib/routing.js` selection/retry/assessment functions, `lib/responses.js` history/WebSocket/virtual agents, `lib/anthropic-gateway.js`, `llm-proxy.js`, `lib/memory/index.js`; add `tests/task-routing-integration.test.js` and extend existing protocol suites.

**Consumes:** task-router/cache/bridge contracts. Produces protocol-consistent task pinning and justified fallback.

- [ ] Write failing integration tests through real handlers with mocked upstreams: Chat Completions stream/nonstream, Responses HTTP/WebSocket with `previous_response_id`, Anthropic Messages, explicit model requests and tool-result continuations all retain task allocation.
- [ ] Add regression tests for higher score/cheaper price/discovery changes mid-task: assert upstream calls still use the pin. New explicit task IDs must allow a cheaper/weaker or stronger model when classification supports it.
- [ ] Test 429/timeout/model-not-found: bounded backoff, equivalent-model alternate provider, then similar eligible model. Reject candidates lacking tools/media/context/required effort/review floor. Never fallback on malformed caller input or denied permission by pretending it is model downtime.
- [ ] Include exhausted account credits, shared buckets, healthy independent
  accounts, real reset evidence, credential refresh and quota state on restart.
  Prefer a healthy same-model route; retain its new provider/account pin after
  successful fallback rather than oscillating when the former account recovers.
- [ ] Test one stream chunk then failure: return a protocol-correct terminal error, retain task state and do not transparently restart a side-effect-capable turn. Before-first-byte retry remains possible within the ledger.
- [ ] Run targeted tests and confirm failures against current routing.
- [ ] Resolve task context at the HTTP/WS boundary, preserve it through Responses history and native gateway conversion, and expose `X-LLM-Proxy-Task-ID` in response/CORS headers. Prefer explicit task/conversation IDs; use conversation-anchor fallback only when scoped and identify its confidence. Never use the memory system hash alone.
- [ ] Add one allocation guard immediately before each actual provider inference send. Route assessment, compaction summaries, memory generation and virtual-agent calls through the same parent ledger. Strip internal IDs from upstream bodies except documented provider cache/session controls.
- [ ] Order request preparation: task identity → account eligibility → pinned
  allocation → incremental context transform → supported adapter/cache fields →
  final dispatch guard. Include retrieval continuations in the same ledger,
  accounting and iteration limits. Prevent recursive proxy helper calls from
  resetting quota or model budgets.
- [ ] Disable existing diversity/assessment/context-escalation reroutes for ordinary pinned continuations. A capability mismatch must be validated and recorded before acquiring another eligible model; context overflow first compacts or produces guidance. Internal summaries use admitted models or deterministic fallback.
- [ ] Carry parent task key into virtual child calls and require role review floors from the bridge. Native client subagents can only share this budget if they propagate the task metadata; expose missing propagation as a limitation, never silently claim coverage.
- [ ] Run all affected routing/scoring/streaming/Responses/gateway/memory tests, plus new integration tests. Include compaction that removes the original first user message and a process restart between tool calls. Commit once passing or with any pre-existing baseline failures separately documented.

### Task 9: Connect orchestration flows and capability diagnostics

**Files:** bridge integration; `lib/responses.js`; `lib/ide-capabilities.js`; `llm-proxy.js`; README/INSTRUCTIONS; `tests/orchestration-integration.test.js`.

**Consumes:** embedded upstream dispatch/capability contracts, active client tools and parent allocation.

**Produces:** executable proxy-adapted phases/roles using shared task budget; read-only `/v1/orchestration` diagnostics with no credentials.

- [ ] Write failing tests for FEATURE/BUG_FIX/REVIEW flow generation, phase gates, independent review, iteration limits and child inheritance. A declared-but-uncallable MCP/tool must not appear as executable. Missing capabilities report blocked/degraded state, never fake execution evidence.
- [ ] Add original proxy role contracts extending the embedded registry, rather
  than copying agents-library prompts. Select relevant roles only; verify a tiny
  task avoids an unnecessary manager/reviewer fleet while a high-risk task keeps
  independent review and its capability floor. Agent count is separately budgeted
  from the maximum three canonical models.
- [ ] Confirm failures, then adapt upstream flow contracts to native client tools and existing proxy-hosted virtual agent handling. Choose tier/effort per role once; continuations reuse that role pin. Multiple shards may share one model; shard count never requires additional distinct models.
- [ ] Implement `selectProxyRoles` and `buildAgentBrief` with task/risk, exposed
  tools, assigned files and completion-cost budget as inputs. Give each role a
  single measurable objective, acceptance criteria, allowed tools/files and a
  token/cost/iteration ceiling. Preserve hard constraints verbatim; hand off
  compact evidence references instead of whole transcripts. Suppress unrelated
  role definitions from every request's prefix.
- [ ] Enforce one writer per overlapping file set and read-only review permissions
  where the actual client can enforce them; expose unsupported enforcement.
  Pin final gate/review evidence to source revision/tree digest. Invalidate it
  after relevant edits, task reset or the final history-cleanup tree change.
- [ ] Test findings confirmed/refuted/uncertain against real fixture code. Verify
  findings before fixes, deduplicate equivalent issues and bound repair loops.
  Stop at convergence or budget exhaustion; do not keep paying for unchanged
  reviews. Cover equivalent affected protocol paths without unrelated cleanup.
- [ ] Add original dispatch/review eval cases with clear pass/fail criteria,
  including irrelevant-role selection, a false-positive finding, ignored task
  constraint and stale gate evidence. Optional live eval compares role context
  enabled/disabled; it is bounded and never runs automatically on all models.
- [ ] Implement bounded diagnostics exposing source SHA, registry revision, evidence age, capability states, counts and sanitized reasons. Task inspection must be scoped; public diagnostics must not enumerate other clients' prompts or IDs.
- [ ] Document explicit task IDs/reset, conversation fallback confidence, same-model provider fallback, three-model exhaustion, helper accounting and what proxy cannot enforce when a client bypasses it.
- [ ] Run `rtk proxy node --test tests/orchestration-integration.test.js tests/ide-capabilities.test.js tests/responses.test.js tests/orchestrator-bridge.test.js`; commit.

## Phase C — Efficiency evidence, onboarding and clean delivery

### Task 10: Measure total completion efficiency and gate optimization rollout

**Files:** create `scripts/benchmark-efficiency.js`, sanitized fixtures,
`tests/efficiency-contract.test.js`; extend existing benchmark/telemetry modules.

**Consumes:** Tasks 3–9 inventory, pricing, account state, task allocations,
compression diagnostics, role results and upstream usage evidence.

**Produces:** reproducible four-arm report: passthrough, current proxy baseline,
stable routing/cache, and stable routing/cache plus context optimization.

- [ ] Write failing report tests distinguishing estimated tokens/cost, observed
  upstream usage, subscription credits and unavailable data. Include all helper,
  retrieval and retry turns; cache writes must not be counted as free cache hits.
  A failed task cannot count as a successful cheap completion.
- [ ] Add paired fixtures: repeated log with one diagnostic outlier, wide JSON
  requiring an omitted original row, exact-file patch, signed reasoning,
  long tool loop, account exhaustion and high-risk independent review. Include
  redundant role context so the control can expose overhead without benefit.
- [ ] Run `rtk proxy node --test tests/efficiency-contract.test.js`; confirm failure.
- [ ] Implement offline replay with content/graph invariants, emitted prefix hash,
  model/account sequence, transform/retrieval counts and estimated costs. Use a
  provider tokenizer only where verified; otherwise label estimates and units.
  Compare representative task distributions, not one synthetic giant log.
- [ ] Implement explicit live mode with hard limits for tasks, output tokens,
  duration and spend/credits when measurable. Evaluate matched task correctness
  and final tests, not only JSON validity. Hold model and workload constant when
  isolating compression; record all model differences when evaluating routing.
- [ ] Report task success rate, total cost per success, p50/p95 end-to-end latency,
  input/output/reasoning/cache usage, credit consumption when exposed, fallback
  reasons and compression overhead. Report sample counts and uncertainty; do not
  infer realized cost saving from shortened input alone.
- [ ] Preserve correctness/review-floor gates. Do not enable a transform that
  loses a required fact or breaks retrieval/protocol invariants. Make runtime
  optimizer controls task-pinned and keep passthrough available. Treat dynamic
  per-turn effort reduction and cold-prefix rewriting as off by default until
  provider-specific quality/cache evidence supports them.
- [ ] Run offline tests, then only selected bounded live checks with available
  configured accounts. Save dated reproducible results; commit sanitized fixtures,
  metrics/report code and documentation of any unverified live outcomes.

### Task 11: Rewrite presentation and make installation verifiable and easy

**Files:** `README.md`, `INSTRUCTIONS.md`, `.gitignore`, `setup.sh`, `lib/http-home.js`,
`tests/http-home.test.js`, Dockerfile/Compose/env defaults; create
`scripts/doctor.js`, `tests/setup.test.js`, `docs/operator/`.

**Consumes:** final implemented behavior and Task 10 evidence. **Produces:** one
documented install entrypoint, read-only doctor and clear client/provider setup.

- [ ] Add installer fixtures for Docker missing, daemon down, Compose unavailable,
  occupied/configured port, no route, expired auth, empty credits and healthy
  configured account. Run setup twice and assert credentials/config/client files
  remain unchanged unless a specific requested change is applied.
- [ ] Confirm `rtk proxy node --test tests/setup.test.js` fails before changes.
- [ ] Keep `./setup.sh` as the primary entrypoint. Add documented `doctor`,
  `--dry-run`, `--non-interactive`, `--upgrade` and `--uninstall` behavior. Package
  checks/doctor with the container so a new install does not need host Node/Python.
  Do not install host package managers or Docker silently.
- [ ] Start minimal proxy/orchestrator/task/original-store services with one
  configured route; make optional memory/provider services explicit profiles.
  Preserve current deployments' chosen features. Validate configured ports before
  starting, bind new defaults to loopback and print URLs from actual resolved
  config rather than the current hardcoded port 18900.
- [ ] Show readiness in layers: runtime healthy, account configured, auth/listing
  status known, inference verified only when a bounded explicit probe succeeded.
  Doctor is read-only by default; it must not create sessions/accounts, consume
  inference credits, expose secrets or alter client configuration.
- [ ] Detect existing supported host credentials without dumping them. Offer
  provider-specific next commands and opt-in client setup with backup/restore.
  Re-running setup or upgrading must not remove unrelated keys or settings.
  Uninstall stops/removes only this installation's resources and preserves data
  and credentials; destructive purge is separately named and never the default.
- [ ] Remove the current unconditional setup loop that deletes configured memory,
  Graphiti, model-discovery and provider transport environment settings. Replace
  it with explicit versioned migrations only when required, with recoverable
  config backup. Test a pre-existing customized `.env` byte-for-byte.
- [ ] Rewrite README order: purpose/benefits → actual quick start → choose mode or
  client → simple architecture → measured proof → limits → detailed links.
  Lead with right model per task, stable cache and account-aware continuity.
  Keep historical benchmark results dated and outside the product headline.
- [ ] Align the existing local home page with the same factual positioning,
  detected endpoint/client instructions and readiness states; reuse its current
  UI rather than introducing another marketing website or dashboard framework.

Proposed opening copy, to publish only after corresponding acceptance checks:

> Bogdan LLM Smart Proxy uses the right model for each task, keeps useful context
> cached, and continues through an available provider when an account reaches its
> limits. Run one local endpoint for your AI clients, with recoverable context
> compression, bounded orchestration and visible cost and routing decisions.
- [ ] Add choose-by-task/client/provider tables, supported/limited/untested states,
  upgrade/remove instructions and troubleshooting for 429, empty credits and
  expired auth. Use original wording and only screenshots/diagrams matching the
  actual build; no borrowed savings percentages or copied reference-project prose.
- [ ] Version the new operator docs through a narrow ignore exception or explicit
  selected additions. Do not broadly unignore old plans, private archives or data.
- [ ] Verify README commands and client snippets against the build. Test a clean
  isolated install, repeat install, configuration-preserving upgrade and uninstall.
  Assert doctor distinguishes a running container from a usable provider. Re-run
  setup/docs tests and affected Compose/container smoke checks; commit.

### Task 12: Test and apply history sanitation in an independent clone

**Files:** create audit/sanitize scripts and synthetic-history tests; all refs retained in the independent publication clone; external recovery records.

**Consumes:** integrated tested source, full ref list, external recovery bundle. Produces sanitized publishable refs and an external old-to-new SHA map.

- [ ] Create an isolated Python virtual environment for git-filter-repo; record its installed version. Do not change global Python packages. Verify original backup and source file hashes before rewrite.
- [ ] Write `tests/history-cleanup.test.js` creating a temporary Git repo with a synthetic forbidden token in current/historical blobs, a filename, mixed-case commit message, annotated tag and alternate branch. Pass the token via a temporary unversioned patterns file; never encode the real removed brand into versioned tests or script defaults.
- [ ] Confirm audit finds every fixture match. Sanitize using git-filter-repo path/blob/message/ref callbacks; remove selected company-specific archived documents and sanitize retained code/docs/metadata without deleting useful history.
- [ ] Assert the synthetic repository retains useful branches/authorship/commit structure and contains no matching reachable path, blob, message or tag. Verify ignored archives outside the clone remain unchanged.
- [ ] Commit the tested generic tools, then create an independent `--no-local` clone for sanitation. Never run a history rewrite against the shared managed-worktree repository.
- [ ] Apply the patterns to every retained branch/tag/ref, including legacy auxiliary branches. Point cleaned main at the integrated result. Scan all reachable commits, raw author/committer/tag metadata, paths and blobs case-insensitively; fail publication on any match. Write commit/ref mappings only outside publishable history.
- [ ] Run cleaned-clone test/build checks again and compare its final tree to the integrated tree, allowing only intended sanitation/untracking differences. Record full changed-path manifest.
- [ ] Reconcile the cleaned result back to the intended local checkout only after rechecking every affected linked worktree for new work. Preserve ignored archives physically and prevent an old auxiliary ref from making removed history reachable again. Do not blindly overwrite another worktree's checkout or clear shared reflogs during active work.
- [ ] Keep original history solely in external recovery storage. Remove obsolete publication refs/reflogs only after checkout/ref reconciliation is proven; report any remaining nonpublication recovery objects explicitly. GitHub remains unchanged until publication is separately authorized.

### Task 13: Integrated regression, portable build and reviewable delivery

**Files:** final README/INSTRUCTIONS, package scripts, Docker/Compose, evidence report and focused end-to-end fixtures.

**Consumes:** sanitized merged source, refreshed catalog and task/orchestration implementation.

- [ ] Run complete proxy suite once after final changes: `rtk proxy npm test`. Run relevant upstream orchestrator suites and attribution checks. Summarize exit codes/counts and any baseline exceptions without claiming all-pass when exceptions remain.
- [ ] Re-run final revision-bound role/quality gates, original retrieval tests,
  account-credit fallback, offline efficiency comparisons and clean onboarding.
  Advertise only the outcomes actually observed in the final image.
- [ ] Validate package file manifest, provenance hashes and absence of credentials/runtime journals/unwanted brand text. Scan intended publication history after the last commit as well as the working tree.
- [ ] Build Docker with the embedded package. Use a unique isolated Compose project and loopback ports from an availability check; never reuse unrelated application ports or stop unrelated services.
- [ ] Run fixture-backed HTTP/WS smoke checks in the built image: task continuation, tool roundtrip, unavailable-provider fallback, same-model alternate route, distinct-model cap, helper inheritance and restart persistence. Validate orchestrator diagnostics and health endpoints.
- [ ] Run selected small account-backed listing/probe checks only on enabled routes. If supported, issue a repeated-prefix two-call cache smoke with the same task/role and inspect actual upstream cache usage. Distinguish request-prefix stability from measured cache hit and measured cost saving.
- [ ] Remove only task-created smoke resources. Keep evidence and recovery bundle. Confirm source/user changes survived, main/branch state is understood, ignored archives remain unversioned and no tracked filename/content contains removed company branding.
- [ ] Request final independent branch review appropriate to the selected execution method. Resolve substantive findings, rerun affected checks, then present clean local result, source SHAs/mappings, test/build evidence and any remaining access/cache limits.
- [ ] If the user then authorizes remote publication, re-read the remote main SHA and publish cleaned refs with `--force-with-lease` against that exact SHA. Do not push recovery refs. Verify remote heads/tags afterward. Explain that remote cached URLs or third-party clones are outside local deletion control.

## Plan self-review and handoff

Coverage: recovery/merge (Task 1), embedded package/attribution (Task 2), current
inventory/pricing evidence (Task 3), account/quota state (Task 4), persistent task
identity/model cap (Task 5), stable prefixes/cache controls (Task 6), recoverable
context reduction (Task 7), every transport/retry/helper (Task 8), scoped efficient
roles and verified reviews (Task 9), cost/quality/latency evidence (Task 10), easy
installation and presentation (Task 11), sanitized history (Task 12), final
image/regression/review/publication boundary (Task 13).

Required order: Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 →
Task 8 → Task 9 → Task 10 → Task 11 → Task 12 → Task 13. Stage boundaries are
independently testable; do not mix history rewriting with product debugging.

Recommended execution: native implementation in this chat, ordered task by task,
with one independent whole-branch review. Core tasks share ledger/adapter
interfaces and Git state; ordering avoids parallel edits to routing and Responses.
Subagent-driven execution is available if the user prefers per-task independent
implementation/review despite extra context and coordination cost.

Implementation starts after user review of this plan and execution-method
selection, as required by the writing-plans workflow. No force-push is included
in that selection.
