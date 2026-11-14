import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

// Loads the extension with a stub `vscode` module: activation, the board panel and a few board messages must work,
// and opening a project may create nothing in it except .justcode/. Catches import-order and wiring mistakes in the
// host modules (extension, host, messages, …) that the other tests never load.
test('extension: activates, opens the board, handles messages, writes only .justcode/', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-act-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const cmds: Record<string, (...a: any[]) => any> = {}, handlers: any[] = [], posted: any[] = [];
  const mk = (name: string): any => new Proxy(function () { /* stub */ }, {
    get(_, k) { if (k === 'then') return undefined; if (k === Symbol.toPrimitive) return () => name; if (k === 'dispose') return () => {}; return mk(`${name}.${String(k)}`); },
    apply(_, __, args) {
      if (/registerCommand$/.test(name)) cmds[args[0]] = args[1];
      if (/onDidReceiveMessage$/.test(name)) handlers.push(args[0]);
      if (/postMessage$/.test(name)) posted.push(args[0]);
      if (/window\.showWarningMessage$/.test(name)) return Promise.resolve(confirmAnswer ? args[2] : undefined);
      return mk(`${name}()`);
    },
    construct() { return mk(`new ${name}`); },
  });
  const stored: string[] = []; let phoneOn = false, confirmAnswer = true;
  const vscode: any = {};
  for (const k of ['window', 'commands', 'env', 'Uri', 'StatusBarAlignment', 'ViewColumn', 'ConfigurationTarget', 'ThemeColor', 'languages', 'extensions']) vscode[k] = mk(k);
  vscode.workspace = new Proxy({}, { get(_, k) {
    if (k === 'workspaceFolders') return [{ uri: { fsPath: root } }];
    if (k === 'getConfiguration') return () => ({ get: (k2: string, d: unknown) => phoneOn && k2 === 'phoneServer' ? true : phoneOn && k2 === 'phoneServerPort' ? 0 : phoneOn && k2 === 'phoneTls' ? false : d, update: async () => {} });
    return mk(`workspace.${String(k)}`);
  } });
  const load = Module._load;
  Module._load = function (req: string, ...rest: unknown[]) { return req === 'vscode' ? vscode : load.call(this, req, ...rest); };
  try {
    const ext = require('../extension');
    const mem = () => { const m = new Map(); return { get: (k: string, d: unknown) => m.has(k) ? m.get(k) : d, update: async (k: string, v: unknown) => { m.set(k, v); }, keys: () => [...m.keys()] }; };
    ext.activate({ subscriptions: [], globalState: mem(), workspaceState: mem(), secrets: { get: async () => undefined, store: async (k: string) => { stored.push(k); }, delete: async () => {} },
      extensionUri: { fsPath: process.cwd() }, extension: { packageJSON: { version: '9.9.9' } }, extensionPath: process.cwd() });
    assert.deepEqual(Object.keys(cmds).sort(), ['justCode.addProject', 'justCode.exportAudit', 'justCode.exportSprintReport', 'justCode.open', 'justCode.phoneLink', 'justCode.setApiKey', 'justCode.setup', 'justCode.showPhonePairing']);
    cmds['justCode.open']();
    assert.equal(handlers.length, 1);
    const send = (m: any) => handlers[0]({ root, ...m });
    await send({ type: 'ready' });
    await send({ type: 'addTask', title: 'Smoke task', mode: 'acceptEdits' });
    await send({ type: 'phoneRevoke', id: 'all' });
    // Pairing: the code goes to the panel only, never a shared sink; remote calls are ignored; server off issues no code.
    const { handle } = require('../messages'), { sinks } = require('../host'), { phoneDevices } = require('../phonehost');
    const seen: any[] = []; sinks.add((m: any) => seen.push(m));
    const before = posted.length;
    await handle({ type: 'phonePairing', root }, true);
    await handle({ type: 'phoneUnpair', root }, true);
    assert.equal(posted.length, before, 'remote pairing calls are ignored');
    const tokenWrites = stored.filter(k => k === 'justCode.phoneToken').length;
    await send({ type: 'phonePairing' });
    const pairing = posted.slice(before).filter(m => m?.type === 'pairing');
    assert.deepEqual(pairing, [{ type: 'pairing', on: false }], 'server off: on:false and no code');
    assert.equal(seen.filter(m => m?.type === 'pairing').length, 0, 'pairing is not broadcast to shared sinks');
    confirmAnswer = false; const w0 = stored.length;
    await send({ type: 'phoneUnpair' });
    assert.equal(stored.length, w0, 'declining the confirm leaves the token alone');
    confirmAnswer = true;
    await send({ type: 'phoneUnpair' });
    assert.ok(stored.filter(k => k === 'justCode.phoneToken').length > tokenWrites, 'unpair rotates the token');
    assert.deepEqual(phoneDevices.list(), [], 'unpair clears devices');
    // Server on: the payload has the code, QR, url and fingerprint, and still goes only to the panel.
    phoneOn = true;
    try {
      const b2 = posted.length; seen.length = 0;
      await send({ type: 'phonePairing' });
      const p2 = posted.slice(b2).find(m => m?.type === 'pairing');
      assert.ok(p2?.on && /^\d{6}$/.test(p2.code) && p2.qr.includes('<svg') && /^https?:\/\/.+:\d+$/.test(p2.url) && typeof p2.fingerprint === 'string', 'pairing payload: ' + JSON.stringify(p2)?.slice(0, 200));
      assert.equal(seen.filter(m => m?.type === 'pairing').length, 0, 'live code is not broadcast');
    } finally { phoneOn = false; require('../host').st.phone?.close(); }
    await new Promise(r => setTimeout(r, 200));
    const state = posted.filter(m => m?.type === 'state').pop();
    assert.deepEqual(state.board.tasks.map((t: any) => t.title), ['Smoke task']);
    assert.equal(state.board.tasks[0].mode, 'acceptEdits', 'a task with no session keeps its own mode in the board state');
    assert.ok(state.policy && Array.isArray(state.registry) && state.phone);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', '.justcode']);
  } finally {
    // Always shut down (even after a failed assertion), or the store's file watcher keeps the test process alive.
    // The setup check still running may create the project's runner again: let it settle, then end it too.
    const ext = require('../extension');
    ext.deactivate();
    await new Promise(r => setTimeout(r, 1500));
    ext.deactivate();
    Module._load = load;
  }
});
