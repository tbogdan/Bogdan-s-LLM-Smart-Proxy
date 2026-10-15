const test = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawn } = require("node:child_process");
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", r));
test(
  "actual proxy HTTP keeps a task model and new task selects independently",
  { timeout: 15000 },
  async () => {
    let depleted = false;
    let denied = false;
    const calls = [];
    const upstream = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.push(body);
      if (denied) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "permission_denied", message: "Forbidden" },
          }),
        );
        return;
      }
      if (depleted && body.model === "gpt-test") {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "3600",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "insufficient_quota",
              message: "Insufficient credits",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A useful answer." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      );
    });
    await listen(upstream);
    const portServer = http.createServer();
    await listen(portServer);
    const port = portServer.address().port;
    await new Promise((r) => portServer.close(r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-http-"));
    const providers = ["gpt-test", "gpt-other"].map((m, i) => ({
      name: "Fixture-" + i,
      family: "openai",
      protocol: "openai",
      model: "openai/" + m,
      upstream_model: m,
      url:
        "http://127.0.0.1:" + upstream.address().port + "/v1/chat/completions",
      key_env: "FIXTURE_KEY_" + i,
      caps: ["text", "tools"],
      context: 131072,
      tier: 2,
      alive: true,
    }));
    fs.writeFileSync(
      path.join(dir, "providers.json"),
      JSON.stringify({ providers, groups: { "auto-text": "text" } }),
    );
    const child = spawn(process.execPath, ["llm-proxy.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        DATA_DIR: dir,
        LLM_PROXY_PORT: String(port),
        FIXTURE_KEY_0: "fixture",
        FIXTURE_KEY_1: "other-fixture",
        MEMORY_ENABLED: "false",
        DEV_MODE: "false",
        LLM_PROXY_PROBE_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (x) => {
      log += x;
    });
    child.stderr.on("data", (x) => {
      log += x;
    });
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          const r = await fetch("http://127.0.0.1:" + port + "/health");
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(ready, log);
      const send = async (task, model) => {
        const r = await fetch(
          "http://127.0.0.1:" + port + "/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-LLM-Proxy-Task-ID": task,
              "X-LLM-Proxy-Client-ID": "integration",
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "user",
                  content: "Explain cache reuse in one sentence.",
                },
              ],
              max_tokens: 100,
            }),
          },
        );
        const b = await r.json();
        assert.equal(r.status, 200, JSON.stringify(b) + "\n" + log);
        return b;
      };
      await send("same", "openai/gpt-test");
      await send("same", "openai/gpt-other");
      await send("new", "openai/gpt-other");
      assert.deepEqual(
        calls.map((c) => c.model),
        ["gpt-test", "gpt-test", "gpt-other"],
      );
      assert.ok(
        calls.every(
          (c) => !Object.keys(c).some((k) => k.startsWith("_llmProxyTask")),
        ),
      );
      denied = true;
      const beforeDenied = calls.length;
      const forbidden = await fetch(
        "http://127.0.0.1:" + port + "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-LLM-Proxy-Task-ID": "denied",
            "X-LLM-Proxy-Client-ID": "integration",
          },
          body: JSON.stringify({
            model: "auto-text",
            messages: [{ role: "user", content: "Say hello." }],
            max_tokens: 32,
          }),
        },
      );
      assert.equal(forbidden.status, 403, await forbidden.text());
      assert.equal(calls.length - beforeDenied, 1);
      denied = false;
      depleted = true;
      await send("same", "openai/gpt-test");
      assert.equal(calls.at(-1).model, "gpt-other");
      assert.equal(calls.filter((c) => c.model === "gpt-test").length, 3);
      const d = await (
        await fetch("http://127.0.0.1:" + port + "/v1/orchestration")
      ).json();
      assert.equal(d.stats.dispatches, 6);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
    }
  },
);
