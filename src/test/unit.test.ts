import { discoverAgents } from '../claude';
import { ensurePlugin, pluginDir } from '../plugin';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { matches, alwaysChoice, parseRule } from '../policy';
import { agentLog, savedAgents, sessionSettings, usableCommands, sessionLog, parseVerdict, carryOver, claudeEnv, parseProposals, taskText, plannerFirst, frontendDesignPlugin, artifactBrief, ARTIFACT_URL } from '../claude';
import { Limits, isLimitError } from '../limits';
import { Store } from '../store';
import { projectSetup } from '../setup';
import { Session } from '../session';
import { setupSkill, DESIGN_SKILL_PATH } from '../skill';
import { writePlugin } from '../plugin';
import * as g from '../git';
import * as A from '../artifacts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-test-'));

test('rules: tools, prefixes, exact commands, compound commands', () => {
  assert.equal(matches('Edit', 'Write', { file_path: 'a.ts' }), true);
  assert.equal(matches('Edit', 'Bash', { command: 'ls' }), false);
  assert.equal(matches('Bash(npm run:*)', 'Bash', { command: 'npm run build' }), true);
  assert.equal(matches('Bash(npm run:*)', 'Bash', { command: 'npm run' }), true);
  assert.equal(matches('Bash(npm run:*)', 'Bash', { command: 'npm runner' }), false);
  assert.equal(matches('Bash(npm run:*)', 'Bash', { command: 'npm run build && rm -rf /' }), false);
  assert.equal(matches('Bash(npm run:*)', 'Bash', { command: 'npm run x | sh' }), false);
  assert.equal(matches('Bash(git status)', 'Bash', { command: 'git status' }), true);
  assert.equal(matches('Bash(git status)', 'Bash', { command: 'git status -s' }), false);
  assert.equal(matches('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://example.com/a' }), true);
  assert.equal(matches('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://evil.com/example.com' }), false);
  assert.equal(matches('Bash(git status *)', 'Bash', { command: 'git status --short' }), true);
  assert.equal(matches('Bash(git status *)', 'Bash', { command: 'git statusx' }), false);
  assert.equal(matches('Read(//Users/me/Library/**)', 'Read', { file_path: '/Users/me/Library/Android/sdk' }), true);
  assert.equal(matches('Read(//Users/me/Library/**)', 'Read', { file_path: '/Users/me/Documents/a' }), false);
  assert.equal(matches('Edit(src/**)', 'Edit', { file_path: '/repo/src/a/b.ts' }), true);
  assert.equal(matches('Edit(src/*.ts)', 'Edit', { file_path: '/repo/src/a/b.ts' }), false);
  assert.deepEqual(parseRule('Bash(npm test:*)'), { tool: 'Bash', content: 'npm test:*' });
  assert.equal(parseRule('not a rule!'), undefined);
});

test('always choice: rules from suggestions, or edits for this task', () => {
  const r = alwaysChoice([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch y.txt' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.deepEqual(r?.rules, ['Bash(touch y.txt)']);
  assert.match(r!.label, /Always allow Bash\(touch y.txt\)/);
  const e = alwaysChoice([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.equal(e?.mode, 'acceptEdits');
  assert.equal(alwaysChoice([]), undefined);
});

test('reviewer verdict parsing', () => {
  const v = parseVerdict('All good.\n```json\n{"pass": true, "issues": [], "risk": "minor", "tested": ["npm test"]}\n```');
  assert.deepEqual(v, { pass: true, issues: [], risk: 'minor', tested: ['npm test'] });
  assert.throws(() => parseVerdict('```json\n{"pass": false, "issues": []}\n```'), /without issues/);
  assert.throws(() => parseVerdict('no verdict here'), /no JSON verdict/);
  assert.equal(parseVerdict('```json\n{"pass": false, "issues": [{"file":"a"}], "risk": "critical"}\n```').risk, 'critical');
});

test('claude env: no inherited Claude markers, no stray API key', () => {
  process.env.CLAUDECODE = '1'; process.env.ANTHROPIC_API_KEY = 'sk-stray';
  const env = claudeEnv();
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(claudeEnv('sk-chosen').ANTHROPIC_API_KEY, 'sk-chosen');
  delete process.env.CLAUDECODE; delete process.env.ANTHROPIC_API_KEY;
});

test('carry-over: uncommitted agents and local settings, as a path', () => {
  const root = tmp(), wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'builder.md'), '---\nname: builder\ndescription: builds\nmodel: sonnet\n---\nBuild it.');
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{"env":{"SECRET":"x"}}');
  const c = carryOver(root, wt);
  assert.equal(c.agents?.builder.prompt, 'Build it.');
  assert.equal(c.settingsFile, path.join(root, '.claude', 'settings.local.json'));
  assert.deepEqual(carryOver(root, root), { addDirs: [] });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 's'), { recursive: true });
  assert.deepEqual(carryOver(root, wt).addDirs, []); // skills come from the plugin, not the project folder
});

test('limits: plan windows, reached, reset', () => {
  const l = new Limits();
  const now = Date.now() / 1000;
  l.update({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: now + 3600 }, seven_day: { utilization: 0.1, resetsAt: now + 86400 } } });
  assert.equal(l.view().five?.pct, 42);
  assert.equal(l.view().week?.pct, 10);
  let reset = 0;
  l.onReset(() => reset++);
  l.update({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: now + 3600 });
  assert.equal(l.held(), true);
  l.clear();
  assert.equal(l.held(), false);
  assert.equal(reset, 1);
  assert.equal(isLimitError('Claude usage limit reached'), true);
  assert.equal(isLimitError('TypeError: x is undefined'), false);
  l.dispose();
});

test('store: rules and queue persist, deleted tasks leave the queue', () => {
  const root = tmp();
  const s = new Store(root);
  const a = s.addTask({ title: 'A', mode: 'auto' }), b = s.addTask({ title: 'B', mode: 'auto' });
  s.addRules(['Bash(npm test:*)', 'Bash(npm test:*)']);
  s.setQueue([a.id, b.id]);
  s.deleteTask(a.id);
  const again = new Store(root);
  assert.deepEqual(again.rules, ['Bash(npm test:*)']);
  assert.deepEqual(again.queue, [b.id]);
  s.dispose(); again.dispose();
});

test('planner proposals: goal, files, done-when and sprint', () => {
  const text = 'Thoughts.\n```tasks\n[{"ref":"a1","title":"Login","goal":"Sign in","files":["src/auth.ts"],"done":["bad password errors","npm test passes"],"sprint":"Sprint 1: Auth"},{"title":"Logout"}]\n```';
  const p = parseProposals(text, new Set(['a1']))!;
  assert.equal(p[0].ref, 'a1');
  assert.equal(p[0].sprint, 'Sprint 1: Auth');
  assert.equal(p[0].description, 'Goal: Sign in\nFiles: src/auth.ts\nDone when:\n- bad password errors\n- npm test passes');
  assert.equal(p[1].description, undefined);
  assert.equal(taskText({ goal: 'x', done: [] }), 'Goal: x');
});

