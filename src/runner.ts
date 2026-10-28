import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import { Ptys } from './pty';
import * as g from './git';
import { sessionArgs, sessionExists, sessionSize, reviewPrompt, runReview, discoverAgents, adb } from './claude';
import { Limits, isLimitError } from './limits';

// What counts as having tested, and diffs that change what a user sees.
const TEST_CMD = /\b(test|pytest|jest|vitest|spec|build|gradlew|playwright|screenshot)\b/i;
const UI_FILE = /^\+\+\+ b\/.*\.(html?|css|scss|tsx|jsx|vue|svelte|xml|kt|java|swift|dart|component\.ts)$/m;

export interface ReviewOpts { auto: boolean; model: string; maxAttempts: number; autoMerge: boolean; commands?: string[]; freshAfterKB?: number }

// What a task's live session is doing, from its hooks: running, waiting for approval, or idle (turn finished).
export type RunState = 'running' | 'waiting' | 'idle';

// What a waiting session asks for, shown on its card: the tool and its main argument.
export interface Ask { message: string; tool?: string; detail?: string; always?: string }

// Claude Code's permission menu: "1. Yes", "2. Yes, and always allow …", …, last "No". The prompt is on screen when
// it asks "Do you want to proceed?" (or similar) and lists numbered choices.
const isMenu = (screen: string) => /Esc\s*to\s*cancel/i.test(screen) && /^\s*[❯›>]?\s*1\.\s*\S/m.test(screen);
const optionText = (screen: string, n: number) => {
  const lines = screen.split('\n');
  const i = lines.findIndex(l => new RegExp(`^\\s*[❯›>]?\\s*${n}\\.\\s*\\S`).test(l));
  if (i < 0) return;
  const out = [lines[i].replace(new RegExp(`^\\s*[❯›>]?\\s*${n}\\.\\s*`), '')];
  for (let j = i + 1; j < lines.length && !/^\s*[❯›>]?\s*\d\./.test(lines[j]) && !/Esc to cancel/i.test(lines[j]) && out.length < 3; j++) out.push(lines[j].trim());
  return out.join(' ').replace(/\s+/g, ' ').trim();
};

const toolDetail = (input: any) => {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.description ?? Object.values(input).find(x => typeof x === 'string');
  return typeof v === 'string' ? v.slice(0, 400) : '';
};

// Runs tasks of one project: worktree + branch per task, a Claude session per task in a pty,
// auto-commit when a turn ends, and the review → merge flow back into the task's base branch.
export class Runner {
  state = new Map<string, RunState>();
  private unsubExit?: () => void;
  private launching = new Set<string>();   // runs between claim and process start (an old process's exit must not touch them)
  private reviewing = new Set<string>();   // reviews in flight (in memory: a persisted "running" would survive a crash)
  limits?: Limits;                 // shared usage-limit tracker (set by the extension)
  copyFiles: () => string[] = () => [];   // env files copied into each new worktree
  private emptyAt = new Set<string>();    // tasks whose branch had nothing to review yet
  asks = new Map<string, Ask>();
  private lastTool = new Map<string, { tool: string; detail: string }>();
  private queue: string[] = [];
  private watched = new Map<string, number>(); // taskId → bytes of its status file already read
  private ev = new EventEmitter();
  private busy = new Set<string>(); // tasks with a git operation in flight
  private lock: Promise<unknown> = Promise.resolve();

