import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Store, Task } from './store';
import { Ptys } from './pty';
import { Runner } from './runner';
import * as g from './git';
import { claudeBin, discoverAgents, discoverSkills, plan } from './claude';

const cfg = () => vscode.workspace.getConfiguration('justCode');
const CLAUDE_EXT = 'anthropic.claude-code';
const CLAUDE_OPEN = 'claude-vscode.primaryEditor.open'; // (sessionId?, prompt?)

let panel: vscode.WebviewPanel | undefined;
const runners = new Map<string, Runner>(); // project root → runner
let ptys: Ptys;
let current: string | undefined; // root shown on the board

export function activate(context: vscode.ExtensionContext) {
  ptys = new Ptys();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'justCode.open';
  status.show();

  const runnerFor = (root: string) => {
    let r = runners.get(root);
    if (r) return r;
    const notify = (level: 'info' | 'warn' | 'error', text: string, taskId?: string) => {
      const show = level === 'error' ? vscode.window.showErrorMessage : level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      // Approval prompts are only worth a toast when the board isn't on screen.
      if (level === 'warn' && taskId && panel?.visible) return;
      show(text, ...(taskId ? ['Show'] : [])).then(c => c && open(taskId));
    };
    r = new Runner(new Store(root), ptys, path.join(context.globalStorageUri.fsPath, 'runs'), () => claudeBin(cfg().get('claudePath', '')),
      notify, () => cfg().get('maxParallel', 1), () => cfg().get('taskModel', 'sonnet'));
    r.onChange(push);
    r.store.onChange(push);
    runners.set(root, r);
    return r;
  };
  const roots = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  const runner = () => {
    if (!current || !roots().includes(current)) current = roots()[0];
    return current ? runnerFor(current) : undefined;
  };

  function updateStatus() {
    let run = 0, wait = 0;
    for (const r of runners.values()) for (const s of r.state.values()) s === 'waiting' ? wait++ : s === 'running' && run++;
    status.text = `$(checklist) JustCode${run ? ` $(sync~spin) ${run}` : ''}${wait ? ` $(warning) ${wait}` : ''}`;
    status.tooltip = wait ? `${wait} task(s) waiting for your approval` : 'Open the JustCode board';
    status.backgroundColor = wait ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  let pending: NodeJS.Timeout | undefined;
  function push() {
    updateStatus();
    if (pending) return;
    pending = setTimeout(() => { pending = undefined; void post(); }, 50);
  }

  async function post() {
    const r = runner();
    if (!panel || !r) return panel?.webview.postMessage({ type: 'state', empty: true });
    const tasks = r.store.data.tasks.map(t => ({
      ...t, run: r.state.get(t.id), live: ptys.has(t.id), queued: r.queued().includes(t.id), busy: r.isBusy(t.id),
    }));
    panel.webview.postMessage({
      type: 'state',
      roots: roots().map(p => ({ path: p, name: path.basename(p) })), root: r.root,
      board: { ...r.store.data, tasks },
      agents: discoverAgents(r.root).map(a => ({ name: a.name, description: a.description, scope: a.scope })),
      skills: discoverSkills(r.root),
      git: { repo: await g.isRepo(r.root), remote: await g.hasRemote(r.root).catch(() => false), branch: await g.currentBranch(r.root).catch(() => '') },
      defaultMode: cfg().get('defaultMode', 'default'),
      claudeExt: !!vscode.extensions.getExtension(CLAUDE_EXT),
    });
  }

  ptys.onData((id, data) => panel?.webview.postMessage({ type: 'data', id, data }));
  ptys.onExit(id => panel?.webview.postMessage({ type: 'exit', id }));

  // Left side of a review diff: the file at the merge base, read straight from git.
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('justcode-base', {
    provideTextDocumentContent: uri => { const q = JSON.parse(uri.query); return g.show(q.dir, q.ref, q.file); },
  }));

  // restored: a board tab VS Code kept across a reload or extension update. It is rewired here;
  // a tab nobody rewires stays on screen but its clicks go nowhere.
  const open = (focusTask?: string, restored?: vscode.WebviewPanel) => {
    if (panel && restored && restored !== panel) restored.dispose();
    if (panel) { panel.reveal(); }
    else {
      const media = vscode.Uri.joinPath(context.extensionUri, 'media');
      const xterm = vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@xterm');
      const options = { enableScripts: true, localResourceRoots: [media, xterm] };
      panel = restored ?? vscode.window.createWebviewPanel('justCode.board', 'JustCode', vscode.ViewColumn.One, { ...options, retainContextWhenHidden: true });
      panel.webview.options = options;
      const w = panel.webview, nonce = randomUUID().replace(/-/g, '');
      const u = (base: vscode.Uri, ...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(base, ...p));
      w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${u(xterm, 'xterm', 'css', 'xterm.css')}"><link rel="stylesheet" href="${u(media, 'board.css')}"></head>
<body><div id="app"></div><dialog id="dlg"></dialog>
<script nonce="${nonce}" src="${u(xterm, 'xterm', 'lib', 'xterm.js')}"></script>
<script nonce="${nonce}" src="${u(xterm, 'addon-fit', 'lib', 'addon-fit.js')}"></script>
<script nonce="${nonce}" src="${u(media, 'board.js')}"></script></body></html>`;
      w.onDidReceiveMessage(m => handle(m).catch(e => vscode.window.showErrorMessage(e.message)));
      panel.onDidDispose(() => { panel = undefined; }); // runs keep going; reopening the board reattaches
    }
    if (focusTask) panel.webview.postMessage({ type: 'focus', id: focusTask });
    push();
  };

  async function handle(m: any) {
    const r = runner();
    if (m.type === 'ready') return push();
    if (m.type === 'root') { current = m.root; return push(); }
    if (!r) return;
    const s = r.store;
    const t: Task | undefined = m.id ? s.task(m.id) : undefined;
    switch (m.type) {
      case 'addTask': {
        const task = s.addTask({ title: m.title, description: m.description || undefined, sprintId: m.sprintId || undefined, agent: m.agent || undefined, mode: m.mode });
        if (m.images?.length) s.updateTask(task.id, { images: saveImages(r.root, task.id, m.images) });
        break;
      }
      case 'editTask': s.updateTask(m.id, m.patch); break;
      case 'move': s.updateTask(m.id, { status: m.status }); break;
      case 'delete':
        if (await confirm(`Delete "${t?.title}"? Its branch and uncommitted work are removed too.`, 'Delete')) await r.remove(m.id);
        break;
      case 'archive': s.updateTask(m.id, { archived: true }); break;
      case 'addSprint': s.addSprint(m.name, m.goal || undefined); break;
      case 'activateSprint': s.updateSprint(m.sprintId, { active: true }); break;
      case 'closeSprint':
        if (await confirm('Close this sprint? Unfinished tasks go back to the backlog.', 'Close sprint')) s.closeSprint(m.sprintId);
        break;
      case 'run': await r.run(m.id, undefined, m.size); break;
      case 'runAll': r.runAll(m.ids); break;
      case 'cancelQueue': r.cancelQueue(); break;
      case 'stop': r.stop(m.id); break;
      case 'input': ptys.write(m.id, m.data); break;
      case 'resize': ptys.resize(m.id, m.cols, m.rows); break;
      case 'attach': panel?.webview.postMessage({ type: 'replay', id: m.id, data: ptys.buffer(m.id) }); break;
      case 'claudeCode': return openInClaudeCode(r, t);
      case 'openFolder': if (t?.worktree) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(t.worktree), { forceNewWindow: true }); break;
      case 'changes': panel?.webview.postMessage({ type: 'changes', id: m.id, files: await r.changes(m.id) }); break;
      case 'diff': return diff(t, m.file);
      case 'openFile': if (t?.worktree) vscode.window.showTextDocument(vscode.Uri.file(path.join(t.worktree, m.file))); break;
      case 'merge':
        if (t && await confirm(`Merge "${t.title}" (${t.branch}) into ${t.base}?`, 'Merge')) await r.merge(m.id);
        break;
      case 'resolve': await r.resolveWithClaude(m.id); break;
      case 'resolved': await r.markResolved(m.id); break;
      case 'discard':
        if (await confirm(`Discard all work on "${t?.title}"? Its branch is deleted and the task goes back to To do.`, 'Discard')) await r.discard(m.id);
        break;
      case 'remotePr': await r.remotePr(m.id); break;
      case 'openUrl': vscode.env.openExternal(vscode.Uri.parse(m.url)); break;
      case 'plan': return runPlan(r, m);
    }
  }

  // Pasted images go to .justcode/attachments/<task>/ (outside git); the task's prompt points Claude at them.
  function saveImages(root: string, taskId: string, images: { name: string; data: string }[]) {
    const dir = path.join(root, '.justcode', 'attachments', taskId);
    fs.mkdirSync(dir, { recursive: true });
    return images.map((img, i) => {
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(img.data);
      if (!m) throw new Error(`${img.name}: not an image`);
      const file = path.join(dir, `image-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      return file;
    });
  }

  const confirm = async (text: string, action: string) => await vscode.window.showWarningMessage(text, { modal: true }, action) === action;

  async function diff(t: Task | undefined, file: string) {
    if (!t?.worktree || !t.base) return;
    const ref = await g.mergeBase(t.worktree, t.base);
    const left = vscode.Uri.from({ scheme: 'justcode-base', path: '/' + file, query: JSON.stringify({ dir: t.worktree, ref, file }) });
    vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(path.join(t.worktree, file)), `${file} (${t.base} ↔ ${t.title})`);
  }

  // The Claude Code extension resumes sessions of the folder it runs in; a task's session lives in its worktree.
  async function openInClaudeCode(r: Runner, t: Task | undefined) {
    if (!t?.sessionId) return;
    if (!vscode.extensions.getExtension(CLAUDE_EXT)) return vscode.window.showWarningMessage('Install the Claude Code extension to view sessions there.');
    if (ptys.has(t.id)) {
      // Two processes on one session would both write the transcript.
      if (!await confirm(`Stop the run in the card and continue "${t.title}" in Claude Code?`, 'Continue in Claude Code')) return;
      r.stop(t.id);
    }
    await vscode.commands.executeCommand(CLAUDE_OPEN, t.sessionId);
  }

  async function runPlan(r: Runner, m: any) {
    const tasks = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Claude is planning…', cancellable: true },
      (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return plan(claudeBin(cfg().get('claudePath', '')), r.root, m.goal, m.agent || undefined, cfg().get('plannerModel', 'opus'), ac.signal);
      });
    if (!tasks.length) return vscode.window.showWarningMessage('Claude returned no tasks.');
    const picked = await vscode.window.showQuickPick(tasks.map(t => ({ label: t.title, detail: t.description, picked: true, t })),
      { canPickMany: true, title: `Add ${tasks.length} planned tasks`, ignoreFocusOut: true });
    if (!picked?.length) return;
    let sprintId = m.sprintId || undefined;
    if (m.newSprint) sprintId = r.store.addSprint(m.newSprint, m.goal.split('\n')[0].slice(0, 120)).id;
    for (const p of picked) r.store.addTask({ title: p.t.title, description: p.t.description, sprintId, agent: m.taskAgent || undefined, mode: m.mode });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('justCode.open', () => open()),
    vscode.workspace.onDidChangeWorkspaceFolders(push),
    vscode.window.registerWebviewPanelSerializer('justCode.board', {
      async deserializeWebviewPanel(p) { open(undefined, p); },
    }),
    { dispose: () => { for (const r of runners.values()) r.dispose(); ptys.dispose(); } },
  );
  updateStatus();
}

// Kills every Claude process this window started, so none outlive it.
export function deactivate() {
  for (const r of runners.values()) r.dispose();
  ptys?.dispose();
}
