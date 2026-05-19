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

