import { discoverAgents } from '../claude';
import { ensurePlugin, pluginDir } from '../plugin';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { matches, alwaysChoice, parseRule, setBudget } from '../policy';
import { stopsOthersContainers } from '../policy';
import { webOptions, reviewPrompt, playwrightMcp, PLAYWRIGHT_TOOLS, agentLog, savedAgents, sessionSettings, usableCommands, sessionLog, parseVerdict, carryOver, claudeEnv, parseProposals, taskText, plannerFirst, installedPlugin, installedPlugins, artifactBrief, ARTIFACT_URL } from '../claude';
import { Limits, isLimitError } from '../limits';
import { Store, resolveWhere, splitTitle, runsApp } from '../store';
import { projectSetup } from '../setup';
import { Session, toolOptions } from '../session';
import { setupSkill, DESIGN_SKILL_PATH } from '../skill';
import { writePlugin } from '../plugin';
import * as g from '../git';
import * as A from '../artifacts';
import * as R from '../registry';

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
  assert.deepEqual(turns, [{ ok: true, error: undefined, text: 'Done', limit: false, costUsd: 0.01, sessionId: undefined, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
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
  const t = { id: 't1', title: 'Add roles', description: 'Owner and staff', mode: 'auto', status: 'todo', created: 0, sources: ['s1', 's3'], files: ['/x/data.csv', '.justcode/sources/d1/project/Floor.dc.html'] } as any;
  const brief = A.writeBrief(root, t, sources);
  assert.ok(brief.includes(`- ${path.join(root, '.justcode/sources/d1/project/Floor.dc.html')}`), 'design screen file by absolute path: task folders have no .justcode');
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

test('folder setup: a frontend/ subfolder is linked too; Python gets one shared virtualenv on PATH; the task is told', async () => {
  const root = tmp(), wt = path.join(root, '.justcode', 'worktrees', 't');
  for (const dir of [root, wt]) {
    fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true }); fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'frontend', 'package.json'), '{}'); fs.writeFileSync(path.join(dir, 'frontend', 'package-lock.json'), '{"v":1}');
    fs.writeFileSync(path.join(dir, 'backend', 'requirements.txt'), '# nothing to install\n');
  }
  fs.mkdirSync(path.join(root, 'frontend', 'node_modules', 'x'), { recursive: true });
  const log: string[] = [];
  assert.equal(await C.setupFolder(root, wt, 'auto', { PATH: process.env.PATH! }, s => log.push(s)), true, log.join('\n'));
  assert.equal(fs.realpathSync(path.join(wt, 'frontend', 'node_modules')), fs.realpathSync(path.join(root, 'frontend', 'node_modules')));
  assert.equal(C.findVenv(root), C.sharedVenv(root));
  assert.ok(C.folderEnv(root, 'aaaa1111', { PATH: '/bin' }).PATH.startsWith(path.join(C.sharedVenv(root), 'bin')));
  const note = C.setupNote(root, wt)!;
  assert.match(note, /virtualenv .*on PATH/); assert.match(note, /node_modules in frontend/);
  // Second time: nothing to redo (requirements unchanged).
  log.length = 0;
  assert.equal(await C.setupFolder(root, wt, 'auto', { PATH: process.env.PATH! }, s => log.push(s)), true);
  assert.deepEqual(log, []);
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

test('direct tasks: merge refused while one holds files; pump starts only one', async () => {
  const root = tmp();
  const store = new Store(root);
  const settings: any = { maxParallel: 3, review: { auto: false } };
  const msgs: string[] = [];
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => settings, limits: new Limits(), notify: (_k: string, m: string) => { msgs.push(m); }, choose: async () => 'x', cli: '' });
  const calls: string[] = [];
  r.run = async (id: string) => { calls.push(id); };
  const d1 = store.addTask({ title: 'D1', mode: 'auto', where: 'direct' } as any), d2 = store.addTask({ title: 'D2', mode: 'auto', where: 'direct' } as any);
  store.updateTask(d1.id, { status: 'review', directFiles: ['a.txt'] });
  const b = store.addTask({ title: 'B', mode: 'auto', where: 'branch' } as any);
  store.updateTask(b.id, { status: 'review', branch: 'jc/b', base: 'main', worktree: path.join(root, 'wt') });
  await r.merge(b.id);
  assert.ok(msgs.some(m => /"D1" has uncommitted files.*Finish or Discard/.test(m)), msgs.join('|'));
  store.setQueue([d2.id]);
  r.pump();
  assert.deepEqual(calls, []);
  assert.deepEqual(store.queue, [d2.id]);
  store.updateTask(d1.id, { status: 'done' });
  r.pump();
  assert.deepEqual(calls, [d2.id]);
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
  // The Runner and its method files (queue, checks, review, merge, planner, sessions, guards).
  const src = ['runner', 'planner', 'reviewflow'].map(f => fs.readFileSync(path.join(__dirname, '..', '..', 'src', `${f}.ts`), 'utf8')).join('\n');
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
  assert.equal(installedPlugin('frontend-design', file), install);
  assert.equal(installedPlugin('superpowers', file), undefined);
  assert.deepEqual(installedPlugins(file), { 'frontend-design': install });
  assert.equal(installedPlugin('frontend-design', path.join(dir, 'none.json')), undefined);
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

test('one task at a time keeps the queue order: a task waiting on a held one holds back later tasks', () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const ran: string[] = [];
  r.run = async (id: string) => { ran.push(id); };
  // 7.2 passed review but is held for your approval: it frees the slot, yet 7.3 needs it merged first.
  const held = store.addTask({ title: '7.2', mode: 'auto' });
  store.updateTask(held.id, { status: 'review', worktree: root, branch: 'b', base: 'main', review: { state: 'pass', attempts: 1, hold: 'migrations' } as any });
  assert.equal(r.inFlight().length, 0);
  const a = store.addTask({ title: '7.3', mode: 'auto' }), b = store.addTask({ title: '8.3', mode: 'auto' });
  store.updateTask(a.id, { dependsOn: [held.id] });
  store.setQueue([a.id, b.id]);
  r.pump();
  assert.deepEqual(ran, [], '8.3 does not jump ahead of 7.3');
  assert.deepEqual(store.queue, [a.id, b.id]);
  // What 7.3 waits for can never start (a To do outside the queue): it is passed over.
  const never = store.addTask({ title: 'never', mode: 'auto' });
  store.updateTask(a.id, { dependsOn: [never.id] });
  r.pump();
  assert.deepEqual(ran, [b.id]);
  assert.deepEqual(store.queue, [a.id]);
  // A task waiting for To do tasks queued after it (12.2 needs 12.1) does not stop the queue: 12.1 runs first.
  ran.length = 0;
  const later = store.addTask({ title: '12.1', mode: 'auto' }), head = store.addTask({ title: '12.2', mode: 'auto' });
  store.updateTask(head.id, { dependsOn: [later.id] });
  store.setQueue([head.id, later.id]);
  r.pump();
  assert.deepEqual(ran, [later.id]);
  assert.deepEqual(store.queue, [head.id]);
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

test('a deleted artifact source is not added back by a prompt that mentions it, until you add it by hand', () => {
  const { root } = leaseRepo();
  const link = 'https://claude.ai/artifact/5gSFCPn8TRg5KYfarQHeXL';
  assert.equal(A.addLinkSources(root, `use ${link}#page-dcb81aee8d83`).length, 1);
  assert.equal(R.load(root).length, 1, 'listed under ⧉ Artifacts');
  A.saveSources(root, []); A.markRemoved(root, `${link}#page-dcb81aee8d83`, true); R.remove(root, link);
  assert.equal(A.addLinkSources(root, `again ${link}`).length, 0);
  R.link(root, link, 'task1');
  assert.deepEqual(A.loadSources(root), []);
  assert.deepEqual(R.load(root), [], 'not back in ⧉ Artifacts either');
  A.markRemoved(root, link, false);
  assert.equal(A.addLinkSources(root, `again ${link}`).length, 1);
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

test('merge into the checked-out branch: your uncommitted files in the way stop it cleanly; JustCode\'s own are reset; task commits skip .justcode', async () => {
  const { root, sh } = leaseRepo();
  fs.mkdirSync(path.join(root, '.justcode', 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.justcode', 'plugin', 'p.json'), '1'); sh('add', '-A'); sh('commit', '-qm', 'tracked .justcode');
  const wt = path.join(root, '.wt'); sh('worktree', 'add', '-q', '-b', 'side', wt);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'side'); fs.writeFileSync(path.join(wt, '.justcode', 'plugin', 'p.json'), '2');
  assert.equal(await g.commitAll(wt, 'work'), true);
  assert.deepEqual(sh('diff', '--name-only', 'main', 'side').toString().trim().split('\n'), ['a.txt'], '.justcode stays off the branch');
  fs.writeFileSync(path.join(root, 'a.txt'), 'mine');                         // your uncommitted edit, in the way
  fs.writeFileSync(path.join(root, '.justcode', 'plugin', 'p.json'), '3');   // JustCode's own, rewritten locally
  const head = sh('rev-parse', 'main').toString();
  await assert.rejects(g.mergeBranch(root, 'main', 'side', 'x'), (e: any) => e instanceof g.LocalChanges && e.files.join() === 'a.txt' && /Commit or discard/.test(e.message));
  assert.equal(sh('rev-parse', 'main').toString(), head, 'nothing merged');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'mine', 'your edit is untouched');
  sh('checkout', '--', 'a.txt');
  assert.deepEqual(await g.mergeBranch(root, 'main', 'side', 'x'), []);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'side');
});

test('commitAll works when .gitignore lists .justcode (the usual case)', async () => {
  const { root, sh } = leaseRepo();
  fs.writeFileSync(path.join(root, '.gitignore'), '/.justcode/\n'); sh('add', '-A'); sh('commit', '-qm', 'ignore');
  fs.mkdirSync(path.join(root, '.justcode'), { recursive: true }); fs.writeFileSync(path.join(root, '.justcode', 'board.json'), '{}');
  fs.writeFileSync(path.join(root, 'a.txt'), 'work');
  fs.mkdirSync(path.join(root, 'graphify-out', 'cache'), { recursive: true }); fs.writeFileSync(path.join(root, 'graphify-out', 'cache', 'stat-index.json'), '{}');
  assert.equal(await g.commitAll(root, 'work'), true);
  assert.deepEqual(sh('show', '--name-only', '--format=', 'HEAD').toString().trim().split('\n'), ['a.txt'], 'no .justcode, no graphify-out cache');
});

test('a sprint whose merge is held up by your uncommitted files: the task is still merged, the sprint says why, and it merges once clear', async () => {
  const { root, sh } = leaseRepo();
  const store = new Store(root), notes: string[] = [];
  const r = leaseRunner(store, notes);
  const sp = store.addSprint('S1');
  const branch = `jc/sprint-x`; sh('branch', branch);
  store.updateSprint(sp.id, { branch, target: 'main' });
  const wt = path.join(root, '.wt'); sh('worktree', 'add', '-q', wt, branch);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'sprint'); sh('-C', wt, 'commit', '-qam', 's'); sh('worktree', 'remove', '--force', wt);
  fs.writeFileSync(path.join(root, 'a.txt'), 'mine');
  await r.mergeSprint(sp.id);
  assert.match(store.sprint(sp.id)!.blocked ?? '', /uncommitted changes in main.*a\.txt/);
  assert.equal(store.sprint(sp.id)!.branch, branch);
  sh('checkout', '--', 'a.txt');
  await r.sweep();
  assert.equal(store.sprint(sp.id)!.branch, undefined, 'merged by the sweep');
  assert.equal(store.sprint(sp.id)!.blocked, undefined);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'sprint');
  r.dispose();
});

test('a sprint held up by your files asks what to do: commit is recommended when they do not clash, Later when they do', async () => {
  const { root, sh } = leaseRepo();
  const lines = (n: number, at: number, v: string) => Array.from({ length: n }, (_, i) => i === at ? v : `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'b.txt'), lines(10, -1, '')); sh('add', '-A'); sh('commit', '-qm', 'b');
  const store = new Store(root);
  const r = leaseRunner(store);
  const asked: string[][] = [];
  r.d.choose = async (_text: string, ...b: string[]) => { asked.push(b); return b[0]; };   // take the recommendation
  const sp = store.addSprint('S1'), branch = 'jc/sprint-y'; sh('branch', branch);
  store.updateSprint(sp.id, { branch, target: 'main' });
  const wt = path.join(root, '.wt'); sh('worktree', 'add', '-q', wt, branch);
  fs.writeFileSync(path.join(wt, 'b.txt'), lines(10, 0, 'sprint')); sh('-C', wt, 'commit', '-qam', 's'); sh('worktree', 'remove', '--force', wt);
  // Clashing edit (same line): Later is recommended, and nothing changes.
  fs.writeFileSync(path.join(root, 'b.txt'), lines(10, 0, 'mine'));
  await r.mergeSprint(sp.id);
  for (let i = 0; i < 50 && !asked.length; i++) await new Promise(res => setTimeout(res, 20));
  assert.match(asked[0][0], /^Later \(recommended\)/);
  assert.equal(store.sprint(sp.id)!.branch, branch);
  assert.match(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), /mine/);
  // An edit elsewhere in the file: commit is recommended, and taking it commits then merges.
  fs.writeFileSync(path.join(root, 'b.txt'), lines(10, 8, 'mine'));
  store.updateSprint(sp.id, { blocked: undefined, blockedBy: undefined });
  await r.mergeSprint(sp.id);
  for (let i = 0; i < 100 && store.sprint(sp.id)!.branch; i++) await new Promise(res => setTimeout(res, 20));
  assert.match(asked[1][0], /^Commit them, then merge \(recommended\)/);
  assert.equal(store.sprint(sp.id)!.branch, undefined, 'merged');
  const merged = fs.readFileSync(path.join(root, 'b.txt'), 'utf8');
  assert.ok(merged.includes('sprint') && merged.includes('mine'), merged);
  assert.equal(sh('status', '--porcelain', '--', '.', ':(exclude).justcode').toString().trim(), '');
  r.dispose();
});

test('raising a budget clears every stop it covers and puts the To do tasks back in the queue', () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  r.pump = () => {};   // nothing really starts here
  const sp = store.addSprint('S1');
  setBudget(root, 'sprint', 50);
  const spent = store.addTask({ title: 'Spent', mode: 'auto', sprintId: sp.id }); store.updateTask(spent.id, { status: 'done', costUsd: 50.41 });
  const why = 'Budget reached: $50.41 of $50 (sprint). Raise the sprint budget in ⚙ Settings → Policy, then press Resume.';
  const a = store.addTask({ title: 'A', mode: 'auto', sprintId: sp.id }), b = store.addTask({ title: 'B', mode: 'auto', sprintId: sp.id });
  store.updateTask(a.id, { error: why }); store.updateTask(b.id, { error: why });
  assert.equal(r.budgetRaised(), 0, 'still over: nothing changes');
  setBudget(root, 'sprint', 100);
  assert.equal(r.budgetRaised(), 2);
  assert.equal(store.task(a.id)!.error, undefined);
  assert.deepEqual(store.queue, [a.id, b.id]);
  r.dispose();
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
  for (const f of ['.claude-plugin/plugin.json', 'skills/plan-tasks/SKILL.md', 'skills/design-from-artifact/SKILL.md', 'skills/fix-design/SKILL.md', 'agents/reviewer.md', 'agents/planner.md', 'agents/implementer.md'])
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, 'agents', 'reviewer.md'), 'utf8'), /<root>\/\.justcode\/tasks\/<id>\/shots\//);
  assert.deepEqual(fs.readdirSync(root), ['.justcode']);
  const b = writePlugin(root);
  assert.equal(b.written.length, 0);
  assert.equal(b.kept.length, a.written.length);
});

test('artifact path helpers stay under <root>/.justcode/', () => {
  const root = path.join(os.tmpdir(), 'jc-root');
  const base = path.join(root, '.justcode') + path.sep;
  const paths = [A.sourceCopy(root, 'x'), A.taskDir(root, 'x'), A.briefFile(root, 'x'), A.handoffFile(root, 'x'), A.artifactFile(root, 'x'), A.shotsDir(root, 'x'),
    A.reviewFile(root, 'x'), A.checksLog(root, 'x'), A.planFile(root, 'x'), A.progressFile(root), A.projectFile(root), A.designMdFile(root), A.promptsFile(root)];
  for (const p of paths) assert.ok(p.startsWith(base), p);
  assert.equal(A.shotsDir(root, 'x'), path.join(root, '.justcode', 'tasks', 'x', 'shots'));
});

test('src never writes CLAUDE.md, TASKS.md, .claude agents/skills or docs/', () => {
  const dir = path.join(__dirname, '..', '..', 'src');
  const bad = /CLAUDE\.md|TASKS\.md|\.claude[\\/'"`]?.*(agents|skills)|\bdocs[\\/]/;
  const hits: string[] = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ts')))
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((l, i) => { if (/(writeFileSync|copyFileSync|mkdirSync)/.test(l) && bad.test(l)) hits.push(`${f}:${i + 1}`); });
  assert.deepEqual(hits, []);
});

test('Store migrates where: root to direct', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-mig-'));
  fs.mkdirSync(path.join(root, '.justcode'), { recursive: true });
  fs.writeFileSync(path.join(root, '.justcode', 'board.json'), JSON.stringify({ sprints: [], tasks: [{ id: 'a', title: 'x', status: 'todo', mode: 'auto', where: 'root' }] }));
  assert.equal(new Store(root).data.tasks[0].where, 'direct');
});

