# Project LLM Smart Proxy

Project LLM Smart Proxy is a local Docker OpenAI-compatible smart proxy for the supported provider families: Windsurf, Claude, Codex, and GitHub Copilot. It exposes one local endpoint, discovers available models for those families, and routes smart group model names such as `auto`, `auto-coding`, and `coding-sm` to the best available provider.

## Summary

Project LLM Smart Proxy reduces AI operating cost by automatically routing each request to the right LLM for the task, context size, latency target, and business policy.

- Cost-aware automation: steers simple work to small, free, or low-cost models and escalates only when quality, tools, reasoning, or context require it.
- Multi-source provider fabric: unifies Windsurf, Claude, Codex, and GitHub Copilot behind one local API, so clients are not locked to one vendor path.
- Context continuity: preserves working context across requests with a local Neo4j memory ledger, Graphiti semantic sidecar, compacted-context archives, and built-in memory summaries.
- Multi-client API support: serves OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, token counting, and model discovery for IDEs, SDKs, and agents.
- Auditable operations: emits detailed routing, assessment, provider, cost, speed, thinking, cache, fallback, context-escalation, memory, compaction, and human-approval telemetry for transparent governance.
- Policy-driven control: lets operators tune spend, latency, and reasoning depth centrally without changing client applications.

## Supported Providers

| Provider family | Host authentication | Runtime adapter | Models |
| --- | --- | --- | --- |
| Windsurf | `node windsurf-auth.js --env-file .env` | Native proxy adapter | SWE, GPT, Claude, Gemini, GLM, Minimax, and Grok models from the local catalog |
| Claude | `claude auth login --console`, then `node claude-auth.js --env-path .env` to extract `ANTHROPIC_API_KEY` | Anthropic Messages adapter | `claude/...` from discovery/seed |
| Codex | `npx @openai/codex login`; setup copies `auth.json` into `data/codex-auth.json` | Local Codex proxy container | `codex/gpt-5.5`, `codex/gpt-5.4`, `codex/gpt-5.4-mini`, `codex/gpt-5.3-codex`, `codex/gpt-5.2`, `codex/codex-auto-review` |
| GitHub Copilot | `node github-copilot-auth.js --env-file .env`, or set `COPILOT_GITHUB_TOKEN` manually | GitHub OAuth token exchange + OpenAI-compatible Copilot LLM endpoint | Copilot GPT models from discovery/seed |

## Quick Start

```bash
chmod +x setup.sh
./setup.sh
```

The setup script copies `.env.example` to `.env` when needed, prompts for the provider families to enable, and starts Docker Compose with the required profiles.
When Codex is enabled, it also copies `${CODEX_HOME:-$HOME/.codex}/auth.json` into `data/codex-auth.json` if the file exists.

## Manual Setup

```bash
cp .env.example .env
```

Edit `.env` and enable the provider families you want:

```dotenv
COMPOSE_PROJECT_NAME=llm-proxy
LLM_PROXY_PORT=18900
CODEX_PROXY_PORT=10531
DATA_DIR=/data
DEV_MODE=true
ENABLE_WINDSURF=true
WINDSURF_API_KEY=
ENABLE_CLAUDE=true
CLAUDE_CODE_OAUTH_TOKEN=
ANTHROPIC_API_KEY=
ENABLE_CODEX=true
ENABLE_COPILOT=true
COPILOT_GITHUB_TOKEN=
LLM_COST_TARGET=3
LLM_THINKING_TARGET=medium
LLM_SPEED_TARGET=4
LLM_ROUTING_POLICY=balanced
WINDSURF_ENTERPRISE=false
```

Authenticate enabled providers on the host:

```bash
node windsurf-auth.js --env-file .env
claude auth login --console
node claude-auth.js --env-path .env
npx @openai/codex login
mkdir -p data
cp ~/.codex/auth.json data/codex-auth.json
node github-copilot-auth.js --env-file .env
```

