import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import * as g from './git';
import { setupSkillBody, designFromCodeBody } from './skill';
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

// One Runner per project: starts each task's Claude session in the task's own copy of the project (a git worktree on
// its own branch), moves cards as the work progresses (To do → Doing → Review → Done), runs the AI reviewer, merges,
// and keeps Run all's queue. Everything it starts it also stops: sessions close when idle, reviews time out, and every
// task copy is removed when its task is merged, discarded or deleted (orphans are pruned at startup).

// The folder where checks run on the base branch, to tell failures a task caused from ones it found.
export const BASELINE = '_base';
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const TEST_CMD = /\b(test|pytest|jest|vitest|spec|build|tsc|check|gradlew|playwright|screenshot|lint)\b/i;
export const UI_FILE = /^\+\+\+ b\/.*\.(html?|css|scss|tsx|jsx|vue|svelte|xml|kt|java|swift|dart|component\.ts)$/m;

export interface RunnerSettings {
  maxParallel: number;
  taskModel: string;
  allowedTools: string[];
  worktreeCopy: string[];
  idleMinutes: number;
  bypassAll?: boolean;   // justCode.bypassAll: every task runs with bypassPermissions
  superpowers: boolean;     // load the installed superpowers plugin into task, planner and review sessions
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

export const LEASE_MS = 2 * 60_000;

export class Runner {
  sessions = new Map<string, Session>();
  starting = new Set<string>();
  reviews = new Map<string, { ac: AbortController; started: number }>();
  busy = new Set<string>();
  checking = new Set<string>();   // tasks whose checks are running now: no review, merge or cleanup meanwhile
  errorSwept = new Set<string>(); // errored reviews the sweep already retried this window
  emptyAt = new Set<string>();
  phase = new Map<string, string>(); // what JustCode itself is doing for a task: setting up, running checks
  setPhase(id: string, text?: string) { if (text) this.phase.set(id, text); else this.phase.delete(id); this.changed(); } // tasks whose branch had nothing to review at their last turn end
  ev = new EventEmitter();
  lock: Promise<unknown> = Promise.resolve();
  sweepTimer?: NodeJS.Timeout;
  sweeping = false;
  unsub: { dispose(): void };
  disposed = false;
  leading = false;
  leaseTimer?: NodeJS.Timeout;

  // The JustCode plugin (skills, agents) every session loads, rewritten first if it is missing or from another version,
  // plus superpowers when it is installed and on (lean sessions do not load the user's plugins; personal ones do).
  plugins(extra: Array<string | undefined> = []) {
    try { ensurePlugin(this.root, this.d.version ?? '0.0.0'); } catch { /* a read-only folder: sessions still run */ }
    const set = this.d.settings();
    const sp = set.superpowers && !set.personalSetup ? installedPlugin('superpowers') : undefined;
    return [...new Set([pluginDir(this.root), ...[...extra, sp].filter((p): p is string => !!p)])];
  }

