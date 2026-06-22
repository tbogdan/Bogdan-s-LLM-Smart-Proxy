# Bogdan LLM Smart Proxy

Bogdan LLM Smart Proxy is a local Docker OpenAI-compatible proxy for Windsurf, Claude, Codex, and GitHub Copilot. It exposes one endpoint, discovers available models, and routes smart groups such as `auto`, `auto-coding`, and `coding-sm` to the best provider.

## Summary

Bogdan LLM Smart Proxy lowers AI operating cost by routing each request according to task, context fit, latency target, and business policy.

- Cost-aware automation: sends simple work to small/free/low-cost models, escalates capability only when quality/tools/reasoning/risk require it, and prefers same-capability larger-context peers before frontier upgrades.
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

The setup script copies `.env.example` to `.env` when needed, prompts for enabled provider families, starts Docker Compose with the required profiles, and copies `${CODEX_HOME:-$HOME/.codex}/auth.json` into `data/codex-auth.json` when Codex is enabled and the file exists.

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
CLAUDE_CODE_DEVICE_ID=
CLAUDE_CODE_ACCOUNT_UUID=
CLAUDE_CODE_ORGANIZATION_UUID=
CLAUDE_CODE_SESSION_ID=
CLAUDE_CODE_VERSION=
CLAUDE_CODE_BILLING_BUILD=
CLAUDE_CODE_MAX_TOKENS=
CLAUDE_CODE_STAINLESS_PACKAGE_VERSION=
CLAUDE_CODE_BETAS=
CLAUDE_CODE_OUTPUT_EFFORT=
ENABLE_CODEX=true
LLM_PROXY_CODEX_VIRTUAL_SUBAGENTS=true
ENABLE_COPILOT=true
COPILOT_GITHUB_TOKEN=
LLM_COST_TARGET=3
LLM_THINKING_TARGET=medium
LLM_SPEED_TARGET=4
LLM_ROUTING_POLICY=balanced
LLM_PROXY_PROMPT_INJECTION=full
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

For Claude, choose the Anthropic Console account. The helper reads Claude Code's local login-managed API key, writes `ANTHROPIC_API_KEY`, extracts Claude Code identity metadata from `~/.claude.json`, and runs a local CLI probe to capture request defaults such as beta headers and max token shape. Pass `--session-id <uuid>` if you want to pin a session id in `.env`; otherwise proxied Claude Code requests can override it per request with `x-claude-code-session-id`.
For Copilot, the helper uses GitHub device-flow auth with VS Code GitHub Authentication's public OAuth client id by default, accepts `--client-id`, writes `COPILOT_GITHUB_TOKEN`, and the proxy exchanges it for a short-lived Copilot runtime token.

Start Docker with the Codex profile when Codex is enabled:

```bash
docker compose --profile codex up -d --build
```

Without Codex, the base services are enough:

```bash
docker compose up -d --build
```

Base services include the graph memory backend and Graphiti MCP sidecar. Their settings live in Compose so `.env` stays focused on provider credentials, host ports, and routing policy. Neo4j and Graphiti MCP stay on the Compose network by default.

To run this proxy beside another checkout on the same Docker host, set a different `COMPOSE_PROJECT_NAME`, `LLM_PROXY_PORT`, and `CODEX_PROXY_PORT` in `.env`. Container-internal ports stay unchanged.

## Endpoint

- **Base URL:** `http://localhost:18900/v1`
- **API key:** any non-empty value, e.g. `proxy`
- **Default model:** `auto`

### Client Setup

#### Quick setup (persistent)

Set the client environment variables your OpenAI-compatible client expects:

```env
OPENAI_API_BASE_URL=http://localhost:18900/v1
OPENAI_API_KEY=proxy
OPENAI_MODEL=gpt-5.5
```
Requesting `gpt-5.5` uses the advertised Codex alias whose smart target is `auto-coding`; clients can also request `auto` or `auto-coding` directly.

