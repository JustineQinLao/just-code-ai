import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'vm';
import { AddressInfo } from 'net';
import { startPhoneServer, canPhoneMerge } from '../phone';

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

test('phone merge is never looser than bulk merge', () => {
  const ok = { worktree: '/w', status: 'review', review: { state: 'pass', risk: 'low' } };
  assert.equal(canPhoneMerge(ok), true);
  assert.equal(canPhoneMerge({ ...ok, review: { state: 'pass', risk: 'critical' } }), false);
  assert.equal(canPhoneMerge({ ...ok, status: 'doing' }), false);
  assert.equal(canPhoneMerge({ ...ok, where: 'root' }), false);
  assert.equal(canPhoneMerge({ ...ok, worktree: undefined }), false);
  assert.equal(canPhoneMerge({ ...ok, review: { state: 'fail' } }), false);
});

async function boot() {
  const srv = await startPhoneServer(0, { token: 'tok', state: () => ({ tasks: [] }), act: async () => {} });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { srv, base };
}

test('phone: /sw.js is served without a token, state still needs one', async () => {
  const { srv, base } = await boot();
  try {
    const sw = await fetch(base + '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type')!, /javascript/);
    assert.match(await sw.text(), /notificationclick/);
    assert.equal((await fetch(base + '/api/state')).status, 401);
  } finally { srv.close(); }
});

// Runs the page script against a stub DOM and fake fetch/timers. Timers are captured, not run: call `fire()` to run the pending poll.
async function runPage(responses: Array<() => any>) {
  const { srv, base } = await boot();
  const html = await (await fetch(base + '/')).text();
  srv.close();
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const els: Record<string, any> = {};
  const mk = () => ({ value: '', textContent: '', style: {}, append() {}, addEventListener() {}, scrollIntoView() {} });
  const delays: number[] = []; const listeners: Record<string, () => void> = {}; let call = 0; let pending: (() => any) | undefined;
  const ctx: any = {
    document: { getElementById: (i: string) => els[i] ??= mk(), createElement: () => mk(), addEventListener: (n: string, f: () => void) => { listeners['doc:' + n] = f; }, hidden: false },
    localStorage: {}, location: { search: '', href: 'http://x/' }, navigator: {}, URLSearchParams, URL,
    addEventListener: (n: string, f: () => void) => { listeners[n] = f; }, alert() {}, confirm() { return true; }, Object, Math, console,
    setTimeout: (f: () => any, ms: number) => { delays.push(ms); pending = f; return 1; }, clearTimeout() { pending = undefined; },
    fetch: async () => responses[Math.min(call++, responses.length - 1)](),
  };
  ctx.window = ctx;
  vm.runInNewContext(script, ctx);
  const settle = () => new Promise(r => setImmediate(r));
  await settle();
  const fire = async () => { const f = pending; pending = undefined; f?.(); await settle(); };
  return { delays, els, listeners, fire, settle, calls: () => call };
}

const ok = () => ({ ok: true, json: async () => ({ tasks: [] }) });
const down = () => { throw new TypeError('offline'); };
const badBody = () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });

test('phone page: backoff doubles, caps at 30s, shows the text, and resets after success', async () => {
  const { delays, els, fire } = await runPage([down, down, down, down, down, down, ok]);
  assert.equal(els.st.textContent, 'Offline, retrying in 6s');
  for (let i = 0; i < 5; i++) await fire();
  assert.deepEqual(delays, [6000, 12000, 24000, 30000, 30000, 30000]);
  assert.equal(els.st.textContent, 'Offline, retrying in 30s');
  await fire(); // 7th request succeeds
  assert.equal(delays[6], 3000);
  assert.equal(els.st.textContent, '');
  await fire();
});

test('phone page: failure after success starts again from 6s, and a bad body counts as a failure', async () => {
  const { delays, els, fire } = await runPage([ok, badBody, down]);
  assert.equal(delays[0], 3000);
  await fire(); assert.equal(delays[1], 6000); assert.equal(els.st.textContent, 'Offline, retrying in 6s');
  await fire(); assert.equal(delays[2], 12000);
});

test('phone page: online / visible / focus events poll immediately and reset the backoff', async () => {
  const { delays, els, listeners, settle, calls } = await runPage([down, down, ok, ok]);
  assert.equal(delays[0], 6000);
  listeners.online(); await settle();           // not waiting for the 6s timer
  assert.equal(calls(), 2);
  assert.equal(delays[1], 6000);                // fails counter was reset to 0 then incremented once
  listeners.focus(); await settle();
  assert.equal(calls(), 3);
  assert.equal(els.st.textContent, '');
  listeners['doc:visibilitychange'](); await settle();
  assert.equal(calls(), 4);
});

test('phone page: a malformed response still schedules the next poll', async () => {
  const { delays } = await runPage([badBody]);
  assert.equal(delays.length, 1);
});

test('phone page: success resets to the normal 3s interval', async () => {
  const { delays, els } = await runPage([ok]);
  assert.deepEqual(delays, [3000]);
  assert.equal(els.st.textContent, '');
});

test('phone page: says notifications are unavailable outside a secure context', async () => {
  const { els } = await runPage([ok]);
  assert.match(els.nt.textContent, /unavailable/);
});
