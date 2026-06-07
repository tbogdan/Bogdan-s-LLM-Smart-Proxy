const fs = require('fs');
const env = fs.readFileSync('.env.example', 'utf8');
const required = [
  'OPENAI_API_KEY=',
  'OPENROUTER_API_KEY=',
  'ANTHROPIC_API_KEY=',
  'COPILOT_GITHUB_TOKEN=',
  'WINDSURF_API_KEY=',
  'KIRO_API_KEY=',
  'REFRESH_TOKEN=',
];
const missing = required.filter((key) => !env.includes(key));
if (missing.length) {
  throw new Error(`Missing env keys: ${missing.join(', ')}`);
}
console.log('provider env union ok');