Add these lines to your shell profile, such as `~/.zshrc` or `~/.bashrc`, or to your IDE environment/settings file, then restart the IDE or terminal.

#### Codex (persistent config example)

For Codex CLI or plugin, point at llm-proxy (port 18900). This is the primary endpoint for Codex — it handles smart routing, prompt injection, memory, and compaction. Edit `~/.codex/config.toml`:

```toml
# ~/.codex/config.toml
model = "gpt-5.5"
model_provider = "llm-proxy"

[model_providers.llm-proxy]
name = "Bogdan LLM Smart Proxy (OpenAI-compatible)"
base_url = "http://localhost:18900/v1"

[features]
multi_agent = true
codex_hooks = true
js_repl = false
```

Set the API key in your shell or IDE environment:

```bash
export OPENAI_API_KEY=proxy
```

Restart after saving.

> **llm-proxy (port 18900) vs codex-proxy (port 10531):**
> llm-proxy is the smart routing endpoint Codex should talk to. It provides OpenAI Responses API, memory, and routing across all providers.
> codex-proxy (port 10531) is a separate OAuth/auth shim container that only handles Codex credential refresh from `data/codex-auth.json`. It does not route or inject prompts. The proxy uses it internally as a provider backend.

#### VS Code, JetBrains, or other OpenAI-compatible IDEs

In the extension/plugin settings, use **API Base URL** `http://localhost:18900/v1`, **API Key** `proxy`, and **Model** `auto` or another supported model.

#### Anthropic/Claude Code as client

Use the Anthropic-compatible bridge on the same service:

```bash
export ANTHROPIC_BASE_URL=http://localhost:18900
export ANTHROPIC_MODEL=auto-coding
export ANTHROPIC_SMALL_FAST_MODEL=coding-sm
claude
```

Project-local Claude Code config in `.claude/settings.local.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:18900",
    "ANTHROPIC_MODEL": "auto-coding",
    "ANTHROPIC_SMALL_FAST_MODEL": "coding-sm"
  }
}
```

The bridge exposes `/v1/messages` and `/v1/messages/count_tokens`.

## Test

