# Proxy and orchestrator unification

Date: 2026-10-15, Europe/Bucharest
Status: original design approved on 2026-10-15; revision 2 incorporates the user's
Headroom, agents-library, efficiency, account-fallback and onboarding requests.
Revision 2 and the amended implementation plan await consolidated review.
Product implementation has not started.

## Intended outcome

Unify the local proxy and its GitHub variant, remove the former company branding
from everything versioned including retained history, bundle llm-orchestrator,
refresh model and pricing evidence, and keep model selection stable throughout
each task to improve upstream prompt-cache reuse.

Primary objective: reduce total cost per successfully completed task while
preserving correctness, required capabilities and review floors. Token reduction
is one mechanism, not the success criterion. Include retries, reasoning, helper
calls, retrieval, compression overhead, latency and subscription consumption.

User requirements:

- Preserve useful work from both divergent proxy histories, favoring the current
  implementation where it supersedes the older implementation.
- Unversioned, ignored local archives may retain former branding.
- Select an appropriate LLM when a new task starts. Do not rescore ordinary
  continuations into a different LLM.
- Use at most three distinct LLMs across a task, including orchestration helpers.
- Bundle the local llm-orchestrator and its dependencies in a portable build.
- Reuse and adapt its routing, orchestration, discovery, and verification logic.
- Refresh model identifiers, capabilities, pricing and cache costs from evidence.
- Use Headroom as a source of cache-aware and recoverable context optimization.
- Use agents-library as inspiration for focused roles, verified findings,
  bounded review loops and clear completion evidence; fill gaps rather than
  duplicate the embedded orchestrator's existing roles and permissions.
- Rewrite the product presentation around measurable benefits and make initial
  installation, diagnosis, upgrades and removal straightforward.

## Verified starting state

- Proxy checkout: `/Users/bogdan/PhpstormProjects/llm-proxy-docker`.
- Local main: `733d5b3c328b91e1c2579cc2eb4a0f41e7b7657e`.
- GitHub main, read directly with ls-remote:
  `c187a42fd3c5f4d3b662a2b926ac0a07df137918`.
- Common ancestor: `b9b83ef4567a0c027db6611e8903e145f327d631`.
- 80 local-only and 54 remote-only commits, also after exact patch-equivalence
  filtering. Commit dates alone cannot select the correct implementation.
- Merge-tree audit reports 29 conflicted paths. No merge was applied to main.
- Local routing, Responses bridge and transforms contain substantially more code;
  all named top-level remote functions in the sampled core modules also exist
  locally. This supports a local baseline but does not prove semantic inclusion.
- Ten tracked files are modified, including an ignored-but-tracked archived spec.
  `.serena/` is untracked. These changes must be preserved before integration.
- Two currently tracked archived documents retain the former branding in paths.
  Across all current refs, 281 of 993 scanned unique historical blobs match the
  former branding; five commit messages match. Current ref names do not match.
- Runtime provider data contains 245 providers; newest recorded probe is
  2026-06-28. Existing discovery contains 274 model records. These are stale
  evidence, not a current availability guarantee.
- No llm-named container was found in the active Docker context.
- Existing `lib/memory/index.js:getSession(messages)` keys memory sessions from
  system content. Do not use that hash alone as a task/conversation identity:
  independent conversations can have identical system prompts.
- Orchestrator source: `/Users/bogdan/PhpstormProjects/llm_orchestrator`, main
  `834089e`, package version 1.4.0, Node >=22, ESM, CC BY 4.0.
  Its package declares no external npm dependencies; inspected lib/bin imports
  use Node built-ins and local modules. MCP servers and CLIs in its capability
  registry are external integrations, not npm runtime dependencies.

## Approaches

1. Recommended: local proxy baseline, three-way semantic reconciliation with
   remote, pinned embedded orchestrator package and a proxy adapter. Retains
   local protocol compatibility while recovering remote-only behavior.
2. Remote baseline with local features ported back: possible, but substantially
   more risk of dropping local routing and Responses behavior.
3. Fresh snapshot with no prior history: quickest brand removal, but discards
   useful history. Not selected; retain and sanitize history instead.

## Git integration and history cleanup

1. Save a recoverable Git bundle plus the exact tracked working diff and relevant
   untracked files outside publishable refs. Preserve local ignored runtime data
   and credentials without copying credentials into version control.
2. Use an isolated managed checkout for reconciliation. Record both source SHAs.
   Keep the existing working directory and other linked worktrees recoverable.
3. Reconcile all conflicting paths by behavior, using the local runtime as the
   starting point. Compare remote tests, scripts, provider catalog, documentation
   and deploy changes individually. A newer timestamp is not a blanket overwrite.
   Apply the saved local working changes after resolving committed divergence.