test('resolveWhere: explicit wins, setting decides otherwise, remote is always a branch', () => {
  assert.equal(resolveWhere({}), 'direct');
  assert.equal(resolveWhere({ sprintId: 's' }), 'branch');
  assert.equal(resolveWhere({ setting: 'branch' }), 'branch');
  assert.equal(resolveWhere({ setting: 'direct', sprintId: 's' }), 'direct');
  assert.equal(resolveWhere({ where: 'direct', sprintId: 's' }), 'direct');
  assert.equal(resolveWhere({ where: 'direct', remote: true, setting: 'direct' }), 'branch');
  assert.equal(resolveWhere({ remote: true }), 'branch');
});

test('direct tasks: one at a time, not during a merge; directFiles = status minus dirty-before, no commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-direct-'));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 'a@b.c'); sh('config', 'user.name', 'a');
  fs.writeFileSync(path.join(root, 'a.txt'), '1'); sh('add', '-A'); sh('commit', '-qm', 'init');
  const store = new Store(root);
  const settings: any = { maxParallel: 2, taskModel: '', allowedTools: [], worktreeCopy: [], idleMinutes: 10, personalSetup: false, freshAfterTokens: 0, checks: 'none', setup: '', maxCheckRounds: 2, checkTimeoutMinutes: 1,
    review: { auto: false, model: '', lightModel: '', triage: true, maxAttempts: 3, autoMerge: false, mergeIfCannotRun: false, commands: [], timeoutMinutes: 1 } };
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => settings, limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  const t1 = store.addTask({ title: 'One', mode: 'auto', where: 'direct' });
  const t2 = store.addTask({ title: 'Two', mode: 'auto', where: 'direct' });
  // A second direct task is refused while the first is starting; the first is not affected.
  r.starting.add(t1.id);
  await assert.rejects(() => r.run(t2.id), /already working in the project folder/);
  r.starting.delete(t1.id);
  // Not while a merge (busy op) runs.
  r.busy.add('other');
  await assert.rejects(() => r.run(t2.id), /merge is running/);
  r.busy.delete('other');
  // turnEnded: only files that changed during the task, nothing committed.
  fs.writeFileSync(path.join(root, 'old.txt'), 'dirty before'); // already dirty at start
  fs.mkdirSync(A.taskDir(root, t1.id), { recursive: true });
  fs.writeFileSync(path.join(A.taskDir(root, t1.id), 'dirty-before.txt'), 'old.txt');
  fs.writeFileSync(path.join(root, 'new.txt'), 'x');
  const head = sh('rev-parse', 'HEAD').toString();
  store.updateTask(t1.id, { status: 'doing' });
  await r.turnEnded(t1.id, { ok: true, text: 'done' });
  assert.deepEqual(store.task(t1.id)!.directFiles, ['new.txt']);
  assert.equal(sh('rev-parse', 'HEAD').toString(), head);
});

test('git: workingDiff and workingChanges cover tracked edits and untracked files in the list only', async () => {
  const root = tmp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'x\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'hello\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'changed\n');
  const files = ['a.txt', 'new.txt'];
  const list = await g.workingChanges(root, head, files);
  assert.deepEqual(list.map(c => `${c.status} ${c.file}`).sort(), ['A new.txt', 'M a.txt']);
  const diff = await g.workingDiff(root, head, files);
  assert.match(diff, /\+two/);
  assert.match(diff, /\+\+\+ b\/new\.txt[\s\S]*\+hello/);
  assert.doesNotMatch(diff, /other\.txt/);
  assert.equal(await g.workingDiff(root, head, []), '');
});

