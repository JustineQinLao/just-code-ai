import { mobileMessage, bypassGate, canEnableBypassAll, DialogHub, makePhoneBoard, confirmBypassFor, remoteConfirm, remoteInput, remotePaths, validLink } from './bridge';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Store, Task } from './store';
import { Runner, RunnerSettings } from './runner';
import * as g from './git';
import { artifactUrlIn, claudeBin, claudeEnv, discoverAgents, discoverSkills, sessionLog } from './claude';
import { Limits } from './limits';
import { checkSetup, installCommand, projectSetup, SetupState } from './setup';
import { cliCommand, syncSkill } from './skill';
import * as A from './artifacts';
import * as C from './checks';
import { startPhoneServer, canPhoneMerge, phoneDetail, phoneMoveError, phoneProjectOk, phoneProjects, phoneLinkUrl, qrSvg, issuePairingCode } from './phone';
import type * as http from 'http';
import { startMobileServer, MobileServer } from './server';

const cfg = () => vscode.workspace.getConfiguration('justCode');

// Settings changed on the board are kept by JustCode itself (so saving never depends on VS Code's settings registry,
// which can be out of date right after an update) and also written to VS Code's settings when that works.
let ctx: vscode.ExtensionContext;
let bypassPending: Promise<boolean> | undefined;   // one bypass-all confirm at a time
const overrides = () => ctx.globalState.get<Record<string, unknown>>('settings', {});
const bypassAllRaw = () => { const o = overrides(); return (('bypassAll' in o ? o.bypassAll : cfg().get<boolean>('bypassAll', false))) === true; };
// Counts only once the desktop user has confirmed it, so a value that arrives from a settings file never takes effect on its own.
const bypassAllOn = () => bypassAllRaw() && ctx.globalState.get<boolean>('bypassAllConfirmed', false);
const setting = <T,>(key: string, fallback: T): T => { if (key === 'defaultMode' && bypassAllOn()) return 'bypassPermissions' as unknown as T; const o = overrides(); return key in o ? o[key] as T : cfg().get<T>(key, fallback); };

