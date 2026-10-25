# Claude Code final-response timeout — validation 2026-10-25

## Fixed causes

1. A requested terminal `DONE` after a completed Bash tool was treated as stalled because it is shorter than five characters. The proxy returned 409 `hidden continuation: heuristic_stall`; Claude Code retried repeatedly. A narrow completion rule now accepts the exact requested marker after matched completed tool history, retaining required-tool, active-task, working-status and failed-tool guards. Native Claude reminder/hook envelopes are excluded only from local terminal-intent lookup; model and safety-classifier payloads remain unchanged.
2. Anthropic gateway accumulated streamed tool argument fragments and then appended the full final snapshot again. Final snapshots now replace accumulated arguments, correlated by stable call ID. True incremental repeated fragments remain intact.
3. The exact typed OpenCode `403 api_error: Upstream request failed: Model access is disabled` envelope stopped a Sonnet request before configured model fallback. It now counts as a route capability mismatch. Generic authorization/policy 403 remains terminal; explicit native-only/free OpenCode restrictions remain enforced with zero upstream dispatch in their regression fixture.
4. Native tool failure flags must remain linked through gateway conversion, trusted routing options, external body sanitization and tool ID normalization. Internal failed-call IDs now survive that chain, are remapped with tool results, and are stripped from upstream requests. Untrusted body metadata remains stripped.

## Regression and review

Final full suite: 1290 total, 1289 passed, zero failed, one skipped, 65.65 seconds. Core smoke and diff checks passed. Independent review covered the complete bridge, including failed-tool ID remapping and native reminder/hook handling. Actual local HTTP fixtures verify completed terminal response on one dispatch, failed native tools do not acquire the new completion exemption, duplicate snapshot handling, known-model 403 fallback and unchanged general/native-only 403 restrictions.

The first live replay still failed because its real user turn included native reminder and SessionStart hook context; the failing evidence was retained before the final envelope correction. Later live results below use the corrected image, not a selected timing rerun of the original implementation.

## Live Claude Code acceptance

Claude Code 2.1.310, auto mode enabled, classifier `codex/gpt-5.6-luna`, client-side safety requests through localhost proxy. Each temporary session performed an explicitly authorized Bash/Python file write and requested final `DONE`. MCP servers were isolated with the CLI's strict empty MCP config; normal user settings and safety classification remained active.

| Requested conversation model | Whole CLI session | Result | Classifier times |
|---|---:|---|---|
| codex/gpt-6-luna | 20.081 s | exit 0, correct file, exact DONE | 2.346 s |
| codex/gpt-5.6-luna | 22.647 s | exit 0, correct file, exact DONE | 5.565 s and 1.927 s; two legitimate Bash checks |
| claude-sonnet-5-5 | 15.509 s | exit 0, correct file, exact DONE via configured fallback | 3.854 s |

No client API errors in these three completed sessions. The first isolated snapshot recorded exactly three provider dispatches: initial model response, safety classifier, and final model response; zero retries/errors/helpers. Concurrent organic traffic appeared later, so global later counters are not attributed exclusively to the test harness. See final-timeout-log-audit-2026-10-25.md for bounded log attribution.

## Rollout and limits

Only llm-proxy was recreated. Final runtime source hashes match checked local sources. Effective memory/CPU limits remain 2 GiB/2 CPUs/256 PIDs. Codex proxy, Graphiti and Neo4j container IDs remain unchanged. Health and metrics returned 200; transport active, pending, inflight, nativeActive and retainedBytes returned to zero at idle. Rollback image rebuilt from the prior committed source because Docker no longer retained the running image in its image cache.

The earlier 16509-frame response overflow is not causally attributed to the gateway snapshot bug: it happened before downstream headers. Response/memory limits were preserved. The same model completed the bounded live tool/classifier session above without overflow after rollout; this proves that scenario works, not that arbitrary future model generation cannot hit a resource cap.

Artifacts: .superpowers/sdd/2026-10-25-final-timeout-fix/ includes full-tests-envelope.log, build/rollout logs, sanitized before events, source/container/metrics evidence and each live session's verified JSON summary. Raw test client debug logs remain only in private temporary test directories.

Final local image: `sha256:dc4874bbc7d089541828e5ad2a61cba752763f7a895a0604383ecd9bf2c97df1`.
