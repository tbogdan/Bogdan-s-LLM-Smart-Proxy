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

class FakeClientResponse {
  constructor() {
    this.status = null;
    this.headers = null;
    this.body = "";
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.body += chunk;
  }

  end(chunk = "") {
    this.body += chunk;
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

test("routeToProvider estimates usage when upstream reports zero tokens", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "benchmark-ok",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    }, async (url) => {
      const resp = await routing.routeToProvider(provider(url), {
        model: "test-model",
        messages: [
          { role: "system", content: "Benchmark system prompt." },
          { role: "user", content: "Reply exactly: benchmark-ok" },
        ],
        _llmProxyBypassOptimizations: true,
      });
      const usage = JSON.parse(resp.body).usage;

      assert.equal(usage.prompt_tokens > 0, true);
      assert.equal(usage.completion_tokens > 0, true);
      assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
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

test("handleChatCompletion preserves duplicate history for direct benchmark bypass", async () => {
  await withRoutingState(async () => {
    let capturedRequest = null;
    await withServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        capturedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      });
    }, async (url) => {
      const originalProviders = state.PROVIDERS;
      state.PROVIDERS = [provider(url, { name: "Direct-Test", model: "test-model" })];
      try {
        await routing.handleChatCompletion({
          model: "test-model",
          _llmProxyBypassOptimizations: true,
          messages: [
            { role: "user", content: "Replay exact direct baseline." },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_read_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
            },
            { role: "tool", tool_call_id: "call_read_1", content: "First read." },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_read_2", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }],
            },
            { role: "tool", tool_call_id: "call_read_2", content: "Second read." },
          ],
        }, new FakeClientResponse());

        const readCalls = capturedRequest.messages
          .filter((msg) => msg.role === "assistant" && msg.tool_calls?.[0]?.function?.name === "Read");
        assert.equal(readCalls.length, 2);
      } finally {
        state.PROVIDERS = originalProviders;
      }
    });
  });
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

test("routeToProvider accepts diagnostic recovery reports from tool-heavy sessions", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "The script works now; the previous shell compatibility fix is resolved.",
              "",
              "The current failure is **Ansible requires a sudo password on localhost**.",
              "",
              "```text",
              "status=failed",
              "fatal: missing sudo password",
              "```",
              "",
              "Evidence used:",
              "- The command reached execution and returned status=failed.",
              "- The error is outside the edited script path.",
              "- Verification should re-run the command after the Ansible privilege setting is fixed.",
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
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"run_cmd.py\"}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "return object excerpt" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "Edit", arguments: "{\"file_path\":\"run_cmd.py\"}" } }] },
          { role: "tool", tool_call_id: "call_2", content: "edit failed" },
        ],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.match(JSON.parse(resp.body).choices[0].message.content, /sudo password/);
    });
  });
});

