# Auto-routing eligibility correction — 2026-10-25

## Incident and root cause

After a successful small smoke request, real Claude Code requests still failed with the generic selected-model error. Logs at15:38:40–15:39:10UTC show repeated Cloudflare404code7003 against `/client/v4/accounts/me/ai/v1/chat/completions`. `CLOUDFLARE_ACCOUNT_ID` was absent in both host configuration and container environment. The loader only substituted the placeholder when the setting existed and otherwise left the route eligible. This is incomplete provider configuration, not a missing auto-coding group or a client authentication failure.

The loader now checks both seed and persisted-provider hydration. Standard Cloudflare API URLs require a32-character hexadecimal account ID in the account path. Unresolved/invalid account paths are disabled with a configuration reason before any dispatch. A valid explicit account URL is preserved; custom gateway endpoints are preserved. No account discovery request, credential change or account switch was performed.

Automatic selection also treated providers without observations optimistically (`success_rate=1` at zero requests). This can put untested catalog entries before routes with successful inference history. The selection correction gives an adequate, already admissible observed route priority while retaining unknown routes as fallback. Observed history is a routing prior, not proof of current credential access or a new capability. Context, tools, complexity, price-policy gates, within-task pinning and explicit model selection remain constraints.

## Required verification

The configuration regression suite must prove an unresolved Cloudflare account produces zero upstream calls and cannot be revived by metadata merging, while valid account IDs and custom gateways remain supported. Automatic-selection fixtures must check actual dispatch after runtime ranking, tool-bearing large-context requests, preservation of explicit model selection and pins, fallback after observed routes fail, and no preference for an inadequate small model on complex work. Final runtime evidence is recorded after full tests and rollout; a small successful text probe alone is insufficient evidence for a large tool-bearing request.

## Identity correction

The persisted catalog contains673rows and41duplicate configured names. Runtime selection used provider names as identities: a healthy duplicate could be admitted but resolved through the first disabled entry sharing its name. Hydration now collapses exact transport/model/account duplicates, with any explicit disabled state winning. Different identities remain distinct and receive stable internal names; original names are reserved against suffix collisions. Credential material is never printed or embedded in names. Local offline hydration produces667routes with667unique names;70members of genuinely ambiguous groups remain available with an ambiguity marker. Historical success under an ambiguous old name is not used to promote those routes. OR-MiniMaxM25 now resolves to one inactive route.

## Orchestrator cost selection

The user requested cost-aware model selection both for this development session and for the proxy, and explicitly confirmed that Auto should control model and thinking effort. The local vendored matrix and model dataset remain the source of role/effort decisions; no prices were invented or copied from stale prose tables. Runtime evidence shows configured gpt-6-luna, gpt-6-sol and gpt-6-astra routes have successful history and declared low/medium/high/xhigh controls. Their effective configured context is272k, not the larger public/model-family context shown elsewhere. The inventory does not establish max support, so max must not be assumed.

Simple/mechanical tasks map to W/Luna; standard implementation to S/Sol; difficult debug/review to X/Sol at the registry effort; exceptional task complexity to F/Astra. Context pressure alone does not create frontier intent. Registry effort is bound to an exact route that declares support; duplicate model IDs do not lend effort support to another route. Auto overrides client effort with the allocated registry effort; an explicit model keeps manual effort. A task continuation keeps its model allocation. Decision logs distinguish requested/effective model and effort and identify the registry as the optimization basis. Historical inference preference cannot move an unrated model ahead of an admitted registry match.

The native Anthropic gateway now translates valid output_config.effort into the compatible request, allowing explicit-model high effort to survive translation and Auto to replace it deliberately. Local HTTP regression fixtures cover Auto/high to Luna/low and explicit Astra/high remaining Astra/high. These are proxy fixtures, not claims of external model benchmark performance or subscription billing savings.

For this development session, the independent final review was explicitly delegated to gpt-6-sol at high reasoning with a compact fresh context. This does not claim the root conversation's model was changed, or that earlier inherited agents ran on cheaper models.

## Assessment latency and redundant dispatch

The AI assessment loop now enforces a global budget (`LLM_PROXY_AI_ASSESSMENT_GLOBAL_BUDGET_MS`, default 8000 ms) in addition to the per-candidate timeout. Once the global deadline is reached, remaining candidates are skipped with `AI-ASSESS-SKIP: global budget exhausted`, instead of each candidate consuming the full per-candidate timeout. Per-candidate timeout remains capped by the remaining budget. Approval, security and provider gates are unchanged. This bounds worst-case assessment time without removing fallback candidates when the budget is sufficient. Deterministic classification (direct answers, identity/exact replies) continues to skip AI assessment. No billed-cost or latency guarantee is claimed; the change is a bound on dispatch time, not a measured production result.
