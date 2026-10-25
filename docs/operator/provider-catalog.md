# Provider catalog and pricing

The registry covers all 38 catalog families in `config/provider-catalog.json` (37 listing families plus `antigravity`, a curated-only Interactions API family with no listing endpoint). The distributable snapshot, `data/model-catalog-evidence.json`, records official model identities, pricing observations, source URLs, observation times, scopes and coverage gaps. It is not an account entitlement list. Newly published models are not promoted implicitly by a pricing refresh. The explicit seed-refresh command can add current catalog routes with metadata heuristics and `probe: false`; those routes are catalog-only, not inference- or account-validated.

## Refresh

```sh
node scripts/refresh-model-catalog.js --mode list --env-file .env \
  --output data/model-inventory.json \
  --catalog-output data/model-catalog-evidence.json
```

The private inventory uses mode 0600 and includes account exposure references. The distributable catalog excludes those references. The scan uses bounded model-list requests, four workers, a maximum of six pages per provider, and explicit timeouts. It performs no inference, context-window probing or billable token benchmarks. Authentication token exchange can be needed for Copilot. Codex uses the project's `data/codex-auth.json` or explicit `CODEX_AUTH_FILE`; it does not search other projects for credentials.

Public OpenRouter, Kilo, Hugging Face, LLM7, Cline, ModelScope and Nebius listings work without inference credentials. Other listings require the named key in the registry. Cloudflare needs an account ID or exactly one account returned by the token. A failure or missing key retains the last private observations as stale; it never means the model was retired. Listing success does not prove inference, credit balance or rate-limit headroom.

OpenAI, Claude, Codex, Windsurf, Copilot and Mistral pricing documents have dedicated parsers. These fail closed when their format changes. The 2026-10-24 run parses OpenAI (including the new 30-minute/12-hour cache-write columns), Claude, Codex, Copilot and Mistral; Windsurf's page no longer exports machine-readable data, so its retained evidence stays dated until credentials or the List Models API can refresh it. Other official HTML/documentation observations are retained with their original dates and source URLs; a model-list refresh does not renew their pricing timestamps. API responses refresh prices only when their units are explicitly supported. Review expiring promotions and conditional tables before applying them.

## Seed refresh without inference

The dated catalog can also fill the bundled fallback routes without calling a model:

```sh
node scripts/refresh-seed-from-catalog.js --write
node scripts/merge-seed-into-providers.js --write
```

`refresh-seed-from-catalog.js` fills missing route metadata from the catalog (context window, output limit, capabilities, display name, source), applies published-family defaults and name-based capability/tier heuristics, and only promotes current canonical chat models. Generated entries carry `probe: false` and `probe_skip_reason: "catalog_only_no_inference"`, so the discovery daemon records them as catalog-only instead of spending tokens probing every model. The merge script adds missing seed routes to the local `providers.json` while preserving discovered/provisioned routes, alive state, last-test timestamps and benchmark evidence; it writes a timestamped backup first. These are metadata claims, not proof of inference or account access.

The 2026-10-24 run expanded `seed-providers.json` from 241 to 500 routes (259 additions: Kimi, Xiaomi, Together, Fireworks, xAI, Perplexity, Nebius plus current flagship models for existing families) and merged 296 missing routes into the local runtime provider file. Pricing and capability evidence for those routes still comes from `data/model-catalog-evidence.json`.

## Price rules

- Preserve provider identity. A hosted model's origin-vendor price is not its reseller price.
- Preserve currency, region, service tier, context tier, plan, cache read/write duration, promotions and additional non-token charges.
- OpenRouter/Kilo USD-per-token values become USD per million tokens. Negative dynamic-routing sentinels remain unknown. Hugging Face prices belong to provider-qualified IDs. LLM7 media/second/page rates never become token rates.
- Windsurf dollar references and credit multipliers remain subscription evidence. Copilot token references and legacy multipliers depend on billing plan. Kiro agent credits are not token prices. Codex subscription usage is not billed at OpenAI API rates.
- Unknown, expired, conditional or non-USD observations do not silently produce USD estimates. Default price freshness is seven days unless the source provides an explicit expiry. Anthropic cache-read/cache-creation tokens are additional to uncached input; OpenAI cached tokens are included in prompt tokens.
- The existing routing budget groups remain policy classifications, not fresh dollar quotes or measured quality rankings. Actual cost evidence is exposed separately as `price_evidence`. Historical audit dollar fields cannot replace fresh scoped evidence.

