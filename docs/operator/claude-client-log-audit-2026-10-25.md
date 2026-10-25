# Audit original Claude Code client logs — 2026-10-25

Read-only bounded snapshot of original files, no provider requests or configuration changes. Log discovery includes ignored files. Diagnostic counts are log records, not unique requests.

## Original locations

Active IDE session: `~/Library/Application Support/Antigravity IDE/logs/20261025T160557/window{1..5}/exthost/Anthropic.claude-code/Claude VSCode.log`.
Previous useful session: `~/Library/Application Support/Antigravity IDE/logs/20261025T023805/window1/exthost/Anthropic.claude-code/Claude VSCode.log`.
Read up to 512 KiB per current window and 4 MiB from previous window. Sources contain private SDK payloads; artifacts retain typed metadata only.
IDE timestamps use local Bucharest time, embedded CLI timestamps UTC (local time = UTC+2 on this date).

## Confirmed findings

- All five current windows report one SDK subprocess initialization timeout: 60,000 ms without an initialize response and without a reported running SessionStart/Setup hook. Spawned CLI version is **2.1.310**. This is a client startup failure, independent of model generation success.
- Window1 auto-mode spawn 16:06:38.121 local, timeout 16:07:38.709. Later MCP connection diagnostics and shutdown cannot establish the cause of that earlier deadline. Startup setup takes 9.895 s; command/agent loading 12.633 s; MCP configuration resolution 16.2 s, awaited at +25.528 s. Concurrent windows show setup 10.452–13.903 s and command/agent loading 5.652–16.810 s.
- On the next subprocess, SessionStart hooks hit actual deadlines: local Caveman activation configured 5 s, observed 11.620 s in window1; Headroom configured 10 s, observed 12.526 s; Stripe configured 10 s, observed 12.823 s. Plugin Caveman activation also executes separately and succeeds in 6.913 s. This confirms duplicate activation work and startup contention, but does not independently prove the first timeout cause.
- MemPalace tracebacks in windows2/3 end in **KeyboardInterrupt**, during ChromaDB imports through overrides/signature/typing utilities. Timestamps 14:08:40.196Z and 14:08:33.727Z follow shutdown. No ModuleNotFoundError or ImportError was identified. Cancellation, not evidence of a missing package.
- Exa MCP reports UnauthorizedError; several other MCP connections complete successfully. Playwright, Firebase and MemPalace connections are abandoned during shutdown. Abandonment is a shutdown consequence, not proof those servers failed their own deadlines. Repeated same-name connection records include transport negotiation retries; they must not automatically be counted as duplicate configured servers.
- Classifier warning explicitly says the server-configured `claude-sonnet-5[1m]` takes priority over `CLAUDE_CODE_AUTO_MODE_MODEL=codex/gpt-5.6-luna`. Warning alone does not prove actual classifier dispatch model. Separate successful CLI probe records actual classifier request `codex/gpt-5.6-luna`; current IDE startup snapshot contains no completed classifier action to establish IDE effective dispatch.
- Previous original window1 contains **254 autocompact checks, all `level=ok`, effectiveWindow=980000**. No explicit compact/summarization-failed record. These checks are not 254 performed compactions. Proxy POST-COMPACT logging must be assessed independently against routed model context.
- OAuth credentials are discovered in secure storage. Presence of OAuth does not prove the selected API SDK request authenticates with OAuth: proxy environment includes API-key/base-URL configuration. No credential values were read or exported.
- Missing optional settings/commands/agents directories, optional managed settings, and certificate filtering diagnostics do not by themselves establish an error.

## Evidence

Private sanitized metadata: `.superpowers/sdd/2026-10-25-current-log-fixes/original-client-log-events.json` and `original-client-startup-summary.json`.

Shell PATH startup timeout is being diagnosed separately. No hooks, permissions, MCP services, auth settings or app instances were disabled or restarted by this audit.

## Startup remediation and current validation

Removed eager duplicate NVM initialization from personal shell profiles, retaining Node 22.18.0 and lazy NVM/completion. Five concurrent login shells now complete in 0.208–0.215 s, versus the original 10 s shell discovery deadline failures. Removed only the obsolete standalone Caveman SessionStart activation; the official plugin, security hooks and permission checks remain enabled. Private backups of both profiles and original Claude settings are retained under the task evidence directory.

The extension-bundled Claude 2.1.310 answered a fresh SDK initialize probe in 2.354 s with normal plugins/MCP configuration and no inference request. Reloaded only the affected IDE window: spawn at 16:25:02.636, engine UI attached at 16:25:14.640 (12.004 s), resumed session confirmed, and startup error disappeared. This validates one affected window; other windows were not reloaded. Fresh logs still report Exa and Meta MCP UnauthorizedError and transient configuration lock contention; these did not prevent this window from starting. No authentication or permission protection was disabled.

The successful live CLI task exited 0 in 13.975 s, created the expected file and returned DONE. Actual classifier request used codex/gpt-5.6-luna and completed in 2538 ms. Original harness incorrectly counted a WARN about server classifier precedence as an API error; reviewed evidence separates that configuration warning without changing the original artifact.