test('git: secrets stay out, orphan task folders are pruned', async () => {
  const root = tmp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  fs.writeFileSync(path.join(root, 'app.js'), 'x');
  fs.writeFileSync(path.join(root, 'server.pem'), 'secret');
  fs.writeFileSync(path.join(root, '.env'), 'A=1');
  await g.ensureRepo(root);
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  assert.match(tracked, /app\.js/);
  assert.doesNotMatch(tracked, /server\.pem|\.env/);
  const wt = g.worktreeDir(root, 'gone1');
  await g.addWorktree(root, wt, 'jc/gone-gone1', 'HEAD');
  const kept = g.worktreeDir(root, 'keep1');
  await g.addWorktree(root, kept, 'jc/keep-keep1', 'HEAD');
  const r = await g.pruneOrphans(root, new Set(['keep1']));
  assert.deepEqual(r.removed, ['gone1']);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.existsSync(kept), true);
});

test('session: messages build the log, agent map and turn result', () => {
  const s = new Session({ bin: 'claude', cwd: '/x', sessionId: 'id', resume: false, mode: 'auto', allowed: [], rules: () => [], env: {}, idleMs: 60_000, label: 'Task' });
  const turns: any[] = [];
  s.on('turn', t => turns.push(t));
  const msg = (m: any) => (s as any).message(m);
  msg({ type: 'system', subtype: 'init', permissionMode: 'default' });
  assert.match(s.modeNote!, /auto is not available/);
  msg({ type: 'assistant', parent_tool_use_id: null, message: { usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'On it' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  msg({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', description: 'scan', subagent_type: 'Explore' });
  msg({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } });
  msg({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'scan', usage: { total_tokens: 5000, tool_uses: 3, duration_ms: 1200 }, last_tool_name: 'Grep' });
  msg({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'found it', output_file: '' });
  msg({ type: 'result', subtype: 'success', is_error: false, result: 'Done', duration_ms: 900, total_cost_usd: 0.01 });
  const sub = s.agents.get('t1')!;
  assert.deepEqual([sub.name, sub.status, sub.tokens, sub.parent], ['Explore', 'completed', 5000, 'main']);
  assert.equal(s.agents.get('main')!.tokens, 120);
  assert.deepEqual(s.steps.map(x => x.kind), ['info', 'say', 'tool', 'tool']);
  assert.equal(s.steps[3].agent, 'Explore');
  assert.deepEqual(turns, [{ ok: true, error: undefined, text: 'Done', limit: false, costUsd: 0.01, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
  assert.equal(s.state, 'idle');
  s.kill();
});

test('session: permission requests wait for an answer; Always reports the rules', async () => {
  const s = new Session({ bin: 'claude', cwd: '/x', sessionId: 'id', resume: false, mode: 'default', allowed: [], rules: () => ['Bash(npm test:*)'], env: {}, idleMs: 60_000, label: 'Task' });
  const signal = new AbortController().signal;
  const perm = (tool: string, input: any, suggestions?: any) => (s as any).permission(tool, input, { signal, suggestions, toolUseID: `${tool}-1` });
  assert.equal((await perm('Bash', { command: 'npm test -- a' })).behavior, 'allow'); // a project rule: no question
  let rules: string[] = [];
  s.onRules(r => { rules = r; });
  const p = perm('Bash', { command: 'make' }, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make:*' }], behavior: 'allow', destination: 'localSettings' }]);
  await new Promise(r => setImmediate(r));
  assert.equal(s.state, 'waiting');
  assert.equal([...s.asks.values()][0].always, 'Always allow Bash(make:*)');
  s.answer({ id: 'Bash-1', choice: 'always' });
  const res = await p;
  assert.equal(res.behavior, 'allow');
  assert.equal(res.updatedPermissions[0].destination, 'session');
  assert.deepEqual(rules, ['Bash(make:*)']);
  const d = perm('Write', { file_path: 'a' });
  await new Promise(r => setImmediate(r));
  s.answer({ id: 'Write-1', choice: 'deny', message: 'use b instead' });
  assert.deepEqual(await d, { behavior: 'deny', message: 'use b instead', interrupt: false });
  // Switching to Allow everything approves what waits, and nothing asks after.
  const w = perm('Bash', { command: 'ls ~/x | head' });
  await new Promise(r => setImmediate(r));
  await s.setMode('bypassPermissions');
  assert.equal((await w).behavior, 'allow');
  assert.equal((await perm('Bash', { command: 'rm -rf build; make' })).behavior, 'allow');
  assert.equal(s.asks.size, 0);
  s.kill();
});

test('artifacts: brief lists sources by reference, progress keeps merged work', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'docs'));
  const sources: A.Source[] = [{ id: 's1', kind: 'file', ref: path.join(root, 'docs', 'spec.md'), note: 'Product spec' }, { id: 's2', kind: 'url', ref: 'https://example.com/design' }, { id: 's3', kind: 'folder', ref: '/outside/designs' }];
  const t = { id: 't1', title: 'Add roles', description: 'Owner and staff', mode: 'auto', status: 'todo', created: 0, sources: ['s1', 's3'], files: ['/x/data.csv'] } as any;
  const brief = A.writeBrief(root, t, sources);
  assert.match(brief, /- docs\/spec\.md — Product spec/);
  assert.doesNotMatch(brief, /example\.com/);
  assert.match(brief, /\/x\/data\.csv/);
  assert.match(brief, new RegExp(A.handoffFile(root, 't1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(A.outsideDirs(root, sources), ['/outside/designs']);
  fs.writeFileSync(A.handoffFile(root, 't1'), '# Handoff\n- Added Role model\n- npm test: 12 passed\n');
  A.appendProgress(root, t);
  const progress = fs.readFileSync(A.progressFile(root), 'utf8');
  assert.match(progress, /Add roles\n- Added Role model\n- npm test: 12 passed/);
  assert.match(A.writeBrief(root, { ...t, sources: undefined }, sources), /Project history/);
});

test('review triage: docs need none, small code light, sensitive or big full', () => {
  const d = (file: string, lines: number) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` + Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n') + '\n';
  assert.equal(A.triage(d('README.md', 50) + d('package-lock.json', 900)).level, 'none');
  assert.equal(A.triage(d('src/list.tsx', 30)).level, 'light');
  assert.equal(A.triage(d('src/auth/login.ts', 5)).level, 'full');
  assert.equal(A.triage(d('src/a.ts', 200)).level, 'full');
});

import * as C from '../checks';

test('checks: detected from the project, never watch modes', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', dev: 'vite' } }));
  fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
  assert.deepEqual(C.detectChecks(d).map(c => c.cmd), ['pnpm run typecheck', 'pnpm test']);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'jest --watch' } }));
  assert.deepEqual(C.detectChecks(d), []);
  const py = tmp();
  fs.writeFileSync(path.join(py, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  assert.deepEqual(C.detectChecks(py).map(c => c.cmd), ['python -m pytest -q -x']);
  assert.deepEqual(C.checksFor(py, ''), []);
  assert.deepEqual(C.checksFor(py, 'make lint\nmake test').map(c => c.cmd), ['make lint', 'make test']);
});

test('checks: run, keep the failing tail, stop at the timeout with the whole tree', async () => {
  const d = tmp();
  const { results } = await C.runChecks([{ name: 'ok', cmd: 'echo fine' }, { name: 'bad', cmd: 'echo boom; exit 3' }], d, { PATH: process.env.PATH! }, 10_000);
  assert.deepEqual(results.map(r => [r.name, r.ok, r.code]), [['ok', true, 0], ['bad', false, 3]]);
  assert.match(results[1].tail, /boom/);
  const t0 = Date.now();
  const r = await C.runCommand('sleep 30 & sleep 30', d, { PATH: process.env.PATH! }, 500);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('folder setup: node_modules linked when the lockfile matches; ports per task', async () => {
  const root = tmp(), wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(wt);
  for (const dir of [root, wt]) { fs.writeFileSync(path.join(dir, 'package.json'), '{}'); fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"v":1}'); }
  const log: string[] = [];
  assert.equal(await C.setupFolder(root, wt, 'auto', { PATH: process.env.PATH! }, s => log.push(s)), true);
  assert.equal(fs.realpathSync(path.join(wt, 'node_modules')), fs.realpathSync(path.join(root, 'node_modules')));
  const a = C.folderEnv(root, 'aaaa1111', { PATH: '/bin' }), b = C.folderEnv(root, 'bbbb2222', { PATH: '/bin' });
  assert.notEqual(a.PORT, b.PORT);
  assert.equal(a.PATH, '/bin');
});

import { Runner, effectiveMode } from '../runner';
import { bypassGate, canEnableBypassAll } from '../bridge';

// A runner on a real temp repo with a fake Claude: checks run by JustCode, failures sent back, base failures ignored.
test('runner: failing check goes back to Claude; a failure the base already has is ignored', async () => {
  const root = tmp();
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  sh(root, 'init', '-q', '-b', 'main'); sh(root, 'config', 'user.email', 't@t'); sh(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js', typecheck: 'node tc.js' } }));
  fs.writeFileSync(path.join(root, 't.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(root, 'tc.js'), 'console.log("base type error"); process.exit(1)'); // fails on main already
  sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'init');
  const store = new Store(root);
  const said: string[] = [];
  const settings: any = { maxParallel: 1, taskModel: '', allowedTools: [], worktreeCopy: [], idleMinutes: 10, personalSetup: false, freshAfterTokens: 0, checks: 'auto', setup: '', maxCheckRounds: 2, checkTimeoutMinutes: 1,
    review: { auto: false, model: '', lightModel: '', triage: true, maxAttempts: 3, autoMerge: false, mergeIfCannotRun: false, commands: [], timeoutMinutes: 1 } };
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({ PATH: process.env.PATH! }), settings: () => settings, limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  r.say = async (_id: string, text: string) => { said.push(text); };
  const t = store.addTask({ title: 'Feature', mode: 'auto' });
  const wt = g.worktreeDir(root, t.id);
  await g.addWorktree(root, wt, 'jc/feature-' + t.id, 'main');
  store.updateTask(t.id, { worktree: wt, branch: 'jc/feature-' + t.id, base: 'main', status: 'review' });
  fs.writeFileSync(path.join(wt, 't.js'), 'console.log("FAIL: expected 2 got 3"); process.exit(1)');
  await g.commitAll(wt, 'work');
  assert.equal(await r.check(t.id), 'fail');
  const c1 = store.task(t.id)!.checks!;
  assert.equal(c1.state, 'fail');
  assert.deepEqual(c1.results!.map(x => [x.name, x.ok, !!x.preexisting]), [['type check', false, true], ['tests', false, false]]);
  assert.equal(said.length, 1);
  assert.match(said[0], /expected 2 got 3/);
  assert.doesNotMatch(said[0], /base type error/);
  assert.equal(store.task(t.id)!.status, 'doing');
  // Claude fixes it: the same head is not re-run, a new commit passes.
  fs.writeFileSync(path.join(wt, 't.js'), 'process.exit(0)');
  await g.commitAll(wt, 'fix');
  assert.equal(await r.check(t.id), 'pass');
  assert.equal(store.task(t.id)!.checks!.state, 'pass');
  assert.equal(said.length, 1);
  r.dispose();
});

test('requestRun: honors the one-at-a-time limit, queues the rest', async () => {
  const root = tmp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'x'); execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  const store = new Store(root);
  const settings: any = { maxParallel: 1, taskModel: '', allowedTools: [], worktreeCopy: [], idleMinutes: 10, personalSetup: false, freshAfterTokens: 0, subagents: false, taskEffort: '', plannerEffort: '', checks: '', setup: '', maxCheckRounds: 2, checkTimeoutMinutes: 1,
    review: { auto: false, model: '', effort: '', lightModel: '', triage: true, maxAttempts: 3, autoMerge: false, mergeIfCannotRun: false, commands: [], timeoutMinutes: 1 } };
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => settings, limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  const runCalls: string[] = [];
  r.run = async (id: string) => { runCalls.push(id); };
  const a = store.addTask({ title: 'A', mode: 'auto' }), b = store.addTask({ title: 'B', mode: 'auto' });
  // A is already in flight (doing, with a worktree): the slot is taken.
  store.updateTask(a.id, { status: 'doing', worktree: g.worktreeDir(root, a.id), branch: 'jc/a', base: 'main' });
  await r.requestRun(b.id);
  assert.deepEqual(runCalls, []);                 // not started: limit reached
  assert.deepEqual(store.queue, [b.id]);          // queued instead
  // Free the slot: A done. requestRun B again starts it.
  store.updateTask(a.id, { status: 'done', worktree: undefined });
  await r.requestRun(b.id);
  assert.deepEqual(runCalls, [b.id]);
  r.dispose();
});

test('setup skill: only writes under .justcode and runs no CLI command', () => {
  const skill = setupSkill();
  assert.ok(skill.includes('name: just-code-setup') && skill.includes('disable-model-invocation: true'));
  assert.ok(skill.includes('.justcode/project.md') && skill.includes('.justcode/design/DESIGN.md'));
  assert.doesNotMatch(skill, /node "/);
});

test('project.md: the brief and plan chats point at it when it exists; projectSetup reports it', () => {
  const root = tmp();
  const t = { id: 't1', title: 'x', mode: 'auto', status: 'todo', created: 0 } as any;
  assert.doesNotMatch(A.writeBrief(root, t, []), /## Project\n/);
  assert.deepEqual(projectSetup(root), { projectMd: false, designMd: false });
  fs.mkdirSync(path.join(root, '.justcode'), { recursive: true });
  fs.writeFileSync(A.projectFile(root), 'About');
  assert.match(A.writeBrief(root, t, []), new RegExp(`## Project\\nRead ${A.projectFile(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} first\\.`));
  assert.match(A.projectSection(root), /^## Project/);
  assert.deepEqual(projectSetup(root), { projectMd: true, designMd: false });
});

test('plugin: written once, rewritten when the version changes; agents are discovered from it', () => {
  const root = tmp();
  ensurePlugin(root, '1.2.3');
  const pj = path.join(pluginDir(root), '.claude-plugin', 'plugin.json');
  assert.equal(JSON.parse(fs.readFileSync(pj, 'utf8')).version, '1.2.3');
  fs.writeFileSync(path.join(pluginDir(root), 'agents', 'reviewer.md'), 'edited');
  ensurePlugin(root, '1.2.3');
  assert.equal(fs.readFileSync(path.join(pluginDir(root), 'agents', 'reviewer.md'), 'utf8'), 'edited');
  ensurePlugin(root, '1.2.4');
  assert.equal(JSON.parse(fs.readFileSync(pj, 'utf8')).version, '1.2.4');
  assert.notEqual(fs.readFileSync(path.join(pluginDir(root), 'agents', 'reviewer.md'), 'utf8'), 'edited');
  assert.ok(discoverAgents(root).some(a => a.name === 'reviewer'));
});

test('runner: writes the plugin on creation and hands it to every session', () => {
  const root = tmp(), settings: any = { personalSetup: false, review: {} };
  const r: any = new Runner(new Store(root), { version: '9.9.9', bin: () => 'claude', env: () => ({}), settings: () => settings, limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  const pj = path.join(pluginDir(root), '.claude-plugin', 'plugin.json');
  assert.equal(JSON.parse(fs.readFileSync(pj, 'utf8')).version, '9.9.9');
  assert.deepEqual(r.plugins(), [pluginDir(root)]);
  assert.deepEqual(r.plugins(['/x/fd', undefined]), [pluginDir(root), '/x/fd']);
  fs.rmSync(pluginDir(root), { recursive: true });
  r.plugins();
  assert.ok(fs.existsSync(pj));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'runner.ts'), 'utf8');
  assert.equal((src.match(/new Session\(\{[\s\S]*?\n    \}\);|new Session\(\{/g) ?? []).length, 2);
  assert.equal((src.match(/plugins: this\.plugins\(/g) ?? []).length, 3); // task, planner, review
  r.dispose();
});

test('deleting a sprint keeps its tasks, in the backlog', () => {
  const store = new Store(tmp());
  const sp = store.addSprint('Old'), keep = store.addSprint('Keep');
  const a = store.addTask({ title: 'A', mode: 'auto', sprintId: sp.id }), b = store.addTask({ title: 'B', mode: 'auto', sprintId: keep.id });
  store.updateTask(a.id, { status: 'done' });
  store.deleteSprint(sp.id);
  assert.deepEqual(store.data.sprints.map(x => x.name), ['Keep']);
  assert.deepEqual([store.task(a.id)!.sprintId, store.task(a.id)!.status, store.task(b.id)!.sprintId], [undefined, 'done', keep.id]);
});

test('planner: editing a sprint scopes the instruction to all its tasks', () => {
  const text = plannerFirst([{ id: 'a', title: 'Login' }, { id: 'b', title: 'Logout' }], 'add Done when to each', [], { name: 'Sprint 1', goal: 'Auth' });
  assert.match(text, /every not-started task of Sprint 1 \(goal: Auth\)/);
  assert.match(text, /\[a\] Login\n\[b\] Logout/);
  assert.doesNotMatch(plannerFirst([], 'x'), /Scope/);
});

test('runner: a task merged while its checks run is not sent back; Resume clears a leftover folder', async () => {
  const root = tmp();
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  sh(root, 'init', '-q', '-b', 'main'); sh(root, 'config', 'user.email', 't@t'); sh(root, 'config', 'user.name', 't');
  // A slow test, so the task can be merged while it runs.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
  fs.writeFileSync(path.join(root, 't.js'), 'setTimeout(() => process.exit(1), 400)');
  sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'init');
  const store = new Store(root);
  const said: string[] = [];
  const settings: any = { maxParallel: 1, taskModel: '', allowedTools: [], worktreeCopy: [], idleMinutes: 10, personalSetup: false, freshAfterTokens: 0, checks: 'auto', setup: '', maxCheckRounds: 2, checkTimeoutMinutes: 1,
    review: { auto: false, model: '', lightModel: '', triage: true, maxAttempts: 3, autoMerge: false, mergeIfCannotRun: false, commands: [], timeoutMinutes: 1 } };
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({ PATH: process.env.PATH! }), settings: () => settings, limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  r.say = async (_id: string, text: string) => { said.push(text); };
  const t = store.addTask({ title: 'Docs', mode: 'auto' });
  const wt = g.worktreeDir(root, t.id), branch = 'jc/docs-' + t.id;
  await g.addWorktree(root, wt, branch, 'main');
  store.updateTask(t.id, { worktree: wt, branch, base: 'main', status: 'review' });
  fs.writeFileSync(path.join(wt, 'README.md'), 'docs');
  await g.commitAll(wt, 'docs');
  const running = r.check(t.id);
  await new Promise(res => setTimeout(res, 100));
  assert.equal(r.checking.has(t.id), true);           // the checks are in flight
  settings.review.auto = true; settings.review.autoMerge = true;
  await r.sweep();                                      // the sweep must not review or merge meanwhile
  settings.review.auto = false;
  assert.equal(store.task(t.id)!.review, undefined);
  // Merged elsewhere while the test still runs: the folder goes away, then a stray write recreates part of it.
  store.updateTask(t.id, { status: 'done', worktree: undefined });
  sh(root, 'worktree', 'remove', '--force', wt);
  fs.mkdirSync(path.join(wt, 'out-test'), { recursive: true });
  assert.equal(await running, 'none');
  assert.equal(said.length, 0);
  assert.equal(store.task(t.id)!.status, 'done');
  // Starting the task again over the leftover folder works.
  await g.addWorktree(root, wt, branch, 'main');
  assert.ok(fs.existsSync(path.join(wt, '.git')));
  r.dispose();
});

test('queue: Run all continues when a task is merged with no Claude process open', async () => {
  const root = tmp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const store = new Store(root);
  const settings: any = { maxParallel: 1, taskModel: '', allowedTools: [], worktreeCopy: [], idleMinutes: 10, personalSetup: false, freshAfterTokens: 0, checks: '', setup: '', maxCheckRounds: 2, checkTimeoutMinutes: 1,
    review: { auto: false, model: '', lightModel: '', triage: true, maxAttempts: 3, autoMerge: false, mergeIfCannotRun: false, commands: [], timeoutMinutes: 1 } };
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => settings, limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  const started: string[] = [];
  r.run = async (id: string) => { started.push(id); };
  // A is in review (its process closed long ago); B waits in the queue behind it.
  const a = store.addTask({ title: 'A', mode: 'auto' });
  store.updateTask(a.id, { status: 'review', worktree: path.join(root, 'wt-a'), branch: 'jc/a' });
  const b = store.addTask({ title: 'B', mode: 'auto' });
  r.runAll([b.id]);
  assert.deepEqual(started, []);                    // no free slot while A is in flight
  store.updateTask(a.id, { status: 'done', worktree: undefined });  // merged
  await new Promise(res => setTimeout(res, 400));
  assert.deepEqual(started, [b.id]);
  assert.deepEqual(store.queue, []);
  r.dispose(); store.dispose();
});

test('phone auth: link sets cookie, missing/wrong/old token gets 401', async () => {
  const { startPhoneServer } = await import('../phone');
  const mk = (token: string) => startPhoneServer(0, { token, state: () => ({ ok: 1 }), act: async () => {} });
  const base = (s: any) => `http://127.0.0.1:${s.address().port}`;
  let srv = await mk('tok1');
  try {
    assert.equal((await fetch(base(srv) + '/')).status, 401);
    assert.equal((await fetch(base(srv) + '/?t=nope')).status, 401);
    assert.equal((await fetch(base(srv) + '/api/state')).status, 401);
    const r = await fetch(base(srv) + '/?t=tok1');
    assert.equal(r.status, 200);
    const ck = r.headers.get('set-cookie')!;
    assert.match(ck, /HttpOnly/);
    const cookie = ck.split(';')[0];
    assert.equal((await fetch(base(srv) + '/api/state', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base(srv) + '/api/state', { headers: { cookie: 'jc_session=%' } })).status, 401);
    const r2 = await fetch(base(srv) + '/?token=tok1');
    assert.equal(r2.status, 200);
    assert.match(r2.headers.get('set-cookie')!, /jc_session=.*HttpOnly/);
    srv.close(); srv = await mk('tok2'); // regenerated
    assert.equal((await fetch(base(srv) + '/api/state', { headers: { cookie } })).status, 401);
    assert.equal((await fetch(base(srv) + '/?t=tok1')).status, 401);
  } finally { srv.close(); }
});

test('artifact tasks: frontend-design is found by path, the brief sets the rules, the link is read', () => {
  const dir = tmp(), install = path.join(dir, 'fd', '1.1.1');
  fs.mkdirSync(path.join(install, 'skills', 'frontend-design'), { recursive: true });
  const file = path.join(dir, 'installed_plugins.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, plugins: { 'frontend-design@claude-plugins-official': [
    { scope: 'project', installPath: path.join(dir, 'missing') }, { scope: 'user', installPath: install }] } }));
  assert.equal(frontendDesignPlugin(file), install);
  assert.equal(frontendDesignPlugin(path.join(dir, 'none.json')), undefined);
  const brief = artifactBrief('/p/.justcode/tasks/t1/artifact.html', true);
  assert.match(brief, /\/p\/\.justcode\/tasks\/t1\/artifact\.html/);
  assert.match(brief, /frontend-design/);
  assert.match(brief, /Do not publish it yourself/);
  assert.equal(ARTIFACT_URL.exec('{"text":"Published: https://claude.ai/code/artifact/5fbea6f3-aa11-4c2d-9e7a-0b1c2d3e4f50 ok"}')?.[0], 'https://claude.ai/code/artifact/5fbea6f3-aa11-4c2d-9e7a-0b1c2d3e4f50');
  assert.equal(ARTIFACT_URL.exec('see https://claude.ai/artifact/abc123')?.[0], 'https://claude.ai/artifact/abc123');
});

test('bypass-all forces bypassPermissions at run time, and off leaves the mode alone', () => {
  assert.equal(effectiveMode('auto', true), 'bypassPermissions');
  assert.equal(effectiveMode('plan', false), 'plan');
  assert.equal(effectiveMode('plan', undefined), 'plan');
});

test('a phone can neither get bypass nor enable bypass-all; the desktop skips the per-task confirm only when bypass-all is on', async () => {
  let asked = 0; const yes = async () => { asked++; return true; };
  assert.equal(await bypassGate(true, true, yes), false);
  assert.equal(await bypassGate(true, false, yes), false);
  assert.equal(await bypassGate(false, true, yes), true);
  assert.equal(asked, 0);
  assert.equal(await bypassGate(false, false, yes), true);
  assert.equal(asked, 1);
  assert.equal(await canEnableBypassAll(true, yes), false);
  assert.equal(asked, 1);
  assert.equal(await canEnableBypassAll(false, yes), true);
});

const leaseRepo = () => {
  const root = tmp();
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: root });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x'); sh('add', '-A'); sh('commit', '-qm', 'init');
  return { root, sh };
};
const leaseRunner = (store: Store, notes: string[] = []): any => new Runner(store, { bin: () => 'claude', env: () => ({ PATH: process.env.PATH! }),
  settings: () => ({ maxParallel: 1, worktreeCopy: [], review: { auto: false } }) as any, limits: new Limits(), notify: (_l: string, text: string) => { notes.push(text); }, choose: async () => 'x', cli: '' });

test('addWorktree: a folder still being written into does not stop the task', async () => {
  const { root } = leaseRepo();
  const dir = g.worktreeDir(root, 'busy');
  fs.mkdirSync(path.join(dir, 'out-test'), { recursive: true });
  const writer = setInterval(() => { try { fs.mkdirSync(path.join(dir, 'out-test'), { recursive: true }); fs.writeFileSync(path.join(dir, 'out-test', 'a.js'), 'x'); } catch { /* being cleared */ } }, 1);
  setTimeout(() => clearInterval(writer), 300);
  await g.addWorktree(root, dir, 'jc/busy', 'main');
  clearInterval(writer);
  assert.ok(fs.existsSync(path.join(dir, '.git')));
});

test('git errors leave out the progress lines', async () => {
  const { root } = leaseRepo();
  await g.addWorktree(root, g.worktreeDir(root, 'one'), 'jc/one', 'main');
  await assert.rejects(g.git(root, ['worktree', 'add', g.worktreeDir(root, 'two'), 'jc/one']), (e: Error) => !/Preparing worktree/.test(e.message) && /already/.test(e.message));
});

test('Resume on a merged task that late checks sent back: goes to Done, no new folder', async () => {
  const { root, sh } = leaseRepo();
  sh('branch', 'jc/merged');
  const store = new Store(root);
  const r = leaseRunner(store);
  const t = store.addTask({ title: 'Merged', mode: 'auto' });
  store.updateTask(t.id, { status: 'doing', branch: 'jc/merged', base: 'main', doneAt: Date.now(), error: "fatal: 'x' already exists" });
  await r.run(t.id, 'Continue the task.');
  assert.equal(store.task(t.id)!.status, 'done');
  assert.equal(store.task(t.id)!.error, undefined);
  assert.ok(!fs.existsSync(g.worktreeDir(root, t.id)));
  assert.throws(() => sh('rev-parse', '--verify', '--quiet', 'refs/heads/jc/merged'));
  r.dispose();
});

test('late check results never send a merged task back to work', async () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const said: string[] = [];
  const r = leaseRunner(store);
  r.say = async (_id: string, text: string) => { said.push(text); };
  const t = store.addTask({ title: 'Merged', mode: 'auto' });
  store.updateTask(t.id, { status: 'done', checks: { state: 'fail', rounds: 1, head: 'x', results: [{ name: 'tests', cmd: 'npm test', ok: false, ms: 1 }] } });
  await r.sendChecks(t.id);
  assert.equal(store.task(t.id)!.status, 'done');
  assert.equal(said.length, 0);
  r.dispose();
});

test('one window per project: a live lease elsewhere blocks runs and automation, a dead one passes on', async () => {
  const { root } = leaseRepo();
  fs.mkdirSync(path.join(root, '.justcode'), { recursive: true });
  const lock = path.join(root, '.justcode', 'runner.lock');
  fs.writeFileSync(lock, String(process.ppid));
  const store = new Store(root);
  const r = leaseRunner(store);
  const t = store.addTask({ title: 'A', mode: 'auto' });
  store.setQueue([t.id]);
  await assert.rejects(r.run(t.id), /Another window/);
  r.pump();
  assert.deepEqual(store.queue, [t.id]);
  r.dispose();
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.ppid), 'never drops another window\'s lease');
  // That window crashed: the next one takes over, and gives the lease back when it closes.
  const dead = execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(lock, dead);
  const r2 = leaseRunner(store);
  assert.equal(r2.holdsLease(), true);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  r2.dispose();
  assert.ok(!fs.existsSync(lock));
});

test('a failed start tells the user once and stays on the card', async () => {
  const { root } = leaseRepo();
  const notes: string[] = [];
  const store = new Store(root);
  const r = leaseRunner(store, notes);
  r.prepare = async () => { throw new Error('git worktree: fatal: boom'); };
  const t = store.addTask({ title: 'A', mode: 'auto' });
  await r.run(t.id);
  assert.equal(store.task(t.id)!.error, 'git worktree: fatal: boom');
  assert.equal(notes.length, 1);
  r.dispose();
});

test('prompt history: logged prompts and older tasks, newest first; sessions only from known ids', () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const old = store.addTask({ title: 'Old task', description: 'From before the log', mode: 'auto' });
  store.updateTask(old.id, { created: 1 } as any);
  const t = store.addTask({ title: 'New task', mode: 'auto' });
  A.logPrompt(root, { kind: 'task', text: 'New task', taskId: t.id, title: 'New task' });
  A.logPrompt(root, { kind: 'message', text: 'also add tests', taskId: t.id });
  fs.appendFileSync(A.promptsFile(root), 'not json\n');
  const h = r.history();
  assert.deepEqual(h.map((p: any) => [p.kind, p.text]), [['message', 'also add tests'], ['task', 'New task'], ['task', 'Old task\n\nFrom before the log']]);
  assert.equal(h[0].title, 'New task');
  assert.equal(r.sessionDir('someone-elses-session'), undefined);
  r.dispose();
});

test('conversation log notes the model that answered, and when it changes', () => {
  const home = tmp(), cwd = '/x/proj', id = 'sess-1';
  const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const a = (model: string, text: string) => JSON.stringify({ type: 'assistant', timestamp: 't', message: { model, content: [{ type: 'text', text }] } });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), [a('claude-opus-5-5', 'one'), a('claude-opus-5-5', 'two'), a('<synthetic>', 'x'), a('claude-sonnet-5-5', 'three')].join('\n'));
  const was = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const steps = sessionLog(cwd, id).filter(s => s.kind === 'info').map(s => s.text);
    assert.deepEqual(steps, ['Model: claude-opus-5-5', 'Model: claude-sonnet-5-5']);
  } finally { if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was; }
});

