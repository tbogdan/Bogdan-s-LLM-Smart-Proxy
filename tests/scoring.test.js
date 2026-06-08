"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
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

test("recordStalling logs possible stalls without cooldown", () => {
  withIsolatedScoring(() => {
    scoring.recordStalling("Windsurf-Test");
    scoring.recordStalling("Windsurf-Test");
    assert.equal(scoring.isOnCooldown("Windsurf-Test"), false);

    scoring.recordStalling("Windsurf-Test");

    assert.equal(scoring.isOnCooldown("Windsurf-Test"), false);
    assert.equal(scoring.getScore("Windsurf-Test").stalling || 0, 0);
    assert.deepEqual(state.stallingTracker["Windsurf-Test"] || [], []);
  });
});

test("recordStalling does not renew stale chronic stall cooldowns", () => {
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

    assert.equal(scoring.isOnCooldown(provider), false);
    assert.equal(state.scores[provider].stalling, 5);
    assert.deepEqual(state.stallingTracker[provider], []);
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

test("detectIncompatibility does not ban Windsurf tool history on generic invalid_argument", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Windsurf-ClaudeSonnet46Thinking",
      502,
      '{"error":{"code":"invalid_argument","message":"an internal error occurred"}}',
      { hasToolHistory: true, hasTools: true },
    );

    const compat = scoring.getCompat("Windsurf-ClaudeSonnet46Thinking");
    assert.notEqual(compat.no_tool_history, true);
  });
});

test("detectIncompatibility learns unsupported adaptive thinking", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Claude-Sonnet45",
      400,
      '{"type":"error","error":{"type":"invalid_request_error","message":"adaptive thinking is not supported"}}',
    );

    assert.equal(scoring.getCompat("Claude-Sonnet45").no_adaptive_thinking, true);
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

test("detectIncompatibility learns context from Copilot max input length errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-gpt4omini",
      400,
      '{"error":{"message":"prompt token count of 137630 exceeds max input length of 128000"}}',
      { inputTokens: 137630, providerContext: 128000 },
    );

    const compat = scoring.getCompat("Copilot-gpt4omini");
    assert.equal(compat.real_context, 128000);
  });
});

test("detectIncompatibility learns exact context from Copilot prompt limit errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-claudesonnet45",
      400,
      '{"error":{"message":"prompt token count of 281721 exceeds the limit of 168000","code":"model_max_prompt_tokens_exceeded"}}',
      { inputTokens: 156000, estimatedTokens: 281721, providerContext: 200000 },
    );

    const compat = scoring.getCompat("Copilot-claudesonnet45");
    assert.equal(compat.real_context, 168000);
  });
});

test("detectIncompatibility learns conservative context from prompt-too-long errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Windsurf-SWE16",
      500,
      '{"error":{"code":"invalid_argument","message":"The prompt is too long for this model"}}',
      { inputTokens: 137630, providerContext: 200000 },
    );

    const compat = scoring.getCompat("Windsurf-SWE16");
    assert.equal(compat.real_context, 116985);
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

test("detectIncompatibility does not infer no_tools from bare Copilot Bad Request on tool payloads", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-claudesonnet46",
      400,
      "Bad Request",
      { hasTools: true },
    );

    const compat = scoring.getCompat("Copilot-claudesonnet46");
    assert.equal(compat.no_tools, undefined);
    assert.equal(compat.no_stream, undefined);
  });
});

test("detectIncompatibility learns bare Copilot Bad Request on streaming payloads as no_stream", () => {
  withIsolatedScoring(() => {
    const compat = scoring.getCompat("Copilot-claudesonnet46");
    compat.stream_only = true;

    scoring.detectIncompatibility(
      "Copilot-claudesonnet46",
      400,
      "Bad Request",
      { isStreaming: true, hasTools: true },
    );

    assert.equal(compat.no_stream, true);
    assert.equal(compat.stream_only, undefined);
    assert.equal(compat.no_tools, undefined);
  });
});

