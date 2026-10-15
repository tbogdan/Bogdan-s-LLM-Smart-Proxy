"use strict";
let corePromise;
function loadOrchestrator() { return corePromise ||= import('../vendor/llm-orchestrator/lib/router.mjs'); }
async function rankTaskCandidates({ profile = {}, inventory, role, taskAllocation } = {}) {
 const core = await loadOrchestrator();
 const classification = core.classify({ task_type: profile.task_type || 'FEATURE', complexity: profile.complexity || 'MODERATE', ...(profile.risk ? {risk:profile.risk}:{}), ...(role ? {role}: {}) });
 const ranked = core.rankModels({ pair: classification.pair, inventory });
 const allowed = taskAllocation?.models;
 return { ranked: allowed ? ranked.filter(r => allowed.includes(r.model_requested || r.model?.key || r.key)) : ranked, classification, exclusions: [], inventoryRevision: inventory?.revision || null };
}
async function buildProxyFlow({ taskType='FEATURE', complexity='MODERATE' }={}) {
 const core=await loadOrchestrator();
 return core.estimateFlow(taskType,complexity);
}
module.exports={loadOrchestrator,rankTaskCandidates,buildProxyFlow};
