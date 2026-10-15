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

`data/model-catalog-evidence.json` records dated direct API Standard prices and source URLs. `/v1/models` exposes `price_evidence` only for exact model/provider identity. Set `billing_basis: "api"` on an explicitly direct API route to apply those prices; subscriptions remain unknown in USD. New listed IDs require verified adapter/capability metadata before promotion into `providers.json`. Long-context pricing and plan multipliers require separate evidence.
