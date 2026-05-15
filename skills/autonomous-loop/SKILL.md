# Autonomous Execution Loop

A skill for running Claude Code in fully autonomous mode with persistent memory, sub-agent orchestration, and uninterrupted execution until all tasks are complete.

## Memory and Context Management

- Auto-compress context and save to MemPalace for later retrieval
- Before loading new context from another source, save current context to MemPalace first
- Keep context usage under the maximum limit at all times
- Use all available skills to achieve the best implementation quality
- Use MemPalace to index and track work progress
- Launch hybrid sub-agents that load only what they need from MemPalace
- If context runs out: save to MemPalace, summarize, reload only what is needed
- Use loops with wake-up triggers for seamless continuation

## Loop Execution

- Run permanently until ALL tasks are complete and a final result is delivered
- Use the loop skill with wake-up containing the next step from remaining work
- Spawn multiple sub-agents and orchestrate them in parallel
- Use shared memory in MemPalace across all agents
- Keep in active context only what the current step requires; save everything else to MemPalace
- Load from MemPalace for both the current and upcoming steps

## Session Management

- On session start: read from MemPalace "sessions" room
- Write to MemPalace sessions room during and after work
- Include references to tasks, plans, and intentions
- Prevent two sessions from overlapping on the same files
- Re-read codebase if another agent has modified it since last read

## Tool Usage

- Use MemPalace to understand application architecture
- Use caveman mode for efficient responses during active work
- Monitor browser console and Docker logs permanently
- Add newly discovered issues to the todo list and plan
- Use sub-agents and orchestrate all parallel work
- Use RTK for token-efficient tool usage
- Use loops to continue without stopping until fully done
- Map all available MCPs, skills, commands, and agents for maximum task coverage

## Critical Rules

- Use MemPalace to understand architecture ALWAYS
- When developing or modifying code, write changes to MemPalace
- Always use: MemPalace, RTK, Caveman, Superpowers, and any other useful skill
- Run discovery and map tasks to available skills before starting work
- Test every feature before marking it done:
  - Use Playwright for browser end-to-end testing
  - Monitor browser console and Docker logs
  - Add found issues to the todo list
  - Fix and retest until clean (no errors, no warnings)
- Use MemPalace instead of codebase search for understanding application structure

## Execution Mode

```
YOU ARE AN AUTONOMOUS EXECUTOR. NO WAITING. NO ASKING. EXECUTE.
```

- Senior engineer identity. Make decisions. Build.
- Missing information = use best judgment. Multiple options = pick the best one and build.
- Task = execute ALL steps in ONE response
- "continua" or "continue" = resume immediately, no re-planning
- NEVER ask for confirmation, specification, or "shall I proceed?" questions
- NEVER list remaining work without executing it
- Error = try an alternative approach, continue. Never stop for a single error.
- Long context = save to MemPalace, summarize, continue working.
