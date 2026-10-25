#!/usr/bin/env node
"use strict";

// Expand seed-providers.json from the dated public model catalog without
// calling any inference endpoint. Metadata is taken from the catalog first
// (official model listings / pricing documents), then from a small set of
// published-family defaults and name-based capability heuristics. Entries
// created here are marked `probe: false` so the discovery daemon does not
// spend tokens probing every newly published model.

const fs = require("node:fs");
const path = require("node:path");
const providerConfig = require("../lib/provider-config");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SEED = path.join(ROOT, "seed-providers.json");
const DEFAULT_CATALOG = path.join(ROOT, "data/model-catalog-evidence.json");

// Account-scoped, provisioned, retired or reseller-wide catalogs stay curated.
// They are discovered/provisioned separately and must not be bulk-promoted.
const SKIP_FAMILIES = new Set([
  "windsurf",
  "claude",
  "codex",
  "copilot",
  "openrouter",
  "kilo",
  "huggingface",
  "llm7",
  "cline",
  "modelscope",
  "opencode",
  "opencode-go",
  "githubmodels",
  "kiro",
  "hyperbolic",
]);

// Families that currently have no seed routes at all. Add every current chat
// model so a fresh install still knows about them.
const FULL_FAMILIES = new Set([
  "kimi",
  "xiaomi",
  "together",
  "fireworks",
  "xai",
  "perplexity",
  "nebius",
]);

// For families that already have a curated seed set, add current flagship and
// newly published routes explicitly. This avoids turning the seed into a copy
// of a 400-model reseller catalog.
const CURATED = {
  openai: [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6.1-sol",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-mini",
    "o3",
    "o4-mini",
    "gpt-5.5-cyber",
    "gpt-5.6-cyber",
  ],
  gemini: [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-4-argon",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  mistral: [
    "mistral-large-4",
    "mistral-large-2512",
    "mistral-medium-3-5",
    "mistral-medium-2604",
    "mistral-small-2603",
    "codestral-2508",
    "magistral-medium-latest",
    "magistral-small-latest",
    "zai-glm-5-3",
    "zai-glm-5-3-flash",
    "ministral-14b-2512",
  ],
  groq: [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-safeguard-20b",
    "qwen/qwen3.8-27b",
    "llama-3.3-70b-versatile",
    "allam-2-7b",
  ],
  cerebras: ["gpt-oss-120b", "qwen-3.8-27b"],
  sambanova: [
    "gemma-4-31B-it",
    "MiniMax-M3",
    "MiniMax-M3.1-Flash",
    "DeepSeek-V3.1",
    "DeepSeek-V3.2",
    "gpt-oss-120b",
    "Meta-Llama-3.3-70B-Instruct",
  ],
  nvidia: [
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-3.5-bolt-e4b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "deepseek-ai/deepseek-v4-pro-0813",
    "deepseek-ai/deepseek-v4.1-flash",
    "moonshotai/kimi-k2.6",
    "minimaxai/minimax-m3.1-flash",
    "openai/gpt-oss-20b",
    "z-ai/glm-5.3",
    "stepfun-ai/step-5-preview",
    "meta/muse-glimmer-30b",
  ],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  alibaba: [
    "qwen3.8-max",
    "qwen3.8-max-0902",
    "qwen3.8-flash",
    "qwen3.8-27b",
    "qwen3.7-max",
    "qwen3.6-plus",
    "qwen3.6-flash",
    "qwen3-coder-flash",
    "qwen3-vl-plus",
    "deepseek-v4.1-flash-1017",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-pro-0813",
    "glm-5.3",
    "kimi-k3",
  ],
  cohere: [
    "command-a-03-2025",
    "command-a-plus-05-2026",
    "command-a-reasoning-08-2025",
    "command-a-vision-07-2025",
    "command-r-08-2024",
    "command-r-plus-08-2024",
    "command-r7b-12-2024",
  ],
  ollama: [
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.2",
    "kimi-k3",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "minimax-m3",
    "minimax-m3.1-flash",
    "muse-spark-open",
    "beam",
    "nemotron-3-ultra",
    "nemotron-3-super",
    "gemma4",
    "gpt-oss:120b",
    "gpt-oss:20b",
    "mistral-large-4",
  ],
  siliconflow: [
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
    "zai-org/GLM-5.3",
    "zai-org/GLM-5.3-Flash",
    "zai-org/GLM-5.2",
    "moonshotai/Kimi-K3",
    "MiniMaxAI/MiniMax-M3",
    "MiniMaxAI/MiniMax-M3.1-Flash",
    "Qwen/Qwen3.8-2.4T-A95B",
    "Qwen/Qwen3.8-27B",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "Qwen/Qwen3.6-27B",
    "Qwen/Qwen3.6-35B-A3B",
    "tencent/Hy3",
  ],
  bigmodel: [
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.3-flashx",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "glm-4.7",
    "glm-4.6",
  ],
  ovh: [
    "gpt-oss-120b",
    "gpt-oss-20b",
    "Meta-Llama-3_3-70B-Instruct",
    "Mistral-Small-3.2-24B-Instruct-2506",
    "Qwen3.8-27B",
    "Qwen3.6-27B",
    "Qwen3.5-9B",
    "Qwen3.5-397B-A17B",
    "Qwen3-Coder-30B-A3B-Instruct",
    "Qwen2.5-VL-72B-Instruct",
  ],
  cloudflare: [
    "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    "@cf/deepseek-ai/deepseek-v4-pro-0813",
    "@cf/deepseek-ai/deepseek-v4-flash-0731",
    "@cf/moonshotai/kimi-k2.6",
    "@cf/moonshotai/kimi-k2.7-code",
    "@cf/zai-org/glm-5.3",
    "@cf/zai-org/glm-5.3-flash",
    "@cf/zai-org/glm-5.2",
    "@cf/qwen/qwen3.8-27b",
    "@cf/openai/gpt-oss-120b",
    "@cf/openai/gpt-oss-20b",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  ],
};

