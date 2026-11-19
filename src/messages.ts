import { mobileMessage, bypassGate, canEnableBypassAll, DialogHub, makePhoneBoard, confirmBypassFor, remoteConfirm, remoteInput, remotePaths, validLink } from './bridge';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Store, Task, resolveWhere, runsApp, resolveOutput, splitTitle } from './store';
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
import { loadPolicy, policyFile, setBudget } from './policy';
import type { Actor } from './audit';
import * as C from './checks';
import * as D from './design';
import { ensureCert, PhoneCert } from './phonecert';
import { Device, DeviceStore, startPhoneServer, canPhoneMerge, phoneDetail, phoneSteps, phoneMoveError, phoneProjectOk, phoneProjects, phoneLinkUrl, qrSvg, issuePairingCode } from './phone';
import type * as http from 'http';
import { startMobileServer, MobileServer } from './server';
import { hub, phoneDevices, lanIps, loadPhoneToken, newToken, syncPhone } from './phonehost';
import { BYPASS_TEXT, bin, bypassAllOn, cfg, commandCache, confirm, confirmFor, emit, ensureBypassAll, env, limits, open, overrides, pick, push, q, roots, runner, runnerFor, runners, saved, savingTerms, setCurrent, setting, st } from './host';
import { fix, recheck } from './setupflow';
import { publishArtifact, saveArtifactSource } from './artifact-terminal';
import { sendSteps } from './boardstate';
import * as App from './app';
import * as Cleanup from './cleanup';
import { sweepStacks } from './docker';

// Messages from the board (desktop or phone) and the actions they start.

