# Verification and delivery record

## Repeatable local performance baseline

Run all four performance suites through a real temporary `llm-proxy.js` child
and a fixed local synthetic upstream:

```bash
npm run benchmark:fixture -- --output=.superpowers/sdd/2026-10-25-performance-hardening/performance-latest.json
```

This command never loads provider credentials or calls remote inference. It
creates a temporary provider catalog and data directory, then removes them.
The artifact contains `latency`, `throughput`, `large-body` (exactly 1 MiB
after JSON serialization),
and `streaming` suites. Defaults are `BENCH_REPEAT=50`, `BENCH_WARMUP=5`,
`BENCH_CONCURRENCY=8`, and `BENCH_TIMEOUT_MS=10000`; invalid, non-finite, or
negative values fall back to those limits. Set `--warmup=0` explicitly to
disable warmups. Percentiles use nearest rank (`ceil(p * N)`) and include only
successful measured requests. Failed durations are reported separately;
throughput uses all measured attempts over total measured wall duration.

Run one suite with `npm run benchmark -- --run --suite=latency --fixture
--json`. Provider-backed performance runs require the explicit
`--live-provider` flag. Proxy memory is reported separately from benchmark
driver memory; unavailable proxy metrics are `null`, never zero. Driver memory
is an observed sampled maximum between requests, and proxy RSS is one `ps`
sample after readiness.

2026-10-25: resumed cross-model failover and verified actual Codex text, tool
execution, and unavailable-model fallback. See [acceptance evidence](codex-failover-validation-2026-10-25.md).
Streaming transport is now selected after task allocation; OpenAI providers
retain the OpenAI stream validator.

2026-10-24 update (scaffold cache_control cap): fixed a 429-retry path that produced HTTP 400 `A maximum of 4 blocks with cache_control may be provided`. `withClaudeCodeSdkScaffold` spent a fresh budget of 4 on top of the client's own prompt-caching breakpoints (up to 6+ total). It now deep-strips all pre-existing `cache_control` markers first (cycle-safe), so the scaffold pass can add at most the budget of 4. Covered by `tests/anthropic-adapter.test.js` ("scaffold retry never exceeds Anthropic cache_control block limit"). Full suite green (1086 tests, 0 fail), image rebuilt, live container verified.

2026-10-24 update (native-stream swap + Claude OAuth refresh): fixed a `routeNativeStreamToProvider → "Unsupported native streaming protocol: openai" → 502` path. Root cause: the streaming entry points check `canUseNativeStreaming` on the *proposed* provider, but `taskRuntime.beforeDispatch` may substitute an equivalent provider *after* the gate, landing an openai-protocol provider (e.g. Gemini after a Claude 400) in the native-streaming implementation. Fix: `routeNativeStreamToProvider` marks the request `_requireNativeStreaming`, and `beforeDispatch` only lets native-streaming-capable providers win the allocation (drops to the proposed provider otherwise); the marker is stripped before any upstream serialization. Covered by `tests/task-runtime.test.js` ("never swaps to an openai-protocol provider"). Also rotated the expired Claude Code OAuth token (Keychain → `.env` → container recreate; old token got HTTP 401 "revoked") and cleared two ~2h-stuck `claude` CLI zombies that held the config lock and blocked new IDE sessions.

