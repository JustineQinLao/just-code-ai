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
import { bin, confirm, env, out, push, q, runner, setting, st } from './host';
import { saveArtifactSource, savedAt } from './artifact-terminal';

// The setup checklist: checks, project health rows, and each row's fix.

export const recheck = () => st.checking ??= checkSetup(bin(), env(), runner()?.root, !!st.apiKey)
  .then(s => { const r = runner(); st.setup = r ? { ...s, checks: [...s.checks, ...health(r)] } : s; }).catch(e => out.appendLine(`setup check failed: ${e.message}`)).finally(() => { st.checking = undefined; push(); });

// Problems in the project's .justcode files (see checkHealth): extra checklist rows, each with one fix.
export function health(r: Runner) {
  const tasks = r.store.data.tasks, hours = Math.max(0, setting<number>('artifactRefreshHours', 24));
  const stale = A.loadSources(r.root).filter(x => x.kind === 'url' && A.isArtifactLink(x.ref) && (!A.hasCopy(r.root, x) || Date.now() - (savedAt(r.root, x) ?? 0) > hours * 3600_000));
  const unarchived = tasks.filter(t => t.sessionId && !fs.existsSync(A.transcriptFile(r.root, t.id)) && r.sessionDir(t.sessionId, t));
  return checkHealth({ root: r.root, taskIds: new Set(tasks.map(t => t.id)), worktrees: new Set([...tasks.filter(t => t.worktree).map(t => path.basename(t.worktree!)), '_base']),
    staleSources: stale.map(x => x.id), unarchived: unarchived.map(t => t.id) }, loadPolicy(r.root).errors);
}

export async function fix(action: string) {
  const term = (name: string, cmd: string) => {
    const t = vscode.window.createTerminal({ name, env: { CLAUDECODE: null } });
    t.sendText(cmd);
    t.show();
    const sub = vscode.window.onDidCloseTerminal(c => { if (c === t) { sub.dispose(); void recheck(); } });
    vscode.window.showInformationMessage(`${name}: follow the steps in the terminal. The board checks again when you close it.`, 'Check again').then(c => { if (c) void recheck(); });
  };
  if (action.startsWith('installPlugin:')) {
    const name = action.slice('installPlugin:'.length).replace(/[^\w-]/g, '');
    if (name === 'superpowers') vscode.window.showInformationMessage(`If the install fails, type these in Claude Code: ${SUPERPOWERS_FALLBACK.join(' then ')}`);
    return term(`Install ${name}`, pluginInstallCommands(q(bin() ?? 'claude'), name).join(' && '));
  }
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
    case 'installPlaywright': return term('Install Playwright', playwrightCommand(q(bin() ?? 'claude')));
    case 'createDesignMd': {
      const r = runner();
      if (!r) return;
      const f = path.join(r.root, '.justcode', 'design', 'DESIGN.md');
      if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '# Design\n\nPalette, typography, spacing and tone for this project.\n'); }
      await vscode.window.showTextDocument(vscode.Uri.file(f));
      return recheck();
    }
    case 'recheck': return recheck();
  }
  const r = runner();
  if (!r) return;
  if (action.startsWith('openJustcodeFile:')) { void vscode.window.showTextDocument(vscode.Uri.file(path.join(r.root, '.justcode', path.basename(action.slice(17))))); return; }
  switch (action) {
    case 'openPolicy': loadPolicy(r.root); void vscode.window.showTextDocument(vscode.Uri.file(policyFile(r.root))); return;
    case 'resetRegistry':
      if (!await confirm('Reset the artifact registry? .justcode/artifacts.json starts empty (the old file is kept as artifacts.json.bak). Links you type or publish are added again.', 'Reset registry')) return;
      try { fs.copyFileSync(R.registryFile(r.root), R.registryFile(r.root) + '.bak'); } catch { /* nothing to keep */ }
      R.save(r.root, []);
      return recheck();
    case 'pruneRegistry': {
      const ids = new Set(r.store.data.tasks.map(t => t.id));
      R.save(r.root, R.load(r.root).map(e => ({ ...e, taskIds: e.taskIds.filter(t => ids.has(t)) })));
      return recheck();
    }
    case 'deleteOrphans': {
      const used = new Set([...r.store.data.tasks.filter(t => t.worktree).map(t => path.basename(t.worktree!)), '_base']);
      const dir = path.join(r.root, '.justcode', 'worktrees');
      const orphans = (() => { try { return fs.readdirSync(dir).filter(d => !used.has(d)); } catch { return []; } })();
      if (!orphans.length || !await confirm(`Delete ${orphans.length} task folder(s) no task uses? Uncommitted work in them is lost.\n\n${orphans.join('\n')}`, 'Delete')) return;
      for (const o of orphans) await g.removeWorktree(r.root, path.join(dir, o)).catch(e => out.appendLine(`could not remove ${o}: ${e.message}`));
      return recheck();
    }
    case 'refreshSources': {
      const hours = Math.max(0, setting<number>('artifactRefreshHours', 24));
      const stale = A.loadSources(r.root).filter(x => x.kind === 'url' && A.isArtifactLink(x.ref) && (!A.hasCopy(r.root, x) || Date.now() - (savedAt(r.root, x) ?? 0) > hours * 3600_000));
      await Promise.all(stale.map(x => saveArtifactSource(r.root, x)));
      return recheck();
    }
    case 'archiveTranscripts':
      for (const t of r.store.data.tasks) {
        const dir = t.sessionId && r.sessionDir(t.sessionId, t);
        for (const sid of [...(t.pastSessions ?? []), t.sessionId].filter((x): x is string => !!x)) if (dir) A.archiveTranscript(r.root, t.id, transcript(dir, sid), sid);
      }
      return recheck();
  }
}