  // One repo-changing git operation at a time per project (parallel runs would race on init, worktrees, refs).
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  constructor(readonly store: Store, private ptys: Ptys, private runsDir: string, private bin: () => string,
    private notify: (level: 'info' | 'warn' | 'error', text: string, taskId?: string) => void,
    private maxParallel: () => number, private model: () => string,
    private reviewOpts: () => ReviewOpts = () => ({ auto: false, model: '', maxAttempts: 3, autoMerge: false })) {
    fs.mkdirSync(runsDir, { recursive: true });
    this.unsubExit = ptys.onExit((id) => { if (this.store.task(id)) void this.exited(id); });
    // Finished work has no running session, however it got there (Done, archive, drag, sync, merge).
    store.onChange(() => {
      for (const id of ptys.ids()) {
        const t = this.store.task(id);
        if (t && (t.status === 'done' || t.archived)) this.stop(id);
      }
      this.sweepSoon();
      if (this.queue.length) this.pump();
    });
    for (const t of store.data.tasks) if (t.review?.state === 'running') store.updateTask(t.id, { review: undefined });
    this.sweepSoon(3000);
  }

  onChange(fn: () => void) { this.ev.on('change', fn); }
  private changed() { this.ev.emit('change'); }

  get root() { return this.store.root; }
  queued() { return [...this.queue]; }
  private statusFile(id: string) { return path.join(this.runsDir, `${id}.status`); }

  /* ---------- runs ---------- */

  async run(id: string, prompt?: string, size?: { cols: number; rows: number }) {
    const t = this.store.task(id);
    if (!t || this.ptys.has(id) || this.state.has(id)) return;
    this.state.set(id, 'running'); // claimed before the awaits, so Run all never double-starts a task
    this.launching.add(id);
    try { await this.launch(t, prompt, size); } catch (e) { this.state.delete(id); this.changed(); throw e; } finally { this.launching.delete(id); }
  }

  private async launch(t: Task, prompt?: string, size?: { cols: number; rows: number }) {
    const id = t.id;
    if (t.where === 'root') return this.spawn(t, this.root, {}, prompt, size);
    const { base, branch, worktree, refreshed } = await this.serial(async () => {
      await g.ensureRepo(this.root);
      const base = t.base ?? await g.currentBranch(this.root);
      if (base === 'HEAD') throw new Error('Your project folder is on a detached HEAD. Check out a branch first (git switch main).');
      // The worktree is cut from base, so base must hold the project's current files, committed or not.
      if (await g.currentBranch(this.root) === base) {
        const snap = await g.snapshot(this.root);
        if (snap.files.length) this.notify('info', `Committed ${snap.files.length} uncommitted file(s) on ${base} so tasks see the current project.`);
        if (snap.skipped.length) this.notify('warn', `Left out of git (over 10 MB): ${snap.skipped.join(', ')}`);
      }
      const branch = t.branch ?? g.taskBranch(t.title, t.id);
      const worktree = t.worktree ?? g.worktreeDir(this.root, t.id);
      await g.addWorktree(this.root, worktree, branch, base);
      g.copyEnvFiles(this.root, worktree, this.copyFiles());
      const refreshed = await g.catchUp(worktree, base).catch(() => false);
      return { base, branch, worktree, refreshed };
    });
    // A resumed session was looking at the old files; tell it they changed.
    const note = refreshed && t.sessionId && !prompt
      ? `JustCode updated this worktree with the latest ${base}: the project's files are here now. Re-check them and continue the task.` : prompt;
    await this.spawn(t, worktree, { base, branch, worktree }, note, size);
  }

  // Starts (or resumes) the task's session in `cwd`: its worktree, or the project root for root tasks.
  private async spawn(t: Task, cwd: string, patch: Partial<Task>, prompt?: string, size?: { cols: number; rows: number }) {
    const id = t.id;
    const sessionId = t.sessionId ?? randomUUID();
    const resume = !!t.sessionId && sessionExists(cwd, sessionId);
    const task = this.store.updateTask(id, { ...patch, sessionId, status: t.status === 'todo' ? 'doing' : t.status })!;
    const statusFile = this.statusFile(id);
    fs.writeFileSync(statusFile, '');
    this.watch(id);
    this.ptys.start(id, cwd, this.bin(), sessionArgs({ task, root: this.root, worktree: cwd, statusFile, resume, prompt, model: this.model() }), size?.cols, size?.rows);
    this.changed();
  }