For Claude, choose the Anthropic Console account in the browser flow. The helper reads the login-managed API key from Claude Code's local credential store and writes it to `ANTHROPIC_API_KEY` in `.env`. As a manual fallback, create a key at `https://platform.claude.com/settings/keys` and put it into `ANTHROPIC_API_KEY`.
For Copilot, the helper defaults to VS Code GitHub Authentication's public OAuth client id. You can override it with `--client-id`. The helper uses GitHub's device-flow authorization and writes the resulting GitHub token to `COPILOT_GITHUB_TOKEN`; the proxy exchanges it for a short-lived Copilot runtime token before calling the Copilot LLM endpoint.

Start Docker with the Codex profile when Codex is enabled:

```bash
docker compose --profile codex up -d --build
```

Without Codex, the base services are enough:

```bash
docker compose up -d --build
```

The base services include the graph memory backend and the Graphiti MCP sidecar. Their internal settings are fixed in Compose so `.env` stays focused on provider credentials, host ports, and routing policy. Neo4j and Graphiti MCP are kept on the Compose network by default instead of publishing extra host ports.

To run this proxy beside another checkout on the same Docker host, set a different `COMPOSE_PROJECT_NAME`, `LLM_PROXY_PORT`, and `CODEX_PROXY_PORT` in `.env`. Container-internal ports stay unchanged.

## Endpoint

- Base URL: `http://localhost:18900/v1`
- API key: any non-empty value, for example `proxy`
- Default model: `auto`

Use this endpoint from OpenAI-compatible SDKs, IDEs, and coding agents.

For Claude Code as a client, use the Anthropic-compatible bridge on the same service:

```bash
export ANTHROPIC_BASE_URL=http://localhost:18900
export ANTHROPIC_MODEL=auto-coding
export ANTHROPIC_SMALL_FAST_MODEL=coding-sm
claude
```

Project-local Claude Code config can be placed in `.claude/settings.local.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:18900",
    "ANTHROPIC_MODEL": "auto-coding",
    "ANTHROPIC_SMALL_FAST_MODEL": "coding-sm"
  }
}
```

The Claude Code bridge exposes `/v1/messages` and `/v1/messages/count_tokens`.

## Test

```bash
curl http://localhost:18900/v1/chat/completions \
  -H "Authorization: Bearer proxy" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello from Project LLM Smart Proxy"}]}'
```

Health and model checks:

```bash
curl http://localhost:18900/health
curl http://localhost:18900/v1/models
curl http://localhost:18900/v1/messages/count_tokens \
  -H "x-api-key: proxy" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto-coding","messages":[{"role":"user","content":"ping"}]}'
```

## Benchmark

The local benchmark compares an expensive direct concrete model with a proxy smart-routing ladder using the same test set. The direct arm bypasses proxy prompt injection, memory injection, content compaction, and routing assessment markers; the proxy arm keeps full optimization enabled and uses the appropriate smart group per case (`auto-assess`, `auto-sm`, `auto-memory`, `auto-text`, `coding-sm`, `auto-coding`, `auto-thinking`, or `auto-max`). Cases are coding-heavy and borrow benchmark shapes from code reasoning, real issue repair, secure coding, tool-use, terminal-agent recovery, and architecture decision tasks. It reports provider/model choices, average and p50/p95 latency, correctness, weighted correctness by complexity, prompt/completion tokens, estimated cost, cost group, route traces, memory/compaction counters, provider-family fairness, proxy savings percentage, and ASCII comparison charts.

### Smart Routing, Memory, and Compaction Benchmark

This section summarizes the 2026-05-22 local ladder benchmark. The full benchmark methodology, routing examples, latency/cost breakdown, and benchmark log analysis live in [Smart Routing, Memory, and Compaction Benchmark](docs/smart-routing-memory-benchmark.md).

#### Executive Summary

Project LLM Smart Proxy matched direct Opus quality on the tested workload while materially reducing estimated model spend.

