import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'vm';
import { AddressInfo } from 'net';
import { startPhoneServer, canPhoneMerge, phoneLinkUrl, qrSvg } from '../phone';

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
  const html = await (await fetch(base + '/?t=tok')).text();
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

test('phoneLinkUrl and qrSvg', () => {
  assert.equal(phoneLinkUrl('192.168.1.5', 7878, 'a b'), 'http://192.168.1.5:7878/?token=a%20b');
  const svg = qrSvg('http://192.168.1.5:7878/?token=abc');
  assert.match(svg, /^<svg/);
  assert.ok(svg.length > 500);
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DialogHub, confinePath, validLink } from '../bridge';

test('DialogHub: accept, cancel, unknown id, timeout', async () => {
  const h = new DialogHub(50);
  const a = h.ask({ title: 't', buttons: ['Merge'] });
  const id = (h.events(0).events[0] as any).id;
  assert.equal(h.reply({ id: 'nope' }), false);
  assert.equal(h.reply({ id, button: 'Merge' }), true);
  assert.deepEqual(await a, { button: 'Merge', value: undefined });
  assert.equal(h.reply({ id, button: 'Merge' }), false); // already answered
  const b = h.ask({ title: 't' });
  h.reply({ id: (h.events(1).events[0] as any).id, cancelled: true });
  assert.equal(await b, undefined);
  assert.equal(await h.ask({ title: 'slow' }), undefined); // times out as a decline
  assert.equal(h.size, 0);
});

test('confinePath and validLink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-root-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-out-'));
  fs.writeFileSync(path.join(root, 'a.txt'), ''); fs.writeFileSync(path.join(out, 'secret'), '');
  fs.symlinkSync(out, path.join(root, 'link'));
  const real = fs.realpathSync(root);
  assert.equal(confinePath(root, 'a.txt'), path.join(real, 'a.txt'));
  assert.equal(confinePath(root, path.join(out, 'secret')), undefined);
  assert.equal(confinePath(root, '../' + path.basename(out) + '/secret'), undefined);
  assert.equal(confinePath(root, 'link/secret'), undefined);
  assert.equal(confinePath(root, 'missing'), undefined);
  assert.ok(validLink('https://x.dev/a') && !validLink('file:///etc/passwd') && !validLink('javascript:alert(1)'));
});

test('phone server: /api/board strips client remote flag and whitelists types', async () => {
  const got: any[] = [];
  const srv = await startPhoneServer(0, { token: 's', state: () => ({}), act: async () => {}, board: async m => { got.push(m); }, events: n => ({ n }) });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const post = (b: object) => fetch(base + '/api/board', { method: 'POST', headers: { 'x-token': 's' }, body: JSON.stringify(b) });
    assert.equal((await post({ type: 'merge', id: 'a', remote: false })).status, 200);
    assert.equal((await post({ type: 'openFile' })).status, 400);
    assert.equal('remote' in got[0], false);
    assert.equal((await fetch(base + '/api/events?since=3', { headers: { 'x-token': 's' } })).status, 200);
  } finally { srv.close(); }
});

import { remoteConfirm, remoteInput, remotePaths } from '../bridge';
const answer = (h: DialogHub, x: object) => setImmediate(() => { const e = h.events(0).events.find((m: any) => m.type === 'dialog') as any; h.reply({ id: e.id, ...x }); });

test('remote confirm: only the offered button proceeds; decline, cancel and timeout do not', async () => {
  let h = new DialogHub(50); answer(h, { button: 'Bypass permissions' });
  assert.equal(await remoteConfirm(h, 't', 'Bypass permissions'), true);
  h = new DialogHub(50); answer(h, { button: 'Other' });
  assert.equal(await remoteConfirm(h, 't', 'Bypass permissions'), false);
  h = new DialogHub(50); answer(h, { cancelled: true });
  assert.equal(await remoteConfirm(h, 't', 'Merge'), false);
  assert.equal(await remoteConfirm(new DialogHub(30), 't', 'Merge'), false); // no reply: declined
});

