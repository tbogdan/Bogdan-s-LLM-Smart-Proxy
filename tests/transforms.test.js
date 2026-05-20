"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const transforms = require("../lib/transforms");
const state = require("../lib/state");

const provider = {
  name: "Codex-Test",
  model: "gpt-5.3-codex",
  url: "http://codex.local/v1/chat/completions",
  key: "test",
  caps: ["tools", "coding"],
  context: 200000,
  tier: 1,
};

test("transformRequest sanitizes tool schemas and tool call history for provider compatibility", async () => {
  const request = {
    model: "auto-coding",
    parallel_tool_calls: true,
    tools: [
      {
        type: "function",
        function: {
          name: "bad tool name!",
          strict: true,
          parameters: { type: "object" },
        },
      },
    ],
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Use the tool." },
      {
        role: "assistant",
        content: "Calling the tool now.",
        tool_calls: [
          {
            id: "call_with_symbols_and_too_much_length",
            type: "function",
            function: { name: "bad tool name!", arguments: "{\"x\":1}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_with_symbols_and_too_much_length", content: "ok" },
      { role: "final", content: "invalid role" },
      { role: "user", content: "Continue." },
    ],
  };

  const transformed = await transforms.transformRequest(provider, request);
  const toolCall = transformed.messages.find((m) => m.role === "assistant" && m.tool_calls)?.tool_calls[0];
  const toolResult = transformed.messages.find((m) => m.role === "tool");

  assert.equal(transformed.parallel_tool_calls, undefined);
  assert.equal(transformed.tools[0].function.name, "bad_tool_name_");
  assert.equal(transformed.tools[0].function.strict, undefined);
  assert.match(toolCall.id, /^[a-zA-Z0-9]{9}$/);
  assert.equal(toolResult.tool_call_id, toolCall.id);
  assert.equal(transformed.messages.some((m) => m.role === "final"), false);
  assert.equal(transformed.messages.find((m) => m.role === "assistant" && m.tool_calls).content, null);
  assert.equal(transformed.messages.some((m, i, arr) => m.role === "tool" && arr[i + 1]?.role === "user"), false);
});

test("transformRequest never increases requested max_tokens while fitting context", async () => {
  const transformed = await transforms.transformRequest({
    ...provider,
    context: 3030,
  }, {
    model: "auto-coding",
    max_tokens: 1000,
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "x ".repeat(1900) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "x ".repeat(1900) },
      { role: "assistant", content: "ok" },
    ],
  });

  assert.equal(transformed.max_tokens <= 1000, true);
});

test("detectStalling catches planning-only cognitive stalls", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "This is a massive task and there are many next steps that will be needed. I probably need to plan more before changing files, and subsequent turns will implement the pieces.",
        },
      },
    ],
  });

  assert.equal(transforms.detectStalling(body), true);
});

test("detectStalling reads OpenAI content parts", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I'll check the files now." }],
        },
      },
    ],
  });

  assert.equal(transforms.detectStalling(body), true);
});

test("detectStalling catches permission-seeking continuation stalls", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "I found the next fixes. Reply A to proceed, or tell me if you want me to fix the next one. Press enter to continue.",
        },
      },
    ],
  });

  assert.equal(transforms.detectStalling(body), true);
});

test("detectUseCase requests stronger routing after recent complexity stalls", () => {
  const result = transforms.detectUseCase([
    { role: "system", content: "You are a software engineering agent." },
    { role: "user", content: "Implement the refactor." },
    {
      role: "assistant",
      content: "This is a complex implementation that requires more planning and should be broken down into smaller tasks before doing any code.",
    },
  ], { tools: [{ type: "function", function: { name: "edit" } }] });

  assert.equal(result.needsUpgrade, true);
});

