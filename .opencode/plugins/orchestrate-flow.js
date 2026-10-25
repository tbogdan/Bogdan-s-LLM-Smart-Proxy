// orchestrate-core:flow — llm-orchestrator · created by Bogdan-Gabriel Torcescu · https://www.linkedin.com/in/bogdantorcescu/ · keep this credit when copying or deriving
// Flow adherence: adds one reminder when work starts with no orchestrate-core run open.
// Never blocks a tool and never throws; any failure is silent.
import { spawnSync } from "node:child_process";

const CLI = `${process.env.HOME}/.agents/skills/orchestrate-core/bin/llm-orchestrator.mjs`;

export const OrchestrateFlow = async ({ directory }) => {
  const parentOf = new Map();
  const pending = new Map();

  const gate = (payload) => {
    try {
      const result = spawnSync("node", [CLI, "gate", "--project", directory], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 3000,
      });
      const text = (result.stdout || "").trim();
      return text ? JSON.parse(text)?.hookSpecificOutput?.additionalContext ?? null : null;
    } catch {
      return null;
    }
  };

  const owner = (sessionID) => {
    const parent = parentOf.get(sessionID);
    return parent ? { session_id: parent, agent_id: sessionID } : { session_id: sessionID };
  };

  return {
    event: async ({ event }) => {
      try {
        const info = event?.properties?.info;
        if (event?.type === "session.created" && info?.parentID) {
          parentOf.set(info.id, info.parentID);
          gate({ hook_event_name: "SubagentStart", session_id: info.parentID, agent_id: info.id });
        }
        const idle = event?.properties?.sessionID;
        if (event?.type === "session.idle" && idle && !parentOf.has(idle)) gate({ hook_event_name: "Stop", session_id: idle });
        const ended = info?.id;
        if (event?.type === "session.deleted" && ended && !parentOf.has(ended)) gate({ hook_event_name: "SessionEnd", session_id: ended });
      } catch {}
    },
    "chat.message": async (input) => {
      try {
        if (!parentOf.has(input?.sessionID)) gate({ hook_event_name: "UserPromptSubmit", session_id: input?.sessionID, prompt_id: input?.messageID });
      } catch {}
    },
    "tool.execute.before": async (input, output) => {
      try {
        const note = gate({ hook_event_name: "PreToolUse", ...owner(input?.sessionID), tool_name: input?.tool, tool_input: output?.args, tool_use_id: input?.callID });
        if (note) pending.set(input.callID, note);
      } catch {}
    },
    "tool.execute.after": async (input, output) => {
      try {
        const note = pending.get(input?.callID);
        if (note && typeof output?.output === "string") {
          pending.delete(input.callID);
          output.output = `${output.output}\n\n${note}`;
        }
      } catch {}
    },
  };
};
