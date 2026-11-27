import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import * as g from './git';
import { sweepStacks } from './docker';
import * as App from './app';
import { setupSkillBody } from './skill';
import { Session, Answer, Ask, AgentNode, TurnEnd, RunState } from './session';
import * as R from './registry';
import * as Audit from './audit';
import { SecretsFound, describeSecrets } from './secrets';
import { loadPolicy, violations, toolArg } from './policy';
import { trackIssues, openIssues, acceptedIssues, roundLimit } from './issues';
import { transcript } from './claude';
import { carryOver, discoverAgents, reviewPrompt, runReview, sessionExists, sessionSize, taskPrompt, adb, userAllowRules, addUsage, Usage, PLANNER_APPEND, plannerFirst, parseProposals, RefineResult, artifactBrief, installedPlugin, webOptions } from './claude';
import * as A from './artifacts';
import { ensurePlugin, pluginDir } from './plugin';
import * as C from './checks';
import * as Out from './outside';
import { Limits, isLimitError } from './limits';
import type { Runner } from './runner';
import { BASELINE, sha, TEST_CMD, UI_FILE, effectiveMode } from './runner';

// Runner methods: Merging and finishing tasks, sprint merges, conflicts, discard, pull requests and removal.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const mergeMethods = {
  async changes(this: Runner, id: string) {
    const t = this.store.task(id);
    const inProject = await this.projectChanges(id);
    // Files Claude changed in another folder or repo (outside.ts), listed after the project's own.
    return t?.outside?.length && t.status !== 'done' ? [...inProject, ...await Out.outsideChanges(this.root, t.outside).catch(() => [])] : inProject;
  },

  projectChanges(this: Runner, id: string): Promise<g.Change[]> {
    const t = this.store.task(id);
    if (t?.status === 'done' && !t.worktree && t.branch && t.where !== 'direct') return g.mergedChanges(this.root, t.branch);
    if (t?.where === 'direct' && !t.init) return t.startHead && t.directFiles?.length ? g.workingChanges(this.root, t.startHead, t.directFiles) : Promise.resolve([]);
    if (!t?.worktree || !t.base || !fs.existsSync(t.worktree)) return Promise.resolve([]);
    // A folder git no longer knows (its record was lost) cannot be diffed: show the merge if there is one, else nothing.
    return g.isWorktree(t.worktree).then(ok => ok ? g.changes(t.worktree!, t.base!) : t.branch ? g.mergedChanges(this.root, t.branch).catch(() => []) : []);
  },

  async guarded<T>(this: Runner, id: string, fn: (t: Task) => Promise<T>) {
    const t = this.store.task(id);
    if (!t || this.busy.has(id)) return;
    this.busy.add(id);
    // A refused or failed action (Merge, Mark resolved, PR) says why on the card, not only in a toast, until the next try.
    if (t.warning) this.store.updateTask(id, { warning: undefined });
    this.changed();
    try { return await this.serial(() => fn(t)); } catch (e: any) {
      if (this.store.task(id)) this.store.updateTask(id, { warning: String(e?.message ?? e).slice(0, 400) });
      this.d.notify('error', e.message, id);
    } finally { this.busy.delete(id); this.changed(); }
  },

  // Finish/Merge: the task's files in other repos get their own commit there (same message). Said on the card.
  async finishOutside(this: Runner, t: Task) {
    if (!t.outside?.length) return '';
    const { committed, loose } = await Out.commitOutside(t.outside, A.commitMessage(this.root, t), this.secretScan()).catch(e => { if (e instanceof SecretsFound) this.secretsBlocked(t.id, e); throw e; });
    this.store.updateTask(t.id, { outside: undefined });
    const said = [committed.length ? `committed in ${committed.map(r => path.basename(r)).join(', ')}` : '', loose.length ? `${loose.length} file(s) outside any git repo left as they are` : ''].filter(Boolean).join('; ');
    if (said) this.audit('outside.commit', t.id, `${said}: ${t.outside.map(o => o.file).join(', ')}`, 'justcode');
    return said;
  },

  mergeLater(this: Runner, t: Task) {
    this.store.updateTask(t.id, { mergeWhenReady: true, warning: undefined });
    this.d.notify('info', `"${t.title}" will ${t.where === 'direct' && !t.init ? 'finish' : 'merge'} by itself when Claude, the checks and the review are done and pass.`, t.id);
  },

  // Base is brought into the branch first, inside the task's folder; conflicts stop there, never in the user's checkout.
  merge(this: Runner, id: string, auto = false, by: Audit.Actor = 'user') {
    return this.guarded(id, async t => {
      this.requireLease();
      const pol = loadPolicy(this.root).policy;
      if (pol.requireChecksPass && t.checks?.state === 'fail' && !t.init) {
        const why = `The project policy requires passing checks before ${t.where === 'direct' ? 'Finish' : 'Merge'} (.justcode/policy.json, requireChecksPass). Fix the checks or Discard.`;
        this.audit('policy.deny', id, why, 'policy');
        throw new Error(why);
      }
      if (auto && !t.init) {
        const hold = await this.humanReviewFor(t);
        if (hold.length) {
          if (t.review) this.store.updateTask(id, { review: { ...t.review, hold: `touches ${hold.slice(0, 3).join(', ')}${hold.length > 3 ? '…' : ''}` } });
          this.audit('policy.deny', id, `not merged automatically: ${hold.join(', ')} (requireHumanReviewFor)`, 'policy');
          this.d.notify('warn', `"${t.title}" passed review but needs your approval (policy): it touches ${hold.slice(0, 3).join(', ')}.`, id, true);
          return;
        }
      }
      if (t.where === 'direct' && !t.init) {
        const s0 = this.sessions.get(id);
        if (!auto && (this.reviews.has(id) || this.checking.has(id) || (s0?.open && s0.state !== 'idle') || t.status === 'doing')) return this.mergeLater(t);
        if (t.status !== 'review' || this.reviews.has(id) || this.checking.has(id) || (s0?.open && s0.state !== 'idle')) throw new Error('Claude is still working on this task. Wait for it to finish, then Finish.');
        const files = t.directFiles ?? [];
        if (files.length) await g.commitFiles(this.root, A.commitMessage(this.root, t), files, this.secretScan()).catch(e => { if (e instanceof SecretsFound) this.secretsBlocked(id, e); throw e; });
        const outsideSaid = await this.finishOutside(t);
        if (outsideSaid) this.d.notify('info', `"${t.title}": files outside the project ${outsideSaid}.`, id);
        try { A.appendProgress(this.root, t); } catch { /* progress is a convenience */ }
        this.stop(id);
        this.store.updateTask(id, { status: 'done', live: undefined, doneAt: Date.now() });
        this.audit('finish', id, `${files.length} file(s) committed${acceptedIssues(t.review).length ? `, ${acceptedIssues(t.review).length} accepted review issue(s)` : ''}`, auto ? 'justcode' : by);
        this.d.notify('info', `Finished "${t.title}".`, undefined, auto);
        void App.afterMerge(this.root, files, `after "${t.title}"`, false).catch(() => undefined);
        this.pump();
        return;
      }
      if (!t.worktree) { this.store.updateTask(id, { status: 'done' }); return; }
      if (!t.branch || !t.base) throw new Error('Nothing to merge yet');
      const dirty = this.openDirect(id);
      if (dirty?.directFiles?.length) throw new Error(`"${dirty.title}" has uncommitted files in the project folder. Finish or Discard it first, then merge.`);
      const s = this.sessions.get(id);
      // Busy (Claude, the checks or the review): remembered, and merged by the sweep once they pass.
      if (!auto && ((s?.open && s.state !== 'idle') || this.checking.has(id) || this.reviews.has(id))) return this.mergeLater(t);
      if (s?.open && s.state !== 'idle') throw new Error('Claude is still working on this task. Wait for it to finish, or stop it.');
      if (this.checking.has(id)) throw new Error('The checks are still running in this task\'s folder. Merge when they finish.');
      this.stop(id);
      // An earlier Merge got as far as the merge commit and then failed while removing the folder (git no longer knows it): only finish up.
      const already = await g.isMerged(this.root, t.branch, t.base) && !await g.isWorktree(t.worktree);
      const outsideSaid = await this.finishOutside(t);
      if (outsideSaid) this.d.notify('info', `"${t.title}": files outside the project ${outsideSaid}.`, id);
      // Nothing for the base (Claude only answered, or only changed another repo): no merge commit, just finish up.
      const nothing = !already && !(await g.git(t.worktree, ['status', '--porcelain']).catch(() => 'x')).trim()
        && Number(await g.git(t.worktree, ['rev-list', '--count', `${t.base}..HEAD`]).catch(() => '1')) === 0;
      if (nothing) {
        await this.cleanup(t).catch(e => this.d.notify('warn', `Finished "${t.title}", but could not remove its folder (${e.message}). Delete ${t.worktree} by hand.`, id));
        this.store.updateTask(id, { status: 'done', conflicts: undefined, worktree: undefined, live: undefined, doneAt: Date.now(), mergeWhenReady: undefined, resolveTries: undefined, noProjectChanges: undefined });
        this.audit('finish', id, `no project changes${outsideSaid ? `; outside: ${outsideSaid}` : ''}`, auto ? 'justcode' : by);
        this.d.notify('info', `Finished "${t.title}" (no project files changed).`, undefined, auto);
        if (t.sprintId) await this.mergeSprint(t.sprintId).catch(e => this.d.notify('error', e.message));
        this.pump();
        return;
      }
      if (!already) {
        const msg = A.commitMessage(this.root, t);
        await g.commitAll(t.worktree, msg, this.secretScan()).catch(e => { if (e instanceof SecretsFound) this.secretsBlocked(id, e); throw e; });
        await g.squash(t.worktree, t.base, msg).catch(() => false);   // one commit per task, in the project's message format
        const conflicts = await g.syncWithBase(t.worktree, t.base);
        if (conflicts.length) {
          // Its base moved on while it waited (other tasks merged). Claude resolves them by itself (twice at most); the
          // task then goes through checks and review again and merges, as a click on Merge asked.
          const tries = (t.resolveTries ?? 0) + 1;
          this.store.updateTask(id, { conflicts, status: 'review', resolveTries: tries, ...(auto ? {} : { mergeWhenReady: true }) });
          if (tries <= 2 && !this.overBudget(t) && !this.d.limits.held()) {
            this.d.notify('info', `"${t.title}" conflicts with ${t.base} in ${conflicts.length} file(s): Claude is resolving them, then it merges.`, id);
            void Promise.resolve(this.resolveWithClaude(id)).catch(e => this.store.updateTask(id, { warning: `Could not start resolving: ${e.message}` }));
          } else this.d.notify('warn', `"${t.title}" conflicts with ${t.base} in ${conflicts.length} file(s). Resolve them on the card (Resolve with Claude, or by hand and Mark resolved), then merge again.`, id, true);
          return;
        }
        const before = await g.git(this.root, ['rev-parse', `refs/heads/${t.base}`]).catch(() => '');
        await g.mergeIntoBase(this.root, t.base, t.branch, `${A.commitSubject(this.root, t)}\n\nMerge branch ${t.branch} into ${t.base}`);
        try { A.appendProgress(this.root, t); } catch { /* progress is a convenience */ }
        // A running app follows the project folder: rebuild it when this merge landed on the checked-out branch.
        if (before && await g.currentBranch(this.root).catch(() => '') === t.base) {
          const files = (await g.git(this.root, ['diff', '--name-only', before, t.base]).catch(() => '')).split('\n').filter(Boolean);
          void App.afterMerge(this.root, files, `after "${t.title}"`, false).catch(() => undefined);
        }
      }
      // The merge is in git. A folder that will not go away must not leave the task in Review, or Merge runs again.
      await this.cleanup(t).catch(e => this.d.notify('warn', `Merged "${t.title}", but could not remove its folder (${e.message}). Delete ${t.worktree} by hand.`, id));
      this.store.updateTask(id, { status: 'done', conflicts: undefined, worktree: undefined, live: undefined, doneAt: Date.now(), mergeWhenReady: undefined, resolveTries: undefined });
      this.audit('merge', id, `${t.branch} into ${t.base}${acceptedIssues(t.review).length ? `, ${acceptedIssues(t.review).length} accepted review issue(s)` : ''}${t.review?.unreviewed ? ', unreviewed' : ''}`, auto ? 'justcode' : by);
      this.d.notify('info', `${auto ? 'Review passed, merged' : 'Merged'} "${t.title}" into ${t.base}.`, undefined, auto);
      // The task is merged: a sprint merge that cannot go yet is the sprint's problem (shown on the board), not this task's.
      if (t.sprintId) await this.mergeSprint(t.sprintId).catch(e => this.d.notify('error', e.message));
      this.pump();  // its slot is free: the next queued task starts on top of this merge
    });
  },

  // A sprint is finished when none of its tasks is left to do and no task still builds on its branch. Its branch
  // then merges into the branch it was cut from. Conflicts leave both branches as they are and say which files.
  finishSprint(this: Runner, id: string) {
    return this.serial(() => this.mergeSprint(id)).catch(e => this.d.notify('error', e.message));
  },

  async mergeSprint(this: Runner, id: string) {
    const sp = this.store.sprint(id);
    if (!sp?.branch || !sp.target) return;
    const tasks = this.store.data.tasks;
    if (tasks.some(x => (x.sprintId === id && !x.archived && x.status !== 'done') || (x.base === sp.branch && x.worktree && x.status !== 'done'))) return;
    this.requireLease();
    const before = await g.git(this.root, ['rev-parse', `refs/heads/${sp.target}`]).catch(() => '');
    // Not merged yet: said once, kept on the sprint (a board banner), and tried again by the sweep until it goes in.
    const block = (why: string, files?: string[]) => {
      const fresh = sp.blocked !== why;
      this.store.updateSprint(id, { blocked: why, blockedBy: files });
      if (!fresh) return;
      // Your own files in the way: ask what to do, with a recommendation (not awaited: a dialog must not hold the queue).
      if (files) void this.askBlocked(id);
      else this.d.notify('warn', `${sp.name} is done, but not merged into ${sp.target} yet: ${why}`, undefined, true);
    };
    if (await g.branchExists(this.root, sp.branch)) {
      let conflicts: string[];
      // The sprint's merge says what it brings: each of its tasks' commit subjects.
      const subjects = tasks.filter(x => x.sprintId === id && x.status === 'done' && !x.archived && !x.init).map(x => `- ${A.commitSubject(this.root, x)}`);
      try { conflicts = await g.mergeBranch(this.root, sp.target, sp.branch, `chore(sprint): merge ${sp.name} into ${sp.target}${subjects.length ? `\n\n${subjects.join('\n')}` : ''}`); } catch (e: any) {
        if (!(e instanceof g.LocalChanges)) throw e;
        const by = tasks.filter(x => !x.archived && x.directFiles?.some(f => e.files.includes(f))).map(x => `${x.chat ? 'chat' : 'task'} "${x.title.slice(0, 40)}"`);
        return block(`${e.message}${by.length ? ` They come from ${by.join(', ')}.` : ''}`, e.files);
      }
      if (conflicts.length) return block(`${sp.branch} conflicts with ${sp.target} in: ${conflicts.join(', ')}. Merge it by hand (git merge ${sp.branch} on ${sp.target}), then Merge sprint.`);
      await g.deleteBranch(this.root, sp.branch).catch(() => undefined);
    }
    // Merged: the sprint is finished. Closed, so a later plan never puts new work in it (and never re-cuts its branch).
    this.store.updateSprint(id, { branch: undefined, target: undefined, blocked: undefined, blockedBy: undefined, closed: true, active: false });
    this.d.notify('info', `${sp.name} is done: merged ${sp.branch} into ${sp.target}.`, undefined, true);
    // The sprint is in: free Docker of every task stack, then rebuild the project's app from the project folder when code changed.
    const live = this.store.data.tasks.filter(x => x.worktree && x.status !== 'done').map(x => x.worktree!);
    await sweepStacks(this.root, live).catch(() => []);
    const files = before ? (await g.git(this.root, ['diff', '--name-only', before, sp.target]).catch(() => '')).split('\n').filter(Boolean) : [];
    void App.afterMerge(this.root, files, `after ${sp.name}`, true).catch(() => undefined);  // not awaited: a build can take minutes
  },

  // A done sprint held up by your uncommitted files in the project folder: you choose, JustCode recommends. Committing
  // them is recommended when they merge cleanly with the sprint; when they change the same lines, look first.
  async askBlocked(this: Runner, id: string) {
    const sp = this.store.sprint(id), files = sp?.blockedBy;
    if (!sp?.branch || !sp.target || !files?.length) return;
    const clash = await g.wouldConflict(this.root, sp.target, sp.branch, files).catch(() => files);
    const COMMIT = `Commit them, then merge${clash.length ? '' : ' (recommended)'}`, DISCARD = 'Discard my changes, then merge', LATER = `Later${clash.length ? ' (recommended)' : ''}`;
    const list = `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`;
    const c = await this.d.choose(`${sp.name} is done, but your uncommitted changes in ${sp.target} are in the way of its merge: ${list}.\n\n` +
      (clash.length ? `${clash.join(', ')} change${clash.length === 1 ? 's' : ''} the same lines as the sprint: committing leads to a conflict you resolve by hand. Recommended: look at them first (keep, commit or discard), and the sprint merges by itself once they are out of the way.`
        : 'They do not clash with the sprint. Recommended: commit them; the sprint then merges on top.'),
      ...(clash.length ? [LATER, COMMIT, DISCARD] : [COMMIT, DISCARD, LATER]));
    const now = this.store.sprint(id);
    if (!now?.branch || now.blockedBy?.join() !== files.join() || (c !== COMMIT && c !== DISCARD)) return;
    await this.serial(async () => {
      if (c === COMMIT) await g.commitFiles(this.root, `chore: commit local changes before merging ${sp.name}`, files, this.secretScan());
      else await g.revertFiles(this.root, files);
      this.audit(c === COMMIT ? 'finish' : 'discard', undefined, `${files.join(', ')} (in the way of ${sp.name})`, 'user');
      // Chats and direct tasks that listed these files no longer have them uncommitted.
      for (const t of this.store.data.tasks) if (t.directFiles?.some(f => files.includes(f))) this.store.updateTask(t.id, { directFiles: t.directFiles.filter(f => !files.includes(f)) });
      this.store.updateSprint(id, { blocked: undefined, blockedBy: undefined });
      await this.mergeSprint(id);
    }).catch(e => this.d.notify('error', e.message));
  },

  resolveWithClaude(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t?.conflicts?.length) return;
    return this.followUp(id, `Merging ${t.base} into this branch left conflicts in: ${t.conflicts.join(', ')}. ` +
      'Resolve every conflict keeping the intent of both sides, remove all conflict markers, and make sure it builds. Do not commit; JustCode does.');
  },

  markResolved(this: Runner, id: string) {
    return this.guarded(id, async t => {
      if (!t.worktree || !t.conflicts) return;
      const left = g.markersLeft(t.worktree, t.conflicts);
      if (left.length) throw new Error(`Conflict markers still in: ${left.join(', ')}`);
      if (await g.merging(t.worktree)) await g.finishResolve(t.worktree);
      this.store.updateTask(id, { conflicts: undefined });
      this.d.notify('info', `Conflicts resolved for "${t.title}". Merge it when ready.`, id);
    });
  },

  // Drops the branch and its work; the task goes back to To do with a fresh session next run.
  discard(this: Runner, id: string, by: Audit.Actor = 'user') {
    return this.guarded(id, async t => {
      this.audit('discard', id, t.where === 'direct' ? (t.directFiles ?? []).join(', ') : t.branch, by);
      if (t.where === 'direct' && !t.init) {
        if (t.status === 'done') throw new Error('This task is finished and committed. Revert the commit in git instead.');
        this.stop(id);
        this.cancelReview(id);
        await g.revertFiles(this.root, t.directFiles ?? []);
        this.store.updateTask(id, { status: 'todo', directFiles: undefined, startHead: undefined, usage: undefined, checks: undefined, startedAt: undefined, sessionId: undefined,
          review: undefined, error: undefined, live: undefined, reply: undefined, limited: undefined });
        A.removeTaskDir(this.root, id);
        this.pump();
        return;
      }
      await this.cleanup(t);
      A.removeTaskDir(this.root, id);
      this.store.updateTask(id, { status: 'todo', usage: undefined, checks: undefined, startedAt: undefined, branch: undefined, worktree: undefined, sessionId: undefined, conflicts: undefined, pr: undefined,
        review: undefined, error: undefined, live: undefined, reply: undefined, remote: undefined, limited: undefined });
    });
  },

  remotePr(this: Runner, id: string) {
    return this.guarded(id, async t => {
      if (!t.worktree || !t.branch || !t.base) throw new Error('Run the task first');
      await g.commitAll(t.worktree, A.commitMessage(this.root, t), this.secretScan());
      const url = await g.openRemotePr(t.worktree, t.base, t.branch, t.title, t.description ?? '');
      this.store.updateTask(id, { pr: url });
    });
  },

  async cleanup(this: Runner, t: Task, keepBranch = false) {
    this.stop(t.id);
    this.cancelReview(t.id);
    fs.rmSync(path.join(os.tmpdir(), 'justcode-reviews', t.id), { recursive: true, force: true });
    if (t.worktree) await g.removeWorktree(this.root, t.worktree);
    if (t.branch && !keepBranch) await g.deleteBranch(this.root, t.branch).catch(() => { /* never created */ });
  },

  // Commits on a task's branch that its base does not have yet (0 when there is no branch or nothing new).
  async unmergedCommits(this: Runner, t: Task) {
    if (!t.branch || !await g.branchExists(this.root, t.branch)) return 0;
    const base = t.base && await g.branchExists(this.root, t.base) ? t.base : await g.currentBranch(this.root).catch(() => '');
    if (!base) return 0;
    return Number(await g.git(this.root, ['rev-list', '--count', `${base}..${t.branch}`]).catch(() => '0')) || 0;
  },

  // Deleting a task never throws away work that was not merged: its branch stays (and is named in a notice).
  // When it was its sprint's last open task, the sprint can now merge.
  async remove(this: Runner, id: string, mergeSprint = true) {
    const t = this.store.task(id);
    if (!t) return;
    const kept = t.status !== 'done' ? await this.unmergedCommits(t).catch(() => 0) : 0;
    await this.serial(() => this.cleanup(t, kept > 0)).catch(e => this.d.notify('error', e.message));
    if (kept) this.d.notify('warn', `Deleted "${t.title}", but kept its branch ${t.branch}: it has ${kept} commit${kept === 1 ? '' : 's'} that ${t.base ?? 'its base'} does not have. ` +
      `Merge it by hand (git merge ${t.branch}) or delete it (git branch -D ${t.branch}).`, undefined, true);
    fs.rmSync(path.join(this.root, '.justcode', 'attachments', id), { recursive: true, force: true });
    A.removeTaskDir(this.root, id);
    try { R.unlinkTask(this.root, id); } catch { /* the registry is a convenience */ }
    this.store.deleteTask(id);
    if (t.sprintId && mergeSprint) await this.finishSprint(t.sprintId);
  },

  // Sprints that are finished but still open: every task done (or archived) and the sprint branch merged, deleted,
  // or merged by hand into its target or the branch you are on. Closed, so plans do not reuse them.
  async tidySprints(this: Runner) {
    const current = await g.currentBranch(this.root).catch(() => '');
    for (const sp of this.store.data.sprints) {
      if (sp.closed) continue;
      const tasks = this.store.data.tasks.filter(x => x.sprintId === sp.id && !x.archived);
      if (!tasks.length || tasks.some(x => x.status !== 'done')) continue;
      if (sp.branch && await g.branchExists(this.root, sp.branch)) {
        const into = [sp.target, current].filter((b): b is string => !!b && b !== 'HEAD' && b !== sp.branch);
        let merged = false;
        for (const b of into) if (await g.branchExists(this.root, b) && await g.isMerged(this.root, sp.branch, b)) { merged = true; break; }
        if (!merged) continue;   // its work is not in yet: Merge sprint does that
        await g.git(this.root, ['branch', '-d', sp.branch]).catch(() => undefined);
      }
      this.store.updateSprint(sp.id, { branch: undefined, target: undefined, blocked: undefined, blockedBy: undefined, closed: true, active: false });
    }
  },
};
