# Performance hardening — local validation, 2026-10-25

Status: seven tasks implemented and independently reviewed; final error-body ownership correction independently approved. Local affected containers updated and live acceptance passed. No commit or push.

## Regression and benchmark evidence

- Final suite: 1262 tests, 1261 passed, 0 failed, 1 skipped. Focused final correction: 110/110. Core smoke passed.
- Authoritative synthetic fixture baseline: task-1-baseline-v2.json. After: task-7-after.json. Both 200/200 requests successful; all unchanged regression gates passed.
- Latency fixture p95: 55.873 → 31.324 ms; throughput fixture: 137.208 → 539.463 requests/s. These are local synthetic fixtures, not remote-provider throughput guarantees.
- Streaming p99 increased 44.734 → 52.072 ms (+16.4%), within preset gate. No reruns to select favorable timings.
- Endpoint RSS/heap growth observations are not peak-memory or long-duration leak proof.

## Local rollout

New llm-proxy image: sha256:5a6b5cc42675dec1c93218fb99865660ae7f694b1a9e9a1798233779f30a64b4. Runtime source hashes matched before rollout.
Codex image retained: sha256:280fa475d76f52a30858740eea42643e7218ffd724aff08fa8d45a94159d5527.
Both affected containers recreated and running. /health and /metrics returned HTTP 200.
Effective Docker controls: llm-proxy 2 GiB / 2 CPUs / 256 PIDs; codex-proxy 1 GiB / 1 CPU / 256 PIDs. Graphiti and Neo4j container IDs/start times unchanged. Rollback image tags and private configuration backup retained.

## Live acceptance after rollout

| Model | Verification | Observed time |
|---|---|---|
| codex/gpt-6-luna | Exact text, valid JSON SSE with terminal event, valid read arguments, exact tool result; actual requested route | 1.06–1.64 s/request |
| antigravity/antigravity-preview-latest | Same four checks, actual requested route | 9.26–12.47 s/request |
| codex/gpt-5.6-luna | Real Codex CLI through Responses API; shell command completed exit 0, exact PERF_PROXY_918 answer | 6.658 s complete tool loop |

Eight matrix requests plus two real CLI inference requests produced exactly ten provider dispatches. Zero helper/ancillary dispatches, retries, fallbacks, errors or cancels. Both matrix tool loops recorded exactly two attempts/two observed dispatches. Twelve client completions include non-inference discovery requests; not twelve model calls.
After completion: client inflight=0; transport active/pending/inflight/nativeActive/retainedBytes=0. RSS 137244672 bytes; heapUsed 37981800 bytes.
Log audit: 2026-10-25T03:51:30.195149+00:00 through 03:54:32.466015+00:00, 95 proxy lines and 7 Codex lines, no error/failed/invalid/incompatible/exception/unhandled matches. Successful protocol checks supplement this bounded keyword audit; not a promise about future logs.

## Provider and resource limits

OpenCode FREE remains subject to previously verified shared FreeUsageLimitError/429, reset 2026-10-26 00:00 UTC. No repeated quota probes or paid substitutions. NVIDIA previously returned authorization 403 or retired-model 410. Neither is claimed newly successful; see provider-validation-2026-10-25.md.
Codex matrix tool prompts used 343 then 378 input tokens. Antigravity tool loop reported 9354 cumulative input tokens. Real Codex CLI reported 22751 input tokens over its turn: native client instructions/tool schemas remain substantial. Zero duplicate dispatches does not mean zero context overhead.
Authoritative virtual agent/thread registries remain outside generic TTL eviction to preserve follow-up correctness. Docker hard limits bound container memory but can cause OOM if that long-lived state grows; this is not a whole-process memory-bound proof.

## Evidence and decisions

Artifacts: .superpowers/sdd/2026-10-25-performance-hardening/ (progress.md contains all controller rulings; final-rereview.md, final-fix-full-tests.log, task-7-after.json, docker-after.json, live-log-audit.json, metrics-before-live.json, metrics-after-live.json, live-validation/verified-summary.json and cli-events.jsonl).
Plan: docs/superpowers/plans/2026-10-25-performance-hardening.md.
Branch codex/performance-hardening and existing workspace retained unchanged in integration status. No merge, commit, push or cleanup authorized/performed.

## Security hook follow-up

Shared streaming upstream error no longer embeds payload in Error.message. Bounded raw body/headers are private nonenumerable recovery metadata; public/log diagnostic categories are fixed strings. Independent controller review of incremental runtime diff completed. Full suite1264 pass/0fail/1skip; final focused85/85 after final defensive adjustments. Updated llm-proxy image sha256:247a673daf0145ac8fb35feac65028fda551da3b4995ed3d259383b19312d9e7 verified against runtime source hashes and recreated. Live actual Codex shell tool loop:7.049s, exact SECURITY_PROXY_724,2dispatches,0retry/fallback/error,retainedBytes0. Bounded postrollout log audit clean. Evidence: .superpowers/sdd/2026-10-25-performance-hardening/security-error-fix.md and security-live/. This addresses flagged shared streaming path; unrelated buffered/adapters are not claimed globally sanitized.
