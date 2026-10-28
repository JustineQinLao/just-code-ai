import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import * as g from './git';
import { Session, Answer, Ask, AgentNode, TurnEnd, RunState } from './session';
import { carryOver, discoverAgents, reviewPrompt, runReview, sessionExists, sessionSize, taskPrompt, adb, userAllowRules, addUsage, Usage } from './claude';
import * as A from './artifacts';
import { Limits, isLimitError } from './limits';

// One Runner per project: starts each task's Claude session in the task's own copy of the project (a git worktree on
// its own branch), moves cards as the work progresses (To do → Doing → Review → Done), runs the AI reviewer, merges,
// and keeps Run all's queue. Everything it starts it also stops: sessions close when idle, reviews time out, and every
// task copy is removed when its task is merged, discarded or deleted (orphans are pruned at startup).

const TEST_CMD = /\b(test|pytest|jest|vitest|spec|build|tsc|check|gradlew|playwright|screenshot|lint)\b/i;
const UI_FILE = /^\+\+\+ b\/.*\.(html?|css|scss|tsx|jsx|vue|svelte|xml|kt|java|swift|dart|component\.ts)$/m;

export interface RunnerSettings {
  maxParallel: number;
  taskModel: string;
  allowedTools: string[];
  worktreeCopy: string[];
  idleMinutes: number;
  personalSetup: boolean;   // load the user's own Claude setup (plugins, skills, MCP, memory) in tasks: ~7k more tokens per request
  freshAfterTokens: number; // a review-fix round starts a fresh session from the task's artifacts once the old one holds this much context
  review: { auto: boolean; model: string; lightModel: string; triage: boolean; maxAttempts: number; autoMerge: boolean; mergeIfCannotRun: boolean; commands: string[]; timeoutMinutes: number };
}

export interface RunnerDeps {
  bin(): string | undefined;
  env(): Record<string, string>;
  settings(): RunnerSettings;
  limits: Limits;
  notify(level: 'info' | 'warn' | 'error', text: string, taskId?: string): void;
  // A modal question; resolves to the chosen button, or undefined when dismissed.
  choose(text: string, ...buttons: string[]): Promise<string | undefined>;
  cli: string; // out/cli.js, for the reviewer's screenshot command
}

// What a card shows about its live work, beyond what board.json keeps.
export interface Live { run?: RunState; asks: Ask[]; agents: AgentNode[]; context: number; output: number; modeNote?: string; mode?: string; reviewing?: number; busy: boolean; queued: boolean }

export class Runner {
  private sessions = new Map<string, Session>();
  private starting = new Set<string>();
  private reviews = new Map<string, { ac: AbortController; started: number }>();
  private busy = new Set<string>();
  private errorSwept = new Set<string>(); // errored reviews the sweep already retried this window
  private emptyAt = new Set<string>(); // tasks whose branch had nothing to review at their last turn end
  private ev = new EventEmitter();
  private lock: Promise<unknown> = Promise.resolve();
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  private unsub: { dispose(): void };
  private disposed = false;

  constructor(readonly store: Store, private d: RunnerDeps) {
    // Finished or archived work has no running session, however it got there (Done, archive, sync, merge).
    this.unsub = store.onChange(() => {
      for (const [id] of this.sessions) {
        const t = this.store.task(id);
        if (!t || t.status === 'done' || t.archived) this.stop(id);
      }
      this.sweepSoon();
    });
    // A review that was running when the window closed never finished.
    for (const t of store.data.tasks) if (t.review?.state === 'running') store.updateTask(t.id, { review: undefined });
    setTimeout(() => void this.startup(), 1500).unref?.();
  }

  get root() { return this.store.root; }
  onChange(fn: () => void) { this.ev.on('change', fn); }
  private changed() { this.ev.emit('change'); }

  // One repo-changing git operation at a time per project (parallel runs would race on worktrees and refs).
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  live(id: string): Live {
    const s = this.sessions.get(id), r = this.reviews.get(id);
    return {
      run: this.starting.has(id) ? 'starting' : s?.open ? s.state : undefined,
      asks: s ? [...s.asks.values()] : [], agents: s ? [...s.agents.values()] : [],
      context: s?.context ?? 0, output: s?.output ?? 0, modeNote: s?.modeNote, mode: s?.mode,
      reviewing: r?.started, busy: this.busy.has(id), queued: this.store.queue.includes(id),
    };
  }
  steps(id: string) { return this.sessions.get(id)?.steps; }
  isOpen(id: string) { return !!this.sessions.get(id)?.open; }
  counts() {
    let running = 0, waiting = 0;
    for (const s of this.sessions.values()) if (s.open) s.state === 'waiting' ? waiting++ : s.state === 'running' && running++;
    return { running, waiting };
  }