| Metric | Direct Opus | Proxy smart routing | Result |
| --- | ---: | ---: | --- |
| Correctness | 9/9 | 9/9 | Quality parity |
| Weighted correctness | 100% | 100% | Quality parity |
| Estimated total cost | $0.385830 | $0.059077 | 84.7% lower |
| Cost per correct answer | $0.042870 | $0.006564 | 6.5x more efficient |
| Average latency | 14.8s | 19.6s | +32% headline latency |
| Average tokens | 986 | 905 | 8.2% fewer tokens |

In that historical run, the headline latency delta was dominated by one security-sensitive patch case routed to Sonnet Thinking. Excluding `secure-token-patch`, the proxy averaged 12.0s versus 13.3s for direct Opus, which is 9.3% faster while still saving 85.7% estimated cost. The current router now includes a thinking-latency guard for deterministic security patches with small output budgets.

The command is a dry run unless `--run` is present:

```bash
npm run benchmark
npm run benchmark -- --run --max-cases=6
npm run benchmark -- --run --suite=opus
npm run benchmark -- --run --suite=all --max-minutes=5
npm run benchmark -- --run --direct-model=windsurf/claude-opus-4.6 --proxy-model=auto-coding
```

Defaults are intentionally conservative: sequential requests, one repeat, six route-ladder cases, bounded completions, no cost cap, and a runtime guard of a few minutes. Use `--suite=opus` for the Opus-vs-optimized-proxy comparison where the direct arm calls Opus directly and the proxy arm receives natural high-complexity programming, architecture, and logic tasks with proxy cleanup and routing policy enabled. Use `--suite=all` to run the route ladder and Opus comparison in one merged benchmark. Cost is an estimate from model-family pricing and normalized token usage, then summarized as absolute USD plus proxy savings percentage. It can differ from subscription or bundled-provider billing; Windsurf SWE is treated as free.

## Smart Routing, Memory, and Compaction Strategy

### Productivity Effect

The proxy does more than choose a cheaper model. It applies managed system-prompt injection that turns a generic upstream model into a task-aware operating lane:

- Identity and client compatibility are normalized across providers.
- Tool strategy is injected only when tools are actually available.
- Lightweight mode strips unnecessary tool schemas for passive or exact-answer tasks.
- Use-case focus adds routing profile, task shape, gates, and verification posture.
- Memory instructions tell models to use injected memory first and request private recall with `LLM_PROXY_RECALL` only when needed.
- Post-route assessment markers let the response carry hidden metadata for the next route without leaking it to the user.

This improves productivity because client prompts do not need to repeatedly restate workflow rules, memory behavior, tool discipline, or routing expectations. The user and IDE can ask naturally; the proxy supplies the operating policy.

### Routing Algorithm

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
   - Requests classified as `human_signoff` or `dry_run_first` are blocked until the client retries with an explicit approval token.
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
   - Emit route trace telemetry with top candidates, selected source, gate, route profile, memory counters, compaction counters, warning codes, and provider-family fairness inputs.

This matches the research direction behind model cascades and learned routing: spend premium reasoning only when the task, context, or risk justifies it.

### Memory Algorithm

The active runtime uses `lib/memory` with Neo4j as the canonical ledger and Graphiti MCP as a semantic sidecar that is enabled by default in Compose but optional for successful hot-path routing.

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

### Compaction Algorithm

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

### Bibliography

