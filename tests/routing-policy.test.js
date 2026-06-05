"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../lib/routing-policy");
const seedProviders = require("../seed-providers.json");

test("classifyProvider assigns five cost groups across supported model families", () => {
  assert.equal(policy.classifyProvider({ family: "claude", model: "claude/claude-opus-4-7", name: "Claude-Opus47" }).cost_group, 4);
  assert.equal(policy.classifyProvider({ family: "claude", model: "claude/claude-sonnet-4-5", name: "Claude-Sonnet45" }).cost_group, 3);
  assert.equal(policy.classifyProvider({ family: "claude", model: "claude/claude-haiku-4-5", name: "Claude-Haiku45" }).cost_group, 2);
  assert.equal(policy.classifyProvider({ family: "codex", model: "codex/gpt-5.4-mini", name: "Codex-GPT54Mini" }).cost_group, 2);
  assert.equal(policy.classifyProvider({ family: "codex", model: "codex/gpt-5.5", name: "Codex-GPT55" }).cost_group, 4);
  assert.equal(policy.classifyProvider({ family: "codex", model: "codex/gpt-5.4", name: "Codex-GPT54" }).cost_group, 3);
  assert.equal(policy.classifyProvider({ family: "copilot", model: "copilot/gpt-4.1", name: "Copilot-GPT41" }).cost_group, 3);
  assert.equal(policy.classifyProvider({ family: "windsurf", model: "windsurf/swe-1.6-fast", name: "Windsurf-SWE16Fast" }).cost_group, 1);
  assert.equal(policy.classifyProvider({ family: "windsurf", model: "windsurf/minimax-m2.5", name: "Windsurf-MinimaxM25" }).cost_group, 1);
});

test("classifyProvider keeps API cost multipliers out of global cost groups", () => {
  assert.equal(policy.classifyProvider({ family: "copilot", model: "copilot/gpt-4.1", name: "Copilot-GPT41", cost_multiplier: 0 }).cost_group, 3);
  assert.equal(policy.classifyProvider({ family: "copilot", model: "copilot/claude-haiku-4.5", name: "Copilot-Haiku45", cost_multiplier: 0.33 }).cost_group, 2);
  assert.equal(policy.classifyProvider({ family: "copilot", model: "copilot/claude-sonnet-4.6", name: "Copilot-Sonnet46", cost_multiplier: 1 }).cost_group, 3);
  assert.equal(policy.classifyProvider({ family: "copilot", model: "copilot/claude-opus-4.6", name: "Copilot-Opus46", cost_multiplier: 3 }).cost_group, 4);
  assert.equal(policy.classifyProvider({ family: "copilot", model: "copilot/claude-opus-4.7", name: "Copilot-Opus47", cost_multiplier: 15 }).cost_group, 4);
});

test("classifyProvider assigns researched quality, speed, and thinking defaults", () => {
  assert.deepEqual(
    policy.classifyProvider({ family: "claude", model: "claude/claude-opus-4-8", name: "Claude-Opus48" }),
    { cost_group: 4, quality_group: 5, speed_group: 3, thinking_effort: "xhigh", thinking_level: 5 },
  );
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
  assert.deepEqual(
    policy.classifyProvider({ family: "copilot", model: "copilot/gpt-4.1", name: "Copilot-GPT41", tc: true, caps: ["text", "coding", "tools", "thinking"] }),
    { cost_group: 3, quality_group: 4, speed_group: 4, thinking_effort: "medium", thinking_level: 3 },
  );
});

test("providerMaxRoutingLevel reserves level 5 for frontier high-thinking models", () => {
  const cases = [
    [{ name: "Windsurf-ClaudeSonnet46", model: "windsurf/claude-sonnet-4.6", quality_group: 4, cost_group: 3, thinking_effort: "medium" }, 4],
    [{ name: "Windsurf-ClaudeSonnet46Thinking", model: "windsurf/claude-sonnet-4-6-thinking", quality_group: 4, cost_group: 3, thinking_effort: "high" }, 4],
    [{ name: "Claude-Sonnet46", model: "claude/claude-sonnet-4-6", quality_group: 4, cost_group: 3, thinking_effort: "medium" }, 4],
    [{ name: "Codex-GPT54", model: "codex/gpt-5.4", quality_group: 5, cost_group: 3, thinking_effort: "medium" }, 4],
    [{ name: "Windsurf-GPT54LowThinking", model: "windsurf/gpt-5-4-low", quality_group: 5, cost_group: 3, thinking_effort: "low" }, 4],
    [{ name: "Windsurf-GPT55NoThinking", model: "windsurf/gpt-5-5-none", quality_group: 5, cost_group: 4, thinking_effort: "none" }, 4],
    [{ name: "Windsurf-GPT55LowThinking", model: "windsurf/gpt-5-5-low", quality_group: 5, cost_group: 4, thinking_effort: "low" }, 4],
    [{ name: "Windsurf-Gemini31ProHighThinking", model: "windsurf/gemini-3-1-pro-high", quality_group: 5, cost_group: 2, thinking_effort: "high" }, 4],
    [{ name: "Claude-Opus48", model: "claude/claude-opus-4-8", quality_group: 5, cost_group: 4, thinking_effort: "high" }, 5],
    [{ name: "Windsurf-ClaudeOpus48", model: "windsurf/claude-opus-4.8", quality_group: 5, cost_group: 4, thinking_effort: "xhigh" }, 5],
    [{ name: "Claude-Opus47", model: "claude/claude-opus-4-7", quality_group: 5, cost_group: 4, thinking_effort: "xhigh" }, 5],
    [{ name: "Copilot-claudeopus47", model: "copilot/claude-opus-4.7", quality_group: 5, cost_group: 4, thinking_effort: "xhigh" }, 5],
    [{ name: "Claude-Opus46", model: "claude/claude-opus-4-6", quality_group: 5, cost_group: 4, thinking_effort: "xhigh" }, 5],
    [{ name: "Windsurf-ClaudeOpus46Thinking", model: "windsurf/claude-opus-4-6-thinking", quality_group: 5, cost_group: 4, thinking_effort: "xhigh" }, 5],
    [{ name: "Codex-GPT55", model: "codex/gpt-5.5", quality_group: 5, cost_group: 4, thinking_effort: "xhigh" }, 5],
    [{ name: "Windsurf-GPT54HighThinking", model: "windsurf/gpt-5-4-high", quality_group: 5, cost_group: 3, thinking_effort: "high" }, 5],
    [{ name: "Copilot-gpt4o20240513", model: "copilot/gpt-4o-2024-05-13", quality_group: 4, cost_group: 3, thinking_effort: "medium" }, 2],
    [{ name: "Copilot-gpt4opreview", model: "copilot/gpt-4-o-preview", quality_group: 4, cost_group: 3, thinking_effort: "medium" }, 2],
    [{ name: "Copilot-gpt4omini", model: "copilot/gpt-4o-mini", quality_group: 4, cost_group: 3, thinking_effort: "medium" }, 2],
    [{ name: "Copilot-gpt41", model: "copilot/gpt-4.1", quality_group: 4, cost_group: 3, thinking_effort: "medium" }, 3],
  ];

  for (const [providerConfig, expected] of cases) {
    assert.equal(
      policy.providerMaxRoutingLevel(providerConfig),
      expected,
      providerConfig.name,
    );
  }
});

test("providerMaxRoutingLevel keeps Opus effort variants at complex or frontier tiers", () => {
  for (const version of ["4-6", "4-7", "4-8"]) {
    for (const [effort, expected] of [["low", 4], ["medium", 4], ["high", 5], ["xhigh", 5]]) {
      const suffix = effort === "xhigh" ? "max" : effort;
      const provider = {
        name: `Windsurf-ClaudeOpus${version.replace("-", "")}${suffix}`,
        model: `windsurf/claude-opus-${version}-${suffix}`,
        upstream_model: `claude-opus-${version}-${suffix}`,
        quality_group: 5,
        cost_group: 4,
        thinking_effort: effort,
      };

      assert.equal(policy.providerMaxRoutingLevel(provider), expected, provider.model);
    }
  }
});

test("seed Haiku providers stay capped at standard routing tier", () => {
  const haikuProviders = (seedProviders.providers || []).filter((provider) => {
    const text = `${provider.name || ""} ${provider.model || ""} ${provider.upstream_model || ""}`.toLowerCase();
    return text.includes("haiku");
  });

  assert.ok(haikuProviders.length >= 3);
  for (const provider of haikuProviders) {
    const profile = policy.classifyProvider(provider);
    assert.equal(policy.providerMaxRoutingLevel(provider), 3, provider.name);
    assert.ok(profile.quality_group <= 3, `${provider.name} quality_group=${profile.quality_group}`);
    assert.ok(profile.thinking_level <= 2, `${provider.name} thinking_level=${profile.thinking_level}`);
  }
});

test("classifyProvider caps Haiku even when discovered metadata is too optimistic", () => {
  const provider = {
    name: "Copilot-claudehaiku45",
    family: "copilot",
    model: "copilot/claude-haiku-4.5",
    upstream_model: "claude-haiku-4.5",
    cost_group: 2,
    quality_group: 4,
    speed_group: 5,
    thinking_effort: "medium",
    thinking_level: 3,
  };

  assert.deepEqual(policy.classifyProvider(provider), {
    cost_group: 2,
    quality_group: 3,
    speed_group: 5,
    thinking_effort: "low",
    thinking_level: 2,
  });
  assert.equal(policy.providerMaxRoutingLevel(provider), 3);
});

test("source-local cost multiplier bonus compares only providers from the same source", () => {
  const req = {
    messages: [{ role: "user", content: "Summarize this short status update." }],
    _estimatedTokens: 1200,
  };
  const cheap = {
    name: "Cheap-Sonnet",
    family: "copilot",
    model: "copilot/cheap-sonnet",
    cost_group: 3,
    cost_multiplier: 1,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "medium",
  };
  const expensive = {
    ...cheap,
    name: "Expensive-Sonnet",
    model: "copilot/expensive-sonnet",
    cost_multiplier: 3,
  };
  const windsurf = {
    ...cheap,
    name: "Windsurf-Expensive",
    family: "windsurf",
    model: "windsurf/expensive",
    cost_multiplier: 3,
  };

  assert.equal(policy.providerPolicyBonus(cheap, req), policy.providerPolicyBonus(expensive, req));
  assert.equal(
    policy.sourceLocalCostMultiplierBonus(cheap, [cheap, expensive, windsurf], req) >
      policy.sourceLocalCostMultiplierBonus(expensive, [cheap, expensive, windsurf], req),
    true,
  );
  assert.equal(policy.sourceLocalCostMultiplierBonus(windsurf, [cheap, expensive, windsurf], req), 0);
});

