import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import * as g from './git';
import { setupSkillBody } from './skill';
import { Session, Answer, Ask, AgentNode, TurnEnd, RunState } from './session';
import { carryOver, discoverAgents, reviewPrompt, runReview, sessionExists, sessionSize, taskPrompt, adb, userAllowRules, addUsage, Usage, PLANNER_APPEND, plannerFirst, parseProposals, RefineResult, artifactBrief, frontendDesignPlugin } from './claude';
import * as A from './artifacts';
import { ensurePlugin, pluginDir } from './plugin';
import * as C from './checks';
import { Limits, isLimitError } from './limits';

// One Runner per project: starts each task's Claude session in the task's own copy of the project (a git worktree on
// its own branch), moves cards as the work progresses (To do → Doing → Review → Done), runs the AI reviewer, merges,
// and keeps Run all's queue. Everything it starts it also stops: sessions close when idle, reviews time out, and every
// task copy is removed when its task is merged, discarded or deleted (orphans are pruned at startup).

// The folder where checks run on the base branch, to tell failures a task caused from ones it found.
const BASELINE = '_base';

const TEST_CMD = /\b(test|pytest|jest|vitest|spec|build|tsc|check|gradlew|playwright|screenshot|lint)\b/i;
const UI_FILE = /^\+\+\+ b\/.*\.(html?|css|scss|tsx|jsx|vue|svelte|xml|kt|java|swift|dart|component\.ts)$/m;

export interface RunnerSettings {
  maxParallel: number;
  taskModel: string;
  allowedTools: string[];
  worktreeCopy: string[];
  idleMinutes: number;
  bypassAll?: boolean;   // justCode.bypassAll: every task runs with bypassPermissions
  personalSetup: boolean;   // load the user's own Claude setup (plugins, skills, MCP, memory) in tasks: ~7k more tokens per request
  taskEffort: string; plannerModel: string; plannerEffort: string; subagents: boolean;
  freshAfterTokens: number;
  checks: string;           // 'auto', '' (off) or commands, one per line
  setup: string;            // task folder setup: 'auto', '' (off) or a command
  maxCheckRounds: number;   // failing-check rounds sent back to Claude before it waits for you
  checkTimeoutMinutes: number; // a review-fix round starts a fresh session from the task's artifacts once the old one holds this much context
  review: { auto: boolean; model: string; effort: string; lightModel: string; triage: boolean; maxAttempts: number; autoMerge: boolean; mergeIfCannotRun: boolean; commands: string[]; timeoutMinutes: number };
}

export interface RunnerDeps {
  version?: string;   // the extension's version: the JustCode plugin is rewritten when its plugin.json differs
  bin(): string | undefined;
  env(): Record<string, string>;
  settings(): RunnerSettings;
  limits: Limits;
  // toast: show a VS Code notification (errors always do). Everything else only goes to the JustCode output log,
  // so notifications are kept for things you can act on.
  notify(level: 'info' | 'warn' | 'error', text: string, taskId?: string, toast?: boolean): void;
  // A modal question; resolves to the chosen button, or undefined when dismissed.
  choose(text: string, ...buttons: string[]): Promise<string | undefined>;
  cli: string; // out/cli.js, for the reviewer's screenshot command
  // Publishes an artifact task's page (needs an interactive claude: the Agent SDK cannot publish artifacts).
  publish?(id: string): void;
  // Saves a local copy of every claude.ai artifact source that has none yet (links in `text` are added as sources
  // first), so plans and tasks build on the real page. Resolves when the copies are saved or could not be.
  saveSources?(text: string): Promise<void>;
}

// What a card shows about its live work, beyond what board.json keeps.
export interface Live { phase?: string; run?: RunState; asks: Ask[]; agents: AgentNode[]; context: number; output: number; modeNote?: string; mode?: string; modelUsed?: string; reviewing?: number; busy: boolean; queued: boolean }

/** The mode a task actually runs with: bypass-all forces bypassPermissions. */
export const effectiveMode = <M,>(mode: M, bypassAll?: boolean): M | 'bypassPermissions' => bypassAll ? 'bypassPermissions' : mode;

const LEASE_MS = 2 * 60_000;

export class Runner {
  private sessions = new Map<string, Session>();
  private starting = new Set<string>();
  private reviews = new Map<string, { ac: AbortController; started: number }>();
  private busy = new Set<string>();
  private checking = new Set<string>();   // tasks whose checks are running now: no review, merge or cleanup meanwhile
  private errorSwept = new Set<string>(); // errored reviews the sweep already retried this window
  private emptyAt = new Set<string>();
  private phase = new Map<string, string>(); // what JustCode itself is doing for a task: setting up, running checks
  private setPhase(id: string, text?: string) { if (text) this.phase.set(id, text); else this.phase.delete(id); this.changed(); } // tasks whose branch had nothing to review at their last turn end
  private ev = new EventEmitter();
  private lock: Promise<unknown> = Promise.resolve();
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  private unsub: { dispose(): void };
  private disposed = false;
  private leading = false;
  private leaseTimer?: NodeJS.Timeout;

  // The JustCode plugin (skills, agents) every session loads, rewritten first if it is missing or from another version.
  private plugins(extra: Array<string | undefined> = []) {
    try { ensurePlugin(this.root, this.d.version ?? '0.0.0'); } catch { /* a read-only folder: sessions still run */ }
    return [pluginDir(this.root), ...extra.filter((p): p is string => !!p)];
  }

  constructor(readonly store: Store, private d: RunnerDeps) {
    this.plugins();
    // Finished or archived work has no running session, however it got there (Done, archive, sync, merge).
    this.unsub = store.onChange(() => {
      for (const [id] of this.sessions) {
        const t = this.store.task(id);
        if (!t || t.status === 'done' || t.archived) this.stop(id);
      }
      this.sweepSoon();
      // A slot may have opened (merged, done, archived, deleted, discarded), however it happened: Run all continues.
      // Before, the queue only moved when the merged task's Claude process exited, so a task whose process had
      // already closed (idle during a long review) left the queue stuck.
      this.pumpSoon();
    });
    setTimeout(() => this.renewLease(), 1500).unref?.();
    this.leaseTimer = setInterval(() => this.renewLease(), LEASE_MS / 4);
    this.leaseTimer.unref?.();
  }

