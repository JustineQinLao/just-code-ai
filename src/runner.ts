import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import { Ptys } from './pty';
import * as g from './git';
import { sessionArgs, sessionExists } from './claude';

// What a task's live session is doing, from its hooks: running, waiting for approval, or idle (turn finished).
export type RunState = 'running' | 'waiting' | 'idle';

// Runs tasks of one project: worktree + branch per task, a Claude session per task in a pty,
// auto-commit when a turn ends, and the review → merge flow back into the task's base branch.
export class Runner {
  state = new Map<string, RunState>();
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
    private maxParallel: () => number, private model: () => string) {
    fs.mkdirSync(runsDir, { recursive: true });
    ptys.onExit((id) => { if (this.store.task(id)) void this.exited(id); });
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
    try { await this.launch(t, prompt, size); } catch (e) { this.state.delete(id); this.changed(); throw e; }
  }

  private async launch(t: Task, prompt?: string, size?: { cols: number; rows: number }) {
    const id = t.id;
    if (t.where === 'root') return this.spawn(t, this.root, {}, prompt, size);
    const { base, branch, worktree } = await this.serial(async () => {
      await g.ensureRepo(this.root);
      const base = t.base ?? await g.currentBranch(this.root);
      const branch = t.branch ?? g.taskBranch(t.title, t.id);
      const worktree = t.worktree ?? g.worktreeDir(this.root, t.id);
      await g.addWorktree(this.root, worktree, branch, base);
      return { base, branch, worktree };
    });
    await this.spawn(t, worktree, { base, branch, worktree }, prompt, size);
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
    if (!this.ptys.has(id)) return this.run(id, prompt);
    this.ptys.write(id, prompt);
    setTimeout(() => this.ptys.write(id, '\r'), 150); // separate Enter, so the TUI doesn't take it as part of a paste
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

  private pump() {
    const working = [...this.state.entries()].filter(([, s]) => s !== 'idle').length;
    for (let n = working; n < this.maxParallel() && this.queue.length; n++) {
      const id = this.queue.shift()!;
      this.run(id).catch(e => this.notify('error', `${this.store.task(id)?.title}: ${e.message}`, id));
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
      if (text.length <= seen) return;
      this.watched.set(id, text.length);
      const last = text.slice(seen).trim().split('\n').pop();
      if (last === 'stop') void this.turnEnded(id);
      else if (last === 'wait') { this.state.set(id, 'waiting'); this.notify('warn', `"${this.store.task(id)?.title}" needs your approval`, id); this.changed(); }
      else if (last === 'run') { this.state.set(id, 'running'); this.changed(); }
    });
  }

  private unwatch(id: string) {
    fs.unwatchFile(this.statusFile(id));
    this.watched.delete(id);
    fs.rmSync(this.statusFile(id), { force: true });
  }

  // Turn finished: commit what changed so the branch always holds the work, then move on in the queue.
  private async turnEnded(id: string) {
    this.state.set(id, 'idle');
    const t = this.store.task(id);
    if (t?.worktree && !t.conflicts?.length) {
      try { await g.commitAll(t.worktree, t.title); } catch (e: any) { this.notify('error', `Commit failed: ${e.message}`, id); }
    }
    if (t?.status === 'doing') this.store.updateTask(id, { status: 'review' });
    this.changed();
    this.pump();
  }

  private async exited(id: string) {
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
  merge(id: string) {
    return this.guarded(id, async t => {
      if (!t.worktree || !t.branch || !t.base) throw new Error('Nothing to merge yet');
      if (this.state.get(id) === 'running' || this.state.get(id) === 'waiting') throw new Error('Claude is still working on this task. Wait for it to finish or stop it.');
      await g.commitAll(t.worktree, t.title);
      const conflicts = await g.syncWithBase(t.worktree, t.base);
      if (conflicts.length) {
        this.store.updateTask(id, { conflicts, status: 'review' });
        this.notify('warn', `"${t.title}" conflicts with ${t.base} in ${conflicts.length} file(s). Resolve them on the card, then merge again.`, id);
        return;
      }
      await g.mergeIntoBase(this.root, t.base, t.branch, `Merge ${t.branch}: ${t.title}`);
      await this.cleanup(t);
      this.store.updateTask(id, { status: 'done', conflicts: undefined, worktree: undefined });
      this.notify('info', `Merged "${t.title}" into ${t.base}`);
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
    await this.serial(() => this.cleanup(t)).catch(e => this.notify('error', e.message));
    fs.rmSync(path.join(this.root, '.justcode', 'attachments', id), { recursive: true, force: true });
    this.store.deleteTask(id);
  }

  dispose() {
    for (const id of [...this.watched.keys()]) this.unwatch(id);
    this.ev.removeAllListeners();
  }
}
