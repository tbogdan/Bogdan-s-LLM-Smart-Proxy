"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../lib/routing-policy");

test("classifyProvider assigns five cost groups across supported model families", () => {
  assert.equal(policy.classifyProvider({ family: "claude", model: "claude/claude-opus-4-7", name: "Claude-Opus47" }).cost_group, 4);
  assert.equal(policy.classifyProvider({ family: "claude", model: "claude/claude-sonnet-4-5", name: "Claude-Sonnet45" }).cost_group, 3);
  assert.equal(policy.classifyProvider({ family: "claude", model: "claude/claude-haiku-4-5", name: "Claude-Haiku45" }).cost_group, 2);
  assert.equal(policy.classifyProvider({ family: "codex", model: "codex/gpt-5.4-mini", name: "Codex-GPT54Mini" }).cost_group, 2);
  assert.equal(policy.classifyProvider({ family: "codex", model: "codex/gpt-5.5", name: "Codex-GPT55" }).cost_group, 4);
  assert.equal(policy.classifyProvider({ family: "codex", model: "codex/gpt-5.4", name: "Codex-GPT54" }).cost_group, 3);
  assert.equal(policy.classifyProvider({ family: "windsurf", model: "windsurf/swe-1.6-fast", name: "Windsurf-SWE16Fast" }).cost_group, 1);
  assert.equal(policy.classifyProvider({ family: "windsurf", model: "windsurf/minimax-m2.5", name: "Windsurf-MinimaxM25" }).cost_group, 1);
});

test("classifyProvider assigns researched quality, speed, and thinking defaults", () => {
  assert.deepEqual(
    policy.classifyProvider({ family: "claude", model: "claude/claude-sonnet-4-6", name: "Claude-Sonnet46" }),
    { cost_group: 3, quality_group: 4, speed_group: 4, thinking_effort: "medium", thinking_level: 3 },
  );
  assert.deepEqual(
    policy.classifyProvider({ family: "windsurf", model: "windsurf/gemini-3-0-flash", name: "Windsurf-Gemini3Flash" }),
    { cost_group: 1, quality_group: 4, speed_group: 5, thinking_effort: "medium", thinking_level: 3 },
  );
  assert.deepEqual(
    policy.classifyProvider({ family: "windsurf", model: "windsurf/grok-code-fast-1", name: "Windsurf-GrokCodeFast1" }),
    { cost_group: 2, quality_group: 3, speed_group: 5, thinking_effort: "low", thinking_level: 2 },
  );
});

test("routing targets parse elastic env budgets", () => {
  const targets = policy.getPolicyTargets({
    LLM_COST_TARGET: "2",
    LLM_THINKING_TARGET: "high",
    LLM_SPEED_TARGET: "5",
  });

  assert.equal(targets.costTarget, 2);
  assert.equal(targets.thinkingTarget, "high");
  assert.equal(targets.thinkingTargetLevel, 4);
  assert.equal(targets.speedTarget, 5);
});

test("assessRequestDifficulty separates trivial prompts from agentic refactors", () => {
  const trivial = policy.assessRequestDifficulty(
    [{ role: "user", content: "Reply exactly: ok" }],
    { _estimatedTokens: 16 },
  );
  const complex = policy.assessRequestDifficulty(
    [
      { role: "system", content: "You are a software engineering agent." },
      { role: "user", content: "Refactor the authentication flow across multiple files, fix failing tests, and verify Docker." },
    ],
    { tools: [{ type: "function", function: { name: "edit" } }], _estimatedTokens: 90000 },
  );

  assert.equal(trivial.level, 1);
  assert.equal(trivial.thinkingEffort, "none");
  assert.equal(trivial.speedTarget, 5);
  assert.equal(complex.level >= 4, true);
  assert.equal(["high", "xhigh"].includes(complex.thinkingEffort), true);
  assert.equal(complex.costTarget >= 4, true);
});

test("assessRequestDifficulty uses input size rather than response budget for task complexity", () => {
  const result = policy.assessRequestDifficulty(
    [{ role: "user", content: "Who are you?" }],
    {
      _inputTokens: 327,
      _estimatedTokens: 32327,
      max_tokens: 32000,
    },
  );

  assert.equal(result.level <= 2, true);
  assert.equal(result.costTarget, 2);
  assert.equal(result.speedTarget, 5);
});