// ---- direct tasks: Finish and Discard against a real temp repo ----
const gitSync = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const directRepo = () => {
  const d = tmp();
  gitSync(d, 'init', '-q'); gitSync(d, 'config', 'user.email', 't@t'); gitSync(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a1\n'); fs.writeFileSync(path.join(d, 'other.txt'), 'o1\n');
  gitSync(d, 'add', '-A'); gitSync(d, 'commit', '-q', '-m', 'init');
  return d;
};
const mkRunner = async (d: string, files: string[]) => {
  const { Runner } = await import('../runner');
  const store = new Store(d);
  const t = store.addTask({ title: 'My task', mode: 'auto' });
  store.updateTask(t.id, { where: 'direct', status: 'review', directFiles: files, startHead: gitSync(d, 'rev-parse', 'HEAD').trim() });
  const deps: any = { bin: () => undefined, env: () => ({}), settings: () => ({}), limits: new Limits(), notify() {}, choose: async () => undefined, cli: '' };
  return { r: new Runner(store, deps), store, id: t.id };
};

test('commitFiles commits only the listed files, skipping stale entries', async () => {
  const d = directRepo();
  fs.writeFileSync(path.join(d, 'a.txt'), 'a2\n'); fs.writeFileSync(path.join(d, 'new.txt'), 'n\n'); fs.writeFileSync(path.join(d, 'other.txt'), 'o2\n');
  fs.writeFileSync(path.join(d, 'staged.txt'), 's\n'); gitSync(d, 'add', 'staged.txt');
  const made = await g.commitFiles(d, 'My task', ['a.txt', 'new.txt', 'ghost.txt']);
  assert.equal(made, true);
  assert.equal(gitSync(d, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(gitSync(d, 'log', '-1', '--format=%s').trim(), 'My task');
  assert.deepEqual(gitSync(d, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['a.txt', 'new.txt']);
  assert.match(gitSync(d, 'status', '--porcelain'), /other\.txt/);
  assert.match(gitSync(d, 'status', '--porcelain'), /A  staged\.txt/);
  assert.equal(await g.commitFiles(d, 'again', ['a.txt']), false);
});

test('Runner.merge finishes a direct task: one commit, progress, done', async () => {
  const d = directRepo();
  fs.writeFileSync(path.join(d, 'a.txt'), 'a2\n'); fs.writeFileSync(path.join(d, 'other.txt'), 'o2\n');
  const { r, store, id } = await mkRunner(d, ['a.txt']);
  await r.merge(id);
  assert.equal(store.task(id)!.status, 'done'); assert.ok(store.task(id)!.doneAt);
  assert.equal(gitSync(d, 'log', '-1', '--format=%s').trim(), 'My task');
  assert.ok(fs.readFileSync(path.join(d, '.justcode', 'progress.md'), 'utf8').includes('My task'));
  assert.match(gitSync(d, 'status', '--porcelain'), /other\.txt/);
  r.dispose?.();
});

test('Runner.merge with nothing to commit still marks done; refuses a task still working', async () => {
  const d = directRepo();
  const { r, store, id } = await mkRunner(d, ['a.txt']);
  await r.merge(id);
  assert.equal(store.task(id)!.status, 'done');
  assert.equal(gitSync(d, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.ok(fs.existsSync(path.join(d, '.justcode', 'progress.md')));
  const w = await mkRunner(directRepo(), ['a.txt']);
  w.store.updateTask(w.id, { status: 'doing' });
  await w.r.merge(w.id);
  assert.equal(w.store.task(w.id)!.status, 'doing');
  r.dispose?.(); w.r.dispose?.();
});

test('Runner.discard reverts only the listed files and refuses done tasks', async () => {
  const d = directRepo();
  fs.mkdirSync(path.join(d, 'dir')); fs.writeFileSync(path.join(d, 'dir', 'x.txt'), 'x\n');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a2\n'); fs.writeFileSync(path.join(d, 'new.txt'), 'n\n'); fs.writeFileSync(path.join(d, 'st.txt'), 's\n');
  gitSync(d, 'add', 'st.txt'); fs.writeFileSync(path.join(d, 'other.txt'), 'o2\n'); fs.writeFileSync(path.join(d, 'keep.txt'), 'k\n');
  const { r, store, id } = await mkRunner(d, ['a.txt', 'new.txt', 'st.txt', 'dir']);
  await r.discard(id);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'a1\n');
  for (const f of ['new.txt', 'st.txt', 'dir']) assert.equal(fs.existsSync(path.join(d, f)), false);
  assert.equal(fs.readFileSync(path.join(d, 'other.txt'), 'utf8'), 'o2\n');
  assert.ok(fs.existsSync(path.join(d, 'keep.txt')));
  assert.equal(store.task(id)!.status, 'todo');
  store.updateTask(id, { status: 'done', directFiles: ['a.txt'] });
  await r.discard(id);
  assert.equal(store.task(id)!.status, 'done');
  r.dispose?.();
});

test('setup: Recommended rows are optional and follow the lookups', async () => {
  const { checkSetup, pluginInstallCommands } = await import('../setup');
  const run = (have: string[], md: boolean) => checkSetup(undefined, {}, '/p', false, { plugin: n => have.includes(n) ? '/x' : undefined, designMd: () => md });
  const s = await run(['superpowers'], false);
  const row = (id: string) => s.checks.find(c => c.id === id)!;
  for (const id of ['frontendDesign', 'superpowers', 'playwright', 'designMd']) assert.ok(row(id).optional);
  assert.ok(row('superpowers').ok && !row('frontendDesign').ok);
  assert.equal(row('playwright').fix?.action, 'installPlaywright');
  assert.equal(row('frontendDesign').fix?.action, 'installPlugin:frontend-design');
  assert.ok((await run([], true)).checks.find(c => c.id === 'designMd')!.ok);
  assert.equal(pluginInstallCommands('claude', 'superpowers').length, 2);
  // the install route registers a plugin named playwright, which is what the row looks up
  const { playwrightCommand } = await import('../setup');
  assert.equal(playwrightCommand('claude'), 'claude plugin install playwright@claude-plugins-official');
  assert.equal(row('playwright').fix?.action, 'installPlaywright');
});

test('installedPlugins: scopes, fallbacks, bare keys, two marketplaces, no skills/', () => {
  const dir = tmp(), mk = (n: string, skills = true) => { const d = path.join(dir, n); fs.mkdirSync(skills ? path.join(d, 'skills') : d, { recursive: true }); return d; };
  const file = path.join(dir, 'p.json');
  const [u, pr, only, bare, m1, m2, mcp] = [mk('u'), mk('pr'), mk('only'), mk('bare'), mk('m1'), mk('m2'), mk('mcp', false)];
  fs.writeFileSync(file, JSON.stringify({ plugins: {
    'both@x': [{ scope: 'project', installPath: pr }, { scope: 'user', installPath: u }],
    'proj@x': [{ scope: 'project', installPath: only }],
    'bare': [{ scope: 'user', installPath: bare }],
    'dup@a': [{ scope: 'user', installPath: m1 }], 'dup@b': [{ scope: 'user', installPath: m2 }],
    'playwright@claude-plugins-official': [{ scope: 'user', installPath: mcp }] } }));
  const all = installedPlugins(file);
  assert.equal(all.both, u);
  assert.equal(all.proj, only);
  assert.equal(all.bare, bare);
  assert.equal(all.dup, m1); // first marketplace wins
  assert.equal(all.playwright, mcp); // MCP-only plugin: no skills/ needed
  assert.equal(installedPlugin('playwright', file, 'skills'), undefined);
  assert.equal(installedPlugin('both', file, 'skills'), u);
});

test('design: listDesigns parses a tree and caches 24h; install writes sha256; brief section only for UI tasks', async () => {
  const D = await import('../design');
  const dir = tmp(), file = path.join(dir, 'c', 'designs.json');
  let calls = 0;
  const tree = { tree: [{ type: 'blob', path: 'design-md/stripe/DESIGN.md' }, { type: 'blob', path: 'design-md/apple/DESIGN.md' }, { type: 'blob', path: 'README.md' }, { type: 'tree', path: 'design-md/x' }] };
  const get = async () => { calls++; return tree; };
  assert.deepEqual((await D.listDesigns(get, 1000, file)).map(d => d.name), ['apple', 'stripe']);
  await D.listDesigns(get, 1000 + 3600e3, file);
  assert.equal(calls, 1);
  await D.listDesigns(get, 1000 + 25 * 3600e3, file);
  assert.equal(calls, 2);
  const root = tmp();
  const info = D.installDesign(root, '# Stripe\n', { source: 'awesome-design-md', name: 'stripe' });
  assert.equal(JSON.parse(fs.readFileSync(D.originFile(root), 'utf8')).sha256, info.sha256);
  assert.equal(info.sha256.length, 64);
  const ui = { id: 'u', title: 'Restyle the settings page', mode: 'auto', status: 'todo', created: 0 } as any;
  const be = { id: 'b', title: 'Fix retry logic in queue', mode: 'auto', status: 'todo', created: 0 } as any;
  assert.match(A.writeBrief(root, ui, []), /## Design system/);
  assert.match(A.writeBrief(root, { ...be, output: 'artifact' }, []), /## Design system/);
  assert.doesNotMatch(A.writeBrief(root, be, []), /## Design system/);
  D.removeDesign(root);
  assert.doesNotMatch(A.writeBrief(root, ui, []), /## Design system/);
});

test('playwright MCP: pinned, headless, saves into shots; review prompt UI section', () => {
  const m = playwrightMcp('/s').playwright;
  assert.equal(PLAYWRIGHT_TOOLS, 'mcp__playwright');
  assert.ok(m.args.some(a => /^@playwright\/mcp@\d+\.\d+\.\d+$/.test(a)));
  assert.deepEqual(m.args.slice(-5), ['--headless', '--isolated', '--allow-unrestricted-file-access', '--output-dir', '/s']);
  const task = { id: 'x', title: 't' } as any;
  const web = reviewPrompt(task, 'main', 'd', { shots: '/s', web: true });
  assert.match(web, /browser_take_screenshot/); assert.doesNotMatch(web, new RegExp(['npx', 'playwright', 'screenshot'].join(' ')));
  const none = reviewPrompt(task, 'main', 'd', { shots: '/s' });
  assert.doesNotMatch(none, /# UI checks/);
  assert.doesNotMatch(reviewPrompt(task, 'main', 'd', { shots: '/s', adb: { bin: 'adb', devices: ['a'] }, cli: 'c.js' }), /browser_take_screenshot/);
});

test('webOptions: MCP server and allow rule come together', () => {
  const on = webOptions(true, '/s', ['Read']);
  assert.deepEqual(on.allowed, [PLAYWRIGHT_TOOLS, 'Read']); assert.ok(on.mcpServers?.playwright);
  const off = webOptions(false, '/s', ['Read']);
  assert.deepEqual(off.allowed, ['Read']); assert.equal(off.mcpServers, undefined);
  assert.match(reviewPrompt({ id: 'x', title: 't' } as any, 'm', 'd', { shots: '/s', web: true }), /browser_install/);
  // A bare filename is saved relative to the server's cwd (the project), not --output-dir: checked live with 0.0.85.
  assert.match(reviewPrompt({ id: 'x', title: 't' } as any, 'm', 'd', { shots: '/s', web: true }), /absolute path "\/s\/<name>\.png"/);
});

test('UI wiring: webOptions reach the SDK options, the rule approves the server tools, the brief follows the same flag', () => {
  const w = webOptions(true, '/s', ['Read']);
  const o = toolOptions({ mcpServers: w.mcpServers, allowed: w.allowed });
  assert.deepEqual((o.mcpServers as any).playwright.args.slice(-2), ['--output-dir', '/s']);
  assert.ok(o.allowedTools?.includes('mcp__playwright'));
  assert.equal(toolOptions({ mcpServers: undefined, allowed: [] }).mcpServers, undefined);
  assert.ok(matches('mcp__playwright', 'mcp__playwright__browser_take_screenshot', {}));
  assert.ok(!matches('mcp__playwright', 'mcp__playwrightx__a', {}));
  assert.ok(!matches('mcp__play', 'mcp__playwright__a', {}));
  const root = tmp();
  const ui = { id: 'u', title: 'Restyle the settings page', mode: 'auto', status: 'todo', created: 0 } as any;
  const be = { id: 'b', title: 'Fix retry logic in queue', mode: 'auto', status: 'todo', created: 0 } as any;
  assert.equal(A.isUiTask(ui), true); assert.equal(A.isUiTask(be), false);
  assert.match(A.writeBrief(root, ui, []), /browser_take_screenshot/);
  assert.doesNotMatch(A.writeBrief(root, be, []), /browser_take_screenshot/);
});

import { designFromCodeBody, setupSkillBody } from '../skill';
import { checkSetup } from '../setup';
test('design: setup reads DESIGN.md from the code without asking; the checklist row starts that; catalog stays manual', async () => {
  const setup = setupSkillBody();
  assert.match(setup, /Do not ask about the design when the code already has a UI/);
  assert.match(setup, /DESIGN\.md\*\*: when the project has a UI[\s\S]*CSS custom properties/);
  const body = designFromCodeBody();
  assert.match(body, /Write only `\.justcode\/design\/DESIGN\.md`/);
  assert.match(body, /no UI code at all, write nothing/);
  assert.match(body, /Never invent values/);
  const st = await checkSetup(undefined, {}, tmp(), false, { plugin: () => undefined, designMd: () => false });
  assert.deepEqual(st.checks.find(c => c.id === 'designMd')!.fix, { action: 'designFromProject', label: 'Write from project' });
  // Claude already read the code and found no UI: the row offers the catalog instead of the same button again.
  const tried = await checkSetup(undefined, {}, tmp(), false, { plugin: () => undefined, designMd: () => false, designTried: () => true });
  const row = tried.checks.find(c => c.id === 'designMd')!;
  assert.deepEqual(row.fix, { action: 'designPick', label: 'Choose a design' });
  assert.match(row.detail!, /no styles in the code yet/);
});

test('splitTitle: a long prompt typed as the title keeps a short title and moves the text to the description', () => {
  assert.deepEqual(splitTitle('Fix login bug', 'details'), { title: 'Fix login bug', description: 'details' });
  const long = 'Create clickable mock screens for Tally Desk (see docs/project/project-description.md for the full spec). Mockups only: no Django or Angular code, no API calls.';
  const s = splitTitle(long);
  assert.ok(s.title.length <= 81, s.title);
  assert.equal(s.description, long);
  const nl = splitTitle('Add dark mode\nUse the theme tokens', 'extra');
  assert.equal(nl.title, 'Add dark mode');
  assert.equal(nl.description, 'Add dark mode\nUse the theme tokens\n\nextra');
});

test('runsApp: "run it so I can see it" goes to the project folder, ordinary work does not', () => {
  for (const t of ['pls build the project so I can see', 'Run the app with docker compose so I can open it in the browser', 'start the frontend locally', 'spin up the stack so we can test it'])
    assert.ok(runsApp(t), t);
  for (const t of ['Build merchant list, empty state and form', 'Add expenses API with scoping', 'Run the migrations for the new table', 'Fix the build'])
    assert.ok(!runsApp(t), t);
  assert.equal(resolveWhere({ sprintId: 's', runApp: true }), 'direct');
  assert.equal(resolveWhere({ sprintId: 's', runApp: true, where: 'branch' }), 'branch');
  assert.equal(resolveWhere({ sprintId: 's', runApp: true, remote: true }), 'branch');
});

test('staleStacks: only stacks of task folders no live task uses', () => {
  const { staleStacks } = require('../docker');
  const root = '/p/app', wt = (id: string) => `${root}/.justcode/worktrees/${id}`;
  const list = [
    { Name: 'app', ConfigFiles: `${root}/docker-compose.yml` },
    { Name: 'aaaa1111', ConfigFiles: `${wt('aaaa1111')}/docker-compose.yml` },
    { Name: 'bbbb2222', ConfigFiles: `${wt('bbbb2222')}/docker-compose.yml,/tmp/ov.yml` },
    { Name: 'other', ConfigFiles: '/q/other/.justcode/worktrees/cccc3333/docker-compose.yml' },
  ];
  assert.deepEqual(staleStacks(list, root, [wt('bbbb2222')]).map((s: any) => s.Name), ['aaaa1111']);
});

test('app: detects how to run a project and which link is the frontend', () => {
  const App = require('../app');
  const mk = (files: Record<string, string>) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-app-')); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; };
  assert.equal(App.detect(mk({ 'docker-compose.yml': 'services: {}' })).kind, 'Docker Compose');
  const ng = App.detect(mk({ 'frontend/package.json': JSON.stringify({ scripts: { start: 'ng serve' }, dependencies: { '@angular/core': '19' } }), 'backend/manage.py': '', '.env': 'FRONTEND_PORT=4209\nBACKEND_PORT=8009\n' }));
  assert.equal(ng.kind, 'Angular + Django');
  assert.deepEqual(ng.procs.map((p: any) => [p.role, p.port]), [['frontend', 4209], ['backend', 8009]]);
  assert.equal(App.detect(mk({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }) })).procs[0].port, 5173);
  assert.equal(App.detect(mk({ 'README.md': 'hi' })), undefined);
  const ps = App.parsePs('{"Service":"db","Publishers":[{"PublishedPort":5432,"TargetPort":5432}]}\n{"Service":"backend","Publishers":[{"PublishedPort":8009,"TargetPort":8000}]}\n{"Service":"frontend","Publishers":[{"PublishedPort":4209,"TargetPort":4200}]}\n{"Service":"mailpit","Publishers":[{"PublishedPort":8025,"TargetPort":8025}]}');
  assert.deepEqual(App.composeLinks(ps, {}).map((l: any) => [l.role, l.url]), [['frontend', 'http://localhost:4209'], ['backend', 'http://localhost:8009'], ['other', 'http://localhost:8025']]);
  assert.ok(App.needsBuild(['frontend/src/app/x.ts']));
  assert.ok(!App.needsBuild(['docs/plan.md', 'e2e/tests/a.spec.ts', '.justcode/progress.md']));
});

test('app: covers static sites, generators, PHP, Procfile, monorepos, Dockerfile, Make and printed URLs', () => {
  const App = require('../app');
  const mk = (files: Record<string, string>) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-app-')); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; };
  const kind = (f: Record<string, string>) => App.detect(mk(f))?.kind;
  assert.equal(kind({ 'index.html': '<h1>hi</h1>' }), 'Static site');
  assert.equal(kind({ 'public/index.html': '' }), 'Static site');
  assert.equal(kind({ 'hugo.toml': '', 'content/_index.md': '' }), 'Hugo');
  assert.equal(kind({ '_config.yml': '', 'Gemfile': '' }), 'Jekyll');
  assert.equal(kind({ 'mkdocs.yml': '' }), 'MkDocs');
  assert.equal(kind({ 'index.php': '<?php' }), 'PHP');
  assert.match(kind({ 'wp-config.php': '' }), /WordPress/);
  assert.equal(kind({ 'Procfile': 'web: gunicorn app:app' }), 'Procfile');
  assert.equal(kind({ 'Dockerfile': 'FROM nginx\nEXPOSE 80' }), 'Dockerfile');
  assert.equal(kind({ 'Makefile': 'dev:\n\tnpm run dev\n' }), 'make dev');
  assert.equal(kind({ 'package.json': JSON.stringify({ workspaces: ['apps/*'], scripts: { dev: 'turbo dev' } }), 'turbo.json': '{}' }), 'Monorepo dev script');
  assert.equal(kind({ 'mix.exs': 'defp deps do [{:phoenix, "~> 1.7"}] end' }), 'Phoenix');
  assert.equal(kind({ 'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web">' }), '.NET');
  assert.equal(kind({ 'main.py': 'from fastapi import FastAPI\napp = FastAPI()' }), 'FastAPI');
  assert.equal(kind({ 'app.py': 'import streamlit as st' }), 'Streamlit');
  assert.equal(kind({ 'go.mod': 'module x', 'main.go': '' }), 'Go');
  assert.equal(kind({ 'package.json': JSON.stringify({ scripts: { dev: 'node server.js' } }) }), 'dev script');
  // Python never installs into the system interpreter: a venv in .justcode/venv.
  const dj = App.detect(mk({ 'manage.py': '', 'requirements.txt': 'django' })).procs[0];
  assert.ok(dj.setup.some((s: string) => /-m venv .*\.justcode\/venv/.test(s)) && dj.setup.some((s: string) => /migrate/.test(s)));
  assert.deepEqual(App.printedUrls('\x1b[32m  ➜  Local:   http://localhost:5174/\x1b[0m\n  Network: http://192.168.1.2:5174/\n Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C)'), ['http://localhost:5174', 'http://localhost:8000']);
});

test('app: freePort skips a taken port', async () => {
  const App = require('../app');
  const net = require('net');
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const taken = s.address().port;
  const p = await App.freePort(taken);
  assert.notEqual(p, taken);
  s.close();
});

test('chat: its turn is only a reply (no commit, review or status change) and it never blocks a project-folder task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-chat-'));
  const store = new Store(root);
  const chat = store.addTask({ title: 'Chat', chat: true, where: 'direct', status: 'review', mode: 'default' } as any);
  const { Runner } = require('../runner');
  const r = new Runner(store, { settings: () => ({ review: { auto: true } }), notify: () => {}, limits: { held: () => false, update: () => {}, setReached: () => {} }, bin: () => undefined } as any);
  await r.turnEnded(chat.id, { ok: true, text: 'Here is the answer.', costUsd: 0.01 } as any);
  const t = store.task(chat.id)!;
  assert.equal(t.status, 'review');
  assert.equal(t.reply, 'Here is the answer.');
  assert.equal(t.review, undefined);
  r.dispose();
});

test('ignoreJustcode: adds /.justcode/ to .gitignore once, and respects an existing rule', () => {
  const g = require('../git');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ign-'));
  assert.equal(g.ignoreJustcode(d), true);
  assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /^\/\.justcode\/$/m);
  assert.equal(g.ignoreJustcode(d), false);
  const e = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ign-'));
  fs.writeFileSync(path.join(e, '.gitignore'), 'node_modules\n.justcode');
  assert.equal(g.ignoreJustcode(e), false);
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ign-'));
  fs.writeFileSync(path.join(f, '.gitignore'), 'node_modules');
  g.ignoreJustcode(f);
  assert.equal(fs.readFileSync(path.join(f, '.gitignore'), 'utf8'), 'node_modules\n\n# JustCode (local board, task folders, logs)\n/.justcode/\n');
});

test('chat never blocks: a chat with changed files is not an open project-folder task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-od-'));
  const store = new Store(root);
  store.addTask({ title: 'Chat', chat: true, where: 'direct', status: 'review', mode: 'default', directFiles: ['a.ts'] } as any);
  const { Runner } = require('../runner');
  const r = new Runner(store, { settings: () => ({ review: {} }), notify: () => {}, limits: { held: () => false }, bin: () => undefined } as any);
  assert.equal(r.openDirect(), undefined);
  const q = store.addTask({ title: 'Quick fix', where: 'direct', status: 'review', mode: 'default', directFiles: ['b.ts'] } as any);
  assert.equal(r.openDirect()?.id, q.id);
  r.dispose();
});

test('cleanup: finished tasks lose transcripts and screenshots, keep brief and handoff; deleted tasks go whole', () => {
  const C = require('../cleanup');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-clean-'));
  const w = (p: string, c = 'x') => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
  w('.justcode/tasks/done1/transcript.jsonl', 'x'.repeat(5000)); w('.justcode/tasks/done1/brief.md'); w('.justcode/tasks/done1/handoff.md'); w('.justcode/tasks/done1/shots/a.png', 'png');
  w('.justcode/tasks/live1/transcript.jsonl'); w('.justcode/tasks/gone1/brief.md'); w('.justcode/attachments/gone1/a.png');
  const tasks = [{ id: 'done1', status: 'done', doneAt: Date.now() - 20 * 86400000 }, { id: 'live1', status: 'doing' }] as any;
  const items = C.scan(root, tasks);
  const by = (k: string) => items.find((i: any) => i.kind === k);
  assert.equal(by('logs').count, 1);
  assert.equal(by('gone').count, 2);
  assert.equal(C.scan(root, tasks, 30).find((i: any) => i.kind === 'logs'), undefined, 'not yet 30 days old');
  C.removeFiles(items.filter((i: any) => i.kind === 'logs' || i.kind === 'gone'));
  assert.ok(fs.existsSync(path.join(root, '.justcode/tasks/done1/brief.md')) && fs.existsSync(path.join(root, '.justcode/tasks/done1/handoff.md')));
  assert.ok(!fs.existsSync(path.join(root, '.justcode/tasks/done1/transcript.jsonl')) && !fs.existsSync(path.join(root, '.justcode/tasks/done1/shots')));
  assert.ok(fs.existsSync(path.join(root, '.justcode/tasks/live1/transcript.jsonl')));
  assert.ok(!fs.existsSync(path.join(root, '.justcode/tasks/gone1')) && !fs.existsSync(path.join(root, '.justcode/attachments/gone1')));
});

test('app: a command that hangs is stopped at its timeout, with everything it started', async () => {
  const App = require('../app');
  const t0 = Date.now();
  assert.equal(typeof await App.pingDocker(), 'boolean');
  assert.ok(Date.now() - t0 < 15000, 'the Docker check never hangs');
});

test('app: links from nginx server names (https when ssl) and .env URLs, with a note for a name that does not resolve', async () => {
  const App = require('../app');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ngx-'));
  fs.mkdirSync(path.join(d, 'nginx'));
  fs.writeFileSync(path.join(d, 'nginx', 'default.conf'), 'server { listen 80; server_name _; }\nserver { listen 443 ssl; server_name viaje.test, www.viaje.test; ssl_certificate /c.pem; }\nserver { listen 80; server_name localhost; }');
  assert.deepEqual(App.nginxHosts(d), [{ host: 'viaje.test', ssl: true }, { host: 'www.viaje.test', ssl: true }]);
  const links = await App.configuredLinks(d, { FRONTEND_URL: 'http://localhost:4200', API_URL: 'http://localhost:8882/api/', SECRET: 'x' }, [{ target: 443, port: 8443, service: 'nginx' }, { target: 80, port: 8080, service: 'nginx' }]);
  assert.deepEqual(links.map((l: any) => [l.role, l.url]), [['frontend', 'http://localhost:4200'], ['backend', 'http://localhost:8882/api/'], ['other', 'https://viaje.test:8443'], ['other', 'https://www.viaje.test:8443']], 'a name that does not resolve is listed under Other with the hosts fix');
  assert.match(links[2].note, /\/etc\/hosts/);
});

test('app: after a merge it rebuilds only for build inputs, otherwise restarts', () => {
  const App = require('../app');
  assert.equal(App.modeFor(['frontend/src/app/x.ts', 'backend/api/views.py']), 'restart');
  for (const f of ['Dockerfile', 'frontend/Dockerfile.dev', 'docker-compose.yml', 'frontend/package.json', 'package-lock.json', 'backend/requirements.txt', 'backend/app/migrations/0004_x.py', 'go.mod', 'nginx/nginx.conf'])
    assert.equal(App.modeFor(['src/a.ts', f]), 'build', f);
});

test('app: test and job containers are never the frontend or backend', () => {
  const App = require('../app');
  const ps = App.parsePs(JSON.stringify([
    { Service: 'api', Publishers: [{ PublishedPort: 9009, TargetPort: 9009 }] },
    { Service: 'playwright-worker', Publishers: [{ PublishedPort: 3001, TargetPort: 3000 }] },
    { Service: 'frontend', Publishers: [{ PublishedPort: 4200, TargetPort: 4200 }] },
  ]));
  assert.deepEqual(App.composeLinks(ps, {}).map((l: any) => [l.label, l.role]), [['frontend', 'frontend'], ['api', 'backend'], ['playwright-worker', 'other']]);
});

test('app: a "building" state left by a reloaded window is checked, not waited on forever', async () => {
  const App = require('../app');
  const http = require('http');
  const srv = http.createServer((_q: any, r: any) => r.end('ok')); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-stale-'));
  fs.mkdirSync(path.join(root, '.justcode'));
  fs.writeFileSync(path.join(root, '.justcode', 'app.json'), JSON.stringify({ state: 'building', links: [{ role: 'frontend', label: 'web', url: `http://127.0.0.1:${srv.address().port}` }] }));
  App.view(root);
  for (let i = 0; i < 20 && App.load(root).state === 'building'; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(App.load(root).state, 'running');
  srv.close();
});

test('conflicts: when Claude resolved and staged them, the turn end finishes the merge and clears the card', async () => {
  const { execFileSync: x } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-conf-'));
  const git = (...a: string[]) => x('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'task'); fs.writeFileSync(path.join(repo, 'a.txt'), 'task\n'); git('commit', '-qam', 'task');
  git('checkout', '-q', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'main\n'); git('commit', '-qam', 'main');
  git('checkout', '-q', 'task');
  try { git('merge', '--no-edit', 'main'); } catch { /* the conflict */ }
  fs.writeFileSync(path.join(repo, 'a.txt'), 'task and main\n'); git('add', 'a.txt');   // what Claude did
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-confs-')));
  const t = store.addTask({ title: 'T', status: 'doing', mode: 'default', worktree: repo, branch: 'task', base: 'main', conflicts: ['a.txt'] } as any);
  const { Runner } = require('../runner');
  const r = new Runner(store, { settings: () => ({ review: { auto: false }, checks: '', setup: '' }), notify: () => {}, limits: { held: () => false, update: () => {}, setReached: () => {} }, bin: () => undefined } as any);
  await r.turnEnded(t.id, { ok: true, text: 'Resolved.' } as any);
  assert.equal(store.task(t.id)!.conflicts, undefined);
  assert.match(git('log', '-1', '--format=%P'), / /, 'the merge commit was made');
  r.dispose();
});

test('merge: clicked while the checks run, it is remembered and done once they and the review pass', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-later-')));
  const t = store.addTask({ title: 'T', status: 'review', mode: 'default', worktree: '/w', branch: 'b', base: 'main' } as any);
  const { Runner } = require('../runner');
  const r = new Runner(store, { settings: () => ({ review: { auto: true } }), notify: () => {}, limits: { held: () => false }, bin: () => undefined } as any);
  r.holdsLease = () => true; r.requireLease = () => {};
  r.checking.add(t.id);
  await r.merge(t.id);
  assert.equal(store.task(t.id)!.mergeWhenReady, true);
  const merged: string[] = [];
  r.merge = async (id: string) => { merged.push(id); };
  await r.sweep();
  assert.deepEqual(merged, [], 'still checking');
  r.checking.delete(t.id);
  store.updateTask(t.id, { review: { state: 'pass', attempts: 1 } } as any);
  await r.sweep();
  assert.deepEqual(merged, [t.id]);
  store.updateTask(t.id, { mergeWhenReady: true, review: { state: 'fail', attempts: 1, issues: [] } } as any);
  await r.sweep();
  assert.match(store.task(t.id)!.warning ?? '', /Not merged: the AI review found issues/);
  r.dispose();
});

test('docker: stacks of finished or gone task folders, in any project, are stale; live ones and unreadable boards are kept', () => {
  const { staleAcross } = require('../docker');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-all-'));
  const wt = (id: string) => { const d = path.join(root, '.justcode', 'worktrees', id); fs.mkdirSync(d, { recursive: true }); return d; };
  const live = wt('live1'), done = wt('done1');
  const list = [
    { Name: 'live1', ConfigFiles: `${live}/docker-compose.yml` }, { Name: 'done1', ConfigFiles: `${done}/docker-compose.yml` },
    { Name: 'gone1', ConfigFiles: `${root}/.justcode/worktrees/gone1/docker-compose.yml` }, { Name: 'proj', ConfigFiles: `${root}/docker-compose.yml` },
  ];
  const board = { tasks: [{ worktree: live, status: 'doing' }, { worktree: done, status: 'done' }] };
  assert.deepEqual(staleAcross(list, () => board).map((s: any) => s.Name), ['done1', 'gone1']);
  assert.deepEqual(staleAcross(list, () => undefined).map((s: any) => s.Name), ['gone1'], 'no board: only folders that are gone');
});

test('checks: a command that leaves a background process holding its output still finishes', async () => {
  const C = require('../checks');
  const t0 = Date.now();
  const r = await C.runCommand('(sleep 30 &) ; echo done', os.tmpdir(), { ...process.env }, 60_000);
  assert.equal(r.code, 0);
  assert.match(r.out, /done/);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
});

test('checks: watch-mode test runners run once', () => {
  const C = require('../checks');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-once-'));
  fs.writeFileSync(path.join(d, 'karma.conf.js'), '');
  assert.equal(C.oneShot('ng test', d), '--watch=false --browsers=ChromeHeadless');
  assert.equal(C.oneShot('ng test --watch=false', d), '');
  assert.equal(C.oneShot('vitest', d), '--run');
  assert.equal(C.oneShot('vitest run', d), '');
  assert.equal(C.oneShot('react-scripts test', d), '--watchAll=false');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'ng test' } }));
  assert.equal(C.detectChecks(d).find((c: any) => c.name === 'tests').cmd, 'npm test --silent -- --watch=false --browsers=ChromeHeadless');
});