  /* ---------- startup ---------- */

  private async startup() {
    // Task copies whose task no longer exists.
    const keep = new Set(this.store.data.tasks.filter(t => t.worktree).map(t => path.basename(t.worktree!)));
    if (await g.isRepo(this.root)) {
      const { removed, kept } = await this.serial(() => g.pruneOrphans(this.root, keep)).catch(() => ({ removed: [], kept: [] as string[] }));
      if (removed.length) this.d.notify('info', `Cleaned up ${removed.length} leftover task folder(s) in .justcode/worktrees.`);
      if (kept.length) this.d.notify('warn', `.justcode/worktrees has ${kept.length} folder(s) with uncommitted work that belong to no task: ${kept.join(', ')}. Check them, then delete them.`);
    }
    // Tasks that were mid-turn when the window closed continue where they stopped.
    for (const t of this.store.data.tasks) {
      if (!t.live || t.archived || t.status === 'done' || t.remote) continue;
      this.d.notify('info', `Continuing "${t.title}" where it stopped.`, t.id);
      void this.say(t.id, 'The editor restarted while you were working. Continue the task exactly where you stopped.').catch(e => this.fail(t.id, e));
    }
    this.pump();
    this.sweepSoon(500);
  }

  /* ---------- runs ---------- */

  async run(id: string, prompt?: string) {
    const t = this.store.task(id);
    if (!t || this.sessions.get(id)?.open || this.starting.has(id) || t.remote) return;
    if (this.d.limits.held()) throw new Error('Your Claude usage limit is reached. The task starts by itself after the reset.');
    const bin = this.d.bin();
    if (!bin) throw new Error('Claude Code is not installed or not found. Open JustCode: Check Setup.');
    this.starting.add(id); // claimed before the awaits, so Run all never double-starts a task
    this.changed();
    try {
      if (t.where === 'root') return await this.start(t, bin, this.root, {}, prompt);
      const prep = await this.prepare(t);
      if (!prep) return; // the user cancelled
      const note = prep.refreshed && t.sessionId && !prompt
        ? `JustCode brought the latest ${prep.base} into this task's folder. Re-check the files you rely on and continue the task.` : prompt;
      await this.start(t, bin, prep.worktree, { base: prep.base, branch: prep.branch, worktree: prep.worktree }, note);
    } catch (e) {
      this.fail(id, e);
      throw e;
    } finally {
      this.starting.delete(id);
      this.changed();
    }
  }

  // The task's own copy of the project. Asks before creating a git repo or committing the user's uncommitted files.
  private prepare(t: Task) {
    return this.serial(async () => {
      if (!await g.isRepo(this.root)) {
        const c = await this.d.choose(`${path.basename(this.root)} is not a git repository yet. JustCode gives every task its own branch, so it needs one. ` +
          'Create a local repository (no remote) and commit the current files? Secrets like .env, keys and node_modules are left out.', 'Create repository');
        if (!c) return;
        await g.ensureRepo(this.root);
      } else if (!await g.hasCommits(this.root)) await g.ensureRepo(this.root);
      const base = t.base ?? await g.currentBranch(this.root);
      if (base === 'HEAD') throw new Error('Your project folder is on a detached HEAD. Check out a branch first (git switch main).');
      if (!t.worktree && await g.currentBranch(this.root) === base) {
        const dirty = await g.dirtyFiles(this.root);
        if (dirty.length) {
          const c = await this.d.choose(`${dirty.length} file(s) in ${path.basename(this.root)} are not committed (${dirty.slice(0, 4).join(', ')}${dirty.length > 4 ? ', …' : ''}). ` +
            `The task works on a copy of what is committed on ${base}. Commit them first so the task sees them?`, 'Commit and run', 'Run without them');
          if (!c) return;
          if (c === 'Commit and run') {
            const snap = await g.snapshot(this.root);
            if (snap.skipped.length) this.d.notify('warn', `Left out of git (over 10 MB): ${snap.skipped.join(', ')}`);
          }
        }
      }
      const branch = t.branch ?? g.taskBranch(t.title, t.id);
      const worktree = t.worktree ?? g.worktreeDir(this.root, t.id);
      const copy = this.d.settings().worktreeCopy;
      await g.exclude(this.root, false, copy);
      await g.addWorktree(this.root, worktree, branch, base);
      g.copyEnvFiles(this.root, worktree, copy);
      const refreshed = await g.catchUp(worktree, base).catch(() => false);
      return { base, branch, worktree, refreshed };
    });
  }