test('a task stopped on an error does not hold the slot; Run now starts a queued task', async () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const stuck = store.addTask({ title: 'Stuck', mode: 'auto' });
  store.updateTask(stuck.id, { status: 'doing', worktree: g.worktreeDir(root, stuck.id), branch: 'jc/x', base: 'main', error: 'Claude Code returned an error result' });
  assert.equal(r.inFlight().length, 0);
  const t = store.addTask({ title: 'Next', mode: 'auto' });
  const ran: string[] = [];
  r.run = async (id: string) => { ran.push(id); };
  await r.requestRun(t.id);
  assert.deepEqual(ran, [t.id]);
  // With the slot really taken, ▶ Run queues and Run now starts it anyway.
  store.updateTask(stuck.id, { error: undefined });
  const u = store.addTask({ title: 'Later', mode: 'auto' });
  await r.requestRun(u.id);
  assert.deepEqual(store.queue, [u.id]);
  await r.runNow(u.id);
  assert.deepEqual(ran, [t.id, u.id]);
  assert.deepEqual(store.queue, []);
  r.dispose();
});

test('applying a plan keeps the planner\'s build order, before other To do tasks and on an empty board', () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  r.plannerOthers = []; r.plannerTargets = [];
  const p = (title: string) => ({ title, kind: 'add', apply: true });
  r.applyProposals([p('Tokens'), p('Header'), p('Captures')], []);
  assert.deepEqual(store.data.tasks.map(t => t.title), ['Tokens', 'Header', 'Captures']);
  r.plannerTargets = []; // a new chat: the tasks above are other To do tasks
  r.applyProposals([p('A'), p('B')], []);
  assert.deepEqual(store.data.tasks.map(t => t.title), ['A', 'B', 'Tokens', 'Header', 'Captures']);
  r.dispose();
});

