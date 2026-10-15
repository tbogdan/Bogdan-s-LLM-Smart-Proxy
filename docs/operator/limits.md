# Behavior and limits

A task defaults to one role/model route. At most three distinct canonical LLMs may be attempted across its lifetime, including failed attempts, internal assessment/summary and proxy-hosted child work. Proven same-model provider/account fallback preserves that model count but starts a different provider-local cache. An exhausted model budget returns an error; it never silently creates another task.

Account state is scoped by configured account and quota bucket. Do not label two independent credentials as the same account unless they actually share billing/quota. A generic model-list response does not establish quota, entitlement or successful inference.

Explicit task/client/conversation IDs provide reliable scope. Anchor-derived identity is a heuristic and cannot distinguish identical conversations with no stable identifiers. Native subagents or external memory sidecars that bypass this proxy or fail to carry parent identity are outside its enforceable task budget.

Context optimization currently folds repetitive tool logs and compacts JSON whitespace on supported non-streaming tool-capable routes. Exact originals are kept on disk and retrieved in bounded ranges. Mixed retrieval/client tools preserve client calls. Current instructions, exact-edit code/diffs, signed reasoning and opaque/multimodal content pass through. Streams retain their native transport and do not receive new compressed-original references.

Task-pinned traffic avoids the old destructive history compaction. If required context cannot fit, the proxy returns guidance instead of silently dropping important context or selecting a fourth model. Store capacity failures retain active originals and bypass new compression; corrupt task budget state fails closed.

Tool availability and permission enforcement belong partly to the client. Proxy-hosted virtual agents can analyze provided context; they cannot execute host shell/filesystem tools. Read-only role text is not a sandbox. Findings remain unverified without independent current-revision executor evidence.

Prefix stability is not proof of cache reuse. Only upstream usage can confirm cache-read/write tokens. The offline benchmark is synthetic and does not prove quality parity or billed savings. Public API prices do not represent subscription billing automatically.

## Review and revision gates

Task state carries FEATURE/BUG_FIX/REVIEW phases and requires independent review for critical tasks. Optional `metadata.llm_proxy` fields `task_type`, `risk: "critical"`, and `source_revision` refine that state and are stripped before upstream forwarding. Revision changes invalidate gate evidence. `X-LLM-Proxy-Review-Gate: pending-executor-evidence` means the native client must supply actual independent execution/review evidence through a trusted integration. The proxy's text-only agents cannot verify a host repository or mark that gate passed by claiming success. No public endpoint accepts self-declared trusted execution evidence.

A crashed container lock may need up to two seconds for its heartbeat lease to expire. Concurrent writers to one data directory fail closed. A healthy writer in the same PID namespace is never displaced merely because a request took longer.

Nonstreaming completions include `llm_proxy_usage`: task-lifetime observed input/output totals, dispatch count, unknown usage count and upstream cache evidence. Standard `usage` remains the final upstream call. Failed attempts and streams may omit billed usage; totals therefore remain a lower bound, not a complete invoice.