test('code map: built into .justcode only, refreshed when the commit changes, handed to sessions as read-only commands', { skip: !require('../codemap').bins().graphify && 'graphify not installed' }, async () => {
  const CodeMap = require('../codemap');
  const { root, sh } = leaseRepo();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'pay.ts'), 'export function total(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }\nexport function checkout(xs: number[]) { return total(xs) * 1.12; }\n');
  sh('add', '-A'); sh('commit', '-qm', 'code');
  assert.deepEqual(CodeMap.sessionOptions(root, true).allowed, [], 'no map yet: nothing handed over');
  assert.equal(await CodeMap.refresh(root), true);
  assert.ok(fs.existsSync(CodeMap.graphFile(root)));
  assert.deepEqual(fs.readdirSync(root).sort(), ['.git', '.justcode', 'a.txt', 'src'], 'nothing outside .justcode');
  const t0 = fs.statSync(CodeMap.graphFile(root)).mtimeMs;
  await CodeMap.refresh(root);
  assert.equal(fs.statSync(CodeMap.graphFile(root)).mtimeMs, t0, 'same commit: not rebuilt');
  const o = CodeMap.sessionOptions(root, true);
  assert.ok(o.allowed.some((r: string) => / query:\*\)$/.test(r)) && /query "<question>" --graph/.test(o.rule));
  assert.deepEqual(CodeMap.sessionOptions(root, false).allowed, [], 'setting off: nothing');
  const out = execFileSync(CodeMap.bins().graphify, ['explain', 'checkout()', '--graph', CodeMap.graphFile(root)]).toString();
  assert.match(out, /total/);
  // A sprint task's folder: its own map, started from the project's and brought up to its branch (which has code main lacks).
  sh('branch', 'jc/sprint'); const wt = path.join(root, '.justcode', 'worktrees', 't1');
  sh('worktree', 'add', '-q', '-b', 'jc/t1', wt, 'jc/sprint');
  fs.writeFileSync(path.join(wt, 'src', 'refund.ts'), 'import { total } from "./pay";\nexport function refund(xs: number[]) { return -total(xs); }\n');
  sh('-C', wt, 'add', '-A'); sh('-C', wt, 'commit', '-qm', 'refund');
  const o2 = await CodeMap.forSession(wt, root, true);
  assert.ok(o2.rule.includes(CodeMap.graphFile(wt)), 'the session queries its own folder\'s map');
  assert.equal(await CodeMap.refresh(wt), true);
  const has = (dir: string) => /refund/.test(fs.readFileSync(CodeMap.graphFile(dir), 'utf8'));
  assert.ok(has(wt), 'task map has the branch\'s code');
  await CodeMap.refresh(root, true);
  assert.ok(!has(root), 'project map holds no copy of task folders');
});

