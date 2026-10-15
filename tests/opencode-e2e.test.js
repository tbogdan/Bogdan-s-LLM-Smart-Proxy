const test = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", r));
test(
  "running proxy routes all OpenCode wire formats through HTTP and streaming with task identity",
  { timeout: 20000 },
  async () => {
    const seen = [];
    const upstream = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      seen.push({ url: req.url, headers: req.headers, body });
      const proto = req.url.split("/")[1];
      const streaming =
        body.stream || req.url.includes("streamGenerateContent");
      const tokens = {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
      };
      const data =
        proto === "responses"
          ? {
              id: "resp_fixture",
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "Cache preserved." }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 3 },
            }
          : proto === "anthropic"
            ? {
                id: "msg_fixture",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Cache preserved." }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 3 },
              }
            : proto === "gemini"
              ? {
                  candidates: [
                    {
                      content: { parts: [{ text: "Cache preserved." }] },
                      finishReason: "STOP",
                    },
                  ],
                  usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 3,
                    totalTokenCount: 13,
                  },
                }
              : {
                  id: "chat_fixture",
                  model: "fixture",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "Cache preserved.",
                      },
                      finish_reason: "stop",
                    },
                  ],
                  usage: tokens,
                };
      if (!streaming) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const events =
        proto === "responses"
          ? [
              { type: "response.output_text.delta", delta: "Cache preserved." },
              {
                type: "response.completed",
                response: { status: "completed", usage: data.usage },
              },
            ]
          : proto === "anthropic"
            ? [
                {
                  type: "message_start",
                  message: { usage: { input_tokens: 10 } },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Cache preserved." },
                },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 3 },
                },
                { type: "message_stop" },
              ]
            : proto === "gemini"
              ? [data]
              : [
                  {
                    choices: [
                      {
                        index: 0,
                        delta: { content: "Cache preserved." },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: tokens,
                  },
                ];
      for (const e of events) res.write("data: " + JSON.stringify(e) + "\n\n");
      if (proto === "openai") res.write("data: [DONE]\n\n");
      res.end();
    });
    await listen(upstream);
    const allocator = http.createServer();
    await listen(allocator);
    const port = allocator.address().port;
    await new Promise((r) => allocator.close(r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-e2e-"));
    let child,
      logs = "";
    const providers = ["openai", "responses", "anthropic", "gemini"].map(
      (protocol) => ({
        name: "OpenCode-" + protocol,
        family: "opencode",
        protocol,
        model: "opencode/fixture-" + protocol,
        upstream_model: "fixture-" + protocol,
        key_env: "FIXTURE_KEY",
        url:
          "http://127.0.0.1:" +
          upstream.address().port +
          "/" +
          protocol +
          (protocol === "gemini"
            ? "/models/fixture:generateContent"
            : "/request"),
        context: 100000,
        caps: ["text", "tools"],
        tier: 2,
        alive: true,
      }),
    );
    const blocked = {
      ...providers[0],
      name: "OpenCode-native-free",
      model: "opencode/free-fixture",
      alive: false,
      access_policy: "native_client_only",
      billing_class: "free_limited",
    };
    fs.writeFileSync(
      path.join(dir, "providers.json"),
      JSON.stringify({ providers: [...providers, blocked] }),
    );
    try {
      child = spawn(process.execPath, ["llm-proxy.js"], {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          DATA_DIR: dir,
          LLM_PROXY_PORT: String(port),
          FIXTURE_KEY: "fixture-key",
          MEMORY_ENABLED: "false",
          DEV_MODE: "false",
          LLM_PROXY_PROBE_ENABLED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (b) => (logs += b));
      child.stderr.on("data", (b) => (logs += b));
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          ready = (await fetch("http://127.0.0.1:" + port + "/health")).ok;
          if (ready) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(ready, logs);
      for (const p of providers) {
        const headers = {
          "content-type": "application/json",
          "x-llm-proxy-task-id": p.protocol,
          "x-llm-proxy-client-id": "gateway-e2e",
        };
        for (const stream of [false, true]) {
          const r = await fetch(
            "http://127.0.0.1:" + port + "/v1/chat/completions",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: p.model,
                messages: [{ role: "user", content: "Reply briefly." }],
                max_tokens: 64,
                stream,
              }),
              signal: AbortSignal.timeout(5000),
            },
          );
          const raw = await r.text();
          assert.equal(r.status, 200, raw + "\n" + logs);
          assert.equal(r.headers.get("x-llm-model"), p.model);
          assert.match(raw, /Cache preserved/);
          if (stream) assert.match(raw, /\[DONE\]/);
        }
        const calls = seen.filter((c) =>
          c.url.startsWith("/" + p.protocol + "/"),
        );
        assert.equal(calls.length, 2);
        assert.equal(
          calls[0].headers["x-opencode-session"],
          calls[1].headers["x-opencode-session"],
        );
        assert.ok(calls[0].headers["x-opencode-session"]);
        assert.equal(calls[0].headers.authorization, "Bearer fixture-key");
      }
      // Streaming closes the HTTP response before asynchronous usage persistence.
      // Wait for the observable state, including under full-suite CPU contention.
      const deadline = Date.now() + 5000;
      let records;
      do {
        records = fs
          .readdirSync(path.join(dir, "tasks"))
          .filter((f) => f.endsWith(".json"))
          .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "tasks", f))));
        if (records.length === 4 && records.every((record) =>
          record.usage?.observedDispatches === 2)) break;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 25));
      } while (true);
      assert.equal(records.length, 4);
      for (const record of records) {
        assert.equal(record.usage.observedDispatches, 2);
        assert.equal(record.usage.unknownUsageDispatches, 0);
        assert.equal(record.usage.inputTokens, 20);
        assert.equal(record.usage.outputTokens, 6);
      }
      assert.equal(
        new Set(seen.map((c) => c.headers["x-opencode-session"])).size,
        4,
      );
      assert.ok(
        seen.every((c) => !JSON.stringify(c.body).includes("_llmProxy")),
      );
      const before = seen.length;
      const denied = await fetch(
        "http://127.0.0.1:" + port + "/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "opencode/free-fixture",
            messages: [{ role: "user", content: "hello" }],
            max_tokens: 32,
          }),
        },
      );
      const denial = await denied.json();
      assert.equal(denied.status, 403);
      assert.equal(denial.error.code, "OPENCODE_NATIVE_CLIENT_ONLY");
      assert.equal(
        seen.length,
        before,
        "blocked free request must not silently spend on a paid fallback",
      );
    } finally {
      if (child && child.exitCode === null)
        await new Promise((r) => {
          child.once("exit", r);
          child.kill("SIGTERM");
        });
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