test("assessRequestDifficulty keeps identity questions cheap even with agent tools and large history", () => {
  const result = policy.assessRequestDifficulty(
    [
      { role: "system", content: "You are Claude Code running as a software engineering agent with repository tools." },
      { role: "user", content: "<system-reminder> prior context omitted </system-reminder>\n\ncum te cheama?" },
    ],
    {
      tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
      _inputTokens: 166000,
      _estimatedTokens: 198000,
    },
  );

  assert.equal(result.level, 1);
  assert.equal(result.taskKind, "direct_answer");
  assert.equal(result.taskLevel, 1);
  assert.equal(result.contextLevel, 1);
  assert.equal(result.costTarget, 2);
  assert.equal(result.thinkingEffort, "none");
  assert.equal(result.speedTarget, 5);
});

test("assessRequestDifficulty treats large Claude Code tool requests as complex even when user ask is hidden", () => {
  const result = policy.assessRequestDifficulty(
    [
      { role: "system", content: "You are Claude Code running as a software engineering agent with repository tools." },
      { role: "user", content: "<system-reminder> SessionStart:startup hook success." },
    ],
    {
      tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
      _inputTokens: 35548,
      _estimatedTokens: 67548,
    },
  );

  assert.equal(result.level, 4);
  assert.equal(result.taskLevel, 3);
  assert.equal(result.contextLevel, 4);
  assert.equal(result.costTarget, 3);
  assert.equal(result.thinkingEffort, "medium");
  assert.equal(result.speedTarget, 4);
});

test("assessRequestDifficulty separates task complexity from large context pressure", () => {
  const result = policy.assessRequestDifficulty(
    [
      { role: "system", content: "You are Claude Code running as a software engineering agent with repository tools." },
      { role: "user", content: "<system-reminder> SessionStart:startup hook success." },
    ],
    {
      tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
      _inputTokens: 141013,
      _estimatedTokens: 173013,
    },
  );

  assert.equal(result.level, 4);
  assert.equal(result.taskLevel, 3);
  assert.equal(result.contextLevel, 4);
  assert.equal(result.thinkingEffort, "medium");
  assert.equal(result.speedTarget, 4);
});

test("difficulty markers are parsed and stripped from OpenAI responses", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "LLM_PROXY_TASK_DIFFICULTY level=4 effort=high speed=2 reason=multi_file_refactor\nI will inspect the repo.",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);

  assert.equal(result.marker.level, 4);
  assert.equal(result.marker.effort, "high");
  assert.equal(result.marker.speed, 2);
  assert.equal(JSON.parse(result.body).choices[0].message.content, "I will inspect the repo.");
});

test("difficulty marker stripping preserves same-line assistant content", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "LLM_PROXY_TASK_DIFFICULTY level=1 effort=none speed=5 reason=exact_reply ok",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);

  assert.equal(result.marker.level, 1);
  assert.equal(JSON.parse(result.body).choices[0].message.content, "ok");
});

test("difficulty marker stripping removes leading blank lines before marker", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "\n\nLLM_PROXY_TASK_DIFFICULTY level=1 effort=none speed=5 reason=identity-question\n\nMy name is Project LLM Smart Proxy.",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);

  assert.equal(result.marker.level, 1);
  assert.equal(JSON.parse(result.body).choices[0].message.content, "My name is Project LLM Smart Proxy.");
});

test("difficulty marker stripping preserves attached uppercase same-line content", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "LLM_PROXY_TASK_DIFFICULTY level=1 effort=minimal speed=5 reason=identity_replyMy name is Project LLM Smart Proxy.",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);

  assert.equal(result.marker.level, 1);
  assert.equal(result.marker.reason, "identity_reply");
  assert.equal(JSON.parse(result.body).choices[0].message.content, "My name is Project LLM Smart Proxy.");
});

test("difficulty marker stripping supports OpenAI content parts", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "LLM_PROXY_TASK_DIFFICULTY level=2 effort=low speed=4 reason=content_parts\nProject " },
            { type: "text", text: "LLM Smart Proxy." },
          ],
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);
  const content = JSON.parse(result.body).choices[0].message.content;

  assert.equal(result.marker.level, 2);
  assert.deepEqual(content, [
    { type: "text", text: "Project " },
    { type: "text", text: "LLM Smart Proxy." },
  ]);
});