test('reworking a sprint: a done task that must change goes back to To do; a started one gets the change as a message', () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const said: [string, string][] = [];
  r.say = async (id: string, text: string) => { said.push([id, text]); };
  const sid = store.addSprint('S1').id;
  const done = store.addTask({ title: 'Login page', mode: 'auto', sprintId: sid });
  store.updateTask(done.id, { status: 'done', sessionId: 's-old', branch: 'jc/login', doneAt: 5, review: { state: 'pass', attempts: 0 } as any });
  const wip = store.addTask({ title: 'Signup page', mode: 'auto', sprintId: sid });
  store.updateTask(wip.id, { status: 'review', worktree: '/nowhere', branch: 'jc/signup', base: 'main' });
  r.plannerOthers = [done.id, wip.id];
  r.plannerTargets = [];
  assert.match(plannerFirst([], 'restyle', [], { name: 'S1' }, [{ id: done.id, title: 'Login page', status: 'done' }]), /\(done, merged\) Login page/);
  r.applyProposals([
    { ref: done.id, title: 'Login page, new style', description: 'Goal: match the mockup', kind: 'reopen', apply: true },
    { ref: wip.id, title: 'Signup page, new style', description: 'Goal: match the mockup', kind: 'amend', apply: true },
  ], []);
  const d = store.task(done.id)!;
  assert.equal(d.status, 'todo');
  assert.equal(d.title, 'Login page, new style');
  assert.deepEqual([d.sessionId, d.branch, d.doneAt, d.review], [undefined, undefined, undefined, undefined]);
  assert.deepEqual(d.pastSessions, ['s-old']);
  assert.equal(store.task(wip.id)!.status, 'review');
  assert.equal(store.task(wip.id)!.title, 'Signup page, new style');
  assert.equal(said.length, 1);
  assert.match(said[0][1], /plan for this task changed[\s\S]*match the mockup/);
  r.dispose();
});

