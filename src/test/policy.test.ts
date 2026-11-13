import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPolicy, violations, DEFAULT_POLICY, policyFile, pathMatches } from '../policy';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-pol-'));

test('policy: created with defaults on first read; bad fields fall back and are named', () => {
  const root = tmp();
  assert.deepEqual(loadPolicy(root), { policy: DEFAULT_POLICY, errors: [] });
  assert.ok(fs.existsSync(policyFile(root)));
  fs.writeFileSync(policyFile(root), JSON.stringify({ denyTools: 'WebFetch', maxCostUsd: { task: 0.01, sprint: -1 }, secretScan: false }));
  const { policy, errors } = loadPolicy(root);
  assert.deepEqual(policy.denyTools, DEFAULT_POLICY.denyTools);
  assert.equal(policy.maxCostUsd.task, 0.01); assert.equal(policy.maxCostUsd.sprint, 50);
  assert.equal(policy.secretScan, false);
  assert.deepEqual(errors.sort(), ['denyTools must be a list of strings', 'maxCostUsd.sprint must be a number ≥ 0']);
  fs.writeFileSync(policyFile(root), '{nope');
  assert.match(loadPolicy(root).errors[0], /not valid JSON/);
});

test('policy: protected paths, denied tools (also inside compound commands), allowed calls', () => {
  const p = DEFAULT_POLICY, cwd = '/repo';
  assert.match(violations(p, 'Edit', { file_path: '/repo/.github/workflows/x.yml' }, cwd)!, /protects \.github\/workflows\/\*\*: \.github\/workflows\/x\.yml/);
  assert.ok(violations(p, 'Write', { file_path: 'config/.env.local' }, cwd));
  assert.ok(violations(p, 'Write', { file_path: '/repo/certs/key.pem' }, cwd));
  assert.equal(violations(p, 'Edit', { file_path: '/repo/src/app.ts' }, cwd), undefined);
  assert.equal(violations(p, 'Read', { file_path: '/repo/.env' }, cwd), undefined, 'reading is fine');
  assert.equal(violations(p, 'Edit', { file_path: '/elsewhere/infra/x' }, cwd), undefined, 'outside the project');
  assert.match(violations(p, 'Bash', { command: 'curl https://x' }, cwd)!, /denies Bash\(curl \*\)/);
  assert.ok(violations(p, 'Bash', { command: 'npm test && curl https://x' }, cwd));
  assert.ok(violations(p, 'Bash', { command: 'echo $(wget -qO- x)' }, cwd));
  assert.equal(violations(p, 'Bash', { command: 'npm test' }, cwd), undefined);
  assert.ok(violations(p, 'WebFetch', { url: 'https://x' }, cwd));
  assert.ok(pathMatches('infra/**', 'infra/a/b.tf')); assert.ok(!pathMatches('infra/**', 'src/infra.ts'));
});

import { Store } from '../store';
import { Runner } from '../runner';
import { Limits } from '../limits';
import * as Audit from '../audit';
const status = require(path.join(__dirname, '..', '..', 'media', 'status.js'));

test('policy on runs and merges: forbidden mode and model refused, bypass-all neutralized, failing checks block merge', async () => {
  const root = tmp();
  const store = new Store(root);
  const set: any = { maxParallel: 1, taskModel: 'sonnet', bypassAll: true, maxCheckRounds: 2, review: { maxAttempts: 3 } };
  const notes: string[] = [];
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => set, limits: new Limits(), notify: (_l: string, m: string) => notes.push(m), choose: async () => 'x', cli: '' });
  r.holdsLease = () => true; r.requireLease = () => {};
  const t = store.addTask({ title: 'A', mode: 'bypassPermissions' });
  await assert.rejects(r.run(t.id), /forbids the "bypassPermissions" permission mode/);
  assert.match(store.task(t.id)!.error!, /forbidModes/);
  assert.equal(Audit.read(root, { event: 'policy.deny' }).length, 1);
  await assert.rejects(r.setMode(t.id, 'bypassPermissions'), /forbids/);
  const u = store.addTask({ title: 'B', mode: 'auto' });
  assert.equal(r.modeFor(store.task(u.id)), 'auto', 'Bypass all does not apply when the policy forbids it');
  fs.writeFileSync(path.join(root, '.justcode', 'policy.json'), JSON.stringify({ allowedModels: ['opus'] }));
  assert.match(r.policyBlock(store.task(u.id)), /allows only these models: opus/);
  fs.writeFileSync(path.join(root, '.justcode', 'policy.json'), JSON.stringify({}));
  store.updateTask(u.id, { status: 'review', worktree: root, branch: 'b', base: 'main', checks: { state: 'fail', rounds: 3 } });
  await r.merge(u.id);
  assert.match(notes.pop()!, /requires passing checks/);
  assert.notEqual(store.task(u.id)!.status, 'done');
  r.dispose();
});

test('status: a policy hold asks for your approval and checks-fail hides "anyway" when the policy requires checks', () => {
  const settings = { review: { maxAttempts: 3, auto: true }, maxCheckRounds: 2 };
  const c = (policy?: any) => ({ settings, queue: { queued: [] }, policy, post: () => {}, open: () => {}, dur: () => '', lastTool: () => '' });
  const held = { id: 'a', title: 'A', status: 'review', worktree: '/w', review: { state: 'pass', attempts: 1, hold: 'touches src/auth.ts' } };
  const n = status.nextStep(held, c());
  assert.match(n.text, /Needs your approval \(policy\): touches src\/auth\.ts/);
  assert.equal(status.lane(held, settings), 'needs');
  const failing = { id: 'b', title: 'B', status: 'review', worktree: '/w', checks: { state: 'fail', rounds: 3, results: [{ name: 't', cmd: 'npm test', ok: false }] } };
  assert.ok(status.nextStep(failing, c()).actions.some((a: any) => /anyway/.test(a[0])));
  assert.ok(!status.nextStep(failing, c({ requireChecksPass: true })).actions.some((a: any) => /anyway/.test(a[0])));
});
