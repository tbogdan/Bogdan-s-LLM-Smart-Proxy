# Reference projects: useful patterns and proxy gaps

Observed: 2026-10-15. Scope: research and design/plan revision only. No reference
plugin was installed and no proxy runtime code was changed by this revision.

## Product target

Reduce total cost per successfully completed task while keeping correctness,
compatible tools/protocols, appropriate independent review and reliable fallback
when an account reaches a rate/credit limit. Count helper/retrieval/retry overhead
and account credits as well as prompt tokens. Make installation and presentation
clear enough that a user can reach one working route without reading the internals.

## Sources inspected

- [Headroom](https://github.com/headroomlabs-ai/headroom), source revision
  `76133cff59b71284399bf760c5578dc373c97231`, Apache-2.0 repository license.
- [Headroom incremental context](https://docs.headroomlabs.ai/docs/context-management),
  [cache diagnostics](https://docs.headroomlabs.ai/docs/cache-optimization),
  [original retrieval](https://docs.headroomlabs.ai/docs/ccr),
  [shared agent context](https://docs.headroomlabs.ai/docs/shared-context),
  [measurement](https://docs.headroomlabs.ai/docs/benchmarks).
- [Headroom TypeScript service client](https://github.com/headroomlabs-ai/headroom/blob/76133cff59b71284399bf760c5578dc373c97231/sdk/typescript/src/client.ts).
  Its `compress` implementation calls `/v1/compress`; installing the SDK alone
  does not embed the Python/Rust compression implementation in the proxy.
- [Agents Library](https://github.com/cleanunicorn/agents-library), revision
  `41f66278c97eea3d2466fc39565835df5a186d5f`.
- [Independent review verification](https://github.com/cleanunicorn/agents-library/blob/41f66278c97eea3d2466fc39565835df5a186d5f/skills/review-pr/SKILL.md),
  [revision-bound coordinator evidence](https://github.com/cleanunicorn/agents-library/blob/41f66278c97eea3d2466fc39565835df5a186d5f/skills/manager/references/coordinator-brief.md),
  [workflow evals](https://github.com/cleanunicorn/agents-library/blob/41f66278c97eea3d2466fc39565835df5a186d5f/docs/evals.md).

Reference repository instructions were read as research material, not installed
as instructions governing this chat. Neither their large reviewer fan-outs nor
their global installation/scheduling flows are requirements for this product.

## Current state versus useful additions

| Area | Local evidence | Adaptation | Acceptance |
| --- | --- | --- | --- |
| Task continuity | `lib/routing.js` has a scoring affinity bonus; no stable per-task model ledger | Pin role/model/account; switch only for justified availability/capability events | Same task stays pinned; fresh task can choose another tier; lifetime maximum three LLMs |
| Cache-friendly context | `lib/compaction.js` caches transformations but may reduce data to short previews | Incremental transforms, immutable replay of prior transmitted representations | Warm prefix stays stable under new tool data and optimizer config refresh |
| Original recovery | Current preview/truncation paths do not establish a task-scoped recoverable-original contract | Durable original snapshots plus a bounded accessible retrieval tool | Exact bytes recover after restart; no inaccessible or cross-task references |
| Content identity | `contentHash` samples first/last 200 characters and length; `msgHash` also samples ends | Full-content digest, transform version and authorization scope | Different middle content never returns another payload's original |
| Account fallback | Existing quota/cooldown helpers use provider/model names and several fixed one-hour cooldown rules | Normalize failure cause and real account/bucket/reset evidence | Exhausted account excluded across its models; unrelated healthy account remains eligible |
| Role quality | Orchestrator already has charters, RO/RW profiles and risk floors | Reuse them; add compact briefs, cost limits and selected relevant review domains | No duplicate role fleet; independent review where needed; one writer per overlap |
| Findings and gates | Orchestrator has dispatch/evidence contracts, not yet adapted to proxy sessions | Validate findings; bind gate evidence to current revision and bounded fix loops | False positive is not auto-fixed; edits invalidate stale review/test claims |
| Workflow overhead | No audited proxy-level comparison proves every helper/agent improves efficiency | Original synthetic evals plus bounded with/without role-context runs | Remove redundant context/dispatch when quality is unchanged and cost rises |
| Savings claims | README leads into a dated May benchmark using older models | Fresh matched controls; report correctness, all calls, measured versus estimated cost | No borrowed savings number or quality claim without a reproducible report |
| Setup safety | `setup.sh` preserves `.env` initially but later removes many memory/provider settings | Idempotent versioned migrations and read-only doctor | Customized configuration survives rerun and upgrade |
| Readiness | Setup calls Compose and prints a fixed `18900` URL | Detect actual ports and separate infrastructure/auth/listing/inference readiness | Running containers with no usable account are not reported as functional inference |
| Presentation | Large README mixes setup, old results and internals; existing local homepage is available | Short purpose/quick start, choose-by-task/client tables, evidence and clear limits | README commands work against final build; homepage uses matching factual copy |

## Selected adaptations

Headroom informs context handling: optimize new eligible backing data while
preserving prior wire representations, keep exact originals accessible, and
measure prefix drift. Its detector does not repair prompts. Compression cannot
guarantee answer quality merely by preserving a retrievable source; retrieval,
protocol behavior and final task correctness need their own tests.

Agents Library informs review discipline: narrow assignments, read-only reviewers,
skeptical confirmation of findings, current-revision gate evidence and bounded
iteration. The proxy does not need a ten-reviewer fan-out on every request or a
separate manager when deterministic routing suffices.

Both presentations make supported entrypoints and use cases visible early. The
new README/homepage should do the same with original copy: explain the outcome,
show one install path, then compatibility, measured evidence and limits. Detailed
configuration and historical benchmark reports belong behind those entrypoints.

## Deliberate exclusions

- No mandatory Headroom service, model download, global wrapper installation,
  external telemetry or automatic edits to AGENTS/CLAUDE files.
- No wholesale agents-library prompts/scripts/plugin import. The inspected tree
  has no explicit repository LICENSE file and GitHub reports no license; use
  concepts and original implementations. Retain notices for any licensed code
  separately reused from other sources.
- No compression of current instructions, exact-edit data, opaque signatures or
  unknown formats; no untested per-turn reasoning downgrade for nominal savings.
- No new dashboard framework, autonomous whole-repo cleanup, automatic PR merges,
  account creation, credit purchases or account rotation beyond configured access.

## Implementation mapping

Amended plan: account circuits Task 4; persistent pins Task 5; cache Task 6;
recoverable compression Task 7; transport/fallback Task 8; role discipline Task 9;
efficiency evaluation Task 10; README/homepage/install Task 11. Recovery/merge,
bundled orchestrator, current catalog, final history sanitation and delivery remain
Tasks 1–3 and 12–13. All work remains subject to consolidated plan review.
