const fs = require('fs');
const path = require('path');
const providerConfig = require('../lib/provider-config');

const PROVIDERS_FILE = path.join(__dirname, 'providers.json');

if (fs.existsSync(PROVIDERS_FILE)) {
  const config = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
  let changed = false;

  config.providers = config.providers.map(p => {
    if (!p.family && p.model) {
      // Infer family from key_env or model name if possible, fallback to openrouter or openai
      if (p.key_env === 'COPILOT_TOKEN') p.family = 'copilot';
      else if (p.key_env === 'WINDSURF_API_KEY' || p.key_env === 'WINDSURF_TOKEN') p.family = 'windsurf';
      else if (p.key_env === 'CODEX_API_KEY') p.family = 'codex';
      else if (p.key_env === 'MISTRAL_API_KEY') p.family = 'mistral';
      else if (p.key_env === 'GROQ_API_KEY') p.family = 'groq';
      else if (p.key_env === 'GEMINI_API_KEY') p.family = 'gemini';
      else if (p.key_env === 'DEEPSEEK_API_KEY') p.family = 'deepseek';
      else if (p.key_env === 'CEREBRAS_API_KEY') p.family = 'cerebras';
      else if (p.key_env === 'SAMBANOVA_API_KEY') p.family = 'sambanova';
      else if (p.key_env === 'NVIDIA_API_KEY') p.family = 'nvidia';
      else if (p.key_env === 'OPENROUTER_API_KEY') p.family = 'openrouter';
      else p.family = 'openai';
      
      p.protocol = providerConfig.SUPPORTED_PROTOCOLS[p.family] || 'openai';
      changed = true;
    }
    
    // Ensure model ID starts with family/
    if (p.family && p.model && !p.model.startsWith(p.family + '/')) {
      p.upstream_model = p.model;
      p.model = p.family + '/' + p.model;
      changed = true;
    }
    return p;
  });

  if (changed) {
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(config, null, 2));
    console.log('Fixed providers.json namespacing');
  } else {
    console.log('providers.json already correctly namespaced');
  }
}