const FAMILY_LABEL = {
  openai: "OpenAI",
  gemini: "Gemini",
  mistral: "Mistral",
  groq: "Groq",
  cerebras: "Cerebras",
  sambanova: "SambaNova",
  nvidia: "NVIDIA",
  deepseek: "DeepSeek",
  alibaba: "Alibaba",
  cohere: "Cohere",
  ollama: "Ollama",
  kimi: "Kimi",
  xiaomi: "Xiaomi",
  xai: "xAI",
  perplexity: "Perplexity",
  together: "Together",
  fireworks: "Fireworks",
  nebius: "Nebius",
  siliconflow: "SiliconFlow",
  bigmodel: "BigModel",
  ovh: "OVH",
  cloudflare: "Cloudflare",
};

const FAMILY_DEFAULT_CONTEXT = {
  openai: 272000,
  gemini: 1048576,
  mistral: 131072,
  groq: 131072,
  cerebras: 131072,
  sambanova: 131072,
  nvidia: 131072,
  deepseek: 1048576,
  alibaba: 262144,
  cohere: 131072,
  ollama: 131072,
  kimi: 262144,
  xiaomi: 1048576,
  xai: 1000000,
  perplexity: 200000,
  together: 131072,
  fireworks: 131072,
  nebius: 131072,
  siliconflow: 131072,
  bigmodel: 1048576,
  ovh: 131072,
  cloudflare: 32768,
};

const FAMILY_DEFAULTS = {
  kimi: {
    url: "https://api.moonshot.ai/v1/chat/completions",
    key_env: "KIMI_API_KEY",
  },
  xiaomi: {
    url: "https://api.xiaomimimo.com/v1/chat/completions",
    key_env: "XIAOMI_API_KEY",
  },
  together: {
    url: "https://api.together.xyz/v1/chat/completions",
    key_env: "TOGETHER_API_KEY",
  },
  fireworks: {
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    key_env: "FIREWORKS_API_KEY",
  },
  xai: {
    url: "https://api.x.ai/v1/chat/completions",
    key_env: "XAI_API_KEY",
  },
  perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    key_env: "PERPLEXITY_API_KEY",
  },
  nebius: {
    url: "https://api.studio.nebius.com/v1/chat/completions",
    key_env: "NEBIUS_API_KEY",
  },
};

