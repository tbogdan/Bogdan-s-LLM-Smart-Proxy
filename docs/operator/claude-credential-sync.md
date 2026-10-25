# Claude Code credential synchronization

Claude Code owns OAuth refresh and refresh-token rotation. The proxy must not run a competing refresh grant or copy the refresh token into Docker.

On the macOS host, run:

```sh
node scripts/sync-claude-credentials.js --watch --interval 60 --output data/claude-oauth.json
```

The helper reads the default `Claude Code-credentials` Keychain service using an argument array (no shell). Only when Keychain is unavailable does it try `~/.claude/.credentials.json`. A readable but invalid/expired Keychain payload never falls back to an older file. Custom `CLAUDE_CONFIG_DIR` is explicitly rejected because its Keychain service can differ.

Only `accessToken` and `expiresAt` are written. Output is atomic, mode 0600; temporary files also use 0600 and the ignored `*.json` suffix. Identical snapshots are not rewritten. Watch iterations are sequential, default 60 seconds; Keychain reads have a 5-second timeout and 64 KiB limit. A failure logs one generic message per failure streak, without credential values or subprocess output.

Opt in inside the proxy container with `LLM_PROXY_CLAUDE_CREDENTIAL_FILE=/data/claude-oauth.json` and mount the containing data directory (not an individual file, because writes use rename). Both startup hydration paths read the snapshot. Request handling calls `refreshClaudeCredentials()`; reads are throttled to once per second. Only Claude routes using `CLAUDE_CODE_OAUTH_TOKEN` are updated. In-flight provider objects retain the original credential so their failures cannot quarantine a newly rotated token.

Missing, malformed, oversized, or expired snapshots never replace runtime credentials. They do not perform authentication or refresh. If Claude Code is not running and its access token expires, the helper cannot renew it: Claude Code must refresh through its normal authenticated flow. Existing per-credential account availability prevents repeatedly using a credential rejected by the upstream.

Validation uses mocked Keychain input and synthetic tokens; no real secrets are needed: `node --test tests/claude-credential-sync.test.js tests/provider-config.test.js`.

## Local validation — 2026-10-25

The live Keychain contained a newer access token and refresh token than the credentials file; the proxy environment held a different access token. No credential values were logged. A user LaunchAgent, `com.bogdan.llm-proxy.claude-credential-sync`, now runs the host helper every 60 seconds. The local container opts in to `/data/claude-oauth.json`; its existing directory mount exposes atomic updates. The snapshot contains exactly accessToken and expiresAt, mode 0600, and is Git-ignored.

The combined regression suite passed 1274 tests, zero failures, one skip. The subsequent native-selector correction passed 41 focused tests; core smoke passed. Final selector rollout occurred at 09:22:36 UTC. An Anthropic Messages API request routed explicitly to codex/gpt-5.6-luna returned HTTP 200 and exact expected text in 2.948 seconds.

Claude's prior revoked-token 401 stopped after synchronization. The refreshed credential encountered HTTP 429; direct Claude inference is therefore not claimed successful. Existing generic-429 scaffold compatibility remains; it can make one additional attempt. Native Claude passthrough no longer selects third-party Anthropic-protocol providers by matching upstream model names. A separately requested OpenCode route can still fail its own access policy.

Auth failures now persist against a credential fingerprint scoped to family and endpoint origin. Rotated credentials and independent accounts remain eligible; legacy auth records without fingerprints are requalified once. Quota/credit records retain their existing account scope. Snapshot synchronization does not independently refresh OAuth: Claude Code remains the refresh owner.
