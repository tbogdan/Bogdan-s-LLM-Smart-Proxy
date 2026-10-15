const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../lib/providers');
test('merged runtime hydrates namespaced legacy seed providers and Cloudflare accounts', () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'fixture-account';
  try {
    const result = providers.hydrateSeedProviders({ providers: [
      { name: 'Legacy-Groq', family: 'groq', protocol: 'openai', model: 'groq/llama', url: 'https://api.groq.com/openai/v1/chat/completions', key_env: 'GROQ_API_KEY', tc: true },
      { name: 'CF', family: 'cloudflare', protocol: 'openai', model: 'cloudflare/test', url: 'https://api.cloudflare.com/client/v4/accounts/me/ai/v1/chat/completions', key_env: 'CLOUDFLARE_API_KEY' }
    ] });
    assert.equal(result.providers.length, 2);
    assert.equal(result.providers[1].url.includes('/accounts/fixture-account/'), true);
  } finally { delete process.env.CLOUDFLARE_ACCOUNT_ID; }
});
