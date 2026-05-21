"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const gateway = require("../lib/anthropic-gateway");

class FakeResponse {
  constructor() {
    this.status = null;
    this.headers = null;
    this.chunks = [];
    this.ended = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    this.ended = true;
  }
}

class StrictFakeResponse extends FakeResponse {
  writeHead(status, headers) {
    if (this.headers) {
      const err = new Error("Cannot write headers after they are sent to the client");
      err.code = "ERR_HTTP_HEADERS_SENT";
      throw err;
    }
    super.writeHead(status, headers);
  }
}

test("translateRequest maps Anthropic Messages requests to OpenAI chat requests", () => {
  const translated = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    system: "Use the repository rules.",
    max_tokens: 1234,
    messages: [
      { role: "user", content: "Edit the file." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect it." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.js" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "const a = 1;" },
          { type: "text", text: "Now patch it." },
        ],
      },
    ],
    tools: [{ name: "Read", description: "Read file", input_schema: { type: "object" } }],
  });

  assert.equal(translated.model, "auto-coding");
  assert.equal(translated.max_tokens, 1234);
  assert.deepEqual(translated.messages[0], { role: "system", content: "Use the repository rules." });
  assert.equal(translated.messages[2].role, "assistant");
  assert.equal(translated.messages[2].tool_calls[0].function.name, "Read");
  assert.equal(translated.messages[3].role, "tool");
  assert.equal(translated.messages[3].tool_call_id, "toolu_1");
  assert.equal(translated.messages[4].content, "Now patch it.");
  assert.equal(translated.tools[0].function.name, "Read");
});

test("toAnthropicResponse maps OpenAI chat response to Anthropic message", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Done.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Edit", arguments: "{\"file_path\":\"a.js\"}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, "auto-coding");

  assert.equal(response.type, "message");
  assert.equal(response.role, "assistant");
  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[1].type, "tool_use");
  assert.equal(response.content[1].name, "Edit");
  assert.deepEqual(response.content[1].input, { file_path: "a.js" });
});

test("toAnthropicResponse preserves OpenAI text content parts", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Project " },
            { type: "text", text: "LLM Smart Proxy." },
          ],
        },
        finish_reason: "stop",
      },
    ],
  }, "auto-coding");

  assert.deepEqual(response.content, [
    { type: "text", text: "Project \nLLM Smart Proxy." },
  ]);
});

test("toAnthropicResponse suppresses generated tool_use missing required input", () => {
  const response = gateway.toAnthropicResponse({
    model: "auto-coding",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }, "auto-coding", [
    { name: "Bash", input_schema: { type: "object", required: ["command"] } },
  ]);

  assert.equal(response.stop_reason, "end_turn");
  assert.equal(response.content.some((part) => part.type === "tool_use"), false);
  assert.equal(/invalid tool call/i.test(response.content.map((part) => part.text || "").join("\n")), false);
});

test("streaming Anthropic bridge suppresses generated tool_use missing required input", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "run pwd" }],
    tools: [{ name: "Bash", input_schema: { type: "object", required: ["command"] } }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal(body.includes('"type":"tool_use"'), false);
  assert.equal(/invalid tool call/i.test(body), false);
});

test("streaming Anthropic bridge keeps invalid tool diagnostics out of IDE-visible text", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "run pwd" }],
    tools: [{ name: "Bash", input_schema: { type: "object", required: ["command"] } }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal(body.includes('"type":"tool_use"'), false);
  assert.equal(/invalid tool call/i.test(body), false);
});

test("streaming Anthropic bridge ignores duplicate routed writeHead calls", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done" }, finish_reason: null }],
      })}\n\n`);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new StrictFakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal(res.ended, true);
  assert.match(body, /message_start/);
  assert.match(body, /text_delta/);
  assert.match(body, /message_stop/);
});

test("streaming Anthropic bridge preserves output usage from OpenAI final chunks", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /"usage":\{"output_tokens":4\}/);
});

test("streaming Anthropic bridge waits for post-stop OpenAI usage chunk", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "Done" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "say done" }],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.match(body, /"usage":\{"output_tokens":4\}/);
});

test("streaming Anthropic bridge keeps multiple unindexed tool calls separate", async () => {
  gateway.init({
    handleChatCompletion: async (_chatReq, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end();
    },
  });

  const res = new FakeResponse();
  await gateway.handleMessagesHTTP({}, res, JSON.stringify({
    model: "auto-coding",
    stream: true,
    messages: [{ role: "user", content: "inspect repo" }],
    tools: [
      { name: "Read", input_schema: { type: "object", required: ["file_path"] } },
      { name: "Bash", input_schema: { type: "object", required: ["command"] } },
    ],
  }));

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal((body.match(/"type":"tool_use"/g) || []).length, 2);
  assert.match(body, /"name":"Read"/);
  assert.match(body, /"name":"Bash"/);
  assert.equal(/invalid tool call/i.test(body), false);
});