test('a claude.ai artifact source: briefs point at the saved copy, and the task can read its folder', () => {
  const root = tmp();
  const src = { id: 'abc', kind: 'url' as const, ref: 'https://claude.ai/artifact/RRgUoNaXSgxGCWotthB3qF' };
  assert.ok(A.isArtifactLink(src.ref) && A.isArtifactLink('https://claude.ai/code/artifact/0b1c-2d') && !A.isArtifactLink('https://example.com/artifact/x'));
  const t = { id: 't1', title: 'Restyle', mode: 'auto', status: 'todo', created: 1 } as any;
  assert.match(A.writeBrief(root, t, [src]), /- https:\/\/claude\.ai\/artifact\/RRg/);
  assert.deepEqual(A.outsideDirs(root, [src]), []);
  const dir = A.sourceCopy(root, 'abc'), esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.saved'), '');
  assert.ok(!A.hasCopy(root, src), 'only the marker: no copy yet');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  assert.match(A.writeBrief(root, t, [src]), new RegExp(`${esc}/ \\(saved copy of https://claude.ai/artifact/`));
  assert.deepEqual(A.outsideDirs(root, [src]), [dir]);
  // A design canvas: the brief names its screen index and says to match the screens.
  fs.mkdirSync(path.join(dir, 'project'));
  fs.writeFileSync(path.join(dir, 'project', 'canvas.json'), '{"boards":{}}');
  assert.match(A.writeBrief(root, t, [src]), /saved copy of the design canvas[\s\S]*project\/canvas\.json lists every screen[\s\S]*build them to match/);
});

