# Auto-routing recovery — 2026-10-25

## Confirmed incidents

The IDE now sends `auto-coding`; original proxy logs contain ROUTING-PROFILE and Route records for that group. The selectable custom model exists. Claude Code's generic access/authentication error can instead describe a terminal upstream route rejection.

At15:17:58Z and15:18:37Z, the Ollama route for Mistral Large4 returned403 with an exact typed model-rollout-unavailable message. A previous Mistral subscription-tier rejection had already been repaired. Generic403 policy failures remain terminal. The Ollama exception is restricted to the Ollama family, status403, api_error type, exact rollout wording and optional UUID reference. Availability is scoped to credential/endpoint/model for five minutes, not the whole account.

OpenRouter's local MiniMax route had legacy `upstream_model: minimax`, despite canonical model `openrouter/minimax/minimax-m2.5:free`. Request construction used that incorrect explicit value verbatim. The wire adapter now repairs only this exact vendor-only corruption shape for nested OpenRouter IDs, preserving complete slugs, custom aliases and other provider families. Local metadata was backed up before correcting the same field; `alive:false` was preserved. No route was manually promoted as inference-validated.

The assessment loop ignored `taskTerminal` from guarded dispatch. It iterated candidate labels while task pinning kept the same failed assessor. A bounded log snapshot counted24MiniMax400attempts. A terminal assessment failure now ends that helper loop and lets the existing heuristic/approval flow proceed. This does not ignore policy checks on the primary request.

Assessment timeout used Promise.race without cancelling the losing upstream operation. Its work could continue fallback after a five-second skip. `withDeadline` supplies an isolated child ownership scope, cancellation controller and retained-byte lifetime, links parent cancellation, aborts actual HTTP/native work at deadline and blocks late dispatch. Parent conversation work remains available. Each assessor attempt retains its configured deadline; this does not claim a five-second total budget across all candidates.

Assessment metadata now records the actual served provider after runtime fallback, rather than its initial candidate label. The separate outer direct-route success/affinity attribution inconsistency remains documented in the model-complexity audit and is not claimed fixed by this patch.

## Verification

Regression fixtures use local HTTP upstreams and no paid/provider inference. They cover full OpenRouter model ID on the wire, terminal assessment failure without six repeated calls, timeout cancellation without late fallback, parent continuation/client cancellation, actual assessor identity, Ollama rollout fallback and next-task cooldown avoidance. Existing generic403 policy and native/free restrictions remain enforced. Final test and rollout counts are recorded in the task evidence directory after validation.

Final full suite after the NVIDIA correction:1322tests,1321passed,0failed,1skipped,65.835s. Independent review found no blocking issue. Docker image hashes matched all five changed production modules before rollout; a rollback image was retained.

## Live-probe correction

The first post-rollout native `/v1/messages` probe using `auto-coding` failed403 in3.182s. Evidence is retained as `live-auto-probe.json`; this is not a successful validation. Logs identified SambaNova401 followed by NVIDIA403 with JSON `status:403`, `title:Forbidden`, `detail:Authorization failed`. The exact NVIDIA-family authentication envelope now maps to account authentication failure, using existing credential-hash isolation and fallback. Different families, modified detail text and policy403 remain terminal. The focused21-test gate includes first-request fallback, next-task avoidance across another model sharing the same credential and eligibility after credential rotation. No credentials were changed or exposed.

Final live native Anthropic-wire probe: auto-coding, HTTP200, exact AUTO_ROUTE_OK_583 response,7.341s. Runtime logs show NVIDIA authorization rejection no longer terminates the request; actual successful fallback is Gemini3.5Flash. Earlier failed probe remains preserved separately. Production module hashes match the tested workspace; container retains2GiB/2CPU/256PID controls. This validates a small complete request, not large-context latency or every configured provider credential.
