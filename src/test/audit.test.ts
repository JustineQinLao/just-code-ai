import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as Audit from '../audit';
import { Session } from '../session';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-audit-'));

test('audit: log appends, read filters by task, event and time, csv escapes', () => {
  const root = tmp();
  Audit.log(root, { actor: 'user', event: 'task.run', taskId: 'a', time: '2026-11-01T00:00:00.000Z' });
  Audit.log(root, { actor: 'phone', event: 'permission.allow', taskId: 'b', detail: 'Bash npm test, "quoted"' });
  fs.appendFileSync(Audit.auditFile(root), 'not json\n');
  Audit.log(root, { actor: 'policy', event: 'policy.deny', taskId: 'a' });
  assert.equal(Audit.read(root).length, 3);
  assert.deepEqual(Audit.read(root, { taskId: 'a' }).map(e => e.event), ['task.run', 'policy.deny']);
  assert.equal(Audit.read(root, { since: Date.parse('2026-11-02') }).length, 2);
  assert.equal(Audit.read(root, { event: 'permission.allow' })[0].actor, 'phone');
  const csv = Audit.toCsv(Audit.read(root), id => id === 'b' ? 'Task B' : undefined);
  assert.match(csv, /phone,permission\.allow,Task B,b,,"Bash npm test, ""quoted"""/);
  Audit.log('/dev/null/nope', { actor: 'user', event: 'task.run' }); // never throws
});

test('audit: a permission answered on the phone is logged with actor phone', async () => {
  const events: any[] = [];
  const s: any = new Session({ bin: 'x', cwd: '/', sessionId: 's', resume: false, mode: 'default', allowed: [], rules: () => [], env: {}, idleMs: 1000, label: 't',
    audit: (event, detail, actor) => events.push({ event, detail, actor }) });
  const ac = new AbortController();
  const p = s.permission('Bash', { command: 'rm -rf build' }, { signal: ac.signal, toolUseID: 'u1' });
  s.answer({ id: 'u1', choice: 'allow', by: 'phone' });
  assert.equal((await p).behavior, 'allow');
  const q = s.permission('Bash', { command: 'curl x' }, { signal: ac.signal, toolUseID: 'u2' });
  s.answer({ id: 'u2', choice: 'deny', message: 'no network' });
  assert.equal((await q).behavior, 'deny');
  assert.deepEqual(events, [
    { event: 'permission.allow', detail: 'Bash rm -rf build', actor: 'phone' },
    { event: 'permission.deny', detail: 'Bash curl x: no network', actor: 'user' },
  ]);
});