test('terse replies: the installed caveman rules, without their on/off section, with files kept in normal prose', { skip: !require('../claude').installedPlugin('caveman', undefined, 'skills') && 'caveman not installed' }, () => {
  const r = require('../terse').rules();
  assert.match(r, /^## Reply style \(caveman\)/);
  assert.match(r, /Files you write .* normal clear prose/);
  assert.match(r, /Answer first/);
  assert.doesNotMatch(r, /## Persistence|stop caveman/);
  assert.ok(r.length < 6000, `small enough to add to every task: ${r.length} chars`);
});

test('commit messages: the project\'s own rules are found and named in the brief; the task\'s commit.md is used; per-turn commits squash into one', async () => {
  const { root, sh } = leaseRepo();
  assert.match(A.commitInstructions(root, 'x1'), /Conventional Commits/, 'no rules: Conventional Commits');
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'git-commit.md'), 'type(scope): description');
  assert.deepEqual(A.commitRules(root), [path.join(root, '.claude', 'commands', 'git-commit.md')]);
  assert.match(A.commitInstructions(root, 'x1'), /git-commit\.md: only its message format applies/);
  const t = { id: 'x1', title: 'Add bundle dialog' };
  assert.equal(A.commitMessage(root, t), 'Add bundle dialog', 'no commit.md: the title');
  fs.mkdirSync(A.taskDir(root, 'x1'), { recursive: true });
  fs.writeFileSync(A.commitFile(root, 'x1'), '```\nfeat(bundles): add bundle details dialog\n\n- Show members and price\n```\n');
  assert.equal(A.commitMessage(root, t), 'feat(bundles): add bundle details dialog\n\n- Show members and price');
  assert.equal(A.commitSubject(root, t), 'feat(bundles): add bundle details dialog');
  fs.writeFileSync(A.commitFile(root, 'x1'), '# Commit\nlots of prose');
  assert.equal(A.commitMessage(root, t), 'Add bundle dialog', 'a heading is not a commit message');
  sh('checkout', '-q', '-b', 'jc/x1');
  for (const n of [1, 2, 3]) { fs.writeFileSync(path.join(root, `f${n}.txt`), String(n)); sh('add', '-A'); sh('commit', '-qm', `turn ${n}`); }
  assert.equal(await g.squash(root, 'main', 'feat(x): one commit\n\n- three files'), true);
  assert.equal(sh('rev-list', '--count', 'main..HEAD').toString().trim(), '1');
  assert.equal(sh('log', '-1', '--format=%B').toString().trim(), 'feat(x): one commit\n\n- three files');
  const files = sh('diff', '--name-only', 'main', 'HEAD').toString();
  assert.ok(['f1.txt', 'f2.txt', 'f3.txt'].every(f => files.includes(f)), 'every turn\'s change is in the one commit');
});

