import { mobileMessage, bypassGate, canEnableBypassAll, DialogHub, makePhoneBoard, confirmBypassFor, remoteConfirm, remoteInput, remotePaths, validLink } from './bridge';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Store, Task, resolveWhere, resolveOutput } from './store';
import { Runner, RunnerSettings } from './runner';
import * as g from './git';
import { pluginDir } from './plugin';
import { transcript, agentLog, archivedLog, artifactUrlIn, claudeBin, claudeEnv, discoverAgents, discoverSkills, savedAgents, sessionLog, slashCommands } from './claude';
import { Limits } from './limits';
import { checkHealth, checkSetup, installCommand, projectSetup, SetupState, pluginInstallCommands, playwrightCommand, SUPERPOWERS_FALLBACK } from './setup';
import * as A from './artifacts';
import * as R from './registry';
import * as Audit from './audit';
import { writeSprintReport } from './report';
import { loadPolicy, policyFile } from './policy';
import type { Actor } from './audit';
import * as C from './checks';
import * as D from './design';
import { ensureCert, PhoneCert } from './phonecert';
import { Device, DeviceStore, startPhoneServer, canPhoneMerge, phoneDetail, phoneSteps, phoneMoveError, phoneProjectOk, phoneProjects, phoneLinkUrl, qrSvg, issuePairingCode } from './phone';
import type * as http from 'http';
import { startMobileServer, MobileServer } from './server';
import { bypassAllOn, push, roots, runner, setCurrent, setting, sinks, st } from './host';
import { handle } from './messages';
import { recheck } from './setupflow';
import { savedLog } from './boardstate';

// The phone server and the LAN board: token, pairing, devices, actions a phone may take.

export const newToken = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

export const phoneToken = () => st.phoneTok;

// Token lives in SecretStorage (migrating the old globalState copy once).
export const loadPhoneToken = async () => {
  let t = await st.ctx.secrets.get('justCode.phoneToken');
  if (!t) { t = newToken(); await st.ctx.secrets.store('justCode.phoneToken', t); }
  st.phoneTok = t;
  if (st.ctx.globalState.get('phoneToken')) void st.ctx.globalState.update('phoneToken', undefined);
};

export const phoneState = () => {
  const r = runner();
  return { projects: phoneProjects(roots()), current: st.current, tasks: (r?.store.data.tasks ?? []).filter(t => !t.archived).map(t => {
    const l = r!.live(t.id);
    return { id: t.id, title: t.title, status: t.status, busy: l.busy, asks: l.asks, review: t.review?.state,
      canMerge: canPhoneMerge(t) };
  }) };
};

export async function phoneAct(m: any, via = 'phone'): Promise<string | void> {
  const r = runner();
  if (!r) return 'no project open';
  const t = m.id ? r.store.task(m.id) : undefined;
  if (m.type !== 'project') r.audit('phone.action', t?.id, `${m.type}${m.choice ? ` ${m.choice}` : ''}${m.status ? ` → ${m.status}` : ''} (${via})`, 'phone');
  switch (m.type) {
    case 'addTask': {
      if (!String(m.title ?? '').trim()) return 'title required';
      const output = resolveOutput(undefined, String(m.title));
      const task = r.store.addTask({ title: String(m.title).trim(), mode: (setting<string>('defaultMode', 'auto') === 'bypassPermissions' ? 'auto' : setting<string>('defaultMode', 'auto')) as Task['mode'], ...(output ? { output, where: 'direct' as const } : {}) });
      A.logPrompt(r.root, { kind: 'task', text: task.title, taskId: task.id, title: task.title });
      r.audit('task.create', task.id, task.title, 'phone');
      if (m.start) await r.run(task.id);
      return;
    }
    case 'run': if (!t) return 'no such task'; await r.requestRun(t.id); return;
    case 'stop': if (!t) return 'no such task'; r.stop(t.id); return;
    case 'answer':
      if (m.choice !== 'allow' && m.choice !== 'deny') return 'phone can only allow or deny';
      return r.answer(m.id, { id: m.ask, choice: m.choice, by: 'phone' }) ? undefined : 'request no longer open';
    case 'project':
      if (!phoneProjectOk(m.root, roots())) return 'unknown project';
      setCurrent(m.root); st.watching = undefined; void recheck(); push(); return;
    case 'move':
      if (!t) return 'no such task';
      { const l = r.live(t.id); const e = phoneMoveError({ status: t.status, worktree: t.worktree, where: t.where, review: t.review, busy: l.busy, asks: l.asks }, m.status); if (e) return e; }
      if (m.status === 'done') { await r.merge(t.id, false, 'phone'); return; }
      r.store.updateTask(t.id, { status: m.status }); return;
    case 'merge':
      if (!t || !canPhoneMerge(t)) return 'only tasks that passed review (and are not flagged critical) can be merged from the phone';
      await r.merge(t.id, false, 'phone'); return;
  }
}