  private async start(t: Task, bin: string, cwd: string, patch: Partial<Task>, prompt?: string) {
    const id = t.id;
    const sessionId = t.sessionId ?? randomUUID();
    const resume = !!t.sessionId && sessionExists(cwd, sessionId);
    // A fresh session gets the task itself (plus anything the board adds); a resumed one only the new message.
    if (!fs.existsSync(cwd)) throw new Error(`This task's folder is gone (${cwd}). Use Discard to start it over.`);
    const sources = A.loadSources(this.root);
    const first = resume ? (prompt ?? 'Continue the task.') : [taskPrompt(t, A.writeBrief(this.root, t, sources)), prompt].filter(Boolean).join('\n\n');
    const task = this.store.updateTask(id, { ...patch, sessionId, status: t.status === 'todo' ? 'doing' : t.status, error: undefined, live: true })!;
    const set = this.d.settings();
    const carry = carryOver(this.root, cwd);
    const personal = set.personalSetup ? [] : userAllowRules();
    const s = new Session({
      bin, cwd, sessionId, resume, mode: task.mode, model: set.taskModel || undefined, agent: task.agent,
      agents: carry.agents, settingsFile: carry.settingsFile, personal: set.personalSetup,
      // The task's artifacts folder (brief, handoff), its screenshots and any sources outside the project.
      addDirs: [...new Set([...carry.addDirs, A.taskDir(this.root, id), ...(task.images?.length ? [path.dirname(task.images[0])] : []), ...A.outsideDirs(this.root, sources)])],
      allowed: [...new Set([...set.allowedTools, ...personal, ...this.store.rules, ...(task.allow ?? []), `Edit(${A.handoffFile(this.root, id)})`, `Write(${A.handoffFile(this.root, id)})`])],
      rules: () => [...set.allowedTools, ...this.store.rules, ...(this.store.task(id)?.allow ?? [])],
      env: this.d.env(), idleMs: Math.max(1, set.idleMinutes) * 60_000, label: task.title,
    });
    this.sessions.set(id, s);
    s.on('change', () => this.changed());
    s.on('ask', a => { if (a.kind === 'plan' && a.plan) try { A.writePlan(this.root, id, a.plan); } catch { /* the card still shows it */ } });
    s.on('ask', a => this.d.notify('warn', `"${task.title}" needs you: ${a.kind === 'question' ? 'Claude has a question' : `${a.tool} ${a.detail}`.slice(0, 120)}`, id));
    s.onRules(rules => { this.store.addRules(rules); this.d.notify('info', `Approved for every task in ${path.basename(this.root)}: ${rules.join(', ')}`); });
    s.on('rate', info => this.d.limits.update(info));
    s.on('running', () => {
      const cur = this.store.task(id);
      if (cur?.status === 'review' && cur.where !== 'root' && !cur.init) this.store.updateTask(id, { status: 'doing', live: true });
      else if (cur && !cur.live) this.store.updateTask(id, { live: true });
    });
    s.on('turn', turn => void this.turnEnded(id, turn).catch(e => this.d.notify('error', e.message, id)));
    s.on('exit', error => {
      if (this.sessions.get(id) === s) this.sessions.delete(id);
      if (error && this.store.task(id)) this.fail(id, new Error(error));
      this.changed();
      this.pump();
    });
    try { await s.start(first); } catch (e) { this.sessions.delete(id); s.kill(); throw e; }
  }

  private fail(id: string, e: unknown) {
    const msg = String((e as any)?.message ?? e).slice(0, 600);
    if (!this.store.task(id)) return;
    if (isLimitError(msg)) { this.d.limits.setReached('usage'); this.store.updateTask(id, { limited: true }); return; }
    this.store.updateTask(id, { error: msg, live: undefined });
  }

  // A message for the task's Claude: into the open session, or a resumed one started with it.
  async say(id: string, text: string) {
    const s = this.sessions.get(id);
    if (s?.open && s.send(text)) { this.store.updateTask(id, { live: true, error: undefined }); return; }
    await this.run(id, text);
  }

  answer(id: string, a: Answer) { return this.sessions.get(id)?.answer(a) ?? false; }
  async setMode(id: string, mode: string) {
    this.store.updateTask(id, { mode: mode as Task['mode'] });
    await this.sessions.get(id)?.setMode(mode);
  }
  async interrupt(id: string) { await this.sessions.get(id)?.interrupt(); }

