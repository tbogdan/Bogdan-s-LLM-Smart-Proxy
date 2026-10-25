"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const adapter = require("../lib/anthropic-adapter");
const gateway = require("../lib/anthropic-gateway");

test("buildHeaders merges client betas with env betas, deduped and capped", () => {
  const provider = { key: "k", url: "https://api.anthropic.com/v1/messages" };
  const headers = adapter.buildHeaders(provider, {
    env: {},
    clientBetas: ["b-one", "b-two", "b-one", "not a beta!!", "x".repeat(200)],
  });
  assert.equal(headers["anthropic-beta"], "b-one,b-two");
});

test("buildHeaders works without client betas", () => {
  const provider = { key: "k", url: "https://api.anthropic.com/v1/messages" };
  const headers = adapter.buildHeaders(provider, { env: {} });
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers.Authorization, "Bearer k");
});

test("clientBetasFromHeaders parses and sanitizes", () => {
  assert.deepEqual(
    gateway.clientBetasFromHeaders({ "anthropic-beta": "a-1, b_2 ,a-1, bad beta!, " }),
    ["a-1", "b_2"],
  );
  assert.deepEqual(gateway.clientBetasFromHeaders({}), []);
  assert.deepEqual(gateway.clientBetasFromHeaders({ "anthropic-beta": ["x", "x", 42] }), ["x", "42"]);
});
