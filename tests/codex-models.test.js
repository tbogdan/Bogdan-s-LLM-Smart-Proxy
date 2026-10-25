"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("Codex catalog wraps routable model metadata in ModelsResponse", () => {
  const { codexModelsResponse } = require("../lib/codex-models");
  const result = codexModelsResponse({ data: [
    { id: "codex/test", context_window: 32000, supported_thinking_efforts: ["low", "high"] },
  ] });
  assert.equal(result.models[0].slug, "codex/test");
  assert.equal(typeof result.models[0].base_instructions, "string");
  assert.equal(result.models[0].context_window, 32000);
  assert.equal(result.models[0].shell_type, "unified_exec");
  assert.deepEqual(result.models[0].supported_reasoning_levels.map(x => x.effort), ["low", "high"]);
  assert.deepEqual(result.models[0].input_modalities, ["text"]);
  assert.deepEqual(result.models[0].truncation_policy, { mode: "tokens", limit: 10000 });
});
