"use strict";

/**
 * transform-coverage.test.js
 *
 * Proves the two OpenAI Chat pivot boundaries:
 *   1. Responses API (Codex / input_text / input_image) → OpenAI Chat
 *   2. Anthropic Messages (Windsurf / image blocks) → OpenAI Chat
 *
 * Also proves the chained path:
 *   Anthropic translateRequest → transforms.transformRequest for Windsurf provider
 *
 * No new wire logic is introduced.  Tests verify that the existing
 * mediaContent helpers and transformRequest already handle these shapes
 * correctly, closing the test coverage gap from TRANSLATION_GAP_ANALYSIS.md
 * GAP 6 (cross-provider request shape translation coverage).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const coverage = require("../lib/transform-coverage");
const gateway = require("../lib/anthropic-gateway");
const transforms = require("../lib/transforms");

// ---------------------------------------------------------------------------
// Shared provider fixtures
// ---------------------------------------------------------------------------

const CODEX_PROVIDER = {
  name: "Codex-Test",
  model: "gpt-5.3-codex",
  url: "http://codex.local/v1/chat/completions",
  key: "test",
  caps: ["tools", "coding", "images"],
  context: 200000,
  tier: 1,
};

const WINDSURF_PROVIDER = {
  name: "Windsurf-Test",
  model: "windsurf/google-gemini-2-5-pro",
  protocol: "windsurf",
  family: "windsurf",
  key: "test",
  caps: ["tools", "coding"],
  context: 1048576,
  tier: 1,
};

const ANTHROPIC_PROVIDER = {
  name: "Claude-Test",
  model: "claude/claude-sonnet-4-5-20250929",
  protocol: "anthropic",
  family: "claude",
  key: "test",
  caps: ["tools", "coding", "images"],
  context: 200000,
  tier: 1,
};

// ---------------------------------------------------------------------------
// 1. Responses API content shape → OpenAI Chat pivot (transform-coverage helpers)
// ---------------------------------------------------------------------------

test("responsesContentPartToOpenAIChat normalizes input_text to text part", () => {
  const result = coverage.responsesContentPartToOpenAIChat({ type: "input_text", text: "Hello from Codex." });
  assert.deepEqual(result, { type: "text", text: "Hello from Codex." });
});

test("responsesContentPartToOpenAIChat normalizes input_image with data URL to image_url part", () => {
  const result = coverage.responsesContentPartToOpenAIChat({
    type: "input_image",
    image_url: "data:image/png;base64,iVBORw0KGgo=",
  });
  assert.ok(result, "expected non-null result");
  assert.equal(result.type, "image_url");
  assert.equal(result.image_url?.url, "data:image/png;base64,iVBORw0KGgo=");
});

test("responsesContentPartToOpenAIChat normalizes output_text to text part", () => {
  const result = coverage.responsesContentPartToOpenAIChat({ type: "output_text", text: "Response text." });
  assert.deepEqual(result, { type: "text", text: "Response text." });
});

test("responsesContentPartToOpenAIChat returns null for unrecognised type", () => {
  const result = coverage.responsesContentPartToOpenAIChat({ type: "thinking", thinking: "private" });
  assert.equal(result, null);
});

test("responsesContentArrayToOpenAIChat converts mixed input_text/input_image to OpenAI string when no images", () => {
  const result = coverage.responsesContentArrayToOpenAIChat([
    { type: "input_text", text: "What is in this image?" },
  ]);
  // text-only → collapsed to string
  assert.equal(typeof result, "string");
  assert.match(result, /What is in this image/);
});

test("responsesContentArrayToOpenAIChat converts input_text + input_image to OpenAI Chat array", () => {
  const result = coverage.responsesContentArrayToOpenAIChat([
    { type: "input_text", text: "Describe this." },
    { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
  ]);
  assert.ok(Array.isArray(result), "expected array output when images are present");
  const textPart = result.find((p) => p.type === "text");
  const imagePart = result.find((p) => p.type === "image_url");
  assert.ok(textPart, "expected text part");
  assert.equal(textPart.text, "Describe this.");
  assert.ok(imagePart, "expected image_url part");
  assert.equal(imagePart.image_url?.url, "data:image/png;base64,iVBORw0KGgo=");
});

// ---------------------------------------------------------------------------
// 2. Anthropic image block → OpenAI Chat pivot (transform-coverage helpers)
// ---------------------------------------------------------------------------

test("anthropicImageBlockToOpenAIChat converts base64 source to image_url part", () => {
  const result = coverage.anthropicImageBlockToOpenAIChat({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: "/9j/4AAQ==",
    },
  });
  assert.ok(result, "expected non-null result");
  assert.equal(result.type, "image_url");
  assert.match(result.image_url?.url, /^data:image\/jpeg;base64,/);
});

test("anthropicImageBlockToOpenAIChat converts URL source to image_url part", () => {
  const result = coverage.anthropicImageBlockToOpenAIChat({
    type: "image",
    source: {
      type: "url",
      url: "https://example.com/screenshot.png",
    },
  });
  assert.ok(result, "expected non-null result");
  assert.equal(result.type, "image_url");
  assert.equal(result.image_url?.url, "https://example.com/screenshot.png");
});

// ---------------------------------------------------------------------------
// 3. translateRequest: Responses-style input_text / input_image in user messages
//    (Anthropic gateway → OpenAI Chat pivot boundary proof)
// ---------------------------------------------------------------------------

test("translateRequest normalizes Responses input_text parts in user messages to text", () => {
  const translated = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Run the tests." },
        ],
      },
    ],
  });

  assert.equal(translated.messages.length, 1);
  const userMsg = translated.messages[0];
  assert.equal(userMsg.role, "user");
  // text-only arrays collapse to string
  assert.equal(typeof userMsg.content, "string");
  assert.match(userMsg.content, /Run the tests/);
});

test("translateRequest normalizes Responses input_image + input_text to OpenAI image_url array", () => {
  const translated = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What do you see?" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      },
    ],
  });

  assert.equal(translated.messages.length, 1);
  const userMsg = translated.messages[0];
  assert.equal(userMsg.role, "user");
  assert.ok(Array.isArray(userMsg.content), "expected array when images present");
  const textPart = userMsg.content.find((p) => p.type === "text");
  const imagePart = userMsg.content.find((p) => p.type === "image_url");
  assert.ok(textPart, "expected text part");
  assert.equal(textPart.text, "What do you see?");
  assert.ok(imagePart, "expected image_url part");
  assert.equal(imagePart.image_url?.url, "data:image/png;base64,iVBORw0KGgo=");
});

test("translateRequest normalizes Anthropic image source blocks to OpenAI image_url in system chain", () => {
  // Windsurf routing: Anthropic Messages with image blocks → translate → OpenAI Chat
  const translated = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    system: "You are a visual assistant.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe the screenshot." },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      },
    ],
  });

  assert.equal(translated.messages[0].role, "system");
  const userMsg = translated.messages[1];
  assert.equal(userMsg.role, "user");
  assert.ok(Array.isArray(userMsg.content));
  const imagePart = userMsg.content.find((p) => p.type === "image_url");
  assert.ok(imagePart, "expected image_url part from Anthropic image block");
  assert.equal(imagePart.image_url?.url, "data:image/png;base64,iVBORw0KGgo=");
});

// ---------------------------------------------------------------------------
// 4. transformRequest: Responses-style content through the OpenAI Chat pivot
//    for Windsurf provider (verifies flattenToolHistory + content normalisation chain)
// ---------------------------------------------------------------------------

test("transformRequest normalizes input_text content parts for Windsurf provider", async () => {
  const transformed = await transforms.transformRequest(WINDSURF_PROVIDER, {
    model: "auto-coding",
    _llmProxyBypassOptimizations: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Run the tests and report failures." },
        ],
      },
    ],
  });

  assert.equal(transformed.messages.length, 1);
  const userMsg = transformed.messages[0];
  assert.equal(userMsg.role, "user");
  // Windsurf provider does not have images cap set; text-only collapses to string
  assert.equal(typeof userMsg.content, "string");
  assert.match(userMsg.content, /Run the tests/);
});

test("transformRequest normalizes input_text + input_image content for image-capable Codex provider", async () => {
  const transformed = await transforms.transformRequest(CODEX_PROVIDER, {
    model: "auto-coding",
    _llmProxyBypassOptimizations: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe the chart." },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      },
    ],
  });

  assert.equal(transformed.messages.length, 1);
  const userMsg = transformed.messages[0];
  assert.equal(userMsg.role, "user");
  assert.ok(Array.isArray(userMsg.content), "expected array for image-capable provider");
  const textPart = userMsg.content.find((p) => p.type === "text");
  const imagePart = userMsg.content.find((p) => p.type === "image_url");
  assert.ok(textPart, "expected text part");
  assert.equal(textPart.text, "Describe the chart.");
  assert.ok(imagePart, "expected image_url part");
  assert.equal(imagePart.image_url?.url, "data:image/png;base64,iVBORw0KGgo=");
});

// ---------------------------------------------------------------------------
// 5. Chained pivot: translateRequest (Anthropic → Chat) → transformRequest (→ Windsurf)
//    Proves that the Windsurf↔Anthropic path via the OpenAI Chat pivot is end-to-end sound
// ---------------------------------------------------------------------------

test("Anthropic Messages → translateRequest → transformRequest chain normalizes content for Windsurf provider", async () => {
  // Step 1: Anthropic Messages format (as received by anthropic-gateway)
  const chatReq = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    system: "You are a Windsurf coding assistant.",
    messages: [
      { role: "user", content: "Fix the failing test." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read the test file." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "test.js" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "const x = fail();" },
        ],
      },
    ],
    tools: [{ name: "Read", description: "Read file", input_schema: { type: "object" } }],
  });

  assert.ok(chatReq.messages.length >= 3, "translated to chat messages");

  // Step 2: route through transformRequest for a Windsurf provider.
  // For small tool histories (< threshold of 12) and no compaction flag,
  // Windsurf flattening is NOT triggered; the OpenAI Chat pivot structure is preserved.
  // The key boundary proven here is that the content round-trips cleanly.
  const transformed = await transforms.transformRequest(WINDSURF_PROVIDER, {
    ...chatReq,
    _llmProxyBypassOptimizations: true,
  });

  // System message should be present (prepended or merged into first user)
  const hasSystemContent = transformed.messages.some((m) =>
    m.role === "system" || (m.role === "user" && /Windsurf coding assistant/i.test(String(m.content))));
  assert.ok(hasSystemContent, "system instructions preserved after pivot chain");

  // Tool call history should survive the OpenAI Chat pivot intact for small histories
  const toolMsg = transformed.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "small tool history preserved through Windsurf pivot (below flatten threshold)");
  assert.match(String(toolMsg.content), /const x = fail/);
});

test("Anthropic Messages → translateRequest → transformRequest flattens tool history for Windsurf when compaction flagged", async () => {
  // With _llmProxyCompactedContext flag, flattenToolHistoryForProvider triggers for Windsurf.
  // We call flattenToolHistoryForProvider directly because transformRequest guards it behind
  // the bypassOptimizations flag (which test isolation requires for other assertions).
  // This test proves the boundary contract: the function is designed to flatten exactly
  // when compactedContextFlag is true for Windsurf providers.
  const chatReq = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    system: "You are a Windsurf coding assistant.",
    messages: [
      { role: "user", content: "Fix the failing test." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read the test file." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "test.js" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "const x = fail();" },
        ],
      },
    ],
    tools: [{ name: "Read", description: "Read file", input_schema: { type: "object" } }],
  });

  // Verify the translated body has the expected OpenAI Chat structure before flatten
  assert.ok(chatReq.messages.some((m) => m.role === "tool"), "tool role present before flatten");
  assert.ok(chatReq.messages.some((m) => m.role === "assistant" && m.tool_calls?.length > 0),
    "assistant tool_calls present before flatten");

  // Apply the flatten boundary directly (same as transformRequest does for !bypassOptimizations)
  // The body needs _llmProxyCompactedContext to trigger flatten for small histories
  // Import flattenToolHistoryForProvider by running transformRequest without bypass
  // but with an isolated copy to avoid side effects on chatReq
  const transformed = await transforms.transformRequest(WINDSURF_PROVIDER, {
    ...chatReq,
    _llmProxyCompactedContext: true,
    _llmProxyInternalSummary: true, // suppresses prompt injection without bypassing flatten
  });

  // Tool history should be flattened for Windsurf when compaction flag is present
  assert.equal(transformed.messages.some((m) => m.role === "tool"), false,
    "Windsurf provider: tool role messages flattened when compaction flag set");
  assert.equal(transformed.messages.some((m) => m.tool_calls?.length > 0), false,
    "Windsurf provider: assistant tool_calls flattened when compaction flag set");

  // Content should appear as historical tool text in user or assistant messages
  const serialized = JSON.stringify(transformed.messages);
  assert.match(serialized, /Historical tool/i, "tool history converted to historical text");
});

test("Anthropic Messages → translateRequest → transformRequest chain normalizes image content for Windsurf", async () => {
  // Anthropic image blocks should survive both pivots
  const chatReq = gateway.translateRequest({
    model: "claude-sonnet-4-5-20250929",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this screenshot." },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      },
    ],
  });

  // Windsurf provider without images cap — images should be flattened to placeholder text
  const windsurfNoImages = { ...WINDSURF_PROVIDER, caps: ["tools", "coding"] };
  const transformed = await transforms.transformRequest(windsurfNoImages, {
    ...chatReq,
    _llmProxyBypassOptimizations: true,
  });

  const serialized = JSON.stringify(transformed.messages);
  // Images are unsupported for windsurf protocol → flattened to placeholder
  assert.doesNotMatch(serialized, /image_url|data:image/,
    "Windsurf provider: image_url stripped for non-image-capable provider");
  assert.match(serialized, /Look at this screenshot|image omitted/,
    "text content or image placeholder preserved");
});

// ---------------------------------------------------------------------------
// 6. Responses API → OpenAI Chat pivot boundary: tool_call round-trip
//    Proves that function_call items from Responses format survive the chat pivot
// ---------------------------------------------------------------------------

test("transformRequest preserves function_call tool history from Responses API pivot through Anthropic provider", async () => {
  // After responses.js translates Responses → Chat, we get standard OpenAI tool messages
  // This tests that transformRequest for an Anthropic-family provider preserves that history
  const transformed = await transforms.transformRequest(ANTHROPIC_PROVIDER, {
    model: "auto-coding",
    _llmProxyBypassOptimizations: true,
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Run the build." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_abc123de5", type: "function", function: { name: "exec_command", arguments: '{"cmd":"npm run build"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_abc123de5", name: "exec_command", content: "Build succeeded." },
      { role: "user", content: "Good, now run tests." },
    ],
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" } } } } }],
  });

  // Anthropic-family provider: tool history should NOT be flattened
  assert.ok(transformed.messages.some((m) => m.role === "tool"),
    "Anthropic provider: tool role messages preserved");
  assert.ok(transformed.messages.some((m) => m.role === "assistant" && m.tool_calls?.length > 0),
    "Anthropic provider: assistant tool_calls preserved");
});
