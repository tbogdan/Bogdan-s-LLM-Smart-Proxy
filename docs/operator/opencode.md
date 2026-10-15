# OpenCode Console and Go

The proxy supports two independent provider families: `opencode` (Console pay-as-you-go, including limited free models) and `opencode-go` (included subscription consumption). Both use the user's existing OpenCode API keys. The installed app and current Console workspace configuration are discovery evidence; a cached Models.dev catalog alone is not sufficient evidence of current availability or cost.

## Import and provision

```sh
node scripts/provision-opencode.js --env-file .env \
  --auth-store "$HOME/.local/share/opencode/auth.json" \
  --catalog-output data/model-catalog-evidence.json
docker compose up -d --build llm-proxy
```

`--auth-store` is explicit and imports only the two OpenCode API credentials. Other providers' OAuth sessions and MCP credentials are not imported. Without this flag, provision uses `OPENCODE_API_KEY` and `OPENCODE_GO_API_KEY` already present in the supplied env file. Env and runtime files are written atomically with mode 0600. Model-list access uses GET only; provisioning performs no inference and creates no account, subscription, key or credit purchase.

Discovery uses `GET https://opencode.ai/console/api/v2/config` with Bearer authentication. It reads each credential's own provider configuration, including model-specific endpoint, SDK format, capabilities, context limits and price tiers. `x-opencode-org-id` stays in private environment configuration; it is excluded from public catalog evidence. Routes missing from a newer successful snapshot become disabled. A failed refresh preserves the prior configuration.

## Cost classes

| Field                  | Meaning                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `free_limited`         | Explicit zero input/output tariffs across published tiers; rate, region and promotion restrictions still apply |
| `paid`                 | Console model with published nonzero API token tariffs                                                         |
| `subscription_metered` | Go model consumes included allowances; published dollar token rates are reference consumption values           |
| `unknown`              | Missing or incomplete tariff evidence; never assumed free                                                      |

Free candidates remain in the public evidence catalog. `OPENCODE_NATIVE_COMPAT=true` enables the verified Big Pickle native compatibility profile; other free candidates remain disabled until individually verified by the bounded benchmark. Big Pickle requires a real caller-supplied function named `read`, with a string `path` parameter. The proxy does not insert a fake tool, execute tools, or inject OpenCode system instructions. Requests without that capability return 403. Native inference streams upstream; nonstream clients receive a collected Chat Completions response with tool calls and measured usage preserved. Explicit free requests, including aliases, cannot use paid fallback or paid helper roles after rate limits or other failures.

`GET /v1/models` exposes `billing_class`, `billing_basis`, `price_evidence`, `access_policy` and any `required_tools`. Go retains token reference rates but does not present them as a USD charge per request. Context tiers and cache read/write rates remain distinct. Actual subscription tier, balance, reset time and remaining allowance are unknown until observed; having a key does not prove remaining quota. Models may change between snapshots.

## Communication and task cache

The model's declared package selects its upstream format: OpenAI Chat Completions (also Mistral-compatible models), OpenAI Responses, Anthropic Messages, or Gemini generateContent. Streaming converts native SSE incrementally into the proxy's existing Chat Completions stream, preserving function calls, usage and Gemini tool thought signatures. Unsupported typed APIs are disabled rather than sent a chat payload.

Console paid and Go requests use the proxy's own `bogdan-llm-smart-proxy/1.0.0` User-Agent and a stable, scoped, hashed `x-opencode-session` per task. The opt-in Big Pickle profile reproduces the observed OpenCode 2.0.26 desktop wire profile: `opencode/latest/2.0.26/desktop`, the `/inference/v1/chat/completions` endpoint, the public anonymous credential, and the session/client/affinity headers. It never sends the user's Console key or organization ID on that free route. Session IDs follow OpenCode's native descending timestamp format, with creation time persisted for the task and a deterministic scoped suffix; they are not rotated to avoid limits. Credentials are not forwarded between providers. Model pinning and the three-model task limit remain enforced. Console and Go routes for the same upstream model share canonical identity, so account/plan failover does not consume an extra model slot. Rate-limit/credit failures preserve HTTP status and retry headers for the existing account availability and fallback policy. Client disconnects abort upstream work; failed or incomplete streams are not replayed after output has been sent.