  // Sends a prompt to the task's session: typed into the live one, or a resumed one started with it.
  async say(id: string, prompt: string) {
    // A permission prompt takes the next keys as its answer: a message typed now would end up approving the tool.
    if (this.state.get(id) === 'waiting') { this.notify('warn', 'Claude is waiting for your approval. Answer that first (Allow / Deny on the card).', id); return; }
    prompt = prompt.replace(/\x1b/g, ''); // an escape inside the text could end the paste early
    if (!this.ptys.has(id)) return this.run(id, prompt);
    // The board's own messages (review fixes, "continue after the limit") must never land on a permission prompt or other
    // menu: the paste wrapper starts with an Esc byte, which a menu reads as "No", cancelling it and every tool call queued behind it.
    if (isMenu(await this.ptys.screen(id, 14))) {
      this.notify('warn', 'Claude is showing a permission prompt. Answer it first; the message was not sent.', id);
      return;
    }
    // Bracketed paste keeps a multi-line prompt as one message, but only when the program asked for it: otherwise its
    // opening Esc is read as a keypress. Without it, send one plain line.
    const text = this.ptys.bracketedPaste(id) ? `\x1b[200~${prompt}\x1b[201~` : prompt.replace(/\s*\n\s*/g, ' ');
    this.ptys.write(id, text, 'board message');
    setTimeout(() => this.ptys.write(id, '\r', 'board message'), 150); // separate Enter, so the TUI doesn't take it as part of a paste
  }

  stop(id: string) {
    this.queue = this.queue.filter(q => q !== id);
    this.ptys.kill(id);
  }

  // Queues every todo task in `ids` (board order) and keeps up to maxParallel of them going.
  runAll(ids: string[]) {
    for (const id of ids) if (!this.queue.includes(id) && this.store.task(id)?.status === 'todo') this.queue.push(id);
    this.pump();
    this.changed();
  }

  cancelQueue() { this.queue = []; this.changed(); }

  // Tasks still on their way to Done: building, in review, being fixed, or waiting for you to merge. Each holds its slot
  // until it is merged, so with maxParallel 1 the queue runs strictly one at a time and every task builds on the previous
  // one's merged work. (A project-root task is finished when its turn ends: it has no branch to merge.)
  private inFlight() {
    return this.store.data.tasks.filter(t => {
      if (t.archived || t.status === 'done' || t.init) return false;
      const st = this.state.get(t.id);
      if (st === 'running' || st === 'waiting') return true;
      return t.where !== 'root' && !!(t.branch && t.worktree) && (t.status === 'doing' || t.status === 'review');
    });
  }

  // What the queue is waiting for, for the toolbar.
  queueInfo() {
    const b = this.inFlight()[0], r = b?.review;
    const why = !b ? '' : this.state.get(b.id) === 'waiting' ? 'approve a permission prompt'
      : this.state.get(b.id) === 'running' ? 'finish'
      : b.limited ? 'continue after the usage limit'
      : r?.state === 'pass' ? 'be merged (✓ Merge)'
      : r?.state === 'fail' ? (r.attempts >= this.reviewOpts().maxAttempts ? 'be fixed (the reviewer still finds issues)' : 'be fixed by Claude')
      : r?.state === 'error' ? 'be reviewed (Retry review)'
      : b.conflicts?.length ? 'have its conflicts resolved' : 'be reviewed';
    return { queued: [...this.queue], blocker: b ? { id: b.id, title: b.title, why } : undefined };
  }

  private pump() {
    if (this.limits?.held()) return; // out of quota: queued tasks wait for the reset (afterReset starts them)
    let slots = this.maxParallel() - this.inFlight().length;
    while (slots > 0 && this.queue.length) {
      const id = this.queue.shift()!;
      if (this.store.task(id)?.status !== 'todo') continue; // started by hand, moved or deleted meanwhile
      slots--;
      this.run(id).catch(e => { this.notify('error', `${this.store.task(id)?.title}: ${e.message}`, id); this.pump(); });
    }
  }

