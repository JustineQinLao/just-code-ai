import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'vm';
import { AddressInfo } from 'net';
import { startPhoneServer } from '../phone';

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

// Runs the page script against a stub DOM and fake fetch/timers; returns the delays scheduled by each poll.
async function runPage(responses: Array<() => any>) {
  const { srv, base } = await boot();
  const html = await (await fetch(base + '/')).text();
  srv.close();
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const els: Record<string, any> = {};
  const mk = () => ({ value: '', textContent: '', style: {}, append() {}, addEventListener() {}, scrollIntoView() {} });
  const delays: number[] = []; let call = 0;
  const ctx: any = {
    document: { getElementById: (i: string) => els[i] ??= mk(), createElement: () => mk(), addEventListener() {}, hidden: false },
    localStorage: {}, location: { search: '', href: 'http://x/' }, navigator: {}, URLSearchParams, URL,
    addEventListener() {}, alert() {}, confirm() { return true; }, Object, Math, console,
    setTimeout: (_f: any, ms: number) => { delays.push(ms); return 1; }, clearTimeout() {},
    fetch: async () => responses[Math.min(call++, responses.length - 1)](),
  };
  ctx.window = ctx;
  vm.runInNewContext(script, ctx);
  await new Promise(r => setImmediate(r));
  return { delays, els, ctx };
}

const ok = () => ({ ok: true, json: async () => ({ tasks: [] }) });
const down = () => { throw new TypeError('offline'); };
const badBody = () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });

test('phone page: backoff doubles on failures and polling continues after a bad body', async () => {
  const { delays, els } = await runPage([down, badBody, ok]);
  assert.equal(delays[0], 6000);                 // first failure: 3s * 2
  assert.match(els.st.textContent, /Offline|^$/);
  assert.ok(delays.length >= 1);
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