test("providerPolicyBonus nudges frontier requests toward Opus 4.8 over older Opus", () => {
  const req = {
    messages: [{ role: "user", content: "Deep production incident: debug a hard multi-service failure with one million token context." }],
    _inputTokens: 620000,
    _estimatedTokens: 680000,
    _llmProxyDifficulty: {
      level: 5,
      taskKind: "debugging",
      taskLevel: 5,
      contextLevel: 5,
      costTarget: 4,
      qualityTarget: 5,
      thinkingLevel: 4,
      speedTarget: 3,
      stepShape: { shape: "read_heavy", posture: "think_expensive", gate: "plan_split" },
    },
  };
  const opus47 = {
    name: "Claude-Opus47",
    family: "claude",
    model: "claude/claude-opus-4-7",
    context: 1000000,
    caps: ["text", "coding", "tools", "thinking", "max"],
    cost_group: 4,
    quality_group: 5,
    speed_group: 3,
    thinking_effort: "xhigh",
  };
  const opus48 = {
    ...opus47,
    name: "Claude-Opus48",
    model: "claude/claude-opus-4-8",
  };

  assert.equal(policy.providerPolicyBonus(opus48, req) > policy.providerPolicyBonus(opus47, req), true);
});

test("providerPolicyBonus orders newer Opus and GPT frontier peers above older versions", () => {
  const req = {
    messages: [{ role: "user", content: "Debug a hard production incident with tests and a careful implementation plan." }],
    _inputTokens: 90000,
    _estimatedTokens: 120000,
    _llmProxyDifficulty: {
      level: 5,
      label: "deep",
      taskKind: "debugging",
      taskLevel: 5,
      contextLevel: 4,
      costTarget: 4,
      qualityTarget: 5,
      thinkingLevel: 4,
      speedTarget: 3,
      stepShape: { shape: "read_heavy", posture: "think_expensive", gate: "plan_split" },
    },
  };
  const opusBase = {
    family: "claude",
    context: 1000000,
    caps: ["text", "coding", "tools", "thinking", "max"],
    cost_group: 4,
    quality_group: 5,
    speed_group: 3,
    thinking_effort: "xhigh",
  };
  const gptBase = {
    family: "codex",
    context: 272000,
    caps: ["text", "coding", "tools", "thinking", "max"],
    cost_group: 4,
    quality_group: 5,
    speed_group: 3,
    thinking_effort: "xhigh",
  };
  const opus46 = { ...opusBase, name: "Claude-Opus46", model: "claude/claude-opus-4-6" };
  const opus47 = { ...opusBase, name: "Claude-Opus47", model: "claude/claude-opus-4-7" };
  const opus48 = { ...opusBase, name: "Claude-Opus48", model: "claude/claude-opus-4-8" };
  const gpt53 = { ...gptBase, name: "Codex-GPT53", model: "codex/gpt-5.3" };
  const gpt54 = { ...gptBase, name: "Codex-GPT54", model: "codex/gpt-5.4" };
  const gpt55 = { ...gptBase, name: "Codex-GPT55", model: "codex/gpt-5.5" };

  assert.equal(policy.providerPolicyBonus(opus47, req) > policy.providerPolicyBonus(opus46, req), true);
  assert.equal(policy.providerPolicyBonus(opus48, req) > policy.providerPolicyBonus(opus47, req), true);
  assert.equal(policy.providerPolicyBonus(gpt54, req) > policy.providerPolicyBonus(gpt53, req), true);
  assert.equal(policy.providerPolicyBonus(gpt55, req) > policy.providerPolicyBonus(gpt54, req), true);
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

test("routing policy exposes explicit operating modes and safe aliases", () => {
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "economy" }).routingPolicy, "economy");
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "cheap" }).routingPolicy, "economy");
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "balanced" }).routingPolicy, "balanced");
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "speed" }).routingPolicy, "speed");
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "fast" }).routingPolicy, "speed");
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "quality" }).routingPolicy, "quality");
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "capability" }).routingPolicy, "quality");
  assert.equal(policy.getPolicyTargets({ LLM_ROUTING_POLICY: "typo-mode" }).routingPolicy, "balanced");
});