4. Keep historical local archives ignored and remove them from the current index
   where appropriate. `.gitignore` alone does not untrack files.
5. Rewrite the integrated publication history and every retained publication
   branch/tag: sanitize matching blob contents, paths and commit/tag metadata;
   remove archived company-specific plans/specs from that history. Preserve
   meaningful commit structure and author credit. Check identities separately if
   a matching company domain appears in author/committer fields.
6. Scan every commit, tree path, blob, ref name and annotated tag reachable from
   the intended publishable refs, case-insensitively. Scan the packaged build
   contents too. Commit IDs change after rewriting. Keep recovery copies outside
   those refs, never as a backup branch accidentally pushed to GitHub.
7. Review the final clean repository and verification report before replacing
   remote history. Remote publication requires a separate concrete final review;
   use an expected remote SHA to avoid overwriting intervening work.

Old GitHub cached commit URLs, hidden pull-request refs and other people's clones
are outside a local history rewrite. Report that boundary explicitly if remote
publication is requested; do not claim worldwide deletion.

## Task identity and stable model allocation

Approved task identity and failure behavior:

- Accept an explicit task ID and parent task ID as proxy metadata/headers; strip
  internal metadata before upstream dispatch. Derive scope from authenticated
  client/workspace/conversation identity so different clients cannot share state.
- Without an explicit ID, keep one task per identified conversation until an
  explicit task reset. Do not assume every user message starts a new task.
  If stable identity cannot be established, expose the limitation and return a
  task handle rather than claiming cross-request stickiness.
- A task begins with classification and allocation using current discovered
  capabilities, cost, context needs and the orchestrator tier/thinking rules.
- First filter candidates by actual availability, client protocol, tools, context,
  effort support and required quality/review floor. Among eligible candidates,
  consider total expected completion cost, observed reliability and latency.
  Rank by measured evidence when available; do not manufacture quality scores or
  assume the cheapest per-token model completes the task most cheaply.
- Allocate one primary model by default. Allow at most two additional distinct
  models for specialist work, an independent review, or justified fallback.
  Do not eagerly use three models when one is sufficient.
- Fix provider/account/endpoint/model and reasoning configuration per role.
  Pin resolved upstream IDs where available; a mutable alias is weaker evidence.
- Every continuation and tool-result roundtrip keeps its role allocation despite
  price changes, score changes, discovery refreshes, or another model becoming
  faster. A new task receives a fresh allocation.
- Failure policy: bounded retry/backoff on the pinned route, then search for the
  same model through another eligible provider/account endpoint, or a similar
  model from the same or another provider. Require equivalent task capabilities,
  context, supported effort and required review floor. Record why fallback was
  needed and the actual provider/model. This is core proxy behavior, not an error
  to suppress merely for cache preservation.
- Track distinct canonical LLMs actually attempted across the task, atomically.
  A genuinely equivalent model through a different provider does not consume an
  additional model slot, although it loses provider-local cache affinity. Admit
  a different model only while fewer than three distinct models have been used;
  never reset this ledger on failover, compaction, restart or child-agent dispatch.
- A demonstrated capability mismatch can trigger the same bounded fallback.
  A more suitable cheaper or stronger choice for a new task is selected when
  that task starts. Score fluctuations alone never justify switching mid-task.
  If three models have already been used and none can serve the request, return
  a structured exhausted-budget error; do not silently create another task.
- Account exhaustion is a distinct availability condition. Key quota state by
  provider, configured billing account and quota bucket, not by display model
  name or rotating access token. Block all routes sharing a proven exhausted
  bucket; do not disable unrelated accounts or the entire provider family.
- Prefer another available configured account serving the pinned canonical model
  before changing model. Honor provider reset times and Retry-After when known.
  Distinguish transient rate limits, depleted credits, expired credentials,
  entitlement failures and transport errors. A generic timeout is not credit
  exhaustion. Do not repeatedly probe an empty account or clear its circuit just
  to satisfy fallback. Re-enable only after reset, refreshed positive evidence,
  or an explicit operator action; unknown balances remain unknown.
- Context overflow triggers compaction or a clear context-limit response; it
  does not silently escape to another model outside the task group.
- Concurrent requests reserve models atomically; task state survives restart.
  Parent/child agents share the parent's three-model budget. State has bounded
  retention; eviction of an active task must not silently create a new allocation.

The three-model ceiling includes model-backed classification, summaries, memory
helpers and review. Prefer deterministic assessment where possible. Embedding
computation is tracked separately and must not hide additional generative calls.

## Cache behavior