test("routeToProvider accepts concise script command reports from tool-heavy sessions", async () => {
  await withRoutingState(async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "Done. One command:",
              "",
              "```shell",
              "./run-chaos-plan.sh",
              "```",
              "",
              "The script now uses the default SSH_USER value and the run command should execute the prepared plan.",
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
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Edit", arguments: "{\"file_path\":\"run-chaos-plan.sh\"}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "edit applied" },
        ],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", required: ["command"] } } }],
      });

      assert.equal(resp.status, 200);
      assert.match(JSON.parse(resp.body).choices[0].message.content, /run-chaos-plan/);
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

test("coding-sm avoids Opus-class providers for small fast coding work", () => {
  const originalProviders = state.PROVIDERS;
  const originalGroups = state.GROUPS;
  const originalEnv = {
    LLM_COST_TARGET: process.env.LLM_COST_TARGET,
    LLM_THINKING_TARGET: process.env.LLM_THINKING_TARGET,
    LLM_SPEED_TARGET: process.env.LLM_SPEED_TARGET,
    LLM_ROUTING_POLICY: process.env.LLM_ROUTING_POLICY,
  };
  state.GROUPS = { "coding-sm": "coding-sm" };
  state.PROVIDERS = [
    {
      name: "Opus-Deep",
      model: "windsurf/claude-opus-4.6",
      family: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking", "max"],
      context: 200000,
      tier: 1,
      tc: true,
    },
    {
      name: "Sonnet-Mid",
      model: "windsurf/claude-sonnet-4.6",
      family: "windsurf",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 200000,
      tier: 1,
      tc: true,
    },
    {
      name: "Mini-Fast",
      model: "codex/gpt-5.4-mini",
      family: "codex",
      key: "test",
      caps: ["text", "coding", "tools", "thinking"],
      context: 200000,
      tier: 1,
      tc: true,
    },
  ];

  try {
    process.env.LLM_COST_TARGET = "3";
    process.env.LLM_THINKING_TARGET = "medium";
    process.env.LLM_SPEED_TARGET = "4";
    process.env.LLM_ROUTING_POLICY = "balanced";

    const providers = routing.getProvidersForGroup("coding-sm", 1000, {
      model: "coding-sm",
      messages: [{ role: "user", content: "Fix this async timeout helper and keep the answer concise." }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", required: ["file_path"] } } }],
      _estimatedTokens: 1000,
    });

    assert.notEqual(providers[0].name, "Opus-Deep");
    assert.equal(["Sonnet-Mid", "Mini-Fast"].includes(providers[0].name), true);
  } finally {
    state.PROVIDERS = originalProviders;
    state.GROUPS = originalGroups;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
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
  const reqBody = {
    model: "auto-coding",
    messages: [
      { role: "system", content: "You are Claude Code running as a software engineering agent." },
      { role: "user", content: "<system-reminder> SessionStart:startup hook success." },
    ],
    tools: Array.from({ length: 75 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    _estimatedTokens: 67548,
  };
  const line = routing.formatRoutingProfileForLog("auto-coding", reqBody, 35548);

  assert.match(line, /ROUTING-PROFILE: auto-coding/);
  assert.match(line, /level=4\/complex/);
  assert.match(line, /source=heuristic/);
  assert.match(line, /task=agentic_coding/);
  assert.match(line, /shape=write_heavy/);
  assert.match(line, /gate=run_behavior/);
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

test("routing profile log exposes review shape and diff validation gate", () => {
  const reqBody = {
    model: "auto-coding",
    messages: [
      { role: "user", content: "Review this LLM-generated diff line by line; compare summary versus diff and report regressions only." },
    ],
    _estimatedTokens: 6000,
  };
  const line = routing.formatRoutingProfileForLog("auto-coding", reqBody, 6000);

  assert.match(line, /task=code_review|task=completion_review|task=verification/);
  assert.match(line, /shape=review/);
  assert.match(line, /gate=read_diff/);
});

test("routing assessment log exposes chosen provider and task reason", () => {
  const line = routing.formatRoutingAssessmentForLog({
    name: "Codex-GPT54Mini",
    model: "codex/gpt-5.4-mini",
    family: "codex",
    context: 200000,
    tier: 1,
  }, {
    model: "auto-coding",
    messages: [{ role: "user", content: "Reply exactly: metadata-ok" }],
    _estimatedTokens: 256,
  });

  assert.match(line, /ASSESS: Codex-GPT54Mini level=1 effort=none speed=5 reason=exact_reply/);
  assert.match(line, /source=heuristic/);
  assert.match(line, /task=direct_answer/);
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

test("auto-max prefers one-million-token Opus-class providers for deep context requests", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    state.GROUPS = { "auto-max": "max" };
    state.PROVIDERS = [
      {
        name: "Codex-GPT55",
        model: "codex/gpt-5.5",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 272000,
        tier: 2,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 4,
        thinking_effort: "xhigh",
      },
      {
        name: "Windsurf-ClaudeOpus461M",
        model: "windsurf/claude-opus-4-6-1m",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1000000,
        tier: 2,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "xhigh",
      },
    ];

    try {
      const providers = routing.getProvidersForGroup("auto-max", 260000, {
        model: "auto-max",
        messages: [{ role: "user", content: "Deep research one million token production incident with streaming, tools, rate limits, and architecture risk." }],
        _estimatedTokens: 260000,
      });

      assert.equal(providers[0].name, "Windsurf-ClaudeOpus461M");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
    }
  });
});

test("auto-thinking prefers frontier non-1M models for short-context reasoning", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    state.GROUPS = { "auto-thinking": "thinking" };
    state.PROVIDERS = [
      {
        name: "Windsurf-ClaudeOpus461M",
        model: "windsurf/claude-opus-4-6-1m",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1000000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "xhigh",
      },
      {
        name: "Codex-GPT55",
        model: "codex/gpt-5.5",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 272000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 4,
        thinking_effort: "xhigh",
      },
    ];

    try {
      const req = {
        model: "auto-thinking",
        messages: [{ role: "user", content: "Design a recovery workflow with evidence, action, verification, and stop conditions." }],
        _estimatedTokens: 500,
      };
      const providers = routing.getProvidersForGroup("auto-thinking", 500, req);

      assert.equal(providers[0].name, "Codex-GPT55");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
    }
  });
});

test("auto-max keeps Opus for long-context requests but not short no-tool incidents", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    state.GROUPS = { "auto-max": "max" };
    state.PROVIDERS = [
      {
        name: "Windsurf-ClaudeOpus461M",
        model: "windsurf/claude-opus-4-6-1m",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1000000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "xhigh",
      },
      {
        name: "Codex-GPT55",
        model: "codex/gpt-5.5",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 272000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 4,
        thinking_effort: "xhigh",
      },
    ];

    try {
      const shortReq = {
        model: "auto-max",
        messages: [{ role: "user", content: "Production incident decision: choose adaptive routing, schema translation, provider ban, or always frontier. Return JSON with risk and first fix." }],
        _estimatedTokens: 500,
      };
      const longReq = {
        model: "auto-max",
        messages: [{ role: "user", content: "Deep research one million token production incident with streaming, tools, rate limits, and architecture risk." }],
        _estimatedTokens: 260000,
      };

      assert.equal(routing.getProvidersForGroup("auto-max", 500, shortReq)[0].name, "Codex-GPT55");
      assert.equal(routing.getProvidersForGroup("auto-max", 260000, longReq)[0].name, "Windsurf-ClaudeOpus461M");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
    }
  });
});

