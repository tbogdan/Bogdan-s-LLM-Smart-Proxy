"use strict";

const fs = require("fs");
const path = require("path");

const AUDIT_FILENAME = "discovery-model-inventory-costgroups-multipliers-audit.json";
const DEFAULT_AUDIT_PATH = path.join(process.env.DATA_DIR || "/data", AUDIT_FILENAME);

const NUMERIC_FIELDS = new Set([
  "context",
  "context_length",
  "max_tokens",
  "max_tools",
  "cost_group",
  "cost_multiplier",
  "cost_group_original",
  "cost_multiplier_original",
  "cost_bucket_reference_usd_per_1m",
  "quality_group",
  "quality_group_original",
  "speed_group",
  "speed_group_original",
  "thinking_level",
  "routing_level",
  "public_context_length",
  "public_max_output_tokens",
  "input_usd_per_1m",
  "cached_input_usd_per_1m",
  "cache_write_usd_per_1m",
  "output_usd_per_1m",
  "blended_3in_1out_usd_per_1m",
]);

const BOOLEAN_FIELDS = new Set([
  "supports_adaptive_thinking",
  "supports_extended_thinking",
  "supports_code_execution",
  "supports_context_management",
  "supports_context_compaction",
  "supports_structured_outputs",
  "supports_pdf_input",
  "supports_parallel_tool_calls",
  "supports_tool_calls",
  "supports_streaming",
  "supports_search_tool",
  "supports_verbosity",
  "model_picker_enabled",
  "is_chat_default",
  "is_chat_fallback",
  "supported_in_api",
  "swe_model_for_cost_rule",
]);

const LIST_FIELDS = new Set([
  "supported_thinking_efforts",
  "capabilities",
  "input_modalities",
  "service_tiers",
  "additional_speed_tiers",
  "supported_endpoints",
  "evidence_urls",
]);

const AUDIT_METADATA_FIELDS = [
  "canonical_provider",
  "canonical_model",
  "model_status",
  "public_context_length",
  "public_max_output_tokens",
  "cost_group_rule_applied",
  "cost_bucket_reference_usd_per_1m",
  "cost_multiplier_basis",
  "cost_multiplier_original",
  "swe_model_for_cost_rule",
  "cost_group_original",
  "cost_basis",
  "input_usd_per_1m",
  "cached_input_usd_per_1m",
  "cache_write_usd_per_1m",
  "output_usd_per_1m",
  "blended_3in_1out_usd_per_1m",
  "price_tier_note",
  "thinking_effort_original",
  "speed_group_original",
  "quality_group_original",
  "confidence",
  "correction_notes",
  "evidence_urls",
  "original_source",
  "original_source_type",
  "original_context_length",
  "original_max_tokens",
];

let cachedPath = "";
let cachedMtimeMs = -1;
let cachedOverrides = new Map();

function auditPathFromOptions(options = {}) {
  return options.auditPath || process.env.PROVIDER_METADATA_AUDIT_FILE || DEFAULT_AUDIT_PATH;
}

function normalizeModelKey(value) {
  return String(value || "").trim().toLowerCase();
}

