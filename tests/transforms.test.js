"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const transforms = require("../lib/transforms");
const compaction = require("../lib/compaction");
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
  assert.equal(transformed.messages.some((m) => m.role === "assistant" && m.content === "continue"), false);
  assert.equal(transformed.messages.some((m) => m.role === "assistant" && m.content === "Tool result received."), false);
});

test("transformRequest caps tools using provider-advertised maximum", async () => {
  const tools = Array.from({ length: 3 }, (_, idx) => ({
    type: "function",
    function: {
      name: `tool_${idx}`,
      parameters: { type: "object", properties: {} },
    },
  }));

  const transformed = await transforms.transformRequest({
    ...provider,
    name: "Copilot-Test",
    family: "copilot",
    max_tools: 2,
  }, {
    model: "auto-coding",
    tools,
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Use the available tools." },
    ],
  });

  assert.deepEqual(transformed.tools.map((tool) => tool.function.name), ["tool_0", "tool_1"]);
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

test("detectStalling catches file-check prelude ending with Go", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            "Local screenshot 131KB, prod 179KB. Still different size. Prod might have extra banner or different theme.",
            "",
            "Check global CSS and tailwind config for environment-specific flags. Then check layout for any dynamic blocks.",
            "",
            "apps/web/tailwind.config.ts",
            "apps/web/src/app/globals.css",
            "apps/web/src/app/layout.tsx (re-read to see if anything missed)",
            "Go.",
          ].join("\n"),
        },
      },
    ],
  });

  assert.equal(transforms.detectStalling(body), true);
});

test("detectUseCase recognizes Responses input_image content as image capability", () => {
  const result = transforms.detectUseCase([
    {
      role: "user",
      content: [
        { type: "input_text", text: "Compare the screenshot." },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    },
  ], {});

  assert.equal(result.caps.has("images"), true);
});

test("transformRequest normalizes direct chat input_image content to OpenAI image_url", async () => {
  const transformed = await transforms.transformRequest(
    { ...provider, caps: ["text", "coding", "tools", "images"] },
    {
      model: "auto-coding",
      _llmProxyBypassOptimizations: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Compare this screenshot." },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        },
      ],
    },
  );

  assert.deepEqual(transformed.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "Compare this screenshot." },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  ]);
});

test("transformRequest flattens image parts for providers with learned no_images", async () => {
  const originalCompat = state.providerCompat;
  state.providerCompat = { "Copilot-NoVision": { no_images: true } };

  try {
    const transformed = await transforms.transformRequest(
      { ...provider, name: "Copilot-NoVision", protocol: "openai", caps: ["text", "coding", "tools", "images"] },
      {
        model: "auto-coding",
        _llmProxyBypassOptimizations: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare this screenshot." },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
            ],
          },
        ],
      },
    );

    assert.equal(typeof transformed.messages[0].content, "string");
    assert.match(transformed.messages[0].content, /Compare this screenshot/);
    assert.match(transformed.messages[0].content, /image omitted/);
    assert.doesNotMatch(JSON.stringify(transformed.messages), /image_url|data:image/);
  } finally {
    state.providerCompat = originalCompat;
  }
});

test("transformRequest flattens only data images for providers with learned no_data_images", async () => {
  const originalCompat = state.providerCompat;
  state.providerCompat = { "Codex-NoDataImages": { no_data_images: true } };
  const dataRequest = {
    model: "auto-coding",
    _llmProxyBypassOptimizations: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot." },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
    ],
  };
  const remoteRequest = {
    model: "auto-coding",
    _llmProxyBypassOptimizations: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ],
      },
    ],
  };

  try {
    const providerWithImages = { ...provider, name: "Codex-NoDataImages", protocol: "codex", caps: ["text", "coding", "tools", "images"] };
    const dataTransformed = await transforms.transformRequest(providerWithImages, dataRequest);
    const remoteTransformed = await transforms.transformRequest(providerWithImages, remoteRequest);

    assert.equal(typeof dataTransformed.messages[0].content, "string");
    assert.match(dataTransformed.messages[0].content, /image omitted/);
    assert.doesNotMatch(JSON.stringify(dataTransformed.messages), /data:image/);
    assert.equal(Array.isArray(remoteTransformed.messages[0].content), true);
    assert.equal(remoteTransformed.messages[0].content[1].image_url.url, "https://example.test/image.png");
  } finally {
    state.providerCompat = originalCompat;
  }
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

test("detectUseCase keeps direct identity replies cheap even when IDE tools are present", () => {
  const result = transforms.detectUseCase([
    { role: "system", content: "You are a software engineering agent with codebase tools." },
    { role: "user", content: "who are you?" },
  ], {
    tools: Array.from({ length: 75 }, (_, i) => ({
      type: "function",
      function: { name: `tool_${i}`, parameters: { type: "object" } },
    })),
  });

  assert.equal(result.difficulty.taskKind, "direct_answer");
  assert.equal(result.isAgent, false);
  assert.equal(result.caps.has("tools"), false);
  assert.equal(result.caps.has("coding"), false);
});