test('cost: the SDK reports a running total per session, so each turn adds only what it rose by', () => {
  const { spent } = require('../store');
  let seen: any;
  let d = spent(seen, 's1', 0.5); seen = d.seen; assert.equal(d.delta, 0.5);
  d = spent(seen, 's1', 0.8); seen = d.seen; assert.ok(Math.abs(d.delta - 0.3) < 1e-9, 'turn 2 of the same session: only its share');
  d = spent(seen, 's1', 1.1); seen = d.seen; assert.ok(Math.abs(d.delta - 0.3) < 1e-9, 'resumed: the restored spend is not counted again');
  d = spent(seen, 's2', 0.2); seen = d.seen; assert.equal(d.delta, 0.2, 'another session counts on its own');
  d = spent(seen, 's1', 0.1); assert.equal(d.delta, 0.1, 'a total that went down started over: all of it is new');
  const root = tmp(); const store = new Store(root);
  store.addPlannerCost(0.4, 'p'); store.addPlannerCost(0.6, 'p');
  assert.ok(Math.abs(store.data.plannerCostUsd! - 0.6) < 1e-9);
});

test('efficiency: map lookup becomes a short file list; caveman rules are trimmed; the reminder rides on every message', async () => {
  const CodeMap = require('../codemap');
  const out = 'Traversal: BFS\n\nNODE Stop [src=../backend/runs/models.py loc=L16 community=1]\nNODE models.py [src=../backend/runs/models.py loc=L1 community=1]\nNODE complete_stop() [src=../backend/runs/services.py loc=L40 community=2]\nEDGE Stop --contains--> models.py\n';
  assert.equal(CodeMap.looksAt(out), '- backend/runs/models.py: Stop\n- backend/runs/services.py: complete_stop()');
  assert.equal(CodeMap.looksAt('No matching nodes found.'), undefined);
  const r = require('../terse').rules();
  if (r) { assert.doesNotMatch(r, /## Why|## Pre-send check|^Bad:|^Good:/m); assert.match(r, /### 1\. Answer first/); }
  const s = new Session({ bin: 'claude', cwd: '/x', sessionId: 'id', resume: false, mode: 'auto', allowed: [], rules: () => [], env: {}, idleMs: 60_000, label: 'T', remind: 'Be brief.' });
  const h: any = (s as any).hooks().hooks;
  assert.deepEqual(await h.UserPromptSubmit[0].hooks[0]({}), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Be brief.' } });
  assert.equal(h.PreToolUse, undefined, 'no guard: no PreToolUse hook');
  assert.deepEqual((new Session({ bin: 'claude', cwd: '/x', sessionId: 'id', resume: false, mode: 'auto', allowed: [], rules: () => [], env: {}, idleMs: 60_000, label: 'T' }) as any).hooks(), {});
});

test('code map for planner and reviewer: changed names from a diff; outline only for a big map, without tests', () => {
  const CodeMap = require('../codemap');
  const diff = 'diff --git a/a.py b/a.py\n+++ b/a.py\n@@ -1,3 +1,4 @@ def stock_levels(branch):\n+def build_report(x):\n-class OldThing:\n+    def test_it(self):\n+const loadAll = async (x) => x\n';
  assert.deepEqual(CodeMap.changedNames(diff), ['stock_levels', 'build_report', 'OldThing', 'loadAll']);
  const dir = tmp(); fs.mkdirSync(CodeMap.mapDir(dir), { recursive: true });
  const write = (n: number) => fs.writeFileSync(CodeMap.graphFile(dir), JSON.stringify({
    nodes: [{ id: 'hub', label: 'Order', source_file: '../backend/orders/models.py', source_location: 'L5' }, { id: 't', label: 'OrderTests', source_file: '../backend/orders/tests.py', source_location: 'L1' },
      ...Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `f${i}()`, source_file: `../frontend/src/f${i % 3}.ts`, source_location: 'L1' }))],
    links: [...Array.from({ length: 40 }, (_, i) => ({ source: `n${i}`, target: 'hub' })), ...Array.from({ length: 60 }, (_, i) => ({ source: `n${i}`, target: 't' }))] }));
  write(10);
  assert.equal(CodeMap.overview(dir), undefined, 'small project: no outline');
  assert.equal(CodeMap.big(dir), false);
  write(600);
  const o = CodeMap.overview(dir);
  assert.match(o, /Main folders .*frontend\/src \(600\)/);
  assert.match(o, /- Order \(backend\/orders\/models\.py:5\)/);
  assert.doesNotMatch(o, /OrderTests/, 'test code is not an outline hub');
});

test('fix to match: a design with screens/ is described in the brief, and the review checks the screenshots against it', () => {
  const root = tmp(), copy = A.sourceCopy(root, 'd1');
  const ref = path.join(root, '.justcode', 'design', 'ref', 'd1');
  fs.mkdirSync(ref, { recursive: true }); fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(ref, 'screens.json'), '{"screens":[]}');
  const src: A.Source = { id: 'd1', kind: 'url', ref: 'https://claude.ai/artifact/Abc' };
  const task = { id: 't1', title: 'Match the login screen', description: `Files: ${path.join(ref, 'c-login-390.png')}`, mode: 'auto', status: 'todo', created: 0 } as any;
  const brief = A.writeBrief(root, task, [src]);
  assert.match(brief, /screens\.json lists every screen/);
  assert.match(brief, /<screen>~<label>\[~<label>…\]-<width>; states\.json lists each with its steps/);
  assert.match(brief, /"states": "[^"]*design\/ref\/d1\/states\.json"/);
  assert.match(reviewPrompt(task, 'main', 'd', { shots: '/s', web: true }), /# Design match/);
  assert.doesNotMatch(reviewPrompt({ ...task, description: 'Files: a.ts' }, 'main', 'd', { shots: '/s', web: true }), /# Design match/);
});

import { diffMeasures, parseMeasure } from '../designdiff';
import { SHOT_CODE, MEASURE_FN } from '../skill';
test('design diff: measured from code, matched by text, within a few pixels', () => {
  const item = (text: string, o: any = {}) => ({ text, x: 0, w: 100, h: 20, font: 'Fira Sans', size: 14, weight: '400', color: 'rgb(0, 0, 0)', align: 'start', bg: 'rgba(0, 0, 0, 0)', radius: '0px', box: { x: 530, w: 380, pad: '40px', radius: '12px', bg: 'rgb(255, 255, 255)', border: '1px rgb(0, 0, 0)' }, ...o });
  const design = { items: [item('Log in', { size: 34, font: 'Bricolage Grotesque' }), item('Then apply to Agos'), item('Password')] };
  const app = { items: [item('Log in', { size: 34, font: 'Trebuchet MS', w: 103 }), item('Password', { box: { x: 500, w: 430, pad: '40px', radius: '12px', bg: 'rgb(255, 255, 255)', border: '1px rgb(0, 0, 0)' } }), item('Show password')] };
  assert.deepEqual(diffMeasures(design, app), [
    '"Log in" font: design Bricolage Grotesque, app Trebuchet MS',
    'container of "Password" x: design 530px, app 500px',
    'container of "Password" w: design 380px, app 430px',
    'missing in app: "Then apply to Agos"',
    'extra in app: "Show password"',
  ]);
  assert.deepEqual(diffMeasures(design, design), []);
  assert.deepEqual(diffMeasures({ items: [item('svg', { size: 16 })] }, { items: [item('svg', { size: 13 })] }), [], 'unlabelled icons are not paired by order');
  assert.equal(parseMeasure(JSON.stringify(JSON.stringify(design))).items.length, 3, 'a result saved as a JSON string');
  // The browser code is embedded in prompts: it must be valid JavaScript with its placeholders.
  assert.doesNotThrow(() => new Function(`return (${SHOT_CODE.replace("'URL'", "'u'").replace('WIDTH', '390').replace("'PNG'", "'p'").replace('ACTIONS', '[{"click":"Pay","fill":[{"label":"Name","value":"x"}]}]')})`));
  assert.doesNotThrow(() => new Function(`return (${MEASURE_FN})`));
});

import { parseJobs, resultOf, shotCode, diffAll } from '../designcapture';
test('design capture: one jobs file for every screen, run_code results read back, every pair diffed', () => {
  const jobs = parseJobs(JSON.stringify({ groups: [{ setup: 'async (page) => 1', shots: [{ url: 'file:///a.html', width: 390, png: '/s/a-390.png', json: '/s/a-390.json' }] }] }));
  assert.equal(jobs.groups[0].shots.length, 1);
  assert.equal(parseJobs(JSON.stringify([{ url: 'u', width: 1440, png: 'p', json: 'j' }])).groups.length, 1, 'a bare list of shots');
  assert.throws(() => parseJobs('{"groups":[{"shots":[{"url":"u"}]}]}'), /url, width/);
  assert.match(shotCode(jobs.groups[0].shots[0]), /const url = "file:\/\/\/a\.html", width = 390, png = "\/s\/a-390\.png"/);
  assert.deepEqual(resultOf('### Result\n[{"name":"a","html":"<p>"}]\n### Ran Playwright code\n```js'), [{ name: 'a', html: '<p>' }]);
  const root = tmp(), d = path.join(root, 'd'), a = path.join(root, 'a');
  fs.mkdirSync(d); fs.mkdirSync(a);
  const it = (text: string, size: number) => ({ text, x: 0, w: 10, h: 10, font: 'F', size, weight: '400', color: 'c', align: 'start', bg: 'b', radius: '0px', box: null });
  fs.writeFileSync(path.join(d, 'x-390.json'), JSON.stringify({ items: [it('Hi', 16)] }));
  fs.writeFileSync(path.join(a, 'x-390.json'), JSON.stringify({ items: [it('Hi', 15)] }));
  fs.writeFileSync(path.join(d, 'y-390.json'), JSON.stringify({ items: [it('Same', 16)] }));
  fs.writeFileSync(path.join(a, 'y-390.json'), JSON.stringify({ items: [it('Same', 16)] }));
  assert.deepEqual(diffAll(d, a, a).rows.map(r => ({ name: r.name, n: r.n })), [{ name: 'x-390', n: 1 }, { name: 'y-390', n: 0 }]);
  assert.match(fs.readFileSync(path.join(a, 'compare.html'), 'utf8'), /<h2>x-390 <small>1 difference/, 'a side-by-side page of every pair');
  assert.match(fs.readFileSync(path.join(a, 'x-390.diff.txt'), 'utf8'), /"Hi" size: design 16, app 15/);
});

import { screenOf } from '../designcapture';
test('screen names', () => {
  assert.equal(screenOf('c-root-guest-1440'), 'c-root-guest');
});
test('fix to match: text the app lacks or adds is not a shared style, and states are not more screens', () => {
  const root = tmp(), shots = path.join(root, 'screens'), audit = path.join(root, 'audit');
  fs.mkdirSync(shots); fs.mkdirSync(audit);
  const it = (text: string, size = 14) => ({ text, cls: 'muted', x: 0, w: 10, h: 10, font: 'F', size, weight: '400', color: 'c', align: 'start', bg: 'b', radius: '0px', box: null });
  for (const n of ['c-a-390', 'c-a~menu-390', 'c-a~more-390', 'c-b-390', 'c-b~menu-390']) {
    fs.writeFileSync(path.join(shots, `${n}.json`), JSON.stringify({ items: [it('Title')] }));
    fs.writeFileSync(path.join(audit, `${n}.json`), JSON.stringify({ items: [it('Title', 13), it('Switch role')] }));
  }
  const r = diffAll(shots, audit, audit);
  assert.deepEqual(r.shared, [], 'on 2 screens (5 with states), and "Switch role" is content');
  assert.match(fs.readFileSync(path.join(audit, 'c-a~menu-390.diff.txt'), 'utf8'), /extra in app: "Switch role"/, 'still a difference of the screen');
});

import { isSample, usableSample } from '../designdiff';
test('design sample data: whole values only, so a sentence mentioning one is still compared', () => {
  const sample = usableSample(['Malanday', '₱75', 'Blk 7 Lot 12 Sampaguita St., Brgy. Malanday', 'Then apply to Agos Water – Malanday. You will not need to register again.']);
  assert.deepEqual(sample, ['Malanday', '₱75', 'Blk 7 Lot 12 Sampaguita St., Brgy. Malanday'], 'an address is sample, a sentence is copy');
  assert.ok(isSample('Malanday', sample));
  assert.ok(isSample('₱75 · 3', sample));
  assert.ok(!isSample('Then apply to Agos Water – Malanday.', sample));
});

import { similarity } from '../designdiff';
import { pixelScore } from '../designcapture';
import { PNG } from 'pngjs';
test('design diff: near copy is one element, and screenshots get a pixel score with a diff image', () => {
  const it = (text: string, cls = 'muted') => ({ text, cls, x: 0, w: 10, h: 10, font: 'F', size: 14, weight: '400', color: 'c', align: 'start', bg: 'b', radius: '0px', box: null });
  assert.ok(similarity('You won\'t need to register again.', 'You will not need to register again.') > 0.6);
  assert.deepEqual(diffMeasures({ items: [it("You won't need to register again.")] }, { items: [it('You will not need to register again.')] }),
    ['copy differs: design "You won\'t need to register again.", app "You will not need to register again."']);
  assert.deepEqual(diffMeasures({ items: [it('Orders')] }, { items: [it('Logout', 'x')] }), ['missing in app: "Orders"', 'extra in app: "Logout"'], 'unalike texts stay apart');
  const root = tmp(), png = (name: string, w: number, h: number, red: number) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < p.data.length; i += 4) { p.data[i] = (i / 4) < red ? 255 : 255; p.data[i + 1] = (i / 4) < red ? 0 : 255; p.data[i + 2] = (i / 4) < red ? 0 : 255; p.data[i + 3] = 255; } fs.writeFileSync(path.join(root, name), PNG.sync.write(p)); return path.join(root, name); };
  const a = png('a.png', 10, 10, 0), same = png('b.png', 10, 10, 0), half = png('c.png', 10, 10, 50), longer = png('d.png', 10, 20, 0);
  assert.equal(pixelScore(a, same), 0);
  assert.equal(pixelScore(a, half, path.join(root, 'diff.png')), 50);
  assert.ok(fs.existsSync(path.join(root, 'diff.png')));
  assert.equal(pixelScore(a, longer), 0, 'a longer page is the app shot whole against one design frame: only the rows both have count');
  assert.equal(pixelScore(a, png('e.png', 20, 10, 0)), 100, 'other widths are not comparable');
});