2026-10-24 update (streaming hot loop + Anthropic beta forwarding): fixed a wedged event loop (98% CPU, `/health` timing out) hit on long tool-heavy streams. Root causes, all in per-chunk stream processing: the tool-schema map and per-tool regexes were rebuilt on every chunk (752 tools x N fields x 30k chunks), full-content regex scans ran per chunk over ever-growing buffers, the difficulty assessment was recomputed per chunk, and the pre-flush hold never released on long streams. Fixes: per-request WeakMap caches (schema entries, definitions, precompiled matchers), an exact quoted-key prefilter that skips tools with no field hits, bounded 32KB scan windows for hold/stall analysis, throttled re-evaluation (first 25 chunks, then every 25th), hoisted per-stream difficulty profile threaded through the classifier chain, a hold-release valve (flush after 1MB buffered or 1500 chunks), and a 2MB cap on the garble scan. A 30k-chunk x 752-tool stream that never completed now finishes in ~1.3s; covered by `tests/streaming-hot-loop.test.js`. Also: the proxy now forwards the client's `anthropic-beta` header (union with configured betas, allowlisted shape, length-capped) so beta-gated fields (new tool types like `advisor_*`, message `output_config`, ToolSearch references) are accepted upstream as if talking to Anthropic directly; `proxy setup claude on` now also sets `ENABLE_TOOL_SEARCH=true` per the CLI's own guidance. Verified: full suite green, rebuilt image, `/health` instant, Antigravity end-to-end OK post-rebuild.

2026-10-24 update: refreshed the bundled `llm-orchestrator` snapshot from 1.4.0 (`834089e80feb4b4026fbd5a01982ed2b020f3eb0`) to 1.5.0 (`5b0eebb1cbd0dc07a51c8fde7dd79ed1fdcc645b`). The 1.5.0 release adds the domain-conditional `ui.design_system` requirement and Impeccable commands; the vendored package files and `provenance.json` hashes were regenerated from the tagged source. Embedded orchestrator tests: 275 passed. Proxy suite: 1,060 passed, 1 skipped. The proxy image was rebuilt to ship the new bundle.

2026-10-24 update (Antigravity): the `antigravity-preview-*` agents only serve the Gemini Interactions API (`POST /v1beta/interactions`, `agent` field, remote environment, `store: true`), so a new `gemini-interactions` upstream protocol was added (`lib/gemini-interactions.js`, wired in `lib/provider-adapters.js`) with a curated `antigravity` family (3 routes, 1M context, `GEMINI_API_KEY`). Verified end-to-end through the proxy (non-streaming + SSE, incl. tool-call round-trip). Unit tests: 7 passed; full proxy suite green after. The Antigravity IDE OAuth credential found in local app storage refreshes with the Gemini CLI OAuth client, but the IDE's own chat path is separate; the proxy uses the API-key Interactions path above.

2026-10-15 implementation: merged local and upstream histories, bundled orchestrator revision `834089e80feb4b4026fbd5a01982ed2b020f3eb0`, and applied independent review findings.

Verified before final delivery gate:

- Full proxy suite: 981 tests passed, zero failed/skipped. Additional permanent tests cover actual Chat/Responses/Anthropic HTTP, SSE, WebSocket, graceful restart, SIGKILL and same-model account fallback. The final clean-clone suite reruns these plus credential-scope checks.
- Docker image builds with bundled dependencies. The final gate checks actual PID1 restarts and crash recovery on a private fixture volume.
- Generic history sanitizer tested against mixed-case content, deleted historical paths, commit identities, annotated tags and raw-tree editor snapshot refs. Independent sanitized mirror audit: zero matches across all Git objects and retained refs.
- Model listing: 1,273 observations; inaccessible endpoint results remain explicit limitations. Listing does not prove inference, tool capability or account entitlement.
- Synthetic efficiency fixtures retain required facts and exact originals. No measured production quality, dollar savings or subscription-credit savings are claimed.
- `ws` upgraded to 8.21.0 or later for GHSA-96hv-2xvq-fx4p; npm dependency audit reports zero vulnerabilities.

The final verification logs, original Git bundle, original working patches and rewrite mappings are kept outside this repository in the operator's private recovery directory. Final delivery runs the full proxy suite, embedded orchestrator tests, clean Docker build and isolated PID1 recovery checks before promoting the cleaned repository.

## Deliberate limits

Streaming context optimization remains passthrough. The three-model budget covers requests and helpers passing through the shared proxy task identity; native agents bypassing it cannot be counted. Host-side execution/review evidence remains client-owned and critical phase gates stay pending until independently verified. New unmeasured model IDs are listed without invented quality scores or inferred subscription prices.

