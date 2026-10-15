# Provider catalog refresh execution supplement

Continues approved unification Task 3 and the user's explicit all-provider refresh request. Native code implementation; independent official-source research by provider family.

Goal: every supported family has an explicit current catalog/pricing observation or a named access/evidence gap. Preserve direct-provider identity, units, currency, context tiers, service tiers, plan/promotional conditions and exact model IDs. Never treat missing prices as free, copy reseller prices to direct routes, infer entitlement from a public listing, or retire models on a transient listing failure.

1. Enumerate supported/core/legacy families plus seeded/runtime routes. Research official pricing and retirement evidence independently.
2. Extend read-only listing refresh to cover native APIs, pagination, public catalogs, account model lists and provider-wide coverage states. No inference probes. Add tests rejecting unit/identity/tier conflation, negative sentinels, missing credentials and partial failures.
3. Reconcile observations into dated public model/price evidence and seed metadata; disable only officially retired routes. Preserve runtime private data and credentials. Expose correct provider-specific pricing through runtime hydration.
4. Run focused regressions, bounded real model listing scan, full suite and build checks; publish a provider coverage table with exact remaining gaps. Commit and integrate locally after green checks; no GitHub push/deploy.

Review focus: Anthropic token accounting differs from OpenAI; catalog pagination can mimic retirement; OpenRouter/Kilo negative auto-route prices mean unknown; API keys and OAuth/subscription billing differ; failed refresh retains previous evidence with stale markers.
