import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { matches, alwaysChoice, parseRule } from '../policy';
import { parseVerdict, carryOver, claudeEnv } from '../claude';
import { Limits, isLimitError } from '../limits';
import { Store } from '../store';
import { parseTasks } from '../tasksmd';
import { Session } from '../session';
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

test('TASKS.md parsing', () => {
  const t = parseTasks('## Sprint 1\n- [ ] Login\n  with email\n- [x] Setup\n## Backlog\n- [~] Search');
  assert.deepEqual(t.map(x => [x.title, x.status, x.sprint]), [['Login', 'todo', 'Sprint 1'], ['Setup', 'done', 'Sprint 1'], ['Search', 'doing', undefined]]);
  assert.equal(t[0].description, 'with email');
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

import { Runner } from '../runner';

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
