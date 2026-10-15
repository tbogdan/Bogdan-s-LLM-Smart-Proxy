# Provider catalog and pricing

The registry covers all 35 supported provider families in `config/provider-catalog.json`. The distributable snapshot, `data/model-catalog-evidence.json`, records official model identities, pricing observations, source URLs, observation times, scopes and coverage gaps. It is not an account entitlement list. Newly published models are not automatically promoted into production routing without capability and account validation.

## Refresh

```sh
node scripts/refresh-model-catalog.js --mode list --env-file .env \
  --output data/model-inventory.json \
  --catalog-output data/model-catalog-evidence.json
```

The private inventory uses mode 0600 and includes account exposure references. The distributable catalog excludes those references. The scan uses bounded model-list requests, four workers, a maximum of six pages per provider, and explicit timeouts. It performs no inference, context-window probing or billable token benchmarks. Authentication token exchange can be needed for Copilot. Codex uses the project's `data/codex-auth.json` or explicit `CODEX_AUTH_FILE`; it does not search other projects for credentials.

Public OpenRouter, Kilo, Hugging Face, LLM7, Cline, ModelScope and Nebius listings work without inference credentials. Other listings require the named key in the registry. Cloudflare needs an account ID or exactly one account returned by the token. A failure or missing key retains the last private observations as stale; it never means the model was retired. Listing success does not prove inference, credit balance or rate-limit headroom.

OpenAI, Claude, Codex, Windsurf, Copilot and Mistral pricing documents have dedicated parsers. These fail closed when their format changes. Other official HTML/documentation observations are retained with their original dates and source URLs; a model-list refresh does not renew their pricing timestamps. API responses refresh prices only when their units are explicitly supported. Review expiring promotions and conditional tables before applying them.

## Price rules

- Preserve provider identity. A hosted model's origin-vendor price is not its reseller price.
- Preserve currency, region, service tier, context tier, plan, cache read/write duration, promotions and additional non-token charges.
- OpenRouter/Kilo USD-per-token values become USD per million tokens. Negative dynamic-routing sentinels remain unknown. Hugging Face prices belong to provider-qualified IDs. LLM7 media/second/page rates never become token rates.
- Windsurf dollar references and credit multipliers remain subscription evidence. Copilot token references and legacy multipliers depend on billing plan. Kiro agent credits are not token prices. Codex subscription usage is not billed at OpenAI API rates.
- Unknown, expired, conditional or non-USD observations do not silently produce USD estimates. Default price freshness is seven days unless the source provides an explicit expiry. Anthropic cache-read/cache-creation tokens are additional to uncached input; OpenAI cached tokens are included in prompt tokens.
- The existing routing budget groups remain policy classifications, not fresh dollar quotes or measured quality rankings. Actual cost evidence is exposed separately as `price_evidence`. Historical audit dollar fields cannot replace fresh scoped evidence.

## Findings on 2026-10-15

GitHub Models was fully retired on July 30, 2026. Its routes are disabled on hydration, including routes loaded from an existing private providers file. Copilot is separate and remains supported. [Official retirement notice](https://docs.github.com/en/github-models).

NVIDIA has development/prototyping access and production licensing; no universal paid token tariff was verified. BigModel's current pricing application did not yield a verifiable tariff. Hyperbolic's current pricing page returned 404. These remain unknown; no reseller price or historical search snippet substitutes for their own current tariff.

Xiaomi V2.5 aliases began routing to V2.6 on October 14 and have a published October 21 sunset. Moonshot/Kimi's current lineup and cache TTL charges differ from the old K2/K2.5 catalog. DeepSeek peak/off-peak periods, Alibaba regions, SiliconFlow international/domestic currencies and Gemini promotions require explicit scope. See the per-provider notes and individual observation conditions in the snapshot.

Some source tables publish only display names. Those entries use `display:` identities and are evidence for operators, not invented API route IDs. Account listings retain actual IDs independently. Public model count includes these evidence identities and qualified reseller variants.

Codex with ChatGPT sign-in retired GPT-5.5 on October 14 at 19:00 UTC; its exact route is disabled in this subscription adapter. Direct OpenAI API pricing and access remain separate. Codex publishes credit token rates and speed multipliers; these are recorded as credits, without inventing a USD conversion or applying them to included subscription tasks. [Official Codex pricing](https://learn.chatgpt.com/docs/pricing).
