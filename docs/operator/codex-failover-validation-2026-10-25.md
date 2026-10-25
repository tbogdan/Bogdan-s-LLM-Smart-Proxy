# Codex cross-model failover validation — 2026-10-25

Resumed Antigravity conversation `bf9f9637-62ef-4ead-9afd-840df43f7989`
("Implementare Failover Cross-Model"). Its last steps investigated native streaming
dispatch after provider substitution. Docker still contained the older dispatcher;
the working tree also had 13 failing regression tests.

## Changes

- Select streaming transport after task allocation chooses the actual provider.
  OpenAI/Codex retain the existing OpenAI stream validator.
- Translate Codex `additional_tools` and namespaced custom tools; return the
  original namespace and raw custom input. Normalize strict upstream tool names.
- Prefer client metadata over model names when identifying the host IDE.
- Return Codex `ModelsResponse` for versioned discovery, retaining ordinary
  OpenAI discovery for other callers and preserving deferred tool discovery.
- Keep custom-tool descriptions once instead of duplicating them in schemas.
- Prepare eligibility once per candidate batch. Fresh explicit primary tasks
  check their preferred model before scanning unrelated fallback accounts.
  Existing task budgets and pins still govern continuations and specialist roles.
- Reuse provider classifications within each catalog request, without stale
  cross-request caching.

Catalog schema reference:
https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs

## Live acceptance

Actual `codex exec` used the Responses endpoint at
`http://127.0.0.1:18900/v1`, temporary working directory, read-only sandbox,
ephemeral sessions, and distinct proxy task IDs. User config was not modified.
All three runs exited 0 and emitted `turn.completed`, with no error events or
client `ERROR` log entries.

| Check | Verified result | Entire CLI run |
| --- | --- | --- |
| Text | Exact `PROXY_OK_42` | 7.63 s |
| Tool round trip | `printf PROXY_TOOL_OK_42` exited 0; exact final `PROXY_TOOL_OK_42` | 18.43 s |
| Unavailable requested Claude model | Exact `CROSS_MODEL_OK_42`, served through Codex fallback | 13.66 s |

After the final container rebuild, another real Codex run returned exactly
`FINAL_CONTAINER_OK_42` in 4.98 s, exit 0 and `turn.completed`, without client
errors. SHA-256 checks confirmed that all seven changed runtime files match
the running container. The CLI emitted a local rollout-database warning, which
did not affect the response and is unrelated to proxy compatibility.

Times include CLI startup and tool execution; they are observations, not latency
guarantees. Other Claude sessions concurrently used the proxy. Provider quotas
and network failures remain possible.

The acceptance log window contained no unsupported streaming protocol, unknown
input item, API compatibility, or stream compatibility errors. Classification
memoization preserved the model catalog exactly (JSON equality). Health and model
discovery returned HTTP 200.

Local raw evidence: `/tmp/llm-proxy-codex-validation/final.json`,
`final-*-events.jsonl`, `final-*-stderr.log`. Temporary evidence is not committed.

## Regression verification

Final full suite: **1,095 passed, 0 failed, 1 skipped** (1,096 total; 66.54 s).
Log: `/tmp/llm-proxy-completion-tests.log`. Docker build and `git diff --check`
also passed.

Run `node --test tests/*.test.js`. Tests cover substituted streaming transports,
empty-stream rejection, incremental declarations, custom namespace round trips,
strict upstream names, host detection, catalog shape, eligibility refresh after
request changes, explicit-model fast selection, and real HTTP fallback.

An integration assertion previously counted an unrelated auto-selected denial
against the later quota test; it now checks the quota attempt's own call delta.
The same single-attempt, pin, fallback, and dispatch-count assertions remain.

Docker was rebuilt and the local proxy recreated. No commit or push was made;
unrelated existing working-tree changes were preserved.
