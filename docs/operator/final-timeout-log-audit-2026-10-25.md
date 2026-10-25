# Final timeout fix: bounded Docker log audit — 2026-10-25

Read-only observation of this Compose project's four services. Audit made no inference calls or runtime changes. Times below are UTC. No prompt/tool payloads, request identifiers, credential values, or account identifiers retained.

Window: 2026-10-25T10:18:01.095487Z through 2026-10-25T10:22:46.339788+00:00. Latest container rollout began at window start. Two idle observations at 10:21:04 and 10:22:07 UTC had identical counters and zero transport retention; final snapshot follows.

## Result

No observed `409`, `HIDDEN-CONTINUE`, `TOOL-INVALID`, response-byte overflow, stream timeout, or compatibility error after this rollout. Three upstream native-stream 403 events were the known structured OpenCode “Model access is disabled” response; all recovered to Codex. They remain provider access limitations, not evidence that direct Claude/OpenCode succeeded.

The requested Sonnet 5.5 validation encountered OpenCode 403 at 10:19:43 UTC and was served by `codex/codex-auto-review` (resolved 10:19:45 and final response 10:19:54). Classifier model stayed `codex/gpt-5.6-luna` as reported by the controller's native client debug evidence. Other organic Opus requests also recovered to the same Codex model.

Controller validation summaries:

```json
[
  {
    "requestedModel": "codex/gpt-6-luna",
    "exit": 0,
    "seconds": 20.081,
    "valid": true,
    "answer": "DONE",
    "fileCorrect": true,
    "apiErrors": 0
  },
  {
    "requestedModel": "codex/gpt-5.6-luna",
    "exit": 0,
    "seconds": 22.647,
    "valid": true,
    "answer": "DONE",
    "fileCorrect": true,
    "apiErrors": 0
  },
  {
    "requestedModel": "claude-sonnet-5-5",
    "exit": 0,
    "seconds": 15.509,
    "valid": true,
    "answer": "DONE",
    "fileCorrect": true,
    "apiErrors": 0
  }
]
```

GPT-5.6 Luna performed two legitimate Bash checks and therefore two classifier calls. The audit did not count those as duplicate retries. Global counters mix three controller sessions, model discovery and concurrent organic requests; no global one-client-request/one-dispatch claim is made.

Final aggregate metrics: 22 client completions, 21 dispatches, 3 observed upstream errors, 3 retries and 3 metric fallbacks. All three errors/retries correspond to known model-access failures; zero helper/ancillary dispatches, cancellations or client aborts. Successful fallback log entries can repeat across turns and do not equal the retry metric.

Transport at final observation: active=0, pending=0, inflight=0, nativeActive=0, retainedBytes=0. Client inflight=0; RSS 123338752 bytes. This bounded idle sample does not establish long-duration leak freedom.

The earlier 16509-frame incident is not attributed by these logs; no recurrence in the observed validations, with byte limits preserved. No other observed errors in Codex proxy, Graphiti MCP, or Neo4j.

## Sanitized evidence

```json
{
  "services": {
    "llm-proxy-llm-proxy-1": {
      "logLines": 177,
      "tags": {
        "CLIENT-RUNTIME": 8,
        "CAPABILITY-TOOLLESS-TURN": 24,
        "TOOL-SYNC": 21,
        "DEDUP": 12,
        "DEV-STREAM-REQ": 14,
        "TOOL-CALL-STREAM-NORMALIZE": 10,
        "DEV-REQ": 4,
        "DEV-RESP": 4,
        "OK": 4,
        "AI-ASSESS-CONTINUATION-SKIP": 8,
        "STREAM-OK": 4,
        "AI-ASSESS-CACHE": 3,
        "FLUSH-BUFFER": 3,
        "DEV-NATIVE-STREAM-REQ": 3,
        "NATIVE-STREAM-ERR": 3,
        "FALLBACK-RESOLVED": 9
      },
      "matchedErrorLines": 3
    },
    "llm-proxy-codex-proxy-1": {
      "logLines": 0,
      "tags": {},
      "matchedErrorLines": 0
    },
    "llm-proxy-graphiti-mcp-1": {
      "logLines": 34,
      "tags": {},
      "matchedErrorLines": 0
    },
    "llm-proxy-graphiti-neo4j-1": {
      "logLines": 0,
      "tags": {},
      "matchedErrorLines": 0
    }
  },
  "events": [
    {
      "at": "2026-10-25T10:19:33.970321681Z",
      "kind": "native upstream failure",
      "model": "opencode/claude-opus-5-5",
      "status": 403,
      "latencyMs": 588,
      "classification": "known structured model access disabled"
    },
    {
      "at": "2026-10-25T10:19:34.885749390Z",
      "kind": "native upstream failure",
      "model": "opencode/claude-opus-5-5",
      "status": 403,
      "latencyMs": 1317,
      "classification": "known structured model access disabled"
    },
    {
      "at": "2026-10-25T10:19:36.460332141Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:38.433534475Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:40.799616310Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:43.313021019Z",
      "kind": "native upstream failure",
      "model": "opencode/claude-sonnet-5-5",
      "status": 403,
      "latencyMs": 561,
      "classification": "known structured model access disabled"
    },
    {
      "at": "2026-10-25T10:19:44.297050936Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:45.985908854Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:49.530359314Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:54.221546441Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:54.945168275Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    },
    {
      "at": "2026-10-25T10:19:58.058998193Z",
      "kind": "fallback succeeded",
      "servedModel": "codex/codex-auto-review"
    }
  ],
  "metrics": {
    "version": 1,
    "uptimeSeconds": 281,
    "config": {
      "sampleSize": 1024
    },
    "memory": {
      "rss": 123338752,
      "heapUsed": 41001632,
      "heapTotal": 57208832,
      "external": 4021490,
      "arrayBuffers": 475693
    },
    "client": {
      "inflight": 0,
      "completions": 22,
      "errors": 0,
      "aborted": 0,
      "inboundBytes": 1067287,
      "outboundBytes": 15931
    },
    "upstream": {
      "dispatches": 21,
      "errors": 3,
      "cancels": 0,
      "retries": 3,
      "fallbacks": 3,
      "byCategory": {
        "provider": 21,
        "helper": 0,
        "ancillary": 0,
        "other": 0
      }
    },
    "latencyMs": {
      "p50": 2306.652085,
      "p95": 5203.069711,
      "p99": 5552.265002
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
}
```