  // Ends the session (and Run all's claim on the task). Work stays in the task's folder; Resume continues it.
  stop(id: string) {
    this.store.setQueue(this.store.queue.filter(q => q !== id));
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    s?.kill();
    if (this.store.task(id)?.live) this.store.updateTask(id, { live: undefined });
    this.changed();
  }

  /* ---------- Remote Control hand-off ---------- */

  // The task leaves the board for a terminal running `claude --remote-control --resume <session>`, which shows it in
  // the Claude app and on claude.ai. Its session here is closed first: two processes must never share one session.
  async handoff(id: string) {
    const t = this.store.task(id);
    if (!t?.sessionId) throw new Error('Run the task first: there is no session to continue yet.');
    const s = this.sessions.get(id);
    if (s?.open) {
      await new Promise<void>(res => { s.on('exit', () => res()); s.close(); setTimeout(res, 5000).unref?.(); });
      this.sessions.delete(id);
    }
    this.store.updateTask(id, { remote: true, live: undefined, status: t.status === 'todo' ? 'doing' : t.status });
    this.changed();
    return { cwd: t.worktree && fs.existsSync(t.worktree) ? t.worktree : this.root, sessionId: t.sessionId, mode: t.mode };
  }

  // The Remote Control terminal closed: back on the board, its work committed and reviewed like any finished turn.
  async remoteEnded(id: string) {
    const t = this.store.task(id);
    if (!t?.remote) return;
    this.store.updateTask(id, { remote: undefined });
    await this.turnEnded(id, { ok: true, text: '' });
  }

  /* ---------- turn ends ---------- */

  private async turnEnded(id: string, turn: TurnEnd) {
    const t = this.store.task(id);
    if (!t) return;
    const cost = (t.costUsd ?? 0) + (turn.costUsd ?? 0);
    if (turn.usage) this.store.updateTask(id, { usage: { ...t.usage, build: addUsage(t.usage?.build as Usage | undefined, { input_tokens: turn.usage.input, output_tokens: turn.usage.output, cache_read_input_tokens: turn.usage.cacheRead, cache_creation_input_tokens: turn.usage.cacheWrite }) } });
    if (turn.limit || (this.d.limits.held() && !turn.ok)) {
      this.d.limits.setReached('usage');
      this.store.updateTask(id, { limited: true, costUsd: cost });
      this.d.notify('warn', `Claude's usage limit stopped "${t.title}". It continues by itself after the reset.`, id);
      return;
    }
    if (!turn.ok) {
      this.store.updateTask(id, { error: turn.error ?? 'Claude stopped on an error', live: undefined, costUsd: cost });
      this.d.notify('error', `"${t.title}" stopped: ${String(turn.error).slice(0, 200)}`, id);
      return this.pump();
    }
    let committed = false;
    if (t.worktree && fs.existsSync(t.worktree) && !t.conflicts?.length) {
      try { committed = await g.commitAll(t.worktree, t.title); } catch (e: any) {
        this.store.updateTask(id, { error: `Could not commit the task's changes: ${e.message}`, live: undefined, costUsd: cost });
        return this.d.notify('error', `"${t.title}": ${e.message}`, id);
      }
    }
    const reply = turn.text.trim().slice(-4000) || undefined;
    if (t.init) this.store.updateTask(id, { status: 'done', live: undefined, reply, costUsd: cost });
    else this.store.updateTask(id, { status: t.status === 'done' ? 'done' : 'review', live: undefined, reply, costUsd: cost });
    this.emptyAt.delete(id);
    if (!committed && t.worktree && !(await this.hasWork(id))) this.emptyAt.add(id); // Claude only answered: nothing to review
    this.changed();
    this.pump();
    const cur = this.store.task(id);
    if (cur?.status === 'review' && cur.branch && this.d.settings().review.auto && !this.emptyAt.has(id)) await this.review(id);
  }

  private async hasWork(id: string) {
    const t = this.store.task(id);
    if (!t?.worktree || !t.base) return false;
    return !!(await g.git(t.worktree, ['diff', '--stat', `${t.base}...HEAD`]).catch(() => '')).trim();
  }

  /* ---------- queue ---------- */

  runAll(ids: string[]) {
    const q = [...this.store.queue];
    for (const id of ids) if (!q.includes(id) && this.store.task(id)?.status === 'todo') q.push(id);
    this.store.setQueue(q);
    this.pump();
  }
  cancelQueue() { this.store.setQueue([]); }

