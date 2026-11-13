import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { writeSprintReport, sprintReport, reportFile } from '../report';
import * as Audit from '../audit';
import * as R from '../registry';

test('sprint report: goal, tasks with merge commits and files, cost, audit highlights, artifacts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-rep-'));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a'); sh('add', '-A'); sh('commit', '-qm', 'init');
  sh('checkout', '-qb', 'jc/login-1'); fs.writeFileSync(path.join(root, 'b.txt'), 'b'); fs.writeFileSync(path.join(root, 'c.txt'), 'c'); sh('add', '-A'); sh('commit', '-qm', 'work');
  sh('checkout', '-q', 'main'); sh('merge', '--no-ff', '-q', '-m', 'Merge jc/login-1: Login page', 'jc/login-1');
  const sprint = { id: 's1', name: 'Sprint 1', goal: 'Users can sign in' };
  const tasks: any[] = [
    { id: 't1', title: 'Login page', status: 'done', sprintId: 's1', branch: 'jc/login-1', costUsd: 1.25, review: { state: 'pass', attempts: 1, issues: [{ text: 'x', key: 'k', rounds: 1, accepted: true }] } },
    { id: 't2', title: 'Logout | menu', status: 'todo', sprintId: 's1', costUsd: 0 },
    { id: 't3', title: 'Other sprint', status: 'done', sprintId: 's2', costUsd: 9 },
  ];
  Audit.log(root, { actor: 'policy', event: 'policy.deny', taskId: 't1', sprintId: 's1', detail: 'Edit .github/workflows/x.yml' });
  Audit.log(root, { actor: 'user', event: 'task.run', taskId: 't1' });
  R.link(root, 'https://claude.ai/artifact/abc', 't1', 's1', 'output'); R.upsert(root, 'https://claude.ai/artifact/abc', { title: 'Login mock' });
  const file = await writeSprintReport(root, sprint, tasks);
  assert.equal(file, reportFile(root, sprint));
  assert.ok(file.startsWith(path.join(root, '.justcode', 'reports', 'sprint-sprint-1-')));
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /## Goal\nUsers can sign in/);
  assert.match(md, /Tasks: 2 \(1 done, 1 open\)/);
  assert.match(md, /\| Login page \| done \(1 accepted issue\) \| branch \| `[0-9a-f]{8}` \| 2 \| 2 \| \$1\.25 \|/);
  assert.match(md, /\| Logout \/ menu \| todo/);
  assert.doesNotMatch(md, /Other sprint/);
  assert.match(md, /\*\*\$1\.25\*\*/);
  assert.match(md, /policy\.deny · policy · Login page: Edit \.github\/workflows\/x\.yml/);
  assert.doesNotMatch(md, /task\.run/);
  assert.match(md, /\[Login mock\]\(https:\/\/claude\.ai\/artifact\/abc\) · Login page/);
  assert.match(sprintReport(root, { id: 'e', name: 'Empty' }, [], new Map()), /_No goal set\._[\s\S]*_None\._/);
});