test("providerPolicyBonus favors cheaper fast models for trivial tasks and stronger models for complex tasks", () => {
  const cheap = { name: "Codex-GPT54Mini", family: "codex", model: "codex/gpt-5.4-mini", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const expensive = { name: "Claude-Opus47", family: "claude", model: "claude/claude-opus-4-7", caps: ["text", "coding", "tools", "thinking", "max"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };

  const trivial = { messages: [{ role: "user", content: "Reply exactly: ok" }], _estimatedTokens: 20 };
  const complex = {
    messages: [{ role: "user", content: "Design and implement a multi-file architecture migration with tests." }],
    tools: [{ type: "function", function: { name: "edit" } }],
    _estimatedTokens: 110000,
  };

  assert.equal(policy.providerPolicyBonus(cheap, trivial, { env }) > policy.providerPolicyBonus(expensive, trivial, { env }), true);
  assert.equal(policy.providerPolicyBonus(expensive, complex, { env }) > policy.providerPolicyBonus(cheap, complex, { env }), true);
});

test("providerPolicyBonus does not reward heavy thinking for context-only pressure", () => {
  const medium = { name: "Medium-Context-Fit", model: "custom/medium", cost_group: 2, quality_group: 3, speed_group: 5, thinking_effort: "medium" };
  const high = { name: "High-Context-Fit", model: "custom/high", cost_group: 2, quality_group: 3, speed_group: 5, thinking_effort: "high" };
  const req = {
    messages: [
      { role: "system", content: "You are Claude Code running as a software engineering agent." },
      { role: "user", content: "<system-reminder> SessionStart:startup hook success." },
    ],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _inputTokens: 141013,
    _estimatedTokens: 173013,
  };

  assert.equal(policy.effectiveRequestProfile(req).taskLevel, 3);
  assert.equal(policy.effectiveRequestProfile(req).contextLevel >= 4, true);
  assert.equal(policy.providerPolicyBonus(medium, req) >= policy.providerPolicyBonus(high, req), true);
});

test("providerPolicyBonus treats SWE as task-list and summary specialist, not default coding choice", () => {
  const swe = { name: "Windsurf-SWE16Fast", family: "windsurf", model: "windsurf/swe-1.6-fast", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const codex = { name: "Codex-GPT54", family: "codex", model: "codex/gpt-5.4", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };

  const summaryReq = {
    messages: [{ role: "user", content: "Make a list of remaining tasks and summarize status." }],
    _estimatedTokens: 2000,
  };
  const codingReq = {
    messages: [{ role: "user", content: "Implement the code changes, edit files, and run tests." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 9000,
  };

  assert.equal(policy.assessRequestDifficulty(summaryReq.messages, summaryReq).taskKind, "list_summary");
  assert.equal(policy.providerPolicyBonus(swe, summaryReq, { env }) > policy.providerPolicyBonus(codex, summaryReq, { env }), true);
  assert.equal(policy.providerPolicyBonus(codex, codingReq, { env }) > policy.providerPolicyBonus(swe, codingReq, { env }), true);
});

test("providerPolicyBonus prefers Codex auto-review after a task completion report", () => {
  const review = { name: "Codex-AutoReview", family: "codex", model: "codex/codex-auto-review", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const codex = { name: "Codex-GPT54", family: "codex", model: "codex/gpt-5.4", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [
      { role: "assistant", content: "Changes:\n- Fixed routing.\n- Ran tests." },
      { role: "user", content: "task completed, verify the changes and review them" },
    ],
    tools: [{ type: "function", function: { name: "Bash" } }],
    _estimatedTokens: 9000,
  };

  assert.equal(policy.assessRequestDifficulty(req.messages, req).taskKind, "completion_review");
  assert.equal(policy.providerPolicyBonus(review, req, { env }) > policy.providerPolicyBonus(codex, req, { env }), true);
});

test("assessment reroute keeps cheap high-thinking providers when only cost differs", () => {
  const provider = {
    name: "Windsurf-SWE16Fast",
    model: "windsurf/swe-1.6-fast",
    family: "windsurf",
    cost_group: 2,
    speed_group: 5,
    thinking_effort: "high",
  };
  const marker = {
    level: 4,
    costTarget: 4,
    thinkingLevel: 4,
    speedTarget: 2,
    effort: "high",
  };

  assert.equal(policy.shouldRerouteForMarker(provider, marker, {}), false);
});

test("assessment reroute still upgrades clearly underpowered providers", () => {
  const provider = {
    name: "Tiny-Low",
    model: "custom/tiny-low",
    family: "custom",
    cost_group: 1,
    speed_group: 5,
    thinking_effort: "low",
  };
  const marker = {
    level: 5,
    costTarget: 5,
    thinkingLevel: 5,
    speedTarget: 2,
    effort: "xhigh",
  };

  assert.equal(policy.shouldRerouteForMarker(provider, marker, {}), true);
});