test('a plan applied to the current branch makes direct tasks with no sprint; per task, own branches with no sprint', () => {
  const { root } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const old = store.addSprint('Restructure').id;
  store.updateSprint(old, { active: true });
  r.plannerOthers = []; r.plannerTargets = [];
  const p = (title: string) => ({ title, kind: 'add', apply: true, sprint: 'Restructure' });
  r.applyProposals([p('A'), p('B')], [], 'current');
  for (const t of store.data.tasks) { assert.equal(t.where, 'direct'); assert.equal(t.sprintId, undefined, 'not put in the named or active sprint'); }
  r.plannerTargets = [];
  r.applyProposals([p('C')], [], 'task');
  const c = store.data.tasks.find(t => t.title === 'C')!;
  assert.equal(c.where, 'branch'); assert.equal(c.sprintId, undefined);
  r.plannerTargets = [];
  r.applyProposals([p('D')], [], 'sprint');
  assert.equal(store.data.tasks.find(t => t.title === 'D')!.sprintId, old);
  r.dispose();
});

test('the planner reads where from the request and is told the branch; the panel starts from it', () => {
  const p = parseProposals('```tasks\n[{"title":"A","goal":"g","where":"current"},{"title":"B","goal":"g","where":"nope"}]\n```', new Set())!;
  assert.equal(p[0].where, 'current'); assert.equal(p[1].where, undefined);
  assert.match(plannerFirst([], 'fix it', [], undefined, [], undefined, 'qa/final-pass'), /The project folder is on branch qa\/final-pass/);
  const { root } = leaseRepo();
  const r = leaseRunner(new Store(root));
  r.plannerProposals = p; assert.equal(r.planWhere(), 'current');
  r.plannerProposals = [{ title: 'X', sprint: 'S1' }]; assert.equal(r.planWhere(), 'sprint', 'auto: a sprint when Claude named one');
  r.plannerProposals = [{ title: 'X' }]; assert.equal(r.planWhere(), 'current');
  r.dispose();
});

test('a merged sprint is closed; finished or hand-merged open sprints are closed by tidySprints', async () => {
  const { root, sh } = leaseRepo();
  const store = new Store(root);
  const r = leaseRunner(store);
  const merged = store.addSprint('Restructure'), branch = 'jc/sprint-restructure-1'; sh('branch', branch);
  store.updateSprint(merged.id, { branch, target: 'main' });
  const t = store.addTask({ title: 'x', mode: 'auto', sprintId: merged.id }); store.updateTask(t.id, { status: 'done' });
  await r.mergeSprint(merged.id);
  assert.equal(store.sprint(merged.id)!.closed, true);
  // Merged by hand into the branch you are on, never by JustCode.
  const hand = store.addSprint('Design fix'), hb = 'jc/sprint-design-1'; sh('branch', hb);
  store.updateSprint(hand.id, { branch: hb, target: 'elsewhere', active: true });
  const u = store.addTask({ title: 'y', mode: 'auto', sprintId: hand.id }); store.updateTask(u.id, { status: 'done' });
  // Still open work: left alone.
  const open = store.addSprint('Open'); store.addTask({ title: 'z', mode: 'auto', sprintId: open.id });
  // Finished, branch already merged and gone.
  const gone = store.addSprint('Gone'); const v = store.addTask({ title: 'w', mode: 'auto', sprintId: gone.id }); store.updateTask(v.id, { status: 'done' });
  await r.tidySprints();
  assert.equal(store.sprint(hand.id)!.closed, true); assert.equal(store.sprint(hand.id)!.branch, undefined);
  assert.equal(await g.branchExists(root, hb), false, 'merged branch deleted');
  assert.equal(store.sprint(gone.id)!.closed, true);
  assert.ok(!store.sprint(open.id)!.closed);
  assert.equal(r.sprintFor('Restructure') === merged.id, false, 'a closed sprint is never reused');
  r.dispose();
});

test('deleting a task keeps a branch with unmerged work, and lets its sprint merge', async () => {
  const { root, sh } = leaseRepo();
  const store = new Store(root), notes: string[] = [];
  const r = leaseRunner(store, notes);
  const sp = store.addSprint('S1'), sb = 'jc/sprint-s1'; sh('branch', sb);
  store.updateSprint(sp.id, { branch: sb, target: 'main' });
  const wt = path.join(root, '.wt'); sh('worktree', 'add', '-q', wt, sb);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'sprint'); sh('-C', wt, 'commit', '-qam', 's'); sh('worktree', 'remove', '--force', wt);
  const done = store.addTask({ title: 'done one', mode: 'auto', sprintId: sp.id }); store.updateTask(done.id, { status: 'done' });
  const held = store.addTask({ title: 'held for review', mode: 'auto', sprintId: sp.id });
  const tb = 'jc/held'; sh('branch', tb, sb);
  const wt2 = path.join(root, '.wt2'); sh('worktree', 'add', '-q', wt2, tb);
  fs.writeFileSync(path.join(wt2, 'b.txt'), 'work'); sh('-C', wt2, 'add', '-A'); sh('-C', wt2, 'commit', '-qm', 'w'); sh('worktree', 'remove', '--force', wt2);
  store.updateTask(held.id, { status: 'review', branch: tb, base: sb });
  await r.remove(held.id);
  assert.equal(await g.branchExists(root, tb), true, 'unmerged work kept');
  assert.ok(notes.some(n => /kept its branch jc\/held: it has 1 commit/.test(n)), notes.join('\n'));
  for (let i = 0; i < 100 && store.sprint(sp.id)!.branch; i++) await new Promise(res => setTimeout(res, 20));
  assert.equal(store.sprint(sp.id)!.closed, true, 'the sprint merged once its last open task was deleted');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'sprint');
  r.dispose();
});

test('a task may not stop containers it did not start', () => {
  const id = 'ab12cd34';
  assert.match(stopsOthersContainers('docker stop aqua-rush-final-backend-1 >/dev/null; npx playwright test', id, true) ?? '', /Do not stop/);
  assert.match(stopsOthersContainers('cd x && docker compose down', id, false) ?? '', /Compose stack/, 'in the project folder: the user\'s stack');
  assert.match(stopsOthersContainers('docker compose -p aqua-rush-final stop backend', id, true) ?? '', /Compose stack/);
  assert.equal(stopsOthersContainers('docker compose down -v', id, true), undefined, 'its own task folder stack');
  assert.equal(stopsOthersContainers(`docker compose -p jc-${id} down`, id, false), undefined);
  assert.equal(stopsOthersContainers(`docker stop jc-${id}-web`, id, false), undefined);
  assert.equal(stopsOthersContainers('docker ps; docker compose up -d --build; docker compose logs backend', id, false), undefined);
});

import { exploreCode, replayCode, stateShots, screensOf, State } from '../designcapture';
test('design states: explore and replay code is valid JS, app shots click the same label, the reference lives outside the copy', () => {
  const open = 'async (page, name) => "#root"', snap = 'async (page, sel) => "<html></html>"';
  for (const code of [exploreCode(open, snap, 'c-pay-390'), replayCode(open, snap, 'c-pay-1440', ['Pay', 'GCash'])]) {
    assert.doesNotMatch(code, /__(OPEN|SNAP|NAME|LABEL|MAX)__/);
    assert.doesNotThrow(() => new Function(`return (${code})`));
  }
  const states: State[] = [{ name: 'c-pay~gcash-390', base: 'c-pay-390', label: 'GCash', kind: 'state' }, { name: 'c-pay~more-390', base: 'c-pay-390', label: 'More', kind: 'overlay' }];
  const extra = stateShots([{ url: 'http://app/order/new', width: 390, png: '/a/c-pay-390.png', json: '/a/c-pay-390.json' }], states);
  assert.deepEqual(extra, [{ url: 'http://app/order/new', width: 390, png: '/a/c-pay~gcash-390.png', json: '/a/c-pay~gcash-390.json', actions: [{ click: 'GCash' }] },
    { url: 'http://app/order/new', width: 390, png: '/a/c-pay~more-390.png', json: '/a/c-pay~more-390.json', actions: [{ click: 'More' }] }], 'menus and sheets are shot too');
  assert.equal(screensOf('/p/.justcode/sources/abc'), '/p/.justcode/design/ref/abc');
  assert.equal(screensOf('/designs/mine'), '/designs/mine/screens');
});

