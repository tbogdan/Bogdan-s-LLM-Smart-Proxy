const fs = require('fs');
const source = fs.readFileSync('llm-proxy.js', 'utf8');
const required = ['/commands', '/benchmark', '/discovery', '/stats', '/scores', '/health', '/v1/chat/completions', '/v1/responses', '/v1/models', '/v1/capabilities'];
const missing = required.filter((route) => !source.includes(route));
if (missing.length) {
  throw new Error(`Missing routes: ${missing.join(', ')}`);
}
console.log('route presence ok');