test("detectUseCase keeps passive Romanian why questions cheap even when IDE tools are present", () => {
  const result = transforms.detectUseCase([
    { role: "system", content: "You are a software engineering agent with codebase tools." },
    { role: "user", content: "pt ce are nevoie de OPENAI_API_KEY?" },
  ], {
    tools: Array.from({ length: 8 }, (_, i) => ({
      type: "function",
      function: { name: `tool_${i}`, parameters: { type: "object" } },
    })),
  });

  assert.equal(result.difficulty.taskKind, "explanation");
  assert.equal(result.isAgent, false);
  assert.equal(result.caps.has("tools"), false);
  assert.equal(result.caps.has("coding"), false);
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
  assert.match(system, /TOOL STRATEGY.*tools are available/);
  assert.doesNotMatch(system, /EVERY response MUST include at least one tool call/);
  assert.match(system, /USER CONFIRMATION GATES:/);
  assert.match(system, /PLAN DISSEMINATION AND SELF-REVIEW:/);
  assert.match(system, /Before implementing a newly created plan, disseminate it into concrete phases/);
  assert.match(system, /After producing a plan or completing implementation, run a self-review pass/);
  assert.match(system, /RULES — AUTONOMY WITH USER GATES:/);
  assert.match(system, /You are autonomous after the user has authorized implementation/);
  assert.match(system, /Reply A to proceed without explicit user gate\|Press enter to continue without explicit user gate/);
  assert.match(system, /OUTPUT CONTRACT:/);
  assert.match(system, /CONTINUATION AND HISTORY:/);
  assert.match(system, /VIOLATIONS \(any = failure\):/);
  assert.match(system, /Tool result received \/ continue \/ next-step-only progress while useful tool work remains/);
  assert.match(system, /ONLY ask user when: destructive\/irreversible action/);
  assert.match(system, /ROUTING ASSESSMENT.*next route/i);
  assert.match(system, /immediate next route after the current response or tool call/i);
  assert.match(system, /next actionable step, not a retrospective score/i);
  assert.match(system, /LLM_PROXY_INTERNAL_ROUTING level=<1-5>/);
  assert.match(system, /sentinel mandatory/i);
  assert.match(system, /never bare effort=\.\.\., speed=\.\.\., or reason=\.\.\./i);
  assert.match(system, /TASK STATUS - private completion hint/i);
  assert.match(system, /LLM_PROXY_TASK_STATUS state=<working\|complete\|blocked> reason=<slug>/);
  assert.match(system, /never marker-only/i);
  assert.match(system, /EFFICIENT FILE READING:/);
  assert.match(system, /Read files in chunks using offset\/limit parameters/);
  assert.match(system, /Compacted tool outputs use \[READ/);
  assert.match(system, /If a file was already read and not modified, do NOT re-read it/);
  assert.match(system, /CLIENT CAPABILITY CONTRACT:/);
  assert.match(system, /Subagents: no dedicated subagent tool detected/i);
  assert.match(system, /GENERIC CLIENT PROFILE:/);
  assert.match(system, /CONTEXT AND MEMORY CONTRACT:/);
  assert.match(system, /preserve lineage in summaries/i);
  assert.doesNotMatch(system, /You must use subagents whenever possible/i);
  assert.match(system, /PARALLEL EXECUTION:/);
  assert.match(system, /Keep this project-specific instruction\./);
  assert.equal(system.includes("Bogdan's LLM Smart Proxy"), false);
});

test("transformRequest injects structured output contract and route mode lanes", async () => {
  const implement = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tools: [{ type: "function", function: { name: "Read" } }],
    messages: [{ role: "user", content: "Implement the parser fix and verify it." }],
  });
  const implementSystem = implement.messages[0].content;

  assert.match(implementSystem, /OUTPUT CONTRACT/);
  assert.match(implementSystem, /For active work with tools available, every assistant turn must be exactly one of:/);
  assert.match(implementSystem, /valid tool call\(s\)/);
  assert.match(implementSystem, /complete final answer after all required work and verification are done/);
  assert.match(implementSystem, /one concise blocking clarification when no safe\/discoverable action exists/);
  assert.match(implementSystem, /Tool result received/);
  assert.match(implementSystem, /historical-tool-invocation replay text/);
  assert.match(implementSystem, /Do not output tool calls as prose, XML, markdown, shell transcripts/);
  assert.match(implementSystem, /If images, screenshots, or other media are present/);
  assert.match(implementSystem, /MODE LANE: Implement\n- Tool calls, edits, verification, and continuation until complete\./);
  assert.match(implementSystem, /If work remains and a tool can advance it, call the next appropriate tool now/);
  assert.match(implementSystem, /CONTINUATION AND HISTORY:/);
  assert.match(implementSystem, /Do not end a turn while required tool sessions, commands, browser automation, or active implementation work are still running or incomplete/);
  assert.match(implementSystem, /treat it as stale context and continue with a real tool call or final answer/);
  assert.match(implementSystem, /VIOLATIONS \(any = failure\):/);

  const orderedLayers = [
    "IDENTITY:",
    "USE CASE FOCUS:",
    "MODE LANE: Implement",
    "REQUEST CONTEXT:",
    "OUTPUT CONTRACT:",
    "CONTINUATION AND HISTORY:",
    "VIOLATIONS (any = failure):",
    "FLOW:",
    "TOOL STRATEGY",
  ];
  for (let i = 1; i < orderedLayers.length; i += 1) {
    assert.equal(
      implementSystem.indexOf(orderedLayers[i - 1]) < implementSystem.indexOf(orderedLayers[i]),
      true,
      `${orderedLayers[i - 1]} should appear before ${orderedLayers[i]}`,
    );
  }

  const explore = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tools: [{ type: "function", function: { name: "Read" } }],
    messages: [{ role: "user", content: "Debug the failing Playwright click and inspect the logs before editing." }],
  });
  assert.match(explore.messages[0].content, /MODE LANE: Explore\n- Read\/search\/log review, parallel exploration, evidence summary, no writes until authorized\./);

  const plan = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [{ role: "user", content: "Create a plan before implementation and wait for confirmation." }],
  });
  assert.match(plan.messages[0].content, /MODE LANE: Plan\n- Plan, assumptions, risks, verification gates, then stop before implementation\./);

  const ask = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [{ role: "user", content: "Cum te numesti?" }],
  });
  assert.match(ask.messages[0].content, /MODE LANE: Ask\n- Concise answer, no tools, no private markers unless explicitly enabled\./);
});

