import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Store } from '../store';
import { Runner } from '../runner';
import { Limits } from '../limits';
import { parseProposals } from '../claude';
const status = require(path.join(__dirname, '..', '..', 'media', 'status.js'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-deps-'));

test('Run all never starts a task before its dependencies are done', () => {
  const root = tmp();
  const store = new Store(root);
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => ({ maxParallel: 2, review: {} } as any), limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  r.holdsLease = () => true;
  const started: string[] = [];
  r.run = async (id: string) => { started.push(id); };
  const a = store.addTask({ title: 'A', mode: 'auto' }), b = store.addTask({ title: 'B', mode: 'auto' });
  store.updateTask(b.id, { dependsOn: [a.id] });
  store.setQueue([b.id, a.id]);
  r.pump();
  assert.deepEqual(started, [a.id], 'B waits for A even though it is first in the queue');
  assert.deepEqual(store.queue, [b.id]);
  store.updateTask(a.id, { status: 'done' });
  r.pump();
  assert.deepEqual(started, [a.id, b.id]);
  r.dispose();
});

test('planner "after" becomes dependsOn; the card says what it waits for', () => {
  const p = parseProposals('```tasks\n[{"title":"Schema","goal":"g"},{"title":"API","goal":"g","after":["Schema"]}]\n```', new Set());
  assert.deepEqual(p![1].after, ['Schema']);
  const root = tmp();
  const store = new Store(root);
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => ({ review: {} } as any), limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  r.applyProposals(p!.map(x => ({ ...x, kind: 'new', apply: true })), []);
  const schema = store.data.tasks.find(t => t.title === 'Schema')!, api = store.data.tasks.find(t => t.title === 'API')!;
  assert.deepEqual(api.dependsOn, [schema.id]);
  const n = status.nextStep(api, { settings: { review: { maxAttempts: 3, auto: true } }, queue: { queued: [] }, tasks: store.data.tasks, post: () => {}, open: () => {}, dur: () => '', lastTool: () => '' });
  assert.match(n.text, /⟂ waits for “Schema”/);
  r.dispose();
});