test("balanced benchmark-style recovery routes to intermediate models before Opus unless frontier context is needed", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    const originalEnv = {
      LLM_COST_TARGET: process.env.LLM_COST_TARGET,
      LLM_THINKING_TARGET: process.env.LLM_THINKING_TARGET,
      LLM_SPEED_TARGET: process.env.LLM_SPEED_TARGET,
      LLM_ROUTING_POLICY: process.env.LLM_ROUTING_POLICY,
    };
    state.GROUPS = { "auto-max": "max", "auto-thinking": "thinking", "auto-coding": "coding" };
    state.PROVIDERS = [
      {
        name: "Windsurf-ClaudeOpus461M",
        model: "windsurf/claude-opus-4-6-1m",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1000000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "xhigh",
      },
      {
        name: "Codex-GPT54",
        model: "codex/gpt-5.4",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 200000,
        tier: 1,
        tc: true,
        cost_group: 3,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "medium",
      },
      {
        name: "Claude-Sonnet46",
        model: "claude/claude-sonnet-4-6",
        family: "claude",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 200000,
        tier: 1,
        tc: true,
        cost_group: 3,
        quality_group: 4,
        speed_group: 4,
        thinking_effort: "medium",
      },
    ];

    try {
      process.env.LLM_COST_TARGET = "3";
      process.env.LLM_THINKING_TARGET = "medium";
      process.env.LLM_SPEED_TARGET = "4";
      process.env.LLM_ROUTING_POLICY = "balanced";

      const editReq = {
        model: "auto-max",
        messages: [
          { role: "system", content: "Return exactly four bullets: root cause, immediate fix, prevention, benchmark signal." },
          { role: "assistant", content: "Edit run_cmd.py\nEdit failed: expected text was not found after stale reads." },
          { role: "user", content: "Diagnose why the edit failed and give a precise next-edit algorithm so the patch does not corrupt adjacent return-object fields." },
        ],
        _inputTokens: 12000,
        _estimatedTokens: 12300,
      };
      const incidentReq = {
        model: "auto-max",
        messages: [
          { role: "system", content: "Return minified JSON only." },
          { role: "user", content: "A local LLM proxy routes Claude Code traffic to Windsurf, Claude, and Codex. Incident facts: Windsurf sometimes returns text-only while 75 tools are available, some Claude calls are rate-limited, direct Opus is accurate but expensive, SWE is free but weak for agentic coding, and benchmark direct calls must bypass prompt injection and compaction. Choose a decision between provider-ban, schema-translation, adaptive-routing, or always-opus. Return JSON with decision, first_fix, fallback, benchmark_signal, and risk." },
        ],
        _inputTokens: 8000,
        _estimatedTokens: 8400,
      };
      const securityReq = {
        model: "auto-coding",
        messages: [
          { role: "system", content: "Return a concise patch sketch and three regression tests." },
          { role: "user", content: "Fix this Node.js webhook verifier. Reject replayed timestamps, use constant-time comparison, handle malformed hex safely, and list regression tests." },
        ],
        _inputTokens: 1200,
        _estimatedTokens: 1500,
      };

      assert.notEqual(routing.getProvidersForGroup("auto-max", 12300, editReq)[0].name, "Windsurf-ClaudeOpus461M");
      assert.notEqual(routing.getProvidersForGroup("auto-max", 8400, incidentReq)[0].name, "Windsurf-ClaudeOpus461M");
      assert.notEqual(routing.getProvidersForGroup("auto-coding", 1500, securityReq)[0].name, "Windsurf-ClaudeOpus461M");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("auto-coding promotes Opus-class provider for failed edit recovery on huge Claude Code history", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    const originalGroups = state.GROUPS;
    state.GROUPS = { "auto-coding": "coding" };
    state.PROVIDERS = [
      {
        name: "Windsurf-Gemini3FlashLow",
        model: "windsurf/google-gemini-3-0-flash-low",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1048576,
        tier: 1,
        tc: true,
        cost_group: 1,
        quality_group: 4,
        speed_group: 5,
        thinking_effort: "low",
      },
      {
        name: "Windsurf-ClaudeOpus461M",
        model: "windsurf/claude-opus-4-6-1m",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1000000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "xhigh",
      },
    ];

    try {
      const req = {
        model: "auto-coding",
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
      const providers = routing.getProvidersForGroup("auto-coding", 257000, req);

      assert.equal(providers[0].name, "Windsurf-ClaudeOpus461M");
    } finally {
      state.PROVIDERS = originalProviders;
      state.GROUPS = originalGroups;
    }
  });
});

