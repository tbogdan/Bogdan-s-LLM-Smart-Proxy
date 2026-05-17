"use strict";

const fs = require("fs");
const path = require("path");
const state = require("./state");

// ---------------------------------------------------------------------------
// Load seed-providers.json (bundled fallback)
// ---------------------------------------------------------------------------
function loadSeedProviders() {
  try {
    const raw = fs.readFileSync(state.SEED_FILE, "utf8");
    const seed = JSON.parse(raw);
    return hydrateSeedProviders(seed);
  } catch (err) {
    state.log(`WARN: Failed to load seed-providers.json: ${err.message}`);
    return { providers: [], groups: {} };
  }
}

// ---------------------------------------------------------------------------
// Hydrate seed format into runtime provider objects
// ---------------------------------------------------------------------------
function resolveUrl(url) {
  // Cloudflare: replace /accounts/me/ with actual account ID
  if (url.includes("cloudflare.com") && url.includes("/accounts/me/") && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return url.replace("/accounts/me/", `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/`);
  }
  return url;
}

function hydrateSeedProviders(config) {
  const providers = [];
  for (const p of (config.providers || [])) {
    providers.push({
      name: p.name,
      url: resolveUrl(p.url),
      key: (p.key_env ? process.env[p.key_env] : null) || p.default_key || (p.no_auth ? "anonymous" : ""),
      key_env: p.key_env || "",
      no_auth: !!p.no_auth,
      model: p.model,
      context: p.context || 131072,
      tier: p.tier || 2,
      tc: !!p.tc,
      caps: p.caps || ["text"],
      headers: p.headers || {},
      authHeader: p.auth_style || null,
      kilo: !!p.kilo,
      alive: p.alive !== false,
      seed: true,
    });
  }
  const groups = config.groups || {
        "auto-tools": "tools",
    "auto-coding": "coding",
    "auto-images": "images",
    "auto-video": "video",
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking",
  };
  return { providers, groups };
}