test("detectIncompatibility learns prefixed Copilot stream Bad Request as no_stream", () => {
  withIsolatedScoring(() => {
    const compat = scoring.getCompat("Copilot-claudesonnet46");
    compat.stream_only = true;

    scoring.detectIncompatibility(
      "Copilot-claudesonnet46",
      400,
      "HTTP 400: Bad Request",
      { isStreaming: true, hasTools: true },
    );

    assert.equal(compat.no_stream, true);
    assert.equal(compat.stream_only, undefined);
    assert.equal(compat.no_tools, undefined);
  });
});

test("detectIncompatibility learns unsupported Copilot models", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-gpt52",
      400,
      "{\"error\":{\"message\":\"The requested model is not supported.\",\"code\":\"model_not_supported\",\"param\":\"model\",\"type\":\"invalid_request_error\"}}",
    );

    const compat = scoring.getCompat("Copilot-gpt52");
    assert.equal(compat.unsupported_model, true);
  });
});

test("detectIncompatibility learns providers that reject tool_choice required", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-claudeopus46",
      400,
      "{\"error\":{\"message\":\"Thinking may not be enabled when tool_choice forces tool use.\",\"code\":\"invalid_request_body\"}}",
    );

    const compat = scoring.getCompat("Copilot-claudeopus46");
    assert.equal(compat.no_required_tool_choice, true);
  });
});

test("detectIncompatibility learns Copilot maximum tools length errors", () => {
  withIsolatedScoring(() => {
    scoring.detectIncompatibility(
      "Copilot-gpt54",
      400,
      "{\"error\":{\"message\":\"Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 134 instead.\",\"code\":\"invalid_request_body\"}}",
    );

    const compat = scoring.getCompat("Copilot-gpt54");
    assert.equal(compat.max_tools, 128);
  });
});

test("loadCompat clears stale Copilot Claude no_tools flags", () => {
  const originalCompat = state.providerCompat;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  let written = null;
  const compatSource = {
    "Copilot-claudesonnet46": { no_tools: true, no_stream: true },
    "Copilot-claudeopus46": { no_tools: true },
    "Copilot-gemini25pro": { no_tools: true },
  };

  const compatFile = path.join(state.DATA_DIR, "compat.json");
  fs.existsSync = (file) => file === compatFile;
  fs.readFileSync = (file, enc) => {
    assert.equal(enc, "utf8");
    return JSON.stringify(compatSource);
  };
  fs.writeFileSync = (_file, data) => {
    written = JSON.parse(data);
  };

  try {
    scoring.loadCompat();
    assert.equal(state.providerCompat["Copilot-claudesonnet46"].no_tools, undefined);
    assert.equal(state.providerCompat["Copilot-claudesonnet46"].no_stream, true);
    assert.equal(state.providerCompat["Copilot-claudeopus46"].no_tools, undefined);
    assert.equal(state.providerCompat["Copilot-gemini25pro"].no_tools, true);
    assert.equal(state.providerCompat.__migrations.copilot_claude_tools_v1.cleared_no_tools, 2);
    assert.equal(written.__migrations.copilot_claude_tools_v1.cleared_no_tools, 2);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    state.providerCompat = originalCompat;
  }
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

test("providerScore ignores historical stalling counters", () => {
  withIsolatedScoring(() => {
    const provider = { name: "Claude-Test", tier: 1 };
    const score = scoring.getScore(provider.name);
    score.requests = 10;
    score.successes = 10;
    score.success_rate = 1;
    score.avg_latency = 0;
    score.stalling = 4;
    score.last_stall_time = Date.now() - 2 * 3600_000;

    const withStallingHistory = scoring.providerScore(provider);

    score.stalling = 0;
    score.last_stall_time = 0;
    const clean = scoring.providerScore(provider);

    assert.equal(withStallingHistory, clean);
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
