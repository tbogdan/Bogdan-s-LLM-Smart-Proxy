"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const state = require("./state");
const scoring = require("./scoring");
const compaction = require("./compaction");
const providers = require("./providers");
const routingPolicy = require("./routing-policy");
const mempalace = require("../llm-mempalace");

// ---------------------------------------------------------------------------
// CAP_TO_SCORE — capability name → MODEL_SCORES field mapping
// ---------------------------------------------------------------------------
const CAP_TO_SCORE = {
  coding: "coding", thinking: "reasoning",
  tools: "tools", text: "chat", images: "vision", video: "vision",
  max: "quality", // max = best overall quality across all categories
};

const PROXY_PROMPT_MARKERS = [
  "You are Project LLM Smart Proxy",
];

const PROXY_PROMPT_END_MARKERS = [
  "- Subagent checklist: 1) Did it use tools? 2) Did files actually change? 3) Do tests pass? 4) Is output correct?",
  "- If subagent fails, retry once with alternative approach (e.g., Explore→general). Log error, continue. Abort only after 3 consecutive failures of same step.",
  "- Mental inventory of capabilities. Right tool for each sub-task. Tool exists = USE IT.",
];

function stripInjectedProxyPrompt(systemText) {
  let text = systemText || "";
  for (;;) {
    let markerIdx = -1;
    for (const marker of PROXY_PROMPT_MARKERS) {
      const idx = text.indexOf(marker);
      if (idx !== -1 && (markerIdx === -1 || idx < markerIdx)) markerIdx = idx;
    }
    if (markerIdx === -1) return text;

    let endIdx = -1;
    let endLen = 0;
    for (const marker of PROXY_PROMPT_END_MARKERS) {
      const idx = text.indexOf(marker, markerIdx);
      if (idx !== -1 && idx + marker.length > endIdx + endLen) {
        endIdx = idx;
        endLen = marker.length;
      }
    }

    if (endIdx === -1) {
      text = text.substring(0, markerIdx);
    } else {
      text = text.substring(0, markerIdx) + text.substring(endIdx + endLen);
    }
  }
}

