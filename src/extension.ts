import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Store, Task } from './store';
import { Runner, RunnerSettings } from './runner';
import * as g from './git';
import { claudeBin, claudeEnv, discoverAgents, discoverSkills, plan, sessionLog } from './claude';
import { Limits } from './limits';
import { checkSetup, installCommand, projectSetup, SetupState } from './setup';
import { syncSkill } from './skill';

const cfg = () => vscode.workspace.getConfiguration('justCode');

// Settings changed on the board are kept by JustCode itself (so saving never depends on VS Code's settings registry,
// which can be out of date right after an update) and also written to VS Code's settings when that works.
let ctx: vscode.ExtensionContext;
const overrides = () => ctx.globalState.get<Record<string, unknown>>('settings', {});
const setting = <T,>(key: string, fallback: T): T => { const o = overrides(); return key in o ? o[key] as T : cfg().get<T>(key, fallback); };

const runners = new Map<string, Runner>(); // project root → runner
let panel: vscode.WebviewPanel | undefined;

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
    review: { auto: setting('autoReview', true), model: setting('reviewModel', 'opus'), maxAttempts: setting('maxReviews', 3), autoMerge: setting('autoMerge', false),
      commands: setting<string[]>('reviewCommands', []), timeoutMinutes: setting('reviewTimeoutMinutes', 20) },
  });

  const runnerFor = (root: string) => {
    let r = runners.get(root);
    if (r) return r;
    r = new Runner(new Store(root), {
      bin, env, settings: runnerSettings, limits, cli: path.join(context.extensionPath, 'out', 'cli.js'),
      notify: (level, text, taskId) => {
        out.appendLine(`${new Date().toLocaleTimeString()} [${path.basename(root)}] ${level}: ${text}`);
        // On screen, the board already shows it; only errors and "needs you" are worth a toast then.
        if (panel?.visible && current === root && level === 'info') return;
        if (panel?.visible && current === root && level === 'warn' && taskId) return;
        const show = level === 'error' ? vscode.window.showErrorMessage : level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        show(text, ...(taskId ? ['Show'] : [])).then(c => { if (c) { setCurrent(root); open(taskId); } });
      },
      choose: async (text, ...buttons) => vscode.window.showWarningMessage(text, { modal: true }, ...buttons),
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

  let watching: { root: string; id: string; n: number; last?: string } | undefined; // the task whose log is open
  function post() {
    if (!panel) return;
    const r = runner();
    if (!r) { void panel.webview.postMessage({ type: 'state', empty: true, roots: [], setup, version: context.extension.packageJSON.version }); return; }
    const tasks = r.store.data.tasks.map(t => ({ ...t, ...r.live(t.id) }));
    const s = runnerSettings();
    void panel.webview.postMessage({
      type: 'state',
      roots: roots().map(p => ({ path: p, name: path.basename(p), removable: !workspace().includes(p), ...(runners.get(p)?.counts() ?? { running: 0, waiting: 0 }) })),
      root: r.root,
      board: { ...r.store.data, tasks },
      setup, project: projectSetup(r.root),
      limit: limits.view(),
      version: context.extension.packageJSON.version,
      queue: r.queueInfo(),
      agents: discoverAgents(r.root).map(a => ({ name: a.name, description: a.description, scope: a.scope })),
      skills: discoverSkills(r.root),
      settings: { ...s, defaultMode: setting('defaultMode', 'auto'), plannerModel: setting('plannerModel', 'opus'), apiKey: !!apiKey },
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
    if (!panel || !watching) return;
    const r = runners.get(watching.root), t = r?.store.task(watching.id);
    if (!r || !t) return;
    const live = r.steps(t.id);
    const steps = live ?? (t.sessionId ? sessionLog(t.worktree && fs.existsSync(t.worktree) ? t.worktree : r.root, t.sessionId) : []);
    const last = steps.length ? steps[steps.length - 1].time + steps[steps.length - 1].text.slice(0, 40) : '';
    if (!force && steps.length === watching.n && last === watching.last) return;
    watching.n = steps.length; watching.last = last;
    void panel.webview.postMessage({ type: 'steps', id: t.id, steps, live: !!live });
  }

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
      w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${u('board.css')}"></head>
<body><div id="app"></div><div id="drawer"></div><dialog id="dlg"></dialog>
<script nonce="${nonce}" src="${u('board.js')}"></script></body></html>`;
      w.onDidReceiveMessage(m => handle(m).catch(e => vscode.window.showErrorMessage(e.message)));
      panel.onDidDispose(() => { panel = undefined; watching = undefined; }); // runs keep going; reopening reattaches
      void recheck();
    }
    if (focusTask) void panel.webview.postMessage({ type: 'focus', id: focusTask });
    push();
  };

  const confirm = async (text: string, action: string) => await vscode.window.showWarningMessage(text, { modal: true }, action) === action;
  const confirmBypass = () => confirm('Allow everything: this task runs with NO approvals. It can run any command and change any file it can reach, including outside its folder. Use it only for work you trust.', 'Allow everything');

  async function handle(m: any) {
    switch (m.type) {
      case 'ready': return push();
      case 'root': if (roots().includes(m.root)) { setCurrent(m.root); watching = undefined; void recheck(); } return push();
      case 'addProject': return addProject();
      case 'removeProject': return removeProject(m.root);
      case 'fix': return fix(m.action);
      case 'guideSeen': await context.globalState.update('guideSeen', true); return;
      case 'openUrl': if (/^https:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url)); return;
      case 'settings':
        await context.globalState.update('settings', { ...overrides(), ...m.values });
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
        if (m.mode === 'bypassPermissions' && !await confirmBypass()) return;
        const task = s.addTask({ title: m.title.trim(), description: m.description?.trim() || undefined, sprintId: m.sprintId || undefined, agent: m.agent || undefined,
          mode: m.mode || setting('defaultMode', 'auto'), where: m.where === 'root' ? 'root' : undefined });
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
      case 'run': await r.run(m.id); return;
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
        if (m.mode === 'bypassPermissions' && !await confirmBypass()) return;
        await r.setMode(m.id, m.mode); return;
      case 'rules': s.setRules(Array.isArray(m.rules) ? m.rules.map(String) : []); return;
      case 'watch': watching = m.id ? { root: r.root, id: m.id, n: -1 } : undefined; sendSteps(true); return;
      case 'changes': void panel?.webview.postMessage({ type: 'changes', id: m.id, files: await r.changes(m.id) }); return;
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
      case 'discard':
        if (t && await confirm(`Discard all work on "${t.title}"? Its branch is deleted and the task goes back to To do.`, 'Discard')) await r.discard(m.id);
        return;
      case 'remotePr': await r.remotePr(m.id); return;
      case 'remote': return handoff(r, t);
      case 'claudeCode': return openInTerminal(r, t, false);
      case 'shots': void panel?.webview.postMessage({ type: 'shots', id: m.id, images: (t?.review?.screenshots ?? []).flatMap(f => {
        try { return [{ name: path.basename(f), data: `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}` }]; } catch { return []; }
      }) }); return;
      case 'plan': return runPlan(r, m);
      case 'initialize': return initialize(r);
    }
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

  context.subscriptions.push(vscode.window.onDidCloseTerminal(term => {
    const h = remoteTerms.get(term);
    if (!h) return;
    remoteTerms.delete(term);
    void runners.get(h.root)?.remoteEnded(h.id);
  }));
  // A reload loses the terminals' link to their tasks: those tasks come back to the board.
  for (const r of runners.values()) for (const t of r.store.data.tasks) if (t.remote) void r.remoteEnded(t.id);

  /* ---------- planning and the optional Claude setup ---------- */

  async function runPlan(r: Runner, m: any) {
    const b = bin();
    if (!b) { vscode.window.showErrorMessage('Claude Code is not installed. Open JustCode: Check Setup.'); return; }
    const tasks = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Claude is reading the code and planning…', cancellable: true },
      (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return plan(m.goal, { bin: b, cwd: r.root, env: env(), model: setting('plannerModel', 'opus') || undefined, agent: m.agent || undefined, signal: ac.signal, timeoutMs: 15 * 60_000, onRate: i => limits.update(i) });
      });
    if (!tasks.length) return vscode.window.showWarningMessage('Claude returned no tasks.');
    const picked = await vscode.window.showQuickPick(tasks.map(t => ({ label: t.title, detail: t.description, picked: true, t })),
      { canPickMany: true, title: `Add ${tasks.length} planned tasks`, ignoreFocusOut: true });
    if (!picked?.length) return;
    let sprintId = m.sprintId || undefined;
    if (m.newSprint) sprintId = r.store.addSprint(m.newSprint, m.goal.split('\n')[0].slice(0, 120)).id;
    for (const p of picked) r.store.addTask({ title: p.t.title, description: p.t.description, sprintId, mode: m.mode || setting('defaultMode', 'auto') });
  }

  // Optional: Claude drafts agents, skills, CLAUDE.md and TASKS.md for this project, then syncs TASKS.md to the board.
  async function initialize(r: Runner) {
    const file = installSkill();
    if (!file) return;
    const task = r.store.addTask({ title: '/just-code-ai-sync', description: 'Set up this project for Claude (agents, skills, CLAUDE.md, TASKS.md) where missing, then sync TASKS.md into the board.',
      mode: 'acceptEdits', where: 'root', init: true, allow: ['Write(.justcode/setup/**)', 'Bash(ls:*)', `Bash(node ${q(path.join(context.extensionPath, 'out', 'cli.js'))} sync:*)`, `Bash(node ${q(path.join(context.extensionPath, 'out', 'cli.js'))} setup:*)`] });
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
    vscode.commands.registerCommand('justCode.setup', () => { open(); void panel?.webview.postMessage({ type: 'showSetup' }); void recheck(); }),
    vscode.commands.registerCommand('justCode.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'Anthropic API key (optional)', prompt: 'Tasks use it instead of your Claude login and are billed per token. Remote Control needs a Claude login. Leave empty to remove the key.', password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      if (key.trim()) await context.secrets.store('apiKey', key.trim()); else await context.secrets.delete('apiKey');
      apiKey = key.trim() || undefined;
      void recheck();
    }),
    vscode.commands.registerCommand('justCode.installSyncSkill', () => { const f = installSkill(); if (f) vscode.window.showInformationMessage(`Installed /just-code-ai-sync at ${f}`); }),
    vscode.workspace.onDidChangeWorkspaceFolders(push),
    // A key changed in VS Code's own Settings UI replaces the board's copy of it.
    vscode.workspace.onDidChangeConfiguration(e => {
      const o = { ...overrides() }; let changed = false;
      for (const k of Object.keys(o)) if (e.affectsConfiguration(`justCode.${k}`) && JSON.stringify(cfg().get(k)) !== JSON.stringify(o[k])) { delete o[k]; changed = true; }
      if (changed) void context.globalState.update('settings', o).then(push);
      if (e.affectsConfiguration('justCode.claudePath')) void recheck();
    }),
    vscode.window.registerWebviewPanelSerializer('justCode.board', { async deserializeWebviewPanel(p) { open(undefined, p); } }),
    { dispose: () => { for (const r of runners.values()) r.dispose(); runners.clear(); limits.dispose(); } },
    out, status,
  );
  updateStatus();
}

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k] === '' ? undefined : o[k]]));

// Every Claude process this window started ends with it.
export function deactivate() {
  for (const r of runners.values()) r.dispose();
  runners.clear();
}
