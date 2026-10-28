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
  assert.deepEqual(turns, [{ ok: true, error: undefined, text: 'Done', limit: false, costUsd: 0.01 }]);
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
  s.kill();
});
