"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const scoring = require("../lib/scoring");
const state = require("../lib/state");

function withIsolatedScoring(fn) {
  const originalScores = state.scores;
  const originalTracker = state.stallingTracker;
  const originalWriteFileSync = fs.writeFileSync;
  state.scores = {};
  state.stallingTracker = {};
  fs.writeFileSync = () => {};
  try {
    fn();
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    state.scores = originalScores;
    state.stallingTracker = originalTracker;
  }
}

test("setCooldown records the reason used by routing diagnostics", () => {
  withIsolatedScoring(() => {
    scoring.setCooldown("Codex-Test", 60_000, "usage limit reached");

    assert.equal(scoring.getScore("Codex-Test").cooldown_reason, "usage limit reached");
  });
});

test("recordStalling cools providers only after three stalls in five minutes", () => {
  withIsolatedScoring(() => {
    scoring.recordStalling("Windsurf-Test");
    scoring.recordStalling("Windsurf-Test");

    assert.equal(scoring.isOnCooldown("Windsurf-Test"), false);

    scoring.recordStalling("Windsurf-Test");

    assert.equal(scoring.isOnCooldown("Windsurf-Test"), true);
  });
});

test("recordStalling renews cooldown immediately for providers with chronic stalling history", () => {
  withIsolatedScoring(() => {
    const provider = "Chronic-Staller";
    state.scores[provider] = {
      requests: 10,
      successes: 8,
      failures: 2,
      success_rate: 0.8,
      stalling: 5,
      last_stall_time: Date.now() - 10 * 60_000,
      cooldown_until: Date.now() - 1000,
    };
    state.stallingTracker[provider] = [];

    scoring.recordStalling(provider);

    assert.equal(scoring.isOnCooldown(provider), true);
  });
});

test("detectIncompatibility cools Windsurf invalid_argument internal errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Windsurf-ClaudeSonnet46Thinking",
      500,
      '{"error":{"code":"invalid_argument","message":"an internal error occurred"}}',
    );

    const score = scoring.getScore("Windsurf-ClaudeSonnet46Thinking");
    assert.equal(scoring.isOnCooldown("Windsurf-ClaudeSonnet46Thinking"), true);
    assert.equal(score.cooldown_reason, "windsurf invalid_argument");
  });
});

test("detectIncompatibility cools Windsurf permission_denied internal errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Windsurf-ClaudeOpus461M",
      500,
      '{"error":{"code":"permission_denied","message":"an internal error occurred"}}',
    );

    const score = scoring.getScore("Windsurf-ClaudeOpus461M");
    assert.equal(scoring.isOnCooldown("Windsurf-ClaudeOpus461M"), true);
    assert.equal(score.cooldown_reason, "windsurf permission_denied");
  });
});

test("generic Anthropic rate_limit_error is treated as temporary rate limit", () => {
  assert.equal(
    scoring.isTemporaryRateLimit(
      429,
      '{"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_test"}',
    ),
    true,
  );
});

test("providerScore applies decaying stalling penalty", () => {
  withIsolatedScoring(() => {
    const provider = { name: "Claude-Test", tier: 1 };
    const score = scoring.getScore(provider.name);
    score.requests = 10;
    score.successes = 10;
    score.success_rate = 1;
    score.avg_latency = 0;
    score.stalling = 4;
    score.last_stall_time = Date.now() - 2 * 3600_000;

    const decayed = scoring.providerScore(provider);

    assert.ok(decayed > 1.2);
    assert.ok(decayed < 1.4);
  });
});

test("providerScore applies decaying tool-invalid penalty", () => {
  withIsolatedScoring(() => {
    const reliable = { name: "Reliable-Tools", tier: 1 };
    const flaky = { name: "Flaky-Tools", tier: 1 };
    state.scores[reliable.name] = {
      requests: 10,
      successes: 10,
      failures: 0,
      success_rate: 1,
      avg_latency: 0,
    };
    state.scores[flaky.name] = {
      requests: 10,
      successes: 10,
      failures: 0,
      success_rate: 1,
      avg_latency: 0,
      tool_invalid: 3,
      last_tool_invalid_time: Date.now() - 60_000,
    };

    assert.equal(scoring.providerScore(reliable) > scoring.providerScore(flaky), true);
  });
});