  // Polls the status file the session's hooks append to (fs.watch misses appends on some filesystems).
  private watch(id: string) {
    this.watched.set(id, 0);
    const file = this.statusFile(id);
    fs.unwatchFile(file);
    fs.watchFile(file, { interval: 400 }, () => {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      const seen = this.watched.get(id) ?? 0;
      const end = text.lastIndexOf('\n') + 1; // only whole lines; a hook may be mid-write
      if (end <= seen) return;
      this.watched.set(id, end);
      for (const line of text.slice(seen, end).split('\n').filter(Boolean)) this.event(id, line);
    });
    // The status line command saves Claude's rate_limits here (percent used and reset time of the 5-hour / weekly windows).
    const rate = this.statusFile(id).replace(/\.status$/, '.rate');
    fs.unwatchFile(rate);
    fs.watchFile(rate, { interval: 3000 }, () => {
      try { this.limits?.setWindows(JSON.parse(fs.readFileSync(rate, 'utf8')).rate_limits); } catch { /* mid-write or no rate_limits */ }
    });
  }

  private event(id: string, line: string) {
    const [kind, raw] = line.split('\t');
    let json: any = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch { /* partial or odd input: state still applies */ }
    if (kind === 'tool') { this.lastTool.set(id, { tool: json.tool_name ?? '', detail: toolDetail(json.tool_input) }); return; }
    if (kind === 'stop') { this.asks.delete(id); void this.turnEnded(id); return; }
    if (kind === 'run') {
      this.asks.delete(id);
      this.state.set(id, 'running');
      // Claude is working on it again (you typed, or it is fixing review issues): back to Doing.
      const t = this.store.task(id);
      if (t?.status === 'review' && !t.init) this.store.updateTask(id, { status: 'doing', review: t.review?.state === 'fail' ? t.review : undefined });
      this.changed();
      return;
    }
    if (kind === 'fail') {
      // A turn ended on an API error. Rate limit → wait for the reset, then continue; anything else → say so.
      const t = this.store.task(id);
      this.asks.delete(id);
      this.state.set(id, 'idle');
      if (/rate_limit|billing/i.test(raw ?? '')) {
        this.limits?.setReached('usage');
        if (t && t.status !== 'done') this.store.updateTask(id, { limited: true });
        this.notify('warn', `Claude's usage limit stopped "${t?.title}". It continues by itself after the reset.`, id);
      } else {
        this.notify('error', `Claude stopped on an API error in "${t?.title}": ${String(json.error ?? json.error_type ?? raw ?? 'unknown').slice(0, 200)}. Resume it when ready.`, id);
      }
      this.changed();
      return;
    }
    if (kind === 'wait') {
      const last = this.lastTool.get(id);
      this.asks.set(id, { message: json.message ?? 'Claude needs your approval', tool: last?.tool, detail: last?.detail });
      this.state.set(id, 'waiting');
      this.notify('warn', `"${this.store.task(id)?.title}" needs your approval${last?.tool ? `: ${last.tool}` : ''}`, id);
      this.changed();
      void this.labelAsk(id);
    }
  }

