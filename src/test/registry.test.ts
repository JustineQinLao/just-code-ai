import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as R from '../registry';
import * as A from '../artifacts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-reg-'));
const U1 = 'https://claude.ai/artifact/aaa111', U2 = 'https://claude.ai/code/artifact/bbb222';

test('registry: upsert, link, byTask, unlink; an output stays an output', () => {
  const root = tmp();
  R.upsert(root, U1 + '?x=1', { kind: 'input' }, 1);
  R.link(root, U1, 't1', 's1');
  R.link(root, U1, 't1');
  R.link(root, U2, 't2', undefined, 'output');
  R.upsert(root, U2, { kind: 'input' }); // typed later in a prompt
  const all = R.load(root);
  assert.equal(all.length, 2);
  assert.deepEqual(R.byTask(root, 't1').map(e => [e.url, e.kind, e.taskIds, e.sprintIds]), [[U1, 'input', ['t1'], ['s1']]]);
  assert.equal(R.find(root, U2)!.kind, 'output');
  assert.equal(R.find(root, U1)!.id.length, 8);
  R.unlinkTask(root, 't1');
  assert.deepEqual(R.find(root, U1)!.taskIds, []);
  assert.ok(R.registryFile(root).startsWith(path.join(root, '.justcode')));
});

test('registry: typed links are inputs; saved copies are hashed and a changed copy is flagged', () => {
  const root = tmp();
  A.addLinkSources(root, `build from ${U1}`);
  assert.equal(R.find(root, U1)!.kind, 'input');
  const dir = A.sourceCopy(root, 'src1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'v1');
  const a = R.recordSaved(root, U1, 'src1', 5);
  assert.equal(a.files, 1); assert.equal(a.savedAt, 5); assert.equal(a.changed, undefined);
  R.recordSaved(root, U1, 'src1');
  assert.equal(R.find(root, U1)!.changed, undefined, 'same content is not a change');
  fs.writeFileSync(path.join(dir, 'index.html'), 'v2');
  assert.equal(R.recordSaved(root, U1, 'src1').changed, true);
});

test('registry: brief lines name titles, kinds and tasks, newest first, skipping listed sources', () => {
  const root = tmp();
  R.link(root, U1, 't1', undefined, 'output'); R.upsert(root, U1, { title: 'Sales dashboard' }, 10);
  R.link(root, U2, 't2'); R.upsert(root, U2, {}, 20);
  const lines = R.forBrief(root, id => ({ t1: 'Build dashboard', t2: 'Restyle' } as any)[id]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /bbb222 \(input, used by "Restyle"\)/);
  assert.match(lines[1], /Sales dashboard: https:\/\/claude\.ai\/artifact\/aaa111 \(output, produced by task "Build dashboard"\)/);
  assert.equal(R.forBrief(root, () => undefined, [U2]).length, 1);
  assert.equal(R.titleOf('<html><head><title> Q3 Sales </title>'), 'Q3 Sales');
});