test('sprint sources: a sprint uses the ones it lists, an older sprint all; pasted links match their source', () => {
  const all = [{ id: 'a', kind: 'url' as const, ref: 'https://claude.ai/artifact/Abc123#page-1' }, { id: 'b', kind: 'file' as const, ref: '/x/spec.md' }];
  assert.deepEqual(A.sprintSources(all, { sources: ['b'] }).map(s => s.id), ['b']);
  assert.deepEqual(A.sprintSources(all, {}).map(s => s.id), ['a', 'b']);
  assert.deepEqual(A.sprintSources(all, { sources: [] }), []);
  assert.deepEqual(A.linkedSources(all, 'match https://claude.ai/artifact/Abc123 please').map(s => s.id), ['a']);
  assert.deepEqual(A.linkedSources(all, 'https://claude.ai/artifact/Abc1234'), []);
  const root = tmp();
  A.saveSources(root, [{ id: 'a', kind: 'url', ref: 'https://claude.ai/artifact/Abc123#page-1' }]);
  assert.equal(A.addLinkSources(root, '/design-from-artifact https://claude.ai/artifact/Abc123').length, 0, 'same artifact without its #page part');
  const store = new Store(tmp());
  assert.deepEqual(store.addSprint('S1').sources, []);
});

test('artifact links in a prompt become sources once; plans list sources; runs save them before starting', async () => {
  const { root } = leaseRepo();
  const link = 'https://claude.ai/artifact/RRgUoNaXSgxGCWotthB3qF';
  assert.equal(A.addLinkSources(root, `Redesign from ${link} please`).length, 1);
  assert.equal(A.addLinkSources(root, `again ${link}`).length, 0);
  assert.match(A.sourceLines(root, A.loadSources(root)), /## Sources[\s\S]*RRgUoNaXSgxGCWotthB3qF/);
  const store = new Store(root);
  const saved: string[] = [];
  const r: any = new Runner(store, { bin: () => undefined, env: () => ({}), settings: () => ({ maxParallel: 1, worktreeCopy: [], review: { auto: false } }) as any,
    limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '', saveSources: async (text: string) => { saved.push(text); } });
  r.holdsLease = () => true;
  const t = store.addTask({ title: 'Restyle', description: `Match ${link}`, mode: 'auto' });
  r.d.bin = () => 'claude';
  r.prepare = async () => undefined;  // stop right after the sources step
  await r.run(t.id);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /RRgUoNaXSgxGCWotthB3qF/);
  r.dispose();
});

