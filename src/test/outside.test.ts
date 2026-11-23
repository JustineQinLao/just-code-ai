import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { outsideEdits, outsideChanges, findOutside, commitOutside, isInside } from '../outside';
import { doneEnough } from '../queue';

// media/status.js is plain JS shared with the webview; out-test/test → ../../media.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const status = require(path.join(__dirname, '..', '..', 'media', 'status.js'));

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
function repo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), 'one\n');
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}

test('outside edits: files in a sibling repo are tracked; project and task folder files are not', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-out-'));
  const project = repo(path.join(base, 'app')), sibling = repo(path.join(base, 'deploy'));
  const wt = path.join(project, '.justcode', 'worktrees', 'x');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'README.md'), 'two\n');
  fs.writeFileSync(path.join(sibling, 'new.md'), 'new\n');
  const edited = [path.join(sibling, 'README.md'), path.join(sibling, 'new.md'), path.join(project, 'src.ts'), path.join(wt, 'a.ts')];
  const out = await outsideEdits(edited, [project, wt]);
  assert.deepEqual(out.map(o => path.basename(o.file)).sort(), ['README.md', 'new.md']);
  assert.ok(out.every(o => o.repo === sibling));
  const ch = await outsideChanges(project, out);
  assert.deepEqual(ch.map(c => [c.file, c.status, c.outside]).sort(), [['../deploy/README.md', 'M', true], ['../deploy/new.md', 'A', true]]);
  assert.equal(findOutside(project, out, '../deploy/new.md')?.file, path.join(sibling, 'new.md'));
  assert.ok(isInside(path.join(wt, 'a.ts'), project));
});

test('outside edits: an undone edit drops off; Finish commits the rest in their own repo', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-out-'));
  const project = repo(path.join(base, 'app')), sibling = repo(path.join(base, 'deploy'));
  fs.writeFileSync(path.join(sibling, 'README.md'), 'two\n');
  const first = await outsideEdits([path.join(sibling, 'README.md')], [project]);
  assert.equal(first.length, 1);
  fs.writeFileSync(path.join(sibling, 'README.md'), 'one\n');   // put back as it was
  assert.equal((await outsideEdits([], [project], first)).length, 0);
  fs.writeFileSync(path.join(sibling, 'README.md'), 'three\n');
  fs.writeFileSync(path.join(sibling, 'mine.md'), 'yours, not the task\'s\n');
  const files = await outsideEdits([path.join(sibling, 'README.md')], [project]);
  const r = await commitOutside(files, 'docs: task message', false);
  assert.deepEqual(r.committed, [sibling]);
  assert.equal(sh(sibling, 'log', '-1', '--format=%s').trim(), 'docs: task message');
  assert.equal(sh(sibling, 'status', '--porcelain').trim(), '?? mine.md');   // only the task's file went in
});

test('queue: a task with no project changes that waits for a reply does not hold back the tasks after it', () => {
  const d = { id: 'p', title: 'Docs', status: 'review', noProjectChanges: true } as any;
  assert.equal(doneEnough(d, false), true);
  assert.equal(doneEnough(d, true), false);                                   // Claude is still working on it
  assert.equal(doneEnough({ ...d, noProjectChanges: undefined }, false), false);
  const c = { settings: { review: { maxAttempts: 3, auto: true } }, queue: { queued: [] }, tasks: [d], post: () => {}, open: () => {}, lastTool: () => '' };
  const next = status.nextStep({ id: 'n', title: 'Next', status: 'todo', dependsOn: ['p'] }, c);
  assert.ok(!/waits for/.test(next.text));
});

test('card: files changed only outside the project offer Finish, not "no changes"', () => {
  const c = { settings: { review: { maxAttempts: 3, auto: true } }, queue: { queued: [] }, tasks: [], post: () => {}, open: () => {}, lastTool: () => '' };
  const t = { id: 'a', title: 'Docs', status: 'review', worktree: '/w', reply: 'Done', noProjectChanges: true, outside: [{ file: '/x/deploy/README.md', repo: '/x/deploy' }] };
  const n = status.nextStep(t, c);
  assert.match(n.text, /outside this project: deploy\/README\.md/);
  assert.ok(n.actions.some((a: any) => a[0] === '✓ Finish'));
});