test("transformRequest scopes goal plan and subagent instructions to current IDE capabilities", async () => {
  const generic = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    messages: [{ role: "user", content: "Implement the parser fix and verify it." }],
  });
  const genericSystem = generic.messages[0].content;

  assert.match(genericSystem, /CLIENT CAPABILITY CONTRACT:/);
  assert.match(genericSystem, /Detected client: generic/i);
  assert.match(genericSystem, /Plan\/progress: no dedicated plan tool detected/i);
  assert.match(genericSystem, /Goals: no dedicated goal tool detected/i);
  assert.match(genericSystem, /Subagents: no dedicated subagent tool detected/i);
  assert.doesNotMatch(genericSystem, /You must use subagents whenever possible/i);
  assert.doesNotMatch(genericSystem, /Use TodoWrite\/update_plan/i);
  assert.doesNotMatch(genericSystem, /Use TodoWrite to track/i);

  const codex = await transforms.transformRequest(provider, {
    model: "auto-coding",
    _llmProxyClient: "codex",
    tools: [
      { type: "function", function: { name: "update_plan", parameters: { type: "object" } } },
      { type: "function", function: { name: "get_goal", parameters: { type: "object" } } },
      { type: "function", function: { name: "update_goal", parameters: { type: "object" } } },
      { type: "function", function: { name: "multi_agent_v1.spawn_agent", parameters: { type: "object" } } },
      { type: "function", function: { name: "functions.exec_command", parameters: { type: "object" } } },
    ],
    messages: [{ role: "user", content: "Implement the parser fix and verify it." }],
  });
  const codexSystem = codex.messages[0].content;

  assert.match(codexSystem, /CLIENT CAPABILITY CONTRACT:/);
  assert.match(codexSystem, /Detected client: codex/i);
  assert.match(codexSystem, /CODEX PROFILE:/);
  assert.match(codexSystem, /forked thread\/subagent work/i);
  assert.match(codexSystem, /close completed agents/i);
  assert.match(codexSystem, /Plan\/progress: use update_plan/i);
  assert.match(codexSystem, /Goals: available via get_goal, update_goal/i);
  assert.match(codexSystem, /pursu(?:e|ing) .*long-running/i);
  assert.match(codexSystem, /Goal state is available via get_goal, update_goal; use it as the durable completion contract/i);
  assert.match(codexSystem, /Subagents: available via multi_agent_v1\.spawn_agent/i);
  assert.match(codexSystem, /Use subagents whenever possible/i);

  const copilot = await transforms.transformRequest(provider, {
    model: "auto-coding",
    _llmProxyClient: "copilot",
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    messages: [{ role: "user", content: "Review the failure and explain the next fix." }],
  });
  const copilotSystem = copilot.messages[0].content;
  assert.match(copilotSystem, /Detected client: copilot/i);
  assert.match(copilotSystem, /COPILOT PROFILE:/);
  assert.match(copilotSystem, /not claim to create Copilot subagents/i);

  const claude = await transforms.transformRequest(provider, {
    model: "auto-coding",
    _llmProxyClient: "claude_code",
    tools: [
      { type: "function", function: { name: "Task", parameters: { type: "object" } } },
      { type: "function", function: { name: "TodoWrite", parameters: { type: "object" } } },
    ],
    messages: [{ role: "user", content: "Investigate logs and split independent checks." }],
  });
  const claudeSystem = claude.messages[0].content;
  assert.match(claudeSystem, /Detected client: claude_code/i);
  assert.match(claudeSystem, /CLAUDE CODE PROFILE:/);
  assert.match(claudeSystem, /Task\/agent\/background-agent affordances/i);
});

test("transformRequest supports Devin Desktop as a Windsurf-like client profile", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    _llmProxyClient: "devin_desktop",
    tools: [
      { type: "function", function: { name: "Read", parameters: { type: "object" } } },
      { type: "function", function: { name: "multi_agent_v1.spawn_agent", parameters: { type: "object" } } },
    ],
    messages: [{ role: "user", content: "Investigate logs and split independent checks." }],
  });
  const system = transformed.messages[0].content;

  assert.match(system, /Detected client: devin_desktop/i);
  assert.match(system, /DEVIN DESKTOP PROFILE:/);
  assert.match(system, /Windsurf successor/i);
  assert.match(system, /Agent Command Center/i);
  assert.match(system, /ACP-capable surface/i);
  assert.match(system, /Use subagents whenever possible/i);
});