const runners = new Map<string, Runner>(); // project root → runner
let panel: vscode.WebviewPanel | undefined;
let closeMobile: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  const limits = new Limits();
  const out = vscode.window.createOutputChannel('JustCode');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'justCode.open';
  status.show();
  let apiKey: string | undefined;
  void context.secrets.get('apiKey').then(k => { apiKey = k || undefined; });

  const bin = () => claudeBin(setting('claudePath', ''));
  const env = () => claudeEnv(apiKey);
  const runnerSettings = (): RunnerSettings => ({
    maxParallel: setting('maxParallel', 1), taskModel: setting('taskModel', 'sonnet'), allowedTools: setting<string[]>('allowedTools', []),
    worktreeCopy: setting<string[]>('worktreeCopy', ['.env', '.env.local']), idleMinutes: setting('idleMinutes', 10),
    taskEffort: setting('taskEffort', 'low'), plannerModel: setting('plannerModel', 'opus'), plannerEffort: setting('plannerEffort', 'low'), subagents: setting('allowSubagents', false),
    bypassAll: bypassAllOn(), personalSetup: setting('personalSetup', false), freshAfterTokens: setting('freshSessionTokens', 120000),
    checks: setting('checks', 'auto'), setup: setting('folderSetup', 'auto'), maxCheckRounds: setting('maxCheckRounds', 3), checkTimeoutMinutes: setting('checkTimeoutMinutes', 10),
    review: { auto: setting('autoReview', true), model: setting('reviewModel', 'sonnet'), effort: setting('reviewEffort', 'medium'), lightModel: setting('reviewLightModel', 'sonnet'), triage: setting('reviewTriage', true), maxAttempts: setting('maxReviews', 3), autoMerge: setting('autoMerge', false), mergeIfCannotRun: setting('mergeIfReviewCannotRun', true),
      commands: setting<string[]>('reviewCommands', []), timeoutMinutes: setting('reviewTimeoutMinutes', 20) },
  });

  const recent = new Map<string, number>(); // notification text → when it was last shown (no repeats within a minute)
  const runnerFor = (root: string) => {
    let r = runners.get(root);
    if (r) return r;
    r = new Runner(new Store(root), {
      bin, env, settings: runnerSettings, limits, cli: path.join(context.extensionPath, 'out', 'cli.js'),
      notify: (level, text, taskId, toast) => {
        out.appendLine(`${new Date().toLocaleTimeString()} [${path.basename(root)}] ${level}: ${text}`);
        // A toast only for what you can act on (a question, ready to merge, a failure); the rest is in the output log.
        // When the board shows this project, the card already says it: no toast for that task.
        // justCode.notifications: actionable (default), errors, off. VS Code's guidelines: only when necessary, never
        // repeated, always with a way to turn them off.
        const pref = setting<string>('notifications', 'actionable');
        if (pref === 'off' || (pref === 'errors' && level !== 'error')) return;
        if (!toast && level !== 'error') return;
        if (taskId && panel?.visible && current === root) return;
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
    });
    r.onChange(push);
    r.store.onChange(push);
    r.store.watch();
    runners.set(root, r);
    return r;
  };

  // Projects = the window's folders + folders added with "+ Project" (remembered across windows).
  const workspace = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  const saved = () => context.globalState.get<string[]>('projects', []);
  const roots = () => [...new Set([...workspace(), ...saved()])].filter(p => fs.existsSync(p));
  let current: string | undefined = context.workspaceState.get<string>('current');
  const setCurrent = (root: string) => { current = root; void context.workspaceState.update('current', root); };
  const runner = () => {
    if (!current || !roots().includes(current)) current = roots()[0];
    return current ? runnerFor(current) : undefined;
  };
  // Runners for workspace folders start with the window, so tasks that were mid-turn continue without opening the board.
  for (const root of workspace()) runnerFor(root);

  /* ---------- setup checklist ---------- */

  let setup: SetupState | undefined;
  let checking: Promise<void> | undefined;
  const recheck = () => checking ??= checkSetup(bin(), env(), runner()?.root, !!apiKey)
    .then(s => { setup = s; }).catch(e => out.appendLine(`setup check failed: ${e.message}`)).finally(() => { checking = undefined; push(); });

  async function fix(action: string) {
    const term = (name: string, cmd: string) => {
      const t = vscode.window.createTerminal({ name, env: { CLAUDECODE: null } });
      t.sendText(cmd);
      t.show();
      const sub = vscode.window.onDidCloseTerminal(c => { if (c === t) { sub.dispose(); void recheck(); } });
      vscode.window.showInformationMessage(`${name}: follow the steps in the terminal. The board checks again when you close it.`, 'Check again').then(c => { if (c) void recheck(); });
    };
    switch (action) {
      case 'installClaude': return term('Install Claude Code', installCommand());
      case 'login': return term('Sign in to Claude', `${q(bin() ?? 'claude')} auth login`);
      case 'installGit': return vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'));
      case 'gitIdentity': {
        const name = await vscode.window.showInputBox({ title: 'git: your name', prompt: 'Shown as the author of commits', ignoreFocusOut: true });
        if (!name) return;
        const email = await vscode.window.showInputBox({ title: 'git: your email', prompt: 'Shown with your name on commits', ignoreFocusOut: true });
        if (!email) return;
        await new Promise(res => execFile('git', ['config', '--global', 'user.name', name], res));
        await new Promise(res => execFile('git', ['config', '--global', 'user.email', email], res));
        return recheck();
      }
      case 'gitInit': {
        const r = runner();
        if (!r) return;
        if (await vscode.window.showWarningMessage(`Create a local git repository in ${path.basename(r.root)} and commit its files? Secrets (.env, keys) and node_modules are left out.`, { modal: true }, 'Create') !== 'Create') return;
        await g.ensureRepo(r.root).catch(e => vscode.window.showErrorMessage(e.message));
        return recheck();
      }
      case 'recheck': return recheck();
    }
  }

  /* ---------- status bar ---------- */

  function updateStatus() {
    let run = 0, wait = 0;
    for (const r of runners.values()) { const c = r.counts(); run += c.running; wait += c.waiting; }
    const lv = limits.view();
    const pct = Math.max(lv.five?.pct ?? 0, lv.week?.pct ?? 0);
    status.text = `$(checklist) JustCode${run ? ` $(sync~spin) ${run}` : ''}${wait ? ` $(bell-dot) ${wait}` : ''}${lv.held ? ' $(watch) limit' : pct >= 80 ? ` $(watch) ${Math.round(pct)}%` : ''}`;
    status.tooltip = lv.held ? 'Claude usage limit reached: tasks continue after the reset' : wait ? `${wait} task(s) need you` : 'Open the JustCode board';
    status.backgroundColor = wait || lv.held ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  /* ---------- board state ---------- */

  let pending: NodeJS.Timeout | undefined;
  function push() {
    updateStatus();
    if (pending) return;
    pending = setTimeout(() => { pending = undefined; post(); }, 60);
  }

  // Everything the board says goes through these sinks: the webview panel, plus any remote client that registers one.
  type Sink = (m: any) => void;
  const sinks = new Set<Sink>();
  const emit = (m: any) => { for (const s of sinks) s(m); };

  let watching: { root: string; id: string; n: number; last?: string } | undefined; // the task whose log is open
  function post() {
    if (!sinks.size) return;
    const r = runner();
    if (!r) { emit({ type: 'state', empty: true, roots: [], setup, version: context.extension.packageJSON.version }); return; }
    const tasks = r.store.data.tasks.map(t => ({ ...t, ...r.live(t.id),
      artifacts: { plan: fs.existsSync(A.planFile(r.root, t.id)), brief: fs.existsSync(A.briefFile(r.root, t.id)), handoff: fs.existsSync(A.handoffFile(r.root, t.id)), review: fs.existsSync(A.reviewFile(r.root, t.id)) } }));
    const s = runnerSettings();
    emit({
      type: 'state',
      roots: roots().map(p => ({ path: p, name: path.basename(p), removable: !workspace().includes(p), ...(runners.get(p)?.counts() ?? { running: 0, waiting: 0 }) })),
      root: r.root,
      board: { ...r.store.data, tasks },
      setup, project: projectSetup(r.root),
      limit: limits.view(),
      version: context.extension.packageJSON.version,
      queue: r.queueInfo(),
      agents: discoverAgents(r.root).map(a => ({ name: a.name, description: a.description, scope: a.scope })),
      skills: discoverSkills(r.root, setting('personalSetup', false)),
      sources: A.loadSources(r.root),
      detectedChecks: C.detectChecks(r.root),
      settings: { ...s, notifications: setting('notifications', 'actionable'), defaultMode: setting('defaultMode', 'auto'), bypassAll: bypassAllOn(), plannerModel: setting('plannerModel', 'opus'), apiKey: !!apiKey },
      planner: r.plannerLive(),
      guideSeen: context.globalState.get('guideSeen', false),
      all: [...runners.entries()].filter(([root]) => roots().includes(root)).map(([root, x]) => ({
        root, name: path.basename(root),
        tasks: x.store.data.tasks.filter(t => !t.archived && (x.isOpen(t.id) || x.live(t.id).reviewing || t.status === 'doing' || t.status === 'review'))
          .map(t => ({ id: t.id, title: t.title, status: t.status, ...x.live(t.id), review: t.review })),
      })),
    });
    sendSteps();
  }

  // The open task's activity: live from its session, or from Claude Code's saved transcript once it has closed.
  function sendSteps(force = false) {
    if (!sinks.size || !watching) return;
    const r = runners.get(watching.root), t = r?.store.task(watching.id);
    if (!r || !t) return;
    const live = r.steps(t.id);
    const steps = live ?? (t.sessionId ? sessionLog(t.worktree && fs.existsSync(t.worktree) ? t.worktree : r.root, t.sessionId) : []);
    const last = steps.length ? steps[steps.length - 1].time + steps[steps.length - 1].text.slice(0, 40) : '';
    if (!force && steps.length === watching.n && last === watching.last) return;
    watching.n = steps.length; watching.last = last;
    emit({ type: 'steps', id: t.id, steps, live: !!live });
  }

  /* ---------- phone server (off by default) ---------- */
  let phone: http.Server | undefined;
  let phoneTok = '';
  const newToken = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const phoneToken = () => phoneTok;
  // Token lives in SecretStorage (migrating the old globalState copy once).
  const loadPhoneToken = async () => {
    let t = await context.secrets.get('justCode.phoneToken');
    if (!t) { t = newToken(); await context.secrets.store('justCode.phoneToken', t); }
    phoneTok = t;
    if (context.globalState.get('phoneToken')) void context.globalState.update('phoneToken', undefined);
  };
  const phoneState = () => {
    const r = runner();
    return { projects: phoneProjects(roots()), current, tasks: (r?.store.data.tasks ?? []).filter(t => !t.archived).map(t => {
      const l = r!.live(t.id);
      return { id: t.id, title: t.title, status: t.status, busy: l.busy, asks: l.asks, review: t.review?.state,
        canMerge: canPhoneMerge(t) };
    }) };
  };
  async function phoneAct(m: any): Promise<string | void> {
    const r = runner();
    if (!r) return 'no project open';
    const t = m.id ? r.store.task(m.id) : undefined;
    switch (m.type) {
      case 'addTask': {
        if (!String(m.title ?? '').trim()) return 'title required';
        const task = r.store.addTask({ title: String(m.title).trim(), mode: (setting<string>('defaultMode', 'auto') === 'bypassPermissions' ? 'auto' : setting<string>('defaultMode', 'auto')) as Task['mode'] });
        if (m.start) await r.run(task.id);
        return;
      }
      case 'run': if (!t) return 'no such task'; await r.requestRun(t.id); return;
      case 'stop': if (!t) return 'no such task'; r.stop(t.id); return;
      case 'answer':
        if (m.choice !== 'allow' && m.choice !== 'deny') return 'phone can only allow or deny';
        return r.answer(m.id, { id: m.ask, choice: m.choice }) ? undefined : 'request no longer open';
      case 'project':
        if (!phoneProjectOk(m.root, roots())) return 'unknown project';
        setCurrent(m.root); watching = undefined; void recheck(); push(); return;
      case 'move':
        if (!t) return 'no such task';
        { const l = r.live(t.id); const e = phoneMoveError({ status: t.status, worktree: t.worktree, where: t.where, review: t.review, busy: l.busy, asks: l.asks }, m.status); if (e) return e; }
        if (m.status === 'done') { await r.merge(t.id); return; }
        r.store.updateTask(t.id, { status: m.status }); return;
      case 'merge':
        if (!t || !canPhoneMerge(t)) return 'only tasks that passed review (and are not flagged critical) can be merged from the phone';
        await r.merge(t.id); return;
    }
  }
  // Only a reply to a pending dialog, or a merge of a task that passed review (same rule as /api/act), may come from a phone.
  const hub = new DialogHub();
  const phoneBoard = makePhoneBoard<Task>({ hub, task: id => runner()?.store.task(id), canMerge: canPhoneMerge, merge: id => runner()!.merge(id) });
  async function syncPhone() {
    await loadPhoneToken();
    const on = setting('phoneServer', false);
    if (!on) { phone?.close(); phone = undefined; return; }
    if (phone) return;
    try { phone = await startPhoneServer(setting('phoneServerPort', 7878), { token: phoneToken(), state: phoneState, act: phoneAct, board: phoneBoard, events: n => hub.events(n),
      detail: async id => { const r = runner(), t = r?.store.task(id); if (!t) return { files: [], checks: [], error: 'no such task' };
        return phoneDetail(t, async dir => {
          const base = t.base ?? 'HEAD', stat = new Map<string, [number, number]>();
          const num = await g.git(dir, ['diff', '--numstat', '--no-renames', '-z', `${base}...HEAD`]).catch(() => '');
          for (const l of num.split('\0').filter(Boolean)) { const [a, d, ...f] = l.split('\t'); stat.set(f.join('\t'), [Number(a) || 0, Number(d) || 0]); }
          return (await g.changes(dir, base)).map(c => { const raw = /^".*"$/.test(c.file) ? (() => { try { return JSON.parse(c.file) as string; } catch { return c.file; } })() : c.file, n = stat.get(raw); return { file: raw, status: c.status, added: n?.[0] ?? 0, removed: n?.[1] ?? 0 }; });
        }); }, allowTokenInUrl: false }); }
    catch (e: any) { vscode.window.showErrorMessage(`JustCode phone server could not start: ${e.message}`); }
  }
  let mobile: MobileServer | undefined;
  let mobileChain: Promise<void> = Promise.resolve();
  // Serialized: each run stops any old server (really closed) before deciding whether to start a new one.
  const syncMobile = (restart = false): Promise<void> => mobileChain = mobileChain.then(async () => {
    const on = setting('mobile.enabled', false);
    if (mobile && (restart || !on)) { const m = mobile; mobile = undefined; await m.stop(); }
    if (!on || mobile) return;
    // The server has no token: with Bypass all on, a LAN client could start tasks that run any command, so it never starts then.
    if (bypassAllOn()) { vscode.window.showWarningMessage('JustCode mobile server not started: turn off Bypass all first (it would let anyone on the network run commands on this computer).'); return; }
    const port = setting('mobile.port', 7979);
    try {
      mobile = await startMobileServer(port, {
        media: vscode.Uri.joinPath(context.extensionUri, 'media').fsPath,
        addSink: s => { sinks.add(s); return () => { sinks.delete(s); }; },
        onMessage: async m => { if (!bypassAllOn()) await handle(m, true); },
        onConnect: () => { watching = undefined; push(); },
        hubEvents: n => hub.events(n),
      });
      vscode.window.showInformationMessage(`JustCode board is served on your network: http://${lanIps()[0] ?? 'this-computer'}:${port}/ (no token: turn off justCode.mobile.enabled when done).`);
    } catch (e: any) { mobile = undefined; vscode.window.showErrorMessage(`JustCode mobile server could not start: ${e.message}`); }
  });
  closeMobile = () => { const m = mobile; mobile = undefined; void m?.stop(); };
  const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address);

  limits.onChange(push);
  limits.onReset(() => { for (const r of runners.values()) r.afterReset(); });

  // Left side of a review diff: the file at the merge base, straight from git.
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('justcode-base', {
    provideTextDocumentContent: uri => { const p = JSON.parse(uri.query); return g.show(p.dir, p.ref, p.file); },
  }));

  /* ---------- webview ---------- */

  const open = (focusTask?: string, restored?: vscode.WebviewPanel) => {
    if (panel && restored && restored !== panel) restored.dispose();
    if (panel) panel.reveal();
    else {
      const media = vscode.Uri.joinPath(context.extensionUri, 'media');
      const options = { enableScripts: true, localResourceRoots: [media] };
      panel = restored ?? vscode.window.createWebviewPanel('justCode.board', 'JustCode', vscode.ViewColumn.One, { ...options, retainContextWhenHidden: true });
      panel.webview.options = options;
      panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
      const w = panel.webview, nonce = randomUUID().replace(/-/g, '');
      const u = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
      w.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${u('board.css')}"></head>
<body><div id="app"></div><div id="drawer"></div><dialog id="dlg"></dialog>
<script nonce="${nonce}" src="${u('board.js')}"></script></body></html>`;
      const sink: Sink = m => void w.postMessage(m);
      sinks.add(sink);
      w.onDidReceiveMessage(m => handle(m).catch(e => vscode.window.showErrorMessage(e.message)));
      panel.onDidDispose(() => { sinks.delete(sink); panel = undefined; watching = undefined; }); // runs keep going; reopening reattaches
      void recheck();
    }
    if (focusTask) emit({ type: 'focus', id: focusTask });
    push();
  };

  // Remote clients (phone) cannot see VS Code's modal dialogs, so these go over the bridge: the host posts a 'dialog'
  // request, board.js shows it in #dlg, and the answer returns as 'dialogReply'. Desktop keeps the native dialogs.
  const confirmFor = (remote: boolean) => async (text: string, action: string) => remote
    ? remoteConfirm(hub, text, action)
    : await vscode.window.showWarningMessage(text, { modal: true }, action) === action;
  const confirm = confirmFor(false);
  const BYPASS_TEXT = 'Bypass permissions: this task runs with NO approvals. It can run any command and change any file it can reach, including outside its folder. Use it only for work you trust.';
  const confirmBypass = () => confirm(BYPASS_TEXT, 'Bypass permissions');
  // One confirm when "bypass all" is switched on; a second one when the phone server is also on.
  async function confirmBypassAll() {
    if (!await confirm('Bypass ALL permissions: every task (new, planned and not yet started) will run with NO approvals and can run any command or change any file it can reach. Use it only for work you trust.', 'Bypass all')) return false;
    return true;
  }
  const PHONE_BYPASS_TEXT = 'The phone server is on while Bypass all is on, so anyone with the phone token could start tasks that run any command on this computer without approval. Keep both on?';
  // Confirms (once at a time) and records the answer; the phone server adds a second confirm.
  function ensureBypassAll(): Promise<boolean> {
    return bypassPending ??= (async () => {
      try {
        const ok = await confirmBypassAll() && (!setting('phoneServer', false) || await confirm(PHONE_BYPASS_TEXT, 'Keep both on'));
        await context.globalState.update('bypassAllConfirmed', ok);
        return ok;
      } finally { bypassPending = undefined; }
    })();
  }
  // Settings-file / Settings-UI changes: ask when it is on but unconfirmed, and switch it off everywhere if declined.
  async function checkBypassAll() {
    if (!bypassAllRaw()) { if (context.globalState.get('bypassAllConfirmed')) await context.globalState.update('bypassAllConfirmed', false); return; }
    if (bypassAllOn()) return;
    if (await ensureBypassAll()) return push();
    const o2 = { ...overrides() }; delete o2.bypassAll; await context.globalState.update('settings', o2);
    for (const t of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]) { try { await cfg().update('bypassAll', false, t); } catch { /* not set at this level */ } }
    push();
  }

  // `remote` is set by the phone server only (never read from the message), so a client cannot pick the confirmation path.
  async function handle(m: any, remote = false) {
    if (remote) {
      m = mobileMessage(m); if (!m) return;
      // Agents must be ones the project defines.
      const known = new Set(discoverAgents(runner()?.root ?? '').map(a => a.name));
      if (typeof m.agent !== 'undefined' && !known.has(m.agent)) m = { ...m, agent: undefined };
      if (m.patch && typeof m.patch.agent !== 'undefined' && !known.has(m.patch.agent)) m = { ...m, patch: { ...m.patch, agent: undefined } };
    } // the LAN client has no token: only allowlisted types, safe settings
    const confirm = confirmFor(remote);
    // A remote caller must not approve its own bypass: the answer would come from the same token. Desktop only.
    const confirmBypass = () => confirmBypassFor(remote, () => confirm(BYPASS_TEXT, 'Bypass permissions'));
    const say = (text: string) => remote ? hub.emit({ type: 'toast', text }) : void vscode.window.showInformationMessage(text);
    const input = async (o: vscode.InputBoxOptions & { multiline?: boolean }) => remote ? remoteInput(hub, { ...o, validateInput: v => { const e = o.validateInput?.(v); return typeof e === 'string' ? e : undefined; } }) : vscode.window.showInputBox(o);
    switch (m.type) {
      case 'dialogReply': hub.reply(m); return;
      case 'ready': return push();
      case 'root': if (roots().includes(m.root)) { setCurrent(m.root); watching = undefined; void recheck(); } return push();
      case 'addProject': return addProject();
      case 'removeProject': return removeProject(m.root);
      case 'fix': return fix(m.action);
      case 'guideSeen': await context.globalState.update('guideSeen', true); return;
      case 'openUrl': if (/^https:\/\//.test(m.url)) { if (remote) hub.emit({ type: 'open', url: m.url }); else void vscode.env.openExternal(vscode.Uri.parse(m.url)); } return;
      case 'settings':
        if (m.values && 'bypassAll' in m.values) {
          if (m.values.bypassAll === true && !bypassAllOn() && !await canEnableBypassAll(remote, () => ensureBypassAll())) m = { ...m, values: { ...m.values, bypassAll: false } };
          else if (m.values.bypassAll !== true) await context.globalState.update('bypassAllConfirmed', false);
        }
        const oldMode = setting<string>('defaultMode', 'auto');
        if (m.values?.defaultMode === 'bypassPermissions' && oldMode !== 'bypassPermissions' && !await bypassGate(remote, bypassAllOn(), confirmBypass)) {
          const { defaultMode: _, ...rest } = m.values; m = { ...m, values: rest };
        }
        await context.globalState.update('settings', { ...overrides(), ...m.values });
        // "Permissions for new tasks" also covers the To do tasks that never started and still have the old default:
        // otherwise a task planned a minute ago keeps running in the mode you just switched away from.
        const newMode = setting<string>('defaultMode', 'auto');
        if (newMode !== oldMode) for (const run of runners.values()) for (const t of run.store.data.tasks) {
          if (t.status === 'todo' && !t.sessionId && t.mode === oldMode) run.store.updateTask(t.id, { mode: newMode as Task['mode'] });
        }
        for (const [k, v] of Object.entries(m.values)) {
          try { await cfg().update(k, v, vscode.ConfigurationTarget.Global); } catch { /* not registered in this window: the board's own copy is used */ }
        }
        return push();
      case 'apiKey': return vscode.commands.executeCommand('justCode.setApiKey');
      case 'resumeNow': limits.clear(); return;
    }
    // Every other request names its project, so a switch mid-click can't send it to another folder.
    if (m.root && !roots().includes(m.root)) return;
    const r = m.root ? runnerFor(m.root) : runner();
    if (!r) return;
    const s = r.store;
    const t: Task | undefined = m.id ? s.task(m.id) : undefined;
    switch (m.type) {
      case 'addTask': {
        if (!String(m.title ?? '').trim()) return;
        if (m.mode === 'bypassPermissions' && !await bypassGate(remote, bypassAllOn(), confirmBypass)) return;
        const all = A.loadSources(r.root).map(x => x.id);
        const picked: string[] | undefined = Array.isArray(m.sources) && m.sources.length < all.length ? m.sources.filter((x: string) => all.includes(x)) : undefined;
        const task = s.addTask({ title: m.title.trim(), description: m.description?.trim() || undefined, sprintId: m.sprintId || undefined, agent: m.agent || undefined,
          mode: m.mode || setting('defaultMode', 'auto'), where: m.where === 'root' || m.output === 'artifact' ? 'root' : undefined,
          output: m.output === 'artifact' ? 'artifact' : undefined,
          files: Array.isArray(m.files) && m.files.length ? m.files.map(String) : undefined, sources: picked });
        if (m.images?.length) s.updateTask(task.id, { images: saveImages(r.root, task.id, m.images) });
        if (m.start) await r.run(task.id);
        return;
      }
      case 'editTask':
        if (!t) return;
        if (m.patch?.mode === 'bypassPermissions' && t.mode !== 'bypassPermissions' && !await confirmBypass()) return;
        s.updateTask(m.id, pick(m.patch, ['title', 'description', 'agent', 'mode', 'where', 'sprintId']));
        if (m.patch?.mode && r.isOpen(m.id)) await r.setMode(m.id, m.patch.mode);
        return;
      case 'move': {
        if (!t) return;
        // Done for a task with unmerged work means: merge it.
        if (m.status === 'done' && t.worktree && t.where !== 'root') {
          if (await confirm(`Merge "${t.title}" into ${t.base}?`, 'Merge')) await r.merge(m.id);
          return;
        }
        if (m.status === 'todo' && t.worktree) { vscode.window.showInformationMessage('This task has work on its branch. Use Discard to start it over.'); return; }
        s.updateTask(m.id, { status: m.status });
        return;
      }
      case 'reorder': s.reorder(m.id, m.before); return;
      case 'archive': r.stop(m.id); s.updateTask(m.id, { archived: !t?.archived }); return;
      case 'delete':
        if (t && await confirm(`Delete "${t.title}"?${t.worktree ? ' Its branch and all its work are deleted too.' : ''}`, 'Delete')) await r.remove(m.id);
        return;
      case 'addSprint': s.addSprint(m.name, m.goal || undefined); return;
      case 'activateSprint': s.updateSprint(m.sprintId, { active: true }); return;
      case 'closeSprint':
        if (await confirm('Close this sprint? Unfinished tasks go back to the backlog.', 'Close sprint')) s.closeSprint(m.sprintId);
        return;
      case 'run': await r.requestRun(m.id); return;
      case 'runAll': r.runAll(m.ids); return;
      case 'cancelQueue': r.cancelQueue(); return;
      case 'stop': r.stop(m.id); return;
      case 'interrupt': await r.interrupt(m.id); return;
      case 'say': if (typeof m.text === 'string' && m.text.trim()) await r.say(m.id, m.text.trim()); return;
      case 'answer':
        if (!r.answer(m.id, { id: m.ask, choice: m.choice, message: m.message, answers: m.answers }))
          vscode.window.showWarningMessage('That request is no longer open (Claude moved on or the session closed).');
        return;
      case 'setMode':
        if (m.mode === 'bypassPermissions' && !await bypassGate(remote, bypassAllOn(), confirmBypass)) return push(); // the picker goes back to the mode it has
        await r.setMode(m.id, m.mode); return;
      case 'rules': s.setRules(Array.isArray(m.rules) ? m.rules.map(String) : []); return;
      case 'watch': watching = m.id ? { root: r.root, id: m.id, n: -1 } : undefined; sendSteps(true); return;
      case 'changes': emit({ type: 'changes', id: m.id, files: await r.changes(m.id) }); return;
      case 'diff': return diff(t, m.file);
      case 'openFile': if (t?.worktree) void vscode.window.showTextDocument(vscode.Uri.file(path.join(t.worktree, m.file))); return;
      case 'openFolder': if (t?.worktree) void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(t.worktree), { forceNewWindow: true }); return;
      case 'merge':
        if (t && await confirm(`Merge "${t.title}" (${t.branch}) into ${t.base}?`, 'Merge')) await r.merge(m.id);
        return;
      case 'mergeReady': {
        const ids: string[] = (m.ids ?? []).filter((id: string) => s.task(id)?.review?.state === 'pass' && s.task(id)?.review?.risk !== 'critical');
        if (!ids.length || !await confirm(`Merge ${ids.length} reviewed task(s), one at a time? A task that conflicts stays on its card for you.`, 'Merge all')) return;
        for (const id of ids) await r.merge(id);
        return;
      }
      case 'resolve': await r.resolveWithClaude(m.id); return;
      case 'resolved': await r.markResolved(m.id); return;
      case 'review': await r.review(m.id, true); return;
      case 'cancelReview': r.cancelReview(m.id); return;
      case 'sendIssues': await r.sendIssues(m.id); return;
      case 'sendChecks': await r.sendChecks(m.id); return;
      case 'copy': if (remote) hub.emit({ type: 'copy', text: String(m.text ?? '') }); else { await vscode.env.clipboard.writeText(String(m.text ?? '')); say('Copied.'); } return;
      case 'discard':
        if (t && await confirm(`Discard all work on "${t.title}"? Its branch is deleted and the task goes back to To do.`, 'Discard')) await r.discard(m.id);
        return;
      case 'remotePr': await r.remotePr(m.id); return;
      case 'remote': return handoff(r, t);
      case 'claudeCode': return openInTerminal(r, t, false);
      case 'publishArtifact':
        if (!t) return;
        if (!fs.existsSync(A.artifactFile(r.root, t.id))) { vscode.window.showWarningMessage(`"${t.title}" has no page yet. Message Claude to build it.`); return; }
        return publishArtifact(r.root, t.id);
      case 'shots': emit({ type: 'shots', id: m.id, images: (t?.review?.screenshots ?? []).flatMap(f => {
        try { return [{ name: path.basename(f), data: `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}` }]; } catch { return []; }
      }) }); return;
      case 'planner': r.defaultMode = setting('defaultMode', 'auto'); await r.startPlanner(m.instruction, m.ids ?? [], m.sprint).catch(e => vscode.window.showErrorMessage(e.message)); return;
      case 'plannerAnswer': r.plannerAnswer({ id: m.ask, choice: m.choice, message: m.message, answers: m.answers }); return;
      case 'plannerSay': try { r.plannerSay(m.text); } catch (e: any) { vscode.window.showErrorMessage(e.message); } return;
      case 'stopPlanner': r.stopPlanner(); return;
      case 'applyProposals': r.defaultMode = setting('defaultMode', 'auto'); r.applyProposals(m.changes, m.removes); return;
      case 'pickFiles': {
        const files = await pickPaths(r.root, 'Attach', remote);
        if (files.length) { if (remote) hub.emit({ type: 'picked', files }); else emit({ type: 'picked', files }); }
        return;
      }
      case 'addSource': {
        let add: A.Source[] = [];
        if (m.kind === 'url') {
          const url = await input({ title: 'Add a link as a source', prompt: 'A spec, design, ticket or doc Claude should use as the basis (https://…)', validateInput: v => validLink(v) ? undefined : 'Enter a full http(s) link' });
          if (url && validLink(url)) add = [{ id: randomUUID().slice(0, 8), kind: 'url', ref: url.trim() }];
        } else {
          const picked = await pickPaths(r.root, 'Add as source', remote);
          add = picked.map(f => ({ id: randomUUID().slice(0, 8), kind: fs.statSync(f).isDirectory() ? 'folder' as const : 'file' as const, ref: f }));
        }
        if (!add.length) return;
        const note = await input({ title: 'What is it? (optional)', prompt: 'One line Claude reads before deciding to open it, e.g. "Product spec for v2: roles and permissions"' });
        A.saveSources(r.root, [...A.loadSources(r.root), ...add.map(a => ({ ...a, note: note?.trim() || undefined }))]);
        return push();
      }
      case 'editSource': A.saveSources(r.root, A.loadSources(r.root).map(x => x.id === m.sourceId ? { ...x, note: String(m.note ?? '').trim() || undefined } : x)); return push();
      case 'removeSource': A.saveSources(r.root, A.loadSources(r.root).filter(x => x.id !== m.sourceId)); return push();
      case 'openSource': {
        const src = A.loadSources(r.root).find(x => x.id === m.sourceId);
        if (src?.kind === 'url') void vscode.env.openExternal(vscode.Uri.parse(src.ref));
        else if (src?.kind === 'file') void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(src.ref));
        else if (src) void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(src.ref));
        return;
      }
      case 'openArtifact': {
        const f = { brief: A.briefFile, handoff: A.handoffFile, review: A.reviewFile, plan: A.planFile, checks: A.checksLog,
          setup: (root: string, id: string) => path.join(A.taskDir(root, id), 'setup.log') }[m.which as 'brief' | 'handoff' | 'review' | 'plan' | 'checks' | 'setup']?.(r.root, m.id) ?? (m.which === 'progress' ? A.progressFile(r.root) : undefined);
        if (f && fs.existsSync(f)) void vscode.window.showTextDocument(vscode.Uri.file(f), { preview: true });
        else say('Not written yet.');
        return;
      }
      case 'initialize': return initialize(r);
    }
  }

  // Files for a remote client are typed as paths (relative to the project) in a bridged dialog; only existing paths are kept.
  async function pickPaths(root: string, label: string, remote: boolean): Promise<string[]> {
    if (!remote) return ((await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(root), openLabel: label })) ?? []).map(u => u.fsPath);
    return remotePaths(hub, root, label);
  }

  async function addProject() {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add project' });
    if (!picked?.length) return;
    const paths = picked.map(u => u.fsPath);
    await context.globalState.update('projects', [...new Set([...saved(), ...paths])]);
    setCurrent(paths[0]);
    void recheck();
    push();
  }

  async function removeProject(root: string) {
    const r = runners.get(root);
    const live = r ? r.counts().running + r.counts().waiting : 0;
    if (!await confirm(`Remove ${path.basename(root)} from JustCode?${live ? ` Its ${live} running task(s) are stopped.` : ''} Files and the board are kept.`, 'Remove')) return;
    if (r) { r.dispose(); runners.delete(root); }
    await context.globalState.update('projects', saved().filter(p => p !== root));
    if (current === root) current = undefined;
    push();
  }

  // Pasted images go to .justcode/attachments/<task>/ (outside git); the task's prompt points Claude at them.
  function saveImages(root: string, taskId: string, images: { name: string; data: string }[]) {
    const dir = path.join(root, '.justcode', 'attachments', taskId);
    fs.mkdirSync(dir, { recursive: true });
    return images.slice(0, 8).map((img, i) => {
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(img.data);
      if (!m) throw new Error(`${img.name}: not an image`);
      const file = path.join(dir, `image-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      return file;
    });
  }

  async function diff(t: Task | undefined, file: string) {
    if (!t?.worktree || !t.base) return;
    const ref = await g.mergeBase(t.worktree, t.base);
    const left = vscode.Uri.from({ scheme: 'justcode-base', path: '/' + file, query: JSON.stringify({ dir: t.worktree, ref, file }) });
    void vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(path.join(t.worktree, file)), `${file} (${t.base} ↔ ${t.title})`);
  }

  /* ---------- Remote Control and Claude Code hand-off ---------- */

  const q = (s: string) => process.platform === 'win32' ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
  const remoteTerms = new Map<vscode.Terminal, { root: string; id: string }>();

  // Continue on your phone: the task's session moves to `claude --remote-control`, which shows it in the Claude app and
  // on claude.ai/code. The card waits; closing the terminal brings the task back to the board (committed, then reviewed).
  async function handoff(r: Runner, t: Task | undefined) {
    if (!t) return;
    if (!setup?.remote) {
      const c = await vscode.window.showWarningMessage('Remote Control needs Claude Code signed in with a Claude account (Pro, Max, Team or Enterprise), not an API key.', 'Check setup');
      if (c) open();
      return;
    }
    if (r.isOpen(t.id) && r.live(t.id).run !== 'idle' && !await confirm(`"${t.title}" is working. Move it to Remote Control now? Its current step is stopped and continues there.`, 'Move')) return;
    return openInTerminal(r, t, true);
  }

  async function openInTerminal(r: Runner, t: Task | undefined, remote: boolean) {
    if (!t) return;
    const b = bin();
    if (!b) { vscode.window.showErrorMessage('Claude Code is not installed. Open JustCode: Check Setup.'); return; }
    if (!remote && r.isOpen(t.id) && !await confirm(`Stop the board's run of "${t.title}" and continue it in a terminal?`, 'Continue')) return;
    const h = await r.handoff(t.id);
    const args = [b, '--resume', h.sessionId, '--permission-mode', h.mode, ...(remote ? ['--remote-control', `JustCode: ${t.title.slice(0, 50)}`] : [])];
    const term = vscode.window.createTerminal({ name: `${remote ? '📱 ' : ''}${t.title.slice(0, 40)}`, cwd: h.cwd, env: { CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null, ANTHROPIC_API_KEY: null }, location: vscode.TerminalLocation.Editor });
    remoteTerms.set(term, { root: r.root, id: t.id });
    term.sendText(`${args.map(q).join(' ')}; exit`);
    term.show();
    if (remote) vscode.window.showInformationMessage(`"${t.title}" is now in Remote Control: open the Claude app or claude.ai/code. Press space in the terminal for a QR code. Close the terminal to bring it back to the board.`);
  }

  // An artifact task's page goes to claude.ai through an interactive claude in a terminal: the Agent SDK, which runs
  // the board's sessions, cannot publish artifacts (code.claude.com/docs/en/artifacts#availability). JustCode reads
  // the link from that session's transcript, puts it on the card and closes the terminal. A later change republishes
  // to the same link.
  const publishing = new Map<string, vscode.Terminal>();
  function publishArtifact(root: string, id: string) {
    const r = runners.get(root), t = r?.store.task(id), b = bin();
    if (!r || !t || !b) return;
    const file = A.artifactFile(root, id), key = `${root}\n${id}`;
    if (publishing.has(key)) return;
    if (!setup?.remote) {
      r.store.updateTask(id, { publishing: undefined });
      void vscode.window.showWarningMessage(`"${t.title}": the page is ready, but publishing an artifact needs Claude Code signed in with a Claude account (Pro, Max, Team or Enterprise), not an API key.`, 'Open the page')
        .then(c => { if (c) void vscode.env.openExternal(vscode.Uri.file(file)); });
      return;
    }
    const sid = randomUUID();
    const prompt = t.artifactUrl
      ? `Update the artifact ${t.artifactUrl} with the page in ${file}, published exactly as the file is (do not edit it). Reply with only the link.`
      : `Publish ${file} as an artifact, exactly as the file is (do not edit it). Use its <title> as the title. Reply with only the link.`;
    const term = vscode.window.createTerminal({ name: `⧉ ${t.title.slice(0, 40)}`, cwd: root, env: { CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null, ANTHROPIC_API_KEY: null } });
    publishing.set(key, term);
    term.sendText([b, '--session-id', sid, '--permission-mode', 'auto', prompt].map(q).join(' '));
    term.show(true);
    r.store.updateTask(id, { publishing: true });
    const started = Date.now();
    const done = (url?: string) => {
      clearInterval(timer); sub.dispose(); publishing.delete(key);
      r.store.updateTask(id, { publishing: undefined, ...(url ? { artifactUrl: url } : {}) });
      out.appendLine(`${new Date().toLocaleTimeString()} [${path.basename(root)}] info: ${url ? `Artifact for "${t.title}": ${url}` : `No artifact link for "${t.title}"`}`);
      if (url) {
        term.dispose();
        if (setting<string>('notifications', 'actionable') !== 'off') void vscode.window.showInformationMessage(`Artifact ready: "${t.title}"`, 'Open artifact', 'Copy link')
          .then(c => { if (c === 'Open artifact') void vscode.env.openExternal(vscode.Uri.parse(url)); else if (c === 'Copy link') void vscode.env.clipboard.writeText(url); });
      } else void vscode.window.showWarningMessage(`"${t.title}": publishing did not return a link. See the ⧉ terminal for what happened, or press Publish again on the card.`);
    };
    const timer = setInterval(() => {
      const url = artifactUrlIn(root, sid);
      if (url) done(url); else if (Date.now() - started > 5 * 60_000) done();
    }, 2000);
    const sub = vscode.window.onDidCloseTerminal(c => { if (c === term) done(artifactUrlIn(root, sid)); });
  }

  context.subscriptions.push(vscode.window.onDidCloseTerminal(term => {
    const h = remoteTerms.get(term);
    if (!h) return;
    remoteTerms.delete(term);
    void runners.get(h.root)?.remoteEnded(h.id);
  }));
  // A reload loses the terminals' link to their tasks: those tasks come back to the board.
  for (const r of runners.values()) for (const t of r.store.data.tasks) if (t.remote) void r.remoteEnded(t.id);

  /* ---------- planning and the optional Claude setup ---------- */

  // Optional: Claude drafts agents, skills, CLAUDE.md and TASKS.md for this project, then syncs TASKS.md to the board.
  async function initialize(r: Runner) {
    const running = r.store.data.tasks.find(t => t.init && !t.archived && t.status !== 'done');
    if (running) return open(running.id);
    const file = installSkill();
    if (!file) return;
    const task = r.store.addTask({ title: 'Set up this project for Claude', description: 'Set up this project: Claude reads the code, asks you a few questions on this card, shows the files it will write, and writes them only after you approve. Then it syncs TASKS.md (with sprints) into the board.',
      mode: 'acceptEdits', where: 'root', init: true, allow: ['Write(.justcode/setup/**)', 'Bash(ls:*)', `Bash(${cliCommand(path.join(context.extensionPath, 'out', 'cli.js'))} sync:*)`, `Bash(${cliCommand(path.join(context.extensionPath, 'out', 'cli.js'))} setup:*)`] });
    await r.run(task.id);
    open(task.id);
  }

  // The skill lives in ~/.claude/skills; written only when the user asks for it (Initialize, or the command).
  function installSkill() {
    const file = path.join(os.homedir(), '.claude', 'skills', 'just-code-ai-sync', 'SKILL.md');
    try {
      const text = syncSkill(path.join(context.extensionPath, 'out', 'cli.js'));
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
      return file;
    } catch (e: any) { vscode.window.showErrorMessage(`Could not write ${file}: ${e.message}`); }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('justCode.open', () => open()),
    vscode.commands.registerCommand('justCode.addProject', async () => { open(); await addProject(); }),
    vscode.commands.registerCommand('justCode.setup', () => { open(); emit({ type: 'showSetup' }); void recheck(); }),
    vscode.commands.registerCommand('justCode.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'Anthropic API key (optional)', prompt: 'Tasks use it instead of your Claude login and are billed per token. Remote Control needs a Claude login. Leave empty to remove the key.', password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      if (key.trim()) await context.secrets.store('apiKey', key.trim()); else await context.secrets.delete('apiKey');
      apiKey = key.trim() || undefined;
      void recheck();
    }),
    vscode.commands.registerCommand('justCode.installSyncSkill', () => { const f = installSkill(); if (f) vscode.window.showInformationMessage(`Installed /just-code-ai-sync at ${f}`); }),
    vscode.commands.registerCommand('justCode.phoneLink', async () => {
      if (!setting('phoneServer', false)) { vscode.window.showInformationMessage('Turn on the justCode.phoneServer setting first.'); return; }
      await syncPhone();
      const panel = vscode.window.createWebviewPanel('justCodePhoneLink', 'JustCode: Phone Link', vscode.ViewColumn.Active, { enableScripts: true });
      const render = () => {
        const link = phoneLinkUrl(lanIps()[0] ?? 'this-computer', setting('phoneServerPort', 7878), issuePairingCode());
        const esc = link.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        panel.webview.html = `<body style="font-family:sans-serif;text-align:center"><h3>Scan with the JustCode Android app</h3><p>One-time link, valid 10 minutes. Same Wi-Fi only.</p><div style="width:320px;margin:auto;background:#fff;padding:8px">${qrSvg(link)}</div><p><code>${esc}</code></p><script>const vs=acquireVsCodeApi()</script><button onclick="vs.postMessage('new')">New link</button> <button onclick="vs.postMessage('revoke')">Unpair all devices</button></body>`;
      };
      panel.webview.onDidReceiveMessage(async m => {
        if (m === 'new') return render(); // a fresh one-time link; paired devices keep working
        if (m !== 'revoke') return;
        // Revoke all devices: a new permanent token and a restarted server drop every session.
        await context.secrets.store('justCode.phoneToken', newToken()); await loadPhoneToken();
        phone?.close(); phone = undefined; await syncPhone(); render();
      });
      render();
    }),
    vscode.commands.registerCommand('justCode.showPhonePairing', async () => {
      if (!setting('phoneServer', false)) { vscode.window.showInformationMessage('Turn on the justCode.phoneServer setting first.'); return; }
      await syncPhone();
      const port = setting('phoneServerPort', 7878);
      vscode.window.showInformationMessage(`Open this one-time link on your phone (same Wi-Fi, valid 10 minutes): ${phoneLinkUrl(lanIps()[0] ?? 'this-computer', port, issuePairingCode())}`, { modal: true });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(push),
    // A key changed in VS Code's own Settings UI replaces the board's copy of it.
    vscode.workspace.onDidChangeConfiguration(e => {
      const o = { ...overrides() }; let changed = false;
      for (const k of Object.keys(o)) if (e.affectsConfiguration(`justCode.${k}`) && JSON.stringify(cfg().get(k)) !== JSON.stringify(o[k])) { delete o[k]; changed = true; }
      if (changed) void context.globalState.update('settings', o).then(push);
      if (e.affectsConfiguration('justCode.bypassAll')) { void checkBypassAll().then(() => syncMobile(true)); }
      if (e.affectsConfiguration('justCode.phoneServer') && bypassAllOn() && setting('phoneServer', false)) void confirm(PHONE_BYPASS_TEXT, 'Keep both on').then(async ok => { if (!ok) { await cfg().update('phoneServer', false, vscode.ConfigurationTarget.Global); const o3 = { ...overrides() }; delete o3.phoneServer; await context.globalState.update('settings', o3); void syncPhone(); push(); } });
      if (e.affectsConfiguration('justCode.claudePath')) void recheck();
      if (e.affectsConfiguration('justCode.phoneServer')) void syncPhone();
      if (e.affectsConfiguration('justCode.mobile')) void syncMobile(true);
    }),
    vscode.window.registerWebviewPanelSerializer('justCode.board', { async deserializeWebviewPanel(p) { open(undefined, p); } }),
    { dispose: () => { phone?.close(); closeMobile?.(); for (const r of runners.values()) r.dispose(); runners.clear(); limits.dispose(); } },
    out, status,
  );
  updateStatus();
  void syncPhone();
  void syncMobile();
  void checkBypassAll();
}

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k] === '' ? undefined : o[k]]));

// Every Claude process this window started ends with it.
export function deactivate() {
  closeMobile?.();
  for (const r of runners.values()) r.dispose();
  runners.clear();
}
