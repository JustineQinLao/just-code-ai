import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { startPhoneServer } from '../phone';

test('phone server: token required, only whitelisted actions', async () => {
  const acts: any[] = [];
  const srv = await startPhoneServer(0, { token: 'secret', state: () => ({ tasks: [] }), act: async m => { acts.push(m); } });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { 'x-token': 'secret' } })).status, 200);
    const post = (b: object, tok = 'secret') => fetch(base + '/api/act', { method: 'POST', headers: { 'x-token': tok }, body: JSON.stringify(b) });
    assert.equal((await post({ type: 'run', id: 'a' })).status, 200);
    assert.equal((await post({ type: 'openFile' })).status, 400);
    assert.equal((await post({ type: 'run' }, 'nope')).status, 401);
    assert.deepEqual(acts.map(a => a.type), ['run']);
  } finally { srv.close(); }
});
