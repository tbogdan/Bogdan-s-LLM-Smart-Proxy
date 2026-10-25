// llm-orchestrator · created by Bogdan-Gabriel Torcescu · https://www.linkedin.com/in/bogdantorcescu/ · keep this credit when copying or deriving
/**
 * Impeccable is the domain-conditional mandatory item for UI work: capability
 * `ui.design_system`, implementation `impeccable`. One registry entry
 * (registries/core-profile.json) is the source of truth; every file that restates it
 * is checked against it here, and the resolver must never let another design skill
 * stand in for it silently.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveCapabilities } from '../lib/capability-resolver.mjs';
import { discoverProject } from '../lib/project-discovery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => readFileSync(root + relative, 'utf8');
const json = (relative) => JSON.parse(read(relative));
const fixture = (name) => fileURLToPath(new URL(`../fixtures/discovery/${name}/`, import.meta.url));

const execFileAsync = promisify(execFile);
// Impeccable 4.5.2 SKILL.md command table, minus `craft` (a deprecated alias for ordinary new work).
const IMPECCABLE_COMMANDS = new Set(['shape', 'init', 'document', 'extract', 'critique', 'audit', 'polish', 'bolder', 'quieter', 'distill', 'harden', 'onboard', 'animate', 'colorize', 'typeset', 'layout', 'delight', 'overdrive', 'clarify', 'adapt', 'optimize', 'live', 'generate']);
const INSTALL = '`npx impeccable install` (shell, project root); or in Claude Code: `/plugin marketplace add pbakaus/impeccable` then `/plugin install impeccable@impeccable`';
const COMPLEMENTS = ['ui-ux-pro-max', 'frontend-design', 'design-system', 'ui-styling', 'web-design-guidelines'];
const requirement = () => json('registries/core-profile.json').requirements.find((entry) => entry.id === 'ui.design_system');
const tool = () => json('registries/preferred-tools.json').tools.find((entry) => entry.id === 'impeccable');
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing section ${start}`);
  const to = end ? text.indexOf(end, from + start.length) : -1;
  return text.slice(from, to > from ? to : undefined);
};

// ---------------------------------------------------------------- registry
test('impeccable is a registered skill implementation of ui.design_system with verified install routes', () => {
  const entry = tool();
  assert.ok(entry, 'registries/preferred-tools.json has no impeccable entry');
  assert.equal(entry.kind, 'skill');
  assert.deepEqual(entry.capabilities, ['ui.design_system']);
  assert.ok(entry.aliases.includes('impeccable:impeccable'), 'the Claude Code plugin-namespaced id must be an alias');
  assert.equal(entry.installable, true);
  assert.equal(entry.recommendation_kind, 'product');
  assert.equal(entry.source_url, 'https://impeccable.style');
  assert.equal(entry.install, INSTALL, 'shell and slash routes are separated in plain language, never with || or &&');
  assert.doesNotMatch(entry.install, /\|\||&&/);
});

test('ui.design_system is a domain-conditional mandatory core requirement bound exclusively to impeccable', () => {
  const entry = requirement();
  assert.ok(entry, 'core-profile.json has no ui.design_system requirement');
  assert.equal(entry.level, 'mandatory');
  assert.equal(entry.domain_conditional, true);
  assert.deepEqual(entry.preferred_implementations, ['impeccable']);
  assert.deepEqual(entry.allowed_alternatives, []);
  assert.equal(entry.exclusive_implementations, true);
  assert.equal(entry.gap_declared_first, true);
  assert.equal(entry.degraded_mode_after_refusal, true);
  assert.deepEqual([...entry.complements].sort(), [...COMPLEMENTS].sort());
  const triggers = entry.applies_when.any_of;
  assert.ok(triggers.some((condition) => condition.any_task_domains?.includes('frontend')));
  assert.ok(triggers.some((condition) => condition.any_task_signals?.includes('web-ui')));
  assert.ok(entry.order > 12, 'must come after the twelve unconditional mandatory items');
  for (const [type, phases] of Object.entries(entry.phase_commands)) {
    assert.ok(json('registries/task-mappings.json').task_types.some((item) => item.id === type), `phase_commands names unknown task id ${type}`);
    for (const commands of Object.values(phases)) {
      assert.ok(commands.length > 0);
      for (const command of commands) assert.ok(IMPECCABLE_COMMANDS.has(command), `phase_commands.${type} names ${command}, which is not a current impeccable command`);
    }
  }
  assert.ok(json('registries/capabilities.json').capabilities.some((cap) => cap.id === 'ui.design_system' && /impeccable/i.test(cap.description)));
});

test('every UI-capable task mapping lists ui.design_system as mandatory via impeccable, never optional', () => {
  const mappings = json('registries/task-mappings.json').mappings;
  for (const id of ['feature', 'bug-incident', 'refactor', 'review', 'investigation']) {
    const mapping = mappings.find((item) => item.id === id);
    const mandatory = mapping.obligations.mandatory.find((item) => item.capability === 'ui.design_system');
    assert.ok(mandatory, `${id} obligations.mandatory is missing ui.design_system`);
    assert.deepEqual(mandatory.preferred_implementations, ['impeccable']);
    assert.deepEqual(mandatory.allowed_alternatives, []);
    assert.ok(![...mapping.obligations.optional, ...mapping.obligations.available].some((item) => item.capability === 'ui.design_system'), `${id}: ui.design_system must not also be optional or available`);
  }
  // No capability + implementation pair sits at two obligation levels of the same mapping. A
  // capability may recur only through a different tool (e.g. code.locate: tracer optional,
  // cavecrew investigator available).
  for (const mapping of mappings.filter((item) => item.obligations)) {
    const seen = new Map();
    for (const [level, items] of Object.entries(mapping.obligations)) {
      for (const item of items) {
        for (const implementation of item.preferred_implementations) {
          const key = `${item.capability} via ${implementation}`;
          assert.ok(!seen.has(key) || seen.get(key) === level, `${mapping.id}: ${key} is both ${seen.get(key)} and ${level}`);
          seen.set(key, level);
        }
      }
    }
  }
  const perType = between(read('policies/capabilities.md'), '## Per task type', '## Mandatory MCP by use case').split('\n');
  for (const type of ['FEATURE', 'BUG_FIX', 'REFACTOR', 'REVIEW', 'INVESTIGATION']) {
    const row = perType.find((line) => line.startsWith(`| **${type}** |`));
    assert.ok(row && row.split('|')[2].includes('`impeccable`'), `capabilities.md ${type} Mandatory column must name impeccable`);
  }
});

test('no shipped file still routes Build through the deprecated craft alias', () => {
  for (const file of ['registries/core-profile.json', 'registries/agent-roles.json', 'registries/task-mappings.json', 'agents/frontend-fixer.md', 'agents/frontend-specialist.md', 'workflows/feature.md', 'SKILL.md', 'README.md', 'policies/capabilities.md', 'commands/task.md']) {
    assert.doesNotMatch(read(file), /\/impeccable craft|"craft"|`craft`/, `${file} still names craft`);
  }
});

// ---------------------------------------------------------------- resolver
const designSystemSkill = { id: 'design-system', kind: 'skill', capabilities: ['ui.design_system'], scope: 'project', status: 'loaded', permission: 'read_only', evidence: ['skill-list'] };
const impeccableSkill = { id: 'impeccable:impeccable', kind: 'skill', capabilities: ['ui.design_system'], scope: 'user', status: 'loaded', permission: 'read_only', evidence: ['skill-list'] };
const plan = (task, entries = [], decisions = []) => resolveCapabilities({ task, phase: 'planning', inventory: { entries }, decisions });
const uiRequirement = (result) => result.mandatory.find((item) => item.id === 'ui.design_system');

test('resolver: a FRONTEND-domain task or a UI signal makes ui.design_system mandatory; a backend task does not', () => {
  assert.ok(uiRequirement(plan({ type: 'FEATURE', domain: 'FRONTEND' })), 'domain FRONTEND');
  assert.ok(uiRequirement(plan({ type: 'BUG_FIX', signals: ['visual-bug'] })), 'visual-bug signal');
  assert.ok(uiRequirement(plan({ type: 'REVIEW', signals: ['ui-review'] })), 'ui-review signal');
  assert.equal(uiRequirement(plan({ type: 'FEATURE', domain: 'BACKEND' })), undefined);
  // A backend task stays backend even inside a frontend project: the trigger is the task, not the repo.
  const frontendProfile = { domains: ['frontend', 'web'], frameworks: ['react'] };
  assert.equal(uiRequirement(resolveCapabilities({ profile: frontendProfile, task: { type: 'FEATURE', domain: 'BACKEND' }, phase: 'planning', inventory: { entries: [] } })), undefined);
  assert.equal(uiRequirement(plan({ type: 'CONFIG' })), undefined);
});

test('resolver: another design skill never satisfies ui.design_system silently; the gap names impeccable', () => {
  const result = plan({ type: 'FEATURE', domain: 'FRONTEND' }, [designSystemSkill]);
  assert.equal(uiRequirement(result).status, 'blocked_pending_user');
  assert.equal(result.bindings['ui.design_system'], undefined);
  const gap = result.gaps.find((item) => item.capability === 'ui.design_system');
  assert.equal(gap?.recommendation, 'impeccable');
  assert.ok(result.recommendations.some((item) => item.capability === 'ui.design_system' && item.implementation === 'impeccable' && item.blocks));
});

test('resolver: a loaded impeccable (plugin-namespaced id) satisfies ui.design_system', () => {
  const result = plan({ type: 'FEATURE', domain: 'FRONTEND' }, [designSystemSkill, impeccableSkill]);
  assert.equal(uiRequirement(result).status, 'satisfied');
  assert.equal(result.bindings['ui.design_system'].implementation, 'impeccable:impeccable');
});

test('resolver: only an explicit refusal degrades ui.design_system, and a substitute still does not bind', () => {
  const declined = [{ capability: 'ui.design_system', implementation: 'impeccable', installation: 'declined' }];
  const result = plan({ type: 'FEATURE', domain: 'FRONTEND' }, [designSystemSkill], declined);
  assert.equal(uiRequirement(result).status, 'degraded');
  assert.equal(result.bindings['ui.design_system'], undefined);
  assert.ok(result.warnings.some((line) => line.startsWith('degraded: ui.design_system')));
});

test('resolver: an explicit user binding to a substitute is the refusal that degrades, with both warnings', () => {
  const decisions = [{ capability: 'ui.design_system', source: 'user', binding: 'design-system' }];
  const result = plan({ type: 'FEATURE', domain: 'FRONTEND' }, [designSystemSkill], decisions);
  assert.equal(uiRequirement(result).status, 'degraded');
  assert.equal(result.bindings['ui.design_system'], undefined);
  assert.ok(result.warnings.includes('exclusive: ui.design_system ignores binding design-system'));
  assert.ok(result.warnings.some((line) => line.startsWith('degraded: ui.design_system')));
  assert.ok(result.fallback_plan.some((item) => item.capability === 'ui.design_system' && item.reason === 'user-chose-substitute'));
});

test('resolver: declining a complement is not choosing a substitute; declining impeccable degrades', () => {
  const declineComplement = [{ capability: 'ui.design_system', implementation: 'design-system', installation: 'declined', source: 'user' }];
  const kept = plan({ type: 'FEATURE', domain: 'FRONTEND' }, [], declineComplement);
  assert.equal(uiRequirement(kept).status, 'blocked_pending_user');
  assert.ok(!kept.warnings.some((line) => line.startsWith('exclusive:') || line.startsWith('degraded: ui.design_system')));
  const declineImpeccable = [{ capability: 'ui.design_system', implementation: 'impeccable', installation: 'declined', source: 'user' }];
  const degradedPlan = plan({ type: 'FEATURE', domain: 'FRONTEND' }, [], declineImpeccable);
  assert.equal(uiRequirement(degradedPlan).status, 'degraded');
  assert.ok(!degradedPlan.warnings.some((line) => line.startsWith('exclusive:')));
});

test('resolver: a project binding to a substitute is reported, not obeyed, and is not a refusal', () => {
  const result = resolveCapabilities({ profile: { bindings: { 'ui.design_system': 'design-system' } }, task: { type: 'FEATURE', domain: 'FRONTEND' }, phase: 'planning', inventory: { entries: [designSystemSkill] } });
  assert.equal(uiRequirement(result).status, 'blocked_pending_user');
  assert.ok(result.warnings.includes('exclusive: ui.design_system ignores binding design-system'));
});

test('resolver: exclusivity is opt-in; requirements without it keep their existing fallback binding', () => {
  const nativeMemory = { id: 'native-memory', kind: 'native_tool', capabilities: ['memory.recall'], scope: 'harness', status: 'callable', permission: 'read_only', evidence: ['native'] };
  const result = plan({ type: 'FEATURE' }, [nativeMemory]);
  assert.equal(result.bindings['memory.recall']?.implementation, 'native-memory');
});

// ---------------------------------------------------------------- roles
test('frontend roles carry impeccable, and the reviewer runs it on UI diffs', () => {
  const roles = json('registries/agent-roles.json').roles;
  for (const id of ['frontend-fixer', 'frontend-specialist']) {
    const role = roles.find((item) => item.id === id);
    assert.equal(role.skills[0], 'impeccable', `${id} must list impeccable first`);
    assert.ok(role.capabilities.includes('ui.design_system'));
    assert.ok(role.charter.principles.some((line) => line.includes('/impeccable')), `${id} charter must say which impeccable command to run`);
  }
  const reviewer = roles.find((item) => item.id === 'code-reviewer');
  const line = reviewer.charter.principles.find((item) => item.includes('/impeccable critique'));
  assert.ok(line && line.includes('/impeccable audit'), 'code-reviewer must run critique + audit on UI diffs');
  for (const id of ['frontend-fixer', 'frontend-specialist', 'code-reviewer']) {
    assert.match(read(`agents/${id}.md`), /impeccable/, `agents/${id}.md is stale; regenerate it`);
  }
});

// ---------------------------------------------------------------- coherence
test('coherence 3c: every domain-conditional mandatory item is restated in SKILL, capabilities, checklist, README and first-run', () => {
  const conditional = json('registries/core-profile.json').requirements.filter((entry) => entry.level === 'mandatory' && entry.domain_conditional === true);
  assert.ok(conditional.length >= 1);
  const tools = json('registries/preferred-tools.json').tools;
  const skill = between(read('SKILL.md'), '## Mandatory core tools', '### When a mandatory item');
  const capabilities = between(read('policies/capabilities.md'), '### Mandatory by domain', '## Per task type');
  const everyTask = between(read('policies/capabilities.md'), '## Mandatory on every task', '### Mandatory by domain');
  const checklist = between(read('adapters/commands.mjs'), 'const MANDATORY_CHECKLIST', 'Questions: native');
  const readme = between(read('README.md'), '### The 8 mandatory core tools', '### Registries');
  const firstRun = read('lib/first-run.mjs');
  for (const entry of conditional) {
    const implementation = entry.preferred_implementations[0];
    assert.ok(!everyTask.includes(entry.id), `policies/capabilities.md lists ${entry.id} under "Mandatory on every task"`);
    // One identifier for the item wherever it is numbered: D<n>, never a core order.
    for (const [label, text] of [['policies/capabilities.md', capabilities], ['adapters/commands.mjs', checklist]]) {
      assert.match(text, new RegExp(`D\\d+[.|\\s][^\\n]*${implementation}`), `${label} must number ${implementation} as D<n>`);
    }
    for (const [label, text] of [['SKILL.md', skill], ['policies/capabilities.md', capabilities], ['adapters/commands.mjs', checklist], ['README.md', readme]]) {
      assert.ok(text.includes(entry.id), `${label} mandatory section is missing ${entry.id}`);
      assert.ok(text.includes(`\`${implementation}\``) || text.includes(implementation), `${label} mandatory section is missing ${implementation}`);
      assert.match(text, /never (silently )?substitut/i, `${label} must say complements never substitute`);
    }
    assert.ok(firstRun.includes(`{ id: '${entry.id}', tool: '${implementation}'`), `lib/first-run.mjs does not check ${entry.id}`);
    const registered = tools.find((item) => item.id === implementation);
    for (const [, route] of registered.install.matchAll(/`([^`]+)`/g)) {
      assert.ok(readme.includes(route), `README is missing the install route ${route}`);
    }
  }
  // The rendered task command carries the conditional checklist item.
  assert.match(read('commands/task.md'), /impeccable[\s\S]*ui\.design_system/);
});

test('workflows name the impeccable command for each phase the registry maps', () => {
  const entry = requirement();
  const mapping = json('registries/task-mappings.json').task_types;
  for (const [type, phases] of Object.entries(entry.phase_commands)) {
    const file = mapping.find((item) => item.id === type).workflow;
    const text = read(file);
    for (const commands of Object.values(phases)) {
      for (const command of commands) assert.ok(text.includes(`/impeccable ${command}`), `${file} does not name /impeccable ${command}`);
    }
  }
  assert.match(read('workflows/feature.md'), /PRODUCT\.md/);
});

test('other design skills are documented as complements, never substitutes', () => {
  const text = read('policies/capabilities.md');
  const uiRow = text.split('\n').find((line) => line.startsWith('| UI / frontend'));
  assert.ok(uiRow, 'Skill selection by job is missing the UI / frontend row');
  assert.ok(uiRow.indexOf('`impeccable`') > 0 && uiRow.indexOf('`impeccable`') < uiRow.indexOf('ui-ux-pro-max'), 'impeccable must lead the UI row');
  assert.match(uiRow, /complement/i);
  assert.ok(!/design-system \+ UI-styling skills \(any new UI\)/.test(text), 'the old optional design-system row must be replaced');
});

// ---------------------------------------------------------------- discovery + first run
test('discovery marks a UI framework project with the frontend domain, and a Python API without it', async () => {
  assert.ok((await discoverProject({ root: fixture('web-monorepo') })).domains.includes('frontend'));
  assert.ok(!(await discoverProject({ root: fixture('python-service') })).domains.includes('frontend'));
});

test('first run reports a missing impeccable as a gap with its install hint on a frontend project only', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'impeccable-home-'));
  const work = await mkdtemp(join(tmpdir(), 'impeccable-project-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });
  const { checkConditionalMandatoryTools, runInit, formatInitReport } = await import('../lib/first-run.mjs');

  const frontend = await checkConditionalMandatoryTools(fixture('web-monorepo'));
  const item = frontend.find((entry) => entry.id === 'ui.design_system');
  assert.equal(item.tool, 'impeccable');
  assert.equal(item.applies, true);
  assert.equal(item.present, false);
  assert.equal(item.install_hint, tool().install);

  const backend = await checkConditionalMandatoryTools(fixture('python-service'));
  assert.equal(backend.find((entry) => entry.id === 'ui.design_system').applies, false);

  const report = await runInit({ project: fixture('web-monorepo'), harnesses: ['claude'], packageRoot: root, stateRoot: join(home, 'state'), skillsRoot: join(home, 'skills') });
  assert.ok(report.missing_mandatory_tools.some((entry) => entry.id === 'ui.design_system'));
  const text = formatInitReport(report);
  assert.match(text, /Mandatory when the task is frontend\/UI/);
  assert.ok(text.includes(`[MISSING] ui.design_system (impeccable) — install: ${INSTALL}`));

  const backendReport = await runInit({ project: fixture('python-service'), harnesses: ['claude'], packageRoot: root, stateRoot: join(home, 'state'), skillsRoot: join(home, 'skills') });
  assert.ok(!backendReport.missing_mandatory_tools.some((entry) => entry.id === 'ui.design_system'));

  await cp(fixture('web-monorepo'), work, { recursive: true });
  await mkdir(join(work, '.claude', 'skills', 'impeccable'), { recursive: true });
  const installed = await checkConditionalMandatoryTools(work);
  assert.equal(installed.find((entry) => entry.id === 'ui.design_system').present, true);
});

test('first run finds impeccable in every skill root `npx impeccable install` writes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'impeccable-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const { checkConditionalMandatoryTools } = await import('../lib/first-run.mjs');
  const present = async (project) => (await checkConditionalMandatoryTools(project, { profile: { domains: ['frontend'] } }))[0].present;
  for (const folder of ['.agents', '.claude', '.codex', '.cursor', '.gemini', '.github', '.opencode']) {
    const work = await mkdtemp(join(tmpdir(), 'impeccable-root-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    assert.equal(await present(work), false, `${folder}: nothing installed yet`);
    await mkdir(join(work, folder, 'skills', 'impeccable'), { recursive: true });
    assert.equal(await present(work), true, `project ${folder}/skills/impeccable is not detected`);
  }
  const empty = await mkdtemp(join(tmpdir(), 'impeccable-root-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  for (const folder of ['.codex', '.cursor', '.gemini']) {
    await rm(join(home, '.codex'), { recursive: true, force: true });
    await rm(join(home, '.cursor'), { recursive: true, force: true });
    await rm(join(home, '.gemini'), { recursive: true, force: true });
    await mkdir(join(home, folder, 'skills', 'impeccable'), { recursive: true });
    assert.equal(await present(empty), true, `~/${folder}/skills/impeccable is not detected`);
  }
});

test('doctor --domain passes the task domain, so a FRONTEND task reports the impeccable gap with its hint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'impeccable-home-'));
  try {
    const run = async (...extra) => JSON.parse((await execFileAsync(process.execPath, [root + 'bin/doctor.mjs', '--project', fixture('web-monorepo'), '--harness', 'claude', '--task', 'feature', ...extra], { env: { ...process.env, HOME: home } })).stdout);
    const frontend = await run('--domain', 'FRONTEND');
    const item = frontend.declare_first.order.find((entry) => entry.id === 'ui.design_system');
    assert.ok(item, 'doctor --domain FRONTEND must resolve ui.design_system');
    assert.equal(item.install_hint, INSTALL);
    const backend = await run('--domain', 'BACKEND');
    assert.ok(!backend.declare_first.order.some((entry) => entry.id === 'ui.design_system'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  assert.match(read('bin/doctor.mjs'), /\[--domain <[^>]+>\]/, 'doctor usage must document --domain');
  assert.match(read('docs/COHERENCE.md'), /checklist item D1/);
  assert.match(read('README.md'), /doctor[^\n]*--domain/, 'README must document doctor --domain');
});