test("transformRequest hidden-only prompt mode preserves IDE identity while keeping proxy control lane", async () => {
  const original = process.env.LLM_PROXY_PROMPT_INJECTION;
  process.env.LLM_PROXY_PROMPT_INJECTION = "off";
  try {
    const transformed = await transforms.transformRequest(provider, {
      model: "auto-coding",
      _llmProxyClient: "devin_desktop",
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "You are Devin Desktop, Cognition's official IDE agent.\nKeep this repo rule." },
        { role: "user", content: "Continue until the fix is verified." },
      ],
    });
    const system = transformed.messages[0].content;

    assert.match(system, /^You are Devin Desktop, Cognition's official IDE agent\./);
    assert.match(system, /Keep this repo rule\./);
    assert.match(system, /LLM PROXY HIDDEN CONTROL LANE/);
    assert.match(system, /CLIENT CAPABILITY CONTRACT:/);
    assert.match(system, /Detected client: devin_desktop/i);
    assert.match(system, /OUTPUT CONTRACT:/);
    assert.match(system, /LLM_PROXY_INTERNAL_ROUTING level=<1-5>/);
    assert.doesNotMatch(system, /You are Project LLM Smart Proxy/);
    assert.doesNotMatch(system, /Do not answer as Claude, ChatGPT, Gemini, Codex, Windsurf/);
  } finally {
    if (original === undefined) delete process.env.LLM_PROXY_PROMPT_INJECTION;
    else process.env.LLM_PROXY_PROMPT_INJECTION = original;
  }
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
  assert.match(system, /MODE LANE: Ask/);
  assert.equal(system.length < 2100, true);
  assert.doesNotMatch(system, /LLM_PROXY_INTERNAL_ROUTING level=<1-5>/);
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
  assert.match(system, /MODE LANE: Ask/);
  assert.doesNotMatch(system, /PLAN DISSEMINATION AND SELF-REVIEW/);
  assert.equal(system.length < 2100, true);
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
  assert.match(system, /MODE LANE: Ask/);
  assert.equal(system.length < 2100, true);
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
  assert.match(system, /private routing metadata for next route/i);
  assert.match(system, /LLM_PROXY_INTERNAL_ROUTING level=<1-5>/);
  assert.match(system, /Sentinel mandatory/i);
  assert.match(system, /never bare effort=\.\.\., speed=\.\.\., or reason=\.\.\./i);
  assert.match(system, /never marker-only/i);
  assert.match(system, /MODE LANE: Ask/);
  assert.equal(system.length < 2400, true);
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
  assert.match(system, /Use extra internal reasoning/);
  assert.doesNotMatch(system, /chain-of-thought|Show step-by-step reasoning/i);
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
  assert.doesNotMatch(JSON.stringify(transformed), /LLM_PROXY_(?:INTERNAL_ROUTING|TASK_DIFFICULTY)/);
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
  assert.match(system, /MODE LANE: Plan/);
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
  assert.equal((system.match(/\[LLM_PROXY_SYSTEM_PROMPT_START\]/g) || []).length, 1);
  assert.match(system, /Keep this project-specific instruction\./);
});

test("transformRequest strips old proxy mode tails and recalled memory before reinjection", async () => {
  const previousProxy = [
    "You are Project LLM Smart Proxy — senior staff engineer. Date: 2026-01-01 00:00:00 UTC.",
    "IDENTITY: old proxy identity.",
    "- Subagent checklist: 1) Did it use tools? 2) Did files actually change? 3) Do tests pass? 4) Is output correct?",
    "",
    "THINKING MODE: stale reasoning tail from a previous route.",
    "[MEMORY — llm-proxy]:",
    "Old remembered instruction that should not stack.",
  ].join("\n");

  const transformed = await transforms.transformRequest(provider, {
    _memoryInjection: "\n[LLM_PROXY_MEMORY_START]\nFresh memory only.\n[LLM_PROXY_MEMORY_END]\n",
    model: "auto-text",
    messages: [
      { role: "system", content: `${previousProxy}\n\nKeep this project-specific instruction.` },
      { role: "user", content: "Summarize the current design." },
    ],
  });

  const system = transformed.messages[0].content;
  assert.equal((system.match(/Project LLM Smart Proxy/g) || []).length, 2); // title + identity rule
  assert.equal((system.match(/THINKING MODE:/g) || []).length, 0);
  assert.equal((system.match(/\[LLM_PROXY_MEMORY_START\]/g) || []).length, 1);
  assert.doesNotMatch(system, /Old remembered instruction/);
  assert.match(system, /Fresh memory only/);
  assert.match(system, /Keep this project-specific instruction\./);
});

test("transformRequest removes known upstream identity lines without dropping project instructions", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-text",
    messages: [
      {
        role: "system",
        content: [
          "You are Claude Code.",
          "You're Gemini.",
          "Tu esti Claude Code, un agent de coding.",
          "You are ChatGPT, a large language model.",
          "Always preserve this repository-specific convention.",
        ].join("\n"),
      },
      { role: "user", content: "Cine esti?" },
    ],
  });

  const system = transformed.messages[0].content;
  assert.doesNotMatch(system, /You are Claude Code/i);
  assert.doesNotMatch(system, /You're Gemini/i);
  assert.doesNotMatch(system, /Tu esti Claude Code/i);
  assert.doesNotMatch(system, /You are ChatGPT/i);
  assert.match(system, /Always preserve this repository-specific convention\./);
});

test("transformRequest preserves Claude Code system verbatim for native Claude providers", async () => {
  const claudeProvider = {
    ...provider,
    name: "Claude-Opus48",
    family: "claude",
    protocol: "anthropic",
    model: "claude/claude-opus-4-8",
    upstream_model: "claude-opus-4-8",
  };
  const originalSystem = [
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "Keep this repository-specific convention.",
  ].join("\n");
  const transformed = await transforms.transformRequest(claudeProvider, {
    model: "claude/claude-opus-4-8",
    _claudeCodeMetadata: {
      user_id: JSON.stringify({
        device_id: "device-from-cli",
        account_uuid: "account-from-cli",
        session_id: "session-from-cli",
      }),
    },
    messages: [
      { role: "system", content: originalSystem },
      { role: "user", content: "Reply ok." },
    ],
  });

  const system = transformed.messages[0].content;
  assert.equal(system, originalSystem);
  assert.doesNotMatch(system, /Project LLM Smart Proxy/);
});