GitHub publication requires separate authorization after local rewritten history is reviewable.

## Performance hardening controls (2026-10-25)

The authoritative pre-change artifact is `task-1-baseline-v2.json`; preserve it.
Run the same 50 measured requests, 5 warmups, concurrency 8, 10000 ms timeout:

```sh
BENCH_ENFORCE_GATES=true BENCH_MAX_RSS_GROWTH_BYTES=536870912 BENCH_MAX_HEAP_GROWTH_BYTES=268435456 node scripts/performance-fixture.js --baseline=.superpowers/sdd/2026-10-25-performance-hardening/task-1-baseline-v2.json --output=.superpowers/sdd/2026-10-25-performance-hardening/performance-latest.json
```

`--baseline` requires identical configuration and applies p95/p99 <= baseline *
1.25 + 2 ms and successful RPS >= 80% baseline. These explicit operator budgets
are not unit-test timing assertions. Reports retain absolute measurements and
ratios. Local fixed-response results do not establish provider/network gains.
`BENCH_ENFORCE_GATES` defaults false: failures remain in JSON but only true makes
them exit nonzero. Individual timing/memory limits are optional:
`BENCH_MAX_P95_MS`, `BENCH_MAX_P99_MS`, `BENCH_MIN_SUCCESSFUL_RPS`,
`BENCH_MAX_RSS_GROWTH_BYTES`, `BENCH_MAX_HEAP_GROWTH_BYTES`; absent means no
threshold, invalid specified values fail the gate. Zero is an explicit threshold.
With `--baseline`, its timing budgets take precedence. Errors, timeouts, aborts,
incomplete runs and nonzero settled client/transport inflight, pending,
nativeActive or retainedBytes always fail; missing required metrics fail too.
Successful RPS uses completed requests, while legacy attempt RPS remains reported.
The fixture captures `/metrics` before/after the entire run, including warmups.
Memory growth is an endpoint delta, not peak RSS, leak proof, or forced-GC heap.

`GET /metrics` version 1 contains bounded aggregate client/upstream counters,
memory RSS/heap/external/arrayBuffers, rolling nearest-rank latency, and transport
state. Health and metrics reads do not count themselves. Retries/fallbacks count
actual dispatches rather than routes considered; cancellations/errors are separate
from client outcomes. It contains no payloads, query strings or task/client IDs.
`LLM_PROXY_METRICS_SAMPLE_SIZE=1024` (maximum 65536) bounds duration retention.

Application defaults (bytes count encoded bytes, not string characters):

| Settings (LLM_PROXY_ prefix) | Defaults | Scope |
| --- | --- | --- |
| MAX_BODY_BYTES / BODY_TIMEOUT_MS | 26214400 / 300000 | Per inbound body |
| MAX_INFLIGHT_REQUESTS / MAX_INFLIGHT_BODY_BYTES | 128 / 67108864 | Inbound retained work |
| CODEX_BACKEND_TIMEOUT_MS | 300000 | Entire ancillary operation |
| HTTP_MAX_SOCKETS / HTTP_MAX_TOTAL_SOCKETS / HTTP_MAX_FREE_SOCKETS | 64 / 256 / 16 | Per HTTP or HTTPS Agent; 512 combined total |
| HTTP_MAX_REQUESTS / UPSTREAM_TIMEOUT_MS | 512 / 300000 | Shared requests and absolute deadline |
| MAX_UPSTREAM_RESPONSE_BYTES / MAX_UPSTREAM_ERROR_BYTES | 33554432 / 1048576 | Buffered response/error |
| MAX_STREAM_BUFFER_BYTES / MAX_RETAINED_UPSTREAM_BYTES | 33554432 / 134217728 | Stream payload and shared retained estimate |
| NATIVE_MAX_REQUESTS | 32 | Native fetch concurrency |
| CACHE_MAX_ENTRIES / CACHE_TTL_MS / CACHE_MAX_PATHS_PER_SESSION | 2000 / 3600000 / 256 | Cache retention bounds |
| CACHE_MAX_BYTES / CLEANUP_INTERVAL_MS | 67108864 / 3600000 | Shared estimated cache bytes / expiry sweep |