test("routing policy modes adjust standard coding targets without lowering safety gates", () => {
  const req = {
    messages: [{ role: "user", content: "Implement this small route fix and run the focused test." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _inputTokens: 6000,
    _estimatedTokens: 12000,
  };
  const baseEnv = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };

  const economy = policy.effectiveRequestProfile(req, { ...baseEnv, LLM_ROUTING_POLICY: "economy" });
  const balanced = policy.effectiveRequestProfile(req, { ...baseEnv, LLM_ROUTING_POLICY: "balanced" });
  const speed = policy.effectiveRequestProfile(req, { ...baseEnv, LLM_ROUTING_POLICY: "speed" });
  const quality = policy.effectiveRequestProfile(req, { ...baseEnv, LLM_ROUTING_POLICY: "quality" });

  assert.equal(economy.costTarget < balanced.costTarget, true);
  assert.equal(economy.thinkingLevel <= balanced.thinkingLevel, true);
  assert.equal(speed.speedTarget > balanced.speedTarget, true);
  assert.equal(quality.costTarget > balanced.costTarget, true);
  assert.equal(quality.thinkingLevel > balanced.thinkingLevel, true);

  const security = policy.effectiveRequestProfile({
    messages: [{ role: "user", content: "Review this auth code for privilege bypass before release." }],
  }, { ...baseEnv, LLM_ROUTING_POLICY: "economy", LLM_SPEED_TARGET: "5" });

  assert.equal(security.costTarget >= 4, true);
  assert.equal(security.thinkingLevel >= 4, true);
  assert.equal(security.speedTarget <= 3, true);
});

test("routing policy modes change provider scoring posture", () => {
  const req = {
    messages: [{ role: "user", content: "Implement this focused routing fix and run the test." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _inputTokens: 6000,
    _estimatedTokens: 12000,
    _llmProxyDifficulty: {
      level: 3,
      taskKind: "agentic_coding",
      taskLevel: 3,
      contextLevel: 2,
      thinkingLevel: 3,
      speedTarget: 4,
      costTarget: 3,
      stepShape: { shape: "write_heavy", posture: "type_cheap", gate: "run_behavior" },
    },
  };
  const fastCheap = {
    name: "FastCheapMini",
    family: "windsurf",
    model: "windsurf/gpt-5-4-mini",
    caps: ["coding", "tools", "thinking"],
    cost_group: 1,
    quality_group: 3,
    speed_group: 5,
    thinking_effort: "low",
  };
  const balancedModel = {
    name: "BalancedSonnet",
    family: "windsurf",
    model: "windsurf/claude-sonnet-4.6",
    caps: ["coding", "tools", "thinking"],
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "medium",
  };
  const premiumModel = {
    name: "PremiumOpus",
    family: "windsurf",
    model: "windsurf/claude-opus-4.6",
    caps: ["coding", "tools", "thinking", "max"],
    cost_group: 4,
    quality_group: 5,
    speed_group: 3,
    thinking_effort: "high",
  };
  const baseEnv = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };

  assert.equal(
    policy.providerPolicyBonus(fastCheap, req, { env: { ...baseEnv, LLM_ROUTING_POLICY: "economy" } }) >
      policy.providerPolicyBonus(premiumModel, req, { env: { ...baseEnv, LLM_ROUTING_POLICY: "economy" } }),
    true,
  );
  assert.equal(
    policy.providerPolicyBonus(fastCheap, req, { env: { ...baseEnv, LLM_ROUTING_POLICY: "speed" } }) >
      policy.providerPolicyBonus(balancedModel, req, { env: { ...baseEnv, LLM_ROUTING_POLICY: "speed" } }),
    true,
  );
  assert.equal(
    policy.providerPolicyBonus(premiumModel, req, { env: { ...baseEnv, LLM_ROUTING_POLICY: "quality" } }) >
      policy.providerPolicyBonus(fastCheap, req, { env: { ...baseEnv, LLM_ROUTING_POLICY: "quality" } }),
    true,
  );
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

test("detectTaskKind covers the prompt-injection task matrix", () => {
  const cases = [
    ["direct_answer", "Reply exactly: ok"],
    ["list_summary", "Summarize this deployment status into five bullets."],
    ["translation_rewrite", "Rewrite this release note in a calmer tone."],
    ["explanation", "Explain how streaming backpressure works."],
    ["documentation", "Update the README setup guide for Docker."],
    ["vision_analysis", "Analyze this screenshot and describe the UI issue."],
    ["image_generation", "Generate an image prompt for a product hero mockup."],
    ["video_generation", "Create a short video storyboard for this workflow."],
    ["data_analysis", "Analyze routing logs, token cost, latency metrics, and provider scores."],
    ["verification", "Verify whether the proxy health endpoint responds correctly."],
    ["code_review", "Code review this diff and find behavioral bugs."],
    ["test_generation", "Add regression tests for this API parser."],
    ["debugging", "Debug this provider 500 error from the proxy logs."],
    ["security_review", "Review this auth endpoint for SQL injection and secret leakage."],
    ["refactor", "Refactor the routing module into smaller functions."],
    ["deployment_ops", "Deploy with docker compose over ssh and verify health checks."],
    ["research", "Deep research model routing tradeoffs and compare options."],
    ["benchmarking", "Build an A/B benchmark for latency, tokens, cost, and correctness."],
    ["planning", "Create a strategy proposal before implementation."],
    ["agentic_coding", "Implement the endpoint change and run tests."],
  ];

  for (const [kind, content] of cases) {
    assert.equal(policy.detectTaskKind([{ role: "user", content }], {}), kind, content);
  }
});

test("detectTaskKind prioritizes the latest coding/debug request over stale architecture context", () => {
  const staleArchitectureContext = [
    { role: "system", content: "You are a software engineering agent." },
    {
      role: "user",
      content: "Deep research production proxy incident: architecture recovery, routing class, long-context pressure, provider health, benchmark fairness.",
    },
    {
      role: "assistant",
      content: "Architecture recovery summary: keep provider health and routing fairness notes for later.",
    },
  ];

  const implementReq = {
    messages: [
      ...staleArchitectureContext,
      { role: "user", content: "Implement GitHub Copilot as a provider, edit the files, and run tests." },
    ],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 18000,
  };
  const debugReq = {
    messages: [
      ...staleArchitectureContext,
      { role: "user", content: "Check the logs: task kind is always architecture_recovery and routing goes to Opus. Debug the detector and improve it." },
    ],
    tools: [{ type: "function", function: { name: "Read" } }],
    _estimatedTokens: 22000,
  };

  assert.equal(policy.detectTaskKind(implementReq.messages, implementReq), "agentic_coding");
  assert.equal(policy.assessRequestDifficulty(implementReq.messages, implementReq).stepShape.shape, "write_heavy");
  assert.equal(policy.detectTaskKind(debugReq.messages, debugReq), "debugging");
});

test("auth token implementation is routed as coding, not security review", () => {
  const req = {
    messages: [
      { role: "assistant", content: "Prior note: security review requires human sign-off before release." },
      { role: "user", content: "Implement GitHub Copilot auth token discovery, fix provider matching, edit code, and run tests." },
    ],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 24000,
  };

  const assessed = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(assessed.taskKind, "agentic_coding");
  assert.equal(assessed.stepShape.shape, "write_heavy");
  assert.equal(assessed.costTarget <= 3, true);
});

test("security-review complaint text does not create human signoff for a read/build task", () => {
  const req = {
    messages: [
      {
        role: "user",
        content:
          "why is it asking for security review?! only high-risk tasks need that:\nwhich tools do we use from chaos-mesh and which tools are separate?\nlet's make a docker dashboard for chaos\nwe want to integrate the current logic, for example auto discovery from SSH_USER=btorcescu ./scripts/startup.sh\ndo a deep dive in the app and identify the best implementation path",
      },
    ],
    tools: [
      { type: "function", function: { name: "Read" } },
      { type: "function", function: { name: "Bash" } },
    ],
    _estimatedTokens: 18000,
  };

  const assessed = policy.assessRequestDifficulty(req.messages, req);

  assert.notEqual(assessed.taskKind, "security_review");
  assert.notEqual(assessed.stepShape.shape, "security");
  assert.notEqual(assessed.stepShape.gate, "human_signoff");
});

test("explicit replay and timing verifier patches stay security gated", () => {
  const req = {
    messages: [
      {
        role: "user",
        content:
          "Fix this Node.js webhook verifier. Current code accepts replayed tokens and leaks timing info. Required: header format t=<unix>,v1=<hex>; reject timestamps older than 5 minutes; compare with constant-time semantics; handle malformed hex safely.",
      },
    ],
    _estimatedTokens: 6000,
  };

  const assessed = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(assessed.taskKind, "security_review");
  assert.equal(assessed.stepShape.shape, "security");
  assert.equal(assessed.costTarget >= 4, true);
});

test("large context write-heavy coding does not imply frontier reasoning", () => {
  const req = {
    messages: [
      { role: "system", content: "You are Claude Code running as a software engineering agent with repository tools." },
      { role: "user", content: "Implement the approved Copilot provider discovery fix, update tests, and deploy locally with Docker." },
    ],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _inputTokens: 197000,
    _estimatedTokens: 229000,
  };

  const profile = policy.effectiveRequestProfile(req, {
    LLM_COST_TARGET: "3",
    LLM_THINKING_TARGET: "medium",
    LLM_SPEED_TARGET: "4",
    LLM_ROUTING_POLICY: "balanced",
  });

  assert.equal(profile.taskKind, "agentic_coding");
  assert.equal(profile.stepShape.shape, "write_heavy");
  assert.equal(profile.costTarget <= 3, true);
  assert.equal(profile.thinkingLevel <= 3, true);
  assert.equal(profile.speedTarget >= 4, true);
});

test("detectStepShape maps task shape to routing posture and validation gate", () => {
  const planning = policy.assessRequestDifficulty(
    [{ role: "user", content: "Understand the spec, plan the architecture migration, split it into sub-tasks, and list acceptance gates before coding." }],
    { _estimatedTokens: 6000 },
  );
  const repetitive = policy.assessRequestDifficulty(
    [{ role: "user", content: "Generate repetitive API client methods from this already-approved contract and keep the output concise." }],
    { _estimatedTokens: 3000 },
  );
  const destructive = policy.assessRequestDifficulty(
    [{ role: "user", content: "Plan a database migration that deletes old rows, includes rollback strategy, and must dry-run first on production-like data." }],
    { _estimatedTokens: 7000 },
  );
  const destructiveExecution = policy.assessRequestDifficulty(
    [{ role: "user", content: "Execute the production database migration that irreversibly deletes customer rows." }],
    { _estimatedTokens: 7000 },
  );
  const security = policy.assessRequestDifficulty(
    [{ role: "user", content: "Review this auth permission change for privilege bypass before merge." }],
    { _estimatedTokens: 4000 },
  );
  const llmReview = policy.assessRequestDifficulty(
    [{ role: "user", content: "Review this LLM-generated diff line by line; compare the summary to what the diff actually changed." }],
    { _estimatedTokens: 5000 },
  );

  assert.equal(planning.stepShape.shape, "read_heavy");
  assert.equal(planning.stepShape.posture, "think_expensive");
  assert.equal(planning.stepShape.gate, "plan_split");
  assert.equal(planning.thinkingLevel >= 4, true);

  assert.equal(repetitive.stepShape.shape, "write_heavy");
  assert.equal(repetitive.stepShape.posture, "type_cheap");
  assert.equal(repetitive.costTarget <= 3, true);
  assert.equal(repetitive.speedTarget >= 4, true);

  assert.equal(destructive.stepShape.shape, "destructive");
  assert.equal(destructive.stepShape.gate, "dry_run_first");
  assert.equal(destructive.thinkingLevel >= 4, true);

  assert.equal(destructiveExecution.stepShape.shape, "destructive");
  assert.equal(destructiveExecution.stepShape.gate, "human_signoff");

  assert.equal(security.stepShape.shape, "security");
  assert.equal(security.stepShape.gate, "human_signoff");

  assert.equal(llmReview.stepShape.shape, "review");
  assert.equal(llmReview.stepShape.gate, "read_diff");
});

test("planning is a high-reasoning design task, while executing a plan is coding work", () => {
  const createPlanReq = {
    messages: [{ role: "user", content: "Create an implementation plan for a multi-file routing migration before any code changes." }],
    _estimatedTokens: 4000,
  };
  const followPlanReq = {
    messages: [{ role: "user", content: "Follow the approved implementation plan and start applying the routing migration." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 12000,
  };

  const createPlan = policy.assessRequestDifficulty(createPlanReq.messages, createPlanReq);
  const followPlan = policy.assessRequestDifficulty(followPlanReq.messages, followPlanReq);

  assert.equal(createPlan.taskKind, "planning");
  assert.equal(createPlan.taskLevel >= 4, true);
  assert.equal(createPlan.thinkingLevel >= 4, true);
  assert.equal(createPlan.costTarget >= 4, true);
  assert.equal(followPlan.taskKind, "agentic_coding");
  assert.equal(followPlan.costTarget <= 3, true);
});

test("self-review after planning or implementation maps to low-cost review specialists", () => {
  const review = { name: "Codex-AutoReview", family: "codex", model: "codex/codex-auto-review", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const opus = { name: "Claude-Opus47", family: "claude", model: "claude/claude-opus-4-7", caps: ["text", "coding", "tools", "thinking", "max"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4", LLM_ROUTING_POLICY: "balanced" };
  const planReviewReq = {
    messages: [
      { role: "assistant", content: "Plan:\n1. Refactor routing policy.\n2. Add regression tests.\n3. Run benchmark." },
      { role: "user", content: "Self-review this plan for risks before implementation." },
    ],
    _estimatedTokens: 3000,
  };
  const implementationReviewReq = {
    messages: [
      { role: "assistant", content: "Implementation completed. Changes:\n- Updated routing.\n- Added tests.\n- Ran benchmark." },
      { role: "user", content: "Run a self-review of the completed work and report regressions only." },
    ],
    tools: [{ type: "function", function: { name: "Read" } }],
    _estimatedTokens: 9000,
  };

  assert.equal(policy.assessRequestDifficulty(planReviewReq.messages, planReviewReq).taskKind, "completion_review");
  assert.equal(policy.assessRequestDifficulty(implementationReviewReq.messages, implementationReviewReq).taskKind, "completion_review");
  assert.equal(policy.providerPolicyBonus(review, planReviewReq, { env }) > policy.providerPolicyBonus(opus, planReviewReq, { env }), true);
  assert.equal(policy.providerPolicyBonus(review, implementationReviewReq, { env }) > policy.providerPolicyBonus(opus, implementationReviewReq, { env }), true);
});

test("task matrix assigns cheap text tasks and expensive recovery tasks different targets", () => {
  const rewrite = policy.assessRequestDifficulty(
    [{ role: "user", content: "Rewrite this release note in a calmer tone." }],
    { _estimatedTokens: 500 },
  );
  const recovery = policy.assessRequestDifficulty(
    [
      { role: "assistant", content: "Edit failed: expected text was not found after a stale read." },
      { role: "user", content: "Continue the patch safely." },
    ],
    {
      tools: [{ type: "function", function: { name: "Edit" } }],
      _estimatedTokens: 50000,
    },
  );

  assert.equal(rewrite.taskKind, "translation_rewrite");
  assert.equal(rewrite.costTarget <= 2, true);
  assert.equal(rewrite.speedTarget, 5);
  assert.equal(recovery.taskKind, "edit_recovery");
  assert.equal(recovery.costTarget, 4);
  assert.equal(recovery.thinkingEffort, "high");
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

test("sentinel private effort markers are parsed, stripped, and kept as route hints", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "LLM_PROXY_INTERNAL_ROUTING effort=low speed=3 reason=followup\nLocal test-vm yes; run bash scripts/startup.sh",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);

  assert.equal(result.marker.level, 2);
  assert.equal(result.marker.effort, "low");
  assert.equal(result.marker.speed, 3);
  assert.equal(result.marker.reason, "followup");
  assert.equal(JSON.parse(result.body).choices[0].message.content, "Local test-vm yes; run bash scripts/startup.sh");
});

test("task status markers are parsed and stripped from OpenAI responses", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "LLM_PROXY_TASK_STATUS state=working reason=tests_pending\nI found the root cause.",
        },
      },
    ],
  });

  const result = policy.stripTaskStatusMarkerFromResponseBody(body);

  assert.equal(result.marker.state, "working");
  assert.equal(result.marker.reason, "tests_pending");
  assert.equal(JSON.parse(result.body).choices[0].message.content, "I found the root cause.");
});

test("sentinel private effort markers can request higher rerouting levels", () => {
  const marker = policy.parseDifficultyMarker("LLM_PROXY_INTERNAL_ROUTING effort=xhigh speed=2 reason=edit_recovery");

  assert.equal(marker.level, 5);
  assert.equal(marker.thinkingLevel, 5);
  assert.equal(marker.costTarget, 5);
  assert.equal(marker.reason, "edit_recovery");
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

test("difficulty marker stripping hides compact slash-level markers", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "LLM_PROXY_TASK_DIFFICULTY level=4/5 reason=major_architecture_pivot\nI will inspect the routing architecture.",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);
  const content = JSON.parse(result.body).choices[0].message.content;

  assert.equal(result.marker.level, 4);
  assert.equal(result.marker.reason, "major_architecture_pivot");
  assert.equal(content, "I will inspect the routing architecture.");
  assert.doesNotMatch(content, /\/5 reason=major_architecture_pivot|LLM_PROXY_TASK_DIFFICULTY/);
});

test("difficulty marker stripping removes orphan slash-level assessment tails", () => {
  const stripped = policy.stripDifficultyMarkerFromText(
    "/5 reason=asset_path_investigation\n\nI'll investigate the static asset handling in this Next.js repo.",
  );

  assert.equal(stripped.marker, null);
  assert.equal(stripped.content, "I'll investigate the static asset handling in this Next.js repo.");
  assert.equal(stripped.changed, true);
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

test("difficulty marker stripping hides bracketed private marker lines", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "[LLM_PROXY_TASK_DIFFICULTY level=4 effort=medium speed=4 reason=coding]",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);
  const parsed = JSON.parse(result.body);

  assert.equal(result.marker.level, 4);
  assert.equal(result.marker.reason, "coding");
  assert.equal(parsed.choices[0].message.content, "");
});

test("difficulty marker stripping consumes standalone legacy bare trailing metadata as route hints", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "I've cleared the TypeScript errors.\n\neffort=medium speed=4 reason=typescript-fixes",
        },
      },
    ],
  });

  const result = policy.stripDifficultyMarkerFromResponseBody(body);
  const parsed = JSON.parse(result.body);

  assert.equal(result.marker.reason, "typescript-fixes");
  assert.equal(result.marker.effort, "medium");
  assert.equal(result.marker.speed, 4);
  assert.equal(result.changed, true);
  assert.equal(parsed.choices[0].message.content, "I've cleared the TypeScript errors.");
});