  // Tasks still on their way to Done. Each holds its slot until merged, so with maxParallel 1 Run all builds every
  // task on the previous one's merged work. A project-root task is finished when its turn ends.
  private inFlight() {
    return this.store.data.tasks.filter(t => {
      if (t.archived || t.status === 'done' || t.init) return false;
      if (this.sessions.get(t.id)?.open && this.sessions.get(t.id)!.state !== 'idle') return true;
      if (this.starting.has(t.id) || t.remote) return true;
      return t.where !== 'root' && !!t.worktree && (t.status === 'doing' || t.status === 'review');
    });
  }

  // What Run all waits for, for the toolbar.
  queueInfo() {
    const b = this.inFlight()[0];
    if (!b) return { queued: this.store.queue, blocker: undefined };
    const s = this.sessions.get(b.id), r = b.review, max = this.d.settings().review.maxAttempts;
    const why = s?.state === 'waiting' ? 'needs your answer'
      : s?.open && s.state !== 'idle' || this.starting.has(b.id) ? 'is working'
      : b.remote ? 'is open in Remote Control'
      : b.limited ? 'waits for the usage limit to reset'
      : b.error ? 'stopped on an error (Resume it)'
      : this.reviews.has(b.id) ? 'is being reviewed'
      : r?.state === 'pass' ? 'is ready to merge'
      : r?.state === 'fail' ? (r.attempts >= max ? 'still has review issues' : 'is fixing review issues')
      : b.conflicts?.length ? 'has merge conflicts'
      : this.emptyAt.has(b.id) ? 'has a reply from Claude for you' : 'waits for review';
    return { queued: this.store.queue, blocker: { id: b.id, title: b.title, why } };
  }

  private pump() {
    if (this.disposed || this.d.limits.held()) return;
    const q = [...this.store.queue];
    let slots = this.d.settings().maxParallel - this.inFlight().length, changed = false;
    while (slots > 0 && q.length) {
      const id = q.shift()!;
      changed = true;
      if (this.store.task(id)?.status !== 'todo') continue; // started by hand, moved or deleted meanwhile
      slots--;
      this.run(id).catch(e => { this.d.notify('error', `${this.store.task(id)?.title ?? 'Task'}: ${e.message}`, id); });
    }
    if (changed) this.store.setQueue(q);
  }

  /* ---------- keeping cards moving ---------- */