  // What "Always" will do, read from the menu's second choice, so the button says it.
  private async labelAsk(id: string) {
    await new Promise(r => setTimeout(r, 500)); // the menu is drawn a moment after the hook fires
    const a = this.asks.get(id);
    if (!a || this.state.get(id) !== 'waiting') return;
    const text = optionText(await this.ptys.screen(id), 2);
    if (text && /always|don't ask|do not ask|allow all/i.test(text)) { a.always = text.slice(0, 200); this.changed(); }
  }

  // Answers the permission prompt. Only the menu's number keys and Enter are sent (1 = Yes, 2 = Yes and always,
  // Esc = No): an arrow key is an escape sequence, and if it ever reached Claude split in two, the first byte would be
  // read as Esc and interrupt the session. Checks the prompt is really on screen first, and that it took the answer.
  async answer(id: string, choice: 'allow' | 'always' | 'deny') {
    if (this.state.get(id) !== 'waiting') return;
    const ask = this.asks.get(id);
    if (!isMenu(await this.ptys.screen(id))) {
      // The hook said "waiting" but Claude isn't asking (answered in the terminal, or already moved on): don't type into the input.
      this.asks.delete(id);
      this.state.set(id, 'running');
      this.notify('info', 'Claude is not asking for permission any more.', id);
      this.changed();
      return;
    }
    if (choice === 'deny') this.ptys.write(id, '\x1b', 'card: Deny');
    else {
      this.ptys.write(id, choice === 'always' ? '2' : '1', `card: ${choice === 'always' ? 'Always' : 'Allow'}`);
      await new Promise(r => setTimeout(r, 200));
      this.ptys.write(id, '\r', `card: ${choice === 'always' ? 'Always' : 'Allow'}`);
    }
    this.asks.delete(id);
    this.state.set(id, 'running');
    this.changed();
    // Still showing the same prompt after a moment: it did not take the answer. Say so instead of looking stuck.
    setTimeout(async () => {
      if (!this.ptys.has(id) || this.state.get(id) !== 'running') return;
      if (choice !== 'deny' && isMenu(await this.ptys.screen(id, 14)) && !this.asks.has(id)) {
        if (ask) this.asks.set(id, ask);
        this.state.set(id, 'waiting');
        this.notify('warn', 'Claude did not take that answer. Answer it in the terminal (⌨).', id);
        this.changed();
      }
    }, 2500);
  }

  private unwatch(id: string) {
    this.asks.delete(id);
    this.lastTool.delete(id);
    fs.unwatchFile(this.statusFile(id));
    const rate = this.statusFile(id).replace(/\.status$/, '.rate');
    fs.unwatchFile(rate);
    fs.rmSync(rate, { force: true });
    this.watched.delete(id);
    fs.rmSync(this.statusFile(id), { force: true });
  }

  // Turn finished: commit what changed so the branch always holds the work, then move on in the queue.
  private async turnEnded(id: string) {
    this.state.set(id, 'idle');
    this.ptys.save(id);
    const t = this.store.task(id);
    this.emptyAt.delete(id);
    // A turn that ends while a limit is in force was cut short: keep the task where it is and continue after the reset.
    if (t && this.limits?.held() && t.status !== 'done' && !t.init) {
      this.store.updateTask(id, { limited: true });
      this.changed();
      return;
    }
    if (t?.worktree && !t.conflicts?.length) {
      try { await g.commitAll(t.worktree, t.title); } catch (e: any) { this.notify('error', `Commit failed: ${e.message}`, id); }
    }
    // The init run is one-shot: done when its turn ends. Other tasks wait in Review.
    if (t?.init && t.status !== 'done') this.store.updateTask(id, { status: 'done' });
    else if (t?.status === 'doing') this.store.updateTask(id, { status: 'review' });
    this.changed();
    this.pump();
    const cur = this.store.task(id);
    if (cur?.status === 'review' && cur.branch && this.reviewOpts().auto) void this.review(id);
  }

  // Sends text that continues the task's work (review issues, "continue after the limit"). Every task has its own session;
  // within a task the session is continued, unless its history has grown big (freshAfterKB): then a new session starts with
  // a short handoff, so a long task does not drag its whole history into every further round.
  async continueTask(id: string, text: string) {
    const t = this.store.task(id);
    if (!t) return;
    const limit = this.reviewOpts().freshAfterKB ?? 600;
    const cwd = t.worktree ?? this.root;
    if (!t.sessionId || limit < 0 || sessionSize(cwd, t.sessionId) <= limit * 1024 || this.state.get(id) === 'waiting') return this.say(id, text);
    this.store.updateTask(id, { sessionId: undefined, pastSessions: [...(t.pastSessions ?? []), t.sessionId] });
    this.stop(id);
    this.state.delete(id);
    this.notify('info', `"${t.title}": its session got long, so it continues in a fresh one (cheaper).`, id);
    const where = t.base ? `see git log and git diff ${t.base}...HEAD; uncommitted work is in git status` : 'see git log and git status';
    await this.run(id, `Continue this task: ${t.title}\n${t.description ?? ''}\n\nWork on it is already in this folder (${where}). ${text}`);
  }

  /* ---------- keeping cards moving ---------- */

  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  private sweepSoon(ms = 1500) {
    clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => void this.sweep(), ms);
    this.sweepTimer.unref?.();
  }