test("difficulty marker stripping leaves inline bare metadata in prose visible", () => {
  const stripped = policy.stripDifficultyMarkerFromText(
    "Am verificat endpoint-ul local. effort=low speed=3 reason=retry_live_probe",
  );

  assert.equal(stripped.marker, null);
  assert.equal(stripped.content, "Am verificat endpoint-ul local. effort=low speed=3 reason=retry_live_probe");
  assert.equal(stripped.changed, false);
});

test("difficulty marker stripping consumes standalone legacy bare assessment metadata as route hints", () => {
  const markerOnly = policy.stripDifficultyMarkerFromText("effort=low speed=4 reason=playwright_smoke");
  const leading = policy.stripDifficultyMarkerFromText("effort=low speed=4 reason=playwright_smoke\nPlaywright smoke passed.");
  const trailing = policy.stripDifficultyMarkerFromText("Restarted production.\neffort=medium speed=4 reason=prod_restart");
  const marker = policy.parseDifficultyMarker("effort=low speed=4 reason=playwright_smoke");

  assert.equal(marker.reason, "playwright_smoke");
  assert.equal(marker.effort, "low");
  assert.equal(marker.speed, 4);
  assert.equal(markerOnly.marker.reason, "playwright_smoke");
  assert.equal(markerOnly.content, "");
  assert.equal(markerOnly.changed, true);
  assert.equal(leading.content, "Playwright smoke passed.");
  assert.equal(leading.marker.reason, "playwright_smoke");
  assert.equal(trailing.content, "Restarted production.");
  assert.equal(trailing.marker.reason, "prod_restart");
});

test("difficulty marker stripping consumes standalone legacy speed-only assessment metadata as route hints", () => {
  const markerOnly = policy.stripDifficultyMarkerFromText("speed=4 reason=commit_changes");
  const trailing = policy.stripDifficultyMarkerFromText("Restarted production.\nspeed=4 reason=commit_changes");
  const marker = policy.parseDifficultyMarker("speed=4 reason=commit_changes");
  const sentinel = policy.stripDifficultyMarkerFromText("LLM_PROXY_INTERNAL_ROUTING speed=4 reason=commit_changes");
  const sentinelMarker = policy.parseDifficultyMarker("LLM_PROXY_INTERNAL_ROUTING speed=4 reason=commit_changes");

  assert.equal(marker.reason, "commit_changes");
  assert.equal(marker.speed, 4);
  assert.equal(marker.effort, "medium");
  assert.equal(markerOnly.marker.reason, "commit_changes");
  assert.equal(markerOnly.content, "");
  assert.equal(markerOnly.changed, true);
  assert.equal(trailing.marker.reason, "commit_changes");
  assert.equal(trailing.content, "Restarted production.");
  assert.equal(trailing.changed, true);
  assert.equal(sentinelMarker.reason, "commit_changes");
  assert.equal(sentinelMarker.speed, 4);
  assert.equal(sentinelMarker.effort, "medium");
  assert.equal(sentinel.content, "");
  assert.equal(sentinel.changed, true);
});

test("difficulty marker stripping removes orphan reason continuation lines", () => {
  const stripped = policy.stripDifficultyMarkerFromText(
    "LLM_PROXY_INTERNAL_ROUTING effort=high speed=4 reason=review\n-and-broader-verify\n-response\nAm verificat si restul.",
  );
  const quoted = policy.stripDifficultyMarkerFromText(
    "LLM_PROXY_INTERNAL_ROUTING effort=high speed=4 reason=inventory\n_needed\n-current-diff\n\"-current-diff]\nReading changed paths around inventory flow.",
  );

  assert.equal(stripped.marker.reason, "review");
  assert.equal(stripped.content, "Am verificat si restul.");
  assert.equal(stripped.changed, true);
  assert.equal(quoted.marker.reason, "inventory");
  assert.equal(quoted.content, "Reading changed paths around inventory flow.");
  assert.equal(quoted.changed, true);
});

