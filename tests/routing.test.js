"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");

const routing = require("../lib/routing");
const state = require("../lib/state");

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1/chat/completions`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withRoutingState(fn) {
  const originalScores = state.scores;
  const originalWriteFileSync = fs.writeFileSync;
  state.scores = {};
  fs.writeFileSync = () => {};
  routing.init({ sendError: () => {}, trackSessionTokens: () => {} });
  try {
    return await fn();
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    state.scores = originalScores;
  }
}

function provider(url, extra = {}) {
  return {
    name: "Routing-Test",
    model: "test-model",
    url,
    key: "test",
    protocol: "openai",
    caps: ["text", "coding", "tools"],
    context: 131072,
    tier: 1,
    ...extra,
  };
}

test("routeToProvider accepts simple text-only replies when difficulty marker says task is trivial", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "LLM_PROXY_TASK_DIFFICULTY level=1 effort=none speed=5 reason=identity\nI am Claude. Working in Claude Code.",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
          messages: [{ role: "user", content: "who are you?" }],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.equal(JSON.parse(resp.body).choices[0].message.content, "I am Claude. Working in Claude Code.");
    });
  });
});

test("routeToProvider accepts proxy identity answers without tool calls when tools are present", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "Project LLM Smart Proxy.",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
        messages: [{ role: "user", content: "what is your name?" }],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.equal(JSON.parse(resp.body).choices[0].message.content, "Project LLM Smart Proxy.");
    });
  });
});

test("routeToProvider accepts exact text-only replies without tool calls when tools are present", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "metadata-ok",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
        messages: [{ role: "user", content: "Reply exactly: metadata-ok" }],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.equal(JSON.parse(resp.body).choices[0].message.content, "metadata-ok");
    });
  });
});

test("routeToProvider rejects wrong identity answers even when tools are present", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "Claude.",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }, async (url) => {
      await assert.rejects(
        () => routing.routeToProvider(provider(url), {
          model: "auto-coding",
          messages: [{ role: "user", content: "who are you?" }],
          tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
        }),
        (error) => error.status === 422 && error.stalling === true,
      );
    });
  });
});

test("routeToProvider rejects marker-only replies because the proxy strips the marker", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "LLM_PROXY_TASK_DIFFICULTY level=1 effort=none speed=5 reason=identity",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }, async (url) => {
      await assert.rejects(
        () => routing.routeToProvider(provider(url), {
          model: "auto-coding",
          messages: [{ role: "user", content: "who are you?" }],
        }),
        (error) => error.status === 422 && error.stalling === true,
      );
    });
  });
});

test("dedupeConsecutiveIdempotentToolCalls removes only exact consecutive read duplicates", () => {
  const longPrefix = "x".repeat(120);
  const reqBody = {
    messages: [
      { role: "user", content: "Read files." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: `${longPrefix}-a.md` }) } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "first" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_2", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: `${longPrefix}-b.md` }) } }],
      },
      { role: "tool", tool_call_id: "call_2", content: "second" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_3", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: `${longPrefix}-b.md` }) } }],
      },
      { role: "tool", tool_call_id: "call_3", content: "third" },
    ],
  };

  const removed = routing.dedupeConsecutiveIdempotentToolCalls(reqBody);
  const remainingCallIds = reqBody.messages
    .filter((msg) => msg.role === "assistant" && msg.tool_calls?.length)
    .map((msg) => msg.tool_calls[0].id);

  assert.equal(removed, 2);
  assert.deepEqual(remainingCallIds, ["call_1", "call_3"]);
});

test("routeToProvider rejects generated tool calls missing required tool input", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      await assert.rejects(
        routing.routeToProvider(provider(url), {
          model: "auto-coding",
          messages: [{ role: "user", content: "run pwd" }],
          tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
        }),
        (err) => err.status === 422 && /missing required field "command"/.test(err.body),
      );
    });
  });
});

test("routeToProvider accepts requested strategy reports even when tools are available", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "## Improvement Strategy",
              "",
              "- Stabilize routing and fallback.",
              "- Add observability for transport and tool calls.",
              "- Add regression tests for each provider.",
              "- ".repeat(200),
            ].join("\n"),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
          messages: [{ role: "user", content: "analyze the current project and provide an improvement strategy" }],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.match(JSON.parse(resp.body).choices[0].message.content, /Strategy/);
    });
  });
});

test("routeToProvider accepts short completed-work reports when tools are available", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "Continued improvements.",
              "",
              "Changes:",
              "- Added unit tests for [test_unit_modules.py](tests/e2e/test_unit_modules.py).",
              "- Fixed Bash tool mapping for command field validation.",
              "- Updated routing to choose coding-sm for small tasks.",
            ].join("\n"),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
        messages: [
          { role: "user", content: "continue the improvements and tell me what changed" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"npm test\"}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "tests passed" },
        ],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.match(JSON.parse(resp.body).choices[0].message.content, /Changes/);
    });
  });
});

test("routeToProvider still rejects short planning-only text when tools are available", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "Scanning repo, git state, and key files. Then I will make a clear strategy.",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      await assert.rejects(
        routing.routeToProvider(provider(url), {
          model: "auto-coding",
          messages: [{ role: "user", content: "analyze the current project and provide a strategy" }],
          tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
        }),
        (err) => err.status === 422 && err.stalling === true,
      );
    });
  });
});

test("routeToProvider accepts substantive reports when Claude Code hides the user ask", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "Analysis complete. Improvement strategy:",
              "",
              "## Current State",
              "",
              "- Context read from tool history.",
              "- ".repeat(300),
              "",
              "## Recommendations",
              "",
              "- Keep the response as a report, without an additional tool call.",
            ].join("\n"),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
        messages: [
          { role: "user", content: "Codebase and user instructions are shown below. Be sure to adhere to these instructions." },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "README contents" },
        ],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.match(JSON.parse(resp.body).choices[0].message.content, /strategy/i);
    });
  });
});

test("routeToProvider accepts strategy-report inflections from provider output", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "Analysis complete. Here is what I found and the recommended strategy:",
              "",
              "---",
              "",
              "## Current State",
              "",
              "**Stack:** Python CLI over Ansible and Docker.",
              "- Routing must be stabilized for analysis responses.",
              "- The recommended order follows impact and risk.",
              "- ".repeat(350),
            ].join("\n"),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
        messages: [
          { role: "user", content: "Codebase and user instructions are shown below. Be sure to adhere to these instructions." },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "README contents" },
        ],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.match(JSON.parse(resp.body).choices[0].message.content, /recommended strategy/);
    });
  });
});

test("routeToProvider does not classify substantive strategy reports as cognitive stalls", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "Analysis complete. Here's the improvement strategy, ranked by impact and effort:",
              "",
              "## Current State",
              "",
              "- The proxy already has provider failover and request transforms.",
              "- Remaining work include better observability and stricter adapter tests.",
              "",
              "## Next Steps",
              "",
              "- Next steps include stabilizing report detection.",
              "- Recommended fix: avoid rerouting finished analysis reports.",
              "- ".repeat(320),
            ].join("\n"),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "auto-coding",
        messages: [
          { role: "user", content: "Codebase and user instructions are shown below. Be sure to adhere to these instructions." },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "README contents" },
        ],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.match(JSON.parse(resp.body).choices[0].message.content, /improvement strategy/);
    });
  });
});

test("auto-coding ranking applies routing policy cost and speed targets", () => {
  const originalProviders = state.PROVIDERS;
  const originalGroups = state.GROUPS;
  const originalEnv = {
    LLM_COST_TARGET: process.env.LLM_COST_TARGET,
    LLM_SPEED_TARGET: process.env.LLM_SPEED_TARGET,
    LLM_THINKING_TARGET: process.env.LLM_THINKING_TARGET,
  };
  state.GROUPS = { "auto-coding": "coding" };
  state.PROVIDERS = [
    {
      name: "Cheap-Fast",
      model: "custom/fast",
      family: "custom",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 200000,
      tier: 1,
      tc: true,
      cost_group: 2,
      speed_group: 5,
      thinking_effort: "low",
    },
    {
      name: "Expensive-Deep",
      model: "custom/deep",
      family: "custom",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 200000,
      tier: 1,
      tc: true,
      cost_group: 5,
      speed_group: 2,
      thinking_effort: "xhigh",
    },
  ];

  try {
    process.env.LLM_COST_TARGET = "2";
    process.env.LLM_SPEED_TARGET = "5";
    process.env.LLM_THINKING_TARGET = "low";
    const trivialProviders = routing.getProvidersForGroup("auto-coding", 1000, {
      model: "auto-coding",
      messages: [{ role: "user", content: "Reply exactly: ok" }],
      _estimatedTokens: 20,
    });

    process.env.LLM_COST_TARGET = "5";
    process.env.LLM_SPEED_TARGET = "1";
    process.env.LLM_THINKING_TARGET = "xhigh";
    const deepProviders = routing.getProvidersForGroup("auto-coding", 90000, {
      model: "auto-coding",
      messages: [{ role: "user", content: "Design a deep architecture migration with streaming, proxy, auth, and regression tests." }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      _estimatedTokens: 90000,
    });

    assert.equal(trivialProviders[0].name, "Cheap-Fast");
    assert.equal(deepProviders[0].name, "Expensive-Deep");
  } finally {
    state.PROVIDERS = originalProviders;
    state.GROUPS = originalGroups;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("coding-sm ranks fast coding tool models ahead of large max models", () => {
  const originalProviders = state.PROVIDERS;
  const originalGroups = state.GROUPS;
  state.GROUPS = { "coding-sm": "coding-sm" };
  state.PROVIDERS = [
    {
      name: "Huge-Max",
      model: "codex/gpt-5.5",
      family: "codex",
      key: "test",
      caps: ["text", "coding", "tools", "thinking", "max"],
      context: 1000000,
      tier: 1,
      tc: true,
    },
    {
      name: "Small-Fast",
      model: "codex/gpt-5.4-mini",
      family: "codex",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 131072,
      tier: 1,
      tc: true,
    },
  ];

  try {
    const providers = routing.getProvidersForGroup("coding-sm", 1000, {
      model: "coding-sm",
      messages: [{ role: "user", content: "read package.json" }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
    });

    assert.equal(providers[0].name, "Small-Fast");
  } finally {
    state.PROVIDERS = originalProviders;
    state.GROUPS = originalGroups;
  }
});

test("tool-bearing smart routes keep Windsurf native tool providers eligible", () => {
  const originalProviders = state.PROVIDERS;
  const originalGroups = state.GROUPS;
  state.GROUPS = { "auto-coding": "coding" };
  state.PROVIDERS = [
    {
      name: "Windsurf-NativeTools",
      model: "windsurf/swe-1.6",
      family: "windsurf",
      protocol: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 200000,
      tier: 1,
      tc: true,
    },
    {
      name: "Codex-Tools",
      model: "codex/gpt-5.4-mini",
      family: "codex",
      protocol: "openai",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 200000,
      tier: 1,
      tc: true,
    },
  ];

  try {
    const providers = routing.getProvidersForGroup("auto-coding", 1000, {
      model: "auto-coding",
      messages: [{ role: "user", content: "inspect repo" }],
      tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
    });

    assert.equal(providers.some((provider) => provider.name === "Windsurf-NativeTools"), true);
    assert.equal(providers.some((provider) => provider.name === "Codex-Tools"), true);
  } finally {
    state.PROVIDERS = originalProviders;
    state.GROUPS = originalGroups;
  }
});

test("routing profile log exposes complexity targets and provider policy dimensions", () => {
  const line = routing.formatRoutingProfileForLog("auto-coding", {
    model: "auto-coding",
    messages: [
      { role: "system", content: "You are Claude Code running as a software engineering agent." },
      { role: "user", content: "<system-reminder> SessionStart:startup hook success." },
    ],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _estimatedTokens: 67548,
  }, 35548);

  assert.match(line, /ROUTING-PROFILE: auto-coding/);
  assert.match(line, /level=4\/complex/);
  assert.match(line, /source=heuristic/);
  assert.match(line, /task=agentic_coding/);
  assert.match(line, /cost=3/);
  assert.match(line, /thinking=3\/medium/);
  assert.match(line, /speed=4/);
  assert.match(line, /tools=75/);

  const candidate = routing.formatProviderCandidateForLog({
    name: "Windsurf-SWE16Fast",
    model: "windsurf/swe-1.6-fast",
    family: "windsurf",
    context: 200000,
    tier: 1,
    cost_group: 2,
    speed_group: 5,
    thinking_effort: "high",
    _lastRoutingScore: 4.54,
  });

  assert.match(candidate, /score=4\.54/);
  assert.match(candidate, /cost=2/);
  assert.match(candidate, /think=high/);
  assert.match(candidate, /speed=5/);
});

test("routing skips providers with recent unresolved chronic stalling", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [
      {
        name: "Chronic-Staller",
        model: "codex/gpt-5.5",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 1000000,
        tier: 1,
        tc: true,
      },
      {
        name: "Reliable-Coder",
        model: "codex/gpt-5.4",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 200000,
        tier: 1,
        tc: true,
      },
    ];
    state.scores["Chronic-Staller"] = {
      requests: 10,
      successes: 8,
      failures: 2,
      success_rate: 0.8,
      stalling: 6,
      last_stall_time: Date.now() - 60_000,
      last_error: { message: "text-only with tools", time: Date.now() - 60_000 },
      cooldown_until: Date.now() - 1000,
    };

    try {
      const providers = routing.getProvidersForGroup("auto-coding", 1000, {
        model: "auto-coding",
        messages: [{ role: "user", content: "Implement a refactor." }],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(providers.some((provider) => provider.name === "Chronic-Staller"), false);
      assert.equal(providers[0].name, "Reliable-Coder");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
    }
  });
});

test("routing prefers reliable fast model over low-success larger-context fit when current context still fits", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [
      {
        name: "Flaky-Large-Fit",
        model: "windsurf/gpt-5-4-mini-high",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 400000,
        tier: 1,
        tc: true,
        cost_group: 2,
        speed_group: 5,
        thinking_effort: "high",
      },
      {
        name: "Reliable-Fast-Fit",
        model: "codex/gpt-5.4-mini",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 200000,
        tier: 1,
        tc: true,
        cost_group: 2,
        speed_group: 5,
        thinking_effort: "high",
      },
    ];
    state.scores["Flaky-Large-Fit"] = {
      requests: 23,
      successes: 11,
      failures: 12,
      success_rate: 11 / 23,
      avg_latency: 7104,
      cooldown_until: 0,
    };
    state.scores["Reliable-Fast-Fit"] = {
      requests: 50,
      successes: 47,
      failures: 3,
      success_rate: 47 / 50,
      avg_latency: 4662,
      cooldown_until: 0,
    };

    try {
      const providers = routing.getProvidersForGroup("auto-coding", 145000, {
        model: "auto-coding",
        messages: [
          { role: "system", content: "You are Claude Code running as a software engineering agent." },
          { role: "user", content: "<system-reminder> SessionStart:startup hook success." },
        ],
        tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
        _inputTokens: 113000,
        _estimatedTokens: 145000,
      });

      assert.equal(providers[0].name, "Reliable-Fast-Fit");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
    }
  });
});

test("routing keeps reliable 200k light model ahead until context is truly tight", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [
      {
        name: "Large-High-Context",
        model: "windsurf/gpt-5-4-mini-high",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 400000,
        tier: 1,
        tc: true,
        cost_group: 2,
        speed_group: 5,
        thinking_effort: "high",
      },
      {
        name: "Reliable-200k-Light",
        model: "codex/gpt-5.4-mini",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking"],
        context: 200000,
        tier: 1,
        tc: true,
        cost_group: 2,
        speed_group: 5,
        thinking_effort: "medium",
      },
    ];
    state.scores["Large-High-Context"] = {
      requests: 40,
      successes: 28,
      failures: 12,
      success_rate: 28 / 40,
      avg_latency: 12214,
      cooldown_until: 0,
    };
    state.scores["Reliable-200k-Light"] = {
      requests: 50,
      successes: 47,
      failures: 3,
      success_rate: 47 / 50,
      avg_latency: 4662,
      cooldown_until: 0,
    };

    try {
      const providers = routing.getProvidersForGroup("auto-coding", 173013, {
        model: "auto-coding",
        messages: [
          { role: "system", content: "You are Claude Code running as a software engineering agent." },
          { role: "user", content: "<system-reminder> SessionStart:startup hook success." },
        ],
        tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
        _inputTokens: 141013,
        _estimatedTokens: 173013,
      });

      assert.equal(providers[0].name, "Reliable-200k-Light");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
    }
  });
});
