"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const scoring = require("../lib/scoring");
const state = require("../lib/state");

function withIsolatedScoring(fn) {
  const originalScores = state.scores;
  const originalTracker = state.stallingTracker;
  const originalCompat = state.providerCompat;
  const originalWriteFileSync = fs.writeFileSync;
  state.scores = {};
  state.stallingTracker = {};
  state.providerCompat = {};
  fs.writeFileSync = () => {};
  try {
    fn();
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    state.scores = originalScores;
    state.stallingTracker = originalTracker;
    state.providerCompat = originalCompat;
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

test("recordSuccess clears stale cooldown and stalling state", () => {
  withIsolatedScoring(() => {
    const provider = "Recovered-Provider";
    state.scores[provider] = {
      requests: 4,
      successes: 1,
      failures: 3,
      total_latency: 500,
      avg_latency: 500,
      success_rate: 0.25,
      last_error: { message: "garbled output", time: Date.now() },
      cooldown_until: Date.now() + 3600_000,
      cooldown_reason: "garbled output",
      stalling: 4,
      last_stall_time: Date.now(),
    };
    state.stallingTracker[provider] = [Date.now()];

    scoring.recordSuccess(provider, 250);
    const score = scoring.getScore(provider);

    assert.equal(score.last_error, null);
    assert.equal(score.cooldown_until, 0);
    assert.equal(score.cooldown_reason, undefined);
    assert.equal(score.stalling, 0);
    assert.deepEqual(state.stallingTracker[provider], []);
  });
});

test("loadScores migrates stale garbled-output cooldowns once", () => {
  const originalScores = state.scores;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  const future = Date.now() + 3600_000;
  let written = null;
  let scoreSource = {
    "Old-Garble": {
      cooldown_until: future,
      cooldown_reason: "garbled output",
      last_error: { message: "garbled output", time: Date.now() },
      stalling: 4,
      last_stall_time: Date.now(),
    },
    "Real-Rate-Limit": {
      cooldown_until: future,
      cooldown_reason: "rate limited",
      last_error: { message: "429", time: Date.now() },
      stalling: 0,
    },
  };

  fs.existsSync = (file) => file === state.SCORES_FILE;
  fs.readFileSync = (file, enc) => {
    assert.equal(file, state.SCORES_FILE);
    assert.equal(enc, "utf8");
    return JSON.stringify(scoreSource);
  };
  fs.writeFileSync = (file, data) => {
    assert.equal(file, state.SCORES_FILE);
    written = JSON.parse(data);
    scoreSource = written;
  };

  try {
    scoring.loadScores();
    assert.equal(state.scores["Old-Garble"].cooldown_until, 0);
    assert.equal(state.scores["Old-Garble"].cooldown_reason, undefined);
    assert.equal(state.scores["Old-Garble"].last_error, null);
    assert.equal(state.scores["Old-Garble"].stalling, 0);
    assert.equal(state.scores["Real-Rate-Limit"].cooldown_until, future);
    assert.equal(state.scores.__migrations.garble_cooldown_v2.cleared, 1);
    assert.equal(state.scores.__migrations.garble_cooldown_v3.cleared, 1);
    assert.equal(state.scores.__migrations.garble_cooldown_v4.cleared, 1);
    assert.equal(state.scores.__migrations.garble_cooldown_v5.cleared, 1);
    assert.equal(written.__migrations.garble_cooldown_v2.cleared, 1);
    assert.equal(written.__migrations.garble_cooldown_v3.cleared, 1);
    assert.equal(written.__migrations.garble_cooldown_v4.cleared, 1);
    assert.equal(written.__migrations.garble_cooldown_v5.cleared, 1);

    scoreSource["Old-Garble"].cooldown_until = future;
    scoreSource["Old-Garble"].cooldown_reason = "garbled output";
    scoring.loadScores();
    assert.equal(state.scores["Old-Garble"].cooldown_until, future);
    assert.equal(state.scores.__migrations.garble_cooldown_v2.cleared, 1);
    assert.equal(state.scores.__migrations.garble_cooldown_v3.cleared, 1);
    assert.equal(state.scores.__migrations.garble_cooldown_v4.cleared, 1);
    assert.equal(state.scores.__migrations.garble_cooldown_v5.cleared, 1);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    state.scores = originalScores;
  }
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

test("detectIncompatibility learns conservative context from overflow without numeric limit", () => {
  withIsolatedScoring(() => {
    const originalProviders = state.PROVIDERS;
    state.PROVIDERS = [
      { name: "Windsurf-GPT54MiniHighThinking", context: 400000 },
    ];

    try {
      scoring.detectIncompatibility(
        "Windsurf-GPT54MiniHighThinking",
        500,
        '{"error":{"code":"invalid_argument","message":"Your input exceeds the context window of this model."}}',
        { inputTokens: 268000, estimatedTokens: 300000, providerContext: 400000 },
      );

      const compat = scoring.getCompat("Windsurf-GPT54MiniHighThinking");
      assert.equal(compat.real_context, 227800);
      assert.equal(scoring.getEffectiveContext(state.PROVIDERS[0]), 227800);
    } finally {
      state.PROVIDERS = originalProviders;
    }
  });
});

test("detectIncompatibility does not learn real context from max_tokens cap errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Cap-Test",
      400,
      "max_tokens is invalid. Max size: 8192 tokens",
      { inputTokens: 2000, providerContext: 200000 },
    );

    const compat = scoring.getCompat("Cap-Test");
    assert.equal(compat.max_tokens_cap, 8192);
    assert.equal(compat.real_context, undefined);
  });
});

test("detectIncompatibility does not cool request-specific token limit errors as quota", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Request-Limit-Test",
      429,
      "max_tokens exceeded configured limit for this request",
    );

    assert.equal(scoring.isOnCooldown("Request-Limit-Test"), false);
  });
});

test("detectIncompatibility learns bare Copilot Bad Request on tool payloads as no_tools", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-claudesonnet46",
      400,
      "Bad Request",
      { hasTools: true },
    );

    const compat = scoring.getCompat("Copilot-claudesonnet46");
    assert.equal(compat.no_tools, true);
  });
});

test("detectIncompatibility learns no_images from vision unsupported errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-gpt5mini",
      400,
      '{"error":{"message":"model \\"gpt-5-mini\\" not supported for vision"}}',
      { hasImages: true },
    );

    const compat = scoring.getCompat("Copilot-gpt5mini");
    assert.equal(compat.no_images, true);
  });
});

test("detectIncompatibility learns no_data_images from data-url-only failures", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Codex-GPT54Mini",
      500,
      '{"error":{"message":"URL scheme must be http or https, got data:"}}',
      { hasImages: true, hasDataImages: true },
    );

    const compat = scoring.getCompat("Codex-GPT54Mini");
    assert.equal(compat.no_data_images, true);
    assert.equal(compat.no_images, undefined);
  });
});

test("getEffectiveContext applies learned real context across provider context field shapes", () => {
  withIsolatedScoring(() => {
    state.providerCompat["Context-Length-Test"] = { real_context: 24000 };
    state.providerCompat["Missing-Context-Test"] = { real_context: 16000 };

    assert.equal(
      scoring.getEffectiveContext({ name: "Context-Length-Test", context_length: 100000 }),
      24000,
    );
    assert.equal(
      scoring.getEffectiveContext({ name: "Missing-Context-Test" }),
      16000,
    );
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
