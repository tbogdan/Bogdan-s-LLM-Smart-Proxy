# Provider catalog refresh

- Scope: approved unification Task 3 plus explicit request to scan every supported provider and refresh current model/pricing evidence.
- Worktree: provider-catalog-refresh, isolated from main c9db81625474bc888934df6e20dfd50fd6e0c82f.
- Official source research: all 35 families. Three independent read-only research shards; native implementation by parent.
- Initial consolidated evidence: 2,551 model identities and 2,501 scoped price observations. Source URLs/dates retained. Subscription/credits, USD/CNY, context, service tiers, regional prices and promotions remain distinct.
- Registry, bounded listing scanner, six dedicated document parsers, conservative public-evidence merge and private-account inventory separated.
- Lifecycle: GitHub Models fully retired; exact Codex GPT-5.5 subscription route retired October 14, direct OpenAI API unaffected.
- Independent source review found three defects: Responses cache schema, placeholder metadata overwrite, Windsurf failed-empty listing. Fixed with regression tests; follow-up review found no unresolved findings.
- Focused verification: 24 tests passing. Complete verification passed: proxy 1003 pass, 0 fail, 1 skip; orchestrator 280 pass; read-only 35-provider scan; Docker build; zero vulnerabilities; no secret or name-hygiene violations. Final snapshot 2893 model identities / 2503 scoped price observations.
- No inference/billable context probes. No push or deployment. Native merge/commit authorized by original integration scope; current user also authorized current CLI credential import and local deployment. Secrets imported only into ignored primary runtime files.
- Private source archives and validation reports: /Users/bogdan/.codex/recovery/provider-refresh-20261015.
