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
  assert.equal(a.files, 1); assert.equal(a.savedAt, 5); assert.equal(a.changedAt, undefined);
  R.recordSaved(root, U1, 'src1');
  assert.equal(R.find(root, U1)!.changedAt, undefined, 'same content is not a change');
  fs.writeFileSync(path.join(dir, 'index.html'), 'v2');
  assert.equal(R.recordSaved(root, U1, 'src1', 9).changedAt, 9);
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

import { Store } from '../store';
import { Runner } from '../runner';
import { Limits } from '../limits';
import { artifactBrief } from '../claude';

test('brief: project artifacts are listed once, not repeating sources; artifact brief names the page to update', () => {
  const root = tmp();
  R.link(root, U1, 't0', undefined, 'output'); R.upsert(root, U1, { title: 'Sales dashboard' });
  R.upsert(root, U2, { kind: 'input' });
  const t = { id: 'x', title: 'Restyle', mode: 'auto', status: 'todo', created: 0 } as any;
  const brief = A.writeBrief(root, t, [{ id: 's', kind: 'url', ref: U2 }], id => id === 't0' ? 'First dashboard' : undefined);
  assert.match(brief, /## Project artifacts[\s\S]*Sales dashboard: https:\/\/claude\.ai\/artifact\/aaa111 \(output, produced by task "First dashboard"\)/);
  assert.doesNotMatch(brief.split('## Project artifacts')[1], /bbb222/);
  assert.doesNotMatch(A.writeBrief(tmp(), t, []), /## Project artifacts/);
  assert.match(artifactBrief('/f.html', false, { url: U1, title: 'Sales dashboard', file: '/old.html' }), /updates the existing artifact "Sales dashboard" \(https:\/\/claude\.ai\/artifact\/aaa111\)[\s\S]*Start from its current page, \/old\.html/);
  assert.doesNotMatch(artifactBrief('/f.html', false), /updates the existing/);
});

test('runner: an artifact task naming a published page updates that page (same link)', () => {
  const root = tmp();
  const store = new Store(root);
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => ({ review: {} } as any), limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  R.link(root, U1, 't0', undefined, 'output'); R.upsert(root, U1, { title: 'Sales dashboard' });
  R.link(root, U2, 't1', undefined, 'output'); R.upsert(root, U2, { title: 'Sales' });
  assert.equal(r.publishedNamedIn({ title: 'Add a region filter to the sales dashboard', output: 'artifact' }).url, U1, 'longest matching title wins');
  assert.equal(r.publishedNamedIn({ title: 'Build a new pricing page', output: 'artifact' }), undefined);
  r.dispose();
});

test('transcript archive: appends only new lines, across sessions', () => {
  const root = tmp(), src = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(src, '{"a":1}\n{"a":2}\n');
  assert.equal(A.archiveTranscript(root, 't', src, 's1'), 2);
  assert.equal(A.archiveTranscript(root, 't', src, 's1'), 0);
  fs.appendFileSync(src, '{"a":3}\n');
  assert.equal(A.archiveTranscript(root, 't', src, 's1'), 1);
  const src2 = path.join(tmp(), 's2.jsonl'); fs.writeFileSync(src2, '{"b":1}\n');
  assert.equal(A.archiveTranscript(root, 't', src2, 's2'), 1);
  assert.deepEqual(fs.readFileSync(A.transcriptFile(root, 't'), 'utf8').trim().split('\n'), ['{"a":1}', '{"a":2}', '{"a":3}', '{"b":1}']);
  assert.equal(A.archiveTranscript(root, 't', '/nope', 's3'), 0);
});