test('remote input revalidates; remotePaths confines; answered dialogs leave the event log', async () => {
  const v = (x: string) => validLink(x) ? undefined : 'bad';
  let h = new DialogHub(50); answer(h, { button: 'OK', value: 'file:///etc/passwd' });
  assert.equal(await remoteInput(h, { title: 'l', validateInput: v }), undefined);
  h = new DialogHub(50); answer(h, { button: 'OK', value: 'https://a.dev' });
  assert.equal(await remoteInput(h, { title: 'l', validateInput: v }), 'https://a.dev');
  assert.deepEqual(h.events(0).events, []); // stale dialog is gone
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-r-')); fs.writeFileSync(path.join(root, 'f'), '');
  h = new DialogHub(50); answer(h, { button: 'OK', value: 'f\n/etc/hosts\n../x' });
  assert.deepEqual(await remotePaths(h, root, 'Attach'), [path.join(fs.realpathSync(root), 'f')]);
});

test('phone server: /api/board refuses everything but dialogReply and merge', async () => {
  const srv = await startPhoneServer(0, { token: 's', state: () => ({}), act: async () => {}, board: async () => {} });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    for (const type of ['setMode', 'addTask', 'editTask', 'delete', 'addSource', 'pickFiles', 'discard'])
      assert.equal((await fetch(base + '/api/board', { method: 'POST', headers: { 'x-token': 's' }, body: JSON.stringify({ type, mode: 'bypassPermissions' }) })).status, 400, type);
  } finally { srv.close(); }
});

import { makePhoneBoard, confirmBypassFor } from '../bridge';
const replyNext = (h: DialogHub, x: object) => setImmediate(() => { const e = h.events(0).events.find((m: any) => m.type === 'dialog') as any; h.reply({ id: e.id, ...x }); });

test('remote bypass is refused without asking; desktop still asks', async () => {
  let asked = 0;
  assert.equal(await confirmBypassFor(true, async () => { asked++; return true; }), false);
  assert.equal(asked, 0);
  assert.equal(await confirmBypassFor(false, async () => { asked++; return true; }), true);
});

test('phoneBoard: merge needs a confirm, re-checks after it, ignores a second tap, refuses other types', async () => {
  let ok = true; const merged: string[] = [];
  const mk = (h: DialogHub) => makePhoneBoard({ hub: h, task: id => id === 'a' ? { id, title: 'A', base: 'main' } : undefined, canMerge: () => ok, merge: async id => { merged.push(id); } });
  let h = new DialogHub(50), board = mk(h);
  replyNext(h, { cancelled: true }); await board({ type: 'merge', id: 'a' });
  assert.deepEqual(merged, []);                                   // declined
  await board({ type: 'merge', id: 'a' }); assert.deepEqual(merged, []); // timed out
  replyNext(h, { button: 'Merge' }); await board({ type: 'merge', id: 'a' });
  assert.deepEqual(merged, ['a']);
  await assert.rejects(board({ type: 'merge', id: 'zzz' }));      // unknown task
  ok = false; await assert.rejects(board({ type: 'merge', id: 'a' })); // not mergeable
  await board({ type: 'setMode', id: 'a' }); assert.deepEqual(merged, ['a']);
  // review flips to not-mergeable while the dialog is open
  ok = true; h = new DialogHub(500); board = mk(h); merged.length = 0;
  setImmediate(() => { ok = false; const e = h.events(0).events[0] as any; h.reply({ id: e.id, button: 'Merge' }); });
  await assert.rejects(board({ type: 'merge', id: 'a' })); assert.deepEqual(merged, []);
  // double tap: second request while the first dialog is open opens no second dialog and does not merge twice
  ok = true; h = new DialogHub(500); board = mk(h);
  const first = board({ type: 'merge', id: 'a' }); await board({ type: 'merge', id: 'a' });
  assert.equal(h.events(0).events.length, 1);
  replyNext(h, { button: 'Merge' }); await first; assert.deepEqual(merged, ['a']);
});

test('board message filter: moving a card to done is refused, other moves and project selection pass', async () => {
  const { mobileMessage } = await import('../bridge');
  assert.deepEqual(mobileMessage({ type: 'root', root: '/p' }), { type: 'root', root: '/p' });
  assert.ok(mobileMessage({ type: 'move', id: 'a', status: 'doing' }));
  assert.ok(mobileMessage({ type: 'move', id: 'a', status: 'review' }));
  assert.equal(mobileMessage({ type: 'move', id: 'a', status: 'done' }), undefined);
  assert.equal(mobileMessage({ type: 'addProject' }), undefined);
});

test('phone page: has no project picker or move controls yet (update docs/GUIDE.md section 11 when it does)', async () => {
  const { srv, base } = await boot();
  try {
    const html = await (await fetch(base + '/?t=tok')).text();
    assert.doesNotMatch(html, /project picker|id="proj|class="tabs/);
  } finally { srv.close(); }
});