## Findings on 2026-10-24

GitHub Models was fully retired on July 30, 2026. Its routes are disabled on hydration, including routes loaded from an existing private providers file. Copilot is separate and remains supported. [Official retirement notice](https://docs.github.com/en/github-models).

Xiaomi MiMo V2.5 and V2.5 Pro were retired on October 21, 2026 at 10:00 UTC+8; their legacy IDs no longer work. The registry now records `modelRetirements`, the evidence marks the models `deprecatedAt`, and their price rows carry an expiry so they cannot be used as live USD estimates. V2.6 real-time and Batch rates are recorded separately. [Official pricing](https://mimo.mi.com/docs/en-US/price/pay-as-you-go).

Moonshot/Kimi will stop admitting new users to K2 series models on October 31, 2026 and plans to retire all K2 series by the end of December 2026; the registry records that future retirement. Kimi K3.1 Pro and K3.1 Pro Highspeed are now in the catalog with their 5-minute and 1-hour cache-write tiers. [Official pricing](https://platform.kimi.ai/docs/pricing/chat).

The OpenAI pricing document changed layout: it now publishes short- and long-context tables with separate 30-minute and 12-hour cache-write columns. The parser was updated and the snapshot records both write tiers; existing Standard/Batch/Flex/Fast/Ultrafast semantics are preserved. [Official pricing](https://developers.openai.com/api/docs/pricing).

Windsurf's model page no longer exports `modelCostData`. Its tables are client-rendered and account-scoped, so the document parser fails closed and keeps the prior subscription/credit evidence rather than inventing current rates. Use the List Models API for account-specific data. [Official models page](https://docs.devin.ai/desktop/models).

Reseller rates moved materially in this refresh: OpenRouter and Kilo repriced many routes, and Hugging Face/LLM7/Nebius refreshed their published rates. Direct tables re-read on October 24 (Groq, DeepSeek, xAI, Together, SambaNova, Fireworks, SiliconFlow, Kimi, Ollama, BigModel, Alibaba Qwen-Max/DeepSeek, Perplexity Agent API, Cloudflare DeepSeek 1017) are recorded with today's observation time. New identities include MiniMax M3.1 Flash, DeepSeek V4.1 Flash 1017, Muse Spark Open, Reflection Beam, NVIDIA Nemotron 3.5 Super VL and Ember-1.

NVIDIA has development/prototyping access and production licensing; no universal paid token tariff was verified. BigModel's current public table is now machine-readable in CNY and replaces the earlier unverified rows. Hyperbolic's current pricing page still returns no verifiable tariff. These remain unknown where the vendor publishes no usable rate; no reseller price or historical snippet substitutes for its own current tariff.

DeepSeek peak/off-peak periods, Alibaba regions, SiliconFlow international/domestic currencies, Gemini promotions and Kimi cache TTLs require explicit scope. See the per-provider notes and individual observation conditions in the snapshot.

Some source tables publish only display names. Those entries use `display:` identities and are evidence for operators, not invented API route IDs. Account listings retain actual IDs independently. Public model count includes these evidence identities and qualified reseller variants.

Codex with ChatGPT sign-in retired GPT-5.5 on October 14 at 19:00 UTC; its exact route is disabled in this subscription adapter. Direct OpenAI API pricing and access remain separate. Codex publishes credit token rates and speed multipliers; these are recorded as credits, without inventing a USD conversion or applying them to included subscription tasks. [Official Codex pricing](https://learn.chatgpt.com/docs/pricing).
