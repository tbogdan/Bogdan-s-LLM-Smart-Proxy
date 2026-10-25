# Provider and efficiency validation — 2026-10-25

Live target: Docker proxy at `127.0.0.1:18900`. Tests used explicit task IDs,
synthetic prompts and a real local `fixture.txt`. Tool continuations retained the
assistant call and matching result. Successful fallback was not counted as
successful access to the requested provider.

## Final live results

Each passing model completed four requests: exact text, streamed JSON with a
terminal marker, a `read` call with validated JSON arguments, and its exact final
tool result. All 12 requests returned HTTP 200 from the requested model.

| Model | Per-request latency | Complete tool loop | Input tokens: tool request / continuation |
| --- | --- | --- | --- |
| `codex/gpt-5.6-luna` | 0.86–1.60 s | 2 requests, 2 upstream dispatches | 343 / 376 |
| `codex/gpt-6-luna` | 0.93–2.00 s | 2 requests, 2 upstream dispatches | 343 / 376 |
| `antigravity/antigravity-preview-latest` | 8.74–9.87 s | 2 requests, 2 upstream dispatches | 4630 / 4724 |

Actual Codex CLI also executed `printf PROXY_FINAL_731`, returned the exact output,
exited 0 and completed its turn in 13.79 s including CLI startup and tool work.

The final Docker log window had no `API-ERROR`, `STREAM-ERR`, unsupported native
streaming, unknown input item, compatibility or hidden-continuation errors.
This is a bounded observation, not a claim about historical or future logs.

## Availability blockers

- **OpenCode free only:** probed cat-jam, mimo, space-bunny and DeepSeek flash.
  The native profile carries stable session/affinity headers, free authorization,
  streaming and the caller's real `read` schema. After the schema fix, DeepSeek
  reached upstream and returned HTTP 429 `FreeUsageLimitError`. Persisted reset
  evidence points to 2026-10-26 00:00 UTC. Other public-free routes share this
  account limit. No paid OpenCode fallback was used. Free inference and complete
  native-profile compatibility remain unverified until quota permits success.
- **NVIDIA:** repaired five truncated upstream IDs in the local provider data.
  Correctly addressed Llama 3.3 70B returned HTTP 410 with an upstream retirement
  date of 2026-08-26. GPT OSS 20B, Nemotron 3 Super and MiniMax M3.1 Flash returned
  HTTP 403 `Authorization failed`. These are not successful provider validations.
- **Antigravity preview-09-2026:** a probe fell back through rate-limited Mistral
  to Gemini. This did not qualify the requested Antigravity route. Only
  `preview-latest` is validated above.

## Repairs and efficiency

1. Preserve the `read` schema required by OpenCode native tool profiles even for
   passive/exact replies. Previously the proxy removed it and its own transport
   rejected the prepared request.
2. Advertise `proxy_retrieve_original` only when compressed originals exist.
   Previously tiny untouched results still gained this tool. A Codex fixture
   generated unnecessary retrieval rounds; final fixtures have exactly two
   dispatches for the two-request tool loop.
3. Add opt-in `LLM_PROXY_PROMPT_INJECTION=compact`, activated in local `.env` and
   verified inside the rebuilt container. Caller instructions remain; the full
   generic workflow manual and changing per-request clock are omitted. Codex
   continuation input fell from 4100 to 376 tokens, about 91%. Cache reads were
   zero in these small fixtures: no cache-saving claim is made.
4. Antigravity accepted multi-step replay but ignored later tool results in live
   tests, repeating `read`. Replay now uses one input step with explicit history
   boundaries and tool results labelled as data. Media remain in order. This is
   stateless replay, without `previous_interaction_id`; history is not sent both
   ways. The final proxy fixture returns the exact supplied tool result.

Antigravity still reports several thousand input tokens even for tiny prompts;
its agent overhead is substantially larger and slower than the tested Codex
routes. Provider-reported usage does not identify every internal agent component.
The adapter's wire format was checked against the
[official Interactions reference](https://ai.google.dev/api/interactions-api).

## Verification and evidence

- Regression tests demonstrated failures before each behavioral fix.
- Final full suite: **1099 passed, 0 failed, 1 skipped** (1100 total).
- `git diff --check` passed. Docker rebuilt with the final runtime changes.
- Local synthetic evidence: `/tmp/provider-proxy-validation/verified-summary.json`,
  `final-matrix.log`, per-case JSON files and `codex-final-events.jsonl`.
- Full test output: `/tmp/provider-final-suite.log`.

No commit or push performed. Prior unrelated workspace changes were preserved.

## Security follow-up

The Interactions adapter now accepts only the fixed official HTTPS endpoint.
Custom hosts, paths, query strings and local/metadata URLs fail before fetch or
credential attachment. Both streaming and non-streaming calls use
`redirect: "error"` so an upstream redirect cannot forward the API key elsewhere.
The transport uses a fixed Google hostname, not a caller-selected DNS target.
Two new regression tests failed before the fix; all 14 adapter/provider tests
passed afterward. Docker was rebuilt with the fix.

## Context and functional model slots follow-up

The supplied 01:55–01:57 UTC log showed successful ~73–79k-input requests on a
272k-context Codex route. The 128k output ceiling triggered a conservative 55%
compaction warning despite fitting the context, including a misleading unchanged
`128000 → 128000` cap. Early compaction now follows input pressure; the full
output ceiling still participates near the hard context boundary. Unchanged caps
are not logged as reductions.

Per the clarified requirement, the three-model ceiling now counts functional
models. A proven unavailable/context-incompatible pin can be replaced after
checking same-model alternatives. `modelHistory` retains historical identities;
`retiredModels` records replacement reasons. Three healthy models still prevent
adding a fourth specialist, including concurrent allocations.

An isolated real-proxy HTTP test grew a task beyond its original context and
verified exactly three upstream calls: small model, larger model, larger model.
No failed upstream probe or duplicate call was needed for this switch. Router
tests also cover replacement with all three slots occupied and persistent pins.

Final suite after these changes: **1104 passed, 0 failed, 1 skipped** (1105 total).
Docker rebuilt; live Codex smoke returned `CONTEXT_ROUTING_OK`, HTTP 200, one
dispatch, 6.52 s. Full output: `/tmp/context-functional-full.log`.