test("effective request profile keeps thinking effort aligned with policy-adjusted level", () => {
  const originalEnv = {
    LLM_COST_TARGET: process.env.LLM_COST_TARGET,
    LLM_SPEED_TARGET: process.env.LLM_SPEED_TARGET,
    LLM_THINKING_TARGET: process.env.LLM_THINKING_TARGET,
    LLM_ROUTING_POLICY: process.env.LLM_ROUTING_POLICY,
  };

  try {
    process.env.LLM_COST_TARGET = "3";
    process.env.LLM_SPEED_TARGET = "4";
    process.env.LLM_THINKING_TARGET = "high";
    process.env.LLM_ROUTING_POLICY = "balanced";

    const profile = policy.effectiveRequestProfile({
      messages: [{ role: "user", content: "review and broader verify" }],
      _llmProxyDifficulty: {
        level: 4,
        label: "complex",
        taskLevel: 4,
        contextLevel: 4,
        taskKind: "edit_recovery",
        stepShape: { shape: "read_heavy", gate: "plan_split" },
        effort: "low",
        thinkingEffort: "low",
        thinkingLevel: 2,
        speedTarget: 4,
        costTarget: 4,
        source: "assessment",
      },
    });

    assert.equal(profile.thinkingLevel, 4);
    assert.equal(profile.thinkingEffort, "high");
    assert.equal(profile.effort, "high");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("providerPolicyBonus favors right-sized models by task complexity", () => {
  const cheap = { name: "Codex-GPT54Mini", family: "codex", model: "codex/gpt-5.4-mini", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const intermediate = { name: "Claude-Sonnet46", family: "claude", model: "claude/claude-sonnet-4-6", caps: ["text", "coding", "tools", "thinking", "max"], tc: true };
  const frontier = { name: "Claude-Opus47", family: "claude", model: "claude/claude-opus-4-7", caps: ["text", "coding", "tools", "thinking", "max"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };

  const trivial = { messages: [{ role: "user", content: "Reply exactly: ok" }], _estimatedTokens: 20 };
  const complex = {
    messages: [{ role: "user", content: "Design and implement a multi-file architecture migration with tests." }],
    tools: [{ type: "function", function: { name: "edit" } }],
    _estimatedTokens: 110000,
  };
  const frontierContext = {
    messages: [{ role: "user", content: "Deep research one million token context pressure architecture migration with tests." }],
    tools: [{ type: "function", function: { name: "edit" } }],
    _inputTokens: 260000,
    _estimatedTokens: 260000,
  };

  assert.equal(policy.providerPolicyBonus(cheap, trivial, { env }) > policy.providerPolicyBonus(frontier, trivial, { env }), true);
  assert.equal(policy.providerPolicyBonus(intermediate, complex, { env }) > policy.providerPolicyBonus(cheap, complex, { env }), true);
  assert.equal(policy.providerPolicyBonus(intermediate, complex, { env }) > policy.providerPolicyBonus(frontier, complex, { env }), true);
  assert.equal(policy.providerPolicyBonus(frontier, frontierContext, { env }) > policy.providerPolicyBonus(intermediate, frontierContext, { env }), true);
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

test("providerPolicyBonus prefers larger low-thinking context for context-only tool pressure", () => {
  const sonnetThinking = {
    name: "Windsurf-ClaudeSonnet46Thinking",
    family: "windsurf",
    model: "windsurf/claude-sonnet-4-6-thinking",
    caps: ["text", "coding", "tools", "thinking"],
    context: 200000,
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "high",
  };
  const codexMiniLow = {
    name: "Windsurf-GPT51CodexMiniLow",
    family: "windsurf",
    model: "windsurf/gpt-5-1-codex-mini-low",
    caps: ["text", "coding", "tools", "thinking"],
    context: 400000,
    cost_group: 2,
    quality_group: 4,
    speed_group: 5,
    thinking_effort: "low",
  };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4", LLM_ROUTING_POLICY: "balanced" };
  const req = {
    messages: [
      { role: "system", content: "You are Claude Code running as a software engineering agent." },
      { role: "user", content: "Continue implementing the routing patch with tests." },
    ],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _inputTokens: 170000,
    _estimatedTokens: 186000,
  };

  assert.equal(policy.effectiveRequestProfile(req, env).taskLevel, 3);
  assert.equal(policy.effectiveRequestProfile(req, env).contextLevel, 5);
  assert.equal(
    policy.providerPolicyBonus(codexMiniLow, req, { env }) > policy.providerPolicyBonus(sonnetThinking, req, { env }),
    true,
  );
});

test("providerPolicyBonus applies thinking latency guard to deterministic security patches", () => {
  const nonThinkingSonnet = {
    name: "Windsurf-ClaudeSonnet46",
    family: "windsurf",
    model: "windsurf/claude-sonnet-4-6",
    caps: ["text", "coding", "tools", "thinking"],
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "medium",
  };
  const thinkingSonnet = {
    name: "Windsurf-ClaudeSonnet46Thinking",
    family: "windsurf",
    model: "windsurf/claude-sonnet-4-6-thinking",
    caps: ["text", "coding", "tools", "thinking"],
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "high",
  };
  const patchReq = {
    max_tokens: 340,
    messages: [{
      role: "user",
      content: "Fix this Node.js webhook verifier. Current code accepts replayed tokens and leaks timing info. Required: constant-time semantics, malformed hex handling, and three regression tests.",
    }],
    _estimatedTokens: 6000,
  };
  const threatModelReq = {
    max_tokens: 900,
    messages: [{ role: "user", content: "Threat model an ambiguous auth architecture for privilege bypass and exploit chains before release." }],
    _estimatedTokens: 12000,
  };

  assert.equal(policy.providerPolicyBonus(nonThinkingSonnet, patchReq) > policy.providerPolicyBonus(thinkingSonnet, patchReq), true);
  assert.equal(policy.providerPolicyBonus(thinkingSonnet, threatModelReq) > policy.providerPolicyBonus(nonThinkingSonnet, threatModelReq), true);
});

test("providerPolicyBonus applies thinking latency guard to small non-risk patch continuations", () => {
  const nonThinkingSonnet = {
    name: "Windsurf-ClaudeSonnet46",
    family: "windsurf",
    model: "windsurf/claude-sonnet-4.6",
    caps: ["text", "coding", "tools", "thinking"],
    context: 200000,
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "medium",
  };
  const thinkingSonnet = {
    ...nonThinkingSonnet,
    name: "Windsurf-ClaudeSonnet46Thinking",
    model: "windsurf/claude-sonnet-4-6-thinking",
    thinking_effort: "high",
  };
  const req = {
    max_tokens: 256,
    tools: [{ type: "function", function: { name: "Edit" } }],
    messages: [{ role: "user", content: "Continue the small routing patch and update the focused regression test." }],
    _inputTokens: 20000,
    _estimatedTokens: 20256,
    _llmProxyDifficulty: {
      level: 3,
      taskKind: "agentic_coding",
      taskLevel: 3,
      contextLevel: 3,
      costTarget: 3,
      speedTarget: 4,
      thinkingLevel: 3,
      stepShape: { shape: "write_heavy", posture: "type_cheap", gate: "run_behavior" },
    },
  };

  assert.equal(
    policy.providerPolicyBonus(nonThinkingSonnet, req) - policy.providerPolicyBonus(thinkingSonnet, req) > 0.25,
    true,
  );
});

test("providerPolicyBonus prefers adequate context over one-million frontier for write-heavy coding", () => {
  const adequate = {
    name: "Windsurf-ClaudeSonnet46Thinking",
    family: "windsurf",
    model: "windsurf/claude-sonnet-4-6-thinking",
    caps: ["text", "coding", "tools", "thinking"],
    context: 400000,
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "high",
  };
  const millionOpus = {
    name: "Windsurf-ClaudeOpus461M",
    family: "windsurf",
    model: "windsurf/claude-opus-4-6-1m",
    caps: ["text", "coding", "tools", "thinking", "max"],
    context: 1000000,
    cost_group: 4,
    quality_group: 5,
    speed_group: 3,
    thinking_effort: "xhigh",
  };
  const gpt55 = {
    name: "Codex-GPT55",
    family: "codex",
    model: "codex/gpt-5.5",
    caps: ["text", "coding", "tools", "thinking"],
    context: 272000,
    cost_group: 4,
    quality_group: 5,
    speed_group: 4,
    thinking_effort: "xhigh",
  };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4", LLM_ROUTING_POLICY: "balanced" };
  const req = {
    messages: [{ role: "user", content: "Implement the provider discovery fix, update tests, and run Docker validation." }],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _inputTokens: 197000,
    _estimatedTokens: 229000,
  };

  assert.equal(policy.providerPolicyBonus(adequate, req, { env }) > policy.providerPolicyBonus(millionOpus, req, { env }), true);
  assert.equal(policy.providerPolicyBonus(adequate, req, { env }) > policy.providerPolicyBonus(gpt55, req, { env }), true);
});

test("providerPolicyBonus treats SWE as task-list and summary specialist, not default coding choice", () => {
  const swe = { name: "Windsurf-SWE16Fast", family: "windsurf", model: "windsurf/swe-1.6-fast", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const codex = { name: "Codex-GPT54", family: "codex", model: "codex/gpt-5.4", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };

  const summaryReq = {
    messages: [{ role: "user", content: "Make a list of remaining tasks and summarize status." }],
    _estimatedTokens: 2000,
  };
  const benchmarkSummaryReq = {
    messages: [
      { role: "system", content: "Return five concise bullets. Each bullet must start with a subsystem name." },
      { role: "user", content: "Make a list of remaining handoff notes and summarize status: API validation finished, deployment checklist prepared, cache cleanup pending, local health passed, remote health passed, documentation update pending. Do not call tools or write function-call syntax." },
    ],
    _estimatedTokens: 264,
  };
  const codingReq = {
    messages: [{ role: "user", content: "Implement the code changes, edit files, and run tests." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 9000,
  };

  assert.equal(policy.assessRequestDifficulty(summaryReq.messages, summaryReq).taskKind, "list_summary");
  assert.equal(policy.assessRequestDifficulty(benchmarkSummaryReq.messages, benchmarkSummaryReq).taskKind, "list_summary");
  assert.equal(policy.providerPolicyBonus(swe, summaryReq, { env }) > policy.providerPolicyBonus(codex, summaryReq, { env }), true);
  assert.equal(policy.providerPolicyBonus(codex, codingReq, { env }) > policy.providerPolicyBonus(swe, codingReq, { env }), true);
});

test("providerPolicyBonus treats SWE as the preferred exact-answer benchmark rung", () => {
  const swe = { name: "Windsurf-SWE16Fast", family: "windsurf", model: "windsurf/swe-1.6-fast", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const haiku = { name: "Claude-Haiku45", family: "claude", model: "claude/claude-haiku-4-5", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [{ role: "user", content: "Reply exactly: ok" }],
    _estimatedTokens: 40,
  };

  assert.equal(policy.assessRequestDifficulty(req.messages, req).taskKind, "direct_answer");
  assert.equal(policy.providerPolicyBonus(swe, req, { env }) > policy.providerPolicyBonus(haiku, req, { env }), true);
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

test("providerPolicyBonus keeps Codex auto-review out of normal coding and generic verification", () => {
  const review = { name: "Codex-AutoReview", family: "codex", model: "codex/codex-auto-review", visibility: "hide", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const codex = { name: "Codex-GPT54", family: "codex", model: "codex/gpt-5.4", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const codingReq = {
    messages: [{ role: "user", content: "Implement the routing policy change and run the unit tests." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 9000,
  };
  const verifyReq = {
    messages: [{ role: "user", content: "Verify whether the proxy health endpoint responds correctly." }],
    tools: [{ type: "function", function: { name: "Bash" } }],
    _estimatedTokens: 3000,
  };

  assert.equal(policy.assessRequestDifficulty(codingReq.messages, codingReq).taskKind, "agentic_coding");
  assert.equal(policy.assessRequestDifficulty(verifyReq.messages, verifyReq).taskKind, "verification");
  assert.equal(policy.providerPolicyBonus(codex, codingReq, { env }) > policy.providerPolicyBonus(review, codingReq, { env }), true);
  assert.equal(policy.providerPolicyBonus(codex, verifyReq, { env }) > policy.providerPolicyBonus(review, verifyReq, { env }), true);
});

test("providerPolicyBonus avoids private Windsurf aliases without tool contracts for tool-heavy coding", () => {
  const privateAlias = {
    name: "Windsurf-Private19",
    family: "windsurf",
    model: "windsurf/private-19",
    upstream_model: "private-19",
    caps: ["text", "images", "max"],
    context: 400000,
    cost_group: 2,
    quality_group: 4,
    speed_group: 5,
    thinking_effort: "low",
  };
  const publicMini = {
    name: "Windsurf-GPT54MiniLowThinking",
    family: "windsurf",
    model: "windsurf/gpt-5-4-mini-low",
    caps: ["text", "coding", "tools", "thinking"],
    context: 400000,
    cost_group: 2,
    quality_group: 3,
    speed_group: 5,
    thinking_effort: "low",
  };
  const req = {
    messages: [{ role: "user", content: "Inspect the repository, edit two files, and run tests." }],
    tools: [{ type: "function", function: { name: "Read" } }, { type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 14000,
  };

  assert.equal(policy.isInternalPrivateProvider(privateAlias), true);
  assert.equal(policy.providerHasToolCodingContract(privateAlias), false);
  assert.equal(policy.providerHasToolCodingContract(publicMini), true);
  assert.equal(policy.providerPolicyBonus(publicMini, req) > policy.providerPolicyBonus(privateAlias, req), true);
});

test("providerPolicyBonus treats Gemini Flash as long-context text, not tool-heavy coding", () => {
  const flash = { name: "Windsurf-Gemini3FlashLow", family: "windsurf", model: "windsurf/google-gemini-3-0-flash-low", caps: ["text", "coding", "tools", "thinking", "max"], context: 1048576, cost_group: 1, quality_group: 4, speed_group: 5, thinking_effort: "low" };
  const codex = { name: "Codex-GPT54", family: "codex", model: "codex/gpt-5.4", caps: ["text", "coding", "tools", "thinking"], context: 200000, cost_group: 3, quality_group: 5, speed_group: 3, thinking_effort: "medium" };
  const summaryReq = {
    messages: [{ role: "user", content: "Summarize this long architecture handoff into a status report." }],
    _inputTokens: 170000,
    _estimatedTokens: 171000,
  };
  const codingReq = {
    messages: [{ role: "user", content: "Refactor the proxy routing implementation and run tests." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _inputTokens: 60000,
    _estimatedTokens: 92000,
  };

  assert.equal(policy.providerPolicyBonus(flash, summaryReq) > policy.providerPolicyBonus(codex, summaryReq), true);
  assert.equal(policy.providerPolicyBonus(codex, codingReq) > policy.providerPolicyBonus(flash, codingReq), true);
});

test("profileFromAssessmentMarker preserves task kind and maps AI reason to route policy", () => {
  const req = {
    messages: [{ role: "user", content: "Implement a multi-file routing refactor and verify it." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 24000,
  };
  const marker = policy.parseDifficultyMarker("LLM_PROXY_TASK_DIFFICULTY level=5 effort=xhigh speed=2 reason=edit_recovery");
  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(profile.taskKind, "edit_recovery");
  assert.equal(profile.taskLevel, 5);
  assert.equal(profile.thinkingEffort, "xhigh");
  assert.equal(profile.costTarget, 5);
});

test("assessment marker generic routing implementation reason stays coding, not architecture recovery", () => {
  const req = {
    messages: [{ role: "user", content: "Implement the routing detector fix and run tests." }],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _estimatedTokens: 12000,
  };
  const marker = policy.parseDifficultyMarker("LLM_PROXY_TASK_DIFFICULTY level=3 effort=medium speed=4 reason=routing_implementation");
  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(profile.taskKind, "agentic_coding");
  assert.equal(profile.costTarget <= 3, true);
});

test("generic none assessment marker cannot escalate debugging above deterministic profile", () => {
  const req = {
    messages: [{ role: "user", content: "monitorizeaza logs si fixeaza daca gasesti ceva off" }],
    tools: [{ type: "function", function: { name: "Bash" } }],
    _inputTokens: 120000,
    _estimatedTokens: 152000,
  };
  const base = policy.assessRequestDifficulty(req.messages, req);
  const marker = policy.parseDifficultyMarker("LLM_PROXY_TASK_DIFFICULTY level=5 effort=xhigh speed=2 reason=none");
  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(base.taskKind, "debugging");
  assert.equal(base.level, 4);
  assert.equal(profile.reason, "");
  assert.equal(profile.taskKind, "debugging");
  assert.equal(profile.level, base.level);
  assert.equal(profile.thinkingLevel, base.thinkingLevel);
  assert.equal(profile.speedTarget, base.speedTarget);
  assert.equal(profile.costTarget, base.costTarget);
});

test("generic followup assessment marker can lower thinking without changing task", () => {
  const req = {
    messages: [{ role: "user", content: "monitorizeaza logs si fixeaza daca gasesti ceva off" }],
    tools: [{ type: "function", function: { name: "Bash" } }],
    _inputTokens: 120000,
    _estimatedTokens: 152000,
  };
  const base = policy.assessRequestDifficulty(req.messages, req);
  const marker = policy.parseDifficultyMarker("LLM_PROXY_INTERNAL_ROUTING effort=low speed=3 reason=followup");
  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(base.taskKind, "debugging");
  assert.equal(profile.taskKind, base.taskKind);
  assert.equal(profile.level, base.level);
  assert.equal(profile.thinkingEffort, "low");
  assert.equal(profile.thinkingLevel, 2);
  assert.equal(profile.speedTarget, 3);
  assert.equal(profile.costTarget, base.costTarget);
});

test("retry live probe assessment marker stays private and keeps deterministic task", () => {
  const req = {
    messages: [{ role: "user", content: "debug this local docker request issue and inspect logs" }],
    tools: [{ type: "function", function: { name: "Bash" } }],
    _estimatedTokens: 120000,
  };
  const base = policy.assessRequestDifficulty(req.messages, req);
  const marker = policy.parseDifficultyMarker("LLM_PROXY_INTERNAL_ROUTING effort=low speed=3 reason=retry_live_probe");
  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(marker.reason, "retry_live_probe");
  assert.equal(base.taskKind, "debugging");
  assert.equal(profile.taskKind, base.taskKind);
  assert.equal(profile.level, base.level);
  assert.equal(profile.thinkingEffort, "low");
  assert.equal(profile.speedTarget, 3);
});

test("trusted AI assessment without reason cannot escalate debugging above deterministic profile", () => {
  const req = {
    messages: [{ role: "user", content: "monitorizeaza logs si fixeaza daca gasesti ceva off" }],
    tools: [{ type: "function", function: { name: "Bash" } }],
    _inputTokens: 120000,
    _estimatedTokens: 152000,
  };
  const base = policy.assessRequestDifficulty(req.messages, req);
  const profile = policy.profileFromTrustedTaskAssessment(req, {
    level: 5,
    effort: "xhigh",
    speed: 2,
  });

  assert.equal(base.taskKind, "debugging");
  assert.equal(base.level, 4);
  assert.equal(profile.reason || "", "");
  assert.equal(profile.taskKind, "debugging");
  assert.equal(profile.level, base.level);
  assert.equal(profile.thinkingLevel, base.thinkingLevel);
  assert.equal(profile.speedTarget, base.speedTarget);
  assert.equal(profile.costTarget, base.costTarget);
});

test("stale architecture context does not make Opus preferred for a normal implementation step", () => {
  const codex = { name: "Codex-GPT54", family: "codex", model: "codex/gpt-5.4", caps: ["text", "coding", "tools", "thinking"], tc: true };
  const opus = { name: "Claude-Opus47", family: "claude", model: "claude/claude-opus-4-7", caps: ["text", "coding", "tools", "thinking", "max"], tc: true };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4", LLM_ROUTING_POLICY: "balanced" };
  const req = {
    messages: [
      { role: "user", content: "Deep research production proxy incident: architecture recovery, routing class, long-context pressure, provider health, benchmark fairness." },
      { role: "assistant", content: "Architecture recovery summary retained." },
      { role: "user", content: "Implement the provider configuration cleanup, edit files, and run tests." },
    ],
    tools: [{ type: "function", function: { name: "Edit" } }],
    _inputTokens: 24000,
    _estimatedTokens: 26000,
  };

  assert.equal(policy.assessRequestDifficulty(req.messages, req).taskKind, "agentic_coding");
  assert.equal(policy.providerPolicyBonus(codex, req, { env }) > policy.providerPolicyBonus(opus, req, { env }), true);
});

test("assessRequestDifficulty does not treat unrelated changes as completed-work review", () => {
  const req = {
    messages: [
      { role: "system", content: "Return five ordered steps. Each step must include evidence, action, and stop condition." },
      { role: "user", content: "A terminal coding agent is midway through a repository migration. Signals: tests were green before a Docker rebuild, one generated file is dirty, a benchmark process was interrupted, and the next run must not hide regressions. Design a recovery workflow that mirrors terminal-agent benchmarks: inspect state, isolate unrelated changes, resume safely, verify, and report." },
    ],
    _estimatedTokens: 435,
  };

  assert.notEqual(policy.assessRequestDifficulty(req.messages, req).taskKind, "completion_review");
});

test("assessRequestDifficulty treats benchmark evidence in recovery workflows as planning context", () => {
  const req = {
    messages: [
      { role: "system", content: "Return five ordered steps. Each step must include evidence, action, and stop condition." },
      { role: "user", content: "A terminal coding agent is midway through a repository migration. Signals: tests were green before a Docker rebuild, one generated file is dirty, a benchmark process was interrupted, and the next run must not hide regressions. Design a recovery workflow that mirrors terminal-agent benchmarks: inspect state, isolate unrelated changes, resume safely, verify, and report." },
    ],
    _estimatedTokens: 435,
  };
  const assessment = policy.assessRequestDifficulty(req.messages, req);

  assert.notEqual(assessment.taskKind, "benchmarking");
  assert.equal(assessment.stepShape.shape, "read_heavy");
});

test("assessRequestDifficulty does not classify deploy identifiers inside code snippets as deployment ops", () => {
  const req = {
    messages: [
      { role: "system", content: "Return minified JSON only with keys output, invariant, bug, fix." },
      { role: "user", content: "Analyze this scheduler without running it:\nfunction schedule(jobs) {\n  const seen = new Set();\n  const out = [];\n  for (const job of jobs) {\n    if (seen.has(job.id)) continue;\n    seen.add(job.id);\n    if (job.dep && !seen.has(job.dep)) out.push(`wait:${job.id}`);\n    out.push(job.id);\n  }\n  return out;\n}\nInput: [{id:'build'},{id:'test',dep:'build'},{id:'deploy',dep:'package'},{id:'test'}]\nWhat is the exact output, what invariant is violated, and what minimal fix avoids scheduling deploy before package?" },
    ],
  };
  const assessment = policy.assessRequestDifficulty(req.messages, req);

  assert.notEqual(assessment.taskKind, "deployment_ops");
  assert.equal(assessment.stepShape.shape, "read_heavy");
});

test("assessRequestDifficulty treats narrow corrected-function bugfixes as write-heavy work", () => {
  const req = {
    messages: [
      { role: "system", content: "Return only the corrected JavaScript function and one short note." },
      { role: "user", content: "Fix the leak and cancellation bug:\nasync function fetchWithTimeout(url, ms) {\n  const controller = new AbortController();\n  const timeout = setTimeout(() => controller.abort(), ms);\n  const res = await fetch(url, { signal: controller.signal });\n  return res.json();\n}" },
    ],
  };
  const assessment = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(assessment.stepShape.shape, "write_heavy");
});

test("detectTaskKind does not treat routing log review as code review without diff evidence", () => {
  const req = {
    messages: [{ role: "user", content: "Review the last regression in routing logs and tell me likely root cause." }],
  };

  assert.equal(policy.assessRequestDifficulty(req.messages, req).taskKind, "debugging");
});

test("read-only audits with regression-test suggestions stay review-oriented", () => {
  const req = {
    messages: [{
      role: "user",
      content: "Read-only audit of lib/routing-policy.js, lib/routing.js, and lib/scoring.js. Look for cached token logging issues and include suggested regression tests. Do not edit files.",
    }],
  };
  const assessment = policy.assessRequestDifficulty(req.messages, req);

  assert.notEqual(assessment.taskKind, "test_generation");
  assert.equal(["verification", "code_review", "data_analysis"].includes(assessment.taskKind), true);
  assert.notEqual(assessment.stepShape.shape, "security");
});

test("profileFromAssessmentMarker keeps cost aligned with inherited complex task level", () => {
  const req = {
    messages: [
      { role: "system", content: "Return five ordered steps. Each step must include evidence, action, and stop condition." },
      { role: "user", content: "A terminal coding agent is midway through a repository migration. Design a recovery workflow that mirrors terminal-agent benchmarks: inspect state, isolate unrelated changes, resume safely, verify, and report." },
    ],
    _estimatedTokens: 435,
  };
  const marker = policy.parseDifficultyMarker("LLM_PROXY_TASK_DIFFICULTY level=2 effort=low speed=4 reason=recovery_workflow_design");
  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(profile.level >= 4, true);
  assert.equal(profile.costTarget >= 4, true);
  assert.notEqual(profile.taskKind, "completion_review");
});

test("providerPolicyBonus promotes one-million-token Opus-class context for deep context asks", () => {
  const opus1m = { name: "Windsurf-ClaudeOpus461M", family: "windsurf", model: "windsurf/claude-opus-4-6-1m", caps: ["text", "coding", "tools", "thinking", "max"], context: 1000000, cost_group: 4, quality_group: 5, speed_group: 3, thinking_effort: "xhigh" };
  const opusStandard = { name: "Windsurf-ClaudeOpus46", family: "windsurf", model: "windsurf/claude-opus-4.6", caps: ["text", "coding", "tools", "thinking", "max"], context: 200000, cost_group: 4, quality_group: 5, speed_group: 3, thinking_effort: "xhigh" };
  const gpt55 = { name: "Codex-GPT55", family: "codex", model: "codex/gpt-5.5", caps: ["text", "coding", "tools", "thinking", "max"], context: 272000, cost_group: 4, quality_group: 5, speed_group: 4, thinking_effort: "xhigh" };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [{ role: "user", content: "Deep research production incident involving one million token context, streaming, tools, rate limits, and architecture risk." }],
    _estimatedTokens: 1000,
  };

  assert.equal(policy.assessRequestDifficulty(req.messages, req).contextLevel, 5);
  assert.equal(policy.providerPolicyBonus(opus1m, req, { env }) > policy.providerPolicyBonus(opusStandard, req, { env }), true);
  assert.equal(policy.providerPolicyBonus(opus1m, req, { env }) > policy.providerPolicyBonus(gpt55, req, { env }), true);
});

test("failed edit recovery escalates to Opus-class routing instead of cheap large-context flash", () => {
  const opus1m = { name: "Windsurf-ClaudeOpus461M", family: "windsurf", model: "windsurf/claude-opus-4-6-1m", caps: ["text", "coding", "tools", "thinking", "max"], context: 1000000, cost_group: 4, quality_group: 5, speed_group: 3, thinking_effort: "xhigh" };
  const flash = { name: "Windsurf-Gemini3FlashLow", family: "windsurf", model: "windsurf/google-gemini-3-0-flash-low", caps: ["text", "coding", "tools", "thinking", "max"], context: 1048576, cost_group: 1, quality_group: 4, speed_group: 5, thinking_effort: "low" };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [
      { role: "system", content: "You are Claude Code running as a software engineering agent." },
      { role: "assistant", content: "Read run_cmd.py (lines 353-382)" },
      { role: "tool", content: "return { command: \"run\", dry_run: args.dry_run }" },
      { role: "assistant", content: "Edit run_cmd.py\nEdit failed: expected text was not found. Shimming and retrying after a stale read." },
      { role: "user", content: "<system-reminder> Continue implementing the precise patch without breaking the file.</system-reminder>" },
    ],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _inputTokens: 225000,
    _estimatedTokens: 257000,
  };

  const assessment = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(assessment.taskKind, "edit_recovery");
  assert.equal(assessment.taskLevel, 4);
  assert.equal(assessment.contextLevel, 5);
  assert.equal(assessment.thinkingEffort, "xhigh");
  assert.equal(policy.providerPolicyBonus(opus1m, req, { env }) > policy.providerPolicyBonus(flash, req, { env }), true);
});

test("architecture recovery escalates to Opus-class routing instead of cheap large-context flash", () => {
  const opus1m = { name: "Windsurf-ClaudeOpus461M", family: "windsurf", model: "windsurf/claude-opus-4-6-1m", caps: ["text", "coding", "tools", "thinking", "max"], context: 1000000, cost_group: 4, quality_group: 5, speed_group: 3, thinking_effort: "xhigh" };
  const flash = { name: "Windsurf-Gemini3FlashLow", family: "windsurf", model: "windsurf/google-gemini-3-0-flash-low", caps: ["text", "coding", "tools", "thinking", "max"], context: 1048576, cost_group: 1, quality_group: 4, speed_group: 5, thinking_effort: "low" };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [
      { role: "system", content: "You are evaluating a production LLM proxy incident." },
      { role: "assistant", content: "Provider evidence: tool-call translation risk, rate-limit noise, long-context pressure, and benchmark fairness concerns." },
      { role: "user", content: "Deep research hard bug in a one-million-token production proxy incident: choose the safest routing class for architecture recovery across Claude Code tools, Windsurf compatibility, Opus context, cost efficiency, regression verification, and benchmark fairness." },
    ],
    _inputTokens: 180000,
    _estimatedTokens: 181000,
  };

  const assessment = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(assessment.taskKind, "architecture_recovery");
  assert.equal(assessment.taskLevel, 5);
  assert.equal(assessment.contextLevel, 5);
  assert.equal(assessment.thinkingEffort, "xhigh");
  assert.equal(policy.providerPolicyBonus(opus1m, req, { env }) > policy.providerPolicyBonus(flash, req, { env }), true);
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

test("assessment marker cannot escalate simple deterministic tasks by itself", () => {
  const provider = {
    name: "Cheap-Direct",
    model: "windsurf/swe-1.6-fast",
    family: "windsurf",
    cost_group: 1,
    speed_group: 5,
    thinking_effort: "low",
  };
  const marker = {
    level: 5,
    costTarget: 5,
    thinkingLevel: 5,
    speedTarget: 1,
    effort: "xhigh",
  };
  const req = {
    messages: [{ role: "user", content: "Reply exactly: ok" }],
  };

  assert.equal(policy.shouldRerouteForMarker(provider, marker, req), false);
});

test("old completion summaries do not turn later routing log debugging into completion review", () => {
  const req = {
    tools: [{ name: "Read" }],
    messages: [
      { role: "assistant", content: "Changes: routing tests passed and providers were updated." },
      { role: "user", content: "Review routing logs and identify root cause for why provider matching still picks expensive models." },
    ],
  };

  const profile = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(profile.taskKind, "debugging");
  assert.notEqual(profile.taskKind, "completion_review");
});

test("Romanian why questions stay explanation even when IDE tools are present", () => {
  const req = {
    tools: Array.from({ length: 8 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [
      { role: "system", content: "You are a software engineering agent with codebase tools." },
      { role: "assistant", content: "Am actualizat docker compose si memory routing." },
      { role: "user", content: "pt ce are nevoie de OPENAI_API_KEY?" },
    ],
    _inputTokens: 11019,
    _estimatedTokens: 27403,
  };

  const profile = policy.assessRequestDifficulty(req.messages, req);
  const effective = policy.effectiveRequestProfile(req, {
    LLM_COST_TARGET: "3",
    LLM_THINKING_TARGET: "medium",
    LLM_SPEED_TARGET: "4",
    LLM_ROUTING_POLICY: "balanced",
  });

  assert.equal(profile.taskKind, "explanation");
  assert.equal(profile.stepShape.gate, "none");
  assert.equal(profile.taskLevel <= 2, true);
  assert.equal(effective.costTarget <= 2, true);
  assert.equal(effective.thinkingLevel <= 2, true);
});

test("routing log diagnostics that mention security mode stay debugging and avoid Opus fallback", () => {
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4", LLM_ROUTING_POLICY: "balanced" };
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [{
      role: "user",
      content: [
        "Routing keeps sending simple tasks to Opus for the wrong reason, fix it:",
        "llm-proxy | ROUTING-PROFILE: auto-coding level=4/complex source=heuristic task=security_review shape=security gate=human_signoff cost=4 thinking=4/high speed=3 input=114397tok estimated=146397tok tools=75",
        "llm-proxy | REROUTE: Windsurf-ClaudeSonnet46Thinking timeout/502 -> trying next provider",
        "llm-proxy | Route: auto-coding -> Windsurf-ClaudeOpus46 (windsurf/claude-opus-4.6) via=Windsurf ctx=200000",
      ].join("\n"),
    }],
    _inputTokens: 120000,
    _estimatedTokens: 152000,
  };
  const sonnet = {
    name: "Windsurf-ClaudeSonnet46",
    family: "windsurf",
    model: "windsurf/claude-sonnet-4.6",
    caps: ["text", "coding", "tools", "thinking", "max"],
    context: 200000,
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "medium",
  };
  const opus = {
    name: "Windsurf-ClaudeOpus46",
    family: "windsurf",
    model: "windsurf/claude-opus-4.6",
    caps: ["text", "coding", "tools", "thinking", "max"],
    context: 200000,
    cost_group: 4,
    quality_group: 5,
    speed_group: 3,
    thinking_effort: "xhigh",
  };

  const profile = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(profile.taskKind, "debugging");
  assert.notEqual(profile.stepShape.shape, "security");
  assert.equal(policy.providerPolicyBonus(sonnet, req, { env }) > policy.providerPolicyBonus(opus, req, { env }), true);
});

test("cached tool output cannot turn the current local deploy task into a security gate", () => {
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [
      { role: "user", content: "redeploy local docker" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_logs",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: "docker compose logs llm-proxy" }) },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_logs",
        content: "llm-proxy-1 | [2026-05-21T13:48:13.005Z] ASSESS: Windsurf-ClaudeSonnet46Thinking level=4 effort=high speed=3 reason=security_review source=heuristic task=security_review shape=security gate=human_signoff cost=4 thinking=4",
      },
    ],
    _inputTokens: 125888,
    _estimatedTokens: 157888,
  };

  const profile = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(profile.taskKind, "deployment_ops");
  assert.notEqual(profile.stepShape.shape, "security");
});

test("single ASSESS routing log complaints stay debugging, not security review", () => {
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [{
      role: "user",
      content: "same issue: 5-21T13:48:13.005Z] ASSESS: Windsurf-ClaudeSonnet46Thinking level=4 effort=high speed=3 reason=security_review source=heuristic task=security_review shape=security gate=human_signoff cost=4 thinking=4",
    }],
    _inputTokens: 125888,
    _estimatedTokens: 157888,
  };

  const profile = policy.assessRequestDifficulty(req.messages, req);

  assert.equal(profile.taskKind, "debugging");
  assert.notEqual(profile.stepShape.shape, "security");
});

test("assessment marker cannot convert normal Copilot implementation into security review", () => {
  const req = {
    tools: [{ name: "Edit" }],
    messages: [
      { role: "user", content: "Implement Copilot auth and provider matching, edit code, run tests, and deploy locally with Docker." },
    ],
  };
  const provider = {
    name: "Windsurf-GPT54Mini",
    model: "windsurf/gpt-5.4-mini",
    family: "windsurf",
    cost_group: 2,
    speed_group: 5,
    thinking_effort: "medium",
  };
  const marker = {
    level: 4,
    effort: "high",
    speed: 3,
    reason: "security_review",
  };

  const markerProfile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(policy.assessRequestDifficulty(req.messages, req).taskKind, "agentic_coding");
  assert.equal(markerProfile.taskKind, "agentic_coding");
  assert.equal(markerProfile.costTarget <= 3, true);
  assert.equal(policy.shouldRerouteForMarker(provider, marker, req), false);
});

test("trusted AI task assessment overrides stale security routing log text", () => {
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [{
      role: "user",
      content: "vezi ca tot pe security review intra, e gresit: reason=security_review source=heuristic task=security_review shape=security gate=human_signoff cost=4 thinking=4\ncum se face clasificarea? hai sa vedem putin logica",
    }],
    _inputTokens: 132373,
    _estimatedTokens: 164373,
  };

  const profile = policy.profileFromTrustedTaskAssessment(req, {
    level: 3,
    effort: "medium",
    speed: 4,
    reason: "routing_debugging",
  });

  assert.equal(profile.source, "assessment");
  assert.equal(profile.taskKind, "debugging");
  assert.notEqual(profile.stepShape.shape, "security");
  assert.equal(profile.costTarget <= 3, true);
  assert.equal(profile.speedTarget >= 4, true);
});

test("trusted AI task assessment cannot create security signoff without deterministic security intent", () => {
  const req = {
    tools: [{ type: "function", function: { name: "Read" } }],
    messages: [
      {
        role: "user",
        content: "Deep dive into the chaos_engineering codebase first. Read files and report architecture, tools, docker, kubernetes, ansible, SSH, and chaos-mesh integrations.",
      },
    ],
    _inputTokens: 12000,
    _estimatedTokens: 18000,
  };

  const profile = policy.profileFromTrustedTaskAssessment(req, {
    level: 4,
    effort: "high",
    speed: 3,
    reason: "security_review",
  });

  assert.equal(profile.source, "assessment");
  assert.notEqual(profile.taskKind, "security_review");
  assert.notEqual(profile.stepShape.gate, "human_signoff");
});

test("post-route assessment marker does not inherit stale security gate", () => {
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [{
      role: "user",
      content: "vezi ca tot pe security review intra, e gresit: reason=security_review source=heuristic task=security_review shape=security gate=human_signoff cost=4 thinking=4\ncum se face clasificarea? raspunde scurt",
    }],
    _inputTokens: 1867,
    _estimatedTokens: 1883,
  };
  const marker = policy.parseDifficultyMarker("LLM_PROXY_TASK_DIFFICULTY level=4 effort=minimal speed=5 reason=classification_explanation");
  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(profile.source, "assessment");
  assert.equal(profile.taskKind, "explanation");
  assert.notEqual(profile.stepShape.shape, "security");
  assert.equal(profile.stepShape.gate, "none");
  assert.equal(profile.costTarget <= 2, true);
  assert.equal(profile.speedTarget, 5);
});

test("trusted AI task assessment maps canonical deployment reason before stale fallback", () => {
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [{
      role: "user",
      content: "redeploy pe local docker\nreason=security_review source=heuristic task=security_review shape=security gate=human_signoff cost=4 thinking=4",
    }],
    _inputTokens: 132373,
    _estimatedTokens: 164373,
  };

  const profile = policy.profileFromTrustedTaskAssessment(req, {
    level: 3,
    effort: "medium",
    speed: 4,
    reason: "deployment_ops",
  });

  assert.equal(profile.source, "assessment");
  assert.equal(profile.taskKind, "deployment_ops");
  assert.notEqual(profile.stepShape.shape, "security");
  assert.equal(profile.costTarget <= 3, true);
});

test("trusted AI assessment keeps heuristic task level when only context is large", () => {
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [{ role: "user", content: "continua" }],
    _inputTokens: 161000,
    _estimatedTokens: 173000,
  };

  const profile = policy.profileFromTrustedTaskAssessment(req, {
    level: 5,
    effort: "high",
    speed: 2,
    reason: "agentic_coding",
  });

  assert.equal(policy.assessRequestDifficulty(req.messages, req).taskLevel, 3);
  assert.equal(profile.taskKind, "agentic_coding");
  assert.equal(profile.taskLevel, 3);
  assert.equal(profile.contextLevel, 5);
  assert.equal(profile.level, 5);

  const effective = policy.effectiveRequestProfile({
    ...req,
    _llmProxyDifficulty: profile,
  }, { LLM_ROUTING_POLICY: "balanced", LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" });
  assert.equal(effective.qualityTarget, 3);
  assert.equal(effective.costTarget, 3);
  assert.equal(effective.thinkingLevel, 3);
  assert.equal(effective.speedTarget, 4);
});

test("post-route marker keeps heuristic task level when only context is large", () => {
  const req = {
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    messages: [{ role: "user", content: "continua" }],
    _inputTokens: 161000,
    _estimatedTokens: 173000,
  };
  const marker = policy.parseDifficultyMarker("LLM_PROXY_TASK_DIFFICULTY level=5 effort=high speed=2 reason=agentic_coding");

  const profile = policy.profileFromAssessmentMarker(req, marker);

  assert.equal(profile.taskKind, "agentic_coding");
  assert.equal(profile.taskLevel, 3);
  assert.equal(profile.contextLevel, 5);
  assert.equal(profile.level, 5);
});

test("balanced policy preserves security and destructive routing floors", () => {
  const env = { LLM_ROUTING_POLICY: "balanced", LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "5" };
  const security = policy.effectiveRequestProfile({
    messages: [{ role: "user", content: "Review this auth and permission code for privilege bypass before release." }],
  }, env);
  const destructive = policy.effectiveRequestProfile({
    messages: [{ role: "user", content: "Plan a database migration that deletes old rows; dry-run first and rollback required." }],
  }, env);

  assert.equal(security.costTarget >= 4, true);
  assert.equal(security.thinkingLevel >= 4, true);
  assert.equal(security.speedTarget <= 3, true);
  assert.equal(destructive.costTarget >= 4, true);
  assert.equal(destructive.thinkingLevel >= 4, true);
  assert.equal(destructive.speedTarget <= 3, true);
});

test("context-only write-heavy continuations keep task quality target standard", () => {
  const env = { LLM_ROUTING_POLICY: "balanced", LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [{ role: "user", content: "continua" }],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _inputTokens: 141000,
    _estimatedTokens: 173000,
    _llmProxyDifficulty: {
      level: 5,
      label: "deep",
      taskKind: "agentic_coding",
      taskLevel: 3,
      contextLevel: 5,
      thinkingEffort: "medium",
      thinkingLevel: 3,
      speedTarget: 4,
      costTarget: 3,
      stepShape: { shape: "write_heavy", posture: "type_cheap", gate: "run_behavior" },
    },
  };

  const profile = policy.effectiveRequestProfile(req, env);

  assert.equal(profile.taskLevel, 3);
  assert.equal(profile.contextLevel, 5);
  assert.equal(profile.qualityTarget, 3);
  assert.equal(profile.costTarget, 3);
  assert.equal(profile.thinkingLevel, 3);
  assert.equal(profile.speedTarget, 4);
});

test("large list summaries keep text-only cost and thinking targets", () => {
  const env = { LLM_ROUTING_POLICY: "balanced", LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [{ role: "user", content: "List the current changed paths and summarize the status." }],
    _inputTokens: 170000,
    _estimatedTokens: 190000,
  };

  const profile = policy.effectiveRequestProfile(req, env);

  assert.equal(profile.taskKind, "list_summary");
  assert.equal(profile.taskLevel, 2);
  assert.equal(profile.contextLevel, 5);
  assert.equal(profile.qualityTarget, 3);
  assert.equal(profile.costTarget <= 2, true);
  assert.equal(profile.thinkingLevel <= 2, true);
  assert.equal(profile.speedTarget, 5);
});

test("trusted assessments cannot turn large list summaries into expensive reasoning", () => {
  const env = { LLM_ROUTING_POLICY: "balanced", LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [{ role: "user", content: "List the current changed paths and summarize the status." }],
    _inputTokens: 170000,
    _estimatedTokens: 190000,
  };
  const assessed = policy.profileFromTrustedTaskAssessment(req, {
    level: 5,
    effort: "high",
    speed: 3,
    reason: "list_summary",
    taskKind: "list_summary",
    thinkingLevel: 4,
    costTarget: 5,
  });

  const profile = policy.effectiveRequestProfile({ ...req, _llmProxyDifficulty: assessed }, env);

  assert.equal(profile.taskKind, "list_summary");
  assert.equal(profile.taskLevel, 2);
  assert.equal(profile.contextLevel, 5);
  assert.equal(profile.qualityTarget, 3);
  assert.equal(profile.costTarget <= 2, true);
  assert.equal(profile.thinkingLevel <= 2, true);
  assert.equal(profile.speedTarget, 5);
});

test("context-only write-heavy continuations prefer medium thinking over higher thinking", () => {
  const env = { LLM_ROUTING_POLICY: "balanced", LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [{ role: "user", content: "continua" }],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _inputTokens: 141000,
    _estimatedTokens: 173000,
    _llmProxyDifficulty: {
      level: 5,
      label: "deep",
      taskKind: "agentic_coding",
      taskLevel: 3,
      contextLevel: 5,
      thinkingEffort: "medium",
      thinkingLevel: 3,
      speedTarget: 4,
      costTarget: 3,
      stepShape: { shape: "write_heavy", posture: "type_cheap", gate: "run_behavior" },
    },
  };
  const medium = {
    name: "Windsurf-ClaudeSonnet46",
    model: "windsurf/claude-sonnet-4.6",
    family: "windsurf",
    caps: ["text", "coding", "tools", "thinking"],
    context: 200000,
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "medium",
  };
  const high = {
    ...medium,
    name: "Windsurf-ClaudeSonnet46Thinking",
    model: "windsurf/claude-sonnet-4-6-thinking",
    thinking_effort: "high",
  };

  const mediumBonus = policy.providerPolicyBonus(medium, req, { env, getEffectiveContext: (provider) => provider.context });
  const highBonus = policy.providerPolicyBonus(high, req, { env, getEffectiveContext: (provider) => provider.context });

  assert.equal(mediumBonus > highBonus + 0.25, true);
});

test("providerPolicyBonus uses learned effective context instead of advertised context", () => {
  const provider = {
    name: "Windsurf-ClaudeOpus461M",
    family: "windsurf",
    model: "windsurf/claude-opus-4-6-1m",
    caps: ["text", "coding", "tools", "thinking", "max"],
    context: 1000000,
    cost_group: 4,
    quality_group: 5,
    speed_group: 3,
    thinking_effort: "xhigh",
  };
  const env = { LLM_COST_TARGET: "3", LLM_THINKING_TARGET: "medium", LLM_SPEED_TARGET: "4" };
  const req = {
    messages: [{ role: "user", content: "Deep research with one million token context and architecture risk." }],
    _estimatedTokens: 1000,
  };

  const advertisedBonus = policy.providerPolicyBonus(provider, req, { env });
  const learnedBonus = policy.providerPolicyBonus(provider, req, { env, getEffectiveContext: () => 200000 });

  assert.equal(learnedBonus < advertisedBonus, true);
});