test("detectUseCase reads system and user content parts", () => {
  const result = transforms.detectUseCase([
    {
      role: "system",
      content: [{ type: "text", text: "Claude Code software engineering agent." }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Fix the failing test in app.js." }],
    },
  ], {});

  assert.equal(result.isAgent, true);
  assert.equal(result.caps.has("coding"), true);
  assert.equal(result.caps.has("tools"), true);
});

test("smartnessBonus stays model-quality focused and leaves routing policy to routing", () => {
  const originalEnv = {
    LLM_COST_TARGET: process.env.LLM_COST_TARGET,
    LLM_SPEED_TARGET: process.env.LLM_SPEED_TARGET,
    LLM_THINKING_TARGET: process.env.LLM_THINKING_TARGET,
  };
  const reqBody = {
    model: "auto-coding",
    messages: [{ role: "user", content: "Implement a proxy adapter regression test." }],
    tools: [{ type: "function", function: { name: "Edit", parameters: { type: "object" } } }],
    _estimatedTokens: 12000,
  };
  const scoredProvider = {
    ...provider,
    cost_group: 5,
    speed_group: 2,
    thinking_effort: "xhigh",
    tc: true,
  };

  try {
    process.env.LLM_COST_TARGET = "1";
    process.env.LLM_SPEED_TARGET = "5";
    process.env.LLM_THINKING_TARGET = "none";
    const cheapTargetScore = transforms.smartnessBonus(scoredProvider, "coding", reqBody);

    process.env.LLM_COST_TARGET = "5";
    process.env.LLM_SPEED_TARGET = "1";
    process.env.LLM_THINKING_TARGET = "xhigh";
    const deepTargetScore = transforms.smartnessBonus(scoredProvider, "coding", reqBody);

    assert.equal(cheapTargetScore, deepTargetScore);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("transformRequest injects upgraded Project system prompt from upstream internals", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tools: [{ type: "function", function: { name: "Read" } }],
    messages: [
      { role: "system", content: "Keep this project-specific instruction." },
      { role: "user", content: "Implement a feature." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /You are Project LLM Smart Proxy/);
  assert.match(system, /If the user asks your name, identity, who you are/);
  assert.match(system, /Do not answer as Claude, ChatGPT, Gemini, Codex, Windsurf/);
  assert.match(system, /USE CASE FOCUS:/);
  assert.match(system, /Route profile: task=agentic_coding/);
  assert.match(system, /shape=write_heavy/);
  assert.match(system, /gate=run_behavior/);
  assert.match(system, /CODING MODE:/);
  assert.match(system, /STEP SHAPE:/);
  assert.match(system, /Type cheap: keep implementation narrow/);
  assert.match(system, /FLOW: UNDERSTAND.*DECOMPOSE.*EXECUTE.*VERIFY.*SAVE.*NEXT/);
  assert.match(system, /TASK DECOMPOSITION \(mandatory for large tasks\):/);
  assert.match(system, /ANTI-STALL RULES \(critical/);
  assert.match(system, /TOOL STRATEGY.*CRITICAL: You MUST use tools/);
  assert.match(system, /USER CONFIRMATION GATES:/);
  assert.match(system, /PLAN DISSEMINATION AND SELF-REVIEW:/);
  assert.match(system, /Before implementing a newly created plan, disseminate it into concrete phases/);
  assert.match(system, /After producing a plan or completing implementation, run a self-review pass/);
  assert.match(system, /RULES — AUTONOMY WITH USER GATES:/);
  assert.match(system, /You are autonomous after the user has authorized implementation/);
  assert.match(system, /Reply A to proceed without explicit user gate\|Press enter to continue without explicit user gate/);
  assert.match(system, /ONLY ask user when: destructive\/irreversible action/);
  assert.match(system, /LLM_PROXY_TASK_DIFFICULTY level=<1-5> effort=<none\|minimal\|low\|medium\|high\|xhigh> speed=<1-5> reason=<slug>/);
  assert.match(system, /EFFICIENT FILE READING:/);
  assert.match(system, /Read files in chunks using offset\/limit parameters/);
  assert.match(system, /Compacted tool outputs use \[READ/);
  assert.match(system, /If a file was already read and not modified, do NOT re-read it/);
  assert.match(system, /SUBAGENT QUALITY CONTROL:/);
  assert.match(system, /Keep this project-specific instruction\./);
  assert.equal(system.includes("Bogdan's LLM Smart Proxy"), false);
});

test("transformRequest skips difficulty marker contract for direct exact replies", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "user", content: "Reply exactly: metadata-ok" },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /You are Project LLM Smart Proxy/);
  assert.match(system, /DIRECT ANSWER MODE/);
  assert.match(system, /LIGHTWEIGHT MODE/);
  assert.equal(system.length < 1600, true);
  assert.doesNotMatch(system, /LLM_PROXY_TASK_DIFFICULTY level=<1-5>/);
  assert.doesNotMatch(system, /EVERY response MUST include at least one tool call/);
  assert.doesNotMatch(system, /FLOW: UNDERSTAND/);
});

test("transformRequest uses lightweight prompt for simple no-tool text requests", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-text",
    messages: [
      { role: "user", content: "Summarize these status notes in five bullets." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /LIGHTWEIGHT MODE/);
  assert.match(system, /SUMMARY MODE/);
  assert.match(system, /Route profile: task=list_summary/);
  assert.doesNotMatch(system, /PLAN DISSEMINATION AND SELF-REVIEW/);
  assert.equal(system.length < 1600, true);
  assert.doesNotMatch(system, /TOOL STRATEGY/);
  assert.doesNotMatch(system, /TASK DECOMPOSITION/);
});

test("transformRequest uses lightweight prompt for no-tool coding benchmark tasks", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "user", content: "Fix this inline JavaScript function and return the corrected code." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /LIGHTWEIGHT MODE/);
  assert.match(system, /CODING MODE/);
  assert.match(system, /Route profile: task=agentic_coding/);
  assert.equal(system.length < 1600, true);
  assert.doesNotMatch(system, /TOOL STRATEGY/);
});

test("transformRequest uses compact assessment prompt for complex no-tool smart routes", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-max",
    messages: [
      { role: "user", content: "Design a concurrency-safe architecture for a production incident involving streaming, provider cooldowns, benchmark fairness, and rollback risk." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /LIGHTWEIGHT MODE/);
  assert.match(system, /ARCHITECTURE RECOVERY MODE/);
  assert.match(system, /Route profile: task=architecture_recovery/);
  assert.match(system, /LLM_PROXY_TASK_DIFFICULTY level=<1-5>/);
  assert.equal(system.length < 1800, true);
  assert.doesNotMatch(system, /TOOL STRATEGY/);
  assert.doesNotMatch(system, /TASK DECOMPOSITION/);
});

test("transformRequest injects targeted review fragment for no-tool review tasks", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "user", content: "Review this completed feature before merge. Implemented validation and tests. Return risks only." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /LIGHTWEIGHT MODE/);
  assert.match(system, /REVIEW MODE/);
  assert.match(system, /Route profile: task=completion_review/);
  assert.doesNotMatch(system, /TOOL STRATEGY/);
  assert.doesNotMatch(system, /ARCHITECTURE RECOVERY MODE/);
});