Application numeric settings require positive safe integers; invalid/nonfinite/
negative/zero fall back to defaults. Timers exceeding 2147483647 ms also fall back,
avoiding Node's 1 ms overflow behavior. No generic zero-means-unlimited mode.
Inbound boundaries return 413 overflow, 408 deadline, 503 admission overload.
Upstream retained capacity returns local 503 without provider penalty/fallback;
upstream deadline is 504, response-size overflow 502. Ancillary backend operation
failure keeps 502; failures after sent headers terminate the stream.

Compose service-level controls apply locally without depending on deploy support:
`LLM_PROXY_MEMORY_LIMIT=2g`, `LLM_PROXY_CPU_LIMIT=2.0`, `LLM_PROXY_PIDS_LIMIT=256`;
`CODEX_PROXY_MEMORY_LIMIT=1g`, `CODEX_PROXY_CPU_LIMIT=1.0`, `CODEX_PROXY_PIDS_LIMIT=256`.
Compose validates syntax; the read-only mounted startup guard validates the same
interpolated limits before either application starts. Zero, negative, nonfinite or
invalid limits fail closed (exit 1); missing/empty Compose values use defaults.
The original image entrypoint and commands run via exec after validation, preserving
signal delivery and arguments. Guard files must exist on the host; missing mounts
fail startup. Operators must still verify effective container limits. Small synthetic config values are interpolation tests,
not recommended production limits. NODE_OPTIONS and existing heap flags remain
untouched; no low V8 heap limit is imposed. Non-Node memory services are unchanged.

Sizing: observed pre-change RSS was about 61/143 MiB on a 13.6 GiB Docker host.
For llm-proxy allow 64 MiB inbound payload with up to 8x parsing/copy headroom
(512 MiB), 128 MiB shared upstream estimate (already charged 8x live payload),
64 MiB cache accounting with up to 8x object/copy headroom (512 MiB), roughly
128 MiB socket/stream buffers at 512 pooled + 32 native connections, and
roughly 768 MiB runtime/GC/transient margin. This motivates 2 GiB, not a proof of
a whole-process bound: input structure, strings/objects and allocator overhead
vary. Native fetch uses bounded concurrency and shared retained accounting but
its internal sockets are outside the custom Agent stats. Response histories retain
40 records, 400 messages, 250k characters per record. Authoritative virtual-agent
and thread maps remain preexisting unbounded state: generic eviction risks data
loss and was intentionally excluded. Container OOM remains possible under such
growth. Codex's 1 GiB is operational headroom over 143 MiB, not an audited bound
for the external Codex service. Monitor RSS/heap/OOM and adjust based on workload.

Controller rollout, after independent review: preserve private `.env` and Compose
backups and pinned `llm-proxy:before-performance-20261025` /
`codex-proxy:before-performance-20261025` images. Build only llm-proxy, recreate
only running llm-proxy and codex-proxy using `--no-deps`; reuse the current Codex
image (`--no-build`) because its Dockerfile globally installs an unversioned npm
package. Do not rebuild Codex solely for resource controls. Verify health, logs,
HostConfig Memory/NanoCpus/PidsLimit, one Codex tool loop and one available
Antigravity streaming/tool fixture. OpenCode probes stay FREE; shared quota and
NVIDIA auth/retirement are upstream limitations, not proxy success.
Rollback: restore backed-up Compose/config, select both pinned previous images
with an override file, and recreate only those two services with `--no-build
--no-deps --force-recreate`; recheck health/resource settings. Never restore data
volumes wholesale or print credential-bearing compose/inspect output. This task
only validates configuration; it does not deploy or restart services.
