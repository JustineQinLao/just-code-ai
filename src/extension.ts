import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Store, Task } from './store';
import { Ptys } from './pty';
import { Runner } from './runner';
import * as g from './git';
import { claudeBin, discoverAgents, discoverSkills, plan, sessionLog } from './claude';
import { findTasksFile } from './tasksmd';

// Project has its own Claude agents (.claude/agents/*.md).
const hasSetup = (root: string) => { try { return fs.readdirSync(path.join(root, '.claude', 'agents')).some(f => f.endsWith('.md')); } catch { return false; } };

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
      show(text, ...(taskId ? ['Show'] : [])).then(c => { if (c) { setCurrent(root); open(taskId); } });
    };
    r = new Runner(new Store(root), ptys, path.join(context.globalStorageUri.fsPath, 'runs'), () => claudeBin(cfg().get('claudePath', '')),
      notify, () => cfg().get('maxParallel', 1), () => cfg().get('taskModel', 'sonnet'),
      () => ({ auto: cfg().get('autoReview', true), model: cfg().get('reviewModel', 'opus'), maxAttempts: cfg().get('maxReviews', 3), autoMerge: cfg().get('autoMerge', false), commands: cfg().get<string[]>('reviewCommands', []) }));
    r.onChange(push);
    r.store.onChange(push);
    r.store.watch();
    runners.set(root, r);
    return r;
  };
  // Projects = the window's workspace folders + folders added with "+ Project" (kept across windows).
  const workspace = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  const saved = () => context.globalState.get<string[]>('projects', []);
  const roots = () => [...new Set([...workspace(), ...saved()])].filter(p => fs.existsSync(p));
  const setCurrent = (root: string) => { current = root; void context.globalState.update('current', root); };
  current = context.globalState.get<string>('current');
  const runner = () => {
    if (!current || !roots().includes(current)) current = roots()[0];
    return current ? runnerFor(current) : undefined;
  };

  async function addProject() {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add project' });
    if (!picked?.length) return;
    const paths = picked.map(u => u.fsPath);
    await context.globalState.update('projects', [...new Set([...saved(), ...paths])]);
    setCurrent(paths[0]);
    push();
  }

  // Forgets the project (its files and board stay). Its runs are stopped first.
  async function removeProject(root: string) {
    const r = runners.get(root);
    const live = r ? [...r.state.keys()].length : 0;
    if (!await confirm(`Remove ${path.basename(root)} from JustCode?${live ? ` Its ${live} running task(s) will be stopped.` : ''} Files and the board are kept.`, 'Remove')) return;
    if (r) { for (const id of r.state.keys()) r.stop(id); r.dispose(); runners.delete(root); }
    await context.globalState.update('projects', saved().filter(p => p !== root));
    if (current === root) current = undefined;
    push();
  }

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
    if (!panel || !r) return panel?.webview.postMessage({ type: 'state', empty: true, roots: [] });
    if (panel.visible && !checked.has(r.root)) { checked.add(r.root); void initialize(r, false).catch(e => vscode.window.showErrorMessage(e.message)); }
    const tasks = r.store.data.tasks.map(t => ({
      ...t, run: r.state.get(t.id), ask: r.asks.get(t.id), live: ptys.has(t.id), queued: r.queued().includes(t.id), busy: r.isBusy(t.id),
    }));
    panel.webview.postMessage({
      type: 'state',
      roots: roots().map(p => {
        const states = [...(runners.get(p)?.state.values() ?? [])];
        return { path: p, name: path.basename(p), removable: !workspace().includes(p),
          running: states.filter(x => x === 'running').length, waiting: states.filter(x => x === 'waiting').length };
      }), root: r.root,
      board: { ...r.store.data, tasks },
      setup: hasSetup(r.root),
      agents: discoverAgents(r.root).map(a => ({ name: a.name, description: a.description, scope: a.scope })),
      skills: discoverSkills(r.root),
      git: { repo: await g.isRepo(r.root), remote: await g.hasRemote(r.root).catch(() => false), branch: await g.currentBranch(r.root).catch(() => '') },
      defaultMode: cfg().get('defaultMode', 'default'),
      settings: { plannerModel: cfg().get('plannerModel', 'opus'), taskModel: cfg().get('taskModel', 'sonnet'), maxParallel: cfg().get('maxParallel', 1), defaultMode: cfg().get('defaultMode', 'default'),
        reviewModel: cfg().get('reviewModel', 'opus'), autoReview: cfg().get('autoReview', true), autoMerge: cfg().get('autoMerge', false), maxReviews: cfg().get('maxReviews', 3) },
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
    if (m.type === 'ready') return push();
    if (m.type === 'root') { if (roots().includes(m.root)) setCurrent(m.root); return push(); }
    if (m.type === 'addProject') return addProject();
    if (m.type === 'removeProject') return removeProject(m.root);
    // Every request names the project it came from, so a switch mid-click can't send it to another folder.
    if (m.root && !roots().includes(m.root)) return;
    const r = m.root ? runnerFor(m.root) : runner();
    if (!r) return;
    const s = r.store;
    const t: Task | undefined = m.id ? s.task(m.id) : undefined;
    switch (m.type) {
      case 'addTask': {
        const task = s.addTask({ title: m.title, description: m.description || undefined, sprintId: m.sprintId || undefined, agent: m.agent || undefined, mode: m.mode, where: m.where === 'root' ? 'root' : undefined });
        if (m.images?.length) s.updateTask(task.id, { images: saveImages(r.root, task.id, m.images) });
        break;
      }
      case 'editTask': s.updateTask(m.id, m.patch); break;
      case 'move': s.updateTask(m.id, { status: m.status }); break;
      case 'delete':
        if (await confirm(`Delete "${t?.title}"? Its branch and uncommitted work are removed too.`, 'Delete')) await r.remove(m.id);
        break;
      case 'archive': s.updateTask(m.id, { archived: true }); break;
      case 'clear': {
        const ids: string[] = m.ids.filter((id: string) => s.task(id));
        if (!ids.length) break;
        const work = ids.filter(id => s.task(id)?.branch && s.task(id)?.status !== 'done').length;
        const msg = `Delete all ${ids.length} task(s) in ${m.column}?${work ? ` ${work} of them have a branch; their work is deleted too.` : ''}`;
        if (await confirm(msg, 'Delete all')) for (const id of ids) await r.remove(id);
        break;
      }
      case 'addSprint': s.addSprint(m.name, m.goal || undefined); break;
      case 'activateSprint': s.updateSprint(m.sprintId, { active: true }); break;
      case 'closeSprint':
        if (await confirm('Close this sprint? Unfinished tasks go back to the backlog.', 'Close sprint')) s.closeSprint(m.sprintId);
        break;
      case 'run': await r.run(m.id, undefined, m.size); break;
      case 'runAll': r.runAll(m.ids); break;
      case 'cancelQueue': r.cancelQueue(); break;
      case 'stop': r.stop(m.id); break;
      case 'answer': r.answer(m.id, m.choice); break;
      case 'input': ptys.write(m.id, m.data); break;
      case 'resize': ptys.resize(m.id, m.cols, m.rows); ptys.size = { cols: m.cols, rows: m.rows }; break;
      case 'attach': panel?.webview.postMessage({ type: 'replay', id: m.id, data: await ptys.snapshot(m.id) }); break;
      case 'log': if (t) panel?.webview.postMessage({ type: 'log', id: m.id, steps: t.sessionId ? sessionLog(t.worktree ?? r.root, t.sessionId) : [] }); break;
      case 'claudeCode': return openInClaudeCode(r, t);
      case 'openFolder': if (t?.worktree) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(t.worktree), { forceNewWindow: true }); break;
      case 'changes': panel?.webview.postMessage({ type: 'changes', id: m.id, files: await r.changes(m.id) }); break;
      case 'diff': return diff(t, m.file);
      case 'openFile': if (t?.worktree) vscode.window.showTextDocument(vscode.Uri.file(path.join(t.worktree, m.file))); break;
      case 'merge':
        if (t && await confirm(`Merge "${t.title}" (${t.branch}) into ${t.base}?`, 'Merge')) await r.merge(m.id);
        break;
      case 'resolve': await r.resolveWithClaude(m.id); break;
      case 'review': await r.review(m.id, true); break;
      case 'shots': panel?.webview.postMessage({ type: 'shots', id: m.id, head: m.head, images: (t?.review?.screenshots ?? []).flatMap(f => {
        try { return [{ name: path.basename(f), data: `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}` }]; } catch { return []; }
      }) }); break;
      case 'openShot': if (m.file) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.file)); break;
      case 'sendIssues': if (t?.review?.issues?.length) { s.updateTask(m.id, { status: 'doing' }); await r.say(m.id, `Fix these review issues, then finish your turn:\n${t.review.issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}`); } break;
      case 'resolved': await r.markResolved(m.id); break;
      case 'discard':
        if (await confirm(`Discard all work on "${t?.title}"? Its branch is deleted and the task goes back to To do.`, 'Discard')) await r.discard(m.id);
        break;
      case 'remotePr': await r.remotePr(m.id); break;
      case 'openUrl': vscode.env.openExternal(vscode.Uri.parse(m.url)); break;
      case 'plan': return runPlan(r, m);
      case 'setupClaude': return initialize(r, true);
      case 'settings':
        for (const [k, v] of Object.entries(m.values)) await cfg().update(k, v, vscode.ConfigurationTarget.Global);
        return push();
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

  // A project that isn't set up (no .claude agents, or nothing to put on the board) is initialized the first time
  // its board is shown: /just-code-ai-sync creates the Claude setup and TASKS.md from docs/project.md, then syncs.
  // It runs once per project (the task stays on the board); the button re-runs it on demand.
  const checked = new Set<string>();
  async function initialize(r: Runner, force: boolean) {
    const s = r.store;
    const done = s.data.tasks.some(t => t.init);
    const needed = !hasSetup(r.root) || (!s.data.tasks.length && !findTasksFile(r.root));
    if (!force && (done || !needed)) return;
    const task = s.addTask({ title: '/just-code-ai-sync', description: 'Initialize this project for JustCode: Claude setup and TASKS.md if missing, then sync the board.',
      mode: 'acceptEdits', where: 'root', init: true, allow: ['Write(.claude/**)', 'Edit(.claude/**)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(mkdir:*)'] });
    await r.run(task.id);
    open(task.id);
  }

  const confirm = async (text: string, action: string) => await vscode.window.showWarningMessage(text, { modal: true }, action) === action;

  async function diff(t: Task | undefined, file: string) {
    if (!t?.worktree || !t.base) return;
    const ref = await g.mergeBase(t.worktree, t.base);
    const left = vscode.Uri.from({ scheme: 'justcode-base', path: '/' + file, query: JSON.stringify({ dir: t.worktree, ref, file }) });
    vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(path.join(t.worktree, file)), `${file} (${t.base} ↔ ${t.title})`);
  }

  // The Claude Code extension resumes sessions of the folder it runs in; a task's session lives in its worktree.
  // Continues the task's session in Claude Code. The extension only finds sessions of the folder it runs in, so:
  // project-root tasks open in the Claude Code panel; branch tasks open as a Claude Code tab in the editor, in the
  // task's worktree (resuming there keeps it on the task's branch, never the main folder).
  async function openInClaudeCode(r: Runner, t: Task | undefined) {
    if (!t?.sessionId) return;
    if (ptys.has(t.id)) {
      // Two processes on one session would both write the transcript.
      if (!await confirm(`Stop the run in the card and continue "${t.title}" in Claude Code?`, 'Continue in Claude Code')) return;
      r.stop(t.id);
      await new Promise(res => setTimeout(res, 500)); // let the session file settle
    }
    const cwd = t.worktree && fs.existsSync(t.worktree) ? t.worktree : r.root;
    const inWorkspace = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.fsPath === cwd);
    if (inWorkspace && vscode.extensions.getExtension(CLAUDE_EXT)) {
      await vscode.commands.executeCommand(CLAUDE_OPEN, t.sessionId);
      return;
    }
    const term = vscode.window.createTerminal({ name: `Claude Code · ${t.title.slice(0, 40)}`, cwd, location: vscode.TerminalLocation.Editor });
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    term.sendText([claudeBin(cfg().get('claudePath', '')), '--resume', t.sessionId, ...(t.mode ? ['--permission-mode', t.mode] : [])].map(q).join(' '));
    term.show();
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
    vscode.commands.registerCommand('justCode.addProject', async () => { open(); await addProject(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(push),
    vscode.window.registerWebviewPanelSerializer('justCode.board', {
      async deserializeWebviewPanel(p) { open(undefined, p); },
    }),
    { dispose: () => { for (const r of runners.values()) r.dispose(); ptys.dispose(); } },
  );
  updateStatus();
  installSyncSkill(context);
}

// ~/.claude/skills/just-code-ai-sync: lets Claude sync TASKS.md into the board from any project.
// Rewritten on every activation so it always points at this version's CLI.
export function installSyncSkill(context: vscode.ExtensionContext) {
  const cli = path.join(context.extensionPath, 'out', 'cli.js');
  const file = path.join(os.homedir(), '.claude', 'skills', 'just-code-ai-sync', 'SKILL.md');
  const text = `---
name: just-code-ai-sync
description: Initialize and sync this project's JustCode board. Creates the Claude setup (.claude agents, skills, CLAUDE.md) and TASKS.md when missing, from docs/project.md, then syncs TASKS.md into the board backlog (new tasks, status changes; removed items archived; sprints are left to the user). Use when the user says "sync tasks", "initialize JustCode", "/just-code-ai-sync", or after editing TASKS.md.
---

# Initialize and sync the JustCode board

The board is this project's \`.justcode/board.json\`. Work from the project root. The user ran this to get the
project ready, so do every step below without stopping to ask; never overwrite a file that already exists.
Run each \`node\` command below exactly as written, as its own command (no variables, \`cd\` or \`&&\`): those are pre-approved.

## 1. Claude setup, if \`.claude/agents\` has no .md files

Read docs/project.md (it describes the project), then CLAUDE.md, README and enough code to learn the stack, commands
and conventions. Write these drafts with the Write tool, tailored to this project. They go under \`.justcode/setup/\`
because Claude Code asks before every write into \`.claude/\`; the CLI installs them there:
- \`.justcode/setup/agents/planner.md\`: splits a goal into small tasks that can each be built, reviewed and merged on their own. Frontmatter \`model: opus\`.
- \`.justcode/setup/agents/implementer.md\`: builds one task following the project's conventions and runs its tests or build. Frontmatter \`model: sonnet\`.
- \`.justcode/setup/agents/reviewer.md\`: reviews a diff for bugs, missed edge cases and convention breaks, and tests it: runs the
  project's tests and build, and for UI changes captures screenshots and looks at them (\`node "${cli}" screenshot <file>.png\` when an
  Android device is connected, else \`npx playwright screenshot <url> <file>.png\` for a web UI), then reads the PNG. When asked for a JSON
  verdict it ends with it. Frontmatter \`model: opus\`, \`tools: Read, Grep, Glob, Bash\`.
- \`.justcode/setup/skills/<name>/SKILL.md\` for recurring workflows the project clearly has (tests, release, deploy…). Only ones that apply.

Agent files start with frontmatter: name, description, model, optionally tools. Then install them (existing files in
\`.claude/\` are kept): \`node "${cli}" setup\`

Also write \`CLAUDE.md\` at the project root if missing: stack, how to run, test and build, conventions.

## 2. TASKS.md, if the project has none

Write \`TASKS.md\` at the project root from docs/project.md (else the README, else the code), with a single
\`## Backlog\` heading: what is already built as \`- [x]\`, everything else as \`- [ ]\` in build order. No sprint
headings: the user plans sprints on the board. Each item is one task a developer could build, review and merge on its
own; put details on indented lines under it.

## 3. Sync

\`node "${cli}" sync\`

The open JustCode board updates by itself. Finish with a short summary: what you created, and what the sync added,
moved and archived. Sprints are not created; the user plans them on the board.

Notes: \`--dry-run\` previews without writing; \`--file path/to/TASKS.md\` picks a file. Only tasks that came from
TASKS.md are changed; tasks made on the board are never touched, and a task with an unmerged branch is not marked done.
`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  } catch { /* no home dir access: the board still works */ }
}

// Kills every Claude process this window started, so none outlive it.
export function deactivate() {
  for (const r of runners.values()) r.dispose();
  ptys?.dispose();
}