  /* ---------- one window per project ---------- */

  // Two windows on one project each ran checks, reviews and merges on the same task, and neither saw the other's
  // running checks: one merged and removed the folder the other was still testing. So only the window holding this
  // lease runs tasks and the automation. It passes on when that window closes, or stops renewing after a crash.
  private get leaseFile() { return path.join(this.root, '.justcode', 'runner.lock'); }

  private holdsLease() {
    if (this.disposed) return false;
    const file = this.leaseFile;
    const mine = String(process.pid);
    try {
      const owner = fs.readFileSync(file, 'utf8').trim();
      if (owner === mine) { const now = new Date(); fs.utimesSync(file, now, now); return true; }
      let alive = Date.now() - fs.statSync(file).mtimeMs < LEASE_MS;
      if (alive) try { process.kill(Number(owner), 0); } catch (e: any) { alive = e.code === 'EPERM'; }
      if (alive) return false;
      fs.rmSync(file, { force: true });
    } catch { /* no lease yet */ }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return true;
    } catch { return false; } // another window took it first
  }

  private renewLease() {
    const was = this.leading;
    this.leading = this.holdsLease();
    if (this.leading && !was) void this.startup();
  }

  private requireLease() {
    if (!this.holdsLease()) throw new Error('Another window is running JustCode for this project. Use that window, or close it and try again.');
    if (!this.leading) this.renewLease();
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
      phase: this.phase.get(id),
      run: this.starting.has(id) ? 'starting' : s?.open ? s.state : undefined,
      asks: s ? [...s.asks.values()] : [], agents: s ? [...s.agents.values()] : [],
      context: s?.context ?? 0, output: s?.output ?? 0, modeNote: s?.modeNote, mode: s?.mode, modelUsed: s?.model,
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
    // A review that was running when the window closed never finished.
    for (const t of this.store.data.tasks) if (t.review?.state === 'running' && !this.reviews.has(t.id)) this.store.updateTask(t.id, { review: undefined });
    for (const t of [...this.store.data.tasks]) await this.settleMerged(t);
    // Task copies whose task no longer exists.
    const keep = new Set([...this.store.data.tasks.filter(t => t.worktree).map(t => path.basename(t.worktree!)), BASELINE]);
    if (await g.isRepo(this.root)) {
      const { removed, kept } = await this.serial(() => g.pruneOrphans(this.root, keep)).catch(() => ({ removed: [], kept: [] as string[] }));
      if (removed.length) this.d.notify('info', `Cleaned up ${removed.length} leftover task folder(s) in .justcode/worktrees.`);
      if (kept.length) this.d.notify('warn', `.justcode/worktrees has ${kept.length} folder(s) with uncommitted work that belong to no task: ${kept.join(', ')}. Check them, then delete them.`, undefined, true);
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

  // Merged earlier, then sent back to work by a late check result (a second window, an older version). Its work is
  // already on base, so Resume must not build a new folder for it: the card goes to Done. true = it was that case.
  private async settleMerged(t: Task) {
    if (t.status === 'done' || !t.doneAt || t.worktree || !t.branch || !t.base || this.sessions.get(t.id)?.open) return false;
    const branch = `refs/heads/${t.branch}`;
    const gone = !await g.git(this.root, ['rev-parse', '--verify', '--quiet', branch]).then(() => true, () => false);
    if (!gone && !await g.git(this.root, ['merge-base', '--is-ancestor', branch, t.base]).then(() => true, () => false)) return false;
    if (!gone) await this.serial(() => g.deleteBranch(this.root, t.branch!)).catch(() => undefined);
    this.store.updateTask(t.id, { status: 'done', error: undefined, live: undefined, checks: undefined });
    return true;
  }

  async run(id: string, prompt?: string) {
    const t = this.store.task(id);
    if (!t || this.sessions.get(id)?.open || this.starting.has(id) || t.remote) return;
    this.requireLease();
    if (t.noWait) this.store.updateTask(id, { noWait: undefined });
    if (await this.settleMerged(t)) return;
    if (this.d.limits.held()) throw new Error('Your Claude usage limit is reached. The task starts by itself after the reset.');
    const bin = this.d.bin();
    if (!bin) throw new Error('Claude Code is not installed or not found. Open JustCode: Check Setup.');
    // One direct task at a time, decided before any await: the first claim wins, a second one is refused.
    if (t.where === 'direct' && !t.init) {
      if (this.store.data.tasks.some(o => o.id !== id && o.where === 'direct' && !o.init && !o.archived && o.status !== 'done' && (this.starting.has(o.id) || this.sessions.get(o.id)?.open)))
        throw new Error('Another task is already working in the project folder. Wait for it to finish, or run this one on its own branch.');
      if (this.busy.size) throw new Error('A merge is running. Start this task in the project folder when it finishes.');
    }
    this.starting.add(id); // claimed before the awaits, so Run all never double-starts a task
    this.changed();
    try {
      if (this.d.saveSources) {
        this.setPhase(id, 'Saving claude.ai sources locally…');
        const text = [t.title, t.description, prompt].filter(Boolean).join('\n');
        try { await this.d.saveSources(text); } finally { this.setPhase(id); }
        this.useLinkedSources(t.sprintId, text);
      }
      if (t.where === 'direct') {
        const patch: Partial<Task> = {};
        if (!t.startHead) {
          patch.startHead = await g.git(this.root, ['rev-parse', 'HEAD']).catch(() => '');
          const before = await g.dirtyFiles(this.root).catch(() => [] as string[]);
          fs.mkdirSync(A.taskDir(this.root, id), { recursive: true });
          fs.writeFileSync(path.join(A.taskDir(this.root, id), 'dirty-before.txt'), before.join('\n'));
        }
        return await this.start(t, bin, this.root, patch, prompt);
      }
      const prep = await this.prepare(t);
      if (!prep) return; // the user cancelled
      if (prep.fresh) await this.setupFolder(id, prep.worktree);
      const note = prep.refreshed && t.sessionId && !prompt
        ? `JustCode brought the latest ${prep.base} into this task's folder. Re-check the files you rely on and continue the task.` : prompt;
      await this.start(t, bin, prep.worktree, { base: prep.base, branch: prep.branch, worktree: prep.worktree }, note);
    } catch (e) {
      // The card shows it; one notification, however the run was started.
      this.fail(id, e);
      const error = this.store.task(id)?.error;
      if (error) this.d.notify('error', `"${t.title}" stopped: ${error}`, id, true);
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
      // A sprint task starts from the sprint's branch; the sprint's first task cuts it from the branch you are on.
      const current = await g.currentBranch(this.root);
      let sprint = t.sprintId && !t.worktree ? this.store.sprint(t.sprintId) : undefined;
      if (sprint?.closed) sprint = undefined;
      if (sprint?.branch && !await g.branchExists(this.root, sprint.branch)) {
        this.store.updateSprint(sprint.id, { branch: undefined, target: undefined }); // deleted by hand: start it again
        sprint = this.store.sprint(sprint.id);
      }
      const from = sprint ? sprint.branch ?? current : t.base ?? current;
      if (from === 'HEAD') throw new Error('Your project folder is on a detached HEAD. Check out a branch first (git switch main).');
      if (!t.worktree && current === from) {
        const dirty = await g.dirtyFiles(this.root);
        if (dirty.length) {
          const c = await this.d.choose(`${dirty.length} file(s) in ${path.basename(this.root)} are not committed (${dirty.slice(0, 4).join(', ')}${dirty.length > 4 ? ', …' : ''}). ` +
            `The task works on a copy of what is committed on ${from}. Commit them first so the task sees them?`, 'Commit and run', 'Run without them');
          if (!c) return;
          if (c === 'Commit and run') {
            const snap = await g.snapshot(this.root);
            if (snap.skipped.length) this.d.notify('warn', `Left out of git (over 10 MB): ${snap.skipped.join(', ')}`);
          }
        }
      }
      let base = from;
      if (sprint && !sprint.branch) {
        base = g.sprintBranch(sprint.name, sprint.id);
        if (!await g.branchExists(this.root, base)) await g.git(this.root, ['branch', base, from]);
        this.store.updateSprint(sprint.id, { branch: base, target: from });
        this.d.notify('info', `${sprint.name} works on its own branch ${base}. Its tasks merge there; when the last one merges, ${base} merges into ${from}.`);
      }
      const branch = t.branch ?? g.taskBranch(t.title, t.id);
      const worktree = t.worktree ?? g.worktreeDir(this.root, t.id);
      const copy = this.d.settings().worktreeCopy;
      await g.exclude(this.root, false, copy);
      const fresh = !fs.existsSync(path.join(worktree, '.git'));
      await g.addWorktree(this.root, worktree, branch, base);
      g.copyEnvFiles(this.root, worktree, copy);
      const refreshed = await g.catchUp(worktree, base).catch(() => false);
      return { base, branch, worktree, refreshed, fresh };
    });
  }

  private async start(t: Task, bin: string, cwd: string, patch: Partial<Task>, prompt?: string) {
    const id = t.id;
    const sessionId = t.sessionId ?? randomUUID();
    const resume = !!t.sessionId && sessionExists(cwd, sessionId);
    // A fresh session gets the task itself (plus anything the board adds); a resumed one only the new message.
    if (!fs.existsSync(cwd)) throw new Error(`This task's folder is gone (${cwd}). Use Discard to start it over.`);
    const sources = A.sprintSources(A.loadSources(this.root), t.sprintId ? this.store.data.sprints.find(x => x.id === t.sprintId) : undefined);
    const first = resume ? (prompt ?? 'Continue the task.') : [taskPrompt(t, A.writeBrief(this.root, t, sources)), t.init ? setupSkillBody() : '', t.output === 'artifact' ? artifactBrief(A.artifactFile(this.root, id), !!frontendDesignPlugin()) : '', prompt].filter(Boolean).join('\n\n');
    const task = this.store.updateTask(id, { ...patch, sessionId, status: t.status === 'todo' ? 'doing' : t.status, error: undefined, live: true, startedAt: t.startedAt ?? Date.now() })!;
    const set = this.d.settings();
    const carry = carryOver(this.root, cwd);
    const personal = set.personalSetup ? [] : userAllowRules();
    const s = new Session({
      bin, cwd, sessionId, resume, mode: effectiveMode(task.mode, set.bypassAll), model: set.taskModel || undefined, effort: set.taskEffort || undefined, subagents: set.subagents, agent: task.agent,
      agents: carry.agents, settingsFile: carry.settingsFile, personal: set.personalSetup,
      plugins: this.plugins(task.output === 'artifact' && !set.personalSetup ? [frontendDesignPlugin()] : []),
      // The task's artifacts folder (brief, handoff), its screenshots and any sources outside the project.
      addDirs: [...new Set([...carry.addDirs, A.taskDir(this.root, id), ...(task.images?.length ? [path.dirname(task.images[0])] : []), ...A.outsideDirs(this.root, sources)])],
      allowed: [...new Set([...set.allowedTools, ...personal, ...this.store.rules, ...(task.allow ?? []), `Edit(${A.handoffFile(this.root, id)})`, `Write(${A.handoffFile(this.root, id)})`])],
      rules: () => [...set.allowedTools, ...this.store.rules, ...(this.store.task(id)?.allow ?? [])],
      env: this.folderEnv(id, cwd), idleMs: Math.max(1, set.idleMinutes) * 60_000, label: task.title,
    });
    this.sessions.set(id, s);
    s.on('change', () => this.changed());
    s.on('ask', a => { if (a.kind === 'plan' && a.plan) try { A.writePlan(this.root, id, a.plan); } catch { /* the card still shows it */ } });
    s.on('ask', a => this.d.notify('warn', `"${task.title}" needs you: ${a.kind === 'question' ? 'Claude has a question' : `${a.tool} ${a.detail}`.slice(0, 120)}`, id, true));
    s.onRules(rules => { this.store.addRules(rules); this.d.notify('info', `Approved for every task in ${path.basename(this.root)}: ${rules.join(', ')}`); });
    s.on('rate', info => this.d.limits.update(info));
    s.on('running', () => {
      const cur = this.store.task(id);
      if (cur?.status === 'review' && cur.where !== 'direct' && !cur.init) this.store.updateTask(id, { status: 'doing', live: true });
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
    if (t.where === 'direct' && !t.init) {
      let before: string[] = [];
      try { before = fs.readFileSync(path.join(A.taskDir(this.root, id), 'dirty-before.txt'), 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
      const now = await g.dirtyFiles(this.root).catch(() => [] as string[]);
      this.store.updateTask(id, { directFiles: now.filter(f => !before.includes(f)) });
    }
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
    // An artifact task's page is published (again, after a change) once Claude has written it.
    if (cur?.output === 'artifact' && fs.existsSync(A.artifactFile(this.root, id))) { this.d.publish?.(id); return; }
    if (cur?.status !== 'review' || !cur.branch || this.emptyAt.has(id)) return;
    if (await this.check(id) === 'fail') return;
    if (this.d.settings().review.auto) await this.review(id);
  }

  /* ---------- task folder setup and checks (no tokens) ---------- */

  // The task folder's environment: the project's virtualenv and the task's own ports.
  private folderEnv(id: string, cwd: string) { return cwd === this.root ? this.d.env() : C.folderEnv(this.root, id, this.d.env()); }

  private async setupFolder(id: string, wt: string, quiet = false) {
    const set = this.d.settings();
    if (!set.setup.trim()) return;
    if (!quiet) this.setPhase(id, 'Setting up the task folder (dependencies)…');
    const log: string[] = [];
    try {
      const ok = await C.setupFolder(this.root, wt, set.setup, this.folderEnv(id, wt), s => log.push(s));
      if (!quiet) fs.mkdirSync(A.taskDir(this.root, id), { recursive: true });
      if (!quiet) fs.writeFileSync(path.join(A.taskDir(this.root, id), 'setup.log'), log.join('\n\n'));
      if (!ok && !quiet) this.d.notify('warn', `Setting up "${this.store.task(id)?.title}" failed; Claude starts anyway. See its setup.log under Details.`, id);
    } finally { if (!quiet) this.setPhase(id); }
  }

  // Runs the project's checks in the task's folder. Failures that the base branch has too are not the task's: they
  // are noted and ignored. A real failure goes back to Claude (up to maxCheckRounds), so the reviewer only sees
  // work that passes.
  private async check(id: string): Promise<'pass' | 'fail' | 'none'> {
    const t = this.store.task(id), set = this.d.settings();
    if (!t?.worktree || !t.base) return 'none';
    const checks = C.checksFor(t.worktree, set.checks);
    if (!checks.length) return 'none';
    const head = await g.git(t.worktree, ['rev-parse', 'HEAD']).catch(() => '');
    if (t.checks?.head === head && t.checks.state === 'pass') return 'pass';
    if (this.checking.has(id)) return 'fail';  // already running for this task: the first run decides
    this.checking.add(id);
    this.setPhase(id, `Running checks: ${checks.map(c => c.name).join(', ')}…`);
    let results: C.CheckResult[], log: string;
    try {
      ({ results, log } = await C.runChecks(checks, t.worktree, this.folderEnv(id, t.worktree), set.checkTimeoutMinutes * 60_000));
      const failing = results.filter(r => !r.ok);
      if (failing.length) {
        const base = await this.baseline(t.base, failing.map(f => f.cmd));
        for (const r of failing) if (base.get(r.cmd) === false) r.preexisting = true;
      }
    } finally { this.setPhase(id); this.checking.delete(id); }
    const now = this.store.task(id);
    // Merged, discarded or deleted while the checks ran: their results no longer belong to anything.
    if (!now || now.status === 'done' || !now.worktree || now.worktree !== t.worktree || !fs.existsSync(path.join(now.worktree, '.git'))) return 'none';
    try { fs.mkdirSync(A.taskDir(this.root, id), { recursive: true }); fs.writeFileSync(A.checksLog(this.root, id), log); } catch { /* the card still shows it */ }
    const real = results.filter(r => !r.ok && !r.preexisting);
    const rounds = real.length ? (now.checks?.state === 'fail' ? now.checks.rounds : 0) + 1 : 0;
    this.store.updateTask(id, { checks: { state: real.length ? 'fail' : 'pass', rounds, head,
      results: results.map(r => ({ name: r.name, cmd: r.cmd, ok: r.ok, ms: r.ms, tail: r.tail || undefined, preexisting: r.preexisting, timedOut: r.timedOut })) } });
    if (!real.length) return 'pass';
    if (rounds > set.maxCheckRounds) {
      this.d.notify('warn', `"${t.title}": checks still fail after ${rounds - 1} fix rounds. Details are on the card.`, id, true);
      return 'fail';
    }
    await this.sendChecks(id);
    return 'fail';
  }

  async sendChecks(id: string) {
    const t = this.store.task(id);
    const failing = t?.checks?.results?.filter(r => !r.ok && !r.preexisting) ?? [];
    if (!t?.worktree || t.status === 'done' || !failing.length) return;
    this.store.updateTask(id, { status: 'doing' });
    await this.say(id, `JustCode ran the project's checks after your turn. These fail:\n\n` +
      failing.map(r => `$ ${r.cmd}  (${r.timedOut ? 'timed out' : 'failed'})\n\`\`\`\n${r.tail ?? ''}\n\`\`\``).join('\n\n') +
      `\n\nFull log: ${A.checksLog(this.root, id)}. Fix the cause (change a test only if the test itself is wrong), re-run the failing check, update your handoff, then finish your turn.`);
  }

  // Which of `cmds` pass on the base branch, cached per base commit. Runs in .justcode/worktrees/_base.
  private baselineRuns = new Map<string, Promise<Map<string, boolean>>>();
  private async baseline(base: string, cmds: string[]): Promise<Map<string, boolean>> {
    const sha = await g.git(this.root, ['rev-parse', base]).catch(() => '');
    if (!sha) return new Map();
    const file = path.join(this.root, '.justcode', 'checks-baseline.json');
    let cache: Record<string, Record<string, boolean>> = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    const known = cache[sha] ?? {};
    const todo = cmds.filter(c => !(c in known));
    if (todo.length) {
      const key = `${sha}:${todo.join('|')}`;
      if (!this.baselineRuns.has(key)) this.baselineRuns.set(key, (async () => {
        const dir = g.worktreeDir(this.root, BASELINE);
        await this.serial(async () => {
          if (!fs.existsSync(path.join(dir, '.git'))) await g.git(this.root, ['worktree', 'add', '--detach', dir, sha]);
          else await g.git(dir, ['checkout', '-q', '--detach', '-f', sha]);
        });
        g.copyEnvFiles(this.root, dir, this.d.settings().worktreeCopy);
        await this.setupFolder(BASELINE, dir, true);
        const out = new Map<string, boolean>();
        for (const cmd of todo) out.set(cmd, (await C.runCommand(cmd, dir, { ...this.folderEnv(BASELINE, dir), CI: 'true' }, this.d.settings().checkTimeoutMinutes * 60_000)).code === 0);
        return out;
      })().finally(() => this.baselineRuns.delete(key)));
      const res = await this.baselineRuns.get(key)!.catch(() => new Map<string, boolean>());
      for (const [c, ok] of res) known[c] = ok;
      cache = { [sha]: known }; // only the latest base commit is worth keeping
      try { fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* recomputed next time */ }
    }
    return new Map(Object.entries(known));
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

  // The task the queue waits on, when only you can move it on (merge it, answer it, fix it): nothing is running.
  userBlocker() {
    const b = this.inFlight()[0];
    if (!b || !this.store.queue.length || this.starting.has(b.id) || this.reviews.has(b.id) || b.remote || b.limited) return;
    const s = this.sessions.get(b.id);
    if (s?.open && s.state !== 'idle' && s.state !== 'waiting') return;
    return { id: b.id, title: b.title, why: this.queueInfo().blocker!.why };
  }
  // Run all goes on without this task; it keeps its branch and still waits for you on its card.
  skipWait(id: string) {
    this.store.updateTask(id, { noWait: true });
    this.pump();
  }

  // "Run now" on a queued card: you asked for this one, so it starts past the "tasks at once" limit.
  async runNow(id: string) {
    this.store.setQueue(this.store.queue.filter(q => q !== id));
    await this.run(id);
  }

  // A card's ▶ Run. It honors the "tasks at once" limit (maxParallel): if a slot is free it starts now, otherwise it
  // goes to the front of the queue and starts when a running task is merged. Raise the limit in Settings to run several.
  async requestRun(id: string) {
    const t = this.store.task(id);
    if (!t || t.status !== 'todo') return this.run(id);  // continuing an existing task is not a new start
    const free = this.d.settings().maxParallel - this.inFlight().length;
    if (free > 0 && !this.d.limits.held()) return this.run(id);
    if (!this.store.queue.includes(id)) this.store.setQueue([id, ...this.store.queue]);
    this.pump();
    this.d.notify('info', this.d.limits.held() ? `"${t.title}" is queued: it starts after the usage limit resets.` : `"${t.title}" is queued: ${this.inFlight().length} task(s) already running (limit ${this.d.settings().maxParallel}). Raise "Tasks at once" in Settings to run more.`, id);
  }

  // Tasks still on their way to Done. Each holds its slot until merged, so with maxParallel 1 Run all builds every
  // task on the previous one's merged work. A project-root task is finished when its turn ends.
  private inFlight() {
    return this.store.data.tasks.filter(t => {
      if (t.archived || t.status === 'done' || t.init) return false;
      if (this.sessions.get(t.id)?.open && this.sessions.get(t.id)!.state !== 'idle') return true;
      if (this.starting.has(t.id) || t.remote) return true;
      // Stopped on an error: nothing runs until you press Resume, so it must not hold the slot (a stopped task in
      // another sprint left ▶ Run only queueing, with nothing visible to wait for).
      if (t.error || t.noWait) return false;
      return t.where !== 'direct' && !!t.worktree && (t.status === 'doing' || t.status === 'review');
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
      : r?.state === 'pass' && r.risk === 'critical' && this.d.settings().review.autoMerge ? 'passed review but is flagged critical, so it is not merged automatically: open it and merge it yourself'
      : r?.state === 'pass' ? 'is ready to merge'
      : r?.state === 'fail' ? (r.attempts >= max ? 'still has review issues' : 'is fixing review issues')
      : b.conflicts?.length ? 'has merge conflicts'
      : this.emptyAt.has(b.id) ? 'has a reply from Claude for you' : 'waits for review';
    return { queued: this.store.queue, blocker: { id: b.id, title: b.title, why } };
  }

  private pumpTimer?: NodeJS.Timeout;
  private pumpSoon(ms = 300) {
    if (!this.store.queue.length) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.pump(), ms);
    this.pumpTimer.unref?.();
  }

  private pump() {
    if (this.disposed || this.d.limits.held() || !this.holdsLease()) return;
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
    this.requireLease();
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
        this.d.notify('info', `"${t.title}" needs no AI review (${tri.why}). Ready to merge.`, id, true);
        return;
      }
      const model = tri.level === 'light' && o.lightModel ? o.lightModel : o.model;
      const effort = tri.level === 'light' ? 'low' : o.effort;
      this.store.updateTask(id, { review: { state: 'running', attempts, head, level: tri.level === 'none' ? 'full' : tri.level, why: tri.why } });
      const reviewer = discoverAgents(this.root).find(a => a.scope === 'project' && /review/i.test(a.name))?.name;
      fs.rmSync(shots, { recursive: true, force: true });
      fs.mkdirSync(shots, { recursive: true });
      const device = adb();
      const screenshots = () => { try { return fs.readdirSync(shots).filter(f => /\.(png|jpe?g)$/i.test(f)).map(f => path.join(shots, f)); } catch { return []; } };
      let brief = ''; try { brief = fs.readFileSync(A.briefFile(this.root, id), 'utf8').replace(/\n## When you finish[\s\S]*$/, '').trim(); } catch { /* none yet */ }
      try { brief += `\n\n## Approved plan\n${fs.readFileSync(A.planFile(this.root, id), 'utf8').slice(0, 6000)}`; } catch { /* no plan */ }
      const passed = this.store.task(id)?.checks?.state === 'pass' ? this.store.task(id)!.checks!.results!.filter(r => r.ok).map(r => r.cmd) : [];
      const prompt = reviewPrompt(t, t.base, diff, { shots, adb: device, cli: this.d.cli, handoff: A.readHandoff(this.root, id), brief, checks: passed }) + (retry
        ? `\n\n## Your previous attempt did not finish (${t.review?.error ?? 'it stopped'})\nKeep it short: run only the tests for the changed code, never a dev server, watch mode or an interactive command, and give the verdict.` : '');
      let usage = this.store.task(id)?.usage?.review as Usage | undefined;
      const exec = async (p: string, resume?: string) => {
        const r = await runReview(p, { bin, cwd: t.worktree!, env: this.d.env(), model: model || undefined, effort: effort || undefined, agent: reviewer, signal: ac.signal, personal: this.d.settings().personalSetup, plugins: this.plugins(),
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
        this.d.notify('info', `"${t.title}" passed AI review${v.risk === 'critical' ? ' (flagged critical: look before merging)' : ''}. Ready to merge.`, id, true);
        return;
      }
      const n = attempts + 1;
      this.store.updateTask(id, { review: { ...lv, state: 'fail', attempts: n, head, issues: v.issues, risk: v.risk, screenshots: screenshots(), tested: v.tested } });
      this.reviews.delete(id);
      if (n >= o.maxAttempts) return this.d.notify('warn', `"${t.title}" failed AI review ${n} times. The issues are on the card.`, id, true);
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
  }

  cancelReview(id: string) { this.reviews.get(id)?.ac.abort(); }

  /* ---------- review / merge ---------- */

  changes(id: string) {
    const t = this.store.task(id);
    if (t?.status === 'done' && !t.worktree && t.branch && t.where !== 'direct') return g.mergedChanges(this.root, t.branch);
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
      this.requireLease();
      if (t.where === 'direct' || !t.worktree) { this.store.updateTask(id, { status: 'done' }); return; }
      if (!t.branch || !t.base) throw new Error('Nothing to merge yet');
      const s = this.sessions.get(id);
      if (s?.open && s.state !== 'idle') throw new Error('Claude is still working on this task. Wait for it to finish, or stop it.');
      if (this.checking.has(id)) throw new Error('The checks are still running in this task\'s folder. Merge when they finish.');
      this.stop(id);
      await g.commitAll(t.worktree, t.title);
      const conflicts = await g.syncWithBase(t.worktree, t.base);
      if (conflicts.length) {
        this.store.updateTask(id, { conflicts, status: 'review' });
        this.d.notify('warn', `"${t.title}" conflicts with ${t.base} in ${conflicts.length} file(s). Resolve them on the card, then merge again.`, id, true);
        return;
      }
      await g.mergeIntoBase(this.root, t.base, t.branch, `Merge ${t.branch}: ${t.title}`);
      try { A.appendProgress(this.root, t); } catch { /* progress is a convenience */ }
      await this.cleanup(t);
      this.store.updateTask(id, { status: 'done', conflicts: undefined, worktree: undefined, live: undefined, doneAt: Date.now() });
      this.d.notify('info', `${auto ? 'Review passed, merged' : 'Merged'} "${t.title}" into ${t.base}.`, undefined, auto);
      if (t.sprintId) await this.mergeSprint(t.sprintId);
      this.pump();  // its slot is free: the next queued task starts on top of this merge
    });
  }

  // A sprint is finished when none of its tasks is left to do and no task still builds on its branch. Its branch
  // then merges into the branch it was cut from. Conflicts leave both branches as they are and say which files.
  finishSprint(id: string) {
    return this.serial(() => this.mergeSprint(id)).catch(e => this.d.notify('error', e.message));
  }
  private async mergeSprint(id: string) {
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
      this.d.notify('info', `Conflicts resolved for "${t.title}". Merge it when ready.`, id);
    });
  }

  // Drops the branch and its work; the task goes back to To do with a fresh session next run.
  discard(id: string) {
    return this.guarded(id, async t => {
      await this.cleanup(t);
      A.removeTaskDir(this.root, id);
      this.store.updateTask(id, { status: 'todo', usage: undefined, checks: undefined, startedAt: undefined, branch: undefined, worktree: undefined, sessionId: undefined, conflicts: undefined, pr: undefined,
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
  /* ---------- planner / editor chat ---------- */

  // A read-only chat that plans new tasks or edits the To do list. You see its history and keep talking to it; it
  // maintains a proposed task list you apply when ready. One per project; lives only while open.
  private planner?: Session;
  private plannerSession?: string;
  private plannerOthers: string[] = [];         // started and done tasks of the sprint: checked, changed only if needed
  private plannerTargets: string[] = [];        // the To do task ids this chat is editing (empty = planning fresh)
  private plannerProposals?: RefineResult[];
  private plannerNote?: string;  // last apply result, shown in the panel
  private plannerTurnAt = 0;     // when Claude's current planning turn started (the panel's progress bar)
  private plannerSprint?: string; // the sprint this chat edits, when started with ✦ Edit sprint

  plannerLive() {
    const s = this.planner;
    if (!s?.open && !this.plannerProposals) return undefined;
    return { run: s?.open ? s.state : 'idle', steps: s?.steps ?? [], proposals: this.plannerProposals, targets: this.plannerTargets, others: this.plannerOthers, context: s?.context ?? 0, model: s?.model, note: this.plannerNote, turnAt: this.plannerTurnAt, sprint: this.plannerSprint,
      asks: s?.open ? [...s.asks.values()].filter(a => a.kind === 'question') : [] };
  }

  plannerPhase?: string;
  // A claude.ai link pasted in a sprint's task or plan prompt becomes one of that sprint's sources.
  private useLinkedSources(sprintId: string | undefined, text: string) {
    const sp = sprintId ? this.store.data.sprints.find(x => x.id === sprintId) : undefined;
    if (!sp?.sources) return;
    const add = A.linkedSources(A.loadSources(this.root), text).map(s => s.id).filter(id => !sp.sources!.includes(id));
    if (add.length) this.store.updateSprint(sp.id, { sources: [...sp.sources, ...add] });
  }

  async startPlanner(instruction: string, targetIds: string[], sprint?: { name: string; goal?: string }, into?: string) {
    const bin = this.d.bin();
    if (!bin) throw new Error('Claude Code is not installed. Open JustCode: Check Setup.');
    if (this.d.limits.held()) throw new Error('Your Claude usage limit is reached. Try again after the reset.');
    this.planner?.kill();
    this.plannerTargets = targetIds;
    // Reworking a sprint also checks the tasks already started or done in it.
    const sid = sprint ? this.store.data.sprints.find(x => x.name === sprint.name && !x.closed)?.id : undefined;
    const others = sid ? this.store.data.tasks.filter(t => t.sprintId === sid && !t.archived && !t.init && !targetIds.includes(t.id) && (t.status !== 'todo' || !!t.worktree)) : [];
    this.plannerOthers = others.map(t => t.id);
    this.plannerProposals = undefined;
    this.plannerNote = undefined;
    this.plannerTurnAt = Date.now();
    this.plannerSprint = sprint?.name;
    this.plannerPhase = 'Saving the claude.ai design locally first. This takes about 30 seconds…';
    this.changed();
    try { await this.d.saveSources?.(instruction); } finally { this.plannerPhase = undefined; }
    this.useLinkedSources(sid, instruction);
    const tasks = targetIds.map(id => this.store.task(id)).filter((t): t is Task => !!t);
    const set = this.d.settings();
    this.plannerSession = randomUUID();
    A.logPrompt(this.root, { kind: 'plan', text: instruction, sessionId: this.plannerSession, title: sprint ? `Edit ${sprint.name}` : 'Plan' });
    const s = new Session({
      // Not Claude Code's plan mode: it tells Claude to write a plan file, which a read-only chat cannot, so each turn
      // spent tokens on a refused Write. Default mode with the write tools removed keeps it read-only.
      bin, cwd: this.root, sessionId: this.plannerSession, resume: false, mode: 'default', model: set.plannerModel || undefined,
      append: PLANNER_APPEND, readOnly: true, effort: set.plannerEffort || undefined,
      allowed: userAllowRules(), rules: () => userAllowRules(), env: this.d.env(), idleMs: 30 * 60_000, label: 'Planner', personal: set.personalSetup, plugins: this.plugins(),
    });
    this.planner = s;
    s.on('change', () => this.changed());
    s.on('rate', info => this.d.limits.update(info));
    s.on('turn', turn => { this.onPlannerTurn(turn); });
    // Questions show in the planning panel. Anything else that asks (a command that is not read-only) is declined.
    s.on('ask', a => { if (a.kind !== 'question') setImmediate(() => s.answer({ id: a.id, choice: 'deny', message: 'Read-only planning chat: use Read, Grep, Glob or read-only commands (ls, cat, grep, git log), and reply with the proposed task list.' })); });
    s.on('exit', () => this.changed());
    const sprints = this.store.data.sprints.filter(x => !x.closed).map(x => ({ name: x.name, goal: x.goal }));
    await s.start((A.projectSection(this.root) ? `${A.projectSection(this.root)}\n\n` : '') + A.sourceLines(this.root, A.sprintSources(A.loadSources(this.root), sid ? this.store.data.sprints.find(x => x.id === sid) : undefined)) + plannerFirst(tasks.map(t => ({ id: t.id, title: t.title, description: t.description })), instruction, sprints, sprint,
      others.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status })), into && this.store.data.sprints.some(x => x.name === into && !x.closed) ? into : undefined));
    this.changed();
  }

  private onPlannerTurn(turn: TurnEnd) {
    if (turn.limit) { this.d.limits.setReached('usage'); return; }
    if (!turn.ok) { this.d.notify('error', `Planner stopped: ${String(turn.error).slice(0, 200)}`); return; }
    const ids = new Set([...this.plannerTargets, ...this.plannerOthers]);
    const p = parseProposals(turn.text, ids);
    if (p) { this.plannerProposals = p; this.plannerNote = undefined; }
    this.changed();
  }

  plannerAnswer(a: Answer) { this.planner?.answer(a); }

  plannerSay(text: string) {
    if (!this.planner?.open) throw new Error('The planning chat has ended. Start it again.');
    this.planner.send(text);
    A.logPrompt(this.root, { kind: 'plan', text, sessionId: this.plannerSession, title: 'Plan' });
    this.plannerTurnAt = Date.now();
  }
  // Your prompts, newest first, with the sessions each one belongs to. Tasks from before the log existed are
  // filled in from the board, so nothing you ran is missing.
  history() {
    const logged = A.readPrompts(this.root);
    const seen = new Set(logged.filter(p => p.kind === 'task').map(p => p.taskId));
    const items = [...logged.reverse(), ...this.store.data.tasks.filter(t => !seen.has(t.id))
      .map(t => ({ time: t.created, kind: 'task' as const, text: [t.title, t.description].filter(Boolean).join('\n\n'), taskId: t.id, title: t.title }))];
    return items.sort((a, b) => b.time - a.time).map(p => {
      const t = p.taskId ? this.store.task(p.taskId) : undefined;
      const sessions = p.kind === 'plan' ? (p.sessionId && this.sessionDir(p.sessionId) ? [p.sessionId] : [])
        : t ? [...(t.pastSessions ?? []), t.sessionId].filter((s): s is string => !!s && !!this.sessionDir(s, t)) : [];
      return { ...p, title: t?.title ?? p.title, exists: !!t, status: t?.status, sessions };
    });
  }

  // Where a session's transcript is: the task's own folder (gone after a merge, its transcript stays) or the project.
  // Only sessions the board or the prompt log knows: a remote viewer can't read an arbitrary transcript.
  sessionDir(sessionId: string, t?: Task) {
    const task = t ?? this.store.data.tasks.find(x => x.sessionId === sessionId || x.pastSessions?.includes(sessionId));
    const known = task ? task.sessionId === sessionId || !!task.pastSessions?.includes(sessionId) : A.readPrompts(this.root).some(p => p.kind === 'plan' && p.sessionId === sessionId);
    if (!known) return;
    const dirs = task ? [task.worktree, g.worktreeDir(this.root, task.id), this.root] : [this.root];
    return dirs.find((d): d is string => !!d && sessionExists(d, sessionId));
  }

  // A done task that must change goes back to To do with the new text. Its work is already merged, so the next run
  // starts a fresh branch and session on top of it; the old session stays in its history.
  private reopen(t: Task, c: RefineResult) {
    this.store.updateTask(t.id, { status: 'todo', title: c.title, description: c.description || undefined, ...(this.sprintFor(c.sprint) ? { sprintId: this.sprintFor(c.sprint) } : {}),
      pastSessions: t.sessionId ? [...(t.pastSessions ?? []), t.sessionId] : t.pastSessions, sessionId: undefined, branch: undefined, worktree: undefined, base: undefined,
      doneAt: undefined, startedAt: undefined, checks: undefined, review: undefined, error: undefined, reply: undefined, conflicts: undefined, live: undefined, pr: undefined, usage: undefined });
  }

  // A working or in-review task that must change: the new text is saved and the change goes to its Claude.
  private async amend(t: Task, c: RefineResult) {
    this.store.updateTask(t.id, { title: c.title, description: c.description || undefined });
    await this.say(t.id, `The plan for this task changed. Update your work to match, verify it, update your handoff, then finish your turn.\n\n# ${c.title}\n${c.description ?? ''}`)
      .catch(e => this.d.notify('error', `"${t.title}": ${e.message}`, t.id));
  }

  stopPlanner() { this.planner?.kill(); this.planner = undefined; this.plannerProposals = undefined; this.plannerTargets = []; this.changed(); }

  // Applies the proposals the user kept: edits, adds (in order), removes, reorder of the To do tasks.
  // Where a task lands: the sprint Claude named (created when the board has no open sprint of that name), else an
  // edited task keeps its sprint, and a fresh plan uses the active sprint (so the tasks appear where you work).
  applyProposals(changes: (RefineResult & { kind: string; apply?: boolean })[], removes: { id: string; apply?: boolean }[]) {
    const sprintId = this.plannerTargets.map(id => this.store.task(id)?.sprintId).find(Boolean)
      ?? (this.plannerTargets.length ? undefined : this.store.data.sprints.find(s => s.active && !s.closed)?.id);
    const orderIds: string[] = [];
    let added = 0, edited = 0, removed = 0, reopened = 0, sent = 0;
    for (const c of changes) {
      const started = c.ref && this.plannerOthers.includes(c.ref) ? this.store.task(c.ref) : undefined;
      if (started && started.status !== 'todo') {
        if (!c.apply) continue;
        if (started.status === 'done') { this.reopen(started, c); orderIds.push(started.id); reopened++; }
        else { void this.amend(started, c); sent++; }
        continue;
      }
      if (!c.apply) { if (c.ref) orderIds.push(c.ref); continue; }
      const named = this.sprintFor(c.sprint);
      if (c.ref) { this.store.updateTask(c.ref, { title: c.title, description: c.description || undefined, ...(named ? { sprintId: named } : {}) }); orderIds.push(c.ref); edited++; }
      else { const t = this.store.addTask({ title: c.title, description: c.description || undefined, sprintId: named ?? (sprintId || undefined), mode: this.defaultMode }); orderIds.push(t.id); added++; }
    }
    for (const rm of removes) if (rm.apply) { void this.remove(rm.id); removed++; }
    const after = this.store.data.tasks.find(t => t.status === 'todo' && !orderIds.includes(t.id) && !this.plannerTargets.includes(t.id));
    // Each goes in front of the same task (or to the end), so in proposal order they keep the planner's build order.
    for (const id of orderIds) this.store.reorder(id, after?.id);
    // The proposals are now real tasks: clear the panel (no double-apply) and let further chat refine them.
    this.plannerProposals = undefined;
    this.plannerTargets = orderIds.slice();
    this.plannerOthers = this.plannerOthers.filter(id => !this.plannerTargets.includes(id));
    const n = added + edited + removed + reopened + sent;
    const parts = [added && `added ${added}`, edited && `updated ${edited}`, removed && `removed ${removed}`, reopened && `${reopened} done back to To do`, sent && `sent the change to ${sent} started`].filter(Boolean);
    this.plannerNote = parts.length ? `Applied: ${parts.join(', ')} task${n === 1 ? '' : 's'}. Keep chatting to add or change more.` : 'No tasks changed.';
    this.changed();
  }
  defaultMode: Task['mode'] = 'auto';  // set by the extension from justCode.defaultMode

  // "Sprint 2: Search" → the open sprint named "Sprint 2", created with goal "Search" when there is none.
  private sprintFor(label?: string) {
    if (!label) return undefined;
    const m = /^(.*?)\s*(?:[:—–]\s*|\s-\s)(.*)$/.exec(label);
    const name = (m ? m[1] : label).trim(), goal = m?.[2].trim() || undefined;
    if (!name) return undefined;
    const k = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
    return this.store.data.sprints.find(x => !x.closed && k(x.name) === k(name))?.id ?? this.store.addSprint(name, goal).id;
  }

  dispose() {
    if (this.holdsLease()) fs.rmSync(this.leaseFile, { force: true });
    this.disposed = true;
    clearInterval(this.leaseTimer);
    this.unsub.dispose();
    clearTimeout(this.sweepTimer);
    clearTimeout(this.pumpTimer);
    this.planner?.kill();
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
    for (const r of this.reviews.values()) r.ac.abort();
    this.reviews.clear();
    this.store.dispose();
    this.ev.removeAllListeners();
  }
}