- [FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance](https://arxiv.org/abs/2305.05176) - prompt adaptation, approximation, and model cascades for cost reduction.
- [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665) - dynamic routing between stronger and weaker LLMs to optimize cost and quality.
- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) - external non-parametric memory and retrieval for more factual generation.
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) - virtual context management inspired by hierarchical memory systems.
- [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://arxiv.org/abs/2404.16130) - graph-based retrieval and summarization over private corpora.
- [Graphiti documentation](https://help.getzep.com/graphiti/getting-started/welcome) and [Graphiti GitHub repository](https://github.com/getzep/graphiti) - temporal graph memory, episodes, hybrid search, and MCP integration.
- [LangGraph memory documentation](https://docs.langchain.com/oss/python/langgraph/add-memory) - short-term thread memory and long-term memory across sessions.
- [LlamaIndex agent memory documentation](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/) - memory put/get semantics, token-limited short-term memory, and flushing older context into longer-term memory.

## Discovery

The discovery daemon scans only the Windsurf, Claude, Codex, and Copilot provider families. It merges discovered models with the seed configuration and writes runtime provider data under `data/`.

Discovery is intentionally scoped to the supported families so `/v1/models`, smart routing, and Docker setup stay aligned.

Windsurf does not expose a stable public model list API, so the proxy ships a broader local catalog. Set `WINDSURF_ENTERPRISE=true` when the source should use the enterprise app API origin; the remaining transport compatibility defaults live in code and Compose rather than in the operator `.env`.

## Smart Groups

| Group | Purpose |
| --- | --- |
| `auto` | General smart routing across enabled providers |
| `auto-assess` | Internal routing assessment using the cheapest viable classifier models by pricing |
| `auto-sm` | Small, cheap/free light models for classification and simple text |
| `auto-memory` | Small reliable extraction models for Graphiti memory ingestion, JSON repair, and entity summaries |
| `auto-coding` | Coding, editing, and agentic development tasks |
| `coding-sm` | Small/fast coding and tool-capable background tasks, suitable for Claude Code small fast model routing |
| `auto-thinking` | Reasoning-heavy tasks |
| `auto-tools` | Requests that use tool calls |
| `auto-text` | General text generation and rewriting |
| `auto-max` | Highest-capability or largest-context routing |

Specific provider model IDs such as `windsurf/swe-1.6-fast`, `claude/...`, and `codex/gpt-5.5` can also be requested directly.

## Routing Policy

The strategy section above is the source of truth for routing behavior. This section documents the operator controls and private metadata contract used by the router at runtime.

For agentic requests, the proxy injects a private first-line task assessment contract:

```text
LLM_PROXY_TASK_DIFFICULTY level=<1-5> effort=<none|minimal|low|medium|high|xhigh> speed=<1-5> reason=<slug>
```

The proxy strips that marker before returning the response. If the selected model says the task needs a materially different level, the proxy reroutes inside the same request.

```dotenv
LLM_COST_TARGET=3
LLM_THINKING_TARGET=medium
LLM_SPEED_TARGET=4
LLM_ROUTING_POLICY=balanced
```

The targets are averages/preferences. Simple prompts are steered toward cheaper/faster models; complex agentic work can exceed the configured cost target when capability is more important. Context compaction and AI summaries are handled by the memory layer before the next route is chosen.

| Variable | Values | Executive effect |
| --- | --- | --- |
| `LLM_COST_TARGET` | `1` to `5`, default `3` | Lower values favor savings and free/mini models; higher values allow more premium models when the task justifies it. |
| `LLM_THINKING_TARGET` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; default `medium` | Sets the preferred reasoning depth, from fast execution to deeper deliberation. |
| `LLM_SPEED_TARGET` | `1` to `5`, default `4` | Higher values prioritize latency; lower values permit slower high-capability models. |
| `LLM_ROUTING_POLICY` | `economy`, `balanced`, `speed`, `quality`; default `balanced` | Selects the operating posture: `economy` maximizes savings, `balanced` optimizes cost and quality, `speed` prioritizes latency, and `quality` allows more capable models when the task benefits. Unknown values safely fall back to `balanced`. |

Policy aliases are accepted for operator convenience: `cheap`, `cost`, `efficient`, `lowcost`, `low-cost`, and `savings` map to `economy`; `fast`, `latency`, and `throughput` map to `speed`; `capability`, `premium`, and `frontier` map to `quality`.

### Human Sign-Off Gate

Human approval is enabled by default. When routing classifies a request with `human_signoff` or `dry_run_first`, the proxy stops before any provider or hidden assessor call and returns HTTP `409` with `error.code=human_signoff_required`.

The response includes an approval challenge and writes an audit event to `${DATA_DIR}/human-approvals.jsonl`. After reviewing the request, retry the same payload with one of these approval forms:

```text
X-LLM-Proxy-Approval: approved_by_user:<challenge>
approved_by_user=approved_by_user:<challenge>
```

The approval token is bound to a hash of the request, task gate, shape, tools, and messages, expires after 15 minutes by default, and is stripped before the upstream model sees the request. `/health` exposes whether the approval system is enabled, the pending count, and the audit file path. For local experiments only, it can be disabled with `LLM_PROXY_HUMAN_APPROVAL_ENABLED=false`.

## Memory Layer

The strategy section above describes the memory and compaction algorithms. The runtime implementation is `lib/memory`; Docker Compose enables the local Neo4j graph backend by default and stores memory governance events, corrections, compacted archive refs, and recall hints there. The in-process backend remains available for tests or temporary non-Docker runs, but it is not part of the operator `.env`.

Models can request private memory work with first-line markers that the proxy strips before returning content to the client:

```text
LLM_PROXY_RECALL v=1 q="routing architecture" types=architecture,decisions budget=1200 reason=task_context
LLM_PROXY_MEMORY v=1 op=user_correction target=routing_policy type=preference confidence=high
```

`LLM_PROXY_RECALL` triggers one internal retry with recalled memory injected into the system prompt. `LLM_PROXY_MEMORY` records memory governance intent, including user corrections that should supersede older facts when the graph backend is enabled. Context compaction archives dropped turns as `memory://...` references and tells the next model to use `LLM_PROXY_RECALL` when it needs details.

Graphiti MCP runs as a semantic sidecar behind the proxy. The canonical memory ledger remains `lib/memory` backed by Neo4j; Graphiti MCP receives memory events and compacted archives asynchronously through a retryable outbox. Recall stays canonical-first: direct Neo4j memory is injected first, semantic Graphiti hints are appended only for explicit `LLM_PROXY_RECALL` requests and only if the sidecar answers within its timeout.

The Graphiti MCP sidecar is wired through this proxy instead of requiring a real `OPENAI_API_KEY`: its OpenAI-compatible URL is `http://llm-proxy:18900/v1`, the LLM model is `auto-memory`, and `/v1/embeddings` is served locally by a deterministic hash embedder. This keeps sidecar ingestion local and cheap.

## Docker Profiles

| Profile | When to use |
| --- | --- |
| `codex` | Required when `ENABLE_CODEX=true`; starts the local Codex proxy container using `data/codex-auth.json`. |

Examples:

```bash
docker compose --profile codex up -d --build
docker compose up -d --build
```

Port variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `llm-proxy` | Prefix for Docker Compose container names |
| `LLM_PROXY_PORT` | `18900` | Host port for the OpenAI/Anthropic proxy |
| `CODEX_PROXY_PORT` | `10531` | Host port for the Codex proxy profile |
| `DATA_DIR` | `/data` | Runtime data path inside the containers |
| `DEV_MODE` | `true` | Enables local development logging and behavior |

## Troubleshooting

- Missing `WINDSURF_API_KEY`: run `node windsurf-auth.js --env-file .env`, then restart the proxy.
- Missing Claude credentials: run `claude auth login --console`, choose Anthropic Console, then run `node claude-auth.js --env-path .env` and restart the proxy. If the helper says you are logged in with a subscription account, run `claude auth logout` and repeat the Console login.
- Missing `data/codex-auth.json`: run `npx @openai/codex login`, then rerun `./setup.sh`; setup copies the auth file into Docker's bind mount target.
- Empty `/v1/models`: confirm at least one provider family is enabled in `.env`, required credentials are present, and the matching Docker profile is running for Codex.

## Provider References

Research references for routing, memory, and compaction are listed in the strategy bibliography above. Provider integration references live here:

- [Claude Platform API authentication](https://platform.claude.com/docs/en/api/authentication/overview)
- [Claude Code authentication docs](https://code.claude.com/docs/en/authentication)
- [Claude Messages API docs](https://platform.claude.com/docs/en/api/messages)
- [GitHub Copilot Extensions LLM endpoint](https://docs.github.com/en/copilot/how-tos/use-copilot-extensions/build-a-copilot-agent/use-copilots-llm)
- [GitHub OAuth device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