```bash
curl http://localhost:18900/v1/chat/completions \
  -H "Authorization: Bearer proxy" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello from Bogdan LLM Smart Proxy"}]}'
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

The local benchmark compares an expensive direct concrete model with proxy smart routing on the same cases. The direct arm bypasses proxy prompt injection, memory injection, compaction, and assessment markers; the proxy arm keeps optimization enabled and chooses the smart group per case (`auto-assess`, `auto-sm`, `auto-memory`, `auto-text`, `coding-sm`, `auto-coding`, `auto-thinking`, or `auto-max`). Cases cover code reasoning, real issue repair, secure coding, tool-use, terminal-agent recovery, and architecture decisions. Reports include provider/model choice, average and p50/p95 latency, correctness, weighted correctness, prompt/completion tokens, estimated cost, cost group, route traces, memory/compaction counters, provider-family fairness, savings percentage, and ASCII charts.

### Smart Routing, Memory, and Compaction Benchmark

This summarizes the 2026-05-22 local ladder benchmark. Full methodology, routing examples, latency/cost breakdown, and log analysis live in [Smart Routing, Memory, and Compaction Benchmark](docs/smart-routing-memory-benchmark.md).

#### Executive Summary

Bogdan LLM Smart Proxy matched direct Opus quality on the tested workload while materially reducing estimated model spend.

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

Defaults are conservative: sequential requests, one repeat, six route-ladder cases, bounded completions, no cost cap, and a short runtime guard. `--suite=opus` compares direct Opus with optimized proxy routing on natural high-complexity programming, architecture, and logic tasks with proxy cleanup/policy enabled. `--suite=all` merges the route ladder and Opus comparison. Cost is estimated from model-family pricing and normalized token usage, summarized as USD plus proxy savings; it can differ from subscription or bundled-provider billing, and Windsurf SWE is treated as free.

## Smart Routing, Memory, and Compaction Strategy

### Productivity Effect

The proxy does more than choose a cheaper model: managed system-prompt injection turns generic upstream models into task-aware operating lanes.

- Identity and client compatibility are normalized across providers.
- Tool strategy is injected only when tools are actually available.
- Lightweight mode strips unnecessary tool schemas for passive or exact-answer tasks.
- Use-case focus adds routing profile, task shape, gates, and verification posture.
- Memory instructions tell models to use injected memory first and request private recall with `LLM_PROXY_RECALL` only when needed.
- Post-route assessment markers let the response carry hidden metadata for the next route without leaking it to the user; continuations reuse that marker/cache instead of asking a classifier again for the same user intent.

Client prompts do not need to restate workflow rules, memory behavior, tool discipline, or routing expectations; the user/IDE can ask naturally while the proxy supplies policy.

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
   - `security`: security review that requires human sign-off before provider execution.
   - `destructive`: dry-run-first execution posture; real irreversible or production-impacting execution requires human sign-off.
   - `benchmark`: preserve fair arms and measurable outputs.
5. Build an effective request profile:
   - `taskLevel`: difficulty of the current user task.
   - `contextLevel`: transcript/tool/cache pressure after the context-headroom check. Token pressure escalates only when the current context tier would leave less than 30% unused context.
   - `level`: max of task and context pressure for telemetry and route profile. The hard provider capability cap uses task level, thinking level, and sign-off gates; context pressure influences fit/scoring and reaches frontier only when no same-capability fit is viable or an explicit frontier context is requested.
   - `costTarget`, `speedTarget`, `thinkingLevel`: adjusted by the operator policy (`economy`, `balanced`, `speed`, `quality`).
6. Gate large-model access:
   - Low-tier models can be selected directly.
   - Context-only pressure does not force Sonnet/Opus/Pro/max access when a same-capability provider has enough context.
   - Sonnet/Opus/Pro/max/high-thinking candidates require AI assessment on a new user task or explicit upgrade.
   - The assessor uses `auto-assess`, favoring cheap fast providers, and returns minified JSON used only by the proxy.
   - Agent continuations reuse the previous response marker or post-route assessment cache when the latest user intent has not changed.
   - Only final `human_signoff` assessments create a human approval state; `dry_run_first` remains a routing/execution posture.
7. Score candidates:
   - Base provider health and compatibility.
   - Capability match for the smart group.
   - Context fit and headroom, preferring same-level large-context providers before frontier upgrades.
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

This matches the research direction behind model cascades and learned routing: spend premium reasoning only when task complexity, reasoning depth, tool/risk posture, or explicit frontier context need justifies it. Ordinary context pressure first selects a provider with enough window at the current capability level.

### Memory Algorithm

The active runtime uses `lib/memory` with Neo4j as the canonical ledger and Graphiti MCP as a semantic sidecar that is enabled by default in Compose but optional for successful hot-path routing.

1. Session identity:
   - The proxy derives the session key from the stable project root/path when present, falling back to project metadata or the system prompt only when no path is available.
   - This keeps assessment cache, compaction cache, memory, and routing diversity stable when IDEs rewrite or compact the volatile prompt preamble.
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
LLM_PROXY_INTERNAL_ROUTING level=<1-5> effort=<none|minimal|low|medium|high|xhigh> speed=<1-5> reason=<slug>
```

The `LLM_PROXY_INTERNAL_ROUTING` sentinel is mandatory in the injected prompt contract. The proxy strips that sentinel line before returning the response and uses it only as internal routing metadata. For compatibility with models that learned the previous compact form, standalone legacy lines such as `effort=low speed=4 reason=playwright_smoke` or `speed=4 reason=commit_changes` are also consumed as private routing hints instead of being shown to users. If the selected model says the task needs a materially different level, the proxy reroutes inside the same request.