test('the @ menu lists tracked and new files with their folders, not ignored ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-files-'));
  await g.git(dir, ['init', '-q']);
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'skip.log\n');
  fs.writeFileSync(path.join(dir, 'skip.log'), '');
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'a b.ts'), '');
  const files = await g.projectFiles(dir);
  assert.deepEqual(files.sort(), ['.gitignore', 'src/', 'src/deep/', 'src/deep/a b.ts']);
  assert.deepEqual(await g.projectFiles(path.join(dir, 'missing')), []);
});

test('the / menu hides internal commands and JustCode\'s own setup skill', () => {
  assert.deepEqual(usableCommands([{ name: 'compact', description: 'Compact' }, { name: '__remote' }, { name: 'just-code-setup' }, { name: 'lexcode-sync' }, { name: 'caveman:caveman' }]),
    [{ name: 'compact', description: 'Compact' }, { name: 'caveman:caveman', description: '' }]);
});

test('a sprint works on its own branch, cut from the current one, and merges back after its last task', async () => {
  const { root, sh } = leaseRepo();
  const store = new Store(root);
  const notes: string[] = [];
  const r = leaseRunner(store, notes);
  r.start = async () => {}; // no Claude: only the git side
  const sp = store.addSprint('Login');
  const a = store.addTask({ title: 'A', mode: 'auto', sprintId: sp.id }), b = store.addTask({ title: 'B', mode: 'auto', sprintId: sp.id });
  const work = async (id: string, file: string) => {
    const p = await r.prepare(store.task(id)!);
    store.updateTask(id, { status: 'review', base: p.base, branch: p.branch, worktree: p.worktree });
    fs.writeFileSync(path.join(p.worktree, file), file);
    return p;
  };
  const pa = await work(a.id, 'a.md');
  const branch = store.sprint(sp.id)!.branch!;
  assert.match(branch, /^jc\/sprint-login-/);
  assert.equal(store.sprint(sp.id)!.target, 'main');
  assert.equal(pa.base, branch);
  await r.merge(a.id);
  assert.ok(sh('ls-tree', '--name-only', branch).toString().includes('a.md'));
  assert.ok(!sh('ls-tree', '--name-only', 'main').toString().includes('a.md'), 'main waits for the whole sprint');
  const pb = await work(b.id, 'b.md');
  assert.equal(pb.base, branch);
  fs.writeFileSync(path.join(root, 'other.txt'), 'x'); sh('add', 'other.txt'); sh('commit', '-qm', 'meanwhile on main');
  await r.merge(b.id);
  const files = sh('ls-tree', '--name-only', 'main').toString();
  assert.ok(files.includes('a.md') && files.includes('b.md') && files.includes('other.txt'), files);
  assert.equal(store.sprint(sp.id)!.branch, undefined);
  assert.ok(!await g.branchExists(root, branch));
  assert.equal(sh('status', '--porcelain').toString().trim(), '');
  r.dispose();
});

