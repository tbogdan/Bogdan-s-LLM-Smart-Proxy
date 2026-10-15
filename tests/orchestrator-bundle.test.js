const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('embedded orchestrator loads real classification without sibling checkout', async () => {
 const bridge = require('../lib/orchestrator-bridge');
 const core = await bridge.loadOrchestrator();
 assert.equal(core.classify({task_type:'FEATURE', complexity:'MODERATE'}).tier, 'S');
 const provenance = require('../vendor/llm-orchestrator/provenance.json');
 assert.equal(provenance.sourceSha.length,40);
 assert.ok(fs.existsSync(path.join(__dirname,'../vendor/llm-orchestrator/NOTICE')));
 assert.ok(!fs.existsSync(path.join(__dirname,'../vendor/llm-orchestrator/.git')));
});