- Preserve stable system/developer prefix, tool definitions and order, provider
  session IDs, model and reasoning settings across a role's task continuation.
- Append changing context after the reusable prefix where protocol semantics
  permit. Never move required instructions behind user-controlled content merely
  for cache savings. Preserve tool-call/result order and trust boundaries.
- Freeze reusable instruction/memory snapshots per task or role. Add subsequent
  updates after that prefix instead of rewriting its beginning every turn.
- Freeze only proxy-owned reusable content. Always honor legitimate incoming
  instruction/schema changes, even when doing so invalidates a cache. Never
  replace new client instructions with an old cached version for savings.
- Pass cache controls only to adapters/models that support them. Preserve caller
  choices; apply documented defaults when absent. Keep a stable scoped cache key.
- Compaction is deliberate and observable, since rewriting history invalidates
  cache prefixes. Separate session state from the compacted request payload.
- Report upstream cache-read/cache-write usage when returned. Distinguish a
  cache-friendly request from a provider-confirmed cache hit; test savings using
  real usage evidence rather than assuming them from model stickiness.

## Headroom-inspired context efficiency

Source reviewed: headroomlabs-ai/headroom, revision
`76133cff59b71284399bf760c5578dc373c97231`, observed 2026-10-15.

- Default to preserving previously transmitted content and optimizing only newly
  added tool data. Reapply the identical prior transformed representation when
  a client resends raw history. Version transformation rules per task; a refresh
  must not recompress a warm prefix differently. First measure prefix drift.
- Select compression by data kind: repeated log lines, large JSON/tabular tool
  outputs, search results or other proven-redundant tool data. Preserve task
  instructions, constraints, errors/outliers needed for diagnosis, exact-edit
  source/diffs, complete Git status, signed reasoning and opaque/multimodal data.
  Small or uncertain inputs pass through. Do not retain only a 100-character
  preview and claim that task-critical information survived.
- Persist exact originals before replacing model-visible data. Use scoped
  full-content SHA-256 plus transformation version, not first/last-character
  fingerprints. Scope retrieval authorization independently from content hashes.
- Offer bounded retrieval with ranges/filters through a protocol-supported tool
  or existing trusted tool bridge. Define its schema at task start for cache
  stability. Never compress data into an inaccessible reference when retrieval
  is unavailable, storage failed, or the client cannot support the tool flow.
- Persist referenced originals across restart and pin them while a live task
  depends on them. If storage is full, pass new data through rather than evict
  active backing data. Retrieval results are exempt from recursive compression.
  Deleted/changed source files do not replace the exact original snapshot.
- Make retrieval selective and bounded; charge its extra inference turns against
  the same model group, token/cost/latency budget and iteration limit. Preserve
  mixed native-client/retrieval tool-call order; never swallow a client tool call.
- Recompact older context only on actual context pressure or evidence-backed
  cache expiry with an expected net benefit. Cache TTL guesswork alone is not
  proof that rewriting a warm prefix is economical.
- Start with deterministic native Node transforms and reuse the existing proxy
  compaction pipeline. Headroom's TypeScript package is a client of its local
  HTTP compression service, not a standalone local engine. A mandatory Python,
  Rust or ML sidecar is not introduced merely by adding that npm package.
  Preserve notices for any source code actually reused; public benchmark claims
  are evidence to investigate, never promised proxy savings.
- Use supported low-verbosity controls or a stable startup instruction for prose;
  never truncate generated code/JSON or final answers after generation. Keep
  reasoning effort pinned per role by default. Per-turn effort reduction is
  experimental and may only be enabled after provider-specific cache/quality
  validation; a clean tool result alone does not prove low reasoning is adequate.

