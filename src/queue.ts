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

// Runner methods: Run all's queue: what runs next, what holds a slot, what the toolbar says it waits for.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const queueMethods = {
  runAll(this: Runner, ids: string[]) {
    const q = [...this.store.queue];
    for (const id of ids) if (!q.includes(id) && this.store.task(id)?.status === 'todo') q.push(id);
    this.store.setQueue(q);
    this.pump();
  },

  cancelQueue(this: Runner) { this.store.setQueue([]); },

  // The task the queue waits on, when only you can move it on (merge it, answer it, fix it): nothing is running.
  userBlocker(this: Runner) {
    const b = this.inFlight()[0];
    if (!b || !this.store.queue.length || this.starting.has(b.id) || this.reviews.has(b.id) || b.remote || b.limited) return;
    const s = this.sessions.get(b.id);
    if (s?.open && s.state !== 'idle' && s.state !== 'waiting') return;
    return { id: b.id, title: b.title, why: this.queueInfo().blocker!.why };
  },

  // Run all goes on without this task; it keeps its branch and still waits for you on its card.
  skipWait(this: Runner, id: string) {
    this.store.updateTask(id, { noWait: true });
    this.pump();
  },

  // "Run now" on a queued card: you asked for this one, so it starts past the "tasks at once" limit.
  async runNow(this: Runner, id: string) {
    this.store.setQueue(this.store.queue.filter(q => q !== id));
    await this.run(id);
  },

  // A card's ▶ Run. It honors the "tasks at once" limit (maxParallel): if a slot is free it starts now, otherwise it
  // goes to the front of the queue and starts when a running task is merged. Raise the limit in Settings to run several.
  async requestRun(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t || t.status !== 'todo') return this.run(id);  // continuing an existing task is not a new start
    const free = this.d.settings().maxParallel - this.inFlight().length;
    if (free > 0 && !this.d.limits.held()) return this.run(id);
    if (!this.store.queue.includes(id)) this.store.setQueue([id, ...this.store.queue]);
    this.pump();
    this.d.notify('info', this.d.limits.held() ? `"${t.title}" is queued: it starts after the usage limit resets.` : `"${t.title}" is queued: ${this.inFlight().length} task(s) already running (limit ${this.d.settings().maxParallel}). Raise "Tasks at once" in Settings to run more.`, id);
  },

  // Tasks still on their way to Done. Each holds its slot until merged, so with maxParallel 1 Run all builds every
  // task on the previous one's merged work. A project-root task is finished when its turn ends.
  inFlight(this: Runner) {
    return this.store.data.tasks.filter(t => {
      if (t.archived || t.status === 'done' || t.init) return false;
      if (this.sessions.get(t.id)?.open && this.sessions.get(t.id)!.state !== 'idle') return true;
      if (this.starting.has(t.id) || t.remote) return true;
      // Stopped on an error: nothing runs until you press Resume, so it must not hold the slot (a stopped task in
      // another sprint left ▶ Run only queueing, with nothing visible to wait for).
      if (t.error || t.noWait || this.stuck(t)) return false;
      return t.where !== 'direct' && !!t.worktree && (t.status === 'doing' || t.status === 'review');
    });
  },

  // Waiting for you after an automatic loop gave up (review or check rounds used up, conflicts, a review that could not
  // run): Run all goes on without it, and the card says what you can do.
  stuck(this: Runner, t: Task) {
    if (t.status !== 'review' || this.reviews.has(t.id) || this.checking.has(t.id) || this.isOpen(t.id)) return false;
    const set = this.d.settings(), r = t.review;
    return !!t.conflicts?.length
      || (t.checks?.state === 'fail' && t.checks.rounds > set.maxCheckRounds)
      || (r?.state === 'fail' && r.attempts >= roundLimit(r, set.review.maxAttempts))
      || (r?.state === 'error' && !(set.review.autoMerge && set.review.mergeIfCannotRun))
      || (r?.state === 'pass' && !!r.hold);
  },

  // What Run all waits for, for the toolbar.
  queueInfo(this: Runner) {
    const b = this.inFlight()[0];
    if (!b) return { queued: this.store.queue, blocker: undefined };
    const s = this.sessions.get(b.id), r = b.review, max = this.d.settings().review.maxAttempts;
    const why = s?.state === 'waiting' ? 'needs your answer'
      : s?.open && s.state !== 'idle' || this.starting.has(b.id) ? 'is working'
      : b.remote ? 'is open in Remote Control'
      : b.limited ? 'waits for the usage limit to reset'
      : b.error ? 'stopped on an error (Resume it)'
      : this.reviews.has(b.id) ? 'is being reviewed'
      : r?.state === 'pass' && r.hold ? `needs your approval (policy: ${r.hold})`
      : r?.state === 'pass' && r.risk === 'critical' && this.d.settings().review.autoMerge ? 'passed review but is flagged critical, so it is not merged automatically: open it and merge it yourself'
      : r?.state === 'pass' ? 'is ready to merge'
      : r?.state === 'fail' ? (r.attempts >= roundLimit(r, max) ? 'still has review issues' : 'is fixing review issues')
      : b.conflicts?.length ? 'has merge conflicts'
      : this.emptyAt.has(b.id) ? 'has a reply from Claude for you' : 'waits for review';
    return { queued: this.store.queue, blocker: { id: b.id, title: b.title, why } };
  },

  pumpSoon(this: Runner, ms = 300) {
    if (!this.store.queue.length) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.pump(), ms);
    this.pumpTimer.unref?.();
  },

  // The tasks this one waits for that are not done yet (deleted ones no longer count).
  waitsFor(this: Runner, t: Task) {
    return (t.dependsOn ?? []).map(d => this.store.task(d)).filter((d): d is Task => !!d && !d.archived && d.status !== 'done');
  },

  // The direct task (other than `except`) still working or waiting to be finished in the project folder.
  openDirect(this: Runner, except?: string) {
    return this.store.data.tasks.find(o => o.id !== except && o.where === 'direct' && !o.init && !o.archived && o.status !== 'done'
      && (o.directFiles?.length || this.starting.has(o.id) || this.sessions.get(o.id)?.open));
  },

  pump(this: Runner) {
    if (this.disposed || this.d.limits.held() || !this.holdsLease()) return;
    const q = [...this.store.queue];
    let slots = this.d.settings().maxParallel - this.inFlight().length, changed = false;
    const keep: string[] = [];
    while (slots > 0 && q.length) {
      const id = q.shift()!;
      changed = true;
      if (this.store.task(id)?.status !== 'todo') continue; // started by hand, moved or deleted meanwhile
      const next = this.store.task(id)!;
      if (next.where === 'direct' && !next.init && this.openDirect(id)) { keep.push(id); continue; } // one direct task at a time
      if (this.waitsFor(next).length) { keep.push(id); continue; } // its dependencies are not done yet
      slots--;
      this.run(id).catch(e => { this.d.notify('error', `${this.store.task(id)?.title ?? 'Task'}: ${e.message}`, id); });
    }
    if (changed) this.store.setQueue([...keep, ...q]);
  },
};