test('mergeBranch reports conflicts and changes nothing', async () => {
  const { root, sh } = leaseRepo();
  sh('branch', 'side');
  fs.writeFileSync(path.join(root, 'a.txt'), 'main'); sh('commit', '-qam', 'm');
  const head = sh('rev-parse', 'main').toString();
  sh('worktree', 'add', '-q', path.join(root, '.wt'), 'side');
  fs.writeFileSync(path.join(root, '.wt', 'a.txt'), 'side'); sh('-C', path.join(root, '.wt'), 'commit', '-qam', 's');
  assert.deepEqual(await g.mergeBranch(root, 'main', 'side', 'x'), ['a.txt']);
  assert.equal(sh('rev-parse', 'main').toString(), head);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'main');
});

test('a merged task still lists what it changed, from its merge commit', async () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const t = store.addTask({ title: 'Make PDF', mode: 'auto' });
  const p = await r.prepare(store.task(t.id)!);
  store.updateTask(t.id, { status: 'review', base: p.base, branch: p.branch, worktree: p.worktree });
  fs.mkdirSync(path.join(p.worktree, 'docs'));
  fs.writeFileSync(path.join(p.worktree, 'docs', 'screens.pdf'), '%PDF');
  await r.merge(t.id);
  assert.equal(store.task(t.id)!.worktree, undefined);
  assert.deepEqual(await r.changes(t.id), [{ status: 'A', file: 'docs/screens.pdf' }]);
  r.dispose();
});

test('JustCode sessions commit without Claude attribution, keeping carried project settings', () => {
  const file = path.join(tmp(), 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, attribution: { commit: 'Co-Authored-By: x' } }));
  assert.deepEqual(sessionSettings(file), { permissions: { allow: ['Bash(ls:*)'] }, attribution: { commit: '', pr: '' } });
  assert.deepEqual(sessionSettings(), { attribution: { commit: '', pr: '' } });
});

test('planning in a sprint puts new tasks in it instead of new sprints', () => {
  const first = plannerFirst([], 'add 2FA', [{ name: '2FA and Email' }, { name: 'Sprint 2' }], undefined, [], '2FA and Email');
  assert.match(first, /## Target sprint\nI am planning in 2FA and Email: set "sprint" to "2FA and Email" on every new task\. Do not create other sprints/);
  assert.doesNotMatch(plannerFirst([], 'x'), /Target sprint/);
});

test('Run all can go on without a task that only waits for you', async () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const started: string[] = [];
  r.run = async (id: string) => { started.push(id); };
  const blocker = store.addTask({ title: 'Critical', mode: 'auto' });
  store.updateTask(blocker.id, { status: 'review', worktree: path.join(root, 'wt'), branch: 'jc/x', base: 'main', review: { state: 'pass', risk: 'critical' } as any });
  const next = store.addTask({ title: 'Next', mode: 'auto' });
  r.runAll([next.id]);
  assert.deepEqual(started, []);
  assert.equal(r.userBlocker()?.id, blocker.id);
  r.skipWait(blocker.id);
  assert.deepEqual(started, [next.id]);
  assert.equal(store.task(blocker.id)!.status, 'review');
  r.dispose();
});

test('a subagent\'s saved transcript: steps, model, final answer, tokens and time', () => {
  const cfg = tmp(), cwd = '/proj/x', sid = 's1';
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const dir = path.join(cfg, 'projects', '-proj-x', sid, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'bible-keeper', description: 'Bible update ch-0001', toolUseId: 'tu1', finished: true }));
    fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), [
      { isSidechain: true, type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Update the bible' } },
      { isSidechain: true, type: 'assistant', timestamp: '2026-01-01T00:00:30Z', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Ch-0003 is recorded.' }] } },
    ].map(x => JSON.stringify(x)).join('\n'));
    assert.deepEqual(savedAgents(cwd, sid), [{ id: 'a1', toolUseId: 'tu1', name: 'bible-keeper', description: 'Bible update ch-0001', finished: true }]);
    const log = agentLog(cwd, sid, 'a1')!;
    assert.equal(log.model, 'claude-sonnet-5-5'); assert.equal(log.result, 'Ch-0003 is recorded.'); assert.equal(log.tokens, 15); assert.equal(log.ms, 30000);
    assert.deepEqual(log.steps.map(s => s.kind), ['user', 'info', 'say']);
    assert.equal(agentLog(cwd, sid, '../x'), undefined);
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; }
});

test('writePlugin writes the plugin folder once and keeps unchanged files', () => {
  const root = tmp(), dir = path.join(root, '.justcode', 'plugin');
  const a = writePlugin(root);
  for (const f of ['.claude-plugin/plugin.json', 'skills/plan-tasks/SKILL.md', 'skills/design-from-artifact/SKILL.md', 'agents/reviewer.md', 'agents/planner.md', 'agents/implementer.md'])
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, 'agents', 'reviewer.md'), 'utf8'), /<root>\/\.justcode\/tasks\/<id>\/shots\//);
  assert.deepEqual(fs.readdirSync(root), ['.justcode']);
  const b = writePlugin(root);
  assert.equal(b.written.length, 0);
  assert.equal(b.kept.length, a.written.length);
});
