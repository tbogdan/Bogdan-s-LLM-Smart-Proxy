"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const mediaContent = require("../lib/media-content");

test("toOpenAIChatContent normalizes Anthropic, Responses, and OpenAI image parts", () => {
  const content = mediaContent.toOpenAIChatContent([
    { type: "input_text", text: "Compare screenshots." },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa=" } },
    { type: "input_image", image_url: "https://example.test/one.png" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,bbb=", detail: "high" } },
  ]);

  assert.deepEqual(content, [
    { type: "text", text: "Compare screenshots." },
    { type: "image_url", image_url: { url: "data:image/png;base64,aaa=" } },
    { type: "image_url", image_url: { url: "https://example.test/one.png" } },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,bbb=", detail: "high" } },
  ]);
});

test("toOpenAIChatContent keeps unsupported image references visible instead of dropping them", () => {
  const content = mediaContent.toOpenAIChatContent([
    { type: "input_text", text: "Use attached file." },
    { type: "input_image", file_id: "file_123" },
  ]);

  assert.equal(content, "Use attached file.\n[image omitted: unsupported file_id file_123]");
});

test("toAnthropicContent converts OpenAI image_url parts to Anthropic image blocks", () => {
  assert.deepEqual(mediaContent.toAnthropicContent([
    { type: "text", text: "Review screenshot." },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } },
  ]), [
    { type: "text", text: "Review screenshot." },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "/9j/4AAQSkZJRg==",
      },
    },
  ]);

  assert.deepEqual(mediaContent.toAnthropicContent([
    { type: "text", text: "Review remote screenshot." },
    { type: "image_url", image_url: { url: "https://example.test/screenshot.png" } },
  ]), [
    { type: "text", text: "Review remote screenshot." },
    { type: "image", source: { type: "url", url: "https://example.test/screenshot.png" } },
  ]);
});

test("providerSupportsImageInput excludes native Windsurf until its adapter encodes media", () => {
  assert.equal(mediaContent.providerSupportsImageInput({ protocol: "windsurf", caps: ["text", "images"] }), false);
  assert.equal(mediaContent.providerSupportsImageInput({ protocol: "openai", caps: ["text", "images"] }), true);
  assert.equal(mediaContent.providerSupportsImageInput({ protocol: "codex", caps: ["text", "images"] }), true);
  assert.equal(mediaContent.providerSupportsImageInput({ protocol: "anthropic", caps: ["text", "images"] }), true);
  assert.equal(mediaContent.providerSupportsImageInput({ protocol: "openai", caps: ["text"] }), false);
});

test("messagesHaveDataImages detects data URL images across normalized content shapes", () => {
  assert.equal(mediaContent.messagesHaveDataImages([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aaa=" } }] },
  ]), true);
  assert.equal(mediaContent.messagesHaveDataImages([
    { role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] },
  ]), false);
});