test("transformRequest strips tool schemas from direct no-tool answers", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tool_choice: "auto",
    function_call: "auto",
    parallel_tool_calls: true,
    tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object" } } }],
    functions: [{ name: "legacy_bash", parameters: { type: "object" } }],
    messages: [
      { role: "system", content: "You are Claude Code." },
      { role: "user", content: "Who are you?" },
    ],
  });

  assert.equal(transformed.tools, undefined);
  assert.equal(transformed.functions, undefined);
  assert.equal(transformed.tool_choice, undefined);
  assert.equal(transformed.function_call, undefined);
  assert.equal(transformed.parallel_tool_calls, undefined);
  assert.doesNotMatch(JSON.stringify(transformed.messages), /Claude Code/);
});

test("transformRequest strips tool schemas from passive explanation questions", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tool_choice: "auto",
    parallel_tool_calls: true,
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    messages: [
      { role: "system", content: "You are Claude Code." },
      { role: "user", content: "pt ce are nevoie de OPENAI_API_KEY?" },
    ],
  });

  assert.equal(transformed.tools, undefined);
  assert.equal(transformed.tool_choice, undefined);
  assert.equal(transformed.parallel_tool_calls, undefined);
  assert.doesNotMatch(JSON.stringify(transformed.messages), /TOOL STRATEGY.*MUST use tools/);
});

test("transformRequest preserves required tool contracts for direct-looking requests", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tool_choice: "required",
    tools: [{ type: "function", function: { name: "Ping", parameters: { type: "object" } } }],
    messages: [
      { role: "system", content: "You are Claude Code." },
      { role: "user", content: "Ping the health endpoint." },
    ],
  });

  assert.equal(transformed.tool_choice, "required");
  assert.equal(transformed.tools.length, 1);
  assert.match(transformed.messages[0].content, /TOOL STRATEGY.*MUST use tools/);
});

test("transformRequest strips tool controls when no valid tool schemas remain", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tool_choice: "required",
    function_call: { name: "missing_tool" },
    parallel_tool_calls: true,
    tools: [{ type: "function", function: { parameters: { type: "object" } } }],
    functions: [],
    messages: [
      { role: "system", content: "You are Claude Code." },
      { role: "user", content: "Continue the investigation from the existing context." },
    ],
  });

  assert.equal(transformed.tools, undefined);
  assert.equal(transformed.functions, undefined);
  assert.equal(transformed.tool_choice, undefined);
  assert.equal(transformed.function_call, undefined);
  assert.equal(transformed.parallel_tool_calls, undefined);
});

test("transformRequest keeps required local prompt when provider rejects tool_choice", async () => {
  const providerName = "NoToolChoice-Test";
  const originalCompat = state.providerCompat[providerName];
  state.providerCompat[providerName] = { no_tool_choice: true };
  try {
    const transformed = await transforms.transformRequest({ ...provider, name: providerName }, {
      model: "auto-coding",
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "Ping", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "You are Claude Code." },
        { role: "user", content: "Ping the health endpoint." },
      ],
    });

    assert.equal(transformed.tool_choice, undefined);
    assert.equal(transformed.tools.length, 1);
    assert.match(transformed.messages[0].content, /TOOL STRATEGY.*MUST use tools/);
  } finally {
    if (originalCompat === undefined) delete state.providerCompat[providerName];
    else state.providerCompat[providerName] = originalCompat;
  }
});

test("transformRequest does not force every response to tool-call when tools are optional", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    tool_choice: { type: "auto" },
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    messages: [
      { role: "system", content: "You are Claude Code." },
      { role: "user", content: "Investigate this issue and report the root cause." },
    ],
  });

  const system = transformed.messages[0].content;
  assert.match(system, /TOOL STRATEGY.*tools are available/);
  assert.doesNotMatch(system, /EVERY response MUST include at least one tool call/);
  assert.match(system, /Text-only answers are allowed/);
});

test("transformRequest does not force tools for no-tool requests that include recalled memory", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-text",
    _memoryInjection: "\n[LLM_PROXY_MEMORY_START]\nArchitecture note: prefer narrow summaries.\n[LLM_PROXY_MEMORY_END]\n",
    messages: [
      { role: "system", content: "Keep this project instruction." },
      { role: "user", content: "Summarize the current design." },
    ],
  });

  const system = transformed.messages[0].content;
  assert.doesNotMatch(system, /MUST use tools/);
  assert.match(system, /NO-TOOL STRATEGY/);
  assert.match(system, /Architecture note: prefer narrow summaries/);
});

test("transformRequest removes stale proxy blocks from developer messages", async () => {
  const oldProxy = [
    "[LLM_PROXY_SYSTEM_PROMPT_START]",
    "You are Project LLM Smart Proxy.",
    "[LLM_PROXY_MEMORY_START]",
    "Old recalled memory.",
    "[LLM_PROXY_MEMORY_END]",
    "[LLM_PROXY_SYSTEM_PROMPT_END]",
  ].join("\n");

  const transformed = await transforms.transformRequest(provider, {
    model: "auto-text",
    messages: [
      { role: "developer", content: `${oldProxy}\nKeep developer project rule.` },
      { role: "user", content: "Summarize this." },
    ],
  });

  const serialized = JSON.stringify(transformed.messages);
  assert.equal((serialized.match(/\[LLM_PROXY_SYSTEM_PROMPT_START\]/g) || []).length, 1);
  assert.equal((serialized.match(/\[LLM_PROXY_MEMORY_START\]/g) || []).length, 0);
  assert.match(serialized, /Keep developer project rule/);
});