// ---------------------------------------------------------------------------
// Load providers from /data/providers.json (written by discovery)
// ---------------------------------------------------------------------------
function loadProvidersFromFile() {
  try {
    if (!fs.existsSync(state.PROVIDERS_FILE)) return null;
    const raw = fs.readFileSync(state.PROVIDERS_FILE, "utf8");
    const config = JSON.parse(raw);
    if (!config.providers || !Array.isArray(config.providers)) return null;
    return config;
  } catch (err) {
    state.log(`WARN: Failed to parse providers.json: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hydrate providers.json format into runtime objects
// ---------------------------------------------------------------------------
function hydrateProvidersFile(config) {
  const providers = [];
  for (const p of (config.providers || [])) {
    providers.push({
      name: p.name,
      url: resolveUrl(p.url),
      key: (p.key_env ? process.env[p.key_env] : null) || p.default_key || (p.no_auth ? "anonymous" : ""),
      key_env: p.key_env || "",
      no_auth: !!p.no_auth,
      model: p.model,
      context: p.context || 131072,
      tier: p.tier || 2,
      tc: !!p.tc,
      caps: p.caps || ["text"],
      headers: p.headers || {},
      authHeader: p.auth_style || null,
      kilo: !!p.kilo,
      alive: p.alive !== false,
      seed: !!p.seed,
    });
  }
  const groups = config.groups || {
        "auto-tools": "tools",
    "auto-coding": "coding",
    "auto-images": "images",
    "auto-video": "video",
    "auto-text": "text",
    "auto-max": "max",
    "auto-thinking": "thinking",
  };
  return { providers, groups };
}

// ---------------------------------------------------------------------------
// Load providers: try providers.json first, fall back to seed
// ---------------------------------------------------------------------------
function loadProviders() {
  const fileConfig = loadProvidersFromFile();
  if (fileConfig) {
    const result = hydrateProvidersFile(fileConfig);
    state.PROVIDERS = result.providers;
    state.GROUPS = result.groups;
    state.providersVersion = fileConfig.version || 0;
    const active = state.PROVIDERS.filter((p) => p.key && p.alive).length;
    state.log(`Loaded ${state.PROVIDERS.length} providers from providers.json (${active} active, version ${state.providersVersion})`);
  } else {
    const seed = loadSeedProviders();
    state.PROVIDERS = seed.providers;
    state.GROUPS = seed.groups;
    state.providersVersion = 0;
    const active = state.PROVIDERS.filter((p) => p.key && p.alive).length;
    state.log(`Loaded ${state.PROVIDERS.length} providers from seed (${active} active, no providers.json yet)`);
  }
}

// ---------------------------------------------------------------------------
// Watch providers.json for changes (hot-reload)
// ---------------------------------------------------------------------------
function watchProvidersFile(onReload) {
  let debounce = null;
  const dir = path.dirname(state.PROVIDERS_FILE);

  // Use fs.watch on the directory (more reliable across platforms for new files)
  try {
    fs.watch(dir, (_eventType, filename) => {
      if (filename !== path.basename(state.PROVIDERS_FILE)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.log("providers.json changed, reloading...");
        const oldCount = state.PROVIDERS.length;
        loadProviders();
        state.log(`Reloaded ${state.PROVIDERS.length} providers (was ${oldCount})`);
        if (onReload) onReload(); // probe new unverified providers
      }, 500); // debounce 500ms to avoid rapid reloads
    });
    state.log(`Watching ${state.PROVIDERS_FILE} for changes`);
  } catch (err) {
    state.log(`WARN: Could not watch providers.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Model Knowledge Base — benchmark-backed per-category scoring
// Pattern → { coding: N, reasoning: N, tools: N, chat: N, vision: N, speed: N }
// S=0.5, A=0.35, B=0.2, C=0.05, null=0
// ---------------------------------------------------------------------------
const MODEL_SCORES = [
  // S-tier coding + reasoning (frontier models)
  { pat: /claude.*opus.*4[._-]7/i,               coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /gpt.*5\.5/i,                           coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.3 },
  { pat: /gemini.*3\.1.*pro/i,                   coding: 0.5, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0.5, speed: 0.3 },
  { pat: /claude.*opus[- _.]4/i,                 coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.15 },
  { pat: /claude.*sonnet[- _.]4[._-]5/i,        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /claude.*sonnet[- _.]4(?![._-]5)/i,    coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.35 },
  { pat: /claude.*3[._-]7.*sonnet/i,            coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /claude.*haiku[- _.]4/i,               coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.5 },
  { pat: /claude.*3[._-]5.*sonnet/i,            coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.35 },
  { pat: /claude.*3[._-]5.*haiku/i,             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /gpt.*4\.1.*nano/i,                     coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /gpt.*4\.1.*mini/i,                     coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /gpt.*4\.1/i,                           coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.35 },
  { pat: /gemini.*3.*flash/i,                    coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.5, vision: 0.5, speed: 0.4 },
  { pat: /deepseek.*v3\.2/i,                     coding: 0.5, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3\.5.*397b/i,                    coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.15 },
  { pat: /qwen.*coder.*480b/i,                   coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.2, vision: 0, speed: 0.15 },
  { pat: /glm.*5\.1/i,                           coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3\.6.*max/i,                     coding: 0.5, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  // A-tier
  { pat: /gemini.*2\.5.*pro/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.5, speed: 0.3 },
  { pat: /gemini.*2\.5.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /deepseek.*v4.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /gpt.*oss.*120b/i,                      coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.5 },
  { pat: /qwen.*coder.*(?:plus|next)/i,          coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /qwen.*coder/i,                        coding: 0.35, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*3\.5.*122b/i,                    coding: 0.35, reasoning: 0.35, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /qwen.*max/i,                           coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /deepseek.*v3\.1/i,                     coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /deepseek.*r1/i,                        coding: 0.35, reasoning: 0.35, tools: 0.2, chat: 0.2, vision: 0, speed: 0.15 },
  { pat: /kimi.*k2\.5/i,                         coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /kimi.*k2\.6/i,                         coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /nemotron.*(?:120b|super)/i,            coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /gpt.*5\.[4-9]/i,                        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.5, speed: 0.3 },
  { pat: /gpt.*5\.[2-3]/i,                        coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.3 },
  { pat: /gpt.*5.*pro/i,                         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.5, vision: 0.35, speed: 0.2 },
  { pat: /gpt.*5.*codex/i,                       coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /gpt.*5(?!\.\d)(?!.*mini|.*nano|.*pro|.*codex)/i, coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.3 },
  { pat: /gpt.*5.*mini/i,                        coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.2, speed: 0.4 },
  { pat: /gpt.*5.*nano/i,                        coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /o3(?!.*mini)/i,                         coding: 0.5, reasoning: 0.5, tools: 0.5, chat: 0.35, vision: 0, speed: 0.2 },
  { pat: /o3.*mini/i,                             coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /o4.*mini/i,                             coding: 0.35, reasoning: 0.5, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /mistral.*medium/i,                     coding: 0.35, reasoning: 0.2, tools: 0.5, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /glm.*5(?!\.)/i,                        coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /minimax.*m2\.[57]/i,                   coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.35, vision: 0, speed: 0.3 },
  // B-tier
  { pat: /gpt.*4o/i,                             coding: 0.2, reasoning: 0.2, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.4 },
  // gpt-4.1 handled in S/A-tier above
  { pat: /qwen.*235b/i,                          coding: 0.2, reasoning: 0.35, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /qwen.*32b/i,                           coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*plus/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /deepseek.*v3(?!\.)/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /llama.*3[\._-]3.*70b/i,                coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /llama.*4.*maverick/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.35, speed: 0.4 },
  { pat: /command.*a/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /kimi.*k2(?!\.)/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /laguna.*m\.?1/i,                       coding: 0.2, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.3 },
  { pat: /laguna.*xs/i,                          coding: 0.2, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.4 },
  { pat: /mistral.*small/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /glm.*4/i,                              coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /ring.*2\.6/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /owl.*alpha/i,                          coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.05 },
  { pat: /nemotron.*(?:30b|nano.*omni)/i,        coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.2, speed: 0.5 },
  { pat: /qwen.*coder.*30b/i,                    coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /deepseek.*chat/i,                      coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /gemini.*3\.1.*flash/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.35, speed: 0.5 },
  { pat: /gemini.*3\.0.*pro/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0.5, speed: 0.3 },
  { pat: /grok.*3/i,                             coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /grok.*code/i,                          coding: 0.35, reasoning: 0.2, tools: 0.35, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /mistral.*medium.*3/i,                  coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  // C-tier
  { pat: /llama.*4.*scout/i,                     coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0.2, speed: 0.4 },
  { pat: /command.*r.*plus/i,                    coding: 0.05, reasoning: 0.05, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /command.*r7b/i,                        coding: 0.05, reasoning: 0.05, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /qwen.*turbo/i,                         coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /qwen.*(?:8b|14b|4b|0\.6b|1\.7b)/i,    coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /llama.*(?:8b|1b|3b)/i,                 coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /mistral.*(?:7b|8b|nemo)/i,             coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /gemma/i,                               coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /cobuddy/i,                             coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /phi/i,                                 coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.05, vision: 0, speed: 0.5 },
  { pat: /mistral.*large.*675b/i,                 coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.2 },
  { pat: /mistral.*small.*119b/i,                coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /mistral.*nemotron/i,                   coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /qwen.*3.*next/i,                       coding: 0.35, reasoning: 0.35, tools: 0.35, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /qwen.*3\.5.*122b/i,                    coding: 0.35, reasoning: 0.35, tools: 0.5, chat: 0.35, vision: 0.35, speed: 0.4 },
  { pat: /solar/i,                               coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /step.*flash/i,                         coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /sarvam/i,                              coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /stockmark/i,                           coding: 0.05, reasoning: 0.05, tools: 0.05, chat: 0.2, vision: 0, speed: 0.2 },
  { pat: /ministral/i,                           coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /mixtral/i,                             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
  { pat: /nemotron.*nano.*vl/i,                  coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.35, speed: 0.4 },
  { pat: /gpt.*oss.*20b/i,                       coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.5 },
  { pat: /llama.*3\.2.*vision/i,                 coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0.35, speed: 0.35 },
  { pat: /compound/i,                             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.35, vision: 0, speed: 0.4 },
  { pat: /seed.*oss/i,                           coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /mistral.*vibe/i,                       coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.35, vision: 0, speed: 0.3 },
  { pat: /openrouter\/(?:auto|free)/i,           coding: 0.15, reasoning: 0.15, tools: 0.15, chat: 0.15, vision: 0, speed: 0.3 },
  { pat: /llm7/i,                                coding: 0.15, reasoning: 0.15, tools: 0.15, chat: 0.15, vision: 0, speed: 0.3 },
  { pat: /perceptron/i,                          coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.3 },
  { pat: /granite/i,                             coding: 0.2, reasoning: 0.2, tools: 0.2, chat: 0.2, vision: 0, speed: 0.4 },
];

// Map proxy group capability → model score field
const CAP_TO_SCORE = {
  coding: "coding", thinking: "reasoning",
  tools: "tools", text: "chat", images: "vision", video: "vision",
  max: "quality", // max = best overall quality across all categories
};

// Heuristic scoring for models not in MODEL_SCORES — infer tier from name patterns
function inferModelScore(model, category) {
  const m = model.toLowerCase();
  // Size-based tier inference (bigger = generally smarter)
  const sizeMatch = m.match(/(\d+)b(?:\b|_)/);
  const sizeB = sizeMatch ? parseInt(sizeMatch[1]) : 0;
  // Known-good model families (any version) → at least B-tier
  const knownGood = /claude|gpt|gemini|deepseek|qwen|mistral|llama|command|kimi/.test(m);
  // Version hints: higher versions tend to be better
  const hasVersion = /[- _.](?:[4-9]|[1-9]\d)[._-]/.test(m);
  // Reasoning/thinking hints
  const isReasoning = /think|reason|r1|o[1-9]|cot/.test(m);
  // Speed hints
  const isFast = /flash|mini|nano|small|tiny|lite|turbo/.test(m);
  const isBig = /max|ultra|pro|large|mega|super/.test(m);

  let base = 0.1; // absolute minimum
  if (knownGood) base = 0.15;
  if (sizeB >= 70) base = Math.max(base, 0.2);
  if (sizeB >= 200) base = Math.max(base, 0.3);
  if (hasVersion && knownGood) base = Math.max(base, 0.2);
  if (isBig) base = Math.max(base, 0.2);

  if (category === "speed") {
    if (isFast) return 0.5;
    if (sizeB > 0 && sizeB <= 14) return 0.5;
    if (sizeB > 200) return 0.15;
    return 0.3;
  }
  if (category === "vision") return 0; // assume no vision unless explicitly matched
  if (category === "reasoning" && isReasoning) return Math.max(base, 0.3);
  return base;
}

function getModelScore(model, category) {
  const m = (model || "").toLowerCase();
  for (const entry of MODEL_SCORES) {
    if (entry.pat.test(m)) {
      if (category === "quality") {
        // Average of coding + reasoning + tools — overall quality metric
        return ((entry.coding || 0) + (entry.reasoning || 0) + (entry.tools || 0)) / 3;
      }
      return entry[category] || 0;
    }
  }
  // No explicit match — use heuristic inference
  if (category === "quality") {
    return (inferModelScore(m, "coding") + inferModelScore(m, "reasoning") + inferModelScore(m, "tools")) / 3;
  }
  return inferModelScore(m, category);
}

module.exports = {
  loadSeedProviders,
  resolveUrl,
  hydrateSeedProviders,
  loadProvidersFromFile,
  hydrateProvidersFile,
  loadProviders,
  watchProvidersFile,
  MODEL_SCORES,
  CAP_TO_SCORE,
  inferModelScore,
  getModelScore,
};