// Only a reply to a pending dialog, or a merge of a task that passed review (same rule as /api/act), may come from a phone.
export const hub = new DialogHub();

export const phoneBoard = makePhoneBoard<Task>({ hub, task: id => runner()?.store.task(id), canMerge: canPhoneMerge, merge: id => runner()!.merge(id) });

export async function syncPhone() {
  await loadPhoneToken();
  const on = setting('phoneServer', false);
  if (!on) { st.phone?.close(); st.phone = undefined; return; }
  if (st.phone) return;
  try {
    st.phoneCert = setting('phoneTls', false) ? await ensureCert() : undefined;
    st.phone = await startPhoneServer(setting('phoneServerPort', 7878), { tls: st.phoneCert, token: phoneToken(), state: phoneState, act: phoneAct, paired: via => { const r = runner(); if (r) Audit.log(r.root, { actor: 'phone', event: 'phone.pair', detail: via }); }, board: phoneBoard, events: n => hub.events(n),
    task: async id => { const r = runner(), t = r?.store.task(id); if (!r || !t) return undefined; const l = r.live(t.id);
      return { id: t.id, ...await detailOf(id), agents: l.agents, costUsd: t.costUsd ?? 0, usage: t.usage, context: l.context }; },
    detail: id => detailOf(id), allowTokenInUrl: false, devices: phoneDevices, tokenDays: Math.max(1, setting<number>('phoneTokenDays', 7)) }); }
  catch (e: any) { vscode.window.showErrorMessage(`JustCode phone server could not start: ${e.message}`); }
}

// Paired phones (token hashes only), kept across restarts in this machine's VS Code storage.
export const phoneDevices: DeviceStore = {
  list: () => st.ctx.globalState.get<Device[]>('phoneDevices', []),
  save: list => { void st.ctx.globalState.update('phoneDevices', list).then(push); },
};

export async function detailOf(id: string): Promise<any> {
  const r = runner(), t = r?.store.task(id); if (!r || !t) return { files: [], checks: [], error: 'no such task' };
  {
      const steps = phoneSteps(r.steps(t.id) ?? savedLog(r, t));
      return { steps, ...await phoneDetail(t, async dir => {
        const base = t.base ?? 'HEAD', stat = new Map<string, [number, number]>();
        const num = await g.git(dir, ['diff', '--numstat', '--no-renames', '-z', `${base}...HEAD`]).catch(() => '');
        for (const l of num.split('\0').filter(Boolean)) { const [a, d, ...f] = l.split('\t'); stat.set(f.join('\t'), [Number(a) || 0, Number(d) || 0]); }
        return (await g.changes(dir, base)).map(c => { const raw = /^".*"$/.test(c.file) ? (() => { try { return JSON.parse(c.file) as string; } catch { return c.file; } })() : c.file, n = stat.get(raw); return { file: raw, status: c.status, added: n?.[0] ?? 0, removed: n?.[1] ?? 0 }; });
      }) }; }
}

// Serialized: each run stops any old server (really closed) before deciding whether to start a new one.
export const syncMobile = (restart = false): Promise<void> => st.mobileChain = st.mobileChain.then(async () => {
  const on = setting('mobile.enabled', false);
  if (st.mobile && (restart || !on)) { const m = st.mobile; st.mobile = undefined; await m.stop(); }
  if (!on || st.mobile) return;
  // The server has no token: with Bypass all on, a LAN client could start tasks that run any command, so it never starts then.
  if (bypassAllOn()) { vscode.window.showWarningMessage('JustCode mobile server not started: turn off Bypass all first (it would let anyone on the network run commands on this computer).'); return; }
  const port = setting('mobile.port', 7979);
  try {
    st.mobile = await startMobileServer(port, {
      media: vscode.Uri.joinPath(st.ctx.extensionUri, 'media').fsPath,
      addSink: s => { sinks.add(s); return () => { sinks.delete(s); }; },
      onMessage: async m => { if (!bypassAllOn()) await handle(m, true); },
      onConnect: () => { st.watching = undefined; push(); },
      hubEvents: n => hub.events(n),
    });
    vscode.window.showInformationMessage(`JustCode board is served on your network: http://${lanIps()[0] ?? 'this-computer'}:${port}/ (no token: turn off justCode.mobile.enabled when done).`);
  } catch (e: any) { st.mobile = undefined; vscode.window.showErrorMessage(`JustCode mobile server could not start: ${e.message}`); }
});

export const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address);
