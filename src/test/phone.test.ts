import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'vm';
import { AddressInfo } from 'net';
import { startPhoneServer, phoneMoveError, canPhoneMerge, phoneLinkUrl, qrSvg, phoneSteps, PHONE_ACTIONS, BOARD_ACTIONS } from '../phone';

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
  assert.equal(canPhoneMerge({ ...ok, where: 'direct' }), false);
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
  assert.equal(phoneLinkUrl('192.168.1.5', 7878, 'a b'), 'http://192.168.1.5:7878/?pair=a%20b');
  const svg = qrSvg('http://192.168.1.5:7878/?pair=abc');
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

test('phone page: has the project picker and the column tabs', async () => {
  const { srv, base } = await boot();
  try {
    const html = await (await fetch(base + '/?t=tok')).text();
    assert.match(html, /<div id="pj"/);
    assert.match(html, /<div id="tabs"/);
    for (const k of ['todo', 'doing', 'review', 'done']) assert.ok(html.includes(`'${k}'`), k);
    assert.match(html, /type:'project'/);
    assert.match(html, /type:'move'/);
    assert.match(html, /name="viewport" content="width=device-width/);
    for (const l of ['To do', 'Doing', 'Review', 'Done']) assert.ok(html.includes(`${l}:'`) || html.includes(`'${l}'`), l);
    assert.match(html, /<input id="t"/);
    assert.match(html, /\$\('t'\)\.hidden=true/);
    assert.match(html, /const ps=el\('select'/);
    assert.ok(html.includes('min-height:44px'));
    assert.ok(html.includes('JustCode: Add Project'));
    assert.match(html, /<div id="top"><header/);
    assert.match(html, /\{ps\.blur\(\);selId='';actGen\+\+;[^}]*act\(\{type:'project'/);
  } finally { srv.close(); }
});

test('phone act: project and move are whitelisted', async () => {
  const { PHONE_ACTIONS } = await import('../phone');
  assert.ok((PHONE_ACTIONS as readonly string[]).includes('project'));
  assert.ok((PHONE_ACTIONS as readonly string[]).includes('move'));
});

test('phoneMoveError: done, busy, asking, out of done and todo-with-branch are refused; plain moves pass', async () => {
  const { phoneMoveError, phoneProjectOk } = await import('../phone');
  const t = { status: 'doing' };
  assert.match(phoneMoveError(t, 'done')!, /Done/);
  assert.match(phoneMoveError(t, 42)!, /unknown/);
  assert.match(phoneMoveError(t, 'archived')!, /unknown/);
  const ok = { status: 'review', worktree: '/w', review: { state: 'pass', risk: 'low' } };
  assert.equal(phoneMoveError(ok, 'done'), undefined);
  assert.match(phoneMoveError({ ...ok, review: { state: 'pass', risk: 'critical' } }, 'done')!, /Done/);
  assert.match(phoneMoveError({ ...ok, review: { state: 'fail' } }, 'done')!, /Done/);
  assert.match(phoneMoveError({ ...t, busy: true }, 'review')!, /running/);
  assert.match(phoneMoveError({ ...t, asks: [{}] }, 'review')!, /running/);
  assert.match(phoneMoveError({ status: 'done' }, 'todo')!, /done task/);
  assert.match(phoneMoveError({ ...t, worktree: '/w' }, 'todo')!, /branch/);
  assert.equal(phoneMoveError({ ...t, worktree: '/w' }, 'review'), undefined);
  assert.equal(phoneMoveError({ status: 'todo' }, 'doing'), undefined);
  assert.equal(phoneProjectOk('/a', ['/a', '/b']), true);
  assert.equal(phoneProjectOk('/c', ['/a']), false);
  assert.equal(phoneProjectOk(['/a'], ['/a']), false);
});

test('phone page: act() posts the message, shows a server error inline and reloads', async () => {
  const { srv, base } = await boot();
  const html = await (await fetch(base + '/?t=tok')).text();
  srv.close();
  const src = html.match(/async function act\(m\)\{.*\}/)![0];
  const calls: string[] = []; const alerts: string[] = [];
  const f = new vm.Script(`(${'async function(fetch,H,$,load){' + src + '; return act}'})`).runInThisContext();
  const mkAct = (reply: any) => f(async (u: string, o: any) => { calls.push(u + ' ' + o.body); return { json: async () => reply }; }, () => ({}), () => ({ set textContent(t: string) { if (t) alerts.push(t); } }), () => calls.push('load'));
  await (await mkAct({ error: 'busy' }))({ type: 'move', id: 'a', status: 'review' });
  assert.deepEqual(calls, ['/api/act {"type":"move","id":"a","status":"review"}', 'load']);
  assert.deepEqual(alerts, ['busy']);
  calls.length = 0; alerts.length = 0;
  await (await mkAct({ ok: true }))({ type: 'project', root: '/p' });
  assert.deepEqual(alerts, []); assert.equal(calls[1], 'load');
});

test('phone page: pending permission asks show and notify on every tab, not just the open one', async () => {
  const { srv, base } = await boot();
  try {
    const html = await (await fetch(base + '/?t=tok')).text();
    assert.match(html, /t\.status===col\|\|t\.asks\.length/);
    assert.match(html, /for\(const t of data\.tasks\)for\(const a of t\.asks\)/);
    assert.doesNotMatch(html, /Move to done/);
  } finally { srv.close(); }
});

async function pageSrc() {
  const { srv, base } = await boot();
  const html = await (await fetch(base + '/?t=tok')).text();
  srv.close();
  return html;
}

test('phone page: load() skips while dragging or a select is focused but keeps polling', async () => {
  const html = await pageSrc();
  const load = html.match(/async function load\(\)\{if\(busy\)return;if\(hold\(\)\)\{.*?\}busy=true/)![0];
  assert.match(load, /sched\(\);return/);
  const hold = html.match(/function hold\(\)\{.*?\}/)![0];
  const mk = (tag: string) => new vm.Script(`(function(document){let dragging=false;${hold};return {hold,set:v=>dragging=v}})`).runInThisContext()({ activeElement: { tagName: tag } });
  const a = mk('BUTTON'); assert.equal(a.hold(), false); a.set(true); assert.equal(a.hold(), true);
  assert.equal(mk('SELECT').hold(), true);
});

test('phone page: Move select blurs then posts a move; drag onto a tab posts it; refresh deferred during drag', async () => {
  const html = await pageSrc();
  // select
  assert.match(html, /onchange:\(\)=>\{if\(sel\.value\)\{sel\.blur\(\);act\(\{type:'move',id:t\.id,status:sel\.value\}\)\}\}/);
  // drag handler run against a fake card and timers
  const src = html.match(/let dragging=false.*?c\.addEventListener\('touchcancel',end\)\}/s)![0];
  const acts: any[] = []; const ls: Record<string, any> = {}; let fire: any;
  const card = { style: {} as any, addEventListener: (n: string, f: any) => { ls[n] = f; }, };
  const tab = { id: 'tab-doing', closest: () => tab };
  const doc = { elementFromPoint: () => ({ closest: () => tab }) };
  const $ = (id: string) => ({ style: {} as any });
  const fn = new vm.Script(`(function(document,$,act,setTimeout,clearTimeout,navigator){${src};return {dragMove,get:()=>dragging}})`).runInThisContext();
  const m = fn(doc, $, (x: any) => acts.push(x), (f: any) => { fire = f; return 1; }, () => { fire = undefined; }, {});
  m.dragMove(card, { id: 'a', status: 'todo' });
  const pt = { clientX: 5, clientY: 5 };
  ls.touchstart({ target: { closest: () => null }, touches: [pt] });
  fire(); assert.equal(m.get(), true);
  ls.touchmove({ touches: [pt], preventDefault() {} });
  ls.touchend({ type: 'touchend', changedTouches: [pt], touches: [] });
  assert.deepEqual(acts, [{ type: 'move', id: 'a', status: 'doing' }]);
  assert.equal(m.get(), false);
  // a quick touch (no long-press) does nothing
  ls.touchstart({ target: { closest: () => null }, touches: [pt] });
  ls.touchend({ type: 'touchend', changedTouches: [pt], touches: [] });
  assert.equal(acts.length, 1);
});

test('phone projects: listing, valid switch and rejected path', async () => {
  const { phoneProjects, phoneProjectOk } = await import('../phone');
  const roots = ['/a/one', '/b/two'];
  assert.deepEqual(phoneProjects(roots), [{ root: '/a/one', name: 'one' }, { root: '/b/two', name: 'two' }]);
  assert.equal(phoneProjectOk('/b/two', roots), true);
  assert.equal(phoneProjectOk('/etc', roots), false);
  assert.equal(phoneProjectOk('/a/one/../../etc', roots), false);
  assert.equal(phoneProjectOk(undefined, roots), false);
  assert.equal(phoneProjectOk(5, roots), false);
  assert.equal(phoneProjectOk({ toString: () => '/a/one' }, roots), false);
});

test('pairing code is single-use, expires, and sets a session cookie', async () => {
  const { issuePairingCode, redeemPairingCode } = await import('../phone');
  const c = issuePairingCode(1000, 0);
  assert.equal(redeemPairingCode(c, 500), true);
  assert.equal(redeemPairingCode(c, 500), false);
  assert.equal(redeemPairingCode(issuePairingCode(1000, 0), 2000), false);
  const srv = await startPhoneServer(0, { token: 'secret', state: () => ({}), act: async () => {} });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const code = issuePairingCode();
    const r = await fetch(`${base}/?pair=${code}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') ?? '', /jc_session=(?!secret)[\w-]+;.*HttpOnly/);
    assert.equal((await fetch(`${base}/?pair=${code}`)).status, 401);
  } finally { srv.close(); }
});

test('pairing: cookie authorizes later calls, expired/empty codes do not, session is not the token', async () => {
  const { issuePairingCode } = await import('../phone');
  const srv = await startPhoneServer(0, { token: 'secret', state: () => ({ ok: 1 }), act: async () => {}, allowTokenInUrl: false });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const expired = issuePairingCode(-1);
    assert.equal((await fetch(`${base}/?pair=${expired}`)).status, 401);
    assert.equal((await fetch(`${base}/?pair=`)).status, 401);
    assert.equal((await fetch(`${base}/?pair=bogus`)).status, 401);
    assert.equal((await fetch(`${base}/?pair=bogus`, { headers: { 'x-token': 'secret' } })).status, 200);
    assert.equal((await fetch(`${base}/?pair=`, { headers: { 'x-token': 'secret' } })).status, 200);
    assert.equal((await fetch(`${base}/?token=secret`)).status, 401); // opted out of token links
    const r = await fetch(`${base}/?pair=${issuePairingCode()}`);
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    assert.doesNotMatch(cookie, /secret/);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: 'jc_session=secret' } })).status, 401);
  } finally { srv.close(); }
});

// One case per phone action: it reaches the handler with a good token and is rejected (401, handler untouched) with a bad one.
async function actHarness() {
  const acts: any[] = []; const boards: any[] = [];
  const srv = await startPhoneServer(0, {
    token: 'tok', state: () => ({ tasks: [] }),
    act: async m => {
      acts.push(m);
      if (m.type === 'move') return phoneMoveError({ status: 'review', worktree: '/w', review: { state: 'fail' } }, m.status);
    },
    board: async m => { boards.push(m); },
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (path: string, b: object, tok = 'tok') => fetch(base + path, { method: 'POST', headers: { 'x-token': tok }, body: JSON.stringify(b) });
  return { srv, post, acts, boards };
}

const actCases: Array<[string, object]> = [
  ['run', { type: 'run', id: 'a' }],
  ['stop', { type: 'stop', id: 'a' }],
  ['answer allow', { type: 'answer', id: 'a', ask: 'q1', allow: true }],
  ['answer deny', { type: 'answer', id: 'a', ask: 'q1', allow: false }],
  ['move valid', { type: 'move', id: 'a', status: 'doing' }],
  ['project', { type: 'project', id: 'p1' }],
  ['addTask', { type: 'addTask', title: 'x' }],
  ['merge', { type: 'merge', id: 'a' }],
];
for (const [name, body] of actCases) {
  test(`phone act: ${name} works and rejects a bad token`, async () => {
    const { srv, post, acts } = await actHarness();
    try {
      assert.equal((await post('/api/act', body, 'nope')).status, 401);
      assert.equal((await post('/api/act', body, '')).status, 401);
      assert.equal(acts.length, 0);
      assert.equal((await post('/api/act', body)).status, 200);
      assert.deepEqual(acts, [body]);
    } finally { srv.close(); }
  });
}

test('phone act: move to done is refused and rejects a bad token', async () => {
  const { srv, post, acts } = await actHarness();
  try {
    const body = { type: 'move', id: 'a', status: 'done' };
    assert.equal((await post('/api/act', body, 'nope')).status, 401);
    assert.equal(acts.length, 0);
    const r = await post('/api/act', body);
    assert.equal(r.status, 400);
    assert.match((await r.json() as any).error, /Done/);
  } finally { srv.close(); }
});

test('phone board: dialogReply and merge relay as remote, bad token rejected', async () => {
  const { srv, post, boards } = await actHarness();
  try {
    for (const type of ['dialogReply', 'merge']) {
      assert.equal((await post('/api/board', { type }, 'nope')).status, 401);
      assert.equal(boards.length, 0);
      assert.equal((await post('/api/board', { type, id: 'a', remote: false })).status, 200);
      assert.equal(boards.pop().remote, undefined);
    }
    assert.equal((await post('/api/board', { type: 'openFile' })).status, 400);
  } finally { srv.close(); }
});

import { phoneDetail } from '../phone';
test('phoneDetail: no worktree gives an empty file list and no error; files and checks are mapped', async () => {
  const d = await phoneDetail({ review: { state: 'fail', why: 'w', issues: ['i'] } }, async () => { throw new Error('should not run'); });
  assert.deepEqual(d.files, []); assert.equal(d.error, undefined); assert.deepEqual(d.review, { state: 'fail', why: 'w', issues: ['i'] });
  const e = await phoneDetail({ worktree: '/x', checks: { results: [{ name: 'test', ok: false, tail: 'boom' }] } }, async () => [{ file: 'a.ts', status: 'M', added: 2, removed: 1 }]);
  assert.equal(e.files[0].added, 2); assert.deepEqual(e.checks, [{ name: 'test', ok: false, tail: 'boom' }]);
});

test('phone server: GET /api/detail needs a token, passes the id, and a rejection gives 500', async () => {
  const ids: string[] = [];
  const srv = await startPhoneServer(0, { token: 'secret', state: () => ({}), act: async () => {},
    detail: async id => { ids.push(id); if (id === 'bad') throw new Error('x'); return { files: [], checks: [] }; } });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    assert.equal((await fetch(base + '/api/detail?id=a')).status, 401);
    assert.equal((await fetch(base + '/api/detail?id=a', { headers: { 'x-token': 'nope' } })).status, 401);
    assert.deepEqual(ids, []);
    const ok = await fetch(base + '/api/detail?id=a', { headers: { 'x-token': 'secret' } });
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { files: [], checks: [] }); assert.deepEqual(ids, ['a']);
    assert.equal((await fetch(base + '/api/detail?id=bad', { headers: { 'x-token': 'secret' } })).status, 500);
  } finally { srv.close(); }
});

test('phone: /api/task is token-protected, read-only, 404 for unknown ids', async () => {
  const srv = await startPhoneServer(0, { token: 'tok', state: () => ({ tasks: [] }), act: async () => {},
    task: async id => id === 'a' ? { id, steps: phoneSteps(Array.from({ length: 300 }, (_, i) => ({ kind: 'say', text: 'x'.repeat(i === 299 ? 5000 : 1) }))), files: [], checks: [], agents: [], costUsd: 1, context: 5 } : undefined });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + '/api/task?id=a')).status, 401);
    const ok = await fetch(base + '/api/task?id=a', { headers: { 'x-token': 'tok' } });
    assert.equal(ok.status, 200);
    const j: any = await ok.json();
    assert.equal(j.steps.length, 200);
    assert.ok(j.steps[199].text.length < 700);
    assert.equal(j.costUsd, 1);
    assert.equal((await fetch(base + '/api/task?id=zzz', { headers: { 'x-token': 'tok' } })).status, 404);
    assert.equal((await fetch(base + '/api/task', { headers: { 'x-token': 'tok' } })).status, 404);
  } finally { srv.close(); }
  assert.deepEqual([...PHONE_ACTIONS], ['addTask', 'run', 'stop', 'answer', 'merge', 'project', 'move']);
  assert.deepEqual([...BOARD_ACTIONS], ['dialogReply', 'merge']);
});