test("transformRequest preserves project rules under common instruction headings", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-text",
    messages: [
      {
        role: "system",
        content: [
          "You are ChatGPT, a large language model.",
          "# Code style",
          "All shell commands must be prefixed with rtk.",
          "# Tone and style",
          "Use concise English.",
        ].join("\n"),
      },
      { role: "user", content: "Summarize the setup." },
    ],
  });

  const system = transformed.messages[0].content;
  assert.match(system, /All shell commands must be prefixed with rtk\./);
  assert.doesNotMatch(system, /You are ChatGPT/);
});

test("transformRequest keeps volatile request metadata out of the stable prompt prefix", async () => {
  const OriginalDate = global.Date;
  async function renderAt(iso) {
    global.Date = class FakeDate extends OriginalDate {
      constructor(...args) {
        return args.length > 0 ? new OriginalDate(...args) : new OriginalDate(iso);
      }
      static now() { return new OriginalDate(iso).getTime(); }
      static parse(value) { return OriginalDate.parse(value); }
      static UTC(...args) { return OriginalDate.UTC(...args); }
    };
    return (await transforms.transformRequest(provider, {
      model: "auto-text",
      messages: [{ role: "user", content: "Summarize these notes." }],
    })).messages[0].content;
  }

  try {
    const first = await renderAt("2026-05-20T10:00:00.000Z");
    const second = await renderAt("2026-05-20T10:00:05.000Z");

    assert.equal(first.slice(0, 800), second.slice(0, 800));
  } finally {
    global.Date = OriginalDate;
  }
});

test("transformRequest caps output after proxy prompt and memory injection", async () => {
  const transformed = await transforms.transformRequest({
    ...provider,
    context: 4000,
  }, {
    model: "auto-coding",
    max_tokens: 1600,
    _memoryInjection: `\n[LLM_PROXY_MEMORY_START]\n${"stable project memory ".repeat(120)}\n[LLM_PROXY_MEMORY_END]\n`,
    messages: [
      { role: "system", content: "Project rule: keep responses concise." },
      { role: "user", content: "Implement a small routing helper." },
      { role: "assistant", content: "I will inspect the helper." },
      { role: "user", content: "Continue and use the memory." },
    ],
  });

  const used = compaction.estimateTokens(transformed.messages) + compaction.estimateToolsTokens(transformed.tools) + transformed.max_tokens;
  assert.equal(used <= 4000, true);
  assert.equal(transformed.max_tokens < 1600, true);
  assert.match(transformed.messages[0].content, /memory truncated|memory omitted/);
});

test("transformRequest compacts near provider context before tokenizer mismatch can overflow", async () => {
  const originalCompact = compaction.compactMessagesAsync;
  const originalLog = state.log;
  const originalRatio = process.env.LLM_PROXY_POST_COMPACT_CONTEXT_RATIO;
  const logs = [];
  let compactCalled = false;

  const request = {
    model: "auto-coding",
    max_tokens: 100,
    messages: [
      { role: "system", content: "Project rule." },
      { role: "user", content: "x ".repeat(820) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "y ".repeat(820) },
      { role: "assistant", content: "ok" },
    ],
  };
  const estimated = compaction.estimateTokens(request.messages)
    + compaction.estimateRequestSchemaTokens(request)
    + request.max_tokens;

  try {
    delete process.env.LLM_PROXY_POST_COMPACT_CONTEXT_RATIO;
    state.log = (line) => logs.push(line);
    compaction.compactMessagesAsync = async (messages, targetTokens, maxOutputTokens) => {
      compactCalled = true;
      assert.equal(targetTokens < estimated, true);
      assert.equal(maxOutputTokens, 100);
      return {
        messages: [
          messages[0],
          { role: "user", content: "compacted transcript" },
        ],
      };
    };

    assert.equal(estimated > 900 && estimated < 950, true);
    const transformed = await transforms.transformRequest({ ...provider, context: 1000 }, request);

    assert.equal(compactCalled, true);
    assert.equal(transformed.messages.some((message) => /compacted transcript/.test(String(message.content || ""))), true);
    assert.match(logs.join("\n"), /POST-COMPACT: Codex-Test needs .* > 900 \(90% of 1000\)/);
  } finally {
    compaction.compactMessagesAsync = originalCompact;
    state.log = originalLog;
    if (originalRatio === undefined) delete process.env.LLM_PROXY_POST_COMPACT_CONTEXT_RATIO;
    else process.env.LLM_PROXY_POST_COMPACT_CONTEXT_RATIO = originalRatio;
  }
});

