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
      return mk(`${name}()`);
    },
    construct() { return mk(`new ${name}`); },
  });
  const vscode: any = {};
  for (const k of ['window', 'commands', 'env', 'Uri', 'StatusBarAlignment', 'ViewColumn', 'ConfigurationTarget', 'ThemeColor', 'languages', 'extensions']) vscode[k] = mk(k);
  vscode.workspace = new Proxy({}, { get(_, k) {
    if (k === 'workspaceFolders') return [{ uri: { fsPath: root } }];
    if (k === 'getConfiguration') return () => ({ get: (_k: string, d: unknown) => d, update: async () => {} });
    return mk(`workspace.${String(k)}`);
  } });
  const load = Module._load;
  Module._load = function (req: string, ...rest: unknown[]) { return req === 'vscode' ? vscode : load.call(this, req, ...rest); };
  try {
    const ext = require('../extension');
    const mem = () => { const m = new Map(); return { get: (k: string, d: unknown) => m.has(k) ? m.get(k) : d, update: async (k: string, v: unknown) => { m.set(k, v); }, keys: () => [...m.keys()] }; };
    ext.activate({ subscriptions: [], globalState: mem(), workspaceState: mem(), secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      extensionUri: { fsPath: process.cwd() }, extension: { packageJSON: { version: '9.9.9' } }, extensionPath: process.cwd() });
    assert.deepEqual(Object.keys(cmds).sort(), ['justCode.addProject', 'justCode.exportAudit', 'justCode.exportSprintReport', 'justCode.open', 'justCode.phoneLink', 'justCode.setApiKey', 'justCode.setup', 'justCode.showPhonePairing']);
    cmds['justCode.open']();
    assert.equal(handlers.length, 1);
    const send = (m: any) => handlers[0]({ root, ...m });
    await send({ type: 'ready' });
    await send({ type: 'addTask', title: 'Smoke task', mode: 'bypassPermissions' });
    await send({ type: 'phoneRevoke', id: 'all' });
    await new Promise(r => setTimeout(r, 200));
    const state = posted.filter(m => m?.type === 'state').pop();
    assert.deepEqual(state.board.tasks.map((t: any) => t.title), ['Smoke task']);
    assert.equal(state.board.tasks[0].mode, 'bypassPermissions', 'a task with no session keeps its own mode in the board state');
    assert.ok(state.policy && Array.isArray(state.registry) && state.phone);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', '.justcode']);
    ext.deactivate();
    // The setup check still running may create the project's runner again: let it settle, then end it too.
    await new Promise(r => setTimeout(r, 1500));
    ext.deactivate();
  } finally { Module._load = load; }
});
