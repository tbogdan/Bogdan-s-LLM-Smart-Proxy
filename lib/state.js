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

// ── Ensure DATA_DIR exists ───────────────────────────────────────────────────
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (_) {
  // ignore — may lack permissions in some environments
}

// ── Mutable state ────────────────────────────────────────────────────────────
let PROVIDERS = [];
let GROUPS = {};
let providersVersion = 0;
let scores = {};
let quotaDisabled = {};
let providerCompat = {};

const sessionStats = {};
const sessionCompactCache = {};
const sessionAssessmentCache = {};
const sessionAssessmentCacheStats = {};
const routeDiversityStats = {};
const groupBans = {};
const stallingTracker = {};
const truncationCache = {}; // { contentHash → truncatedContent } — stable truncation across requests
const compactionDropCache = {}; // { sessionId → Set<msgHash> } — dropped message hashes for replay
const fileActivity = {}; // { sessionId → { filePath → { lastRead, lastWrite, reads, writes } } }
const aiSummaryCache = {}; // { cacheKey → summary } — self-call summaries for compacted context
const humanApprovals = {
  pending: {},
  byRequestHash: {},
  audit: [],
};

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
  humanApprovals,

  // Logging
  log,
};