  private sweepSoon(ms = 1500) {
    clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => void this.sweep(), ms);
    this.sweepTimer.unref?.();
  }

  // Nothing waits in Review for a click the board can do itself: an unreviewed branch is reviewed, and review issues
  // whose session had closed go back to Claude. One at a time, never during a usage limit.
  private async sweep() {
    const o = this.d.settings().review;
    if (this.disposed || this.sweeping || !o.auto || this.d.limits.held()) return;
    this.sweeping = true;
    try {
      for (const t of [...this.store.data.tasks]) {
        if (t.archived || t.status === 'done' || t.init || t.remote || !t.branch || !t.worktree || t.conflicts?.length || t.error || t.limited) continue;
        if (this.sessions.get(t.id)?.open && this.sessions.get(t.id)!.state !== 'idle') continue;
        if (this.reviews.has(t.id) || this.busy.has(t.id) || this.starting.has(t.id)) continue;
        if (t.status === 'review' && !t.review && !this.emptyAt.has(t.id) && await this.hasWork(t.id)) { await this.review(t.id); continue; }
        // A review that could not run before (e.g. before this setting existed, or the window closed): one more try,
        // then the automatic merge applies.
        if (t.status === 'review' && t.review?.state === 'error' && o.autoMerge && o.mergeIfCannotRun && !this.errorSwept.has(t.id) && !isLimitError(t.review.error ?? '')) {
          this.errorSwept.add(t.id);
          await this.review(t.id, true, 1);
          continue;
        }
        if (t.review?.state === 'fail' && t.review.issues?.length && t.review.attempts < o.maxAttempts && t.status === 'doing' && !this.isOpen(t.id)) {
          await this.sendIssues(t.id);
        }
      }
    } finally { this.sweeping = false; }
  }

  // The usage limit is over: tasks it cut short continue, failed reviews are retried, the queue restarts.
  afterReset() {
    for (const t of [...this.store.data.tasks]) {
      if (t.review?.state === 'error') this.store.updateTask(t.id, { review: undefined });
      if (!t.limited) continue;
      this.store.updateTask(t.id, { limited: undefined });
      void this.say(t.id, 'Your Claude usage limit has reset. Continue exactly where you stopped.').catch(e => this.d.notify('error', e.message, t.id));
    }
    this.pump();
    this.sweepSoon(500);
  }

  /* ---------- AI review ---------- */

  async sendIssues(id: string) {
    const t = this.store.task(id);
    if (!t?.review?.issues?.length) return;
    const set = this.d.settings(), max = set.review.maxAttempts;
    this.store.updateTask(id, { status: 'doing' });
    const issues = `The code reviewer found these issues (review ${t.review.attempts} of ${max}). Fix them, verify, update your handoff, then finish your turn:\n` +
      t.review.issues.map((x, i) => `${i + 1}. ${x}`).join('\n');
    // A long session re-sends its whole history on every step. Past the threshold, the fix round starts fresh from the
    // task's artifacts (brief, handoff, review) instead: same knowledge, a fraction of the context.
    const s = this.sessions.get(id);
    const big = set.freshAfterTokens > 0 && (s?.open ? s.context > set.freshAfterTokens
      : !!t.sessionId && sessionSize(t.worktree ?? this.root, t.sessionId) > set.freshAfterTokens * 6);
    if (big && t.sessionId) {
      this.stop(id);
      this.store.updateTask(id, { sessionId: undefined, pastSessions: [...(t.pastSessions ?? []), t.sessionId], status: 'doing' });
      await this.run(id, `This task was already built on this branch (see git diff ${t.base}...HEAD) and ${A.handoffFile(this.root, id)} ` +
        `describes it. The review is in ${A.reviewFile(this.root, id)}.\n\n${issues}`);
      return;
    }
    await this.say(id, issues);
  }

  // A read-only reviewer checks the branch. Fail: its issues go back to the task's Claude, and the new commit is
  // reviewed again, up to maxAttempts. Pass: ready to merge, or merged right away with autoMerge (unless critical).
  // A review that cannot run (timeout, crash, unreadable verdict) is retried once. If it still cannot run and merging
  // is automatic, the task is merged anyway (mergeIfReviewCannotRun), noted on the card: a broken reviewer never holds
  // the queue. A review that finds issues is never merged this way.
  async review(id: string, force = false, retry = 0): Promise<void> {
    const t = this.store.task(id), o = this.d.settings().review;
    const bin = this.d.bin();
    if (!t?.worktree || !t.base || !t.branch || t.conflicts?.length || this.reviews.has(id) || !bin) return;
    let after: 'retry' | 'merge' | undefined;
    const ac = new AbortController();
    this.reviews.set(id, { ac, started: Date.now() }); // synchronously: two triggers never start two reviewers
    this.changed();
    const shots = path.join(os.tmpdir(), 'justcode-reviews', id);
    try {
      const head = await g.git(t.worktree, ['rev-parse', 'HEAD']).catch(() => '');
      if (!force && t.review?.head === head && t.review.state !== 'error') return;
      const diff = await g.git(t.worktree, ['diff', `${t.base}...HEAD`]).catch(() => '');
      if (!diff.trim()) { this.emptyAt.add(id); return; }
      const attempts = t.review?.state === 'fail' ? t.review.attempts : 0;
      this.store.updateTask(id, { review: { state: 'running', attempts, head } });
      // Triage: docs-only diffs need no reviewer; small changes outside sensitive code get the lighter model.
      const tri = o.triage ? A.triage(diff) : { level: 'full' as const, why: '' };
      if (tri.level === 'none' && !force) {
        const v = { pass: true, issues: [], risk: 'minor' as const, tested: [] as string[] };
        this.store.updateTask(id, { review: { state: 'pass', attempts, head, risk: 'minor', level: 'none', why: tri.why } });
        A.writeReview(this.root, id, v, attempts + 1);
        this.reviews.delete(id);
        if (o.autoMerge) { await this.merge(id, true); return; }
        this.d.notify('info', `"${t.title}" needs no AI review (${tri.why}). Ready to merge.`, id);
        return;
      }
      const model = tri.level === 'light' && o.lightModel ? o.lightModel : o.model;
      this.store.updateTask(id, { review: { state: 'running', attempts, head, level: tri.level === 'none' ? 'full' : tri.level, why: tri.why } });
      const reviewer = discoverAgents(this.root).find(a => a.scope === 'project' && /review/i.test(a.name))?.name;
      fs.rmSync(shots, { recursive: true, force: true });
      fs.mkdirSync(shots, { recursive: true });
      const device = adb();
      const screenshots = () => { try { return fs.readdirSync(shots).filter(f => /\.(png|jpe?g)$/i.test(f)).map(f => path.join(shots, f)); } catch { return []; } };
      let brief = ''; try { brief = fs.readFileSync(A.briefFile(this.root, id), 'utf8').replace(/\n## When you finish[\s\S]*$/, '').trim(); } catch { /* none yet */ }
      try { brief += `\n\n## Approved plan\n${fs.readFileSync(A.planFile(this.root, id), 'utf8').slice(0, 6000)}`; } catch { /* no plan */ }
      const prompt = reviewPrompt(t, t.base, diff, { shots, adb: device, cli: this.d.cli, handoff: A.readHandoff(this.root, id), brief }) + (retry
        ? `\n\n## Your previous attempt did not finish (${t.review?.error ?? 'it stopped'})\nKeep it short: run only the tests for the changed code, never a dev server, watch mode or an interactive command, and give the verdict.` : '');
      let usage = this.store.task(id)?.usage?.review as Usage | undefined;
      const exec = async (p: string, resume?: string) => {
        const r = await runReview(p, { bin, cwd: t.worktree!, env: this.d.env(), model: model || undefined, agent: reviewer, signal: ac.signal, personal: this.d.settings().personalSetup,
          timeoutMs: o.timeoutMinutes * 60_000, onRate: info => this.d.limits.update(info), shots, extra: o.commands, adbBin: device?.bin, cli: this.d.cli, resume });
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
          !v.tested.some(c => TEST_CMD.test(c)) && 'you did not run any tests, type check or build',
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
        if (this.store.task(id)) this.store.updateTask(id, { review: { state: 'error', attempts, head, error: msg, screenshots: screenshots() } });
        if (isLimitError(msg) || msg === 'cancelled') return;
        if (retry < 1) { after = 'retry'; return; }
        if (o.autoMerge && o.mergeIfCannotRun) { after = 'merge'; return; }
        this.d.notify('error', `AI review of "${t.title}" could not run: ${msg}`, id);
        return;
      }
      const now = this.store.task(id);
      if (!now || now.status === 'done' || now.worktree !== t.worktree) return; // discarded, deleted or merged meanwhile
      A.writeReview(this.root, id, v, attempts + 1);
      const lv = { level: tri.level === 'none' ? 'full' as const : tri.level, why: tri.why };
      if (v.pass) {
        this.store.updateTask(id, { review: { ...lv, state: 'pass', attempts, head, risk: v.risk, issues: v.issues.length ? v.issues : undefined, screenshots: screenshots(), tested: v.tested } });
        this.reviews.delete(id);
        if (o.autoMerge && v.risk !== 'critical') { await this.merge(id, true); return; }
        this.d.notify('info', `"${t.title}" passed AI review${v.risk === 'critical' ? ' (flagged critical: look before merging)' : ''}. Ready to merge.`, id);
        return;
      }
      const n = attempts + 1;
      this.store.updateTask(id, { review: { ...lv, state: 'fail', attempts: n, head, issues: v.issues, risk: v.risk, screenshots: screenshots(), tested: v.tested } });
      this.reviews.delete(id);
      if (n >= o.maxAttempts) return this.d.notify('warn', `"${t.title}" failed AI review ${n} times. The issues are on the card.`, id);
      await this.sendIssues(id);
    } finally {
      if (this.reviews.get(id)?.ac === ac) this.reviews.delete(id);
      this.changed();
    }
    if (after === 'retry') return this.review(id, true, retry + 1);
    if (after === 'merge') {
      const err = this.store.task(id)?.review?.error;
      this.d.notify('warn', `The AI review of "${t.title}" could not run twice (${err}). Merged without a finished review, as set.`, id);
      this.store.updateTask(id, { review: { ...this.store.task(id)!.review!, unreviewed: true } });
      await this.merge(id, true);
    }
  }

  cancelReview(id: string) { this.reviews.get(id)?.ac.abort(); }

  /* ---------- review / merge ---------- */

  changes(id: string) {
    const t = this.store.task(id);
    if (!t?.worktree || !t.base || !fs.existsSync(t.worktree)) return Promise.resolve([]);
    return g.changes(t.worktree, t.base);
  }

  private async guarded<T>(id: string, fn: (t: Task) => Promise<T>) {
    const t = this.store.task(id);
    if (!t || this.busy.has(id)) return;
    this.busy.add(id);
    this.changed();
    try { return await this.serial(() => fn(t)); } catch (e: any) { this.d.notify('error', e.message, id); } finally { this.busy.delete(id); this.changed(); }
  }

  // Base is brought into the branch first, inside the task's folder; conflicts stop there, never in the user's checkout.
  merge(id: string, auto = false) {
    return this.guarded(id, async t => {
      if (t.where === 'root' || !t.worktree) { this.store.updateTask(id, { status: 'done' }); return; }
      if (!t.branch || !t.base) throw new Error('Nothing to merge yet');
      const s = this.sessions.get(id);
      if (s?.open && s.state !== 'idle') throw new Error('Claude is still working on this task. Wait for it to finish, or stop it.');
      this.stop(id);
      await g.commitAll(t.worktree, t.title);
      const conflicts = await g.syncWithBase(t.worktree, t.base);
      if (conflicts.length) {
        this.store.updateTask(id, { conflicts, status: 'review' });
        this.d.notify('warn', `"${t.title}" conflicts with ${t.base} in ${conflicts.length} file(s). Resolve them on the card, then merge again.`, id);
        return;
      }
      await g.mergeIntoBase(this.root, t.base, t.branch, `Merge ${t.branch}: ${t.title}`);
      try { A.appendProgress(this.root, t); } catch { /* progress is a convenience */ }
      await this.cleanup(t);
      this.store.updateTask(id, { status: 'done', conflicts: undefined, worktree: undefined, live: undefined });
      this.d.notify('info', `${auto ? 'Review passed, merged' : 'Merged'} "${t.title}" into ${t.base}.`);
    });
  }

  resolveWithClaude(id: string) {
    const t = this.store.task(id);
    if (!t?.conflicts?.length) return;
    return this.say(id, `Merging ${t.base} into this branch left conflicts in: ${t.conflicts.join(', ')}. ` +
      'Resolve every conflict keeping the intent of both sides, remove all conflict markers, and make sure it builds. Do not commit; JustCode does.');
  }

  markResolved(id: string) {
    return this.guarded(id, async t => {
      if (!t.worktree || !t.conflicts) return;
      const left = g.markersLeft(t.worktree, t.conflicts);
      if (left.length) throw new Error(`Conflict markers still in: ${left.join(', ')}`);
      if (await g.merging(t.worktree)) await g.finishResolve(t.worktree);
      this.store.updateTask(id, { conflicts: undefined });
      this.d.notify('info', `Conflicts resolved for "${t.title}". Merge it when ready.`);
    });
  }

  // Drops the branch and its work; the task goes back to To do with a fresh session next run.
  discard(id: string) {
    return this.guarded(id, async t => {
      await this.cleanup(t);
      A.removeTaskDir(this.root, id);
      this.store.updateTask(id, { status: 'todo', usage: undefined, branch: undefined, worktree: undefined, sessionId: undefined, conflicts: undefined, pr: undefined,
        review: undefined, error: undefined, live: undefined, reply: undefined, remote: undefined, limited: undefined });
    });
  }

  remotePr(id: string) {
    return this.guarded(id, async t => {
      if (!t.worktree || !t.branch || !t.base) throw new Error('Run the task first');
      await g.commitAll(t.worktree, t.title);
      const url = await g.openRemotePr(t.worktree, t.base, t.branch, t.title, t.description ?? '');
      this.store.updateTask(id, { pr: url });
    });
  }

  private async cleanup(t: Task) {
    this.stop(t.id);
    this.cancelReview(t.id);
    fs.rmSync(path.join(os.tmpdir(), 'justcode-reviews', t.id), { recursive: true, force: true });
    if (t.worktree) await g.removeWorktree(this.root, t.worktree);
    if (t.branch) await g.deleteBranch(this.root, t.branch).catch(() => { /* never created */ });
  }

  async remove(id: string) {
    const t = this.store.task(id);
    if (!t) return;
    await this.serial(() => this.cleanup(t)).catch(e => this.d.notify('error', e.message));
    fs.rmSync(path.join(this.root, '.justcode', 'attachments', id), { recursive: true, force: true });
    A.removeTaskDir(this.root, id);
    this.store.deleteTask(id);
  }

  // Closing the window: every Claude process this project started ends. Tasks that were mid-turn keep `live`, so the
  // next window continues them.
  dispose() {
    this.disposed = true;
    this.unsub.dispose();
    clearTimeout(this.sweepTimer);
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
    for (const r of this.reviews.values()) r.ac.abort();
    this.reviews.clear();
    this.store.dispose();
    this.ev.removeAllListeners();
  }
}