test("transformRequest uses conservative Codex context compaction for large Responses traffic", async () => {
  const originalCompact = compaction.compactMessagesAsync;
  const originalLog = state.log;
  const originalRatio = process.env.LLM_PROXY_CODEX_POST_COMPACT_CONTEXT_RATIO;
  const originalTarget = process.env.LLM_PROXY_CODEX_POST_COMPACT_TARGET_RATIO;
  const logs = [];
  let compactCalled = false;

  const request = {
    model: "auto-coding",
    max_tokens: 4096,
    stream: true,
    messages: [
      { role: "system", content: "Project rule." },
      { role: "user", content: "x ".repeat(310000) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "y ".repeat(310000) },
      { role: "assistant", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
  };
  const estimated = compaction.estimateTokens(request.messages)
    + compaction.estimateRequestSchemaTokens(request)
    + request.max_tokens;

  try {
    delete process.env.LLM_PROXY_CODEX_POST_COMPACT_CONTEXT_RATIO;
    delete process.env.LLM_PROXY_CODEX_POST_COMPACT_TARGET_RATIO;
    state.log = (line) => logs.push(line);
    compaction.compactMessagesAsync = async (messages, targetTokens, maxOutputTokens) => {
      compactCalled = true;
      assert.equal(estimated > Math.floor(272000 * 0.55), true);
      assert.equal(targetTokens < estimated, true);
      assert.equal(targetTokens <= Math.floor(272000 * 0.5), true);
      assert.equal(maxOutputTokens, 4096);
      return {
        messages: [
          messages[0],
          { role: "user", content: "codex compacted transcript" },
        ],
      };
    };

    const transformed = await transforms.transformRequest({
      ...provider,
      name: "Codex-GPT55",
      family: "codex",
      model: "codex/gpt-5.5",
      upstream_model: "gpt-5.5",
      context: 272000,
    }, request);

    assert.equal(compactCalled, true);
    assert.equal(transformed.messages.some((message) => /codex compacted transcript/.test(String(message.content || ""))), true);
    assert.match(logs.join("\n"), /POST-COMPACT: Codex-GPT55 needs .* > 149600 \(55% of 272000\)/);
  } finally {
    compaction.compactMessagesAsync = originalCompact;
    state.log = originalLog;
    if (originalRatio === undefined) delete process.env.LLM_PROXY_CODEX_POST_COMPACT_CONTEXT_RATIO;
    else process.env.LLM_PROXY_CODEX_POST_COMPACT_CONTEXT_RATIO = originalRatio;
    if (originalTarget === undefined) delete process.env.LLM_PROXY_CODEX_POST_COMPACT_TARGET_RATIO;
    else process.env.LLM_PROXY_CODEX_POST_COMPACT_TARGET_RATIO = originalTarget;
  }
});

test("transformRequest includes legacy function schemas in final context budget", async () => {
  const fnSchema = {
    name: "legacy_large_tool",
    description: "x ".repeat(1200),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "y ".repeat(1200) },
      },
    },
  };

  const request = {
    model: "auto-coding",
    max_tokens: 500,
    functions: [fnSchema],
    messages: [
      { role: "user", content: "Implement the specified function with the available legacy function schema." },
    ],
  };

  const unconstrained = await transforms.transformRequest(provider, request);
  const inputTokens = compaction.estimateTokens(unconstrained.messages)
    + compaction.estimateRequestSchemaTokens(unconstrained);
  const context = inputTokens + 250;

  const transformed = await transforms.transformRequest({
    ...provider,
    context,
  }, request);

  const used = compaction.estimateTokens(transformed.messages)
    + compaction.estimateRequestSchemaTokens(transformed)
    + transformed.max_tokens;
  assert.equal(used <= context, true);
  assert.equal(transformed.max_tokens < 500, true);
});

test("buildHeaders does not synthesize legacy client branding from provider flags", () => {
  const headers = transforms.buildHeaders({
    name: "Legacy",
    key: "anonymous",
    no_auth: true,
    kilo: true,
    headers: { "X-Custom": "ok" },
  });

  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    "X-Custom": "ok",
  });
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

test("transformRequest removes whitespace-only assistant messages after tool synchronization", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-coding",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Call a tool." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "answered_call", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "answered_call", content: "README contents." },
      { role: "assistant", content: " " },
      { role: "assistant", content: "\n\t  " },
      { role: "user", content: "Continue." },
    ],
  });

  assert.equal(
    transformed.messages.some((msg) => msg.role === "assistant" && !msg.tool_calls?.length && String(msg.content || "").trim() === ""),
    false,
  );
});

test("transformRequest does not add whitespace assistant separators for native Anthropic providers", async () => {
  const anthropicProvider = {
    ...provider,
    name: "Claude-Opus48",
    family: "claude",
    protocol: "anthropic",
    model: "claude/claude-opus-4-8",
  };
  const transformed = await transforms.transformRequest(anthropicProvider, {
    model: "auto-coding",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_1", content: "README contents." },
      { role: "user", content: "Continue." },
    ],
  });

  assert.equal(transformed.messages.some((msg) => msg.role === "assistant" && !msg.tool_calls?.length && String(msg.content || "").trim() === ""), false);
  assert.equal(transformed.messages.some((msg, i, arr) => msg.role === "tool" && arr[i + 1]?.role === "user"), true);
});

test("transformRequest flattens compacted Windsurf tool history into text", async () => {
  const windsurfProvider = {
    name: "Windsurf-ClaudeSonnet46",
    model: "windsurf/claude-sonnet-4.6",
    protocol: "windsurf",
    family: "windsurf",
    key: "test",
    caps: ["tools", "coding"],
    context: 200000,
    tier: 1,
  };
  const transformed = await transforms.transformRequest(windsurfProvider, {
    model: "auto-coding",
    _llmProxyCompactedContext: true,
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Read README." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call_read_1", content: "README contents after compaction." },
      { role: "user", content: "Continue with the fix." },
    ],
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: { file_path: { type: "string" } } } } }],
  });

  const serialized = JSON.stringify(transformed.messages);
  assert.equal(transformed.messages.some((msg) => msg.role === "tool"), false);
  assert.equal(transformed.messages.some((msg) => msg.tool_calls?.length > 0), false);
  assert.doesNotMatch(serialized, /Tool call:/);
  assert.match(serialized, /Historical tool invocation \(already executed\): Read/);
  assert.match(serialized, /Historical tool result \(already observed\) for Read/);
  assert.match(serialized, /README contents after compaction/);
  assert.equal(transformed.tools.length, 1);
});

