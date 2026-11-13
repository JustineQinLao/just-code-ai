import { mobileMessage, bypassGate, canEnableBypassAll, DialogHub, makePhoneBoard, confirmBypassFor, remoteConfirm, remoteInput, remotePaths, validLink } from './bridge';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Store, Task, resolveWhere } from './store';
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
import { lanIps, loadPhoneToken, newToken, phoneDevices, syncMobile, syncPhone } from './phonehost';
import { PHONE_BYPASS_TEXT, bypassAllOn, cfg, checkBypassAll, confirm, emit, limits, open, out, overrides, push, runner, runnerFor, runners, setting, st, status, updateStatus, workspace } from './host';
import { addProject, remoteTerms } from './messages';
import { recheck } from './setupflow';


export function activate(context: vscode.ExtensionContext) {
  st.ctx = context;
  st.current = context.workspaceState.get<string>('current');

  status.command = 'justCode.open';
  status.show();

  void context.secrets.get('apiKey').then(k => { st.apiKey = k || undefined; });

  // Runners for workspace folders start with the window, so tasks that were mid-turn continue without opening the board.
  for (const root of workspace()) runnerFor(root);

  st.closeMobile = () => { const m = st.mobile; st.mobile = undefined; void m?.stop(); };

  limits.onChange(push);
  limits.onReset(() => { for (const r of runners.values()) r.afterReset(); });

  // Left side of a review diff: the file at the merge base, straight from git.
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('justcode-base', {
    provideTextDocumentContent: uri => { const p = JSON.parse(uri.query); return g.show(p.dir, p.ref, p.file); },
  }));

  context.subscriptions.push(vscode.window.onDidCloseTerminal(term => {
    const h = remoteTerms.get(term);
    if (!h) return;
    remoteTerms.delete(term);
    void runners.get(h.root)?.remoteEnded(h.id);
  }));
  // A reload loses the terminals' link to their tasks: those tasks come back to the board.
  for (const r of runners.values()) for (const t of r.store.data.tasks) if (t.remote) void r.remoteEnded(t.id);

  context.subscriptions.push(
    vscode.commands.registerCommand('justCode.open', () => open()),
    vscode.commands.registerCommand('justCode.addProject', async () => { open(); await addProject(); }),
    vscode.commands.registerCommand('justCode.setup', () => { open(); emit({ type: 'showSetup' }); void recheck(); }),
    vscode.commands.registerCommand('justCode.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'Anthropic API key (optional)', prompt: 'Tasks use it instead of your Claude login and are billed per token. Remote Control needs a Claude login. Leave empty to remove the key.', password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      if (key.trim()) await context.secrets.store('apiKey', key.trim()); else await context.secrets.delete('apiKey');
      st.apiKey = key.trim() || undefined;
      void recheck();
    }),
    vscode.commands.registerCommand('justCode.phoneLink', async () => {
      if (!setting('phoneServer', false)) { vscode.window.showInformationMessage('Turn on the justCode.phoneServer setting first.'); return; }
      await syncPhone();
      const panel = vscode.window.createWebviewPanel('justCodePhoneLink', 'JustCode: Phone Link', vscode.ViewColumn.Active, { enableScripts: true });
      const render = () => {
        const link = phoneLinkUrl(lanIps()[0] ?? 'this-computer', setting('phoneServerPort', 7878), issuePairingCode(), st.phoneCert?.fingerprint);
        const esc = link.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        panel.webview.html = `<body style="font-family:sans-serif;text-align:center"><h3>Scan with the JustCode Android app</h3><p>One-time link, valid 10 minutes. Same Wi-Fi only.</p><div style="width:320px;margin:auto;background:#fff;padding:8px">${qrSvg(link)}</div><p><code>${esc}</code></p>${st.phoneCert ? `<p>HTTPS, certificate fingerprint (SHA-256):<br><code style="word-break:break-all">${st.phoneCert.fingerprint.match(/../g)!.join(':')}</code></p>` : ''}<script>const vs=acquireVsCodeApi()</script><button onclick="vs.postMessage('new')">New link</button> <button onclick="vs.postMessage('revoke')">Unpair all devices</button></body>`;
      };
      panel.webview.onDidReceiveMessage(async m => {
        if (m === 'new') return render(); // a fresh one-time link; paired devices keep working
        if (m !== 'revoke') return;
        await context.secrets.store('justCode.phoneToken', newToken()); await loadPhoneToken();
        phoneDevices.save([]);
        st.phone?.close(); st.phone = undefined; await syncPhone(); render();
      });
      render();
    }),
    vscode.commands.registerCommand('justCode.exportAudit', async () => {
      const r = runner();
      if (!r) { vscode.window.showInformationMessage('Open a project on the board first.'); return; }
      const file = path.join(r.root, '.justcode', 'reports', `audit-${new Date().toISOString().slice(0, 10)}.csv`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Audit.toCsv(Audit.read(r.root), id => r.store.task(id)?.title));
      void vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
    vscode.commands.registerCommand('justCode.exportSprintReport', async () => {
      const r = runner();
      const sprints = r?.store.data.sprints ?? [];
      if (!r || !sprints.length) { vscode.window.showInformationMessage('No sprint on the board yet.'); return; }
      const pick = sprints.length === 1 ? sprints[0] : (await vscode.window.showQuickPick(sprints.map(sp => ({ label: sp.name, description: sp.goal, sp })), { placeHolder: 'Which sprint?' }))?.sp;
      if (pick) void vscode.window.showTextDocument(vscode.Uri.file(await writeSprintReport(r.root, pick, r.store.data.tasks)));
    }),
    vscode.commands.registerCommand('justCode.showPhonePairing', async () => {
      if (!setting('phoneServer', false)) { vscode.window.showInformationMessage('Turn on the justCode.phoneServer setting first.'); return; }
      await syncPhone();
      const port = setting('phoneServerPort', 7878);
      const code = issuePairingCode();
      vscode.window.showInformationMessage(`Pairing code ${code} (valid 10 minutes, one use). Type it in the JustCode app, or open this link on your phone (same Wi-Fi): ${phoneLinkUrl(lanIps()[0] ?? 'this-computer', port, code, st.phoneCert?.fingerprint)}${st.phoneCert ? `\n\nCertificate fingerprint (SHA-256): ${st.phoneCert.fingerprint.match(/../g)!.join(':')}` : ''}`, { modal: true });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(push),
    vscode.workspace.onDidChangeConfiguration(e => {
      const o = { ...overrides() }; let changed = false;
      for (const k of Object.keys(o)) if (e.affectsConfiguration(`justCode.${k}`) && JSON.stringify(cfg().get(k)) !== JSON.stringify(o[k])) { delete o[k]; changed = true; }
      if (changed) void context.globalState.update('settings', o).then(push);
      if (e.affectsConfiguration('justCode.bypassAll')) { void checkBypassAll().then(() => syncMobile(true)); }
      if (e.affectsConfiguration('justCode.phoneServer') && bypassAllOn() && setting('phoneServer', false)) void confirm(PHONE_BYPASS_TEXT, 'Keep both on').then(async ok => { if (!ok) { await cfg().update('phoneServer', false, vscode.ConfigurationTarget.Global); const o3 = { ...overrides() }; delete o3.phoneServer; await context.globalState.update('settings', o3); void syncPhone(); push(); } });
      if (e.affectsConfiguration('justCode.claudePath')) void recheck();
      if (e.affectsConfiguration('justCode.phoneServer')) void syncPhone();
      if (e.affectsConfiguration('justCode.phoneTls')) { st.phone?.close(); st.phone = undefined; void syncPhone(); }
      if (e.affectsConfiguration('justCode.mobile')) void syncMobile(true);
    }),
    vscode.window.registerWebviewPanelSerializer('justCode.board', { async deserializeWebviewPanel(p) { open(undefined, p); } }),
    { dispose: () => { st.phone?.close(); st.closeMobile?.(); for (const r of runners.values()) r.dispose(); runners.clear(); limits.dispose(); } },
    out, status,
  );
  updateStatus();
  void syncPhone();
  void syncMobile();
  void checkBypassAll();
}

// Every Claude process this window started ends with it.
export function deactivate() {
  st.closeMobile?.();
  for (const r of runners.values()) r.dispose();
  runners.clear();
}