  constructor(readonly store: Store, readonly d: RunnerDeps) {
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
  get leaseFile() { return path.join(this.root, '.justcode', 'runner.lock'); }

  holdsLease() {
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

  renewLease() {
    const was = this.leading;
    this.leading = this.holdsLease();
    if (this.leading && !was) void this.startup();
  }

  requireLease() {
    if (!this.holdsLease()) throw new Error('Another window is running JustCode for this project. Use that window, or close it and try again.');
    if (!this.leading) this.renewLease();
  }

  get root() { return this.store.root; }
  onChange(fn: () => void) { this.ev.on('change', fn); }
  changed() { this.ev.emit('change'); }

  // One repo-changing git operation at a time per project (parallel runs would race on worktrees and refs).
  serial<T>(fn: () => Promise<T>): Promise<T> {
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
      context: s?.context ?? 0, output: s?.output ?? 0, modeNote: s?.modeNote, modelUsed: s?.model,
      // The session's mode only while one runs: board state spreads this over the task, and `mode: undefined` would hide the task's own mode.
      ...(s?.mode ? { mode: s.mode } : {}),
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

  async startup() {
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
  async settleMerged(t: Task) {
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
    const block = this.policyBlock(t);
    if (block) {
      this.store.updateTask(id, { error: block });
      this.audit('policy.deny', id, block, 'policy');
      throw new Error(block);
    }
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
    // A branch task started while a direct task holds uncommitted files: say so once on its card.
    const od = t.where !== 'direct' && !t.warning ? this.openDirect(id) : undefined;
    if (od?.directFiles?.length) this.store.updateTask(id, { warning: `"${od.title}" has uncommitted files in the project folder; merging waits until you Finish or Discard it.` });
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
  prepare(t: Task) {
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



  secretsAsked = new Set<string>();





  async start(t: Task, bin: string, cwd: string, patch: Partial<Task>, prompt?: string) {
    const id = t.id;
    const sessionId = t.sessionId ?? randomUUID();
    const resume = !!t.sessionId && sessionExists(cwd, sessionId);
    // A fresh session gets the task itself (plus anything the board adds); a resumed one only the new message.
    if (!fs.existsSync(cwd)) throw new Error(`This task's folder is gone (${cwd}). Use Discard to start it over.`);
    const sources = A.sprintSources(A.loadSources(this.root), t.sprintId ? this.store.data.sprints.find(x => x.id === t.sprintId) : undefined);
    // An artifact task that names a page an earlier task published updates that page (same link) instead of a new one.
    const reuse = !resume && t.output === 'artifact' && !t.artifactUrl ? this.publishedNamedIn(t) : undefined;
    if (reuse) { patch = { ...patch, artifactUrl: reuse.url }; R.link(this.root, reuse.url, t.id, t.sprintId); }
    const title = (x: string) => this.store.task(x)?.title;
    const first = resume ? (prompt ?? 'Continue the task.') : [taskPrompt(t, A.writeBrief(this.root, t, sources, title)), t.init === 'design' ? designFromCodeBody() : t.init ? setupSkillBody() : '',
      t.output === 'artifact' ? artifactBrief(A.artifactFile(this.root, id), !!installedPlugin('frontend-design', undefined, 'skills'), reuse && { ...reuse, file: this.previousPage(reuse) }) : '', prompt].filter(Boolean).join('\n\n');
    if (!resume) this.linkArtifacts(t, sources);
    const task = this.store.updateTask(id, { ...patch, sessionId, status: t.status === 'todo' ? 'doing' : t.status, error: undefined, live: true, startedAt: t.startedAt ?? Date.now() })!;
    const set = this.d.settings();
    const carry = carryOver(this.root, cwd);
    const personal = set.personalSetup ? [] : userAllowRules();
    const web = webOptions(A.isUiTask(task), A.shotsDir(this.root, id), []);
    const s = new Session({
      bin, cwd, sessionId, resume, mode: this.modeFor(task), model: set.taskModel || undefined, effort: set.taskEffort || undefined, subagents: set.subagents, agent: task.agent,
      agents: carry.agents, settingsFile: carry.settingsFile, personal: set.personalSetup,
      plugins: this.plugins(task.output === 'artifact' && !set.personalSetup ? [installedPlugin('frontend-design', undefined, 'skills')] : []),
      // The task's artifacts folder (brief, handoff), its screenshots and any sources outside the project.
      addDirs: [...new Set([...carry.addDirs, A.taskDir(this.root, id), ...(task.images?.length ? [path.dirname(task.images[0])] : []), ...A.outsideDirs(this.root, sources)])],
      mcpServers: web.mcpServers,
      allowed: [...new Set([...web.allowed, ...set.allowedTools, ...personal, ...this.store.rules, ...(task.allow ?? []), `Edit(${A.handoffFile(this.root, id)})`, `Write(${A.handoffFile(this.root, id)})`])],
      rules: () => [...set.allowedTools, ...this.store.rules, ...(this.store.task(id)?.allow ?? [])],
      env: this.folderEnv(id, cwd), idleMs: Math.max(1, set.idleMinutes) * 60_000, label: task.title,
      audit: (event, detail, actor) => this.audit(event, id, detail, actor),
      guard: this.guard(id, cwd),
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

  fail(id: string, e: unknown) {
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
    if (loadPolicy(this.root).policy.forbidModes.includes(mode)) {
      const why = `The project policy forbids the "${mode}" permission mode (.justcode/policy.json, forbidModes).`;
      this.audit('policy.deny', id, why, 'policy');
      throw new Error(why);
    }
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



  /* ---------- turn ends ---------- */

  async turnEnded(id: string, turn: TurnEnd) {
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
      try { committed = await g.commitAll(t.worktree, t.title, this.secretScan()); } catch (e: any) {
        if (e instanceof SecretsFound) return this.secretsBlocked(id, e, cost);
        this.store.updateTask(id, { error: `Could not commit the task's changes: ${e.message}`, live: undefined, costUsd: cost });
        return this.d.notify('error', `"${t.title}": ${e.message}`, id);
      }
    }
    if (t.sessionId) try { A.archiveTranscript(this.root, id, transcript(t.worktree ?? this.root, t.sessionId), t.sessionId); } catch { /* the archive is a convenience */ }
    const reply = turn.text.trim().slice(-4000) || undefined;
    if (t.init) this.store.updateTask(id, { status: 'done', live: undefined, reply, costUsd: cost });
    else this.store.updateTask(id, { status: t.status === 'done' ? 'done' : 'review', live: undefined, reply, costUsd: cost });
    if (!t.init && this.checkBudget(id)) return;
    this.emptyAt.delete(id);
    if (!committed && t.worktree && !(await this.hasWork(id))) this.emptyAt.add(id); // Claude only answered: nothing to review
    this.changed();
    this.pump();
    const cur = this.store.task(id);
    // An artifact task's page is published (again, after a change) once Claude has written it.
    if (cur?.output === 'artifact' && fs.existsSync(A.artifactFile(this.root, id))) { this.d.publish?.(id); return; }
    if (cur?.status !== 'review' || !(cur.branch || (cur.where === 'direct' && !cur.init)) || this.emptyAt.has(id) || cur.quick) return;
    if (await this.check(id) === 'fail') return;
    if (this.d.settings().review.auto) await this.review(id);
  }

  /* ---------- task folder setup and checks (no tokens) ---------- */





  // Which of `cmds` pass on the base branch, cached per base commit. Runs in .justcode/worktrees/_base.
  baselineRuns = new Map<string, Promise<Map<string, boolean>>>();


  /* ---------- queue ---------- */








  pumpTimer?: NodeJS.Timeout;




  /* ---------- keeping cards moving ---------- */




  /* ---------- AI review ---------- */






  /* ---------- review / merge ---------- */











  // Closing the window: every Claude process this project started ends. Tasks that were mid-turn keep `live`, so the
  // next window continues them.
  /* ---------- planner / editor chat ---------- */

  // A read-only chat that plans new tasks or edits the To do list. You see its history and keep talking to it; it
  // maintains a proposed task list you apply when ready. One per project; lives only while open.
  planner?: Session;
  plannerSession?: string;
  plannerOthers: string[] = [];         // started and done tasks of the sprint: checked, changed only if needed
  plannerTargets: string[] = [];        // the To do task ids this chat is editing (empty = planning fresh)
  plannerProposals?: RefineResult[];
  plannerNote?: string;  // last apply result, shown in the panel
  plannerTurnAt = 0;     // when Claude's current planning turn started (the panel's progress bar)
  plannerSprint?: string; // the sprint this chat edits, when started with ✦ Edit sprint


  plannerPhase?: string;









  defaultMode: Task['mode'] = 'auto';  // set by the extension from justCode.defaultMode


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

import { queueMethods } from './queue';
import { checkMethods } from './checkflow';
import { reviewMethods } from './reviewflow';
import { mergeMethods } from './merge';
import { plannerMethods } from './planner';
import { sessionMethods } from './sessions';
import { guardMethods } from './guards';

// The Runner's methods live in one file per concern (queue, checks, review, merge, planner, guards).
type Methods = typeof queueMethods & typeof checkMethods & typeof reviewMethods & typeof mergeMethods & typeof plannerMethods & typeof sessionMethods & typeof guardMethods;
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Runner extends Methods {}
Object.assign(Runner.prototype, queueMethods, checkMethods, reviewMethods, mergeMethods, plannerMethods, sessionMethods, guardMethods);
