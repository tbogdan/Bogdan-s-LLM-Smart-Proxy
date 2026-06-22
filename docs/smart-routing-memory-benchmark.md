# Smart Routing, Memory, and Compaction Benchmark

This document summarizes the 2026-05-22 local ladder benchmark for Bogdan LLM Smart Proxy.

## Executive Summary

Bogdan LLM Smart Proxy matched direct Opus quality on the tested workload while materially reducing estimated model spend.

| Metric | Direct Opus | Proxy smart routing | Result |
| --- | ---: | ---: | --- |
| Correctness | 9/9 | 9/9 | Quality parity |
| Weighted correctness | 100% | 100% | Quality parity |
| Estimated total cost | $0.385830 | $0.059077 | 84.7% lower |
| Cost per correct answer | $0.042870 | $0.006564 | 6.5x more efficient |
| Average latency | 14.8s | 19.6s | +32% headline latency |
| Average tokens | 986 | 905 | 8.2% fewer tokens |

In this historical run, the headline latency delta was dominated by one security-sensitive patch case routed to Sonnet Thinking. Excluding `secure-token-patch`, the proxy averaged 12.0s versus 13.3s for direct Opus, which is 9.3% faster while still saving 85.7% estimated cost.

## Benchmark Methodology

The benchmark used the same nine-case ladder for both arms:

- Direct arm: explicit `windsurf/claude-opus-4.6`, sent through the local endpoint with proxy prompt injection, memory injection, compaction, and routing assessment bypassed.
- Proxy arm: smart groups selected per case (`auto-coding`, `auto-text`, `coding-sm`, `auto-thinking`, `auto-max`) with routing, managed system-prompt injection, memory, and compaction enabled.
- Scoring: deterministic graders checked exact output, required content, JSON structure, and task-specific regular expressions.
- Cost: estimated from model-family pricing and normalized token usage. Bundled providers can report N/A for exact marginal price; in the benchmark math, those entries are treated as bundled/zero marginal cost unless a model-family estimator is available.
- Artifact: `data/benchmarks/ladder-2026-05-22-clean.json`.
- Current harness telemetry: new benchmark runs persist route traces, p50/p95 latency summaries, memory injection counters, compaction counters, post-stream warnings, and provider-family fairness metrics.
- Human-gated benchmark cases are auto-approved only inside the benchmark harness by default so the comparison remains runnable; the artifact records this as approval/warning telemetry. Production traffic receives a visible `LLM_PROXY_HUMAN_APPROVAL_REQUIRED` assistant message and waits for explicit user approval before provider execution.

This is a proxy-vs-optimized-proxy comparison, not a raw SDK comparison. The direct arm intentionally keeps the same local transport but forces a concrete premium model and disables the optimization layer, so the comparison isolates the business value of routing, memory, compaction, and prompt orchestration.

## Routing Examples

The benchmark shows the proxy using multiple agent lanes instead of defaulting to a single frontier model.

| Task type | Smart lane | Routed provider/model | Why this route was appropriate | Proxy latency | Direct Opus cost | Est. proxy cost | Result |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Exact low-cost reply | `auto-coding` | Windsurf Gemini 3 Flash Minimal | Trivial exact answer, no tools, no reasoning needed | 1.2s | $0.006255 | $0.000062 | exact |
| Session summary | `auto-text` | Windsurf Gemini 3 Flash Low | Lightweight summarization from supplied context | 3.3s | $0.013350 | $0.000101 | 3/3 |
| Async resource leak fix | `coding-sm` | Copilot GPT-3.5 Turbo | Small fast coding lane for a local function patch | 2.8s | $0.018090 | bundled/N/A | 3/3 |
| Code trace invariant | `auto-coding` | Windsurf Claude Sonnet 4.6 Thinking | Requires static reasoning over scheduler behavior and invariant | 19.4s | $0.039045 | $0.004053 | 3/3 |
| Completed feature review | `auto-coding` | Copilot GPT-3.5 Turbo | Review-focused low-cost model was enough for risk bullets | 3.3s | $0.033540 | bundled/N/A | 3/3 |
| Secure token patch | `auto-coding` | Windsurf Claude Sonnet 4.6 Thinking | Security-sensitive patch and regression tests in this historical run | 79.7s | $0.095820 | $0.017739 | 4/4 |
| Tool schema bridge | `auto-coding` | Windsurf Claude Sonnet 4.6 Thinking | Tool-contract design with reroute/cooldown behavior | 12.3s | $0.038835 | $0.006666 | 3/3 |
| Terminal recovery plan | `auto-thinking` | Windsurf Claude Sonnet 4.6 Thinking | Multi-signal recovery plan with verification gates | 37.0s | $0.113205 | $0.024906 | 4/4 |
| Production proxy incident | `auto-max` | Windsurf Claude Sonnet 4.6 Thinking | Architecture and risk decision; high quality without Opus cost | 17.2s | $0.027690 | $0.005550 | 4/4 |

The model mix is the business story: Opus was used 9/9 in the direct arm, while the proxy used Gemini Flash, Copilot GPT-3.5, and Sonnet Thinking according to task shape and risk.

## Latency Read

The proxy was massively cheaper, but the headline mean was slower because `secure-token-patch` took 79.7s on Sonnet Thinking. That one route alone accounts for most of the +32% average latency delta.

| View | Direct Opus avg | Proxy avg | Direct cost | Proxy cost | Savings |
| --- | ---: | ---: | ---: | ---: | ---: |
| All 9 cases | 14.8s | 19.6s | $0.385830 | $0.059077 | 84.7% |
| Excluding `secure-token-patch` | 13.3s | 12.0s | $0.290010 | $0.041338 | 85.7% |

For reporting, benchmark dashboards should show both headline averages and outlier-aware views such as p50, p95, and "excluding known stressor" rows. The current benchmark already exposes why this matters: p50 proxy latency was 12.3s, but p95 was 79.7s because of the security patch outlier.

The routing policy now includes a thinking-latency guard for deterministic security implementation tasks with small output budgets. Future runs may route patch sketches with regression tests to a non-thinking Sonnet or another high-quality medium model, while threat modeling and ambiguous auth reviews still keep the high-thinking lane.

## Log and Benchmark Analysis

No benchmark rerun is needed for these observations.

- The clean benchmark completed 18 total calls, with both arms 9/9 correct.
- Large-model gating is active. Logs show Sonnet/Opus-class access being gated by `AI-ASSESS`, with low-cost Gemini Flash Minimal frequently used as assessor.
- Simple exact-answer and summary tasks were routed to Gemini Flash Minimal/Low, which is the expected low-cost behavior.
- Review and small bugfix tasks were accepted by Copilot GPT-3.5 in the benchmark and passed, supporting the low-cost review/small-coding lane.
- Sonnet Thinking handled high-risk or high-reasoning tasks correctly, but `secure-token-patch` is a latency outlier.
- A single `GARBLE-NATIVE-STREAM` diagnostic appeared on unrelated long-context streaming traffic, not in the clean non-streaming benchmark. The recent garble-detector fixes reduced benchmark false positives, but live streaming diagnostics should continue to record reason codes.

## Related Strategy

Proxy-wide productivity impact, routing logic, memory governance, compaction behavior, optimization backlog, and bibliography are documented in the main [README](../README.md#smart-routing-memory-and-compaction-strategy).