test("transformRequest injects task, group, and cost matrix for thinking research", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-thinking",
    messages: [
      { role: "user", content: "Deep research model routing tradeoffs and compare options." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /RESEARCH MODE/);
  assert.match(system, /GROUP AUTO-THINKING/);
  assert.match(system, /Route profile: task=research group=auto-thinking level=5 cost=5\/5 effort=xhigh speed=2\/5 shape=read_heavy gate=plan_split/);
  assert.match(system, /Think expensive: spend reasoning on understanding/);
  assert.match(system, /Cost posture: spend tokens on correctness/);
});

test("transformRequest injects coding-sm group focus for small coding tasks", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "coding-sm",
    messages: [
      { role: "user", content: "Implement a small parser helper and add a focused unit test." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /CODING MODE|TEST MODE/);
  assert.match(system, /GROUP CODING-SM/);
  assert.match(system, /group=coding-sm/);
});

test("transformRequest injects image and video group fragments", async () => {
  const image = await transforms.transformRequest(provider, {
    model: "auto-image",
    messages: [
      { role: "user", content: "Generate an image prompt for a product hero mockup." },
    ],
  });
  const video = await transforms.transformRequest(provider, {
    model: "auto-video",
    messages: [
      { role: "user", content: "Create a short video storyboard for this workflow." },
    ],
  });

  assert.match(image.messages[0].content, /IMAGE MODE/);
  assert.match(image.messages[0].content, /GROUP IMAGE/);
  assert.match(video.messages[0].content, /VIDEO MODE/);
  assert.match(video.messages[0].content, /GROUP VIDEO/);
});

