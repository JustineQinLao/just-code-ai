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
import { post } from './boardstate';
import { hub } from './phonehost';
import { handle } from './messages';
import { publishArtifact, saveSourceCopies } from './artifact-terminal';
import { recheck } from './setupflow';

// Shared host state and helpers: settings, projects and runners, the board's sinks, the panel, confirms, bypass-all.

// Values that change while the extension runs. One object, so every module reads and writes the live value.
export const st = {
  ctx: undefined as unknown as vscode.ExtensionContext,
  bypassPending: undefined as Promise<boolean> | undefined,   // one bypass-all confirm at a time
  panel: undefined as vscode.WebviewPanel | undefined,
  closeMobile: undefined as (() => void) | undefined,
  apiKey: undefined as string | undefined,
  current: undefined as string | undefined,
  setup: undefined as SetupState | undefined,
  checking: undefined as Promise<void> | undefined,
  pending: undefined as NodeJS.Timeout | undefined,
  watching: undefined as { root: string; id: string; n: number; last?: string } | undefined,   // the task whose log is open
  phone: undefined as http.Server | undefined,
  phoneCert: undefined as PhoneCert | undefined,   // set while the phone server runs with TLS (justCode.phoneTls)
  phoneTok: '',
  mobile: undefined as MobileServer | undefined,
  mobileChain: Promise.resolve() as Promise<void>,
  warnedApiKey: false,
};

export const cfg = () => vscode.workspace.getConfiguration('justCode');

export const overrides = () => st.ctx.globalState.get<Record<string, unknown>>('settings', {});

export const bypassAllRaw = () => { const o = overrides(); return (('bypassAll' in o ? o.bypassAll : cfg().get<boolean>('bypassAll', false))) === true; };

// Counts only once the desktop user has confirmed it, so a value that arrives from a settings file never takes effect on its own.
export const bypassAllOn = () => bypassAllRaw() && st.ctx.globalState.get<boolean>('bypassAllConfirmed', false);

export const setting = <T,>(key: string, fallback: T): T => { if (key === 'defaultMode' && bypassAllOn()) return 'bypassPermissions' as unknown as T; const o = overrides(); return key in o ? o[key] as T : cfg().get<T>(key, fallback); };

export const runners = new Map<string, Runner>(); // project root → runner

export const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k] === '' ? undefined : o[k]]));

export const limits = new Limits();

export const out = vscode.window.createOutputChannel('JustCode');

export const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

export const bin = () => claudeBin(setting('claudePath', ''));

export const savingTerms = new Map<string, vscode.Terminal>(); // source id → its hidden terminal saving a claude.ai copy

export const askingTerms = new Set<string>(); // source ids whose save is probably waiting for your approval

export const env = () => claudeEnv(st.apiKey);

export const commandCache = new Map<string, { at: number; list: { name: string; description: string }[] }>();

export const runnerSettings = (): RunnerSettings => ({
  maxParallel: setting('maxParallel', 1), taskModel: setting('taskModel', 'sonnet'), allowedTools: setting<string[]>('allowedTools', []),
  worktreeCopy: setting<string[]>('worktreeCopy', ['.env', '.env.local']), idleMinutes: setting('idleMinutes', 10),
  taskEffort: setting('taskEffort', 'low'), plannerModel: setting('plannerModel', 'opus'), plannerEffort: setting('plannerEffort', 'low'), subagents: setting('allowSubagents', false),
  bypassAll: bypassAllOn(), personalSetup: setting('personalSetup', false), superpowers: setting('superpowers', true), freshAfterTokens: setting('freshSessionTokens', 120000),
  checks: setting('checks', 'auto'), setup: setting('folderSetup', 'auto'), maxCheckRounds: setting('maxCheckRounds', 3), checkTimeoutMinutes: setting('checkTimeoutMinutes', 10),
  review: { auto: setting('autoReview', true), model: setting('reviewModel', 'sonnet'), effort: setting('reviewEffort', 'medium'), lightModel: setting('reviewLightModel', 'sonnet'), triage: setting('reviewTriage', true), maxAttempts: setting('maxReviews', 3), autoMerge: setting('autoMerge', false), mergeIfCannotRun: setting('mergeIfReviewCannotRun', true),
    commands: setting<string[]>('reviewCommands', []), timeoutMinutes: setting('reviewTimeoutMinutes', 20) },
});

