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
