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

// Runner methods: The AI review loop: review, send issues back, accept issues, one more round, and the sweep that keeps cards moving.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const reviewMethods = {
  sweepSoon(this: Runner, ms = 1500) {
    clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => void this.sweep(), ms);
    this.sweepTimer.unref?.();
  },

  // Nothing waits in Review for a click the board can do itself: an unreviewed branch is reviewed, and review issues
  // whose session had closed go back to Claude. One at a time, never during a usage limit.
  async sweep(this: Runner) {
    const o = this.d.settings().review;
    if (this.disposed || this.sweeping || !o.auto || this.d.limits.held() || !this.holdsLease()) return;
    this.sweeping = true;
    try {
      for (const t of [...this.store.data.tasks]) {
        if (t.archived || t.status === 'done' || t.init || t.remote || !t.branch || !t.worktree || t.conflicts?.length || t.error || t.limited) continue;
        if (this.sessions.get(t.id)?.open && this.sessions.get(t.id)!.state !== 'idle') continue;
        if (this.reviews.has(t.id) || this.busy.has(t.id) || this.starting.has(t.id) || this.checking.has(t.id)) continue;
        if (t.status === 'review' && !t.review && !this.emptyAt.has(t.id) && await this.hasWork(t.id)) {
          if (await this.check(t.id) !== 'fail') await this.review(t.id);  // the reviewer only sees work whose checks pass
          continue;
        }
        // A review that could not run before (e.g. before this setting existed, or the window closed): one more try,
        // then the automatic merge applies.
        if (t.status === 'review' && t.review?.state === 'error' && o.autoMerge && o.mergeIfCannotRun && !this.errorSwept.has(t.id) && !isLimitError(t.review.error ?? '')) {
          this.errorSwept.add(t.id);
          await this.review(t.id, true, 1);
          continue;
        }
        if (t.review?.state === 'fail' && openIssues(t.review).length && t.review.attempts < roundLimit(t.review, o.maxAttempts) && t.status === 'doing' && !this.isOpen(t.id)) {
          await this.sendIssues(t.id);
        }
      }
    } finally { this.sweeping = false; }
  },

  // The usage limit is over: tasks it cut short continue, failed reviews are retried, the queue restarts.
  afterReset(this: Runner) {
    for (const t of [...this.store.data.tasks]) {
      if (t.review?.state === 'error') this.store.updateTask(t.id, { review: undefined });
      if (!t.limited) continue;
      this.store.updateTask(t.id, { limited: undefined });
      void this.say(t.id, 'Your Claude usage limit has reset. Continue exactly where you stopped.').catch(e => this.d.notify('error', e.message, t.id));
    }
    this.pump();
    this.sweepSoon(500);
  },

  // Sends the open issues (or only the one with `key`) back to Claude for a fix round.
  async sendIssues(this: Runner, id: string, key?: string) {
    const t = this.store.task(id);
    const open = openIssues(t?.review).filter(i => !key || i.key === key);
    if (!t?.review || !open.length) return;
    const set = this.d.settings(), max = roundLimit(t.review, set.review.maxAttempts);
    this.store.updateTask(id, { status: 'doing' });
    const accepted = acceptedIssues(t.review);
    const issues = `The code reviewer found these issues (review ${t.review.attempts} of ${max}). Fix them, verify, update your handoff, then finish your turn. ` +
      `Do not give up on one because the environment blocks it (a service or Docker not running, a missing tool or browser, a command that failed): start it, fix the setup or find another way to do the check, and only then judge it impossible. ` +
      `If you leave one unfixed on purpose, say why in your final message: the reviewer reads it.\n` +
      open.map((x, i) => `${i + 1}. ${x.text}`).join('\n') +
      (accepted.length ? `\n\nThe user accepted these as they are; leave them:\n${accepted.map(a => `- ${a.text}`).join('\n')}` : '');
    // A long session re-sends its whole history on every step. Past the threshold, the fix round starts fresh from the
    // task's artifacts (brief, handoff, review) instead: same knowledge, a fraction of the context.
    const s = this.sessions.get(id);
    const big = set.freshAfterTokens > 0 && (s?.open ? s.context > set.freshAfterTokens
      : !!t.sessionId && sessionSize(t.worktree ?? this.root, t.sessionId) > set.freshAfterTokens * 6);
    if (big && t.sessionId) {
      this.stop(id);
      this.store.updateTask(id, { sessionId: undefined, pastSessions: [...(t.pastSessions ?? []), t.sessionId], status: 'doing' });
      await this.run(id, `This task was already built on this branch (see ${t.where === 'direct' ? `git diff ${t.startHead} -- ${(t.directFiles ?? []).join(' ')}` : `git diff ${t.base}...HEAD`}) and ${A.handoffFile(this.root, id)} ` +
        `describes it. The review is in ${A.reviewFile(this.root, id)}.\n\n${issues}`);
      return;
    }
    await this.say(id, issues);
  },

  // "1 more round" on a card whose review rounds are used up: this task gets one more, and the open issues go back.
  async moreRound(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t?.review || t.review.state !== 'fail') return;
    this.store.updateTask(id, { review: { ...t.review, extraRounds: (t.review.extraRounds ?? 0) + 1 } });
    await this.sendIssues(id);
  },

  // You decided these issues do not block the merge. With every issue accepted the review counts as passed;
  // `merge` then merges (branch task) or finishes (direct task) right away.
  async acceptIssues(this: Runner, id: string, keys: string[] | 'all', merge = false, by: Audit.Actor = 'user') {
    const t = this.store.task(id);
    if (!t?.review?.issues?.length) return;
    const issues = t.review.issues.map(i => keys === 'all' || keys.includes(i.key) ? { ...i, accepted: true } : i);
    const now = issues.filter((i, n) => i.accepted && !t.review!.issues![n].accepted);
    this.audit(merge ? 'review.override' : 'review.accept', id, now.map(i => i.text.slice(0, 160)).join(' | '), by);
    const done = !issues.some(i => !i.accepted) && t.review.state === 'fail';
    this.store.updateTask(id, { review: { ...t.review, issues, ...(done ? { state: 'pass' as const } : {}) }, ...(done && t.status === 'doing' && !this.isOpen(id) ? { status: 'review' as const } : {}) });
    this.changed();
    if (merge && done) await this.merge(id, false, by);
  },

  // A read-only reviewer checks the branch. Fail: its issues go back to the task's Claude, and the new commit is
  // reviewed again, up to maxAttempts. Pass: ready to merge, or merged right away with autoMerge (unless critical).
  // A review that cannot run (timeout, crash, unreadable verdict) is retried once. If it still cannot run and merging
  // is automatic, the task is merged anyway (mergeIfReviewCannotRun), noted on the card: a broken reviewer never holds
  // the queue. A review that finds issues is never merged this way.
  async review(this: Runner, id: string, force = false, retry = 0): Promise<void> {
    const t = this.store.task(id), o = this.d.settings().review;
    const bin = this.d.bin();
    const direct = t?.where === 'direct' && !t.init;
    if (!t || (direct ? !t.startHead || !t.directFiles?.length : (!t.worktree || !t.base || !t.branch)) || t.conflicts?.length || this.reviews.has(id) || !bin) return;
    const cwd = direct ? this.root : t.worktree!;
    this.requireLease();
    let after: 'retry' | 'merge' | undefined;
    const ac = new AbortController();
    this.reviews.set(id, { ac, started: Date.now() }); // synchronously: two triggers never start two reviewers
    this.changed();
    const shots = path.join(os.tmpdir(), 'justcode-reviews', id);
    try {
      const diff = direct ? await g.workingDiff(cwd, t.startHead!, t.directFiles!) : await g.git(cwd, ['diff', `${t.base}...HEAD`]).catch(() => '');
      const head = direct ? sha(diff) : await g.git(cwd, ['rev-parse', 'HEAD']).catch(() => '');
      if (!force && t.review?.head === head && t.review.state !== 'error') return;
      if (!diff.trim()) { this.emptyAt.add(id); return; }
      const attempts = t.review?.state === 'fail' ? t.review.attempts : 0;
      // Accepted issues and extra rounds belong to the task, not to one review: every new review keeps them.
      const keep = { extraRounds: t.review?.extraRounds, issues: t.review?.issues };
      const fixNote = t.review?.state === 'fail' && t.reply ? t.reply.slice(-1000) : undefined;
      this.store.updateTask(id, { review: { ...keep, state: 'running', attempts, head } });
      // Triage: docs-only diffs need no reviewer; small changes outside sensitive code get the lighter model.
      const tri = o.triage ? A.triage(diff) : { level: 'full' as const, why: '' };
      if (tri.level === 'none' && !force) {
        const v = { pass: true, issues: [], risk: 'minor' as const, tested: [] as string[] };
        this.store.updateTask(id, { review: { ...keep, state: 'pass', attempts, head, risk: 'minor', level: 'none', why: tri.why } });
        this.audit('review.pass', id, `no review needed: ${tri.why}`, 'review');
        A.writeReview(this.root, id, v, attempts + 1);
        this.reviews.delete(id);
        if (o.autoMerge) { await this.merge(id, true); return; }
        this.d.notify('info', `"${t.title}" needs no AI review (${tri.why}). Ready to merge.`, id, true);
        return;
      }
      const model = tri.level === 'light' && o.lightModel ? o.lightModel : o.model;
      const effort = tri.level === 'light' ? 'low' : o.effort;
      this.store.updateTask(id, { review: { ...keep, state: 'running', attempts, head, level: tri.level === 'none' ? 'full' : tri.level, why: tri.why } });
      const reviewer = discoverAgents(this.root).find(a => a.scope === 'project' && /review/i.test(a.name))?.name;
      fs.rmSync(shots, { recursive: true, force: true });
      fs.mkdirSync(shots, { recursive: true });
      const device = adb();
      const screenshots = () => { try { return fs.readdirSync(shots).filter(f => /\.(png|jpe?g)$/i.test(f)).map(f => path.join(shots, f)); } catch { return []; } };
      let brief = ''; try { brief = fs.readFileSync(A.briefFile(this.root, id), 'utf8').replace(/\n## When you finish[\s\S]*$/, '').trim(); } catch { /* none yet */ }
      try { brief += `\n\n## Approved plan\n${fs.readFileSync(A.planFile(this.root, id), 'utf8').slice(0, 6000)}`; } catch { /* no plan */ }
      const passed = this.store.task(id)?.checks?.state === 'pass' ? this.store.task(id)!.checks!.results!.filter(r => r.ok).map(r => r.cmd) : [];
      const prompt = reviewPrompt(t, t.base ?? t.startHead ?? 'HEAD', diff, { shots, adb: device, cli: this.d.cli, web: UI_FILE.test(diff) && !device?.devices.length, handoff: A.readHandoff(this.root, id), brief, checks: passed,
        accepted: acceptedIssues(t.review).map(i => i.text), fixNote }) + (retry
        ? `\n\n## Your previous attempt did not finish (${t.review?.error ?? 'it stopped'})\nKeep it short: run only the tests for the changed code, never a dev server, watch mode or an interactive command, and give the verdict.` : '');
      let usage = this.store.task(id)?.usage?.review as Usage | undefined;
      const exec = async (p: string, resume?: string) => {
        const r = await runReview(p, { bin, cwd, env: this.d.env(), model: model || undefined, effort: effort || undefined, agent: reviewer, signal: ac.signal, personal: this.d.settings().personalSetup, plugins: this.plugins(),
          timeoutMs: o.timeoutMinutes * 60_000, onRate: info => this.d.limits.update(info), shots, extra: o.commands, web: UI_FILE.test(diff) && !device?.devices.length, adbBin: device?.bin, cli: this.d.cli, resume });
        if (r.costUsd) { const cur = this.store.task(id); if (cur) this.store.updateTask(id, { costUsd: (cur.costUsd ?? 0) + r.costUsd }); }
        if (r.usage) {
          usage = addUsage(usage, { input_tokens: r.usage.input, output_tokens: r.usage.output, cache_read_input_tokens: r.usage.cacheRead, cache_creation_input_tokens: r.usage.cacheWrite });
          const cur = this.store.task(id);
          if (cur) this.store.updateTask(id, { usage: { ...cur.usage, review: usage } });
        }
        return r;
      };
      let v;
      try {
        const first = await exec(prompt);
        v = first.verdict;
        // A review that only read the code (or skipped a screenshot it could take) is sent back once to actually test.
        const missing = [
          !passed.length && !v.tested.some(c => TEST_CMD.test(c)) && 'you did not run any tests, type check or build',
          device?.devices.length && UI_FILE.test(diff) && !screenshots().length && 'an Android device is connected and the diff changes UI files, but you took no screenshot',
        ].filter(Boolean);
        // The follow-up continues the reviewer's own session (its context is cached) instead of reviewing from scratch.
        if (missing.length && !ac.signal.aborted) {
          const follow = `Your review was incomplete: ${missing.join('; ')}. Do it now (or say in "tested" why it is impossible), then give the verdict again.`;
          v = (await exec(first.sessionId ? follow : `${prompt}\n\n## ${follow}`, first.sessionId)).verdict;
        }
      } catch (e: any) {
        // The reviewer could not run (cancelled, limit, timeout, bad output). Not a verdict: nothing goes to Claude to "fix".
        if (ac.signal.aborted && !this.store.task(id)) return;
        const msg = String(e.message ?? e).slice(0, 400);
        if (isLimitError(msg)) this.d.limits.setReached('usage');
        if (this.store.task(id)) this.store.updateTask(id, { review: { ...keep, state: 'error', attempts, head, error: msg, screenshots: screenshots() } });
        if (isLimitError(msg) || msg === 'cancelled') return;
        if (retry < 1) { after = 'retry'; return; }
        if (o.autoMerge && o.mergeIfCannotRun) { after = 'merge'; return; }
        this.d.notify('error', `AI review of "${t.title}" could not run: ${msg}`, id);
        return;
      }
      const now = this.store.task(id);
      if (!now || now.status === 'done' || now.worktree !== t.worktree) return; // discarded, deleted or merged meanwhile
      A.writeReview(this.root, id, v, attempts + 1);
      const lv = { level: tri.level === 'none' ? 'full' as const : tri.level, why: tri.why, extraRounds: keep.extraRounds, fixNote };
      const tracked = trackIssues(keep.issues, v.issues);
      // Only accepted issues left: the reviewer agrees with you, so this counts as a pass.
      if (!v.pass && !tracked.some(i => !i.accepted)) v = { ...v, pass: true };
      if (v.pass) {
        this.store.updateTask(id, { review: { ...lv, state: 'pass', attempts, head, risk: v.risk, issues: tracked.length ? tracked : undefined, screenshots: screenshots(), tested: v.tested } });
        this.audit('review.pass', id, `round ${attempts + 1}, risk ${v.risk}`, 'review');
        this.reviews.delete(id);
        if (o.autoMerge && v.risk !== 'critical') { await this.merge(id, true); return; }
        this.d.notify('info', `"${t.title}" passed AI review${v.risk === 'critical' ? ' (flagged critical: look before merging)' : ''}. Ready to merge.`, id, true);
        return;
      }
      const n = attempts + 1;
      const review = { ...lv, state: 'fail' as const, attempts: n, head, issues: tracked, risk: v.risk, screenshots: screenshots(), tested: v.tested };
      this.store.updateTask(id, { review });
      this.audit('review.fail', id, `round ${n}: ${openIssues(review).length} open issue(s)`, 'review');
      this.reviews.delete(id);
      if (n >= roundLimit(review, o.maxAttempts)) return this.d.notify('warn', `"${t.title}": ${openIssues(review).length} review issue(s) left after ${n} rounds. Open the card to see them, accept them, try once more or discard.`, id, true);
      await this.sendIssues(id);
    } finally {
      if (this.reviews.get(id)?.ac === ac) this.reviews.delete(id);
      this.changed();
    }
    if (after === 'retry') return this.review(id, true, retry + 1);
    if (after === 'merge') {
      const err = this.store.task(id)?.review?.error;
      this.d.notify('warn', `The AI review of "${t.title}" could not run twice (${err}). Merged without a finished review, as set.`, id, true);
      this.store.updateTask(id, { review: { ...this.store.task(id)!.review!, unreviewed: true } });
      await this.merge(id, true);
    }
  },

  cancelReview(this: Runner, id: string) { this.reviews.get(id)?.ac.abort(); },
};