  // Nothing should sit in Review waiting for a click that the board could do itself:
  //  - a branch task in Review that was never reviewed (it got there before the reviewer existed, or the window was
  //    closed during its review) gets reviewed;
  //  - a review that failed while its session was closed (reload, restart) sends its issues back to Claude;
  //  - an old "reviewer failed" result is retried as the error it was.
  // One at a time, within maxParallel, never during a usage limit.
  async sweep() {
    const o = this.reviewOpts();
    if (this.sweeping || !o.auto || this.limits?.held()) return;
    this.sweeping = true;
    try {
      for (const t of [...this.store.data.tasks]) {
        if (t.archived || t.status === 'done' || t.init || !t.branch || !t.worktree || t.conflicts?.length) continue;
        const st = this.state.get(t.id);
        if (st === 'running' || st === 'waiting' || t.review?.state === 'running' || this.busy.has(t.id)) continue;
        if (t.review?.state === 'fail' && t.review.issues?.[0]?.startsWith('Reviewer failed')) { this.store.updateTask(t.id, { review: undefined }); continue; }
        if (t.status === 'review' && !t.review && !this.emptyAt.has(t.id)) { await this.review(t.id); continue; }
        if (t.review?.state === 'fail' && t.review.issues?.length && t.review.attempts < o.maxAttempts && !this.ptys.has(t.id) && !st) {
          const working = [...this.state.values()].filter(s => s !== 'idle').length;
          if (working >= this.maxParallel()) continue;
          this.store.updateTask(t.id, { status: 'doing' });
          await this.continueTask(t.id, `The code reviewer found these issues (review ${t.review.attempts} of ${o.maxAttempts}). Fix them, then finish your turn:\n` +
            t.review.issues.map((x, i) => `${i + 1}. ${x}`).join('\n'));
        }
      }
    } finally { this.sweeping = false; }
  }

  // The usage limit is over: tasks it cut short continue, failed reviews are retried, the queue restarts.
  afterReset() {
    this.notify('info', 'Claude usage limit reset: continuing where tasks stopped.');
    for (const t of [...this.store.data.tasks]) {
      if (t.review?.state === 'error') this.store.updateTask(t.id, { review: undefined });
      if (!t.limited) continue;
      this.store.updateTask(t.id, { limited: undefined });
      void this.continueTask(t.id, 'Your Claude usage limit has reset. Continue exactly where you stopped.').catch(e => this.notify('error', e.message, t.id));
    }
    this.pump();
    this.sweepSoon(500);
  }

  /* ---------- AI review ---------- */

  // Reviews the branch's diff with a read-only reviewer. Fail → issues go back to the task's session (it fixes, its
  // turn ends, the new commit is reviewed again), up to maxAttempts; then it waits for you. Pass → ready to merge,
  // or merged right away with autoMerge (unless the reviewer marks it critical).
  async review(id: string, force = false) {
    const t = this.store.task(id), o = this.reviewOpts();
    if (!t?.worktree || !t.base || !t.branch || t.conflicts?.length || this.reviewing.has(id)) return;
    this.reviewing.add(id); // synchronously, before any await: two triggers must not start two reviewers
    try { await this.reviewInner(id, t, o, force); } finally { this.reviewing.delete(id); }
  }

