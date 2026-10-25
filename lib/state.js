"use strict";

const path = require("path");
const fs = require("fs");

// ── Constants ────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || "/data";
const DEV_MODE = process.env.DEV_MODE === "true";
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const DISCOVERY_FILE = path.join(DATA_DIR, "discovery.json");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");
const SEED_FILE = path.join(__dirname, "..", "seed-providers.json");
const REQUEST_TIMEOUT = 300_000;
const COOLDOWN_MS = 30_000;
const QUOTA_DISABLED_FILE = path.join(DATA_DIR, "quota-disabled.json");
const QUOTA_COOLDOWN_MS = 3.5 * 60 * 60_000;

// ── Ensure DATA_DIR exists (deferred to first write to avoid import side effects) ──
let dataDirEnsured = false;
function ensureDataDir() {
  if (dataDirEnsured) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    dataDirEnsured = true;
  } catch (_) {
    // ignore — may lack permissions in some environments
  }
}

// ── Mutable state ────────────────────────────────────────────────────────────
let PROVIDERS = [];
let GROUPS = {};
let providersVersion = 0;
let scores = {};
let quotaDisabled = {};
let providerCompat = {};

const retention = require("./state-retention").createRetention();
const sessionStats = retention.store({ mutable: true, dictionaryDepths: [1] }).object;
const sessionCompactCache = retention.store().object;
const sessionAssessmentCache = retention.store().object;
const sessionAssessmentCacheStats = retention.store({ mutable: true, dictionaryDepths: [] }).object;
const routeDiversityStats = retention.store({ mutable: true, dictionaryDepths: [1] }).object;
const groupBans = {};
const stallingTracker = retention.store({ mutable: true }).object;
const truncationCache = retention.store().object; // { contentHash → truncatedContent } — stable truncation across requests
const compactionDropCache = retention.store({ mutable: true }).object; // { sessionId → Set<msgHash> } — dropped message hashes for replay
const fileActivity = retention.store({ mutable: true, dictionaryDepths: [0] }).object; // { sessionId → { filePath → { lastRead, lastWrite, reads, writes } } }
const aiSummaryCache = retention.store().object; // { cacheKey → summary } — self-call summaries for compacted context
const runtimeProfileLogCache = retention.store().object; // { sessionId → last runtime profile log key }
const humanApprovals = {
  pending: {},
  byRequestHash: {},

};

// Approval tokens and their request index are authoritative; only the diagnostic
// audit tail is evictable. The on-disk audit remains the persistence owner.
const approvalAudit = retention.store({ mutable: true, maxEntries: 1, maxPaths: 500 });
Object.defineProperty(humanApprovals, "audit", {
  enumerable: true,
  get() {
    if (!approvalAudit.get("tail")) approvalAudit.set("tail", []);
    return approvalAudit.get("tail") || [];
  },
  set(value) { approvalAudit.set("tail", value); },
});
const codexBackendUnmappedSeen = retention.store({ maxEntries: 512 });

// ── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  // Constants
  DATA_DIR,
  DEV_MODE,
  SCORES_FILE,
  DISCOVERY_FILE,
  PROVIDERS_FILE,
  SEED_FILE,
  REQUEST_TIMEOUT,
  COOLDOWN_MS,
  QUOTA_DISABLED_FILE,
  QUOTA_COOLDOWN_MS,

  // Mutable primitives — getter/setter pairs so reassignment propagates
  get PROVIDERS() { return PROVIDERS; },
  set PROVIDERS(v) { PROVIDERS = v; },

  get GROUPS() { return GROUPS; },
  set GROUPS(v) { GROUPS = v; },

  get providersVersion() { return providersVersion; },
  set providersVersion(v) { providersVersion = v; },

  get scores() { return scores; },
  set scores(v) { scores = v; },

  get quotaDisabled() { return quotaDisabled; },
  set quotaDisabled(v) { quotaDisabled = v; },

  get providerCompat() { return providerCompat; },
  set providerCompat(v) { providerCompat = v; },

  retention,
  codexBackendUnmappedSeen,

  // Stable object references — mutated in place
  sessionStats,
  sessionCompactCache,
  sessionAssessmentCache,
  sessionAssessmentCacheStats,
  routeDiversityStats,
  groupBans,
  stallingTracker,
  truncationCache,
  compactionDropCache,
  fileActivity,
  aiSummaryCache,
  runtimeProfileLogCache,
  humanApprovals,

  // Data dir
  ensureDataDir,

  // Logging
  log,
};
