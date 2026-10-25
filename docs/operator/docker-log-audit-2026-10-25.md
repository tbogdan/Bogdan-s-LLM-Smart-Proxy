# Bounded Docker log audit — 2026-10-25

Read-only audit of four services belonging to this Compose project. No inference requests, configuration changes, or restarts performed by this audit. Unrelated local containers excluded. Only event tags, timestamps and aggregate metrics retained; no request bodies, tool arguments, account identifiers, or credentials.

## Before selector rollout

Window: 09:20:32–09:22:28 UTC. Proxy: 259 lines; 22 ANTHROPIC-PASSTHROUGH-FAIL, one ANTHROPIC-PASSTHROUGH-SCAFFOLD-FAIL, six API-ERROR, 11 FALLBACK-RESOLVED. Initial direct failures were 429, subsequent direct failures 403. No observed 401 in this window.

Additional issue: four TOOL-INVALID-STREAM → HIDDEN-CONTINUE-STREAM-TOOL-ARGS → HIDDEN-CONTINUE-LIMIT sequences at 09:21:13, 09:21:20, 09:21:31 and 09:21:40 UTC; four POSSIBLE-STALL tags. Exact invalid argument reason/model was not captured before container recreation removed original logs. These events prove rejected streamed tool output and exhausted continuation attempts; they do not establish which component caused malformed output. Follow-up required if repeated.

Metrics at 09:22:28 UTC: 21 completed requests, one inflight; 45 upstream dispatches, 29 upstream errors, 23 retries, two cancellations, zero helper dispatches. Retained response payload 4,344 bytes while one request active: not evidence of a leak. Counters and individual log events are different measures and must not be summed.

Codex proxy and Neo4j: zero new lines. Graphiti MCP: 15 lines, no matched error/failure events.

## After selector rollout

Window: 09:22:36 UTC through 2026-10-25T09:24:24.791129+00:00.

One API-ERROR at 09:22:47 UTC: explicit opencode/claude-sonnet-5, HTTP 403, tools=0, messages=2. This general route error remains distinct from the fixed Anthropic passthrough selector. Claude route successfully served by codex/codex-auto-review at 09:22:57 UTC. No repeated ANTHROPIC-PASSTHROUGH-FAIL, TOOL-INVALID-STREAM or HIDDEN-CONTINUE-LIMIT observed after rollout in this bounded window.

Traffic attribution: controller reports one synthetic explicit codex/gpt-5.6-luna Messages API probe around 09:23 UTC, HTTP 200 with exact expected output in 2.948 seconds. Included in aggregate totals; excluding that probe leaves two observed requests and two dispatches. Audit itself generated only metrics reads.

Final aggregate metrics:

```json
{
  "version": 1,
  "uptimeSeconds": 103,
  "config": {
    "sampleSize": 1024
  },
  "memory": {
    "rss": 102903808,
    "heapUsed": 31259776,
    "heapTotal": 34267136,
    "external": 3694705,
    "arrayBuffers": 144562
  },
  "client": {
    "inflight": 0,
    "completions": 3,
    "errors": 0,
    "aborted": 0,
    "inboundBytes": 737785,
    "outboundBytes": 12927
  },
  "upstream": {
    "dispatches": 3,
    "errors": 1,
    "cancels": 0,
    "retries": 0,
    "fallbacks": 0,
    "byCategory": {
      "provider": 3,
      "helper": 0,
      "ancillary": 0,
      "other": 0
    }
  },
  "latencyMs": {
    "p50": 2800.004502,
    "p95": 7595.563212,
    "p99": 7595.563212
  },
  "transport": {
    "active": 0,
    "pending": 0,
    "free": 0,
    "inflight": 0,
    "retainedBytes": 0,
    "nativeActive": 0
  }
}
```

Service log counts and event categories:

```json
{
  "llm-proxy-llm-proxy-1": {
    "lines": 43,
    "tags": {
      "CLIENT-RUNTIME": 3,
      "CAPABILITY-TOOLLESS-TURN": 7,
      "CLIENT-METADATA-STRIP": 2,
      "TOOL-SYNC": 3,
      "DEV-REQ": 2,
      "DEV-RESP": 2,
      "API-ERROR": 1,
      "AI-ASSESS-CONTINUATION": 1,
      "DEV-STREAM-REQ": 1,
      "STREAM-OK": 1,
      "AI-ASSESS-CACHE": 1,
      "FLUSH-BUFFER": 1,
      "FALLBACK-RESOLVED": 1
    }
  },
  "llm-proxy-codex-proxy-1": {
    "lines": 0,
    "tags": {}
  },
  "llm-proxy-graphiti-mcp-1": {
    "lines": 14,
    "tags": {}
  },
  "llm-proxy-graphiti-neo4j-1": {
    "lines": 0,
    "tags": {}
  }
}
```

No observed duplicate transport attempts in the post-rollout counters: completed requests and dispatches progress together, with zero retries/helper requests. Zero retained transport bytes when idle; no pending transport work. This short window cannot prove long-duration memory stability, output semantic correctness or provider availability without corresponding traffic. API-ERROR can coexist with client.errors=0 because a completed application error response differs from a transport failure; do not interpret that counter alone as all requests successful.