test("auto routes the final Opus benchmark challenge to an Opus-class provider", async () => {
  await withRoutingState(async () => {
    const originalProviders = state.PROVIDERS;
    state.PROVIDERS = [
      {
        name: "Windsurf-Gemini3FlashLow",
        model: "windsurf/google-gemini-3-0-flash-low",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1048576,
        tier: 1,
        tc: true,
        cost_group: 1,
        quality_group: 4,
        speed_group: 5,
        thinking_effort: "low",
      },
      {
        name: "Codex-GPT55",
        model: "codex/gpt-5.5",
        family: "codex",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 272000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 4,
        thinking_effort: "xhigh",
      },
      {
        name: "Windsurf-ClaudeOpus461M",
        model: "windsurf/claude-opus-4-6-1m",
        family: "windsurf",
        key: "test",
        caps: ["text", "coding", "tools", "thinking", "max"],
        context: 1000000,
        tier: 1,
        tc: true,
        cost_group: 4,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "xhigh",
      },
    ];

    try {
      const req = {
        model: "auto",
        messages: [
          { role: "system", content: "Return minified JSON only with implementable invariants." },
          { role: "assistant", content: "Prior evidence: repeated read/edit cycles, provider health conflicts, tool-call translation risks, duplicated benchmark evidence, and stale patch failures." },
          { role: "user", content: "Deep research hard bug: design a concurrency-safe router for a local LLM proxy. It must handle Claude Code tool calls, Windsurf compatibility quirks, provider cooldowns, stale edit recovery, streaming/non-streaming normalization, deduplicated long-context history, and cost-aware fallback without creating oscillation or hiding correctness regressions." },
        ],
        max_tokens: 420,
        _inputTokens: 810000,
        _estimatedTokens: 810420,
      };
      const providers = routing.getProvidersForAuto(req.messages, req._estimatedTokens, req);

      assert.equal(providers[0].name, "Windsurf-ClaudeOpus461M");
    } finally {
      state.PROVIDERS = originalProviders;
    }
  });
});
