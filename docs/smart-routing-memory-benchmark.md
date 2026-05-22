# Smart Routing, Memory, and Compaction Benchmark

This document summarizes the 2026-05-22 local ladder benchmark and explains the routing, memory, and context-compaction strategy behind Project LLM Smart Proxy.

## Executive Summary

Project LLM Smart Proxy matched direct Opus quality on the tested workload while materially reducing estimated model spend.

| Metric | Direct Opus | Proxy smart routing | Result |
| --- | ---: | ---: | --- |
| Correctness | 9/9 | 9/9 | Quality parity |
| Weighted correctness | 100% | 100% | Quality parity |
| Estimated total cost | $0.385830 | $0.059077 | 84.7% lower |
| Cost per correct answer | $0.042870 | $0.006564 | 6.5x more efficient |
| Average latency | 14.8s | 19.6s | +32% headline latency |
| Average tokens | 986 | 905 | 8.2% fewer tokens |

The headline latency delta is dominated by one security-sensitive patch case routed to Sonnet Thinking. Excluding `secure-token-patch`, the proxy averaged 12.0s versus 13.3s for direct Opus, which is 9.3% faster while still saving 85.7% estimated cost.

## Benchmark Methodology

The benchmark used the same nine-case ladder for both arms:

- Direct arm: explicit `windsurf/claude-opus-4.6`, sent through the local endpoint with proxy prompt injection, memory injection, compaction, and routing assessment bypassed.
- Proxy arm: smart groups selected per case (`auto-coding`, `auto-text`, `coding-sm`, `auto-thinking`, `auto-max`) with routing, managed system-prompt injection, memory, and compaction enabled.
- Scoring: deterministic graders checked exact output, required content, JSON structure, and task-specific regular expressions.
- Cost: estimated from model-family pricing and normalized token usage. Bundled providers can report N/A for exact marginal price; in the benchmark math, those entries are treated as bundled/zero marginal cost unless a model-family estimator is available.
- Artifact: `data/benchmarks/ladder-2026-05-22-clean.json`.

This is a proxy-vs-optimized-proxy comparison, not a raw SDK comparison. The direct arm intentionally keeps the same local transport but forces a concrete premium model and disables the optimization layer, so the comparison isolates the business value of routing, memory, compaction, and prompt orchestration.

## Routing Examples

The benchmark shows the proxy using multiple agent lanes instead of defaulting to a single frontier model.

| Task type | Smart lane | Routed provider/model | Why this route was appropriate | Proxy latency | Est. proxy cost | Result |
| --- | --- | --- | --- | ---: | ---: | --- |
| Exact low-cost reply | `auto-coding` | Windsurf Gemini 3 Flash Minimal | Trivial exact answer, no tools, no reasoning needed | 1.2s | $0.000062 | exact |
| Session summary | `auto-text` | Windsurf Gemini 3 Flash Low | Lightweight summarization from supplied context | 3.3s | $0.000101 | 3/3 |
| Async resource leak fix | `coding-sm` | Copilot GPT-3.5 Turbo | Small fast coding lane for a local function patch | 2.8s | bundled/N/A | 3/3 |
| Code trace invariant | `auto-coding` | Windsurf Claude Sonnet 4.6 Thinking | Requires static reasoning over scheduler behavior and invariant | 19.4s | $0.004053 | 3/3 |
| Completed feature review | `auto-coding` | Copilot GPT-3.5 Turbo | Review-focused low-cost model was enough for risk bullets | 3.3s | bundled/N/A | 3/3 |
| Secure token patch | `auto-coding` | Windsurf Claude Sonnet 4.6 Thinking | Security-sensitive patch and regression tests | 79.7s | $0.017739 | 4/4 |
| Tool schema bridge | `auto-coding` | Windsurf Claude Sonnet 4.6 Thinking | Tool-contract design with reroute/cooldown behavior | 12.3s | $0.006666 | 3/3 |
| Terminal recovery plan | `auto-thinking` | Windsurf Claude Sonnet 4.6 Thinking | Multi-signal recovery plan with verification gates | 37.0s | $0.024906 | 4/4 |
| Production proxy incident | `auto-max` | Windsurf Claude Sonnet 4.6 Thinking | Architecture and risk decision; high quality without Opus cost | 17.2s | $0.005550 | 4/4 |

The model mix is the business story: Opus was used 9/9 in the direct arm, while the proxy used Gemini Flash, Copilot GPT-3.5, and Sonnet Thinking according to task shape and risk.

## Latency Read

The proxy was massively cheaper, but the headline mean was slower because `secure-token-patch` took 79.7s on Sonnet Thinking. That one route alone accounts for most of the +32% average latency delta.

| View | Direct Opus avg | Proxy avg | Proxy cost | Savings |
| --- | ---: | ---: | ---: | ---: |
| All 9 cases | 14.8s | 19.6s | $0.059077 | 84.7% |
| Excluding `secure-token-patch` | 13.3s | 12.0s | $0.041338 | 85.7% |