test("transformRequest compacts large Windsurf flattened tool history", async () => {
  const originalThreshold = process.env.WINDSURF_FLATTEN_TOOL_HISTORY_COMPACT_THRESHOLD;
  const originalKeep = process.env.WINDSURF_FLATTEN_TOOL_HISTORY_KEEP_EVENTS;
  process.env.WINDSURF_FLATTEN_TOOL_HISTORY_COMPACT_THRESHOLD = "6";
  process.env.WINDSURF_FLATTEN_TOOL_HISTORY_KEEP_EVENTS = "4";
  try {
    const windsurfProvider = {
      name: "Windsurf-Gemini25Pro",
      model: "windsurf/google-gemini-2-5-pro",
      protocol: "windsurf",
      family: "windsurf",
      key: "test",
      caps: ["tools", "coding"],
      context: 1048576,
      tier: 1,
    };
    const messages = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Continue debugging." },
    ];
    for (let i = 1; i <= 5; i += 1) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "Read", arguments: `{\"file_path\":\"file${i}.md\"}` } }],
      });
      messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `tool result ${i}` });
    }
    messages.push({ role: "user", content: "Go to the next step." });

    const transformed = await transforms.transformRequest(windsurfProvider, {
      model: "auto-coding",
      messages,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: { file_path: { type: "string" } } } } }],
    });

    const serialized = JSON.stringify(transformed.messages);
    assert.equal(transformed.messages.some((msg) => msg.role === "tool"), false);
    assert.equal(transformed.messages.some((msg) => msg.tool_calls?.length > 0), false);
    assert.match(serialized, /Earlier native tool history omitted for compatibility/);
    assert.doesNotMatch(serialized, /file1\.md/);
    assert.doesNotMatch(serialized, /tool result 1/);
    assert.match(serialized, /file4\.md/);
    assert.match(serialized, /tool result 5/);
  } finally {
    if (originalThreshold === undefined) delete process.env.WINDSURF_FLATTEN_TOOL_HISTORY_COMPACT_THRESHOLD;
    else process.env.WINDSURF_FLATTEN_TOOL_HISTORY_COMPACT_THRESHOLD = originalThreshold;
    if (originalKeep === undefined) delete process.env.WINDSURF_FLATTEN_TOOL_HISTORY_KEEP_EVENTS;
    else process.env.WINDSURF_FLATTEN_TOOL_HISTORY_KEEP_EVENTS = originalKeep;
  }
});

test("transformRequest drops flattened Windsurf history on artifact replay retry", async () => {
  const originalRetryKeep = process.env.WINDSURF_FLATTEN_TOOL_HISTORY_RETRY_KEEP_EVENTS;
  process.env.WINDSURF_FLATTEN_TOOL_HISTORY_RETRY_KEEP_EVENTS = "0";
  try {
    const windsurfProvider = {
      name: "Windsurf-Gemini25Pro",
      model: "windsurf/google-gemini-2-5-pro",
      protocol: "windsurf",
      family: "windsurf",
      key: "test",
      caps: ["tools", "coding"],
      context: 1048576,
      tier: 1,
    };
    const transformed = await transforms.transformRequest(windsurfProvider, {
      _llmProxyArtifactReplayRetry: true,
      model: "auto-coding",
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "Continue debugging." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_prev", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" } }],
        },
        { role: "tool", tool_call_id: "call_prev", content: "failing test output" },
        { role: "user", content: "continue. Do not replay historical tool invocations or tool results." },
      ],
      tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" } } } } }],
    });

    const serialized = JSON.stringify(transformed);
    assert.equal(transformed._llmProxyArtifactReplayRetry, undefined);
    assert.equal(transformed.messages.some((msg) => msg.role === "tool"), false);
    assert.equal(transformed.messages.some((msg) => msg.tool_calls?.length > 0), false);
    assert.match(serialized, /Earlier native tool history omitted for compatibility/);
    assert.doesNotMatch(serialized, /Historical tool invocation/);
    assert.doesNotMatch(serialized, /Historical tool result/);
    assert.doesNotMatch(serialized, /failing test output/);
  } finally {
    if (originalRetryKeep === undefined) delete process.env.WINDSURF_FLATTEN_TOOL_HISTORY_RETRY_KEEP_EVENTS;
    else process.env.WINDSURF_FLATTEN_TOOL_HISTORY_RETRY_KEEP_EVENTS = originalRetryKeep;
  }
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

test("transformRequest leaves auto-memory extraction traffic unwrapped by proxy memory prompt", async () => {
  const transformed = await transforms.transformRequest(provider, {
    model: "auto-memory",
    _memoryInjection: "\n[LLM_PROXY_MEMORY_START]\nArchitecture note that must not feed Graphiti extraction.\n[LLM_PROXY_MEMORY_END]\n",
    messages: [
      { role: "system", content: "Extract entities and facts into structured memory." },
      { role: "user", content: "Episode: user fixed routing fallback." },
    ],
    response_format: { type: "json_object" },
  });

  const serialized = JSON.stringify(transformed.messages);
  assert.equal(transformed._memoryInjection, undefined);
  assert.match(String(transformed.messages[0]?.content || ""), /Extract entities and facts/);
  assert.doesNotMatch(serialized, /Project LLM Smart Proxy|LLM_PROXY_MEMORY_START|LLM_PROXY_RECALL|Architecture note that must not feed Graphiti extraction/);
});