Sources: [Console inference](https://opencode.ai/v2/docs/console/api/inference/), [workspace configuration](https://opencode.ai/v2/docs/console/api/), [Go limits and client requirements](https://opencode.ai/v2/docs/console/go/).

## Validation on 2026-10-15

Live Go inference succeeded for GPT-6 Luna (Responses), Claude Haiku 5.5 (Messages), and Gemini 4 Argon Contributor (Gemini). Console authenticated model discovery, but a paid Mistral inference returned 402 (insufficient account credit). Initial Big Pickle requests returned 403 `FreeTierError`; copying the UA alone did not fix them.

A process-scoped TLS proxy inspected the installed desktop app's bundled CLI with a temporary CA supplied only to that child process. No system trust store or normal app session was changed. Native Big Pickle inference and an exact replay both returned 200. Controlled comparisons isolated public authentication, endpoint/profile, native session-ID format and a real caller `read` tool. A new request using only the caller's own prompt and read schema returned 200; no native harness prompt or tool catalog was copied into requests. The implemented adapter subsequently passed live nonstream and SSE calls on the same task, approximately 1.8 and 1.4 seconds. This proves Big Pickle compatibility for that capability profile, not universal access to every free model or a measured cache-hit saving.

Official repository reports also identify free-tier rejection when native read/shell tools are withheld: [read-tool issue](https://github.com/anomalyco/opencode/issues/51315). Current upstream [migration proxy](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/lib/inference-proxy.ts) documents that inference owns availability/free-tier policy, and maps legacy Zen routes while stripping the `public` placeholder before anonymous upstream requests. Native captures and imported credentials stay in private ignored storage; versioned artifacts contain no session transcripts or keys. No credits were purchased.

## Intensive free-model validation and selection

```sh
node scripts/benchmark-opencode-free.js --providers data/providers.json
node scripts/benchmark-opencode-free.js --run --promote \
  --providers data/providers.json --output data/opencode-free-benchmark.json
```

The default is a dry run. The explicit run accepts only OpenCode Console models with fresh, official, explicitly zero input/output tariffs across context tiers. It never imports or sends a paid API credential, falls back to a paid model, executes model-generated code, or reads host files. The `read` tool uses a virtual fixture file for a real tool-result round trip. Each fixture task uses one model and a stable native-format session; the warm-cache pair reuses its task.

The bounded suite covers exact replies, JSON arithmetic, code tracing, summary extraction, forced tool calls, tool-result continuation, SSE text/tool arguments, repeated cache prefixes and two concurrent independent tasks. Limits: 220 requests, 15 minutes, 20 seconds per request and maximum two in flight. A 402/429 stops the entire batch and preserves Retry-After evidence; no identity/account rotation or automatic retry is used. Two transport failures stop that model's remaining cases. Reports record latency p50/p95, transport success, objective fixture pass rates, token totals and observed cached input. HTTP 200 alone does not pass correctness checks.

Promotion requires at least 12 samples, at least 95% transport success, 80% fixture correctness overall and within measured categories, complete token usage reporting, and all tested tool/SSE checks passing (at least two of each). Failed requalification disables a previously promoted model. Qualified zero-tariff models get the native transport profile and measured evidence in private runtime configuration. The routing policy applies a small bounded bonus for fresh fixture reliability, correctness, latency and matching coding/summary category; difficult tasks retain existing quality rules. Evidence expires after 24 hours. This is a synthetic fixture result, not a general intelligence score; static model quality claims are not rewritten. A selected model remains pinned within its task despite later benchmark/ranking updates. `GET /v1/models` exposes `performance_evidence` for inspection.
