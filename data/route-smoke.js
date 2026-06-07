const fs = require('fs');
const source = fs.readFileSync('llm-proxy.js', 'utf8');
const required = ['/ban', '/unban', '/banned', '/v1/chat/completions', '/v1/responses', '/v1/models'];
const missing = required.filter((route) => !source.includes(route));
if (missing.length) {
  throw new Error(`Missing routes: ${missing.join(', ')}`);
}
console.log('route presence ok');