  private async reviewInner(id: string, t: Task, o: ReviewOpts, force: boolean) {
    const stale = () => { const n = this.store.task(id); return !n || n.status === 'done' || n.worktree !== t.worktree || n.branch !== t.branch; };
    const head = await g.git(t.worktree!, ['rev-parse', 'HEAD']).catch(() => '');
    if (!force && t.review?.head === head) return; // this commit was already reviewed
    const diff = await g.git(t.worktree!, ['diff', `${t.base}...HEAD`]).catch(() => '');
    if (!diff.trim()) { this.emptyAt.add(id); return; } // nothing built yet (Claude asked a question): nothing to review
    const attempts = (t.review?.state === 'fail' ? t.review.attempts : 0);
    this.store.updateTask(id, { review: { state: 'running', attempts, head } });
    const reviewer = discoverAgents(this.root).find(a => a.scope === 'project' && /review/i.test(a.name))?.name;
    // Screenshots go outside the worktree (never committed) and in a path without spaces ("Side Hustle" would need quoting
    // in the command Claude runs and in its permission rule). Fresh per review.
    const shots = path.join(os.tmpdir(), 'justcode-reviews', id);
    fs.rmSync(shots, { recursive: true, force: true });
    fs.mkdirSync(shots, { recursive: true });
    const device = adb();
    const screenshots = () => { try { return fs.readdirSync(shots).filter(f => /\.(png|jpe?g)$/i.test(f)).map(f => path.join(shots, f)); } catch { return []; } };
    let v;
    const cli = path.join(__dirname, 'cli.js');
    const prompt = reviewPrompt(t, t.base!, diff, { shots, adb: device, cli });
    const run = (p: string) => runReview(this.bin(), t.worktree!, p, o.model, reviewer, shots, o.commands, device?.bin, cli);
    try {
      v = await run(prompt);
      // A review that only read the code (or skipped the screenshot it could take) is sent back once to actually test.
      const missing = [
        !v.tested.some(c => TEST_CMD.test(c)) && 'you did not run any tests or build',
        device?.devices.length && UI_FILE.test(diff) && !screenshots().length && 'an Android device is connected and the diff changes UI files, but you took no screenshot',
      ].filter(Boolean);
      if (missing.length) v = await run(`${prompt}\n\n## Your previous review was incomplete\n${missing.join('; ')}. Do it now, then give the verdict.`);
    } catch (e: any) {
      // The reviewer could not run (limit, crash, bad output). That is not a verdict: nothing goes to Claude to "fix".
      const msg = String(e.message ?? e).slice(0, 400);
      const limit = isLimitError(msg);
      if (limit) this.limits?.setReached('usage');
      this.store.updateTask(id, { review: { state: 'error', attempts, error: msg, screenshots: screenshots() } });
      if (!limit) this.notify('error', `AI review of "${t.title}" could not run: ${msg}`, id);
      return;
    }
    // Discarded, deleted or finished while the reviewer ran: its verdict is about work that no longer exists.
    if (stale()) { if (this.store.task(id)?.review?.state === 'running') this.store.updateTask(id, { review: undefined }); return; }
    if (v.pass) {
      this.store.updateTask(id, { review: { state: 'pass', attempts, head, risk: v.risk, issues: v.issues.length ? v.issues : undefined, screenshots: screenshots(), tested: v.tested } });
      if (o.autoMerge && v.risk !== 'critical') return this.merge(id, true);
      this.notify('info', `"${t.title}" passed AI review${v.risk === 'critical' ? ' (flagged critical: look before merging)' : ''}. Ready to merge.`, id);
      return;
    }
    const n = attempts + 1;
    this.store.updateTask(id, { review: { state: 'fail', attempts: n, head, issues: v.issues, risk: v.risk, screenshots: screenshots(), tested: v.tested } });
    if (n >= o.maxAttempts) return this.notify('warn', `"${t.title}" failed AI review ${n} times. Check the issues on the card.`, id);
    this.store.updateTask(id, { status: 'doing' });
    await this.continueTask(id, `The code reviewer found these issues (review ${n} of ${o.maxAttempts}). Fix them, then finish your turn:\n` +
      v.issues.map((x, i) => `${i + 1}. ${x}`).join('\n'));
  }