```dotenv
LLM_COST_TARGET=3
LLM_THINKING_TARGET=medium
LLM_SPEED_TARGET=4
LLM_ROUTING_POLICY=balanced
```

The targets are averages/preferences. Simple prompts are steered toward cheaper/faster models; complex agentic work can exceed the configured cost target when capability is more important. Large context is treated primarily as a fit/headroom constraint: context level rises only when less than 30% headroom remains in the current context tier, and the router keeps same-capability large-context providers eligible before upgrading solely for window size. Context compaction and AI summaries are handled by the memory layer before the next route is chosen.

| Variable | Values | Executive effect |
| --- | --- | --- |
| `LLM_COST_TARGET` | `1` to `5`, default `3` | Lower values favor savings and free/mini models; higher values allow more premium models when the task justifies it. |
| `LLM_THINKING_TARGET` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; default `medium` | Sets the preferred reasoning depth, from fast execution to deeper deliberation. |
| `LLM_SPEED_TARGET` | `1` to `5`, default `4` | Higher values prioritize latency; lower values permit slower high-capability models. |
| `LLM_ROUTING_POLICY` | `economy`, `balanced`, `speed`, `quality`; default `balanced` | Selects the operating posture: `economy` maximizes savings, `balanced` optimizes cost and quality, `speed` prioritizes latency, and `quality` allows more capable models when the task benefits. Unknown values safely fall back to `balanced`. |

Policy aliases are accepted for operator convenience: `cheap`, `cost`, `efficient`, `lowcost`, `low-cost`, and `savings` map to `economy`; `fast`, `latency`, and `throughput` map to `speed`; `capability`, `premium`, and `frontier` map to `quality`.

### Human Sign-Off Gate

Human approval is enabled by default. Large-model gates run hidden AI assessment only for a new task or explicit upgrade, and access assessment alone never creates approval state. If the assessed task carries `human_signoff` (`security_review` or real destructive/production-impacting execution), the proxy stops before provider execution and returns `LLM_PROXY_HUMAN_APPROVAL_REQUIRED`. Completion review, test generation, dry-run-first work, and normal large-model access do not create approval states. Trusted AI assessment can create `security_review` sign-off only when the deterministic request also shows security/high-risk intent.

The response includes an approval challenge and writes an audit event to `${DATA_DIR}/human-approvals.jsonl`. After review, reply with the exact `approved_by_user:<challenge>` token. The proxy also accepts the token as IDE tool output or an API retry with:

```text
X-LLM-Proxy-Approval: approved_by_user:<challenge>
approved_by_user=approved_by_user:<challenge>
```

The token is bound to a hash of the original request, task gate, shape, tools, and messages; expires after 15 minutes by default; and is stripped before upstream execution. The visible approval prompt and reply are stripped before routing the original request, so they cannot pollute assessment or provider context. API clients that need the old hard HTTP error can set `LLM_PROXY_HUMAN_APPROVAL_RESPONSE_MODE=http_error`. `/health` exposes enabled state, pending count, and audit file path. Local experiments can disable it with `LLM_PROXY_HUMAN_APPROVAL_ENABLED=false`.

## Memory Layer

The strategy section describes the memory and compaction algorithms. Runtime lives in `lib/memory`; Docker Compose enables local Neo4j by default for governance events, corrections, compacted archive refs, and recall hints. The in-process backend remains for tests or temporary non-Docker runs, but is not part of operator `.env`.

Models can request private memory work with first-line markers that the proxy strips before returning content to the client:

```text
LLM_PROXY_RECALL v=1 q="routing architecture" types=architecture,decisions budget=1200 reason=task_context
LLM_PROXY_MEMORY v=1 op=user_correction target=routing_policy type=preference confidence=high
```

