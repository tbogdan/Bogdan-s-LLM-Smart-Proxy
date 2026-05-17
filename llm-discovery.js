#!/usr/bin/env node
"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || "/data";
const DISCOVERY_FILE = path.join(DATA_DIR, "discovery.json");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");
const SEED_FILE = path.join(__dirname, "seed-providers.json");
const SCAN_INTERVAL = 6 * 60 * 60_000; // 6 hours
const REQUEST_TIMEOUT = 30_000;

// Thinking model patterns
const THINKING_PATTERNS = [
  /qwen3/i, /qwq/i, /deepseek-v[34]/i, /deepseek.*r1/i, /gpt-oss/i, /kimi/i,
  /gemini-2\.5/i, /gemini-3/i, /magistral/i, /\b(o1|o3|o4)\b/i, /nemotron.*reason/i,
  /gpt-5/i, /claude.*sonnet[- _.]4/i, /claude.*opus/i, /claude.*haiku[- _.]4/i,
];

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ---------------------------------------------------------------------------
// URL resolution (e.g. Cloudflare accounts/me → actual account ID)
// ---------------------------------------------------------------------------
function resolveUrl(url) {
  if (url.includes("cloudflare.com") && url.includes("/accounts/me/") && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return url.replace("/accounts/me/", `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function fetchJSON(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(parsed, { method: "GET", headers, timeout: REQUEST_TIMEOUT }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          reject(new Error(`JSON parse error from ${urlStr}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function postJSON(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = mod.request(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Load seed providers
// ---------------------------------------------------------------------------
function loadSeed() {
  try {
    const raw = fs.readFileSync(SEED_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    log(`WARN: Failed to load seed-providers.json: ${err.message}`);
    return { providers: [], groups: {} };
  }
}

// ---------------------------------------------------------------------------
// Provider endpoints to scan for new models
// ---------------------------------------------------------------------------
function getEndpoints() {
  const endpoints = [];

  // Groq
  if (process.env.GROQ_API_KEY) {
    endpoints.push({
      name: "Groq",
      modelsUrl: "https://api.groq.com/openai/v1/models",
      chatUrl: "https://api.groq.com/openai/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      key_env: "GROQ_API_KEY",
    });
  }

  // Cerebras
  if (process.env.CEREBRAS_API_KEY) {
    endpoints.push({
      name: "Cerebras",
      modelsUrl: "https://api.cerebras.ai/v1/models",
      chatUrl: "https://api.cerebras.ai/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      key_env: "CEREBRAS_API_KEY",
    });
  }

  // SambaNova
  if (process.env.SAMBANOVA_API_KEY) {
    endpoints.push({
      name: "SambaNova",
      modelsUrl: "https://api.sambanova.ai/v1/models",
      chatUrl: "https://api.sambanova.ai/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.SAMBANOVA_API_KEY}` },
      key_env: "SAMBANOVA_API_KEY",
    });
  }

  // NVIDIA
  if (process.env.NVIDIA_API_KEY) {
    endpoints.push({
      name: "NVIDIA",
      modelsUrl: "https://integrate.api.nvidia.com/v1/models",
      chatUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      key_env: "NVIDIA_API_KEY",
    });
  }

  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    endpoints.push({
      name: "OpenRouter",
      modelsUrl: "https://openrouter.ai/api/v1/models",
      chatUrl: "https://openrouter.ai/api/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      key_env: "OPENROUTER_API_KEY",
      filterFree: true,
    });
  }

  // Kilo (via OpenRouter models list, but proxied chat endpoint)
  if (process.env.KILO_TOKEN) {
    endpoints.push({
      name: "Kilo",
      modelsUrl: "https://openrouter.ai/api/v1/models",
      chatUrl: "https://api.kilo.ai/api/openrouter/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${process.env.KILO_TOKEN}`,
        "User-Agent": "Kilo-Code/7.2.0",
        "HTTP-Referer": "https://kilocode.ai",
        "X-Title": "Kilo Code",
      },
      key_env: "KILO_TOKEN",
      filterFree: true,
      kilo: true,
      extraHeaders: {
        "User-Agent": "Kilo-Code/7.2.0",
        "HTTP-Referer": "https://kilocode.ai",
        "X-Title": "Kilo Code",
      },
    });
  }

  // SiliconFlow
  if (process.env.SILICONFLOW_API_KEY) {
    endpoints.push({
      name: "SiliconFlow",
      modelsUrl: "https://api.siliconflow.com/v1/models",
      chatUrl: "https://api.siliconflow.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}` },
      key_env: "SILICONFLOW_API_KEY",
    });
  }

  // Mistral
  if (process.env.MISTRAL_API_KEY) {
    endpoints.push({
      name: "Mistral",
      modelsUrl: "https://api.mistral.ai/v1/models",
      chatUrl: "https://api.mistral.ai/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
      key_env: "MISTRAL_API_KEY",
    });
  }

  // DeepSeek
  if (process.env.DEEPSEEK_API_KEY) {
    endpoints.push({
      name: "DeepSeek",
      modelsUrl: "https://api.deepseek.com/v1/models",
      chatUrl: "https://api.deepseek.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      key_env: "DEEPSEEK_API_KEY",
    });
  }

  // Alibaba / DashScope
  if (process.env.ALIBABA_API_KEY) {
    endpoints.push({
      name: "Alibaba",
      modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      chatUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.ALIBABA_API_KEY}` },
      key_env: "ALIBABA_API_KEY",
    });
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    endpoints.push({
      name: "OpenAI",
      modelsUrl: "https://api.openai.com/v1/models",
      chatUrl: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      key_env: "OPENAI_API_KEY",
    });
  }

  // Cohere
  if (process.env.COHERE_API_KEY) {
    endpoints.push({
      name: "Cohere",
      modelsUrl: "https://api.cohere.ai/compatibility/v1/models",
      chatUrl: "https://api.cohere.ai/compatibility/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}` },
      key_env: "COHERE_API_KEY",
    });
  }

  // Hugging Face
  if (process.env.HF_TOKEN) {
    endpoints.push({
      name: "HuggingFace",
      modelsUrl: "https://router.huggingface.co/v1/models",
      chatUrl: "https://router.huggingface.co/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` },
      key_env: "HF_TOKEN",
    });
  }

  // --- Local Gateway Proxies (Docker internal network) ---

  // Kiro Gateway
  if (process.env.ENABLE_KIRO === "true" && process.env.KIRO_API_KEY) {
    endpoints.push({
      name: "Kiro",
      modelsUrl: "http://kiro-gateway:10088/v1/models",
      chatUrl: "http://kiro-gateway:10088/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.KIRO_API_KEY}` },
      key_env: "KIRO_API_KEY",
      local_gateway: true,
    });
  }

  // ModelScope (Alibaba model hub — 65 free models)
  if (process.env.MODELSCOPE_API_KEY) {
    endpoints.push({
      name: "ModelScope",
      modelsUrl: "https://api-inference.modelscope.ai/v1/models",
      chatUrl: "https://api-inference.modelscope.ai/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.MODELSCOPE_API_KEY}` },
      key_env: "MODELSCOPE_API_KEY",
    });
  }

  // Cline Provider (public API — 356 models, 28 free)
  if (process.env.CLINE_API_KEY) {
    endpoints.push({
      name: "Cline",
      modelsUrl: "https://api.cline.bot/api/v1/ai/cline/models",
      chatUrl: "https://api.cline.bot/api/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.CLINE_API_KEY}` },
      key_env: "CLINE_API_KEY",
      filterFree: true,
    });
  }

  // OpenAI Codex Proxy (ChatGPT subscription OAuth)
  if (process.env.ENABLE_CODEX === "true" && process.env.CODEX_API_KEY) {
    endpoints.push({
      name: "Codex",
      modelsUrl: "http://codex-proxy:10531/v1/models",
      chatUrl: "http://codex-proxy:10531/v1/chat/completions",
      headers: { Authorization: `Bearer ${process.env.CODEX_API_KEY}` },
      key_env: "CODEX_API_KEY",
      local_gateway: true,
    });
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------
function detectCaps(modelId, modelData) {
  const caps = ["text"];
  const id = (modelId || "").toLowerCase();

  // Coding — frontier models + code-specialized
  if (/coder|code|codex|starcoder|codellama|deepseek-v[3-9]|laguna|gpt-[45]|claude.*sonnet|claude.*opus|command-a|nemotron.*super|qwen.*max|qwen.*plus|qwen.*235b/i.test(id)) caps.push("coding");

  // Tools — most chat models support tools
  if (modelData?.capabilities?.tools || /gpt|llama|qwen|mistral|gemini|nemotron|glm|deepseek|kimi|ring|claude|command|owl|granite|ministral/i.test(id)) {
    caps.push("tools");
  }

  // Images/vision
  if (/vision|llava|scout|maverick|gemini|gpt-4o|gpt-5|pixtral|claude.*sonnet.*4|claude.*opus|omni/i.test(id)) caps.push("images");

  // Video
  if (/gemini/i.test(id)) caps.push("video");

  // Large context = max
  const ctx = modelData?.context_length || 0;
  if (ctx >= 128000) caps.push("max");

  // Thinking
  if (THINKING_PATTERNS.some((p) => p.test(id))) caps.push("thinking");

  return [...new Set(caps)];
}

// ---------------------------------------------------------------------------
// Test a model with basic chat
// ---------------------------------------------------------------------------
async function testChat(chatUrl, headers, model) {
  try {
    const resp = await postJSON(chatUrl, headers, {
      model,
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 50,
    });
    return resp.status < 400 && resp.data?.choices?.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test thinking capability
// ---------------------------------------------------------------------------
async function testThinking(chatUrl, headers, model) {
  try {
    const body = {
      model,
      messages: [{ role: "user", content: "What is 15 * 37? Think step by step." }],
      max_tokens: 500,
    };

    // Add enable_thinking for Qwen3 models
    if (/qwen3|qwq/i.test(model)) {
      body.extra_body = { enable_thinking: true };
    }

    const resp = await postJSON(chatUrl, headers, body);
    if (resp.status >= 400 || !resp.data) return false;

    const choice = resp.data.choices?.[0];
    if (!choice) return false;

    if (choice.message?.reasoning_content) return true;
    if (choice.message?.thinking) return true;
    const content = choice.message?.content || "";
    if (/<think>[\s\S]*?<\/think>/i.test(content)) return true;

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test context size by sending progressively larger payloads
// ---------------------------------------------------------------------------
async function testContextSize(chatUrl, headers, model) {
  const sizes = [4096, 16384, 32768, 65536, 131072];
  let maxWorking = 0;

  for (const size of sizes) {
    try {
      // Generate a message roughly `size` tokens (~4 chars per token)
      const padding = "word ".repeat(Math.min(size, 8000)); // limit actual test
      const resp = await postJSON(chatUrl, headers, {
        model,
        messages: [{ role: "user", content: `Count to 3. Context test: ${padding}` }],
        max_tokens: 20,
      });
      if (resp.status < 400 && resp.data?.choices?.length > 0) {
        maxWorking = size;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return maxWorking || 4096;
}

// ---------------------------------------------------------------------------
// Load / save discovery data (raw scan results)
// ---------------------------------------------------------------------------
function loadDiscovery() {
  try {
    if (fs.existsSync(DISCOVERY_FILE)) {
      const data = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
      // Handle old format or missing models array
      if (!Array.isArray(data.models)) {
        log("discovery.json has old/incompatible format, resetting");
        return { models: [], last_scan: null, scan_count: 0 };
      }
      return data;
    }
  } catch {}
  return { models: [], last_scan: null, scan_count: 0 };
}

function saveDiscovery(data) {
  try { fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ---------------------------------------------------------------------------
// Write providers.json: merge seed + discovered
// ---------------------------------------------------------------------------
function writeProvidersFile(seed, discoveredProviders) {
  // Start with EXISTING providers.json to preserve previously discovered providers
  const providerMap = new Map();

  // Load existing file first (preserves providers from previous scan cycles)
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      const existing = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
      for (const p of (existing.providers || [])) {
        providerMap.set(p.name, p);
      }
    }
  } catch {}

  // Layer seed providers on top (source of truth for seed config)
  for (const sp of (seed.providers || [])) {
    const existing = providerMap.get(sp.name);
    if (existing) {
      // Keep alive/last_tested from existing, update config from seed
      providerMap.set(sp.name, { ...sp, seed: true, alive: existing.alive, last_tested: existing.last_tested });
    } else {
      providerMap.set(sp.name, { ...sp, seed: true, alive: true });
    }
  }

  // Merge current scan results (update alive status, add new discoveries)
  for (const dp of discoveredProviders) {
    if (providerMap.has(dp.name)) {
      const existing = providerMap.get(dp.name);
      existing.alive = dp.alive;
      existing.last_tested = dp.last_tested;
      providerMap.set(dp.name, existing);
    } else {
      providerMap.set(dp.name, { ...dp, seed: false });
    }
  }

  const config = {
    version: Date.now(),
    generated: new Date().toISOString(),
    providers: Array.from(providerMap.values()),
    groups: seed.groups || {
        "auto-tools": "tools",
      "auto-coding": "coding",
      "auto-images": "images",
      "auto-video": "video",
      "auto-text": "text",
      "auto-max": "max",
      "auto-thinking": "thinking",
    },
  };

  try {
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 2));
    log(`Wrote providers.json: ${config.providers.length} providers (version ${config.version})`);
  } catch (err) {
    log(`ERROR: Failed to write providers.json: ${err.message}`);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Test seed providers for alive status
// ---------------------------------------------------------------------------
function loadProvidersFromFile() {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    }
  } catch {}
  return null;
}

async function testSeedProviders(seed) {
  const results = [];
  const RETEST_OK_MS = 3.5 * 24 * 60 * 60_000; // retest alive providers every 3.5 days
  const RETEST_FAIL_MS = 6 * 60 * 60_000; // retest dead providers every 6h

  // Load existing test results from providers.json
  const existingConfig = loadProvidersFromFile();
  const existingProviders = new Map();
  if (existingConfig?.providers) {
    for (const p of existingConfig.providers) {
      if (p.last_tested) existingProviders.set(p.name, p);
    }
  }

  for (const sp of (seed.providers || [])) {
    const key = (sp.key_env ? process.env[sp.key_env] : null) || sp.default_key || "";
    if (!key && !sp.no_auth) {
      results.push({
        name: sp.name,
        alive: false,
        last_tested: new Date().toISOString(),
        reason: "no_key",
      });
      continue;
    }

    // Skip if recently tested — alive <3,5d, dead <6h
    const existing = existingProviders.get(sp.name);
    if (existing?.last_tested) {
      const age = Date.now() - new Date(existing.last_tested).getTime();
      if (existing.alive && age < RETEST_OK_MS) {
        results.push({ name: sp.name, alive: true, last_tested: existing.last_tested });
        log(`  SKIP:  ${sp.name} (alive, tested ${Math.round(age / 3600000)}h ago)`);
        continue;
      }
      if (!existing.alive && age < RETEST_FAIL_MS) {
        results.push({ name: sp.name, alive: false, last_tested: existing.last_tested });
        log(`  SKIP:  ${sp.name} (dead, tested ${Math.round(age / 3600000)}h ago)`);
        continue;
      }
    }

    // Build headers for test
    const headers = { ...(sp.headers || {}) };
    if (key && !(sp.no_auth && key === "anonymous" && !sp.kilo)) {
      if (sp.auth_style === "token") {
        headers["Authorization"] = `token ${key}`;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    }

    const chatOk = await testChat(resolveUrl(sp.url), headers, sp.model);

    results.push({
      name: sp.name,
      alive: chatOk,
      last_tested: new Date().toISOString(),
    });

    if (chatOk) {
      log(`  ALIVE: ${sp.name} (${sp.model})`);
    } else {
      log(`  DEAD:  ${sp.name} (${sp.model})`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main discovery scan
// ---------------------------------------------------------------------------
async function runDiscoveryScan() {
  log("Starting discovery scan...");
  const seed = loadSeed();
  const endpoints = getEndpoints();
  const discovery = loadDiscovery();
  const seedNames = new Set((seed.providers || []).map((p) => p.name));
  const knownModels = new Set(discovery.models.map((m) => `${m.provider}|${m.name || ""}|${m.model}`));
  let newCount = 0;
  let prevNewCount = 0;

  // Phase 1: Test all seed providers for alive status
  log("Phase 1: Testing seed providers...");
  const seedTestResults = await testSeedProviders(seed);

  // Phase 2: Scan endpoints for new models
  log("Phase 2: Scanning for new models...");
  const discoveredProviders = [];

  // Add seed test results
  for (const r of seedTestResults) {
    discoveredProviders.push(r);
  }

  for (const ep of endpoints) {
    log(`Scanning ${ep.name}...`);
    try {
      const resp = await fetchJSON(ep.modelsUrl, ep.headers);
      if (resp.status >= 400 || !resp.data?.data) {
        log(`  ${ep.name}: failed (HTTP ${resp.status})`);
        continue;
      }

      let models = resp.data.data;

      // Filter free models for OpenRouter/Kilo
      if (ep.filterFree) {
        models = models.filter((m) => {
          const pricing = m.pricing || {};
          return (pricing.prompt === "0" || pricing.prompt === 0) &&
                 (pricing.completion === "0" || pricing.completion === 0);
        });
      }

      log(`  ${ep.name}: ${models.length} models found`);

      for (const m of models) {
        const modelId = m.id || m.name;

        // Skip models that are already in seed (they are handled separately)
        const matchesSeed = (seed.providers || []).some(
          (sp) => sp.model === modelId && sp.url === ep.chatUrl
        );
        if (matchesSeed) continue;

        // Test basic chat
        const chatHeaders = { ...ep.headers };
        const chatOk = await testChat(ep.chatUrl, chatHeaders, modelId);
        if (!chatOk) continue;

        // Detect capabilities
        const caps = detectCaps(modelId, m);

        // Test thinking if pattern matches
        let thinkingVerified = false;
        if (THINKING_PATTERNS.some((p) => p.test(modelId))) {
          thinkingVerified = await testThinking(ep.chatUrl, chatHeaders, modelId);
          if (thinkingVerified && !caps.includes("thinking")) {
            caps.push("thinking");
          }
        }

        // Determine thinking capable
        const tc = thinkingVerified || THINKING_PATTERNS.some((p) => p.test(modelId));

        // Build provider name — unique per source+model
        const shortName = modelId.split("/").pop().replace(/[^a-zA-Z0-9]/g, "").substring(0, 20);
        let providerName = `${ep.name}-${shortName}`;

        // Unique key = source + provider name + model ID
        // Same model from different sources (Kilo, Codex, NVIDIA) = different providers, keep all
        const uniqueKey = `${ep.name}|${providerName}|${modelId}`;
        if (knownModels.has(uniqueKey)) continue;

        // If name collides with seed, suffix to avoid overwrite
        if (seedNames.has(providerName)) {
          providerName = `${providerName}-d`; // -d = discovered duplicate
        }

        const entry = {
          provider: ep.name,
          name: providerName,
          model: modelId,
          context_length: m.context_length || m.max_tokens || 4096,
          capabilities: caps,
          thinking_verified: thinkingVerified,
          discovered_at: new Date().toISOString(),
          chat_tested: true,
        };

        discovery.models.push(entry);
        knownModels.add(uniqueKey);
        newCount++;
        log(`  NEW: ${ep.name}/${modelId} caps=[${caps.join(",")}] thinking=${thinkingVerified}`);

        // Also add as a provider entry for providers.json
        const newProvider = {
          name: providerName,
          url: ep.chatUrl,
          key_env: ep.key_env,
          model: modelId,
          context: m.context_length || m.max_tokens || 4096,
          tier: 2,
          tc,
          caps,
          headers: ep.extraHeaders || {},
          kilo: !!ep.kilo,
          alive: true,
          seed: false,
          last_tested: new Date().toISOString(),
        };
        discoveredProviders.push(newProvider);
      }
    } catch (err) {
      log(`  ${ep.name}: error - ${err.message}`);
    }

    // Incremental write: after each endpoint scan, update providers.json
    // so new providers are available to the proxy immediately (hot-reload via fs.watch)
    if (newCount > prevNewCount) {
      writeProvidersFile(seed, discoveredProviders);
      log(`  → Incremental write: ${newCount - prevNewCount} new providers available now`);
    }
    prevNewCount = newCount;
  }

  // Save raw discovery data
  discovery.last_scan = new Date().toISOString();
  discovery.scan_count = (discovery.scan_count || 0) + 1;
  saveDiscovery(discovery);

  // Phase 3: Write merged providers.json
  log("Phase 3: Writing providers.json...");
  writeProvidersFile(seed, discoveredProviders);

  log(`Discovery scan complete. ${newCount} new models found. Total discovery entries: ${discovery.models.length}`);
}

// ---------------------------------------------------------------------------
// Generate initial providers.json from seed (no scanning)
// ---------------------------------------------------------------------------
function generateInitialProvidersFile() {
  if (fs.existsSync(PROVIDERS_FILE)) {
    log("providers.json already exists, skipping initial generation");
    return;
  }

  log("No providers.json found, generating initial from seed...");
  const seed = loadSeed();

  const providers = (seed.providers || []).map((sp) => ({
    ...sp,
    alive: true,
    seed: true,
    last_tested: null,
  }));

  const config = {
    version: 1,
    generated: new Date().toISOString(),
    providers,
    groups: seed.groups || {
        "auto-tools": "tools",
      "auto-coding": "coding",
      "auto-images": "images",
      "auto-video": "video",
      "auto-text": "text",
      "auto-max": "max",
      "auto-thinking": "thinking",
    },
  };

  try {
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 2));
    log(`Generated initial providers.json with ${providers.length} seed providers`);
  } catch (err) {
    log(`ERROR: Failed to write initial providers.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function log(msg) {
  console.log(`[${new Date().toISOString()}] [discovery] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  log("LLM Discovery daemon starting...");
  log(`Scan interval: ${SCAN_INTERVAL / 3600000}h`);
  log(`Data dir: ${DATA_DIR}`);
  log(`Seed file: ${SEED_FILE}`);
  log(`Providers file: ${PROVIDERS_FILE}`);

  // On first run, generate initial providers.json from seed if missing
  generateInitialProvidersFile();

  // Initial scan after 10s
  setTimeout(async () => {
    await runDiscoveryScan().catch((e) => log(`Scan error: ${e.message}`));
  }, 10_000);

  // Periodic scan every 6 hours
  setInterval(async () => {
    await runDiscoveryScan().catch((e) => log(`Scan error: ${e.message}`));
  }, SCAN_INTERVAL);
}

main();