export const recent = new Map<string, number>(); // notification text → when it was last shown (no repeats within a minute)

export const runnerFor = (root: string) => {
  let r = runners.get(root);
  if (r) return r;
  r = new Runner(new Store(root), {
    version: st.ctx.extension.packageJSON.version, bin, env, settings: runnerSettings, limits, cli: path.join(st.ctx.extensionPath, 'out', 'cli.js'),
    notify: (level, text, taskId, toast) => {
      out.appendLine(`${new Date().toLocaleTimeString()} [${path.basename(root)}] ${level}: ${text}`);
      // A toast only for what you can act on (a question, ready to merge, a failure); the rest is in the output log.
      // When the board shows this project, the card already says it: no toast for that task.
      // justCode.notifications: actionable (default), errors, off. VS Code's guidelines: only when necessary, never
      // repeated, always with a way to turn them off.
      const pref = setting<string>('notifications', 'actionable');
      if (pref === 'off' || (pref === 'errors' && level !== 'error')) return;
      if (!toast && level !== 'error') return;
      if (taskId && st.panel?.visible && st.current === root) return;
      const key = `${root}\n${text}`, now = Date.now();
      if ((recent.get(key) ?? 0) > now - 60_000) return;
      recent.set(key, now);
      const show = level === 'error' ? vscode.window.showErrorMessage : level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      const action = taskId ? 'Open task' : level === 'error' ? 'Show log' : undefined;
      const mute = "Don't show again";
      show(text, ...(action ? [action] : []), mute).then(c => {
        if (c === 'Open task') { setCurrent(root); open(taskId); }
        else if (c === 'Show log') out.show(true);
        else if (c === mute) {
          const next = level === 'error' ? 'off' : 'errors';
          void vscode.workspace.getConfiguration('justCode').update('notifications', next, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(next === 'off' ? 'JustCode notifications are off.' : 'JustCode now notifies only on errors.', 'Undo')
            .then(u => { if (u) void vscode.workspace.getConfiguration('justCode').update('notifications', pref, vscode.ConfigurationTarget.Global); });
        }
      });
    },
    choose: async (text, ...buttons) => vscode.window.showWarningMessage(text, { modal: true }, ...buttons),
    publish: id => publishArtifact(root, id),
    saveSources: text => saveSourceCopies(root, text),
  });
  r.onChange(push);
  r.store.onChange(push);
  r.store.watch();
  runners.set(root, r);
  return r;
};

// Projects = the window's folders + folders added with "+ Project" (remembered across windows).
export const workspace = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

export const saved = () => st.ctx.globalState.get<string[]>('projects', []);

export const roots = () => [...new Set([...workspace(), ...saved()])].filter(p => fs.existsSync(p));

export const setCurrent = (root: string) => { st.current = root; void st.ctx.workspaceState.update('current', root); };

export const runner = () => {
  if (!st.current || !roots().includes(st.current)) st.current = roots()[0];
  return st.current ? runnerFor(st.current) : undefined;
};

/* ---------- status bar ---------- */

export function updateStatus() {
  let run = 0, wait = 0;
  for (const r of runners.values()) { const c = r.counts(); run += c.running; wait += c.waiting; }
  const lv = limits.view();
  const pct = Math.max(lv.five?.pct ?? 0, lv.week?.pct ?? 0);
  status.text = `$(checklist) JustCode${run ? ` $(sync~spin) ${run}` : ''}${wait ? ` $(bell-dot) ${wait}` : ''}${lv.held ? ' $(watch) limit' : pct >= 80 ? ` $(watch) ${Math.round(pct)}%` : ''}`;
  status.tooltip = lv.held ? 'Claude usage limit reached: tasks continue after the reset' : wait ? `${wait} task(s) need you` : 'Open the JustCode board';
  status.backgroundColor = wait || lv.held ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

export function push() {
  updateStatus();
  if (st.pending) return;
  st.pending = setTimeout(() => { st.pending = undefined; post(); }, 60);
}

// Everything the board says goes through these sinks: the webview panel, plus any remote client that registers one.
export type Sink = (m: any) => void;
export const sinks = new Set<Sink>();

export const emit = (m: any) => { for (const s of sinks) s(m); };

/* ---------- webview ---------- */

export const open = (focusTask?: string, restored?: vscode.WebviewPanel) => {
  if (st.panel && restored && restored !== st.panel) restored.dispose();
  if (st.panel) st.panel.reveal();
  else {
    const media = vscode.Uri.joinPath(st.ctx.extensionUri, 'media');
    const options = { enableScripts: true, localResourceRoots: [media] };
    st.panel = restored ?? vscode.window.createWebviewPanel('justCode.board', 'JustCode', vscode.ViewColumn.One, { ...options, retainContextWhenHidden: true });
    st.panel.webview.options = options;
    st.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    const w = st.panel.webview, nonce = randomUUID().replace(/-/g, '');
    const u = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
    w.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${u('board.css')}"></head>
<body><div id="app"></div><div id="drawer"></div><dialog id="dlg"></dialog>
${['status.js', 'board.js', 'drawer.js', 'dialogs.js'].map(f => `<script nonce="${nonce}" src="${u(f)}"></script>`).join('')}</body></html>`;
    const sink: Sink = m => void w.postMessage(m);
    sinks.add(sink);
    w.onDidReceiveMessage(m => handle(m).catch(e => vscode.window.showErrorMessage(e.message)));
    st.panel.onDidDispose(() => { sinks.delete(sink); st.panel = undefined; st.watching = undefined; }); // runs keep going; reopening reattaches
    void recheck();
  }
  if (focusTask) emit({ type: 'focus', id: focusTask });
  push();
};

// Remote clients (phone) cannot see VS Code's modal dialogs, so these go over the bridge: the host posts a 'dialog'
// request, board.js shows it in #dlg, and the answer returns as 'dialogReply'. Desktop keeps the native dialogs.
export const confirmFor = (remote: boolean) => async (text: string, action: string) => remote
  ? remoteConfirm(hub, text, action)
  : await vscode.window.showWarningMessage(text, { modal: true }, action) === action;

export const confirm = confirmFor(false);

export const BYPASS_TEXT = 'Bypass permissions: this task runs with NO approvals. It can run any command and change any file it can reach, including outside its folder. Use it only for work you trust.';

export const confirmBypass = () => confirm(BYPASS_TEXT, 'Bypass permissions');

// One confirm when "bypass all" is switched on; a second one when the phone server is also on.
export async function confirmBypassAll() {
  if (!await confirm('Bypass ALL permissions: every task (new, planned and not yet started) will run with NO approvals and can run any command or change any file it can reach. Use it only for work you trust.', 'Bypass all')) return false;
  return true;
}

export const PHONE_BYPASS_TEXT = 'The phone server is on while Bypass all is on, so anyone with the phone token could start tasks that run any command on this computer without approval. Keep both on?';

// Confirms (once at a time) and records the answer; the phone server adds a second confirm.
export function ensureBypassAll(): Promise<boolean> {
  return st.bypassPending ??= (async () => {
    try {
      const ok = await confirmBypassAll() && (!setting('phoneServer', false) || await confirm(PHONE_BYPASS_TEXT, 'Keep both on'));
      await st.ctx.globalState.update('bypassAllConfirmed', ok);
      return ok;
    } finally { st.bypassPending = undefined; }
  })();
}

// Settings-file / Settings-UI changes: ask when it is on but unconfirmed, and switch it off everywhere if declined.
export async function checkBypassAll() {
  if (!bypassAllRaw()) { if (st.ctx.globalState.get('bypassAllConfirmed')) await st.ctx.globalState.update('bypassAllConfirmed', false); return; }
  if (bypassAllOn()) return;
  if (await ensureBypassAll()) return push();
  const o2 = { ...overrides() }; delete o2.bypassAll; await st.ctx.globalState.update('settings', o2);
  for (const t of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]) { try { await cfg().update('bypassAll', false, t); } catch { /* not set at this level */ } }
  push();
}

/* ---------- Remote Control and Claude Code hand-off ---------- */

export const q = (s: string) => process.platform === 'win32' ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