// `remote` is set by the phone server only (never read from the message), so a client cannot pick the confirmation path.
export async function handle(m: any, remote = false) {
  const who: Actor = remote ? 'phone' : 'user';
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
    case 'root': if (roots().includes(m.root)) { setCurrent(m.root); st.watching = undefined; void recheck(); } return push();
    case 'addProject': return addProject();
    case 'removeProject': return removeProject(m.root);
    case 'fix': return fix(m.action);
    case 'guideSeen': await st.ctx.globalState.update('guideSeen', true); return;
    case 'openUrl': if (/^https:\/\//.test(m.url) || (!remote && (/^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/.test(m.url) || [...runners.keys()].some(root => App.load(root).links.some(l => l.url === m.url))))) { if (remote) hub.emit({ type: 'open', url: m.url }); else void vscode.env.openExternal(vscode.Uri.parse(m.url)); } return;
    case 'settings':
      if (m.values && 'bypassAll' in m.values) {
        if (m.values.bypassAll === true && !bypassAllOn() && !await canEnableBypassAll(remote, () => ensureBypassAll())) m = { ...m, values: { ...m.values, bypassAll: false } };
        else if (m.values.bypassAll !== true) await st.ctx.globalState.update('bypassAllConfirmed', false);
      }
      const oldMode = setting<string>('defaultMode', 'auto');
      if (m.values?.defaultMode === 'bypassPermissions' && oldMode !== 'bypassPermissions' && !await bypassGate(remote, bypassAllOn(), confirmBypass)) {
        const { defaultMode: _, ...rest } = m.values; m = { ...m, values: rest };
      }
      await st.ctx.globalState.update('settings', { ...overrides(), ...m.values });
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
      const output = resolveOutput(m.output, `${m.title}\n${m.description ?? ''}`);
      const named = splitTitle(String(m.title), m.description);
      // A "run it so I can see it" request with Runs in on Automatic: the project folder, outside the sprint (no branch, no merge).
      const runApp = !m.where && !output && runsApp(`${m.title}\n${m.description ?? ''}`);
      // "Run it so I can see it" is not a task: the App button builds and runs the project folder, without Claude.
      if (runApp && !remote && App.detect(r.root)) { void App.start(r.root); emit({ type: 'openApp' }); return; }
      const task = s.addTask({ title: named.title, description: named.description, sprintId: runApp ? undefined : m.sprintId || undefined, agent: m.agent || undefined,
        mode: m.mode || setting('defaultMode', 'auto'), ...(m.quick ? { quick: true } : {}), where: m.quick ? 'direct' : resolveWhere({ where: m.where, artifact: !!output, setting: setting<string>('defaultWhere', 'auto'), sprintId: m.sprintId, remote, runApp }),
        output,
        files: Array.isArray(m.files) && m.files.length ? m.files.map(String) : undefined, sources: picked });
      A.logPrompt(r.root, { kind: 'task', text: [task.title, task.description].filter(Boolean).join('\n\n'), taskId: task.id, title: task.title });
      r.audit('task.create', task.id, task.title, who);
      if (m.images?.length) s.updateTask(task.id, { images: saveImages(r.root, task.id, m.images) });
      if (m.start) await r.run(task.id);
      return;
    }
    case 'editTask':
      if (!t) return;
      if (m.patch?.mode === 'bypassPermissions' && t.mode !== 'bypassPermissions' && !await confirmBypass()) return;
      s.updateTask(m.id, pick(m.patch, ['title', 'description', 'agent', 'mode', 'where', 'sprintId']));
      if (Array.isArray(m.patch?.dependsOn)) { const ids = m.patch.dependsOn.map(String).filter((d: string) => d !== m.id && s.task(d)); s.updateTask(m.id, { dependsOn: ids.length ? ids : undefined }); }
      if (m.patch?.mode && r.isOpen(m.id)) await r.setMode(m.id, m.patch.mode);
      return;
    case 'move': {
      if (!t) return;
      // Done for a task with unmerged work means: merge it.
      if (m.status === 'done' && t.where === 'direct' && !t.init) { await r.merge(m.id); return; }
      if (m.status === 'done' && t.worktree && t.where !== 'direct') {
        if (await confirm(`Merge "${t.title}" into ${t.base}?`, 'Merge')) await r.merge(m.id);
        return;
      }
      if (m.status === 'todo' && t.worktree) { vscode.window.showInformationMessage('This task has work on its branch. Use Discard to start it over.'); return; }
      s.updateTask(m.id, { status: m.status });
      return;
    }
    case 'reorder': s.reorder(m.id, m.before); return;
    // Clear backlog: archives (never deletes) every backlog task that is not running or in review.
    case 'clearBacklog': {
      const idle = s.data.tasks.filter(t => !t.sprintId && !t.archived && !t.init && !t.worktree && t.status !== 'doing' && t.status !== 'review');
      if (!idle.length) return say('Nothing to clear: the backlog has no idle tasks.');
      if (!await confirm(`Archive ${idle.length} backlog task${idle.length === 1 ? '' : 's'}? Running and in-review ones stay. Archived tasks come back with ⋯ › Show archived tasks.`, 'Clear backlog')) return;
      s.setQueue(s.queue.filter(id => !idle.some(t => t.id === id)));
      for (const t of idle) s.updateTask(t.id, { archived: true });
      return;
    }
    case 'archive': r.stop(m.id); s.updateTask(m.id, { archived: !t?.archived }); return;
    case 'delete':
      if (t && await confirm(`Delete "${t.title}"?${t.worktree ? ' Its branch and all its work are deleted too.' : ''}`, 'Delete')) await r.remove(m.id);
      return;
    case 'addSprint': s.addSprint(m.name, m.goal || undefined); return;
    case 'activateSprint': s.updateSprint(m.sprintId, { active: true }); return;
    case 'deleteSprint': {
      const sp = s.data.sprints.find(x => x.id === m.sprintId);
      if (!sp) return;
      const n = s.data.tasks.filter(t => t.sprintId === sp.id && !t.archived).length;
      if (await confirm(`Delete the sprint "${sp.name}"?${n ? ` Its ${n} task${n === 1 ? '' : 's'} move to the Backlog; no task is deleted.` : ''}`, 'Delete sprint')) s.deleteSprint(sp.id);
      return;
    }
    case 'closeSprint':
      if (await confirm('Close this sprint? Unfinished tasks go back to the backlog.', 'Close sprint')) {
        s.closeSprint(m.sprintId);
        if (!remote) await r.finishSprint(m.sprintId); // merging stays desktop-only
      }
      return;
    case 'mergeSprint': {
      const sp = s.sprint(m.sprintId);
      if (sp?.branch && sp.blockedBy?.length && !remote) await r.askBlocked(sp.id);   // your files are in the way: choose what to do with them
      else if (sp?.branch && await confirm(`Merge ${sp.branch} into ${sp.target}?`, 'Merge sprint')) await r.finishSprint(sp.id);
      return;
    }
    case 'run': r.audit('task.run', m.id, undefined, who); await r.requestRun(m.id); return;
    case 'runAll': {
      r.runAll(m.ids);
      const b = r.userBlocker();
      if (b && await confirm(`Run all waits for "${b.title}", which ${b.why}. Start the queue without waiting for it? It keeps its branch and still waits for you on its card.`, 'Run without it')) r.skipWait(b.id);
      return;
    }
    case 'cancelQueue': r.cancelQueue(); return;
    case 'runNow': r.audit('task.run', m.id, 'run now', who); await r.runNow(m.id); return;
    case 'stop': r.audit('task.stop', m.id, undefined, who); r.stop(m.id); return;
    case 'interrupt': await r.interrupt(m.id); return;
    case 'say':
      if (typeof m.text !== 'string' || !m.text.trim()) return;
      if (t?.chat) s.updateTask(t.id, { chatAt: Date.now(), ...(t.title === 'New chat' || t.title === 'Chat' && !t.sessionId ? { title: m.text.trim().split('\n')[0].slice(0, 70) } : {}) });
      A.logPrompt(r.root, { kind: 'message', text: m.text.trim(), taskId: m.id, title: t?.title });
      r.audit('task.message', m.id, m.text.trim().slice(0, 200), who);
      await r.say(m.id, withImages(m.text.trim(), r.root, m.id, m.images)); return;
    case 'completions': {
      const b = bin(), personal = setting('personalSetup', false), key = `${r.root}|${personal}`;
      const known = commandCache.get(key);
      // Files first: listing skills starts Claude Code (seconds, or stuck), and @ must not wait for that.
      const files = await g.projectFiles(r.root);
      emit({ type: 'completions', files, commands: known?.list ?? [] });
      const commands = known && Date.now() - known.at < 60_000 ? known.list
        : await (b ? slashCommands({ bin: b, cwd: r.root, env: env(), personal, plugins: [pluginDir(r.root)] }) : Promise.reject()).catch(() => discoverSkills(r.root, personal));
      if (commands !== known?.list) commandCache.set(key, { at: Date.now(), list: commands });
      emit({ type: 'completions', files, commands }); return;
    }
    case 'history': emit({ type: 'history', items: r.history() }); return;
    case 'sessionLog': {
      const dir = typeof m.sessionId === 'string' ? r.sessionDir(m.sessionId) : undefined;
      emit({ type: 'sessionLog', sessionId: m.sessionId, steps: dir ? sessionLog(dir, m.sessionId) : [] }); return;
    }
    case 'answer':
      if (!r.answer(m.id, { id: m.ask, choice: m.choice, message: m.message, answers: m.answers, by: who }))
        vscode.window.showWarningMessage('That request is no longer open (Claude moved on or the session closed).');
      return;
    case 'setMode':
      if (m.mode === 'bypassPermissions' && !await bypassGate(remote, bypassAllOn(), confirmBypass)) return push(); // the picker goes back to the mode it has
      r.audit('mode.switch', m.id, `${t?.mode} → ${m.mode}`, who);
      await r.setMode(m.id, m.mode); return;
    case 'rules': s.setRules(Array.isArray(m.rules) ? m.rules.map(String) : []); return;
    case 'watch': st.watching = m.id ? { root: r.root, id: m.id, n: -1 } : undefined; sendSteps(true); return;
    case 'changes': emit({ type: 'changes', id: m.id, files: await r.changes(m.id) }); return;
    // Finished subagents from the saved transcripts (newest session first), and one agent's whole conversation.
    case 'savedAgents': {
      const sessions = t ? [t.sessionId, ...[...(t.pastSessions ?? [])].reverse()].filter((x): x is string => !!x) : [];
      const nodes = sessions.flatMap(sid => { const dir = r.sessionDir(sid, t); return dir ? savedAgents(dir, sid).map(a => ({ ...a, sessionId: sid })) : []; });
      emit({ type: 'savedAgents', id: m.id, nodes }); return;
    }
    case 'agentLog': {
      if (!t || typeof m.sessionId !== 'string') return;
      const dir = r.sessionDir(m.sessionId, t);
      if (m.agent === 'main') { emit({ type: 'agentLog', id: m.id, agent: 'main', steps: dir ? sessionLog(dir, m.sessionId) : [] }); return; }
      const saved = dir ? savedAgents(dir, m.sessionId).find(a => a.id === m.agent || a.toolUseId === m.agent) : undefined;
      emit({ type: 'agentLog', id: m.id, agent: m.agent, ...(saved && dir ? agentLog(dir, m.sessionId, saved.id) ?? {} : { steps: [] }) }); return;
    }
    case 'diff': return diff(t, m.file);
    case 'openFile': return openTaskFile(r, t, m.file);
    case 'openFolder': if (t?.worktree) void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(t.worktree), { forceNewWindow: true }); return;
    case 'merge':
      if (t && t.where === 'direct' && !t.init) { if (!t.directFiles?.length || await confirm(`Finish "${t.title}"? Its ${t.directFiles?.length ?? 0} file(s) are committed on the current branch.`, 'Finish')) await r.merge(m.id, false, who); return; }
      if (t && await confirm(`Merge "${t.title}" (${t.branch}) into ${t.base}?`, 'Merge')) await r.merge(m.id, false, who);
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
    case 'sendIssues': await r.sendIssues(m.id, typeof m.key === 'string' ? m.key : undefined); return;
    case 'moreRound': await r.moreRound(m.id); return;
    case 'acceptIssues': {
      if (!t?.review?.issues?.length) return;
      const keys: string[] | 'all' = Array.isArray(m.keys) ? m.keys.map(String) : 'all';
      if (m.merge) {
        const open = t.review.issues.filter(i => !i.accepted);
        const verb = t.where === 'direct' && !t.init ? 'finish' : 'merge';
        if (!await confirm(`Accept ${open.length} review issue(s) and ${verb} "${t.title}"?\n\n${open.map(i => `• ${i.text}`).join('\n')}`, verb === 'merge' ? 'Accept and merge' : 'Accept and finish')) return;
      }
      await r.acceptIssues(m.id, keys, !!m.merge, who);
      return;
    }
    case 'sendChecks': await r.sendChecks(m.id); return;
    case 'copy': if (remote) hub.emit({ type: 'copy', text: String(m.text ?? '') }); else { await vscode.env.clipboard.writeText(String(m.text ?? '')); say('Copied.'); } return;
    case 'discard':
      if (t && t.where === 'direct' && !t.init) {
        const fl = t.directFiles ?? [];
        if (await confirm(`Discard "${t.title}"? These files are reverted (new ones deleted):\n${fl.join('\n') || '(none)'}`, 'Discard')) await r.discard(m.id, who);
        return;
      }
      if (t && await confirm(`Discard all work on "${t.title}"? Its branch is deleted and the task goes back to To do.`, 'Discard')) await r.discard(m.id, who);
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
    case 'planner': r.defaultMode = setting('defaultMode', 'auto'); await r.startPlanner(withImages(m.instruction, r.root, 'plan', m.images), m.ids ?? [], m.sprint, typeof m.into === 'string' ? m.into : undefined).catch(e => vscode.window.showErrorMessage(e.message)); return;
    case 'plannerAnswer': r.plannerAnswer({ id: m.ask, choice: m.choice, message: m.message, answers: m.answers }); return;
    case 'plannerSay': try { await r.plannerSay(withImages(m.text, r.root, 'plan', m.images)); } catch (e: any) { vscode.window.showErrorMessage(e.message); } return;
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
        if (url && validLink(url)) {
          const same = A.loadSources(r.root).find(x => x.kind === 'url' && A.artifactKey(x.ref) === A.artifactKey(url));
          if (same) {
            const sp = s.data.sprints.find(x => x.id === m.sprintId);
            if (sp?.sources && !sp.sources.includes(same.id)) s.updateSprint(sp.id, { sources: [...sp.sources, same.id] });
            say(`That link is already a source${same.note ? ` ("${same.note}")` : ''}${sp?.sources ? ', now used in this sprint' : ''}.`);
            return push();
          }
          add = [{ id: randomUUID().slice(0, 8), kind: 'url', ref: url.trim() }];
        }
      } else {
        const picked = await pickPaths(r.root, 'Add as source', remote);
        add = picked.map(f => ({ id: randomUUID().slice(0, 8), kind: fs.statSync(f).isDirectory() ? 'folder' as const : 'file' as const, ref: f }));
      }
      if (!add.length) return;
      const note = await input({ title: 'What is it? (optional)', prompt: 'One line Claude reads before deciding to open it, e.g. "Product spec for v2: roles and permissions"' });
      A.saveSources(r.root, [...A.loadSources(r.root), ...add.map(a => ({ ...a, note: note?.trim() || undefined }))]);
      for (const a of add) if (a.kind === 'url' && A.isArtifactLink(a.ref)) A.markRemoved(r.root, a.ref, false);   // added by hand: wanted again
      // Added while viewing a sprint: that sprint uses it.
      const sp = s.data.sprints.find(x => x.id === m.sprintId);
      if (sp?.sources) s.updateSprint(sp.id, { sources: [...sp.sources, ...add.map(a => a.id)] });
      for (const a of add) if (a.kind === 'url' && A.isArtifactLink(a.ref)) void saveArtifactSource(r.root, a);
      return push();
    }
    case 'designFromProject': return designFromProject(r);
    case 'fixDesign': return fixDesign(r, m.source);
    case 'openJustcodeFile': {
      const f = path.join(r.root, '.justcode', ...String(m.file).split('/').filter(x => x && x !== '..'));
      if (fs.existsSync(f)) void vscode.window.showTextDocument(vscode.Uri.file(f)); else say('Not written yet.');
      return;
    }
    case 'designArtifact': {
      // The design as a page: an artifact task, so it is published, listed under ⧉ Artifacts, and a later run updates
      // the same link (its title names the page an earlier run published).
      const task = s.addTask({ title: 'Design system page', description: `A page that shows ${path.join(r.root, '.justcode', 'design', 'DESIGN.md')}: the palette as swatches (light and dark), the type scale, spacing, radius and shadows, and the main components in their states. Use only what DESIGN.md says.`,
        mode: setting('defaultMode', 'auto'), output: 'artifact', where: resolveWhere({ artifact: true, setting: setting<string>('defaultWhere', 'auto'), remote }) });
      r.audit('task.create', task.id, task.title, who);
      await r.run(task.id);
      return open(task.id);
    }
    case 'designPick': {
      try {
        const list = await D.listDesigns();
        const items: (vscode.QuickPickItem & { own?: boolean })[] = [{ label: '$(file) Use my own file…', own: true }, ...list.map(d => ({ label: d.name }))];
        const pick = await vscode.window.showQuickPick(items, { title: 'Pick a design (VoltAgent/awesome-design-md)', matchOnDescription: true });
        if (!pick) return;
        if (pick.own) {
          const f = (await pickPaths(r.root, 'Use as DESIGN.md', remote))[0];
          if (!f) return;
          D.installDesign(r.root, fs.readFileSync(f, 'utf8'), { source: 'file', url: f });
        } else D.installDesign(r.root, await D.fetchDesign(pick.label), { source: 'awesome-design-md', name: pick.label, url: D.rawUrl(pick.label) });
        say('DESIGN.md saved. UI and artifact tasks will follow it.');
      } catch (e: any) { void vscode.window.showErrorMessage(`Could not load designs: ${e.message}`); }
      return push();
    }
    case 'designRemove':
      if (await confirm('Remove .justcode/design/DESIGN.md?', 'Remove')) D.removeDesign(r.root);
      return push();
    case 'showSaveTerminal': (m.sourceId ? savingTerms.get(m.sourceId) : [...savingTerms.values()][0])?.show(); return;
    case 'saveSourceCopy': {
      const src = A.loadSources(r.root).find(x => x.id === m.sourceId);
      if (src) void saveArtifactSource(r.root, src).then(() => push());
      return;
    }
    case 'phonePairing': {
      if (remote) return;
      // The code is for this panel only: never through emit(), which also streams to LAN clients of the mobile server.
      const toPanel = (p: object) => void st.panel?.webview.postMessage({ type: 'pairing', ...p });
      if (!setting('phoneServer', false)) { toPanel({ on: false }); return; }
      await syncPhone();
      const port = setting<number>('phoneServerPort', 7878), ip = lanIps()[0] ?? 'this-computer', code = issuePairingCode();
      const link = phoneLinkUrl(ip, port, code, st.phoneCert?.fingerprint);
      toPanel({ on: true, qr: qrSvg(link), code, url: `${st.phoneCert ? 'https' : 'http'}://${ip}:${port}`, fingerprint: st.phoneCert ? st.phoneCert.fingerprint.match(/../g)!.join(':') : '' });
      return;
    }
    case 'phoneUnpair':
      if (remote) return;
      if (!await confirm('Unpair all phones? Every paired device is signed out and the phone token changes. They pair again with a new code.', 'Unpair all')) return;
      await st.ctx.secrets.store('justCode.phoneToken', newToken()); await loadPhoneToken();
      phoneDevices.save([]);
      st.phone?.close(); st.phone = undefined; await syncPhone();
      r.audit('phone.action', undefined, 'unpaired all devices', 'user');
      push();
      return;
    case 'phoneRevoke': phoneDevices.save(phoneDevices.list().filter(d => m.id !== 'all' && d.id !== m.id)); r.audit('phone.action', undefined, `revoked ${m.id === 'all' ? 'all devices' : `device …${m.id}`}`, 'user'); return;
    case 'sprintReport': {
      const sp = s.sprint(m.sprintId);
      if (sp) void vscode.window.showTextDocument(vscode.Uri.file(await writeSprintReport(r.root, sp, s.data.tasks)));
      return;
    }
    case 'setBudget': {
      const was = loadPolicy(r.root).policy.maxCostUsd[m.key as 'task'];
      setBudget(r.root, m.key, Number(m.usd));
      r.audit('policy.change', undefined, `maxCostUsd.${m.key}: ${was} → ${Number(m.usd)}`, who);
      // Every task the old budget stopped and the new one covers carries on (To do ones go back in the queue).
      const wasStopped = t && /^Budget reached/.test(t.error ?? '') && t.status !== 'todo';
      r.budgetRaised();
      push();
      // "Raise and resume" on a started task the budget stopped: it continues under the new budget.
      if (wasStopped) await r.say(m.id, 'Continue the task.');
      return;
    }
    case 'openChat': case 'newChat': {
      // 💬 Chat: conversations in the project folder, off the board. Open goes back to the latest; New starts another
      // (an unused empty one is reused). Every chat stays in the panel's 🕘 history until you delete it.
      if (remote) return;
      const chats = s.data.tasks.filter(x => x.chat && !x.archived).sort((a, b) => (b.chatAt ?? b.created ?? 0) - (a.chatAt ?? a.created ?? 0));
      if (m.type === 'openChat' && chats[0]) { emit({ type: 'focus', id: chats[0].id }); return; }
      const empty = chats.find(x => !x.sessionId);
      if (empty) { emit({ type: 'focus', id: empty.id }); return; }
      const mode = setting<string>('defaultMode', 'auto');
      const chat = s.addTask({ title: 'New chat', chat: true, chatAt: Date.now(), where: 'direct', status: 'review', mode: (mode === 'plan' ? 'default' : mode) as any });
      emit({ type: 'focus', id: chat.id });
      return;
    }
    case 'deleteChat': if (!remote && t?.chat) { await r.remove(t.id); } return;
    case 'cleanupScan': emit({ type: 'cleanup', items: Cleanup.scan(r.root, s.data.tasks) }); return;
    case 'cleanupRun': {
      // 🧹 The kinds you ticked. Task copies and archived tasks go through the runner (worktree, branch, Docker stack, board).
      if (remote) return;
      const kinds: string[] = Array.isArray(m.kinds) ? m.kinds.map(String) : [];
      const items = Cleanup.scan(r.root, s.data.tasks).filter(i => kinds.includes(i.kind));
      const before = items.reduce((n, i) => n + i.bytes, 0);
      Cleanup.removeFiles(items);
      for (const it of items) {
        if (it.kind === 'worktrees') for (const p of it.paths) await g.removeWorktree(r.root, p).catch(e => r.d.notify('warn', `Could not remove ${path.basename(p)}: ${e.message}`));
        if (it.kind === 'archived') for (const id of it.ids ?? []) await r.remove(id);
      }
      const live = s.data.tasks.filter(x => x.worktree && x.status !== 'done' && !x.archived).map(x => x.worktree!);
      const stacks = await sweepStacks(r.root, live).catch(() => [] as string[]);
      r.audit('cleanup', undefined, `${kinds.join(', ')}: ${Cleanup.human(before)}${stacks.length ? `, ${stacks.length} Docker stack(s)` : ''}`, who);
      emit({ type: 'cleanup', items: Cleanup.scan(r.root, s.data.tasks), freed: before, stacks: stacks.length });
      return push();
    }
    case 'appStart': if (!remote) { void App.start(r.root, 'you', ['build', 'start', 'restart'].includes(m.mode) ? m.mode : 'build'); appTerminal(r.root, false); } return;
    case 'appCheck': if (!remote) void App.check(r.root); return;
    case 'appTerminal': if (!remote) appTerminal(r.root, true); return;
    case 'appStop': if (!remote) await App.stop(r.root); return;
    case 'appLog': if (!remote) void vscode.window.showTextDocument(vscode.Uri.file(App.logFile(r.root))); return;
    case 'appFix': {
      // The app would not come up: a ⚡ task in the project folder, with what JustCode tried and the log.
      if (remote) return;
      const a = App.view(r.root);
      const task = s.addTask({ title: 'Get the app running', where: 'direct', quick: true, appFix: true, mode: setting('defaultMode', 'auto'),
        description: `JustCode could not run this project's app from the project folder${a.kind ? ` (detected: ${a.kind})` : ''}: ${a.error ?? 'it did not answer'}.\n\n` +
          `Last lines of .justcode/app.log:\n\`\`\`\n${a.log.slice(-2500)}\n\`\`\`\n\nFix the environment or setup so it builds and starts (prefer config such as .env, a missing dependency ` +
          'or a stale container over code changes). Do not wait for it in long loops and do not check its URLs yourself: when you finish your turn, ' +
          'JustCode rebuilds it and checks every link (nginx server names and .env URLs included), and shows the result in ▶ App. Reply short: what was wrong and what you changed.' });
      r.audit('task.create', task.id, task.title, who);
      await r.run(task.id);
      return;
    }
    case 'openPolicy': loadPolicy(r.root); void vscode.window.showTextDocument(vscode.Uri.file(policyFile(r.root))); return;
    case 'exportAudit': void vscode.commands.executeCommand('justCode.exportAudit'); return;
    case 'artifactNote': { const e = R.find(r.root, String(m.url)); if (e) R.upsert(r.root, e.url, { note: String(m.note ?? '').trim() || undefined }); return push(); }
    // Off the Artifacts list for good: its source (and saved copy) go too, and prompts that mention it no longer add it back.
    case 'removeArtifact': {
      const e = R.find(r.root, String(m.url));
      if (!e || remote) return;
      if (!await confirm(`Remove ${e.title || e.url} from this project's artifacts?${e.kind === 'output' ? ' The page stays on claude.ai.' : ''} Briefs stop listing it, its source and saved copy are deleted, and prompts that mention the link no longer add it back.`, 'Remove')) return;
      for (const src of A.loadSources(r.root).filter(x => x.kind === 'url' && A.artifactKey(x.ref) === e.url)) {
        savingTerms.get(src.id)?.dispose();
        fs.rmSync(A.sourceCopy(r.root, src.id), { recursive: true, force: true });
        for (const sp of s.data.sprints) if (sp.sources?.includes(src.id)) s.updateSprint(sp.id, { sources: sp.sources.filter(id => id !== src.id) });
      }
      A.saveSources(r.root, A.loadSources(r.root).filter(x => !(x.kind === 'url' && A.artifactKey(x.ref) === e.url)));
      A.markRemoved(r.root, e.url, true);
      R.remove(r.root, e.url);
      return push();
    }
    case 'useArtifact': {
      // A registry artifact becomes a project source (once), used by the current sprint when it picks its sources.
      const e = R.find(r.root, String(m.url));
      if (!e) return;
      let src = A.loadSources(r.root).find(x => x.kind === 'url' && A.artifactKey(x.ref) === e.url);
      if (!src) { src = { id: randomUUID().slice(0, 8), kind: 'url', ref: e.url, note: e.title ?? (e.kind === 'output' ? 'claude.ai artifact a task published' : undefined) }; A.saveSources(r.root, [...A.loadSources(r.root), src]); }
      const sp = s.data.sprints.find(x => x.id === m.sprintId);
      if (sp?.sources && !sp.sources.includes(src.id)) s.updateSprint(sp.id, { sources: [...sp.sources, src.id] });
      emit({ type: 'usedSource', sourceId: src.id });
      if (!A.hasCopy(r.root, src)) void saveArtifactSource(r.root, src).then(() => push());
      return push();
    }
    case 'refreshArtifact': {
      const e = R.find(r.root, String(m.url));
      const src = e && A.loadSources(r.root).find(x => x.kind === 'url' && A.artifactKey(x.ref) === e.url);
      if (src) void saveArtifactSource(r.root, src).then(() => push());
      else if (e) say('Use it as a source first: only sources keep a saved copy.');
      return;
    }
    case 'editSource': A.saveSources(r.root, A.loadSources(r.root).map(x => x.id === m.sourceId ? { ...x, note: String(m.note ?? '').trim() || undefined } : x)); return push();
    case 'sprintSource': {
      const sp = s.data.sprints.find(x => x.id === m.sprintId);
      if (!sp) return;
      const cur = sp.sources ?? A.loadSources(r.root).map(x => x.id);
      s.updateSprint(sp.id, { sources: m.on ? [...new Set([...cur, m.sourceId])] : cur.filter(id => id !== m.sourceId) });
      return push();
    }
    // Deleting takes a source out of the whole project, so it asks first and names the sprints that use it.
    case 'removeSource': {
      const src = A.loadSources(r.root).find(x => x.id === m.sourceId);
      if (!src) return;
      const users = s.data.sprints.filter(x => !x.closed && (!x.sources || x.sources.includes(src.id))).map(x => x.name);
      const label = src.kind === 'url' ? src.ref : path.basename(src.ref);
      const art = src.kind === 'url' && A.isArtifactLink(src.ref);
      if (!await confirm(`Delete "${label}" from the project?${users.length ? ` Used in: ${users.join(', ')}.` : ''}${art ? ' Its saved copy goes too, and prompts that mention the link no longer add it back (add it again under 📎 Sources if you need it).' : ''} To stop using it in one sprint only, use Remove from sprint instead.`, 'Delete')) return;
      savingTerms.get(src.id)?.dispose();   // a save still running stops
      A.saveSources(r.root, A.loadSources(r.root).filter(x => x.id !== src.id));
      if (art) { A.markRemoved(r.root, src.ref, true); R.remove(r.root, src.ref); fs.rmSync(A.sourceCopy(r.root, src.id), { recursive: true, force: true }); }
      for (const sp of s.data.sprints) if (sp.sources?.includes(src.id)) s.updateSprint(sp.id, { sources: sp.sources.filter(id => id !== src.id) });
      return push();
    }
    case 'openSource': {
      const src = A.loadSources(r.root).find(x => x.id === m.sourceId);
      if (src?.kind === 'url') void vscode.env.openExternal(vscode.Uri.parse(src.ref));
      else if (src?.kind === 'file') void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(src.ref));
      else if (src) void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(src.ref));
      return;
    }
    case 'openArtifact': {
      const f = { brief: A.briefFile, handoff: A.handoffFile, review: A.reviewFile, plan: A.planFile, checks: A.checksLog, transcript: A.transcriptFile,
        setup: (root: string, id: string) => path.join(A.taskDir(root, id), 'setup.log') }[m.which as 'brief' | 'handoff' | 'review' | 'plan' | 'checks' | 'setup' | 'transcript']?.(r.root, m.id) ?? (m.which === 'progress' ? A.progressFile(r.root) : undefined);
      if (f && fs.existsSync(f)) void vscode.window.showTextDocument(vscode.Uri.file(f), { preview: true });
      else say('Not written yet.');
      return;
    }
    case 'initialize': return initialize(r);
  }
}