`LLM_PROXY_RECALL` triggers one internal retry with recalled memory injected into the system prompt. `LLM_PROXY_MEMORY` records memory governance intent, including user corrections that should supersede older facts when the graph backend is enabled. Context compaction archives dropped turns as `memory://...` references and tells the next model to use `LLM_PROXY_RECALL` when it needs details.

Graphiti MCP runs as a semantic sidecar. The canonical ledger remains `lib/memory` backed by Neo4j; Graphiti receives memory events and compacted archives asynchronously through a retryable outbox. Recall stays canonical-first: direct Neo4j memory is injected first, and semantic Graphiti hints are appended only for explicit `LLM_PROXY_RECALL` requests when the sidecar answers within timeout.

Graphiti MCP uses this proxy instead of a real `OPENAI_API_KEY`: OpenAI-compatible URL `http://llm-proxy:18900/v1`, LLM model `auto-memory`, and local deterministic hash embeddings at `/v1/embeddings`. Sidecar ingestion stays local and cheap.

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
| `LLM_PROXY_PORT` | `18900` | Host port for llm-proxy: OpenAI, Responses, Anthropic bridge, and smart routing |
| `CODEX_PROXY_PORT` | `10531` | Host port for codex-proxy: Codex OAuth/auth shim used by llm-proxy as a backend |
| `DATA_DIR` | `/data` | Runtime data path inside the containers |
| `DEV_MODE` | `true` | Enables local development logging and behavior |

## Codex config

Codex can use the custom provider mode shown above, with `base_url = "http://localhost:18900/v1"`. In first-party ChatGPT provider mode, point both Codex backend surfaces at llm-proxy:

```toml
chatgpt_base_url = "http://<proxy-host>:18900/backend-api"
openai_base_url  = "http://<proxy-host>:18900/v1"
```

`openai_base_url` routes `/responses` inference through the proxy. `chatgpt_base_url` handles ancillary `backend-api/*` traffic and aliases Codex backend responses back to `/v1/responses`.

Codex must use **ChatGPT login** for `backend-api/*` passthrough. The proxy reverse-proxies that traffic to `chatgpt.com` using client token. Override upstream with `LLM_PROXY_CODEX_BACKEND_UPSTREAM`, or disable passthrough with `LLM_PROXY_CODEX_BACKEND_PASSTHROUGH=off`.

The proxy detects tool families from the request (`Task`, `spawn_agent`, `multi_agent_v1.*`) and adjusts routing accordingly.

Point custom `model_provider` configurations at `http://localhost:18900/v1`; reserve `codex-proxy` on port 10531 for the internal OAuth/auth backend.


## Troubleshooting

- Missing `WINDSURF_API_KEY`: run `node windsurf-auth.js --env-file .env`, then restart the proxy.
- Missing Claude credentials or Claude Code profile metadata: run `claude auth login --console`, choose Anthropic Console, then run `node claude-auth.js --env-path .env` and restart the proxy. If the helper says you are logged in with a subscription account, run `claude auth logout` and repeat the Console login.
- Missing `data/codex-auth.json`: run `npx @openai/codex login`, then rerun `./setup.sh`; setup copies the auth file into Docker's bind mount target.
- Empty `/v1/models`: confirm at least one provider family is enabled in `.env`, required credentials are present, and the matching Docker profile is running for Codex.

## Provider References

Research references for routing, memory, and compaction are listed in the strategy bibliography above. Provider integration references live here:

- [Claude Platform API authentication](https://platform.claude.com/docs/en/api/authentication/overview)
- [Claude Code authentication docs](https://code.claude.com/docs/en/authentication)
- [Claude Messages API docs](https://platform.claude.com/docs/en/api/messages)
- [GitHub Copilot Extensions LLM endpoint](https://docs.github.com/en/copilot/how-tos/use-copilot-extensions/build-a-copilot-agent/use-copilots-llm)
- [GitHub OAuth device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
