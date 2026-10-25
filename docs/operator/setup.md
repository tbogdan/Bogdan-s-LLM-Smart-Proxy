# Setup and operation

Run `./setup.sh` with Docker Engine and Compose v2 available. One configured provider is enough. Set values in `.env`; never commit that file. New installs start the minimal proxy. `--memory` enables the optional graph stack; existing selected memory settings are preserved.

## Authentication

For Claude Console/API credentials, use [Claude Platform](https://platform.claude.com/). Set `ANTHROPIC_API_KEY` or use the supported extraction helper. Use the existing provider helper only when that provider is needed. Interactive login remains under your control:

```bash
node windsurf-auth.js --env-file .env
claude auth login --console
node claude-auth.js --env-path .env
node github-copilot-auth.js --env-file .env
npx @openai/codex login
```

Those host-side helpers may require the relevant CLI/Node runtime. The core container does not. Codex: set `ENABLE_CODEX=true`; setup reuses `data/codex-auth.json` or the existing `${CODEX_HOME:-$HOME/.codex}/auth.json`. Direct API providers use their configured key environment variable. Do not treat a generic GitHub token as proof of Copilot LLM entitlement.

## Connect clients

OpenAI-compatible clients use `http://localhost:18900/v1`, with your configured port. Use a discovered model ID or `auto`. Anthropic clients use `http://localhost:18900` as the API base, calling `/v1/messages`.

Prefer the setup command over hand-editing client files:

```bash
npm run proxy -- setup claude on [--model claude/claude-sonnet-4-6] [--no-restart]
npm run proxy -- setup codex on [--model codex/gpt-5.6-luna] [--no-restart]
npm run proxy -- setup all off
```

For `claude` it merges `ANTHROPIC_BASE_URL` (+ `ANTHROPIC_API_KEY=proxy`, the proxy trusts localhost and uses server-side keys; `ENABLE_TOOL_SEARCH=true` so Claude Code keeps optimistic ToolSearch through the proxy, which forwards `tool_reference` blocks and the client's `anthropic-beta` headers upstream) into `~/.claude/settings.json` without touching your model or permissions, and exports the same env globally in your shell profile. Claude Code, the VS Code / Cursor / Antigravity Claude extensions read the same file, so CLI and IDEs are covered together. For `codex` it adds a `[model_providers.llm-proxy]` Responses provider (`base_url http://localhost:18900/v1`, `env_key LLM_PROXY_API_KEY`) and selects it, preserving the rest of `~/.codex/config.toml`. Every mutation is preceded by a timestamped `.bak-proxy-*` backup; `off` restores it byte-for-byte.

Example Codex custom provider; merge it into your existing configuration without replacing unrelated settings:

```toml
model_provider = "bogdan-proxy"
model = "auto-coding"
[model_providers.bogdan-proxy]
name = "Bogdan LLM Smart Proxy"
base_url = "http://localhost:18900/v1"
wire_api = "responses"
```

An explicitly configured custom Responses provider may expose different native Codex features from its built-in provider. The proxy cannot grant capabilities absent from the client's schema.

For SDK clients, send a stable task and client ID. Generate a fresh task ID when the user starts different work. The returned task ID is available in `X-LLM-Proxy-Task-ID`.

## Diagnose

`LLM_PROXY_PROMPT_INJECTION=compact` keeps caller instructions and adds a short
proxy control prompt instead of the full workflow manual. It omits a per-request
clock value so an otherwise identical prefix stays stable. `full`, `hidden_only`
and `off` remain available. This reduces prompt overhead; it does not by itself
prove an upstream cache hit. Recreate the proxy container after changing `.env`.

Original-content retrieval is advertised only when tool history contains a
compressed original. Small unchanged tool results do not add a retrieval tool
or require an extra inference round.

The task model limit counts three **functional canonical models**, not all models
ever attempted. Unavailable or context-incompatible pinned models can be replaced;
the router prefers another eligible account for the same canonical model first.
`models` records occupied functional slots; `modelHistory` retains attempted model
identities and `retiredModels` records replacements. Ordinary continuations retain
their pin, and adding a fourth healthy specialist remains disallowed.

An oversized input triggers selection of a compatible larger-context route before
upstream dispatch. A large output ceiling alone does not trigger early transcript
compaction when the full input/output budget fits with headroom. Near the hard
context boundary, the complete output reservation still participates in fit checks.

`./setup.sh doctor` is read-only and makes no inference call. It distinguishes healthy runtime, configured routes, model list and unverified inference. A selected inference smoke is explicit:

```bash
docker compose exec llm-proxy node scripts/doctor.js --probe --model FAMILY/MODEL
```

That probe uses at most 8 output tokens and consumes account usage. Rate limit: honor Retry-After/reset and use another eligible route. Empty credits: the observed account is excluded until positive reset evidence or an operator reset. Expired auth: refresh through the provider's existing supported login. A timeout alone does not prove depleted credits.

## Upgrade and remove

Back up your configuration/data, update the source revision deliberately, then run `./setup.sh --upgrade`. It rebuilds the checked-out source; it does not pull Git history or replace credentials. `./setup.sh --uninstall` removes this stack without deleting the data volume or `.env`. No automatic purge is performed.

## Smart Groups

| Group | Purpose |
| --- | --- |
| `auto` | Automatic task-appropriate model |
| `auto-assess` | Assessment / classification |
| `auto-sm` | Small text tasks |
| `auto-memory` | Memory summaries |
| `auto-coding` | Coding and tool use |
| `coding-sm` | Small coding tasks |
| `auto-thinking` | Reasoning |
| `auto-tools` | Tool-capable work |
| `auto-text` | Text |
| `auto-max` | High capability when needed |

## Docker Profiles

The base stack runs the proxy. `codex` enables the local Codex transport;
`memory` enables Graphiti/Neo4j. `discovery` is an explicit legacy full-probing
service; prefer the read-only model-list script for routine inventory refresh.

## Model and price discovery

Run `node scripts/refresh-model-catalog.js --mode list --env-file .env`. This only calls configured model-list endpoints; it performs no inference. The resulting private `data/model-inventory.json` records account exposure, not proven capability. Native OAuth providers may require their existing dedicated discovery adapters.

`data/model-catalog-evidence.json` records dated direct API Standard prices and source URLs. `/v1/models` exposes `price_evidence` only for exact model/provider identity. Set `billing_basis: "api"` on an explicitly direct API route to apply those prices; subscriptions remain unknown in USD. New listed IDs are not promoted implicitly; the explicit seed-refresh command adds selected catalog routes with metadata heuristics and `probe: false` (catalog-only, not inference-validated). Long-context pricing and plan multipliers require separate evidence.

To refresh the bundled fallback routes without inference, run `node scripts/refresh-seed-from-catalog.js --write`, then `node scripts/merge-seed-into-providers.js --write`. The second command preserves existing discovered/provisioned routes and writes a backup. Generated seed routes carry `probe: false`, so discovery marks them catalog-only instead of probing every model.
