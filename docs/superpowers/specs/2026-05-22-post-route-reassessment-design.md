# Post-Route Reassessment Design

Date: 2026-05-22

## Goal

Make smart routing adapt at each agentic step without paying for a hidden classifier call on every hop. The selected provider should emit a private assessment marker for the next route whenever it responds. The proxy should strip that marker, cache it, and use it to keep or adjust the next provider choice.

## Current Behavior

The proxy already injects a private marker contract:

```text
LLM_PROXY_TASK_DIFFICULTY level=<1-5> effort=<none|minimal|low|medium|high|xhigh> speed=<1-5> reason=<slug>
```

When a provider returns the marker, `routing.js` strips it from the user-visible response, converts it into a routing profile, and can reroute if the marker says the current provider is materially underpowered.

When a provider does not return the marker, the proxy can cache the existing hidden assessment as `post_route_fallback`. On the next request in the same session, the cache hit sets `_llmProxyDifficulty`, which prevents a new hidden assessment. This is good for cost, but too sticky for agentic loops where assistant and tool messages may change the next step from inspection to editing, testing, or debugging.

## Desired Behavior

Use a hybrid policy:

- Prefer provider-emitted post-route markers as the authoritative next-hop assessment.
- Treat fallback cached assessments as temporary continuity, not as authority after transcript progress.
- Run a hidden assessment only when the provider did not emit a usable marker and the conversation advanced enough that the next step may differ.
- Keep passive/direct answers lightweight and do not require markers for exact replies.

## Prompt Contract

The existing routing assessment prompt should be reframed as a next-step contract:

- The first private line describes the likely next route after the current response or tool call.
- The marker must be emitted before normal content when the request is not passive/direct.
- The proxy removes the marker before the user or client sees it.
- Tool-bearing requests still prioritize valid tool calls; the marker must not replace action.

The wording should make clear that the marker is not user-facing prose and is not a benchmark or security signal by itself.

## Cache Semantics

The session assessment cache should distinguish two origins:

- `post_route`: provider emitted a marker during the current response. This is trusted for the next route, as long as the same user request is still being processed and the cache is fresh.
- `post_route_fallback`: provider did not emit a marker, so the proxy saved the prior assessment. This can be reused only when no meaningful transcript progress happened after that assessment.

Meaningful transcript progress means assistant/tool state changed after the cached assessment. Examples include:

- a new assistant tool call;
- a new tool result;
- a new assistant response body;
- a changed message count or transcript fingerprint for the same last user message.

The ten-minute freshness window remains useful, but it is not enough by itself. A fresh fallback cache can still be stale if the agent loop progressed.

## Routing Flow

Before routing:

1. Look for a cached post-route assessment for the current session.
2. If it is `post_route`, apply it and skip hidden assessment unless normal staleness rules fail.
3. If it is `post_route_fallback`, apply it only when the transcript has not advanced since it was stored.
4. If fallback cache is stale by transcript progress, drop it and allow `applyAiTaskAssessmentIfNeeded` to run normally.

After a provider response:

1. If the response contains `LLM_PROXY_TASK_DIFFICULTY`, strip it, log `ASSESS`, cache it as `post_route`, and let existing marker reroute logic run.
2. If the response has no marker but `_llmProxyDifficulty` exists, cache it as `post_route_fallback` with transcript metadata.
3. If neither exists, do not create a cache entry.

## Reroute Behavior

Existing marker-based reroute behavior should stay intact:

- If a marker says the current provider is too weak or materially wrong for the next step, reroute inside the same request when allowed.
- Limit reroute loops with the existing `_assessmentReroutes` budget.
- Skip the provider that produced the reroute marker using `_assessmentSkipProviders`.

The change is mainly about avoiding stale fallback reuse, not about making reroutes more aggressive.

## Data Model

Each cache entry should keep enough metadata to decide whether fallback reuse is safe:

```js
{
  profile,
  timestamp,
  lastUserText,
  provider,
  origin,              // "post_route" or "post_route_fallback"
  messageCount,
  transcriptFingerprint
}
```

The fingerprint can be simple and deterministic, based on recent message roles plus compact text/tool-call identifiers. It does not need cryptographic strength; it only needs to detect that the agent loop advanced.

## Testing

Add focused routing tests:

- Provider emits marker, proxy strips it, caches `post_route`, and the next route does not call the hidden classifier.
- Provider omits marker, transcript does not advance, fallback cache can be reused.
- Provider omits marker, transcript advances with assistant/tool messages, fallback cache is dropped and hidden assessment runs.
- Marker content is never returned to the client for streaming or non-streaming responses.
- Reroute marker behavior still skips the underpowered provider and respects reroute limits.

Update transform tests to assert that the injected wording describes next-step routing, while passive direct-answer mode still suppresses private markers.

## Non-Goals

- Do not run hidden assessment on every hop unconditionally.
- Do not require markers for passive/direct exact answers.
- Do not expose routing markers or classifier details to the client.
- Do not change provider scoring beyond the assessment profile already used by routing.