import { framePage, sameText } from '../designcapture';
import { newerInstalled } from '../version';
test('design pages keep the device height; a gallery screen equal to a state is the same page; a newer install is found', () => {
  const f = framePage('<html><head></head><body style="margin:0"><div class="scr">x</div></body></html>', 390);
  assert.match(f, /<body style="margin:0"><div data-jc-frame style="width:390px;height:844px"><div class="scr">x<\/div><\/div><\/body>/);
  assert.match(f, /\[data-jc-frame\]>\*:only-child\{height:100%\}<\/style><\/head>/);
  assert.equal(framePage(f, 390), f, 'framed once');
  assert.match(framePage('<body><p>y</p></body>', 1440), /height:900px/);
  const page = (extra: string) => `<html><body><h1>How will you pay?</h1><p>Total ₱75 GCash Pay the driver Place order Confirm order Your name</p>${extra}</body></html>`;
  assert.ok(sameText(page(''), page('<button>Confirm</button>')));
  assert.ok(!sameText(page(''), '<body><h1>Home</h1><p>Welcome back Order water Copy number More</p></body>'));
  const dir = tmp();
  for (const d of ['justine.just-code-2.20.4', 'justine.just-code-2.21.1', 'justine.just-code-2.21.0', 'other.ext-9.0.0']) fs.mkdirSync(path.join(dir, d));
  assert.equal(newerInstalled(path.join(dir, 'justine.just-code-2.21.0'), '2.21.0'), '2.21.1');
  assert.equal(newerInstalled(path.join(dir, 'justine.just-code-2.21.1'), '2.21.1'), undefined);
});

test('a state several clicks deep is shot in the app with every step, typing the design values first', () => {
  const st: State = { name: 'c-pay~place-order~confirm-390', base: 'c-pay-390', label: 'Confirm', kind: 'state',
    steps: [{ click: 'Place order' }, { click: 'Confirm', fill: [{ label: 'Your name', value: 'Maria Santos' }] }] };
  const [sh] = stateShots([{ url: 'http://app/order', width: 390, png: '/a/c-pay-390.png', json: '/a/c-pay-390.json' }], [st, { name: 'c-pay~copy-390', base: 'c-pay-390', label: 'Copy', kind: 'toast' }]);
  assert.deepEqual(sh.actions, st.steps);
  assert.match(shotCode(sh), /"fill":\[\{"label":"Your name","value":"Maria Santos"\}\]/);
  assert.doesNotThrow(() => new Function(`return (${shotCode(sh)})`));
});

import { blankPng } from '../designcapture';
test('a blank screenshot (the app had not drawn) is told apart from a real one', () => {
  const dir = tmp(), { PNG } = require('pngjs');
  const png = (fill: (x: number, y: number) => number[]) => { const p = new PNG({ width: 40, height: 40 }); for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) { const [r, g, b] = fill(x, y), i = (y * 40 + x) * 4; p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255; } return PNG.sync.write(p); };
  fs.writeFileSync(path.join(dir, 'blank.png'), png(() => [233, 241, 243]));
  fs.writeFileSync(path.join(dir, 'page.png'), png((x, y) => y < 10 ? [255, 255, 255] : x % 7 < 2 ? [20, 20, 20] : y % 5 ? [233, 241, 243] : [200, 30, 30]));
  assert.equal(blankPng(path.join(dir, 'blank.png')), true);
  assert.equal(blankPng(path.join(dir, 'page.png')), false);
  assert.equal(blankPng(path.join(dir, 'missing.png')), false);
});

import { shotIsCurrent } from '../designcapture';
import { backgroundDesignRun } from '../policy';
test('a long design capture resumes: current design shots are kept, app shots are always new; it never runs in the background', () => {
  const dir = tmp(), { PNG } = require('pngjs');
  const page = path.join(dir, 'c-login-390.html'), png = path.join(dir, 'c-login-390.png'), json = path.join(dir, 'c-login-390.json');
  const img = new PNG({ width: 40, height: 40 }); for (let i = 0; i < img.data.length; i += 4) { img.data[i] = (i * 7) % 256; img.data[i + 1] = (i * 3) % 256; img.data[i + 2] = (i * 11) % 256; img.data[i + 3] = 255; }
  fs.writeFileSync(page, '<html></html>');
  const old = new Date(Date.now() - 60_000); fs.utimesSync(page, old, old);
  fs.writeFileSync(png, PNG.sync.write(img)); fs.writeFileSync(json, '{"items":[]}');
  const sh = { url: `file://${page}`, width: 390, png, json };
  assert.equal(shotIsCurrent(sh), true);
  assert.equal(shotIsCurrent({ ...sh, url: 'http://localhost:4200/login' }), false, 'app shots are always new');
  assert.equal(shotIsCurrent({ ...sh, actions: [{ click: 'Pay' }] }), false);
  fs.utimesSync(page, new Date(), new Date(Date.now() + 5000));
  assert.equal(shotIsCurrent(sh), false, 'the page changed since');
  assert.match(backgroundDesignRun({ command: 'node cli.js design-capture jobs.json', run_in_background: true }) ?? '', /foreground/);
  assert.equal(backgroundDesignRun({ command: 'node cli.js design-capture jobs.json' }), undefined);
  assert.equal(backgroundDesignRun({ command: 'docker compose up -d', run_in_background: true }), undefined);
});

import { mergeTwins } from '../designcapture';
test('gallery screens merge into a state only when they are that state: no menus, no back steps, no cycles', () => {
  const words = 'Bukal Water Station At risk of leaving 1 branch 3 users joined Mar 2026 Orders Logins Unsettled problems Health score';
  const pages: Record<string, string> = {
    'a-detail-view-390': `<body><h1>Business detail</h1><p>${words}</p><button>Pause business</button><button>Close business</button></body>`,
    'a-detail-pause-390': `<body><h1>Business detail</h1><p>${words}</p><h2>Pause Bukal Water Station?</h2><button>Cancel</button></body>`,
    'a-detail-view~pause-business-390': `<body><h1>Business detail</h1><p>${words}</p><h2>Pause Bukal Water Station?</h2><button>Cancel</button></body>`,
    'a-detail-pause~cancel-390': `<body><h1>Business detail</h1><p>${words}</p><button>Pause business</button><button>Close business</button></body>`,
    'c-root-guest-390': `<body><h1>Fresh water, delivered</h1><p>${words}</p><button>Log in</button></body>`,
    'c-root-signed~account-menu-390': `<body><h1>Fresh water, delivered</h1><p>${words}</p><button>Log out</button></body>`,
  };
  const states: State[] = [
    { name: 'a-detail-view~pause-business-390', base: 'a-detail-view-390', label: 'Pause business', kind: 'state', added: ['Pause Bukal Water Station?'], steps: [{ click: 'Pause business' }] },
    { name: 'a-detail-pause~cancel-390', base: 'a-detail-pause-390', label: 'Cancel', kind: 'state', added: ['Pause business'], steps: [{ click: 'Cancel' }] },
    { name: 'c-root-signed~account-menu-390', base: 'c-root-signed-390', label: 'Account menu', kind: 'overlay', added: ['Log out'] },
  ];
  const m = mergeTwins(['a-detail-view-390', 'a-detail-pause-390', 'c-root-guest-390'], states, n => pages[n] ?? '');
  assert.deepEqual(m.map(x => [x.name, x.to]), [['a-detail-pause-390', 'a-detail-view~pause-business-390']]);
});

import { diffItems, looksData } from '../designdiff';
test('design diff: the app\'s own records (numbers, repeated rows) are data, listed apart and not counted', () => {
  const it = (text: string) => ({ text, cls: 'muted', x: 0, w: 10, h: 10, font: 'F', size: 14, weight: '400', color: 'c', align: 'start', bg: 'b', radius: '0px', box: null });
  const d = diffItems({ items: [it('Title'), it('Export')] }, { items: [it('Title'), it('System · 19 Nov, 7:16 PM'), it('role: staff'), it('role: staff'), it('Search activity')] });
  assert.deepEqual(d.filter(x => !x.data).map(x => x.line), ['missing in app: "Export"', 'extra in app: "Search activity"']);
  assert.equal(d.filter(x => x.data).length, 3);
  assert.ok(looksData('D-6 · 26 Nov') && !looksData('Log out'));
});

import { styleCheck, driftLine, fixTaskText, designStylesheets } from '../stylecheck';
test('style check: classes and tokens compared by style, not position or data; a page overriding a class is named', () => {
  const root = tmp(), ref = path.join(root, 'ref'), app = path.join(root, 'audit');
  fs.mkdirSync(ref); fs.mkdirSync(app);
  const it = (text: string, cls: string, o: Record<string, unknown> = {}) => ({ text, cls, x: 0, w: 10, h: 10, font: '"Fira Sans", sans-serif', size: 14, weight: '400', color: 'c', align: 'start', bg: 'b', radius: '0px', box: null, ...o });
  const put = (dir: string, name: string, items: unknown[]) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ items }));
  for (const id of ['c-a', 'c-b', 'c-c']) put(ref, `${id}-390`, [it('Save', 'btn p', { bg: 'teal' }), it('Hi', 'muted')]);
  put(app, 'c-a-390', [it('Save', 'btn p', { bg: 'white', x: 99 }), it('Juan Cruz', 'muted'), it('Juan Cruz', 'muted')]);
  put(app, 'c-b-390', [it('Save', 'btn p', { bg: 'white' }), it('Hi', 'muted')]);
  put(app, 'c-c-390', [it('Save', 'btn p', { bg: 'white' }), it('Hi', 'muted', { size: 12 })]);
  fs.writeFileSync(path.join(ref, 'screens.json'), JSON.stringify({ tokens: { '--primary': '#0A5C68', '--bad': '#B42318' } }));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'styles.css'), ':root{--primary: #0a5c68; --bad: red}');
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'x.css'), ':root{--bad:#B42318}');
  const r = styleCheck(root, ref, app);
  assert.equal(r.screens, 3);
  assert.deepEqual(r.tokens, [{ name: '--bad', design: '#B42318', app: 'red' }], 'case is not a difference; dependencies are not the app');
  assert.deepEqual(r.drifts.map(driftLine), [
    '.btn.p at 390: bg is white, the design has teal (3 places, e.g. c-a, c-b, c-c)',
    '.muted at 390: size is 12 on c-c, the design has 14 (right elsewhere: a page rule overrides it)',
  ], 'position and text (x, other records) are not compared');
  fs.writeFileSync(path.join(ref, 'c-a-390.css'), '.btn.p{background:teal}\n.muted{font-size:14px}');
  fs.writeFileSync(path.join(ref, 'c-b-390.css'), '.btn.p{background:teal}');
  const css = designStylesheets(ref, root);
  assert.equal(fs.readFileSync(css[0], 'utf8'), '.btn.p{background:teal}\n.muted{font-size:14px}\n', 'one stylesheet per width, rules once');
  const text = fixTaskText(r, { report: 'style-check.md', css }, 'cli.js', root);
  assert.match(text, /style-check .* ONCE/); assert.match(text, /Do not take screenshots/); assert.match(text, /--bad: the app has red, the design has #B42318: fixed/);
});

import { declaredProps } from '../stylecheck';
test('style check: only what the design\'s rule for a class sets is that class\'s look', () => {
  const d = declaredProps('.muted { color: var(--ink2); }\n.m .who { font-size: 13.5px; }\n.btn:hover { color: red }\n.num, .tnum { font-variant-numeric: tabular-nums; }\n.inp.ph { color: grey }');
  assert.deepEqual(d.map(x => [x.classes.join('.'), [...x.props].join(',')]), [['muted', 'color'], ['who', 'size'], ['inp.ph', 'color']], 'hover and a numeric font setting are not looks of the class');
});
