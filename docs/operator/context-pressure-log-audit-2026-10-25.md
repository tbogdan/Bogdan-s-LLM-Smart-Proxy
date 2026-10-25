# Context pressure: post-rollout Docker audit, 2026-10-25

Observation window: `2026-10-25T14:02:52.541298Z` through `2026-10-25T14:08:35.425017+00:00`. Read-only audit of `llm-proxy`; no provider probes, restarts, or configuration changes issued by this audit. Logs inspected repeatedly during a bounded observation, with health metrics sampled independently.

## Live observations

- 208 proxy log lines; 33 client completions (including operational polling; 17 at the first sample), 0 client transport errors, 0 aborted clients. Upstream: 18 dispatches, 2 errors, 2 retries, 7 fallbacks. Helper dispatches: 0.
- `MAX-TOK-CAP`: 7 events, including real input range 182724–186108 tokens. The 128000 output request was reduced to remaining headroom; no active-task `POST-COMPACT` events occurred.
- One OpenCode `opencode/claude-sonnet-5` disabled-model 403 attempt at 14:03:10.163Z appears as both FAIL and API-ERROR. These are two log records for one failure, not duplicate requests. Total matching FAIL attempts: 1. No repeat within this observation. No new provider dispatch occurred during the final samples, so this is not a controlled proof that a fresh task was blocked by the cooldown.
- Successful serving is explicitly recorded for `codex/codex-auto-review`; a classifier response from `Codex-gpt56luna` was HTTP 200 (2248 ms). Requested Claude aliases were served by the recorded fallback model. This does not validate all configured providers.
- Transport retained bytes: 0; pending: 0; inflight: 0. Latency p50/p95/p99: 571/10529/12857 ms. Metrics are process totals since rollout, include operational polling, and are not a controlled benchmark. The last samples added 16 completions but zero inbound request bytes/provider dispatches, so those completions are not additional LLM traffic.

## Error/recovery tags

| Tag | Count |
| --- | ---: |
| `POST-COMPACT` | 0 |
| `MAX-TOK-CAP` | 7 |
| `OUTPUT-UNUSABLE-FALLBACK` | 0 |
| `CONTEXT-UPGRADE` | 0 |
| `UPSTREAM_OUTPUT_UNUSABLE` | 0 |
| `CONTEXT_UPGRADE_UNAVAILABLE` | 0 |
| `TOOL-INVALID` | 0 |
| `overflow` | 0 |
| `status=409` | 0 |
| `status=422` | 0 |

## Limits of proof

Real high-input traffic exercised output reservation without futile compaction. No context overflow occurred, so the absence of `CONTEXT-UPGRADE` does not independently prove a live larger-context transition. The deterministic context-upgrade fixtures cover unchanged messages/tools, larger compatible model selection, budget bounds, and terminal exhaustion. Likewise no unusable-prelude recovery occurred during this window; its policy is covered by focused regression tests. Client completion counters are not semantic answer-validity evidence; consult the separate actual Claude CLI validation for final-answer/tool execution proof. No raw bodies, prompts, credentials, request identifiers, or message previews are included here.

## Follow-up: host contention and routing delay (14:25–14:28 UTC)

Parent observed `/health` at 7.723 s following a 5 s timeout, while a 908k-character request paused 25.846 s between the hidden-read-loop log (14:25:32.021) and routing (14:25:57.867). Subsequent read-only samples returned health 200 in 0.631, 0.394 and 0.347 s. Docker sample: proxy 36.95% CPU, Neo4j 40.28%; host VM process 246.9% CPU and WindowServer 91.5%. Host swap usage was 60406 MiB of 61440 MiB; memory_pressure reported 25% free. Cumulative swap counters do not measure swap activity specifically during the pause.

A later request on the same main-model path, with input increasing from 187073 to 188740 estimated tokens, took only 0.793 s from hidden-read-loop (14:27:25.201) to Route (14:27:25.994), then 0.123 s to MAX-TOK-CAP. This roughly 33-fold variation supports contention/cold-work as a contributor. It does not isolate the cause: no event-loop CPU profile or per-stage timings were captured. `lib/compaction.js:122` estimates tokens using synchronous character counts, not an expensive model tokenizer; repeated synchronous traversal/normalization elsewhere remains possible.

The large request completed upstream tool normalization and fallback successfully at 14:26:40.433. A later main request completed at 14:27:32.748. No provider probes/restarts or code changes were made by this investigation. Exact remaining risk: large-context preprocessing can temporarily delay health and unrelated requests on the shared Node event loop under host pressure; this latency issue is not proven fixed by the context/fallback changes. A controlled per-stage/event-loop profile under stable host conditions is needed before attributing the 26 s pause to code or declaring the latency goal met.

OpenCode disabled403 was attempted again at 14:26:48 after the earlier 14:03:10 attempt (well beyond the five-minute cooldown). The next classifier request at 14:27:17 used Codex directly, consistent with the cooldown; this is not repeated probing within its validity window.
