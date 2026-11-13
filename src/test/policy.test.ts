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