For reporting, benchmark dashboards should show both headline averages and outlier-aware views such as p50, p95, and "excluding known stressor" rows. The current benchmark already exposes why this matters: p50 proxy latency was 12.3s, but p95 was 79.7s because of the security patch outlier.

## Productivity Effect

The proxy does more than choose a cheaper model. It applies managed system-prompt injection that turns a generic upstream model into a task-aware operating lane:

- Identity and client compatibility are normalized across providers.
- Tool strategy is injected only when tools are actually available.
- Lightweight mode strips unnecessary tool schemas for passive or exact-answer tasks.
- Use-case focus adds routing profile, task shape, gates, and verification posture.
- Memory instructions tell models to use injected memory first and request private recall with `LLM_PROXY_RECALL` only when needed.
- Post-route assessment markers let the response carry hidden metadata for the next route without leaking it to the user.

This improves productivity because client prompts do not need to repeatedly restate workflow rules, memory behavior, tool discipline, or routing expectations. The user and IDE can ask naturally; the proxy supplies the operating policy.

## Routing Algorithm

The current routing policy is an elastic optimizer rather than a hard allowlist.

1. Discover alive providers from Windsurf, Claude, Codex, and Copilot.
2. Classify each provider into cost, quality, speed, context, capability, and thinking-effort bands.
3. Classify the request into a task kind (`direct_answer`, `list_summary`, `agentic_coding`, `security_review`, `benchmarking`, `architecture_recovery`, and others).
4. Assign a step shape:
   - `direct`: exact/simple answer, keep it lean.
   - `write_heavy`: implementation or output generation, optimize for fast useful work.
   - `read_heavy`: analysis, architecture, root cause, or planning, spend reasoning before output.
   - `review`: adversarial validation against a diff or completed work.
   - `security` / `destructive`: higher quality and human-signoff posture.
   - `benchmark`: preserve fair arms and measurable outputs.
5. Build an effective request profile:
   - `taskLevel`: difficulty of the current user task.
   - `contextLevel`: transcript/tool/cache pressure.
   - `level`: max of task and context pressure.
   - `costTarget`, `speedTarget`, `thinkingLevel`: adjusted by the operator policy (`economy`, `balanced`, `speed`, `quality`).
6. Gate large-model access:
   - Low-tier models can be selected directly.
   - Sonnet/Opus/Pro/max/high-thinking candidates require AI assessment when the top candidate is a large model or the context is noisy.
   - The assessor uses `auto-assess`, favoring cheap fast providers, and returns minified JSON used only by the proxy.
7. Score candidates:
   - Base provider health and compatibility.
   - Capability match for the smart group.
   - Policy distance from cost, quality, speed, and thinking targets.
   - Learned penalties for tool/schema/context failures.
   - Source-local cost multiplier bonuses so each provider family can contribute its best low-cost candidate.
   - Session affinity for a provider that just worked.
8. Route, validate, and adapt:
   - Strip private markers before returning content.
   - Validate tool calls against client schemas.
   - Reroute on context errors, invalid tool calls, stalling, provider errors, or explicit memory recall requests.
   - Store post-route assessment metadata in the session cache for the next request.

This matches the research direction behind model cascades and learned routing: spend premium reasoning only when the task, context, or risk justifies it.

## Memory Algorithm

The active runtime uses `lib/memory` with Neo4j as the canonical ledger and Graphiti MCP as an optional semantic sidecar.

1. Session identity:
   - The proxy derives a session hash from the system prompt and detects the project name from local paths or project metadata.
   - Each request increments a session counter and tracks the last successful provider for affinity.
2. Canonical recall:
   - `recallMemories()` queries Neo4j by project/session and injects active memory events, project context, and compacted archive references.
   - Superseded facts are excluded from recall.
   - Memory is injected inside `[LLM_PROXY_MEMORY_START]` / `[LLM_PROXY_MEMORY_END]` and marked as untrusted retrieval hints.
3. Explicit recall:
   - A model can emit `LLM_PROXY_RECALL v=1 q="..." types=... budget=... reason=...` as the first private line.
   - The proxy strips the marker, retrieves canonical Neo4j memory plus optional Graphiti semantic results, injects them, and retries once.
4. Memory governance:
   - A model can emit `LLM_PROXY_MEMORY v=1 op=user_correction|save_fact|save_decision target=<topic> type=<type> confidence=<level>`.
   - `user_correction` marks prior events with the same target as `superseded`.
   - Events are recorded in session memory, persisted to Neo4j, and enqueued asynchronously to Graphiti MCP.
5. Semantic sidecar:
   - Graphiti receives memory events and compacted archives through a retryable Neo4j outbox.
   - Semantic search is appended only for explicit recall requests and only behind the same `lib/memory` interface.
   - The hot path remains canonical-first so the proxy is usable even if the sidecar is warming up.