Reference patterns: [context management](https://docs.headroomlabs.ai/docs/context-management),
[recoverable originals](https://docs.headroomlabs.ai/docs/ccr),
[cache drift](https://docs.headroomlabs.ai/docs/cache-optimization).

## Embedded orchestration

- Vendor a pinned, attributed distribution of llm-orchestrator under
  `vendor/llm-orchestrator/`, including package metadata, LICENSE, NOTICE,
  lib/bin, registries, schemas, models, policies, workflows and referenced
  resources. Exclude its nested Git repository, local runtime state and fixtures
  not needed by the packaged distribution. Record source SHA and file hashes.
- Use a narrow CommonJS-to-ESM adapter rather than copying router algorithms into
  proxy code. Keep Docker builds independent of sibling host paths.
- Reuse classify/rank/thinking selection, inventory validation and flow/gate
  contracts. Constrain every phase/shard dispatch to the task's admitted model
  group and three-model lifetime limit, admitting new members only for the
  justified specialist/review/failure/capability cases described above.
  Preserve independent-review requirements; do not label self-review independent.
- Map harness/tool discovery to the tools actually exposed by the requesting
  client and existing proxy adapters. Disk presence is not callability.
- Include integration configuration and clear unavailable/degraded states for
  external MCP/CLI dependencies. Do not bundle user accounts or treat unsupported
  shell/MCP capabilities as callable tools.
- Connect orchestration to the proxy's existing virtual-agent/Responses support.
  Preserve native client tools where available. Expose a read-only diagnostics
  view with bundle revision, capabilities, inventory and task allocation reasons.

## Agents-library-inspired role and review discipline

Source reviewed: cleanunicorn/agents-library, revision
`41f66278c97eea3d2466fc39565835df5a186d5f`, observed 2026-10-15.

- Reuse existing orchestrator charters, read/write profiles and review floors.
  Select only roles relevant to the task; do not spawn every advertised reviewer
  or a management hierarchy for a simple passthrough request. Agent count and
  distinct-model count are separate budgets; three models is not a target.
- Each dispatched role gets one bounded objective, acceptance criteria, allowed
  files/tools, token/cost/iteration limits and a structured result contract.
  Share a compact task brief with retrievable backing evidence rather than the
  entire transcript. Keep current task and hard constraints verbatim.
- Assign one writer to each overlapping file set. Reviewers are read-only in
  enforced dispatch permissions where the client supports enforcement. A prompt
  alone is not a sandbox. Parallelize only disjoint work with a concrete benefit.
- Validate findings against actual code/evidence before automatically fixing
  them. Track confirmed/refuted/uncertain outcomes, deduplicate repeated findings,
  and keep failed verification visible. Recheck fixes at the final tree revision;
  a passing gate on an old SHA is not proof for new work.
- Limit repair/review loops and stop repeated non-improving attempts. Keep
  independent review where the risk floor requires it; do not turn every empty
  finding list into another paid review. Extend a fix to equivalent affected
  protocol paths within the task scope instead of initiating unrelated cleanup.
- Test role dispatch and workflow behavior with synthetic scenarios and an
  optional bounded model-backed comparison with/without the extra role context.
  Retire redundant prompt/role machinery if it adds cost without quality benefit.
- The reviewed agents-library tree has no explicit repository LICENSE file and
  GitHub reports no license. Adopt concepts through original implementation;
  do not vendor its prompts, scripts or plugin. Do not install its global agents,
  scheduled sweeps, automatic PR flows or UI-specialist fleet as dependencies.

Reference patterns: [verified review](https://github.com/cleanunicorn/agents-library/blob/41f66278c97eea3d2466fc39565835df5a186d5f/skills/review-pr/SKILL.md),
[workflow evals](https://github.com/cleanunicorn/agents-library/blob/41f66278c97eea3d2466fc39565835df5a186d5f/docs/evals.md).

## Measured efficiency and rollout

- Compare passthrough, current proxy, cache-stable routing, and routing plus
  compression on the same representative tasks. First run deterministic offline
  protocol/content-retention tests; use bounded paired live runs for actual
  completion quality, cache behavior and billed usage. Replay alone cannot prove
  that compressed context leads to equally correct model answers.
- Track total input/output/reasoning/cache tokens, account credits when exposed,
  retry and retrieval calls, p50/p95 completion latency, task completion rate,
  correctness/repair outcomes and total cost per successful task. Record unknown
  usage and uncertainty. Separate estimated avoided cost from observed billing.
- Enable each optimization only after invariant and quality gates pass; preserve
  a task-pinned passthrough switch. Savings are workload-specific; no fixed
  percentage or quality parity claim without a reproducible measured report.

## Presentation and easy installation

- Lead README with the product purpose: use the right model, preserve useful
  cache, reduce repeated context and continue when an account hits its limits.
  Follow with one quick start, choose-by-task/client tables, an architecture
  diagram, measured evidence, limits and links to detailed operator docs.
- Move old benchmark claims out of the headline into dated historical evidence.
  Present new measurements with model/source versions and reproducible commands;
  never borrow either reference project's savings numbers or imply their runtime
  capabilities are already implemented here.
- Keep `./setup.sh` as the primary install entrypoint. Check Docker engine and
  Compose, preserve existing configuration, use configured/free loopback ports,
  build/start the bundled runtime, and print actual detected URLs.
- New installs should not require host Node/Python or every provider account.
  Start with one configured route; make optional memory/provider services clear
  profiles, preserving existing deployments' selected features. Guide necessary
  provider login through the existing supported auth flow; never claim success
  from the mere presence of a key. No automatic purchases or account creation.
- Add read-only `./setup.sh doctor`, dry-run and non-interactive operation,
  explicit client setup, config backup/restoration and safe uninstall. Re-running
  setup must not wipe provider keys or rewrite unrelated client settings. Removal
  preserves credentials/data unless an explicitly named purge is requested.
- Verify the documented path in a clean isolated environment: fresh install,
  repeat install, occupied port, Docker unavailable, missing/expired auth,
  exhausted account, configured provider with no accessible models, upgrade and
  removal. Distinguish infrastructure health, configured access, listed models
  and successful inference; live paid probes are explicit and bounded.

Expected new boundaries: `lib/task-routing.js` for task identities/allocations,
`lib/orchestrator-bridge.js` for the embedded ESM package and policy adaptation,
and focused discovery/pricing helpers. Keep transport and protocol dispatch in
the existing adapters; avoid adding another independent routing engine.

## Model and pricing refresh

- Keep model availability, pricing and measured quality as separate evidence.
  A public catalog does not prove account access. A price does not prove quality.
- Retrieve each configured provider's supported read-only model inventory where
  available. Retain exact IDs, source URL/endpoint, observation time, effort
  controls, context limits and evidence status: configured/exposed/verified.
- Refresh official input/output/cache-read/cache-write rates, token thresholds,
  service tiers, time-limited promotions, and subscription credit multipliers.
  Do not mix direct API USD pricing with subscription or reseller billing.
- Record unknowns as unknown, never free/zero or invented benchmark scores.
  Retain prior evidence as stale history and report failed refreshes.
- Never start by invoking the current full discovery daemon: its scan probes
  seeded models and may run context/thinking tests. Add/read a bounded listing
  path first; use small selected inference probes only for validation.
- Refresh proxy seed metadata and embedded model registry coherently. New models
  with unverified quality remain available-but-unrated until admission evidence
  exists. Keep explicit model selection possible within capability constraints.
- Active task allocations remain stable during inventory/price updates. Apply
  newer registry revisions when a new task starts.

Official sources already inspected on 2026-10-15:

- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://docs.github.com/en/copilot/reference/ai-models/supported-models
- https://docs.devin.ai/desktop/models (redirect from former Windsurf docs)

These sources already show changes beyond the local runtime catalog, including
GPT-6.1 Sol and Claude Haiku 5.5. Full per-provider refresh remains implementation
work; this audit has not updated seed/runtime files or claimed account access.

## Verification and acceptance

- Run and retain both source baselines before reconciliation; distinguish
  pre-existing failures from regressions. Test the integrated result.
- Use regression-first tests for task persistence across turns, tool calls,
  streaming/Responses/Anthropic paths, concurrent requests and restart.
- Prove new task reallocation, scoped task identity, fixed model/effort/provider,
  bounded failure policy, and the three-model cap including internal helpers.
- Check model-unavailable, 429/timeouts, context overflow, changed tool schemas,
  partial streams, exhausted allocations and stale/missing discovery evidence.
- Check account-wide empty credits, bucket-scoped limits, Retry-After/reset,
  expired-token refresh, unknown balances and independent healthy accounts.
- Prove original-data retrieval, active retention, transformation stability,
  full-content hashing and protocol-safe mixed tool calls. Keep a passthrough
  control and exercise role-selection/review behavior, not just schema validation.
- Verify the clean install and doctor path and base presentation claims on the
  actual final build and measured efficiency report.
- Prove task pins prevent scoring from selecting a fourth model on every retry
  and escalation path. Never replay tool side effects after a partial response.
- Test stable prompt prefixes and adapter-supported cache fields. Run a bounded
  live cache check only where credentials and upstream usage evidence permit.
- Run proxy tests, relevant embedded orchestrator tests, attribution checks,
  package-content checks, Docker build and isolated smoke requests.
- Verify no host-relative orchestrator dependency, credentials, runtime journals,
  obsolete company branding or nested repository enters publishable contents.
- Scan all retained publishable history after rewriting. Record source-to-clean
  SHA mapping outside the publication history and prove working changes survived.
- Report configured, tested, live-verified and still-unverified separately.

## Review checkpoint

Original task-boundary/failure-policy choices remain approved. Revision 2 adds
the user's reference-project and onboarding requirements. Review the amended
file-level plan, then preserve/reconcile, bundle/adapt the orchestrator, refresh
evidence, implement account-aware task routing and recoverable context reduction,
verify role efficiency, improve onboarding/presentation, sanitize final history
and review delivery. The final rewrite happens after the product work to avoid
rewriting the same history repeatedly. Original request remains open until those
phases are complete.
