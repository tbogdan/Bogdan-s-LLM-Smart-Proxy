const fs = require('fs');
const env = fs.readFileSync('.env.example', 'utf8');
const required = [
  'MEMORY_ENABLED=',
  'MEMORY_BACKEND=',
  'MEMORY_MAX_INJECT_TOKENS=',
  'MEMORY_ARCHIVE_MAX_CHARS=',
  'NEO4J_URI=',
  'GRAPHITI_MCP_URL=',
];
const missing = required.filter((line) => !env.includes(line));
if (missing.length) throw new Error(`Missing memory env lines: ${missing.join(', ')}`);
console.log('memory env ok');