test("transformRequest can bypass proxy optimizations for benchmark direct calls", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "claude/claude-opus-4-6",
    _llmProxyBypassOptimizations: true,
    messages: [
      { role: "system", content: "Baseline instruction." },
      { role: "user", content: "Review this code and return findings." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_1", content: "Reading README.md\nFirst output." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_2", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_2", content: "Reading README.md\nSecond output." },
    ],
  });
  const readCalls = transformed.messages
    .filter((msg) => msg.role === "assistant" && msg.tool_calls?.[0]?.function?.name === "Read");

  assert.equal(transformed.messages[0].content, "Baseline instruction.");
  assert.equal(readCalls.length, 2);
  assert.equal(transformed._llmProxyBypassOptimizations, undefined);
  assert.doesNotMatch(JSON.stringify(transformed), /Project LLM Smart Proxy/);
  assert.doesNotMatch(JSON.stringify(transformed), /LLM_PROXY_TASK_DIFFICULTY/);
});

test("transformRequest tells models to wait when user explicitly gates implementation", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "user", content: "Review the project and propose improvements. After I confirm, you can implement." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /USER CONFIRMATION GATES:/);
  assert.match(system, /If the user explicitly asks for proposals, review, research, or a plan before implementation/);
  assert.match(system, /wait for the user's confirmation before editing files or running implementation steps/);
  assert.match(system, /Waiting for confirmation without explicit user requirement/);
});

test("transformRequest preserves existing system content parts during injection", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "Preserve " },
          { type: "text", text: "content parts." },
        ],
      },
      { role: "user", content: "Implement a feature." },
    ],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /You are Project LLM Smart Proxy/);
  assert.match(system, /Preserve \ncontent parts\./);
});

test("transformRequest replaces previous proxy prompt instead of stacking it", async () => {
  const first = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "system", content: "Keep this project-specific instruction." },
      { role: "user", content: "Implement a feature." },
    ],
  });

  const second = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      first.messages[0],
      { role: "user", content: "Continue." },
    ],
  });

  const system = second.messages[0].content;
  assert.equal((system.match(/You are Project LLM Smart Proxy/g) || []).length, 1);
  assert.equal((system.match(/SUBAGENT QUALITY CONTROL:/g) || []).length, 1);
  assert.match(system, /Keep this project-specific instruction\./);
});

test("transformRequest removes consecutive duplicate idempotent tool calls", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Read the same file." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_1", content: "Reading README.md\nFirst output." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_2", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_2", content: "Reading README.md\nSecond output." },
      { role: "user", content: "Continue." },
    ],
  });

  const readCalls = transformed.messages
    .filter((msg) => msg.role === "assistant" && msg.tool_calls?.[0]?.function?.name === "Read");
  const toolResponses = transformed.messages.filter((msg) => msg.role === "tool");

  assert.equal(readCalls.length, 1);
  assert.equal(toolResponses.length, 1);
  assert.match(toolResponses[0].content, /Second output/);
});

test("transformRequest keeps non-consecutive duplicate reads because files may change between turns", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_1", content: "Reading README.md\nFirst output." },
      { role: "assistant", content: "I will edit based on this." },
      { role: "user", content: "Now read it again after the edit." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_2", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_2", content: "Reading README.md\nSecond output." },
      { role: "user", content: "Continue." },
    ],
  });

  const readCalls = transformed.messages
    .filter((msg) => msg.role === "assistant" && msg.tool_calls?.[0]?.function?.name === "Read");

  assert.equal(readCalls.length, 2);
});

test("transformRequest removes empty assistant messages after tool synchronization", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Call a tool." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "unanswered_call", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "user", content: "Continue." },
    ],
  });

  assert.equal(transformed.messages.some((msg) => msg.role === "assistant" && !msg.content && !msg.tool_calls?.length), false);
});

test("transformRequest leaves internal AI summary self-calls unwrapped by proxy prompt", async () => {
  const transformed = await transforms.transformRequest(provider, {
    _llmProxyInternalSummary: true,
    model: "auto-text",
    messages: [
      { role: "system", content: "Summarize compacted context only." },
      { role: "user", content: "assistant: edited lib/compaction.js" },
    ],
  });

  assert.equal(transformed._llmProxyInternalSummary, undefined);
  assert.doesNotMatch(transformed.messages[0].content, /Project LLM Smart Proxy/);
  assert.match(transformed.messages[0].content, /Summarize compacted context only/);
});
