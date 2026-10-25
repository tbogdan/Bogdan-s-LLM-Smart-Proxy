# Claude Code model-complexity routing audit — 2026-10-25

## Conclusion

The current Claude Code setup enables proxy transport but does not enable adaptive model selection. This is the principal confirmed explanation for the observed behavior. Investigation only: no production routing, personal settings, containers or provider requests were changed by this audit.

## Evidence and causes

1. `lib/proxy-setup.js:194–218` manages the base URL, API key and ToolSearch. `ANTHROPIC_MODEL` is written only when an explicit `--model` argument is supplied. Current personal settings retain `model: sonnet`, with no `ANTHROPIC_MODEL` override. The small auto-mode safety classifier setting is separate from the primary conversation model.
2. `lib/anthropic-gateway.js:96–103` preserves recognized model IDs: a local translation probe mapped `claude-sonnet-5-5` to `claude/claude-sonnet-5-5`, while `auto-coding` remained `auto-coding`. Unknown models default to auto-coding; recognized Claude models do not. A healthy direct Anthropic passthrough can return before adaptive routing altogether.
3. `lib/routing.js:6250–6254` refuses AI task assessment when the request is not a group. The named-model path starts at line9551. `lib/task-runtime.js:375–411` applies orchestrator ranking only for a new, unpinned primary request whose model starts with auto. Therefore named Sonnet/Opus traffic can recover through other providers without ever performing the intended adaptive initial selection. Fallback is not proof of complexity-based selection.
4. Without explicit task/conversation IDs, task identity is derived from the first user message (`lib/task-runtime.js:160–177`). A different later user request in the same conversation retains that anchor and existing primary pin. Local no-network reproduction confirmed identical task keys and skipped classification after changing from level1 to level5 intent. This preserves requested within-task stability but lacks a reliable boundary for a new task inside the same chat. Model switches require explicit task boundaries or a trusted boundary detector; switching every tool turn would violate the stability requirement.
5. `taskProfile` type and risk scan all historical user messages (`lib/task-runtime.js:132–156`), so old review/security language can affect current work. All 11 recently modified task records in the captured interval were REVIEW. That distribution is an observation, not proof that all current requests are reviews. The durable orchestration profile also collapses level3 to SIMPLE, whereas ranking calls it MODERATE.
6. New auto-task ranking reads only `_llmProxyDifficulty.taskLevel`, defaulting to1 when no assessment object exists, although `effectiveRequestProfile` can compute a stronger heuristic. A local fixture classified complex intent at heuristic level5 but passed SIMPLE to the orchestrator when the annotation was absent. This is an additional integration inconsistency, independent of the main explicit-model bypass.
7. Actual served-model attribution can be stale. At14:32:18.888Z, inner recovery correctly reported gpt-6.1-sol; at14:32:18.891Z, the outer success log incorrectly reported codex-auto-review. The outer path also updates session affinity using its initial provider. Buffered response headers already use `_servedProvider`; logging/affinity must use the same final result. Do not count nested success logs as separate completions.

## Captured traffic

Window: previous45minutes captured14:53:16UTC /16:53:16Europe/Bucharest;1284log lines. DEV request attempts: gpt-6.1-sol68, codex-auto-review57, OpenCode Sonnet3, Mistral Small1. These are upstream attempts, not unique requests or successful completions. No ROUTING-PROFILE/AI-ASSESS complexity records appeared in the captured interval. No real-model benchmark was run; no claim is made that these models are intrinsically unsuitable or that every larger model selection is wasteful. Context capacity, account availability, tool support and output failures remain valid selection constraints.

## Recommended repair order

1. Make setup explicitly distinguish adaptive routing from a deliberate model pin. Adaptive setup should set a supported auto-group model for the main conversation and reliably cover Claude Code model aliases, CLI and IDE session overrides. Preserve the separate safety classifier and permission controls. Verify the actual wire model in a fresh CLI and an existing IDE session; changing settings alone is insufficient evidence.
2. Use one effective task profile for assessment, ranking and durable orchestration. Base intent on current user work, with explicit trusted task boundaries; keep the same model during ordinary tool continuations and retain three functional model slots.
3. Propagate the actual served provider to success logs and session affinity. Persist sanitized decision evidence: request route, task boundary source, task/context levels, constraints, top eligible alternatives, selection reason and final model.
4. Add deterministic HTTP fixtures for easy/complex/new-task/continuation cases and fallback attribution, then one small live end-to-end CLI/IDE validation. Avoid repeated full-context test calls or an extra classification call per tool continuation.

Private sanitized reproduction and aggregate evidence: `.superpowers/sdd/2026-10-25-model-complexity-audit/`. Personal configuration and raw prompts were not copied into this report.