const NON_CHAT = /(embed|rerank|whisper|tts|asr|transcrib|audio|speech|moderation|guard|ocr|flux|sdxl|stable-diffusion|wan2|video|veo|sora|dall|kling|resnet|bge|indictrans|m2m100|melotts|smart-turn|plamo|distilbert|orpheus|text-to-image|image-generation|cosyvoice|fish-speech|index-tts|z-image|qwen-image|nano-banana|lyria|sourceful)/i;
const BAD_ID = /(^display:)|(^@preset\/)|(pre-mock|skynet|mock_|_mock)/i;
const TINY = /(nano|tiny|(^|[-/_])(1b|3b|4b|7b|8b|9b)([-/_]|$))/i;
const SMALL = /(mini|flash|lite|small|luna|(^|[-/_])(14b|27b|30b|32b|35b|36b)([-/_]|$))/i;
const FLAGSHIP =
  /(^|[-/_])(max|pro|ultra|opus|sonnet|large|k3|k2\.6|k2\.7|gpt-6|gpt-5\.[456]|grok-4|deepseek-v4-pro|glm-5\.[23]|qwen3\.[78]-max|command-a|nemotron-3-ultra|minimax-m3|muse-spark|ember-1)/i;

const CONTEXT_RULES = [
  [/^kimi-k3/i, 1048576],
  [/^kimi-k2/i, 262144],
  [/^mimo-v2\.6/i, 1000000],
  [/^deepseek/i, 1048576],
  [/^gpt-6/i, 272000],
  [/^gpt-5\.[456]/i, 272000],
  [/^gpt-5(\.\d)?$/i, 272000],
  [/^o[34]/i, 200000],
  [/^gemini-(3|4)/i, 1048576],
  [/^gemini-2\.5/i, 1048576],
  [/^grok-4\.(3|20)/i, 1000000],
  [/^grok-4\.[5-7]/i, 500000],
  [/^grok-build/i, 256000],
  [/^glm-5/i, 1048575],
  [/^glm-4\.7/i, 200000],
  [/^qwen3\.8/i, 1000000],
  [/^qwen3\.7/i, 1000000],
  [/^qwen3\.6/i, 262144],
  [/^qwen3\.5/i, 262144],
  [/^qwen-max/i, 131072],
  [/^minimax-m3\.1/i, 1048576],
  [/^minimax-m3/i, 524288],
  [/^mistral-large-4/i, 262144],
  [/^mistral-large/i, 262144],
  [/^mistral-medium/i, 131072],
  [/^mistral-small/i, 131072],
  [/^codestral/i, 256000],
  [/^magistral/i, 131072],
  [/^command-a/i, 256000],
  [/^command-r/i, 128000],
  [/^llama-4/i, 131072],
  [/^gpt-oss/i, 131072],
  [/^nemotron-3-ultra/i, 1000000],
  [/^nemotron-3\.5-super-vl/i, 1048576],
  [/^nemotron-3/i, 131072],
  [/^sonar/i, 200000],
  [/^ember-1/i, 131072],
  [/^muse-spark/i, 1048576],
  [/^muse-glimmer/i, 131072],
  [/^beam/i, 1048576],
  [/^inkling/i, 524288],
  // Provider-qualified identities (Perplexity/Cloudflare/Nebius/Together).
  [/kimi-k3/i, 1048576],
  [/kimi-k2/i, 262144],
  [/deepseek/i, 1048576],
  [/glm-5/i, 1048575],
  [/qwen3\.8/i, 1000000],
  [/gpt-oss/i, 131072],
  [/llama-3\.3/i, 131072],
  [/mistral-large/i, 262144],
  [/grok-4\.(3|20)/i, 1000000],
  [/grok-4\.[5-7]/i, 500000],
  [/minimax-m3\.1/i, 1048576],
  [/minimax-m3/i, 524288],
  [/nemotron-3-ultra/i, 1000000],
  [/nemotron-3/i, 131072],
  [/command-a/i, 256000],
  [/command-r/i, 128000],
  [/sonar/i, 200000],
  [/claude/i, 200000],
  [/gemini/i, 1048576],
  [/gpt-6/i, 272000],
  [/gpt-5/i, 272000],
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function modelKey(family, upstream) {
  return String(family || "") + "|" + String(upstream || "");
}

function isChatModel(model) {
  if (!model || !model.id || model.deprecatedAt) return false;
  if (BAD_ID.test(model.id) || NON_CHAT.test(model.id)) return false;
  if (
    /:[a-z0-9_.-]+$/i.test(model.id) &&
    !["ollama", "cloudflare"].includes(model.providerId)
  )
    return false;
  const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
  if (caps.length > 0 && !caps.includes("text")) return false;
  return true;
}

function priceBlended(priceIndex, family, upstream) {
  const rows = (priceIndex.get(modelKey(family, upstream)) || []).filter(
    (row) =>
      (row.serviceTier || "standard") === "standard" &&
      (row.currency || "USD") === "USD" &&
      Number.isFinite(row.inputPerMTok) &&
      Number.isFinite(row.outputPerMTok),
  );
  if (!rows.length) return null;
  const row = rows[0];
  return (3 * row.inputPerMTok + row.outputPerMTok) / 4;
}

function contextFor(family, upstream, evidenceContext) {
  if (Number.isFinite(evidenceContext) && evidenceContext > 0)
    return evidenceContext;
  const text = String(upstream || "").toLowerCase();
  for (const [pattern, context] of CONTEXT_RULES) {
    if (pattern.test(text)) return context;
  }
  return FAMILY_DEFAULT_CONTEXT[family] || 131072;
}

function maxTokensFor(family, upstream, evidenceMax) {
  if (Number.isFinite(evidenceMax) && evidenceMax > 0) return evidenceMax;
  const text = String(upstream || "").toLowerCase();
  if (/^deepseek/.test(text)) return 384000;
  if (/^claude/.test(text)) return 64000;
  if (/^gemini/.test(text)) return 65536;
  if (/^gpt-6|^gpt-5\.[56]/.test(text)) return 128000;
  return null;
}

function normalizeCaps(evidenceCaps) {
  const caps = new Set(["text"]);
  for (const cap of evidenceCaps || []) {
    if (cap === "tools") caps.add("tools");
    if (cap === "coding") caps.add("coding");
    if (cap === "images" || cap === "vision") caps.add("images");
    if (cap === "thinking" || cap === "reasoning") caps.add("thinking");
    if (cap === "text") caps.add("text");
  }
  return caps;
}

function capsFor(family, upstream, context, evidenceCaps) {
  const text = String(upstream || "").toLowerCase();
  const caps = normalizeCaps(evidenceCaps);
  if (
    !caps.has("thinking") &&
    !/non-reasoning|nonreasoning/.test(text) &&
    /reason|think|r1|o[1-4]|qwq|k3|k2\.[67]|glm-5|deepseek|minimax-m3|nemotron-3|grok-4|qwen3\.[78]|mistral-large-4|command-a-reason|magistral|gpt-6|gpt-5|claude|mimo/.test(
      text,
    )
  )
    caps.add("thinking");
  if (
    !caps.has("tools") &&
    /gpt|claude|gemini|grok|qwen|glm|kimi|deepseek|minimax|mistral|command|llama|nemotron|muse|beam|ember|inkling|sonar|step|hy3|hermes|mimo|clef/.test(
      text,
    )
  )
    caps.add("tools");
  if (
    caps.has("tools") &&
    !/sonar|command-a-translate|muse-glimmer|ternary|tev1/.test(text)
  )
    caps.add("coding");
  if (
    !caps.has("images") &&
    /gemini|claude|gpt-4o|gpt-6|gpt-5\.6|grok-4\.20-multi|vl|vision|pixtral|omni|minicpm-v|muse-glimmer/.test(
      text,
    )
  )
    caps.add("images");
  if (context >= 128000) caps.add("max");
  return [...caps];
}

function tierFor(family, upstream, context, priceIndex) {
  const text = String(upstream || "").toLowerCase();
  const blended = priceBlended(priceIndex, family, upstream);
  if (FLAGSHIP.test(text) && !SMALL.test(text)) return 1;
  if (TINY.test(text)) return 3;
  if (SMALL.test(text)) return 2;
  if (blended !== null && blended >= 5) return 1;
  if (blended !== null && blended < 0.1) return 3;
  return 2;
}

function displayNameFor(model) {
  const supplied = model.displayName;
  if (
    supplied &&
    supplied !== model.id &&
    /[A-Z\s]/.test(supplied)
  )
    return supplied;
  let text = String(model.upstreamModel || model.id || "")
    .split("/")
    .pop()
    .replace(/^@cf\//, "")
    .replace(/(\d)p(\d)/gi, "$1.$2")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const acronyms = {
    gpt: "GPT",
    oss: "OSS",
    glm: "GLM",
    vl: "VL",
    it: "IT",
    ai: "AI",
    api: "API",
    llm: "LLM",
    asr: "ASR",
    tts: "TTS",
    ocr: "OCR",
    xai: "xAI",
  };
  text = text
    .split(" ")
    .map(
      (word) =>
        acronyms[word.toLowerCase()] ||
        word.replace(/^[a-z]/, (letter) => letter.toUpperCase()),
    )
    .join(" ");
  return text
    .replace(/\bMimo\b/g, "MiMo")
    .replace(/\bDeepseek\b/g, "DeepSeek")
    .replace(/\bOpenai\b/g, "OpenAI")
    .replace(/\bNvidia\b/g, "NVIDIA")
    .replace(/\bSiliconflow\b/g, "SiliconFlow")
    .replace(/\bBigmodel\b/g, "BigModel");
}

function shortName(display, used) {
  const base = String(display || "Model")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 22) || "Model";
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = base.slice(0, 19) + index;
    index += 1;
  }
  used.add(name);
  return name;
}