This gives the proxy a memory governance model, not just "chat history". Corrections have lifecycle state, archives have durable `memory://...` references, and semantic memory improves recall without becoming mandatory infrastructure for every request.

## Compaction Algorithm

Context compaction is designed to preserve recent intent, tool-call integrity, and recovery paths.

1. Apply cached truncations:
   - Previously seen large tool outputs reuse the same compacted preview so repeated IDE context does not balloon.
2. Protect recent context:
   - System messages are preserved.
   - The most recent turns are protected first; if needed, protected tool responses are reduced to factual previews.
3. Extract tool facts:
   - Reads become `[READ timestamp] file - line range` summaries.
   - Searches become result-count summaries.
   - Writes track file path and write count.
   - Shell output, diagnostics, and agent output are reduced to short evidence records.
4. Topic grouping:
   - Older messages are grouped into atomic assistant-tool bundles.
   - Topics are detected by file path, commands, errors, decisions, or general context.
   - Low-priority old topics are dropped first.
5. Build a compact summary:
   - The summary records removed message count, archived memory references, compacted topics, files read, files edited, and key decisions.
   - It tells the next model to recover details through `LLM_PROXY_RECALL` or targeted file reads.
6. Add AI summary when useful:
   - Dropped context can be condensed by an internal proxy call to `auto-text`.
   - Summaries are cached by digest.
7. Archive before dropping:
   - The full dropped context is archived as a `memory://episode/...` reference in Neo4j.
   - Graphiti MCP receives the archive asynchronously through the outbox.

The intent is structurally lossy but operationally recoverable compaction: old content can be summarized and dropped from the token window while preserving enough references for recall, re-read, and audit.

## Log And Benchmark Analysis

No benchmark rerun is needed for these observations.

- The clean benchmark completed 18 total calls, with both arms 9/9 correct.
- Large-model gating is active. Logs show Sonnet/Opus-class access being gated by `AI-ASSESS`, with low-cost Gemini Flash Minimal frequently used as assessor.
- Simple exact-answer and summary tasks were routed to Gemini Flash Minimal/Low, which is the expected low-cost behavior.
- Review and small bugfix tasks were accepted by Copilot GPT-3.5 in the benchmark and passed, supporting the low-cost review/small-coding lane.
- Sonnet Thinking handled high-risk or high-reasoning tasks correctly, but `secure-token-patch` is a latency outlier.
- A single `GARBLE-NATIVE-STREAM` diagnostic appeared on unrelated long-context streaming traffic, not in the clean non-streaming benchmark. The recent garble-detector fixes reduced benchmark false positives, but live streaming diagnostics should continue to record reason codes.

## Optimization Backlog

Recommended next improvements, based on logs and the benchmark:

- Split security implementation from security review. A deterministic patch sketch with tests may not always need Sonnet Thinking; reserve high-thinking routes for threat modeling, ambiguous auth architecture, and exploit analysis.
- Add a "thinking latency guard" for medium-size patch tasks: if a high-thinking model is selected with a small output budget, prefer non-thinking Sonnet or a high-quality mini model unless the assessor returns an explicit high-risk reason.
- Persist route traces into the benchmark artifact: top candidates, assessment source, gate reason, route profile, and post-route reassessment. This removes the need to correlate JSON results with Docker logs.
- Report p50, p95, and outlier-aware views by default. Mean-only latency hides whether the proxy is generally faster but occasionally expensive.
- Track memory and compaction counters in benchmark output: injected memory tokens, archive refs, compaction phase, AI summary use, and recall retries.
- Separate post-stream warnings from hard failures in telemetry. A completed stream with a diagnostic warning should not be interpreted as a benchmark failure.
- Add provider family fairness metrics: how often each source was eligible, top-3, selected, failed, or gated. This will make `125/148 active providers` more actionable than a raw health count.

## Bibliography

- [FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance](https://arxiv.org/abs/2305.05176) - prompt adaptation, approximation, and model cascades for cost reduction.
- [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665) - dynamic routing between stronger and weaker LLMs to optimize cost and quality.
- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) - external non-parametric memory and retrieval for more factual generation.
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) - virtual context management inspired by hierarchical memory systems.
- [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://arxiv.org/abs/2404.16130) - graph-based retrieval and summarization over private corpora.
- [Graphiti documentation](https://help.getzep.com/graphiti/getting-started/welcome) and [Graphiti GitHub repository](https://github.com/getzep/graphiti) - temporal graph memory, episodes, hybrid search, and MCP integration.
- [LangGraph memory documentation](https://docs.langchain.com/oss/python/langgraph/add-memory) - short-term thread memory and long-term memory across sessions.
- [LlamaIndex agent memory documentation](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/) - memory put/get semantics, token-limited short-term memory, and flushing older context into longer-term memory.
