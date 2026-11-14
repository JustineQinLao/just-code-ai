import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import * as g from './git';
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
import { Limits, isLimitError } from './limits';
import type { Runner } from './runner';
import { BASELINE, sha, TEST_CMD, UI_FILE, effectiveMode } from './runner';

// Runner methods: Merging and finishing tasks, sprint merges, conflicts, discard, pull requests and removal.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const mergeMethods = {
  changes(this: Runner, id: string) {
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
    this.changed();
    try { return await this.serial(() => fn(t)); } catch (e: any) { this.d.notify('error', e.message, id); } finally { this.busy.delete(id); this.changed(); }
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
        if (t.status !== 'review' || this.reviews.has(id) || this.checking.has(id) || (s0?.open && s0.state !== 'idle')) throw new Error('Claude is still working on this task. Wait for it to finish, then Finish.');
        const files = t.directFiles ?? [];
        if (files.length) await g.commitFiles(this.root, t.title, files, this.secretScan()).catch(e => { if (e instanceof SecretsFound) this.secretsBlocked(id, e); throw e; });
        try { A.appendProgress(this.root, t); } catch { /* progress is a convenience */ }
        this.stop(id);
        this.store.updateTask(id, { status: 'done', live: undefined, doneAt: Date.now() });
        this.audit('finish', id, `${files.length} file(s) committed${acceptedIssues(t.review).length ? `, ${acceptedIssues(t.review).length} accepted review issue(s)` : ''}`, auto ? 'justcode' : by);
        this.d.notify('info', `Finished "${t.title}".`, undefined, auto);
        this.pump();
        return;
      }
      if (!t.worktree) { this.store.updateTask(id, { status: 'done' }); return; }
      if (!t.branch || !t.base) throw new Error('Nothing to merge yet');
      const dirty = this.openDirect(id);
      if (dirty?.directFiles?.length) throw new Error(`"${dirty.title}" has uncommitted files in the project folder. Finish or Discard it first, then merge.`);
      const s = this.sessions.get(id);
      if (s?.open && s.state !== 'idle') throw new Error('Claude is still working on this task. Wait for it to finish, or stop it.');
      if (this.checking.has(id)) throw new Error('The checks are still running in this task\'s folder. Merge when they finish.');
      this.stop(id);
      // An earlier Merge got as far as the merge commit and then failed while removing the folder (git no longer knows it): only finish up.
      const already = await g.isMerged(this.root, t.branch, t.base) && !await g.isWorktree(t.worktree);
      if (!already) {
        await g.commitAll(t.worktree, t.title, this.secretScan()).catch(e => { if (e instanceof SecretsFound) this.secretsBlocked(id, e); throw e; });
        const conflicts = await g.syncWithBase(t.worktree, t.base);
        if (conflicts.length) {
          this.store.updateTask(id, { conflicts, status: 'review' });
          this.d.notify('warn', `"${t.title}" conflicts with ${t.base} in ${conflicts.length} file(s). Resolve them on the card, then merge again.`, id, true);
          return;
        }
        await g.mergeIntoBase(this.root, t.base, t.branch, `Merge ${t.branch}: ${t.title}`);
        try { A.appendProgress(this.root, t); } catch { /* progress is a convenience */ }
      }
      // The merge is in git. A folder that will not go away must not leave the task in Review, or Merge runs again.
      await this.cleanup(t).catch(e => this.d.notify('warn', `Merged "${t.title}", but could not remove its folder (${e.message}). Delete ${t.worktree} by hand.`, id));
      this.store.updateTask(id, { status: 'done', conflicts: undefined, worktree: undefined, live: undefined, doneAt: Date.now() });
      this.audit('merge', id, `${t.branch} into ${t.base}${acceptedIssues(t.review).length ? `, ${acceptedIssues(t.review).length} accepted review issue(s)` : ''}${t.review?.unreviewed ? ', unreviewed' : ''}`, auto ? 'justcode' : by);
      this.d.notify('info', `${auto ? 'Review passed, merged' : 'Merged'} "${t.title}" into ${t.base}.`, undefined, auto);
      if (t.sprintId) await this.mergeSprint(t.sprintId);
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
    if (await g.branchExists(this.root, sp.branch)) {
      const conflicts = await g.mergeBranch(this.root, sp.target, sp.branch, `Merge sprint ${sp.name} (${sp.branch})`);
      if (conflicts.length) {
        this.d.notify('warn', `${sp.name} is done, but ${sp.branch} conflicts with ${sp.target} in: ${conflicts.join(', ')}. ` +
          `Merge it by hand (git merge ${sp.branch} on ${sp.target}), then use Merge sprint.`, undefined, true);
        return;
      }
      await g.deleteBranch(this.root, sp.branch).catch(() => undefined);
    }
    this.store.updateSprint(id, { branch: undefined, target: undefined });
    this.d.notify('info', `${sp.name} is done: merged ${sp.branch} into ${sp.target}.`, undefined, true);
  },

  resolveWithClaude(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t?.conflicts?.length) return;
    return this.say(id, `Merging ${t.base} into this branch left conflicts in: ${t.conflicts.join(', ')}. ` +
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
      await g.commitAll(t.worktree, t.title, this.secretScan());
      const url = await g.openRemotePr(t.worktree, t.base, t.branch, t.title, t.description ?? '');
      this.store.updateTask(id, { pr: url });
    });
  },

  async cleanup(this: Runner, t: Task) {
    this.stop(t.id);
    this.cancelReview(t.id);
    fs.rmSync(path.join(os.tmpdir(), 'justcode-reviews', t.id), { recursive: true, force: true });
    if (t.worktree) await g.removeWorktree(this.root, t.worktree);
    if (t.branch) await g.deleteBranch(this.root, t.branch).catch(() => { /* never created */ });
  },

  async remove(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t) return;
    await this.serial(() => this.cleanup(t)).catch(e => this.d.notify('error', e.message));
    fs.rmSync(path.join(this.root, '.justcode', 'attachments', id), { recursive: true, force: true });
    A.removeTaskDir(this.root, id);
    try { R.unlinkTask(this.root, id); } catch { /* the registry is a convenience */ }
    this.store.deleteTask(id);
  },
};