function templateFor(family, normalizedSeed) {
  const found = normalizedSeed.find((provider) => provider.family === family);
  if (found) {
    return {
      protocol: found.protocol || "openai",
      url: found.url,
      key_env: found.key_env || "",
      headers: found.headers || {},
      ...(found.no_auth ? { no_auth: true } : {}),
      ...(found.default_key ? { default_key: found.default_key } : {}),
    };
  }
  return {
    protocol: "openai",
    headers: {},
    ...(FAMILY_DEFAULTS[family] || {}),
  };
}

function buildSeed(seed, catalog) {
  const providers = JSON.parse(JSON.stringify(seed.providers || []));
  const groups = seed.groups || {};
  const normalized = providers.map((provider) =>
    providerConfig.normalizeSeedProvider(provider),
  );
  const evidenceByKey = new Map(
    (catalog.models || []).map((model) => [
      modelKey(model.providerId, model.upstreamModel || model.id),
      model,
    ]),
  );
  const priceIndex = new Map();
  for (const price of catalog.prices || []) {
    const key = modelKey(price.providerId, price.upstreamModel);
    if (!priceIndex.has(key)) priceIndex.set(key, []);
    priceIndex.get(key).push(price);
  }

  let metadataFilled = 0;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const normalizedProvider = normalized[index];
    const evidence = evidenceByKey.get(
      modelKey(
        normalizedProvider.family,
        normalizedProvider.upstream_model || normalizedProvider.model,
      ),
    );
    if (!evidence) continue;
    let changed = false;
    if (
      Number.isFinite(evidence.contextWindow) &&
      evidence.contextWindow > 0 &&
      (!Number.isFinite(provider.context) ||
        provider.context < evidence.contextWindow)
    ) {
      provider.context = evidence.contextWindow;
      changed = true;
    }
    if (
      Number.isFinite(evidence.maxOutputTokens) &&
      evidence.maxOutputTokens > 0 &&
      !Number.isFinite(provider.max_tokens)
    ) {
      provider.max_tokens = evidence.maxOutputTokens;
      changed = true;
    }
    const context = provider.context || normalizedProvider.context || 131072;
    const caps = new Set(provider.caps || normalizedProvider.caps || ["text"]);
    for (const cap of normalizeCaps(evidence.capabilities)) caps.add(cap);
    if (context >= 128000) caps.add("max");
    if (caps.size !== (provider.caps || []).length) {
      provider.caps = [...caps];
      changed = true;
    }
    if (caps.has("thinking") && provider.tc !== true) {
      provider.tc = true;
      changed = true;
    }
    if (!provider.display_name && evidence.displayName) {
      provider.display_name = evidence.displayName;
      changed = true;
    }
    if (!provider.source && evidence.source) {
      provider.source = evidence.source;
      provider.source_type = "public_catalog";
      changed = true;
    }
    if (caps.has("images") && !provider.input_modalities) {
      provider.input_modalities = ["text", "image"];
      changed = true;
    }
    if (changed) metadataFilled += 1;
  }

  const existing = new Set(
    normalized.map((provider) =>
      modelKey(provider.family, provider.upstream_model || provider.model),
    ),
  );
  const usedNames = new Set(providers.map((provider) => provider.name));
  const added = [];
  const add = (family, model) => {
    const upstream = model.upstreamModel || model.id;
    const key = modelKey(family, upstream);
    if (existing.has(key)) return;
    const namespace = String(upstream).startsWith(family + "/")
      ? String(upstream).slice(family.length + 1)
      : upstream;
    const context = contextFor(family, upstream, model.contextWindow);
    const caps = capsFor(family, upstream, context, model.capabilities);
    const tier = tierFor(family, upstream, context, priceIndex);
    const display = displayNameFor(model);
    const maxTokens = maxTokensFor(family, upstream, model.maxOutputTokens);
    const template = templateFor(family, normalized);
    const entry = {
      name: `${FAMILY_LABEL[family] || family}-${shortName(display, usedNames)}`,
      family,
      protocol: template.protocol || "openai",
      url: template.url,
      key_env: template.key_env || "",
      model: `${family}/${namespace}`,
      upstream_model: upstream,
      context,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      tier,
      tc: caps.includes("thinking"),
      caps,
      headers: template.headers || {},
      ...(template.no_auth ? { no_auth: true } : {}),
      ...(template.default_key ? { default_key: template.default_key } : {}),
      display_name: display,
      input_modalities: caps.includes("images") ? ["text", "image"] : ["text"],
      source: model.source,
      source_type: "public_catalog",
      seed: true,
      probe: false,
      probe_skip_reason: "catalog_only_no_inference",
    };
    providers.push(entry);
    existing.add(key);
    added.push({ family, upstream, name: entry.name });
  };

  for (const family of FULL_FAMILIES) {
    for (const model of catalog.models || []) {
      if (model.providerId !== family || !isChatModel(model)) continue;
      add(family, model);
    }
  }
  for (const [family, ids] of Object.entries(CURATED)) {
    if (SKIP_FAMILIES.has(family)) continue;
    const byId = new Map(
      (catalog.models || [])
        .filter((model) => model.providerId === family)
        .map((model) => [model.id, model]),
    );
    for (const id of ids) {
      const model = byId.get(id);
      if (model && isChatModel(model)) add(family, model);
    }
  }

  return { seed: { ...seed, providers, groups }, added, metadataFilled };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  const write = args.includes("--write");
  const seedPath = path.resolve(arg("--seed", DEFAULT_SEED));
  const catalogPath = path.resolve(arg("--catalog", DEFAULT_CATALOG));
  const seed = readJson(seedPath);
  const catalog = readJson(catalogPath);
  const result = buildSeed(seed, catalog);
  const byFamily = {};
  for (const row of result.added)
    byFamily[row.family] = (byFamily[row.family] || 0) + 1;
  const summary = {
    added: result.added.length,
    addedByFamily: byFamily,
    metadataFilled: result.metadataFilled,
    total: result.seed.providers.length,
    written: false,
  };
  if (write) {
    const tmp = seedPath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result.seed, null, 2) + "\n");
    fs.renameSync(tmp, seedPath);
    summary.written = true;
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();

module.exports = {
  buildSeed,
  isChatModel,
  contextFor,
  capsFor,
  tierFor,
  displayNameFor,
};