function parseNumber(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseBoolean(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  return undefined;
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split("|").map((entry) => entry.trim()).filter(Boolean);
}

function normalizeOverrideValue(field, value) {
  if (NUMERIC_FIELDS.has(field)) return parseNumber(value);
  if (BOOLEAN_FIELDS.has(field)) return parseBoolean(value);
  if (LIST_FIELDS.has(field)) return parseList(value);
  if (value === null || value === undefined || value === "") return undefined;
  return value;
}

function normalizeOverride(raw = {}, audit = {}) {
  const normalized = {};
  for (const [field, value] of Object.entries(raw)) {
    if (field === "model" || field === "provider" || field === "discovery_name") continue;
    const next = normalizeOverrideValue(field, value);
    if (next !== undefined) normalized[field] = next;
  }

  if (normalized.context_length !== undefined && normalized.context === undefined) {
    normalized.context = normalized.context_length;
  }
  if (normalized.capabilities !== undefined && normalized.caps === undefined) {
    normalized.caps = normalized.capabilities;
  }
  if (normalized.source_type === undefined && normalized.original_source_type) {
    normalized.source_type = normalized.original_source_type;
  }
  if (normalized.source === undefined && normalized.original_source) {
    normalized.source = normalized.original_source;
  }

  if (audit.generated_utc) normalized.metadata_audit_generated_utc = audit.generated_utc;
  normalized.metadata_audit_source = AUDIT_FILENAME;
  return normalized;
}

function mergeOverride(target, source) {
  for (const [field, value] of Object.entries(source || {})) {
    if (value !== undefined && value !== null && value !== "") target[field] = value;
  }
  return target;
}

function addOverride(overrides, model, raw, audit) {
  const key = normalizeModelKey(model);
  if (!key) return;
  const existing = overrides.get(key) || {};
  overrides.set(key, mergeOverride(existing, normalizeOverride(raw, audit)));
}

function buildOverrides(audit = {}) {
  const overrides = new Map();

  const full = audit.provider_metadata_overrides || {};
  if (Array.isArray(full)) {
    for (const row of full) addOverride(overrides, row?.model, row, audit);
  } else if (full && typeof full === "object") {
    for (const [model, row] of Object.entries(full)) addOverride(overrides, model, row, audit);
  }

  for (const row of audit.cost_group_changes || []) {
    addOverride(overrides, row?.model, {
      cost_group: row.new_cost_group,
      cost_multiplier: row.new_cost_multiplier,
      cost_group_rule_applied: row.rule_applied,
      cost_bucket_reference_usd_per_1m: row.bucket_reference_usd_per_1m,
      cost_group_original: row.old_cost_group,
      cost_multiplier_original: row.old_cost_multiplier,
      canonical_provider: row.canonical_provider,
      canonical_model: row.canonical_model,
      blended_3in_1out_usd_per_1m: row.blended_3in_1out_usd_per_1m,
      swe_model_for_cost_rule: row.swe_model_for_cost_rule,
    }, audit);
  }

  for (const row of audit.cost_multiplier_changes || []) {
    addOverride(overrides, row?.model, {
      cost_group: row.cost_group,
      cost_multiplier: row.new_cost_multiplier,
      cost_group_rule_applied: row.rule_applied,
      cost_bucket_reference_usd_per_1m: row.bucket_reference_usd_per_1m,
      cost_multiplier_original: row.old_cost_multiplier,
      canonical_provider: row.canonical_provider,
      canonical_model: row.canonical_model,
      blended_3in_1out_usd_per_1m: row.blended_3in_1out_usd_per_1m,
    }, audit);
  }

  return overrides;
}

function loadOverrides(options = {}) {
  const auditPath = auditPathFromOptions(options);
  try {
    const stat = fs.statSync(auditPath);
    if (!options.refresh && cachedPath === auditPath && cachedMtimeMs === stat.mtimeMs) return cachedOverrides;
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    cachedPath = auditPath;
    cachedMtimeMs = stat.mtimeMs;
    cachedOverrides = buildOverrides(audit);
    return cachedOverrides;
  } catch {
    if (cachedPath === auditPath && !options.refresh) return cachedOverrides;
    cachedPath = auditPath;
    cachedMtimeMs = -1;
    cachedOverrides = new Map();
    return cachedOverrides;
  }
}

function lookupProviderMetadataOverride(provider = {}, options = {}) {
  const overrides = loadOverrides(options);
  for (const candidate of [provider.model, provider.upstream_model]) {
    const override = overrides.get(normalizeModelKey(candidate));
    if (override) return override;
  }
  return null;
}

function applyProviderMetadataOverrides(provider = {}, options = {}) {
  const override = lookupProviderMetadataOverride(provider, options);
  if (!override) return provider;
  const next = { ...provider, ...override };
  if (override.context !== undefined) next.context = override.context;
  if (override.caps !== undefined) next.caps = override.caps;
  return next;
}

function clearCache() {
  cachedPath = "";
  cachedMtimeMs = -1;
  cachedOverrides = new Map();
}

module.exports = {
  AUDIT_FILENAME,
  AUDIT_METADATA_FIELDS,
  DEFAULT_AUDIT_PATH,
  applyProviderMetadataOverrides,
  clearCache,
  loadOverrides,
  lookupProviderMetadataOverride,
  normalizeModelKey,
};