// Files for a remote client are typed as paths (relative to the project) in a bridged dialog; only existing paths are kept.
export async function pickPaths(root: string, label: string, remote: boolean): Promise<string[]> {
  if (!remote) return ((await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(root), openLabel: label })) ?? []).map(u => u.fsPath);
  return remotePaths(hub, root, label);
}

export async function addProject() {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add project' });
  if (!picked?.length) return;
  const paths = picked.map(u => u.fsPath);
  await st.ctx.globalState.update('projects', [...new Set([...saved(), ...paths])]);
  setCurrent(paths[0]);
  void recheck();
  push();
}

export async function removeProject(root: string) {
  const r = runners.get(root);
  const live = r ? r.counts().running + r.counts().waiting : 0;
  if (!await confirm(`Remove ${path.basename(root)} from JustCode?${live ? ` Its ${live} running task(s) are stopped.` : ''} Files and the board are kept.`, 'Remove')) return;
  if (r) { r.dispose(); runners.delete(root); }
  await st.ctx.globalState.update('projects', saved().filter(p => p !== root));
  if (st.current === root) st.current = undefined;
  push();
}

// Pasted images go to .justcode/attachments/<task>/ (outside git); the task's prompt points Claude at them.
// prefix keeps later pastes (a message, a planning chat) from overwriting earlier ones.
export function saveImages(root: string, taskId: string, images: { name: string; data: string }[], prefix = 'image') {
  const dir = path.join(root, '.justcode', 'attachments', taskId);
  fs.mkdirSync(dir, { recursive: true });
  return images.slice(0, 8).map((img, i) => {
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(img.data);
    if (!m) throw new Error(`${img.name}: not an image`);
    const file = path.join(dir, `${prefix}-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return file;
  });
}

// A message with pasted screenshots: saved next to the task's other attachments, and named in the message so
// Claude opens them.
export function withImages(text: string, root: string, folder: string, images?: { name: string; data: string }[]) {
  if (!Array.isArray(images) || !images.length) return text;
  const files = saveImages(root, folder, images, `paste-${Date.now()}`);
  return `${text}\n\nScreenshots (read them first):\n${files.map(f => `- ${f}`).join('\n')}`;
}

// The task's folder while it works; the project folder once merged. PDFs, Office files and media open in their own app.
export function openTaskFile(r: Runner, t: Task | undefined, file: unknown) {
  if (!t || typeof file !== 'string') return;
  const dir = t.worktree && fs.existsSync(t.worktree) ? t.worktree : r.root, full = path.resolve(dir, file);
  if (!full.startsWith(dir + path.sep)) return;
  if (!fs.existsSync(full)) { vscode.window.showWarningMessage(`${file} is no longer in ${path.basename(dir)}.`); return; }
  const uri = vscode.Uri.file(full);
  if (/\.(pdf|docx?|xlsx?|pptx?|key|pages|numbers|zip|mp4|mov|webm|mp3|wav|apk|aab|dmg)$/i.test(file)) void vscode.env.openExternal(uri);
  else void vscode.commands.executeCommand('vscode.open', uri);
}

export async function diff(t: Task | undefined, file: string) {
  const r = runner();
  if (!t || !r || typeof file !== 'string') return;
  if (/\.(pdf|png|jpe?g|gif|webp|svg|ico|docx?|xlsx?|pptx?|zip|mp4|mov|webm|mp3|wav|apk|aab)$/i.test(file)) return openTaskFile(r, t, file);
  if (!t.worktree && t.status === 'done' && t.branch) { // merged: the merge commit against what base had before it
    const sha = await g.mergeCommit(r.root, t.branch);
    if (!sha) return openTaskFile(r, t, file);
    const side = (ref: string) => vscode.Uri.from({ scheme: 'justcode-base', path: '/' + file, query: JSON.stringify({ dir: r.root, ref, file }) });
    void vscode.commands.executeCommand('vscode.diff', side(`${sha}^1`), side(sha), `${file} (before ↔ ${t.title})`);
    return;
  }
  if (!t.worktree || !t.base) return;
  const ref = await g.mergeBase(t.worktree, t.base);
  const left = vscode.Uri.from({ scheme: 'justcode-base', path: '/' + file, query: JSON.stringify({ dir: t.worktree, ref, file }) });
  void vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(path.join(t.worktree, file)), `${file} (${t.base} ↔ ${t.title})`);
}

export const remoteTerms = new Map<vscode.Terminal, { root: string; id: string }>();

// Continue on your phone: the task's session moves to `claude --remote-control`, which shows it in the Claude app and
// on claude.ai/code. The card waits; closing the terminal brings the task back to the board (committed, then reviewed).
export async function handoff(r: Runner, t: Task | undefined) {
  if (!t) return;
  if (!st.setup?.remote) {
    const c = await vscode.window.showWarningMessage('Remote Control needs Claude Code signed in with a Claude account (Pro, Max, Team or Enterprise), not an API key.', 'Check setup');
    if (c) open();
    return;
  }
  if (r.isOpen(t.id) && r.live(t.id).run !== 'idle' && !await confirm(`"${t.title}" is working. Move it to Remote Control now? Its current step is stopped and continues there.`, 'Move')) return;
  return openInTerminal(r, t, true);
}

export async function openInTerminal(r: Runner, t: Task | undefined, remote: boolean) {
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

/* ---------- planning and the optional Claude setup ---------- */

// Optional: Claude interviews you and writes .justcode/project.md (and DESIGN.md when you name a design).
// DESIGN.md read from the project's own UI (🎨 Design → From this project, or the setup checklist row).
export async function designFromProject(r: Runner) {
  const running = r.store.data.tasks.find(t => t.init === 'design' && !t.archived && t.status !== 'done');
  if (running) return open(running.id);
  const task = r.store.addTask({ title: 'Write DESIGN.md from this project\'s UI', description: 'Claude reads the styles, theme and components the code already uses and writes them to .justcode/design/DESIGN.md, so new UI matches. Nothing else changes.',
    mode: 'acceptEdits', where: 'direct', init: 'design', allow: ['Write(.justcode/design/**)', 'Edit(.justcode/design/**)'] });
  await r.run(task.id);
  open(task.id);
}

// 🎨 Design → Fix to match: one task compares every screen of a saved design with the running app, writes
// .justcode/design/audit.md and ends with the fix tasks, which JustCode adds as a sprint and runs.
export async function fixDesign(r: Runner, sourceId?: string) {
  const running = r.store.data.tasks.find(t => t.init === 'fixdesign' && !t.archived && t.status !== 'done');
  if (running) return open(running.id);
  const designs = A.loadSources(r.root).filter(s => A.hasCopy(r.root, s) || s.kind === 'folder');
  const src = designs.find(s => s.id === sourceId) ?? (designs.length === 1 ? designs[0] : undefined);
  if (!src) { vscode.window.showWarningMessage(designs.length ? 'Pick the design under 🎨 Design → Fix to match.' : 'Add the design under 📎 Sources and press Save copy first.'); return; }
  const task = r.store.addTask({ title: 'Fix the UI to match the design: compare every screen', description: `Claude splits ${src.note || src.ref} into screen images, compares each screen with the running app, writes .justcode/design/audit.md, and ends with the fix tasks. JustCode adds them as a sprint and runs them.`,
    mode: r.defaultMode, where: 'direct', init: 'fixdesign', sources: [src.id], allow: ['Write(.justcode/**)', 'Edit(.justcode/**)'] });
  await r.run(task.id);
  open(task.id);
}

async function initialize(r: Runner) {
  const running = r.store.data.tasks.find(t => t.init === true && !t.archived && t.status !== 'done');
  if (running) return open(running.id);
  try { g.ignoreJustcode(r.root); } catch { /* read-only folder */ }
  const task = r.store.addTask({ title: 'Describe this project for JustCode', description: 'Claude reads the code, asks you a few questions on this card, shows the files it will write, and writes them only after you approve: .justcode/project.md and, if you name a design, .justcode/design/DESIGN.md.',
    mode: 'acceptEdits', where: 'direct', init: true, allow: ['Write(.justcode/**)', 'Bash(ls:*)'] });
  await r.run(task.id);
  open(task.id);
}

// "JustCode App" terminal: the app's build and run output, live, as in a terminal (follows .justcode/app.log;
// a new build starts a new section). One per project; reopening shows it again.
const appTerms = new Map<string, vscode.Terminal>();
function appTerminal(root: string, focus: boolean) {
  const have = appTerms.get(root);
  if (have && vscode.window.terminals.includes(have)) { have.show(!focus); return; }
  const write = new vscode.EventEmitter<string>();
  let offset = 0, timer: NodeJS.Timeout | undefined;
  const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
  const pump = () => {
    let st: fs.Stats;
    try { st = fs.statSync(App.logFile(root)); } catch { return; }
    if (st.size < offset) { write.fire('\r\n\x1b[2m──────── new build ────────\x1b[0m\r\n'); offset = 0; }
    if (st.size === offset) return;
    const fd = fs.openSync(App.logFile(root), 'r'), buf = Buffer.alloc(st.size - offset);
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = st.size;
    write.fire(crlf(buf.toString('utf8')));
  };
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    open: () => { write.fire(`\x1b[1mJustCode App · ${path.basename(root)}\x1b[0m\r\n\x1b[2mLive output of ▶ Start app / Rebuild. Closing this terminal does not stop the app.\x1b[0m\r\n\r\n`); pump(); timer = setInterval(pump, 400); },
    close: () => { if (timer) clearInterval(timer); appTerms.delete(root); },
  };
  const term = vscode.window.createTerminal({ name: `JustCode App · ${path.basename(root)}`, pty, iconPath: new vscode.ThemeIcon('server-process') });
  appTerms.set(root, term);
  term.show(!focus);
}

