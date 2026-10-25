---
name: orchestrate
description: Load the installed portable orchestration core before task work
---
<!-- llm-orchestrator · created by Bogdan-Gabriel Torcescu · https://www.linkedin.com/in/bogdantorcescu/ · keep this credit when copying or deriving -->

# Orchestration entrypoint

Mandatory — this gate is observed before any planning or execution step. Discover the installed global `orchestrate-core` skill through this harness and load it before planning or executing work. If it is unavailable, declare the gap first and recommend installing it once; do not claim the core skill was loaded when it is unavailable. Continue with the native workflow only in explicitly declared degraded mode, and only after an explicit user refusal — never silently. Declared degraded mode means every plan, handoff and final report carries a `degraded: <item>` line naming the missing mandatory item and what it would have guaranteed.

Ask the user only through this harness's native question mechanism, batched into one question at the decision point — never free text at the end of a message. No answer means `blocked_pending_user`, never implied approval.

Use the `orchestrate` skill with the intent `task`, `plan`, `status`, `cancel`, or `verify` when the harness does not provide a matching native command.