  private async exited(id: string) {
    if (this.ptys.has(id) || this.launching.has(id)) return; // a newer run of this task already took over
    this.state.delete(id);
    this.unwatch(id);
    const t = this.store.task(id);
    if (t?.worktree && fs.existsSync(t.worktree) && !t.conflicts?.length && !await g.merging(t.worktree)) {
      try { await g.commitAll(t.worktree, t.title); } catch { /* reported on next turn */ }
    }
    this.changed();
    this.pump();
  }

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
    try { return await this.serial(() => fn(t)); } catch (e: any) { this.notify('error', e.message, id); } finally { this.busy.delete(id); this.changed(); }
  }
  isBusy(id: string) { return this.busy.has(id); }

  // Approved by the user. Base is brought into the branch first, in the worktree; conflicts stop there.
  merge(id: string, auto = false) {
    return this.guarded(id, async t => {
      if (!t.worktree || !t.branch || !t.base) throw new Error('Nothing to merge yet');
      if (this.state.get(id) === 'running' || this.state.get(id) === 'waiting') throw new Error('Claude is still working on this task. Wait for it to finish or stop it.');
      await g.commitAll(t.worktree, t.title);
      // Uncommitted files in the project folder would block the merge ("untracked working tree files would be
      // overwritten"). Commit them on base first; then bringing base into the branch settles any differences in the worktree.
      if (await g.currentBranch(this.root) === t.base) {
        const snap = await g.snapshot(this.root);
        if (snap.files.length) this.notify('info', `Committed ${snap.files.length} uncommitted file(s) on ${t.base} before merging.`);
      }
      const conflicts = await g.syncWithBase(t.worktree, t.base);
      if (conflicts.length) {
        this.store.updateTask(id, { conflicts, status: 'review' });
        this.notify('warn', `"${t.title}" conflicts with ${t.base} in ${conflicts.length} file(s). Resolve them on the card, then merge again.`, id);
        return;
      }
      await g.mergeIntoBase(this.root, t.base, t.branch, `Merge ${t.branch}: ${t.title}`);
      await this.cleanup(t);
      this.store.updateTask(id, { status: 'done', conflicts: undefined, worktree: undefined });
      this.notify('info', `${auto ? 'AI review passed: auto-merged' : 'Merged'} "${t.title}" into ${t.base}`);
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
      this.notify('info', `Conflicts resolved for "${t.title}". Review, then Merge.`);
    });
  }

  // Drops the branch and its work; the task goes back to todo with a fresh session next run.
  discard(id: string) {
    return this.guarded(id, async t => {
      this.stop(id);
      await this.cleanup(t);
      this.store.updateTask(id, { status: 'todo', branch: undefined, worktree: undefined, sessionId: undefined, conflicts: undefined, pr: undefined });
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
    if (t.worktree) await g.removeWorktree(this.root, t.worktree);
    if (t.branch) await g.deleteBranch(this.root, t.branch).catch(() => { /* never created */ });
  }

  async remove(id: string) {
    const t = this.store.task(id);
    if (!t) return;
    this.ptys.forget(id);
    await this.serial(() => this.cleanup(t)).catch(e => this.notify('error', e.message));
    fs.rmSync(path.join(this.root, '.justcode', 'attachments', id), { recursive: true, force: true });
    this.store.deleteTask(id);
  }

  dispose() {
    this.unsubExit?.();
    clearTimeout(this.sweepTimer);
    this.store.dispose();
    for (const id of [...this.watched.keys()]) this.unwatch(id);
    this.ev.removeAllListeners();
  }
}
