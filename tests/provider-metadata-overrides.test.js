"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const overrides = require("../lib/provider-metadata-overrides");

function withAuditFile(audit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-metadata-audit-"));
  const auditPath = path.join(dir, "audit.json");
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  return auditPath;
}

test("applyProviderMetadataOverrides applies full authoritative provider metadata", () => {
  const auditPath = withAuditFile({
    generated_utc: "2026-06-16T09:05:10Z",
    provider_metadata_overrides: {
      "codex/gpt-5.4": {
        cost_group: 4,
        cost_multiplier: 1.125,
        quality_group: 5,
        speed_group: 3,
        thinking_effort: "high",
        thinking_level: 4,
        routing_level: 5,
        source: "codex_backend",
        source_type: "model",
        context_length: 272000,
        max_tokens: 128000,
        supported_thinking_efforts: ["low", "medium", "high", "xhigh"],
        supports_adaptive_thinking: true,
        supports_extended_thinking: false,
        capabilities: ["text", "coding", "thinking"],
        canonical_provider: "OpenAI",
        canonical_model: "gpt-5.4",
        blended_3in_1out_usd_per_1m: 5.625,
      },
    },
  });

  const provider = overrides.applyProviderMetadataOverrides({
    name: "Codex-gpt54",
    model: "codex/gpt-5.4",
    upstream_model: "gpt-5.4",
    cost_group: 3,
    quality_group: 4,
    speed_group: 4,
    thinking_effort: "medium",
    context: 100000,
  }, { auditPath, refresh: true });

  assert.equal(provider.cost_group, 4);
  assert.equal(provider.cost_multiplier, 1.125);
  assert.equal(provider.quality_group, 5);
  assert.equal(provider.speed_group, 3);
  assert.equal(provider.thinking_effort, "high");
  assert.equal(provider.thinking_level, 4);
  assert.equal(provider.routing_level, 5);
  assert.equal(provider.source, "codex_backend");
  assert.equal(provider.source_type, "model");
  assert.equal(provider.context, 272000);
  assert.equal(provider.max_tokens, 128000);
  assert.deepEqual(provider.supported_thinking_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(provider.supports_adaptive_thinking, true);
  assert.deepEqual(provider.caps, ["text", "coding", "thinking"]);
  assert.equal(provider.canonical_provider, "OpenAI");
  assert.equal(provider.metadata_audit_generated_utc, "2026-06-16T09:05:10Z");
});

test("applyProviderMetadataOverrides can build cost overrides from audit change arrays", () => {
  const auditPath = withAuditFile({
    generated_utc: "2026-06-16T09:05:10Z",
    cost_group_changes: [
      {
        model: "copilot/gpt-5.4",
        new_cost_group: "5",
        new_cost_multiplier: "1.0417",
        rule_applied: ">9",
        bucket_reference_usd_per_1m: "9",
      },
    ],
    cost_multiplier_changes: [
      {
        model: "copilot/gpt-5.4",
        cost_group: "5",
        new_cost_multiplier: "1.0417",
        rule_applied: ">9",
        bucket_reference_usd_per_1m: "9",
      },
    ],
  });

  const provider = overrides.applyProviderMetadataOverrides({
    model: "copilot/gpt-5.4",
    cost_group: 3,
    cost_multiplier: 1,
  }, { auditPath, refresh: true });

  assert.equal(provider.cost_group, 5);
  assert.equal(provider.cost_multiplier, 1.0417);
  assert.equal(provider.cost_group_rule_applied, ">9");
  assert.equal(provider.cost_bucket_reference_usd_per_1m, 9);
});