// ---------------------------------------------------------------------------
// transformRequest — per-provider request transformation
// ---------------------------------------------------------------------------
async function transformRequest(provider, reqBody) {
  const body = { ...reqBody };
  body.model = provider.model;
  const internalSummaryRequest = !!body._llmProxyInternalSummary;
  const skipAISummary = !!body._skipAISummary || internalSummaryRequest;
  delete body._llmProxyInternalSummary;
  delete body._skipAISummary;

  const compat = scoring.getCompat(provider.name);

  // Apply cached truncations — stable across requests (IDE cache gets same result)
  if (body.messages) compaction.applyCachedTruncations(body.messages);

  // Per-provider context compaction: if messages + tools + max_tokens exceed effective context,
  // compact to fit (post-routing, provider-specific)
  if (body.messages && body.messages.length > 4) {
    const providerCtx = scoring.getEffectiveContext(provider);
    const currentTokens = compaction.estimateTokens(body.messages) + compaction.estimateToolsTokens(body.tools) + (body.max_tokens || 4096);
    if (currentTokens > providerCtx * 0.95) {
      const toolsTokens = compaction.estimateToolsTokens(body.tools);
      const msgTokens = compaction.estimateTokens(body.messages);
      const target = Math.floor((providerCtx - toolsTokens) * 0.75);
      state.log(`POST-COMPACT: ${provider.name} needs ${currentTokens}tok (msgs=${msgTokens}, tools=${toolsTokens}, max_tok=${body.max_tokens||4096}) > ${Math.floor(providerCtx*0.95)} (95% of ${providerCtx}) → target ${target}tok`);
      const sessionId = mempalace.getSession(reqBody.messages)?.id;
      const compacted = await compaction.compactMessagesAsync(body.messages, target, body.max_tokens || 4096, [], sessionId, { skipAISummary });
      if (compacted) {
        // Cache compacted messages for session reuse
        try {
          if (sessionId) {
            // Store last message content from ORIGINAL context for split-point matching
            const origMsgs = reqBody.messages || body.messages;
            const lastMsg = origMsgs[origMsgs.length - 1];
            const lastContent = typeof lastMsg?.content === "string" ? lastMsg.content : "";
            state.sessionCompactCache[sessionId] = {
              compactedMessages: compacted.messages,
              originalMsgCount: origMsgs.length,
              lastOriginalContent: lastContent,
              timestamp: Date.now(),
            };
          }
        } catch {}
        body.messages = compacted.messages;
        state.log(`POST-COMPACT: ${provider.name} done: ${compaction.estimateTokens(body.messages)}tok msgs (limit: ${providerCtx}) — cached for session`);
      } else {
        // Can't compact further — cap max_tokens aggressively
        const headroom = providerCtx - msgTokens - toolsTokens;
        if (headroom > 1024) {
          const requestedMaxTokens = body.max_tokens || 4096;
          body.max_tokens = Math.max(1, Math.min(requestedMaxTokens, Math.floor(headroom * 0.9)));
          state.log(`POST-COMPACT: ${provider.name} can't compact msgs, capped max_tokens ${requestedMaxTokens} → ${body.max_tokens} (headroom=${headroom})`);
        } else {
          state.log(`POST-COMPACT: ${provider.name} can't compact and no headroom (${headroom}tok) — will likely fail`);
        }
      }
    }
  }

  // Dynamic max_tokens cap — ensure input + output fits provider's effective context
  if (body.messages && body.max_tokens) {
    const providerCtx = scoring.getEffectiveContext(provider);
    const inputTokens = compaction.estimateTokens(body.messages) + compaction.estimateToolsTokens(body.tools);
    const headroom = providerCtx - inputTokens;
    if (headroom < body.max_tokens && headroom > 0) {
      const oldMax = body.max_tokens;
      body.max_tokens = Math.max(1024, Math.floor(headroom * 0.95)); // 95% of remaining, min 1024
      state.log(`MAX-TOK-CAP: ${provider.name} ${oldMax} → ${body.max_tokens} (input=${inputTokens}, ctx=${providerCtx}, headroom=${headroom})`);
    } else if (headroom <= 0) {
      // Input alone exceeds context — post-compact will handle
      state.log(`MAX-TOK-WARN: ${provider.name} input ${inputTokens} exceeds ctx ${providerCtx}`);
    }
  }

  // Qwen3 models: add enable_thinking (unless provider rejects it)
  if (provider.tc && /qwen3|qwq/i.test(provider.model) && !compat.no_extra_body) {
    if (!body.extra_body) body.extra_body = {};
    body.extra_body.enable_thinking = true;
  }

  // NVIDIA models: add reasoning_budget + enable_thinking for reasoning models
  if (provider.tc && /nvidia|integrate\.api\.nvidia/i.test(provider.url) && /reasoning|nemotron.*omni/i.test(provider.model)) {
    body.reasoning_budget = body.reasoning_budget || 16384;
    body.chat_template_kwargs = { enable_thinking: true };
  }

  // Strip extra_body for providers that reject it (auto-learned)
  if (body.extra_body && compat.no_extra_body) {
    delete body.extra_body;
  }

  // Strip reasoning_content from messages (auto-learned)
  if (body.messages && compat.no_reasoning) {
    body.messages = body.messages.map((m) => {
      if (m.reasoning_content) {
        const { reasoning_content, ...rest } = m;
        return rest;
      }
      return m;
    });
  }

  // Cap max_tokens (auto-learned from provider errors)
  if (compat.max_tokens_cap && body.max_tokens && body.max_tokens > compat.max_tokens_cap) {
    body.max_tokens = compat.max_tokens_cap;
  }

  // Cap tools array (auto-learned — e.g. Groq max 128)
  if (compat.max_tools && body.tools?.length > compat.max_tools) {
    body.tools = body.tools.slice(0, compat.max_tools);
  }

  // Strip stream_options when stream=false or when provider rejects it (auto-learned)
  if (body.stream_options && (!body.stream || compat.no_stream_options)) {
    delete body.stream_options;
  }

  // Strip tool_choice for providers that reject it (auto-learned)
  if (body.tool_choice && compat.no_tool_choice) {
    delete body.tool_choice;
  }

  // Fix empty function_response.name (Gemini rejects empty names)
  // Also inject thoughtSignature for Gemini (required for tool calls to work)
  const isGemini = /gemini/i.test(provider.model);
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function && !tc.function.name) {
            tc.function.name = "unknown_tool";
          }
          // Gemini requires thoughtSignature on tool calls — inject dummy if missing
          if (isGemini) {
            if (!tc.thought_signature) tc.thought_signature = "skip_thought_signature_validator";
            if (!tc.thoughtSignature) tc.thoughtSignature = "skip_thought_signature_validator";
            if (tc.function && !tc.function.thought_signature) tc.function.thought_signature = "skip_thought_signature_validator";
          }
        }
      }
      // Fix tool role messages with empty/missing name (Gemini rejects empty function_response.name)
      if (msg.role === "tool" && (!msg.name || msg.name.trim() === "")) {
        msg.name = "unknown_tool";
      }
    }
  }

  // Sanitize tool definitions for cross-provider compatibility.
  if (body.tools) {
    body.tools = body.tools.filter((t) => t.function?.name).map((t) => {
      const fn = { ...t.function };
      fn.name = fn.name.replace(/[^a-zA-Z0-9_.\-:]/g, "_").substring(0, 128);
      delete fn.strict;
      return { ...t, function: fn };
    });
  }

  // Providers that emulate OpenAI often reject this field even when they support tools.
  delete body.parallel_tool_calls;

  // Keep tool call IDs short and alphanumeric while preserving call/result linkage.
  if (body.messages) {
    const idMap = {};
    for (const msg of body.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id && !/^[a-zA-Z0-9]{9}$/.test(tc.id)) {
            if (!idMap[tc.id]) {
              idMap[tc.id] = crypto.createHash("md5").update(tc.id).digest("base64url").replace(/[^a-zA-Z0-9]/g, "").substring(0, 9).padEnd(9, "a");
            }
            tc.id = idMap[tc.id];
          }
        }
      }
      if (msg.role === "tool" && msg.tool_call_id && idMap[msg.tool_call_id]) {
        msg.tool_call_id = idMap[msg.tool_call_id];
      }
    }
  }

  // Some providers reject assistant messages that include both text content and tool calls.
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === "assistant" && msg.tool_calls?.length > 0 && msg.content) {
        msg.content = null;
      }
    }
  }

  // Sanitize message roles — strip invalid roles emitted by IDE adapters.
  const validRoles = new Set(["system", "user", "assistant", "tool", "function", "developer"]);
  if (body.messages) {
    body.messages = body.messages.filter((m) => {
      if (!m.role || !validRoles.has(m.role)) {
        state.log(`ROLE-STRIP: removed message with invalid role="${m.role}"`);
        return false;
      }
      return true;
    });
  }

  // Some OpenAI-compatible servers require an assistant turn between tool output and new user input.
  if (body.messages) {
    const fixed = [];
    for (let i = 0; i < body.messages.length; i++) {
      fixed.push(body.messages[i]);
      if (body.messages[i].role === "tool" && body.messages[i + 1]?.role === "user") {
        fixed.push({ role: "assistant", content: "Continuing." });
      }
    }
    if (fixed.length !== body.messages.length) body.messages = fixed;
  }

  // Flatten multipart content arrays to string for providers that reject them
  // (Cloudflare, BigModel only accept string content)
  if (body.messages && compat.no_content_array) {
    body.messages = body.messages.map((m) => {
      if (Array.isArray(m.content)) {
        const text = m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        return { ...m, content: text || "" };
      }
      return m;
    });
  }

  // Strip orphaned tool responses (tool role messages whose tool_call_id has no matching
  // assistant tool_call — causes 500 on OpenAI/Codex: "No tool call found for function call output")
  if (body.messages) {
    const validCallIds = new Set();
    for (const msg of body.messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) validCallIds.add(tc.id);
        }
      }
    }
    const before = body.messages.length;
    body.messages = body.messages.filter((m) => {
      if (m.role !== "tool") return true;
      if (!m.tool_call_id) return false; // no/empty tool_call_id = invalid, strip it
      return validCallIds.has(m.tool_call_id);
    });
    const removed = before - body.messages.length;
    if (removed > 0) state.log(`TRANSFORM: stripped ${removed} orphaned tool responses`);

    // Reverse: strip assistant tool_calls that have no matching tool response
    // (causes 500 on Codex/OpenAI: "Tool results are missing for tool calls")
    const answeredCallIds = new Set();
    for (const msg of body.messages) {
      if (msg.role === "tool" && msg.tool_call_id) answeredCallIds.add(msg.tool_call_id);
    }
    let strippedCalls = 0;
    let totalCalls = 0;
    for (const msg of body.messages) {
      if (msg.role === "assistant" && msg.tool_calls?.length > 0) {
        totalCalls += msg.tool_calls.length;
        const orig = msg.tool_calls.length;
        msg.tool_calls = msg.tool_calls.filter((tc) => answeredCallIds.has(tc.id));
        strippedCalls += orig - msg.tool_calls.length;
        if (msg.tool_calls.length === 0) delete msg.tool_calls;
      }
    }
    if (state.DEV_MODE) state.log(`TOOL-SYNC: ${totalCalls} calls, ${answeredCallIds.size} responses, stripped ${strippedCalls} unanswered`);
    if (strippedCalls > 0) state.log(`TRANSFORM: stripped ${strippedCalls} unanswered tool calls`);
  }

  // Inject system instructions — identity, execution rules, memory, date/time
  if (!internalSummaryRequest && body.messages && body.messages.length > 0) {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toISOString().replace("T", " ").substring(0, 19) + " UTC";

    let PROXY_SYSTEM = [
      `You are Project LLM Smart Proxy — senior staff engineer. Date: ${dateStr} ${timeStr}.`,
      "",
      "FLOW: UNDERSTAND→DECOMPOSE→EXECUTE→VERIFY→SAVE→NEXT",
      "UNDERSTAND: Read task. Scan files (package.json, configs, ls). Search memory. git status/log.",
      "DECOMPOSE: If task has 5+ files or 3+ features → break into subtasks. Use TodoWrite/update_plan to track. Each subtask = 1-3 files, independently testable.",
      "EXECUTE: ONE subtask at a time. All files for that subtask in ONE response. Tools directly. [1/N] pattern.",
      "VERIFY: Run build/tests for this subtask. Fix in same response.",
      "SAVE: Save progress to MemPalace with file paths and what's done. Mark subtask complete in todo.",
      "NEXT: Immediately start next subtask. NEVER stop between subtasks. On 'continue' = read todo + mempalace, resume next incomplete subtask.",
      "",
      "TASK DECOMPOSITION (mandatory for large tasks):",
      "- If task involves 5+ files: DECOMPOSE FIRST. Write subtask list using TodoWrite/update_plan.",
      "- Each subtask: clear name, specific files, testable outcome. Max 1-3 files per subtask.",
      "- Execute subtasks sequentially. Mark each done. THEN START NEXT IMMEDIATELY.",
      "- After each subtask: save to MemPalace what changed. Mark complete in todo.",
      "- On 'continue': read todo → find first incomplete subtask → resume. No re-analysis.",
      "- Subtask example: 'Create auth middleware (src/middleware/auth.ts + test)' not 'Implement auth system'.",
      "",
      "ANTI-STALL RULES (critical — most common failure mode):",
      "- NEVER think 'this is huge/massive/too large'. Every task becomes small after decomposition.",
      "- NEVER say 'time limited' or 'can't fit' or 'too many files'. Decompose and start first subtask.",
      "- NEVER write 'Next steps will...' or 'Subsequent turns will...'. DO the next step NOW.",
      "- NEVER create TODO lists without immediately starting item #1.",
      "- NEVER write stub files (empty exports, placeholder tests, skeleton components). Implement FULLY.",
      "- The pattern 'analyze → list what needs doing → summarize → stop' is a FAILURE. Replace with: 'analyze → decompose → implement subtask 1 → implement subtask 2 → ...'",
      "- If you catch yourself writing a summary paragraph: DELETE IT and write a tool call instead.",
      "- 'continue' from user means: read where you left off, start next incomplete task. Not re-analyze.",
      "",
      "TOOL STRATEGY — CRITICAL: You MUST use tools. Text-only responses = FAILURE.",
      "- EVERY response MUST include at least one tool call. Never respond with only text.",
      "- Call as many tools as needed in a single response — minimize back-and-forth.",
      "- If unsure which tool: start with Read to understand, then Edit/Write to change.",
      "- Assess what you know vs what you need. Choose most appropriate tool for each step.",
      "- Do NOT assume tool outcomes. Each step must be informed by previous results.",
      "- Prefer dedicated tools over shell: Read>cat, Edit>sed, Grep>grep, Glob>find, Write>echo",
      "- ALWAYS read a file before editing it. Never guess file contents.",
      "- Make parallel tool calls when independent — don't serialize what can run together.",
      "- If a tool fails: read error, diagnose root cause, try alternative. Don't retry blindly.",
      "- Tool args must be valid. Never pass undefined/null.",
      "- NEVER describe what you would do — DO IT with tool calls. Action > words.",
      "",
      "CODE QUALITY — Quality > Speed. Always.",
      "- Read existing code BEFORE proposing changes. Match existing patterns and conventions.",
      "- Minimal changes — don't refactor/add features beyond what's asked.",
      "- No comments/docstrings unless asked. No type annotations on code you didn't change.",
      "- No commit unless asked. No force push. No skip hooks.",
      "- Security: don't expose .env, credentials, API keys in output or commits.",
      "- On edit: use exact string matching. Include enough context to be unique.",
      "- No dead code: if you replace logic, REMOVE the old in same commit. No 'kept for reference'.",
      "- Breaking changes > compatibility hacks: rename/move, let compiler fail, fix call sites. No shims.",
      "- Explicit > implicit: explicit config over magic defaults, explicit errors over silent failures.",
      "- File size: <500 lines preferred, <1000 hard limit. Split by responsibility if growing.",
      "- Never guess on major architectural decisions — ask user first, token cost < wrong architecture.",
      "",
      "RULES — AUTONOMY IS MANDATORY:",
      "- You are FULLY AUTONOMOUS. Execute without asking permission. Never wait for confirmation.",
      "- After fixing file A, IMMEDIATELY proceed to file B. No 'Reply A to proceed'. Just do it.",
      "- Complete task fully. No stalling. No stopping between steps.",
      "- FORBIDDEN: start with Great/Certainly/Okay/Sure. End with question when you can act.",
      "- On error: read error, check assumptions, focused fix. Don't retry identically.",
      "- Concise, direct. User's language. Markdown. Minimize tokens.",
      "- Search codebase + memory BEFORE asking. Ask ONLY if genuinely ambiguous (2+ valid approaches with major tradeoffs).",
      "- <system-reminder> tags = useful info, NOT user input.",
      "- NEVER write stub/placeholder/empty files. Implement FULLY or skip entirely.",
      "- NEVER end response with summary. After step N, START step N+1 immediately.",
      "- NEVER say 'Time limited' or 'Due to constraints'. You have unlimited time.",
      "- NEVER say 'Next: X. Reply to proceed.' — JUST DO X. NOW.",
      "- NEVER ask 'Should I continue/proceed/fix the next one?' — YES, ALWAYS. Do it.",
      "- If task has 10 items: fix all 10 in one response. Don't stop after 1 and ask.",
      "- ONE file at a time, FULLY implemented. 3 complete > 10 stubs.",
      "- ONLY ask user when: destructive/irreversible action, genuine architectural ambiguity (2+ valid paths), or missing credentials/access.",
      "",
      "ROUTING ASSESSMENT — first line contract:",
      "- Before substantive work, output exactly one private first line in this syntax:",
      "LLM_PROXY_TASK_DIFFICULTY level=<1-5> effort=<none|minimal|low|medium|high|xhigh> speed=<1-5> reason=<slug>",
      "- Difficulty levels: 1=trivial exact/simple reply, 2=simple explanation/edit, 3=standard coding/debug, 4=multi-file/architecture/root-cause, 5=deep research/proof/production-critical.",
      "- Effort means required thinking budget. Speed 5=latency matters most, 1=latency least important.",
      "- After the marker, continue normally in the same response, including tool calls when needed. The proxy removes the marker before the user sees it.",
      "",
      "VIOLATIONS (any = failure):",
      "Should I continue?|Shall I proceed?|Waiting for confirmation|",
      "Reply A to proceed|Press enter to continue|Want me to fix|Shall I move on|",
      "Please specify|Need specifics|Tell me your preference|",
      "Let me check+stop|I will continue with X+not doing it|What I will do next+not doing it|",
      "List work without executing|Ask what you can discover|Shell commands as text|",
      "Summarize then stop|Write stubs|Say 'time limited'|Ask for permission to continue|",
      "End with question when you can act|Repeat failing approach without alternatives",
      "",
      "EFFICIENT FILE READING:",
      "- Read files in chunks using offset/limit parameters. Do not read entire large files at once.",
      "- For files over 500 lines: read first 100 lines to understand structure, then read specific sections as needed.",
      "- When searching: use Grep/Glob first to find exact locations, then Read only relevant ranges.",
      "- Compacted tool outputs use [READ timestamp] previews and topic summaries. Treat them as memory hints, not complete file contents.",
      "- If a file was already read and not modified, do NOT re-read it. Use the information already available.",
      "- If a compacted summary says a file was modified after last read, re-read only the relevant range before editing.",
      "- After writes, verify with targeted reads/tests instead of re-reading whole files.",
      "",
      "DISCOVERY: On session start, gather project context before writing code:",
      "- ls/glob to map directory structure. Read package.json/requirements.txt/Cargo.toml — detect stack, deps, scripts.",
      "- Read config files: tsconfig, tailwind, .env.example, Dockerfile, docker-compose.yml.",
      "- Check CLAUDE.md, AGENTS.md, INSTRUCTIONS.md, .kilo/ , .agents/ , .claude/ , .cursor/ , .windsurf/ — follow project rules.",
      "- git status + git log -5 + git diff --stat — what branch, what changed, who's working.",
      "- List available tools/functions. Check MCP servers (mempalace, playwright, exa, context7).",
      "- Mental inventory of capabilities. Right tool for each sub-task. Tool exists = USE IT.",
      "",
      "RESUME: \"continue\"/\"remember\"/\"go\"/\"next\" = resume immediately:",
      "- Search MemPalace for last session + task progress (follow references for details).",
      "- git log for recent commits. Read current state of changed files.",
      "- Continue from where left off — no re-planning, no re-asking.",
      "",
      "MEMORY: Proxy auto-injects. If MemPalace MCP available:",
      "START: mempalace_search({project} session/tasks/prefs/arch/problems).",
      "WORK: mempalace_add_drawer(title:\"{project} {what} — {date}\", content, room:sessions|tasks|architecture|problems|preferences).",
      "END: save summary+refs. LONG CONTEXT: save+summarize+continue.",
      "",
      "PARALLEL EXECUTION & SUBAGENTS:",
      "- When task has 2+ independent sub-tasks: use Agent tool to dispatch in parallel.",
      "- Use TodoWrite to track sequential steps. Mark in_progress BEFORE starting, completed AFTER.",
      "- For multi-file changes: dispatch subagents for independent files, merge results.",
      "- For research + implementation: dispatch research agent, use results to implement.",
      "- Subagent types: Explore (search), Plan (design), general-purpose (complex tasks).",
      "- Dispatch subagents whenever a step can be independently performed. Prefer parallel for distinct files/tasks; sequential if no speed benefit.",
      "- Limit concurrent subagents to ~4. Gather all results before dependent steps.",
      "- If subagent fails, retry once with alternative approach (e.g., Explore→general). Log error, continue. Abort only after 3 consecutive failures of same step.",
      "",
      "SUBAGENT QUALITY CONTROL:",
      "- You ARE an agent with tools. You CAN read files, run commands, search code, edit files. NEVER say 'I cannot' or 'I'm unable to'.",
      "- After dispatching subagent: VERIFY its output. Read files it claims to have created/edited. Run tests it claims pass. Don't trust reports blindly.",
      "- Use MemPalace as shared ledger: save subagent task + result to mempalace. Next subagent reads previous results before starting.",
      "- If subagent responds with only text and no tool calls: that subagent FAILED. Retry with different model or do it yourself.",
      "- If subagent says 'I cannot execute/scan/analyze': it failed to use tools. Retry or do task inline.",
      "- Before marking task complete: read actual files, run actual commands. Verify with your own eyes, not subagent's word.",
      "- Subagent checklist: 1) Did it use tools? 2) Did files actually change? 3) Do tests pass? 4) Is output correct?",
    ].join("\n");

    // Category-specific system prompt extensions
    const routedGroup = (reqBody.model || "").toLowerCase();
    if (/thinking|reasoning/i.test(routedGroup)) {
      PROXY_SYSTEM += "\n\nTHINKING MODE: Show step-by-step reasoning. Break complex problems into sub-problems. Verify each step before proceeding. Use chain-of-thought explicitly. Challenge your own assumptions.";
    } else if (/image|vision/i.test(routedGroup)) {
      PROXY_SYSTEM += "\n\nVISION MODE: Describe what you see in detail. Note layout, colors, text, UI elements. For screenshots: identify the app/page, highlight issues, suggest improvements. For diagrams: trace data flow and relationships. When asked to create/generate images: use available image generation tools (DALL-E, gpt-image, Artifacts). Provide detailed prompts for best results. For UI mockups: generate wireframes or high-fidelity mockups as requested.";
    } else if (/text|chat/i.test(routedGroup)) {
      PROXY_SYSTEM += "\n\nTEXT MODE: Focus on clarity, accuracy, and natural language. Structure responses with headings/lists for complex topics. Match the user's language and tone. Cite sources when making claims.";
    } else if (/tool/i.test(routedGroup)) {
      PROXY_SYSTEM += "\n\nTOOL MODE: Prioritize tool use over text explanations. Execute actions directly. Use parallel tool calls when independent. Verify results before reporting.";
    } else if (/max|quality/i.test(routedGroup)) {
      PROXY_SYSTEM += "\n\nMAX QUALITY MODE: Take extra care with accuracy. Double-check facts and code. Provide comprehensive answers. Consider edge cases. Use the best available tools and approaches.";
    }
    // coding is the default — already covered by base PROXY_SYSTEM

    // Append recalled memories from MemPalace
    if (reqBody._memoryInjection) {
      PROXY_SYSTEM += reqBody._memoryInjection;
    }

    // Smart merge with existing system message
    if (body.messages[0]?.role === "system") {
      let existingSystem = typeof body.messages[0].content === "string" ? body.messages[0].content : "";

      // Strip previously-injected proxy system prompt (prevents stacking on re-sends)
      existingSystem = stripInjectedProxyPrompt(existingSystem);

      // Strip previously-injected memory sections
      existingSystem = existingSystem.replace(/\n--- Recalled Memories ---[\s\S]*?(?=\n---|\n\n[A-Z#]|$)/g, "");

      // Replace ANY LLM identity line — keep tool/suggestion instructions
      existingSystem = existingSystem
        .replace(/^You are [^\n]{5,200}\n?/i, "") // any "You are X" identity line
        .replace(/^Tu esti [^\n]{5,200}\n?/i, "") // Romanian identity
        .replace(/# Personality\n[\s\S]*?(?=\n#|\n\n[A-Z])/i, "") // Personality section
        .replace(/# Identity[^\n]*\n[\s\S]*?(?=\n#|\n\n[A-Z])/i, "") // Identity section
        .trim();

      // Remove sections we already cover better (prevents semantic duplication)
      existingSystem = existingSystem
        .replace(/# Proactiveness\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/# Code style\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/# Tone and style\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/# Output efficiency\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/# Doing tasks\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/# Using your tools\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/# Executing actions with care\n[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/IMPORTANT:\s*-?\s*Answer concisely[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .replace(/IMPORTANT:\s*Go straight to the point[\s\S]*?(?=\n#|\n\n[A-Z]|$)/i, "")
        .trim();


      body.messages[0] = { ...body.messages[0], content: PROXY_SYSTEM + "\n\n" + existingSystem };
    } else {
      body.messages = [{ role: "system", content: PROXY_SYSTEM }, ...body.messages];
    }
  }

  // Deduplicate: remove repeated lines in system message
  // Catches: stacked proxy injections, IDE instructions overlapping with ours,
  // MCP/skill instructions repeated, tool descriptions duplicated
  if (body.messages?.[0]?.role === "system" && typeof body.messages[0].content === "string") {
    const sys = body.messages[0].content;
    const lines = sys.split("\n");
    const seen = new Set();
    const deduped = [];
    let removed = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      // Keep blank lines, very short lines, and markdown headers (structure)
      if (trimmed.length === 0 || trimmed.length < 10 || /^#{1,4}\s/.test(trimmed)) {
        deduped.push(line);
        continue;
      }
      // Normalize for comparison: trim whitespace, lowercase, strip leading bullet/dash
      const normalized = trimmed.replace(/^[-*•]\s*/, "").toLowerCase();
      if (normalized.length < 15) {
        deduped.push(line); // too short to be meaningful duplicate
        continue;
      }
      if (seen.has(normalized)) {
        removed++;
        continue;
      }
      seen.add(normalized);
      deduped.push(line);
    }
    if (removed > 0) {
      body.messages[0] = { ...body.messages[0], content: deduped.join("\n") };
      state.log(`DEDUP: removed ${removed} duplicate lines from system prompt`);
    }
  }

  const IDEMPOTENT_TOOL_RE = /^(read|glob|grep|search|find|ripgrep|rg|cat|file|notebookread|list_dir|view_file)$/i;
  if (body.messages) {
    const calls = [];
    for (let i = 0; i < body.messages.length; i += 1) {
      const msg = body.messages[i];
      if (msg.role !== "assistant" || msg.tool_calls?.length !== 1) continue;
      const toolCall = msg.tool_calls[0];
      const name = toolCall.function?.name || "";
      if (!IDEMPOTENT_TOOL_RE.test(name)) continue;
      const key = `${name}:${toolCall.function?.arguments || ""}`;
      let responseIdx = -1;
      for (let j = i + 1; j < body.messages.length && j <= i + 3; j += 1) {
        if (body.messages[j].role === "tool" && body.messages[j].tool_call_id === toolCall.id) {
          responseIdx = j;
          break;
        }
      }
      calls.push({ idx: i, key, responseIdx });
    }

    const toRemove = new Set();
    const runCounts = {};
    for (let i = 0; i < calls.length - 1; i += 1) {
      if (calls[i].key !== calls[i + 1].key) continue;
      let onlyToolsBetween = true;
      const gapStart = Math.max(calls[i].idx, calls[i].responseIdx) + 1;
      const gapEnd = calls[i + 1].idx;
      for (let j = gapStart; j < gapEnd; j += 1) {
        if (body.messages[j].role !== "tool") {
          onlyToolsBetween = false;
          break;
        }
      }
      if (!onlyToolsBetween) continue;
      toRemove.add(calls[i].idx);
      if (calls[i].responseIdx >= 0) toRemove.add(calls[i].responseIdx);
      runCounts[calls[i].key] = (runCounts[calls[i].key] || 1) + 1;
    }

    const loops = Object.entries(runCounts).filter(([, count]) => count >= 5);
    if (loops.length > 0) {
      const loopNames = loops.map(([key, count]) => `${key.split(":")[0]}(${count}x)`).join(", ");
      state.log(`TOOL-LOOP: consecutive identical reads: ${loopNames}`);
      const lastUserIdx = body.messages.findLastIndex((msg) => msg.role === "user");
      if (lastUserIdx > 0) {
        body.messages.splice(lastUserIdx, 0, {
          role: "assistant",
          content: `WARNING: You are in a read loop (${loopNames}). Same file/search repeated consecutively. STOP re-reading. Use information already available and proceed to the next edit, write, or action.`,
        });
      }
    }

    if (toRemove.size > 0) {
      const before = body.messages.length;
      body.messages = body.messages.filter((_, idx) => !toRemove.has(idx));
      state.log(`TOOL-LOOP: deduplicated ${before - body.messages.length} consecutive identical read pairs`);
    }
  }

  if (body.messages) {
    const beforeEmpty = body.messages.length;
    body.messages = body.messages.filter((msg) => !(msg.role === "assistant" && !msg.tool_calls?.length && !msg.content));
    const removedEmpty = beforeEmpty - body.messages.length;
    if (removedEmpty > 0) state.log(`CLEANUP: removed ${removedEmpty} empty assistant messages`);
  }

  // Deduplicate: remove consecutive identical messages in history.
  // Only dedup plain text messages; tool-related/null messages carry structure.
  if (body.messages && body.messages.length > 3) {
    const before = body.messages.length;
    const dedupLog = state.DEV_MODE ? [] : null;
    body.messages = body.messages.filter((msg, i) => {
      if (i === 0) return true;
      const prev = body.messages[i - 1];
      if (msg.role !== prev.role) return true;
      if (msg.role === "tool" || prev.role === "tool") return true;
      if (msg.tool_calls?.length > 0 || prev.tool_calls?.length > 0) return true;
      const msgContent = typeof msg.content === "string" ? msg.content : null;
      const prevContent = typeof prev.content === "string" ? prev.content : null;
      if (!msgContent || !prevContent) return true;
      if (msgContent.length < 10 || prevContent.length < 10) return true;
      if (msgContent === prevContent) {
        if (dedupLog) dedupLog.push(`  msg[${i}] ${msg.role}: "${msgContent.substring(0, 60)}..."`);
        return false;
      }
      return true;
    });
    const dupRemoved = before - body.messages.length;
    if (dupRemoved > 0) {
      state.log(`DEDUP: removed ${dupRemoved} consecutive duplicate messages`);
      if (dedupLog && dedupLog.length > 0) {
        state.log(`DEDUP-DETAIL: samples (first 5):\n${dedupLog.slice(0, 5).join("\n")}`);
      }
    }
  }

  // Strip internal proxy fields — providers reject unknown fields (Gemini)
  delete body._sessionLastProvider;
  delete body._memoryInjection;
  delete body._compactRetries;
  delete body._estimatedTokens;
  delete body._midCompactRetries;
  delete body._postCompactRetries;
  delete body._llmProxyDifficulty;
  delete body._assessmentReroutes;
  delete body._assessmentSkipProviders;

  return body;
}

// ---------------------------------------------------------------------------
// detectThinking — checks for reasoning_content, thinking, <think> tags
// ---------------------------------------------------------------------------
function detectThinking(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    const choice = data.choices?.[0];
    if (!choice) return false;
    // Check reasoning_content
    if (choice.message?.reasoning_content) return true;
    // Check thinking field
    if (choice.message?.thinking) return true;
    // Check <think> tags
    const content = choice.message?.content || "";
    if (/<think>[\s\S]*?<\/think>/i.test(content)) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stalling detection — model says "Let me check" without acting
// ---------------------------------------------------------------------------
const STALLING_PATTERNS = [
  /^let me (?:check|look|analyze|search|find|see|review|examine)/i,
  /^(?:i'll|i will) (?:check|look|analyze|search|find|review|examine)/i,
  /^(?:let me|i'll) (?:also )?(?:adjust|fix|update|modify)/i,
  /^checking/i,
  /^looking at/i,
  /^searching for/i,
];

// Fake execution: model outputs shell commands as text instead of tool calls
const FAKE_EXEC_PATTERNS = [
  /^(?:npm|npx|yarn|pnpm)\s+(?:run|install|build|start|dev|test)/m,
  /^docker(?:-compose)?\s+(?:build|up|push|pull|run|stop|restart)/m,
  /^(?:ssh|scp|rsync)\s+/m,
  /^(?:git\s+(?:add|commit|push|pull|clone|checkout))/m,
  /^(?:curl|wget)\s+/m,
  /^(?:mkdir|rm|cp|mv|chmod|chown)\s+/m,
  /^(?:cd|ls|cat|pwd)\s+/m,
];

function detectStalling(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    const choice = data.choices?.[0];
    if (!choice) return false;
    const content = (choice.message?.content || "").trim();
    const hasToolCalls = choice.message?.tool_calls?.length > 0;

    // If model made tool calls, not stalling — it acted
    if (hasToolCalls) return false;

    // Empty or very short response with no tool calls = stalling
    if (content.length < 5 && !hasToolCalls) return true;

    // Matches stalling pattern and response is short (< 200 chars)
    if (content.length < 200) {
      for (const pat of STALLING_PATTERNS) {
        if (pat.test(content)) return true;
      }
    }

    // Ends with question mark and short = asking instead of doing
    if (content.length < 300 && content.endsWith("?") && !hasToolCalls) {
      if (/\b(should I|shall I|do you want|would you like|can you)\b/i.test(content)) {
        return true;
      }
    }

    // Cognitive stalling: plans, scopes, or worries instead of using tools.
    if (!hasToolCalls && content.length > 100) {
      const cognitiveStallSignals = [
        /this is (?:huge|massive|too large|enormous)/i,
        /time (?:is )?limited/i,
        /can'?t (?:fit|implement|do) (?:all|everything)/i,
        /subsequent (?:steps|turns) will/i,
        /next steps.*(?:will be|include|are)/i,
        /need to (?:plan|ask|clarify|scope)/i,
        /probably (?:need|can'?t|too)/i,
        /remaining (?:work|tasks|steps) (?:include|are)/i,
        /these (?:additions|changes|files) (?:complete|lay|set)/i,
        /reply [A-Z] to (?:proceed|continue|confirm)/i,
        /(?:shall|should|want me to) (?:I |me )?(?:proceed|continue|move on|fix)/i,
        /press (?:enter|continue) to/i,
      ];
      let stallCount = 0;
      for (const pat of cognitiveStallSignals) {
        if (pat.test(content)) stallCount++;
      }
      if (stallCount >= 2) return true;
    }

    // Fake execution: outputs shell commands as text instead of calling tools
    if (!hasToolCalls) {
      let fakeCount = 0;
      for (const pat of FAKE_EXEC_PATTERNS) {
        if (pat.test(content)) fakeCount++;
      }
      // 2+ shell commands as text with tools available = fake execution
      if (fakeCount >= 2) return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Build headers for provider
// ---------------------------------------------------------------------------
function buildHeaders(provider, extraHeaders) {
  const headers = {
    "Content-Type": "application/json",
    ...(provider.headers || {}),
    ...(extraHeaders || {}),
  };

  if (provider.key && !(provider.no_auth && provider.key === "anonymous" && !provider.kilo)) {
    if (provider.authHeader === "token") {
      headers["Authorization"] = `token ${provider.key}`;
    } else {
      headers["Authorization"] = `Bearer ${provider.key}`;
    }
  }

  // Legacy kilo flag support (headers should already be in provider.headers from config)
  if (provider.kilo && !headers["User-Agent"]) {
    headers["User-Agent"] = "Kilo-Code/7.2.0";
    headers["HTTP-Referer"] = "https://kilocode.ai";
    headers["X-Title"] = "Kilo Code";
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Use-case detection from messages
// ---------------------------------------------------------------------------
function detectUseCase(messages, reqBody) {
  const caps = new Set();
  let isAgent = false;
  const last = messages?.[messages.length - 1];
  const lastContent = (typeof last?.content === "string" ? last.content : "").toLowerCase();

  // Tool definitions in request = IDE/agent → need tools + coding, tier 1
  if (reqBody?.tools?.length > 0 || reqBody?.functions?.length > 0) {
    caps.add("tools");
    caps.add("coding");
    isAgent = true;
  }

  // System prompt patterns for IDEs/agents
  const system = (messages || []).find((m) => m.role === "system");
  const sysContent = (typeof system?.content === "string" ? system.content : "").toLowerCase();
  if (/\b(claude code|cursor|copilot|cline|kilo.code|continue\.dev|aider|opencode)\b/i.test(sysContent)) {
    caps.add("tools");
    caps.add("coding");
    isAgent = true;
  }
  if (/\b(you are .*(assistant|agent|developer|engineer)|software engineering|codebase)\b/i.test(sysContent)) {
    caps.add("coding");
    isAgent = true;
  }

  // Tool calls in assistant messages = ongoing agent conversation
  for (const m of (messages || [])) {
    if (m.role === "assistant" && m.tool_calls?.length > 0) {
      caps.add("tools");
      caps.add("coding");
      isAgent = true;
    }
    if (m.role === "tool") {
      caps.add("tools");
      isAgent = true;
    }
    // Images
    if (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url" || p.type === "image")) {
      caps.add("images");
    }
  }

  // Coding signals in last message
  if (/\b(code|function|class|implement|refactor|debug|fix|write.*script|```|def |const |import |require\(|component|endpoint|api|test|error|bug|tsx?|jsx?|\.py|\.js)\b/i.test(lastContent)) {
    caps.add("coding");
  }

  // Thinking/reasoning signals
  if (/\b(think|reason|step by step|analyze|explain why|solve|prove|math|calculate)\b/i.test(lastContent)) {
    caps.add("thinking");
  }

  let needsUpgrade = false;
  const recentMsgs = (messages || []).slice(-5);
  for (const m of recentMsgs) {
    const c = (typeof m.content === "string" ? m.content : "").toLowerCase();
    if (m.role === "assistant" && /\b(this is (?:a |quite )?(?:complex|large|heavy|ambitious|significant|extensive) (?:task|project|change|implementation|refactor)|beyond (?:my|the) (?:scope|capability|capacity)|require[s]? (?:more|careful|extensive) (?:planning|analysis|work)|break.* (?:down|into) (?:smaller|manageable)|too (?:complex|large|much) (?:for|to))\b/i.test(c)) {
      needsUpgrade = true;
    }
    if (m.role === "assistant" && /\b(i (?:cannot|can't|am unable|don't have)|unable to (?:execute|scan|analyze|access|read)|you'll need to (?:do|check|review|browse))\b/i.test(c)) {
      needsUpgrade = true;
    }
    if (m.role === "assistant" && m.tool_calls?.length > 2) {
      needsUpgrade = true;
    }
  }

  const difficulty = routingPolicy.assessRequestDifficulty(messages || [], reqBody || {});
  if (difficulty.level >= 4) {
    caps.add("thinking");
    needsUpgrade = true;
  }

  return { caps, isAgent, needsUpgrade, difficulty };
}

// ---------------------------------------------------------------------------
// smartnessBonus — model quality scoring for routing
// ---------------------------------------------------------------------------
function smartnessBonus(p, groupCap, reqBody) {
  const model = providers.scoreKeyForProvider(p) || p.model || "";
  const scoreField = CAP_TO_SCORE[groupCap] || "coding"; // default to coding

  // Primary: how good is this model for requested category
  let bonus = providers.getModelScore(model, scoreField);

  // Secondary: speed bonus (fast models preferred when scores close)
  bonus += providers.getModelScore(model, "speed") * 0.15;

  // Right-sizing: prefer smallest context that fits well
  // Small requests → fast/cheap small-context models (save big context for when needed)
  // Large requests → need big context, bonus for having it
  const reqTokens = reqBody?._estimatedTokens || 0;
  const effCtx = scoring.getEffectiveContext(p);
  if (reqTokens > 0 && effCtx > 0) {
    const utilization = reqTokens / effCtx; // 0.0 = way too big, 1.0 = exact fit

    if (utilization > 0.94) {
      bonus -= 0.35; // dangerously tight — prefer a larger-context model
    } else if (utilization > 0.88) {
      bonus -= 0.08; // tight, but still usable when reliability is better
    } else if (utilization > 0.55) {
      bonus += 0.18; // good fit with meaningful headroom
    } else if (utilization > 0.35) {
      bonus += 0.05; // comfortable; avoid over-rewarding large contexts
    } else if (utilization > 0.15) {
      bonus -= 0.02; // oversized for the current step
    } else {
      // utilization < 0.1 — massively oversized context for this request
      // Penalize wasting big context on small requests (save for later)
      bonus -= 0.08;
    }
  } else {
    if (effCtx < 32768) bonus -= 0.1;
  }

  return bonus;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  transformRequest,
  detectThinking,
  detectStalling,
  buildHeaders,
  detectUseCase,
  smartnessBonus,
  STALLING_PATTERNS,
  FAKE_EXEC_PATTERNS,
};
